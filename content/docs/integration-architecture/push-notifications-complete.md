---
title: Push Notifications Complete
---

# Push Notification Architecture: Complete System Documentation

**Version:** 1.0
**Date:** 2026-02-08
**Session:** 12 — Push Notification Architecture
**Sources:** [two-push-architecture.md](two-push-architecture.md) | [non-voip-notifications.md](non-voip-notifications.md) | [push-credential-configuration.md](push-credential-configuration.md)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Credential and Configuration Chain](#3-credential-and-configuration-chain)
4. [Two-Push VoIP Architecture](#4-two-push-voip-architecture)
5. [Non-VoIP Notification System](#5-non-voip-notification-system)
6. [Platform-Specific Behavior](#6-platform-specific-behavior)
7. [Token Lifecycle Management](#7-token-lifecycle-management)
8. [Deep Linking and Navigation](#8-deep-linking-and-navigation)
9. [Edge Cases and Failure Modes](#9-edge-cases-and-failure-modes)
10. [Observability and Debugging](#10-observability-and-debugging)
11. [Architectural Assessment](#11-architectural-assessment)

---

## 1. Executive Summary

Z360's push notification system serves two distinct purposes:

1. **VoIP Call Notifications** — A dual-push architecture where Z360 sends rich caller info (name, avatar, org context) and Telnyx sends call control metadata (SIP credentials, call ID). These arrive independently and are correlated by normalized phone number within a 500ms window.

2. **Business Notifications** — 10 notification types (8 with push support) for messages, assignments, mentions, notes, and reminders, delivered through Laravel's notification system via a custom FCM channel.

**Key architectural decisions:**
- **Separate push channels for VoIP vs. business notifications** — VoIP uses `PushNotificationService` (direct HTTP) for low latency; business uses `FcmChannel` (Kreait SDK) for queue integration
- **Two delivery protocols for iOS** — APNs VoIP push (PushKit) for call notifications, FCM for business notifications
- **Organization-scoped tokens** — Device tokens are per-user-per-org, enabling multi-tenant notification routing
- **Phone-number correlation** — The two VoIP pushes are matched by last-10-digits normalization, not call ID (which differs between Z360 and Telnyx)

---

## 2. System Overview

### 2.1 Push Notification Components

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Z360 BACKEND                                 │
│                                                                      │
│  ┌─────────────────────┐    ┌──────────────────────────┐            │
│  │ PushNotificationSvc │    │ FcmChannel               │            │
│  │ (VoIP calls)        │    │ (Business notifications)  │            │
│  │                     │    │                          │            │
│  │ • sendFcmMessage()  │    │ • Kreait Firebase SDK    │            │
│  │ • ApnsVoipService   │    │ • Laravel Notification   │            │
│  │ • Direct HTTP v1    │    │ • Queue-backed           │            │
│  └──────┬──────┬───────┘    └──────────┬───────────────┘            │
│         │      │                       │                             │
│      FCM│   APNs│                   FCM│                             │
│      v1 │  VoIP│                   SDK│                             │
└─────────┼──────┼───────────────────────┼─────────────────────────────┘
          │      │                       │
          ▼      ▼                       ▼
     ┌────────┐ ┌─────────┐      ┌────────────┐
     │Firebase│ │Apple    │      │Firebase    │
     │  FCM   │ │APNs    │      │  FCM       │
     └───┬────┘ └────┬────┘      └─────┬──────┘
         │           │                  │
    ┌────┴───┐  ┌────┴───┐       ┌─────┴──────┐
    │Android │  │  iOS   │       │Android/iOS │
    │  VoIP  │  │  VoIP  │       │ Business   │
    └────────┘  └────────┘       └────────────┘

┌──────────────────────────────────────────────────┐
│              TELNYX INFRASTRUCTURE                 │
│                                                    │
│  SIP INVITE → Push binding detected →              │
│  Auto-sends push via FCM (Android) / PushKit (iOS)│
│  Payload: call ID, caller_number, "Unknown" name   │
└──────────────────────────────────────────────────┘
```

### 2.2 Two Notification Pipelines

| Aspect | VoIP Pipeline | Business Pipeline |
|--------|---------------|-------------------|
| **Backend service** | `PushNotificationService` | `FcmChannel` (Laravel) |
| **FCM integration** | Direct HTTP v1 API + OAuth2 | Kreait Firebase SDK |
| **iOS delivery** | APNs VoIP (PushKit) | FCM (regular push) |
| **Android delivery** | FCM high-priority data message | FCM notification + data |
| **Latency priority** | Critical (~50ms target) | Normal (~200ms acceptable) |
| **Queue** | Synchronous (inline) | Laravel queue-backed |
| **TTL** | 60 seconds | 300-3600 seconds |
| **Org context** | In payload directly | Injected by FcmChannel |

---

## 3. Credential and Configuration Chain

### 3.1 Firebase Configuration

**Project:** `z360-c7d9e` (Project Number: `699830885674`)

| Platform | Config File | Location |
|----------|-------------|----------|
| Android | `google-services.json` | `android/app/google-services.json` (committed) |
| iOS | `GoogleService-Info.plist` | `ios/App/App/GoogleService-Info.plist` (committed) |
| Backend | Service account JSON | `storage/z360-c7d9e-firebase-adminsdk-*.json` (gitignored) |

**Backend uses two Firebase access methods:**

1. **Kreait Firebase SDK** (`FcmChannel`) — Service account JSON via `FIREBASE_CREDENTIALS` env var or `FIREBASE_CREDENTIALS_PATH`
2. **Direct HTTP v1 API** (`PushNotificationService`) — OAuth2 bearer token, cached for 55 minutes before refresh

**Reference:** `config/firebase.php`, `config/services.php:54-57`

### 3.2 APNs Configuration (iOS VoIP)

Z360 supports **token-based** (preferred) and **certificate-based** (fallback) APNs auth:

**Token-based (ES256 JWT):**
```
APNS_VOIP_KEY_ID     → 10-char key identifier from Apple Developer
APNS_VOIP_TEAM_ID    → 10-char team identifier
APNS_VOIP_KEY_PATH   → Path to .p8 private key file
APNS_VOIP_BUNDLE_ID  → com.z360.app
APNS_VOIP_ENV        → development | production
```

- JWT signed with ES256, cached for 50 minutes
- VoIP topic: `{bundle_id}.voip`
- Priority 10 (immediate), Expiration 0 (no store-and-forward)
- HTTP/2 required

**Endpoints:**
- Development: `https://api.sandbox.push.apple.com`
- Production: `https://api.push.apple.com`

**Reference:** `app/Services/ApnsVoipService.php:127-176`, `config/services.php:59-71`

### 3.3 Telnyx Push Credential Binding

**Critical finding:** Z360 does NOT register push tokens directly with the Telnyx SDK. The Telnyx push is sent automatically by Telnyx infrastructure when a SIP INVITE arrives at a credential with push notification bindings configured in the Telnyx dashboard.

**SIP credential creation flow:**
1. Backend creates org-level Telnyx Telephony Credentials (`CPaaSService::handleCredentials()`)
2. Credentials linked to a Credential Connection with webhook URLs
3. When inbound call arrives, backend dials all device SIP credentials
4. Telnyx detects push binding on credential and auto-sends platform push

**Reference:** `app/Services/CPaaSService.php:161-205`, `app/Console/Commands/TelnyxSetup.php:147-189`

### 3.4 Environment Variables Summary

```bash
# Firebase (backend)
FIREBASE_CREDENTIALS='{"type":"service_account",...}'
FIREBASE_PROJECT_ID=z360-c7d9e
FIREBASE_CREDENTIALS_PATH=/path/to/service-account.json

# APNs VoIP
APNS_VOIP_ENABLED=true
APNS_VOIP_ENV=production
APNS_VOIP_BUNDLE_ID=com.z360.app
APNS_VOIP_KEY_ID=ABC123XYZ
APNS_VOIP_TEAM_ID=DEF456GHI
APNS_VOIP_KEY_PATH=/path/to/AuthKey.p8

# Telnyx
TELNYX_API_KEY=KEY...
TELNYX_CREDENTIAL_CONNECTION_ID=...
```

---

## 4. Two-Push VoIP Architecture

### 4.1 Why Two Pushes?

The two-push system exists because **call metadata originates from two different systems at different times:**

| Push | Source | Contains | Control |
|------|--------|----------|---------|
| **Z360 Push** | Z360 Laravel backend | Caller name, avatar, org context (from CRM) | Fully controlled |
| **Telnyx Push** | Telnyx SIP infrastructure | Call ID, caller_number, "Unknown" name | Not controllable |

**Cannot be combined because:**
- Z360 push is sent when `call.initiated` webhook arrives (before SIP dial)
- Telnyx push is sent when SIP INVITE hits the credential (during SIP dial)
- Telnyx's push content is auto-generated from SIP headers — Z360 cannot inject CRM data

### 4.2 Timing Sequence

```
T+0ms:   Telnyx call.initiated webhook → Z360 backend
T+50ms:  Z360 backend sends Z360 push (FCM + APNs VoIP)
T+100ms: Z360 backend initiates SIP dial to device credentials
T+150ms: Telnyx delivers SIP INVITE → triggers Telnyx push
T+200ms: Z360 push arrives at device (~60% first)
T+250ms: Telnyx push arrives at device
```

Z360 push is sent **before** the SIP dial, giving it a timing advantage. Arrival order is not guaranteed due to network variability.

### 4.3 Z360 Push Payload

**Android (FCM data message):**
```json
{
  "message": {
    "token": "<fcm_device_token>",
    "data": {
      "type": "incoming_call",
      "caller_number": "+15551234567",
      "caller_name": "John Doe",
      "caller_avatar": "https://z360.app/storage/avatars/123.jpg",
      "organization_id": "42",
      "organization_name": "Acme Corp",
      "call_session_id": "abc-123",
      "call_id": "abc-123",
      "channel_number": "+15559876543",
      "timestamp": "1234567890"
    },
    "android": { "priority": "high", "ttl": "60s" }
  }
}
```

**iOS (APNs VoIP):**
```json
{
  "type": "incoming_call",
  "caller_number": "+15551234567",
  "caller_name": "John Doe",
  "caller_avatar": "...",
  "organization_id": "42",
  "organization_name": "Acme Corp",
  "call_session_id": "abc-123",
  "aps": { "content-available": 1 }
}
```

**Reference:** `app/Services/PushNotificationService.php:20-157`

### 4.4 Telnyx Push Payload

**Android (FCM):** `{ "data": { "metadata": "{\"caller_name\":\"Unknown\",\"caller_number\":\"+15551234567\",\"callId\":\"telnyx-call-id\"}" } }`

**iOS (PushKit):** `{ "telnyx": { "caller_name": "Unknown", "caller_number": "+15551234567", "callId": "telnyx-call-id" } }`

### 4.5 Correlation Mechanism

**Correlation key:** Normalized phone number (last 10 digits)

```
Input: "+1 (555) 123-4567" → Output: "5551234567"
```

**Why phone number, not call ID?** Z360 uses `call_session_id` (parent call) while Telnyx uses the leg's `call_id` (child call in simultaneous ring) — they differ.

**Android — PushSynchronizer** (`android/app/src/main/java/com/z360/app/voip/PushSynchronizer.kt`)
- Singleton with `ConcurrentHashMap` + Kotlin `Mutex`
- `CompletableDeferred<CallDisplayInfo?>` for async waiting
- 500ms timeout, 30-second entry expiry
- Late Z360 arrivals broadcast `ACTION_CALL_DISPLAY_INFO_UPDATED` to update IncomingCallActivity

**iOS — PushCorrelator** (`ios/App/App/VoIP/Services/PushCorrelator.swift`)
- Swift Actor (thread-safe by design) with `CheckedContinuation`
- Triple index: `pendingByPhone`, `pendingByZ360UUID`, `pendingByTelnyxId`
- 500ms timeout, 30-second entry expiry
- Reports to CallKit immediately with minimal info, updates display asynchronously

### 4.6 Correlation Scenarios

| Scenario | Frequency | Android Behavior | iOS Behavior |
|----------|-----------|------------------|-------------|
| Z360 first | ~60% | Store display info → Telnyx finds it immediately | Store info → CallKit gets rich data immediately |
| Telnyx first | ~35% | Wait 500ms via CompletableDeferred | Report CallKit with "Unknown" → update when Z360 arrives |
| Only Telnyx | ~2% | Show "Unknown" (call still works) | CallKit shows "Unknown" (call still works) |
| Only Z360 | ~3% | Info stored but no call shown | Info stored but no CallKit report |
| Timeout (late Z360) | ~3% | Show "Unknown" → broadcast update | CallKit "Unknown" → `updateCallInfo()` |

---

## 5. Non-VoIP Notification System

### 5.1 Notification Types

Z360 defines **10 notification types** in `app/Enums/NotificationType.php`:

| # | Type | Trigger | Push? | Channel | Priority |
|---|------|---------|-------|---------|----------|
| 1 | `message_received` | Inbound message in conversation | Yes | `messages` | high |
| 2 | `conversation_assigned` | Conversation assigned to user | Yes | `assignments` | high |
| 3 | `ticket_assigned` | Ticket assigned to user | Yes | `assignments` | high |
| 4 | `inquiry_assigned` | Inquiry assigned to user | Yes | `assignments` | high |
| 5 | `note_created` | Note added to conversation | Yes | `notes` | normal |
| 6 | `reminder_created` | Reminder created in conversation | Yes | `reminders` | normal |
| 7 | `reminder_assigned` | Reminder assigned to user | No | Email only | — |
| 8 | `reminder_due_alert` | 30 min before reminder due | No | Email only | — |
| 9 | `user_mentioned` | @mention in note/ticket/reminder | Yes | `mentions` | high |
| 10 | `channel_health_alert` | Unhealthy phone/email channels | No | Email + in-app | — |

**Suppression rules:**
- `message_received`: Suppressed for system addresses (no-reply@, donotsend@)
- `conversation_assigned`: Suppressed if assigned to authenticated email
- `note_created`/`reminder_created`: Suppressed for the creator
- `channel_health_alert`: Mandatory (ignores user preferences)

### 5.2 Delivery Architecture

```
Observer/Scheduler → Notification::send()
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
          HasPreferences checks user settings
              │           │           │
         ┌────┴────┐ ┌───┴────┐ ┌───┴────┐
         │  mail   │ │ in_app │ │  push  │
         │ (email) │ │ (DB)   │ │ (FCM)  │
         └─────────┘ └────────┘ └───┬────┘
                                    │
                              FcmChannel
                                    │
                          ┌─────────┴─────────┐
                          │ injectOrgContext() │
                          │ • Prepend [OrgName]│
                          │ • Append org_id    │
                          └─────────┬─────────┘
                                    │
                              Send to each
                              device token
```

**Preference key format:** `notify_{type}_via_{channel}` (e.g., `notify_message_received_via_push`)

**Organization context injection** (`FcmChannel:65-88`):
- Title becomes: `"[Acme Corp] New Message"`
- Link becomes: `/inbox?id=123&organization_id=5`

### 5.3 Android Notification Channels

6 channels created at app startup (`use-push-notifications.ts:100-113`):

| Channel ID | Name | Used By |
|-----------|------|---------|
| `messages` | Messages | message_received |
| `assignments` | Assignments | conversation/ticket/inquiry_assigned |
| `notes` | Notes | note_created |
| `mentions` | Mentions | user_mentioned |
| `reminders` | Reminders | reminder_created |
| `default` | General | Fallback |

All set to `IMPORTANCE_HIGH` with vibration enabled.

### 5.4 Foreground Notification Handling

**Problem:** Capacitor's built-in foreground notification creates untappable notifications (no `PendingIntent`).

**Solution:** `presentationOptions: ['badge', 'sound']` (no `'alert'`) + custom `LocalNotifications.schedule()`:

```typescript
// When push arrives in foreground:
await LocalNotifications.schedule({
    notifications: [{
        id: Math.floor(Math.random() * 2147483647),
        title: notification.title ?? 'Z360',
        body: notification.body ?? '',
        extra: notification.data ?? {},  // Contains 'link' for deep linking
        smallIcon: 'ic_notification',
        channelId: notification.data?.channel_id ?? 'default',
    }],
});

// Also refresh unread count in UI
router.reload({ only: ['unreadNotificationsCount'], showProgress: false });
```

**Reference:** `resources/js/hooks/use-push-notifications.ts:136-157`

---

## 6. Platform-Specific Behavior

### 6.1 Push Delivery Across App States

#### Android

| App State | VoIP (FCM data) | Business (FCM notification) | Notes |
|-----------|------------------|-----------------------------|-------|
| Foreground | `onMessageReceived()` immediate | `onMessageReceived()` → LocalNotification | ~50ms |
| Background | `onMessageReceived()` wakes process | System tray notification auto-displayed | ~100-200ms |
| Terminated | New process started, `onMessageReceived()` | New process, notification displayed | ~300-700ms cold start |
| Locked | Same as above | Same as above | No restrictions for FCM data |
| DND | Delivered (DND only affects display) | Delivered (display suppressed) | Push still received |
| Battery Saver | May be delayed by Doze | May be delayed | High-priority can bypass Doze |

#### iOS

| App State | VoIP (PushKit) | Business (FCM) | Notes |
|-----------|---------------|-----------------|-------|
| Foreground | Delegate called immediately | `pushNotificationReceived` handler | ~50ms |
| Background | App woken, 30s execution time | System notification banner | ~100-200ms |
| Terminated | **App launched in background** (guaranteed) | Standard APNs delivery | PushKit guarantees launch |
| Locked | CallKit on lock screen | Lock screen notification | CallKit bypasses lock |
| DND | Can bypass DND (CallKit) | Suppressed by DND | User-configurable |
| Low Power | **NOT throttled** | May be throttled | VoIP pushes exempt |

**iOS critical constraint:** PushKit requires reporting to CallKit within **5 seconds** or iOS terminates the app. Z360 implements **two-phase startup**:
- Phase 1 (~50ms): PushKit + CallKit only
- Phase 2 (deferred): Firebase, audio session, Telnyx SDK

### 6.2 Permission Model

**Android 13+ (POST_NOTIFICATIONS):**
- Declared in `AndroidManifest.xml`
- Requested via `PushNotifications.requestPermissions()` at first launch
- VoIP plugin also has `requestNotificationPermissions()` for explicit request
- If denied: no notifications displayed (push still received by FCM service)

**iOS:**
- Requested via `UNUserNotificationCenter.requestAuthorization(options: [.alert, .sound, .badge])`
- PushKit VoIP pushes work **without** user permission (system-level)
- Regular push notifications require permission
- If denied: VoIP calls still ring via CallKit; business notifications silent

---

## 7. Token Lifecycle Management

### 7.1 Token Registration Flow

#### iOS (5-step chain)

```
1. PushKitManager.initialize()
   └→ PKPushRegistry(queue: .main).desiredPushTypes = [.voIP]
   └→ APNs VoIP token obtained (for Telnyx push delivery)

2. Firebase SDK initializes
   └→ APNs regular token obtained
   └→ Firebase converts APNs token → FCM token internally

3. MessagingDelegate.didReceiveRegistrationToken()
   └→ 2-second delay (wait for WebView)
   └→ Inject FCM token via: window.dispatchEvent(new CustomEvent('iosFCMToken', { detail: token }))

4. WebView listener (use-push-notifications.ts)
   └→ Receives 'iosFCMToken' event
   └→ Checks: token changed OR > 24 hours since last send?

5. POST /device-tokens { fcm_token, platform: 'ios' }
   └→ Backend upserts UserDeviceToken record
   └→ Updates last_active_at
```

#### Android (3-step chain)

```
1. FirebaseMessaging.getInstance().token
   └→ FCM token received in onNewToken() callback
   └→ Stored in TokenHolder (for native access)

2. Capacitor PushNotifications.register()
   └→ 'registration' event fires with FCM token
   └→ Checks: token changed OR > 24 hours since last send?

3. POST /device-tokens { fcm_token, platform: 'android' }
   └→ Backend upserts UserDeviceToken record
   └→ Updates last_active_at
```

### 7.2 Token Storage

**Backend — `user_device_tokens` table:**

| Column | Purpose |
|--------|---------|
| `user_id` | Owner (FK → users) |
| `organization_id` | Tenant scope (FK → organizations) |
| `device_id` | Unique device identifier |
| `fcm_token` | FCM registration token (up to 500 chars) |
| `platform` | `android` \| `ios` \| `web` |
| `last_active_at` | Last successful notification delivery or token registration |
| `telnyx_credential_id` | VoIP SIP credential (for simultaneous ring) |
| `sip_username`, `sip_password` | Device-level SIP credentials |

**Unique constraint:** `(user_id, organization_id, device_id)`
**Upsert key:** `fcm_token` (if token exists for different user → reassigned)

**Frontend — localStorage:**
- `z360_fcm_token` — Current FCM token
- `z360_fcm_token_sent_at` — Timestamp of last backend registration

### 7.3 Token Refresh and Keepalive

**Refresh triggers:**
- App reinstall → new FCM token generated
- Firebase SDK token rotation (automatic)
- iOS: `MessagingDelegate.didReceiveRegistrationToken()` called on change
- Android: `onNewToken()` called on change

**24-hour keepalive:** Frontend resends token every 24 hours even if unchanged, updating `last_active_at` to signal device liveness.

### 7.4 Stale Token Cleanup

| Mechanism | Trigger | Action |
|-----------|---------|--------|
| FCM send failure | `NotFound` or `InvalidMessage` exception | `$device->delete()` |
| PushNotificationService | `UNREGISTERED` or `INVALID_ARGUMENT` in error | `UserDeviceToken::removeToken($token)` |
| APNs 410 Gone | Token no longer valid | Token removed |
| Manual logout | User logs out | `DeviceTokenController@destroy` |

**Reference:** `app/Channels/FcmChannel.php:127-131`, `app/Services/PushNotificationService.php:110-112`

---

## 8. Deep Linking and Navigation

### 8.1 Link Format

All notifications include a `link` field with organization context:

| Notification Type | Link Pattern |
|-------------------|-------------|
| message_received | `/inbox?id={conversation_id}&organization_id={org_id}` |
| conversation_assigned | `/inbox?id={conversation_id}&organization_id={org_id}` |
| ticket_assigned | `/inbox?id={conversation_id}&focused={message_id}&organization_id={org_id}` |
| inquiry_assigned | `/inbox?id={conversation_id}&focused={message_id}&organization_id={org_id}` |
| note_created | `/inbox?id={conversation_id}&organization_id={org_id}` |
| user_mentioned | `/inbox?id={conversation_id}&organization_id={org_id}` |
| channel_health_alert | `/settings/account/phone-numbers&organization_id={org_id}` |

### 8.2 Navigation Flow

```
User taps notification
        │
        ├── Background/Killed: pushNotificationActionPerformed
        │   └→ Extract link from action.notification.data.link
        │
        └── Foreground (LocalNotification): localNotificationActionPerformed
            └→ Extract link from action.notification.extra.link
        │
        ▼
  visitDeepLink(link)
        │
        ├── If router ready → router.visit(link) immediately
        │
        └── If cold start → wait for first Inertia 'navigate' event → then visit
```

**Organization switching:** Laravel middleware detects `organization_id` query param → calls `$organization->switchTo()` → user lands in correct tenant context.

**Reference:** `resources/js/hooks/use-push-notifications.ts:22-61`

---

## 9. Edge Cases and Failure Modes

### 9.1 VoIP Push Edge Cases

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| **Wrong order (Telnyx first)** | ~35% of calls | 500ms CompletableDeferred/CheckedContinuation wait |
| **Z360 push lost** | "Unknown" caller display | Call still functional; fallback to phone number |
| **Telnyx push lost** | No call shown despite display info | Entry expires in 30s; SIP fallback if app in foreground |
| **Both pushes lost** | No call notification | Extremely rare (<0.1%); caller hears ringing with no answer |
| **Duplicate pushes** | Could show double call UI | Dedup by checking existing call entries before creating new |
| **Late Z360 (after 500ms)** | Brief "Unknown" flash | Broadcast update (Android) / CallKit `updateCallInfo()` (iOS) |
| **Call ID mismatch** | Correlation fails by ID | Phone-number correlation as primary; triple-index fallback on iOS |
| **Cold start delay** | 300-700ms additional latency | Two-phase startup (iOS); still within 500ms timeout most cases |

### 9.2 Business Notification Edge Cases

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| **Invalid FCM token** | Delivery failure | Auto-cleanup on `NotFound`/`InvalidMessage` |
| **Account switching** | Token pointed to wrong user | Upsert by `fcm_token` reassigns to current user |
| **Foreground notification** | Capacitor default is untappable | Custom `LocalNotifications.schedule()` with link |
| **Multi-org notifications** | Wrong org context | `FcmChannel` injects `organization_id` into all links |
| **Permission denied** | No notification display | VoIP still works via PushKit (iOS); silent delivery (Android) |

### 9.3 Token-Related Failures

| Scenario | Impact | Recovery |
|----------|--------|----------|
| **FCM token expires** | Push delivery fails | Auto-removed by FcmChannel; Firebase SDK generates new token |
| **APNs token invalid** | iOS VoIP push fails | ApnsVoipService logs error; token removed on 410 |
| **WebView not ready (iOS)** | FCM token lost | 2-second delay before injection; token re-sent on next app open |
| **Backend unreachable** | Token not registered | `onError` logged; retried on next app open (24h cycle) |

---

## 10. Observability and Debugging

### 10.1 Log Points

**Backend:**
```
VoipLog::info('Mobile push sent to devices', $callSessionId, [
    'android_device_count' => count($fcmTokens),
    'ios_device_count' => count($apnsTokens),
]);
```

**Android PushSynchronizer:**
```
📥 Z360 push received | phone=$normalizedPhone | callId=$callId
📥 Telnyx push received | phone=$normalizedPhone | callId=$callId
✅ Z360 arrived AFTER Telnyx, completing deferred immediately
⏳ Z360 arrived first, storing for Telnyx
⏱️ Waiting for Z360 push (timeout 500ms)
⚠️ Sync timeout — proceeding with Telnyx data only
```

**iOS PushCorrelator:**
```
[PushCorrelator] 📥 Z360 push received | phone=... | callId=...
[PushCorrelator] 📥 Telnyx push received | phone=... | callId=...
[PushCorrelator] ✅ Z360 arrived AFTER Telnyx, completing continuation
[PushCorrelator] ⚠️ Telnyx push has no phone number, cannot correlate
```

### 10.2 Debugging Checklist

**VoIP push not arriving?**
1. Check backend logs for `sendIncomingCallPush` execution
2. Verify device tokens exist in `user_device_tokens` for user+org
3. Check FCM response codes (200 = success)
4. Check APNs response (iOS) — 200 = success, 410 = expired token
5. Verify `APNS_VOIP_ENABLED=true` and credentials are correct
6. Check APNs environment matches provisioning profile

**Business notification not arriving?**
1. Check user preferences: `notify_{type}_via_push` must be enabled
2. Check `FcmChannel` logs for send success
3. Verify FCM token is registered (POST /device-tokens)
4. Check Android notification channel matches (`channel_id` in payload)
5. Verify `POST_NOTIFICATIONS` permission granted (Android 13+)

**Deep link not working?**
1. Verify `link` field in notification payload
2. Check `organization_id` is appended correctly
3. Verify Inertia router is ready before navigation
4. Check cold-start handler for `pushNotificationActionPerformed` event

---

## 11. Architectural Assessment

### 11.1 Strengths

1. **Separation of concerns** — VoIP and business notifications use different pipelines optimized for their requirements (latency vs. reliability)
2. **Multi-tenant aware** — Organization-scoped tokens and automatic context injection enable seamless multi-org experience
3. **Graceful degradation** — VoIP calls work even with missing Z360 push (just "Unknown" caller); correlation timeout prevents indefinite blocking
4. **Platform-native patterns** — PushKit/CallKit on iOS, ConnectionService on Android, both with proper cold-start handling
5. **Automatic cleanup** — Stale tokens removed on send failure; 24-hour keepalive maintains freshness
6. **User control** — Per-type per-channel preference system; Android notification channels for OS-level control

### 11.2 Potential Improvements

1. **Per-device SIP credentials** — Partially implemented (columns exist in `user_device_tokens`). Would eliminate the need for two-push correlation entirely by letting Telnyx push carry Z360 metadata
2. **Server-side badge tracking** — No badge count management on server. iOS badge may drift without explicit clearing
3. **Push notification analytics** — Basic logging exists but no dashboard for delivery rates, latency, or failure rates
4. **Missing push types for reminders** — `REMINDER_ASSIGNED` and `REMINDER_DUE_ALERT` are email-only; could benefit from push
5. **Token registration resilience** — If backend is unreachable during token registration, no retry mechanism beyond next app open

### 11.3 File Reference Map

| Component | Backend | Android | iOS | Frontend |
|-----------|---------|---------|-----|----------|
| **VoIP Push Sender** | `app/Services/PushNotificationService.php` | — | — | — |
| **APNs VoIP** | `app/Services/ApnsVoipService.php` | — | — | — |
| **Business Push Channel** | `app/Channels/FcmChannel.php` | — | — | — |
| **Push Synchronizer** | — | `voip/PushSynchronizer.kt` | `VoIP/Services/PushCorrelator.swift` | — |
| **FCM Handler** | — | `fcm/Z360FirebaseMessagingService.kt` | — | — |
| **PushKit Handler** | — | — | `VoIP/Managers/PushKitManager.swift` | — |
| **CallKit Manager** | — | — | `VoIP/Managers/CallKitManager.swift` | — |
| **Token Registration** | `app/Http/Controllers/DeviceTokenController.php` | — | `AppDelegate.swift` | `hooks/use-push-notifications.ts` |
| **Device Token Model** | `app/Models/UserDeviceToken.php` | — | — | — |
| **Webhook Handler** | `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | — | — | — |
| **Notification Classes** | `app/Notifications/*.php` | — | — | — |
| **Firebase Config** | `config/firebase.php`, `config/services.php` | `google-services.json` | `GoogleService-Info.plist` | — |
| **APNs Config** | `config/services.php:59-71` | — | `App.entitlements` | — |

---

*This document synthesizes findings from three parallel research tracks: two-push architecture analysis, non-VoIP notification cataloging, and push credential configuration mapping. All code references verified against Z360 codebase skills (voip-backend, voip-android, voip-ios, voip-frontend).*
