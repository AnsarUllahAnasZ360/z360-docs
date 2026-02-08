---
title: Simultaneous Ringing Complete
---

# Z360 Simultaneous Ringing: Complete Whitepaper

> **Version**: 1.0 | **Date**: 2026-02-08
> **Status**: Deep-dive research complete
> **Sources**: Z360 codebase (voip-backend/android/ios/frontend skills), Telnyx PHP/Web/iOS/Android SDK packs, Telnyx official docs, Twilio/Vonage docs

---

## Executive Summary

Z360 implements simultaneous ringing (sim-ring) using a **manual N-leg + Redis cache-lock** architecture built on Telnyx's Call Control API. When an inbound PSTN call arrives, the Laravel backend creates individual outbound SIP legs to each registered device's credential, then coordinates "first answer wins" bridging via an atomic Redis lock. This approach is **architecturally sound and follows Telnyx's recommended pattern** for Call Control apps with on-demand per-device credentials.

However, several **critical failure modes** have been identified that explain the known production bugs:

| Known Bug | Root Cause | Severity |
|---|---|---|
| Ghost credentials / phantom SIP legs | No credential cleanup on logout, reinstall, or expiry | **Critical** |
| "Kept ringing after answer" (Android) | All 3 dismissal channels can fail simultaneously (SIP BYE + FCM + Reverb) | **Critical** |
| Caller hangs up but devices keep ringing | `originator_cancel` handler doesn't cancel SIP legs | **Critical** |
| Duplicate ringing on same device | No deduplication in credential creation; orphaned DB rows | **High** |
| Stale sessions / dead endpoints | 24h `last_active_at` filter too wide; `credential_expires_at` never checked | **High** |

This whitepaper documents the current implementation in full detail, catalogs every failure mode with evidence, evaluates alternative approaches, and proposes a hardening plan.

---

## Table of Contents

1. [Current State: End-to-End Flow](#1-current-state-end-to-end-flow)
2. [System Diagrams](#2-system-diagrams)
3. [Root Cause Analysis](#3-root-cause-analysis)
4. [Official Telnyx Recommendations](#4-official-telnyx-recommendations)
5. [Gap Analysis](#5-gap-analysis)
6. [Target Architecture](#6-target-architecture)
7. [Implementation Checklist](#7-implementation-checklist)
8. [Testing Plan](#8-testing-plan)
9. [Appendix](#9-appendix)

---

## 1. Current State: End-to-End Flow

### 1.1 Prerequisites: Per-Device SIP Credentials

Every device must have its own SIP credential stored in `user_device_tokens`.

**Creation path**: `DeviceTokenController::store` → `CPaaSService::createDeviceCredential()` → `Telnyx\TelephonyCredential::create()`

```php
// app/Services/CPaaSService.php — createDeviceCredential()
$name = "Device-{$deviceToken->device_id}_".Str::random(8);
$credential = \Telnyx\TelephonyCredential::create([
    'name' => $name,
    'connection_id' => $connectionId,
]);
$deviceToken->update([
    'telnyx_credential_id' => $credential->id,
    'sip_username' => $credential->sip_username,
    'sip_password' => $credential->sip_password,
    'credential_expires_at' => now()->addDays(30),
]);
```

**Storage**: `user_device_tokens` table with columns: `user_id`, `device_id`, `platform` (android/ios/web), `fcm_token`, `sip_username`, `sip_password`, `telnyx_credential_id`, `connection_id`, `credential_expires_at`, `last_active_at`, `organization_id`.

**Critical rule**: Org-level credentials (`user_telnyx_telephony_credentials.sip_username`) are NEVER dialed for sim-ring. Only per-device SIP credentials from `user_device_tokens` are used.

### 1.2 Phase 1: Inbound Call Arrives

**Trigger**: PSTN call → Telnyx → `POST /webhooks/cpaas/telnyx/call-control` → `call.initiated` webhook

**Route**: `TelnyxCallController` → `TelnyxInboundWebhookController::handleCall()`

**Resolution chain**:
1. Parse `TelnyxCallInitiatedData` from webhook payload
2. Resolve `AuthenticatedPhoneNumber` from `$data->to`
3. Get `Organization` from channel
4. Get `receivingUser` from channel configuration
5. Create `Message` + `Conversation` for call logging
6. Validate: not blocked, within schedule, user exists
7. Store metadata: `original_from`, `received_by`, `parent_call_control_id`
8. Call `transferToUser()`

**Source**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php::handleCall()`

### 1.3 Phase 2: Notification Dispatch

Inside `transferToUser()`, the backend sends notifications to all user devices:

**Mobile push (Z360 push)**:
```php
PushNotificationService::sendIncomingCallPush(
    userId: $user->id,
    callSessionId: ..., callControlId: ...,
    callerNumber: ..., callerName: ..., channelNumber: ...,
    organizationId: ..., organizationName: ..., organizationSlug: ...,
    callerAvatar: ..., callId: ...
);
```

**Payload**: `type: "incoming_call"` with full caller display info (name, number, avatar, org context).

**Web broadcast (Reverb)**:
```php
event(new IncomingCallNotification(
    user: $user, callSessionId: ..., callControlId: ...,
    callerNumber: ..., callerName: ..., channelNumber: ...,
    organizationId: ..., organizationName: ...
));
```

**Channel**: `private-tenant.App.Models.User.{userId}.{organizationId}`

**Note**: Web does NOT consume this broadcast for incoming call detection — it relies on SIP INVITE via Telnyx WebSocket. The broadcast is informational only. Web DOES consume `call_ended` broadcast.

### 1.4 Phase 3: SIP Leg Creation

```php
$sipDestinations = UserDeviceToken::where('user_id', $user->id)
    ->whereNotNull('sip_username')
    ->where('last_active_at', '>=', now()->subDay())
    ->pluck('sip_username')->toArray();
```

**Filter**: Non-null `sip_username` + `last_active_at` within 24 hours.

**Single device**: `Call::transfer()` (simple redirect, no sim-ring)
**Multiple devices**: `Call::create()` for each SIP credential:

```php
foreach ($sipDestinations as $sip) {
    \Telnyx\Call::create([
        'to' => "sip:{$sip}@sip.telnyx.com",
        'from' => $message->metadata['original_from'],
        'connection_id' => $connectionId,
        'webhook_url' => $webhookUrl,
        'timeout_secs' => 30,
        'client_state' => base64_encode(json_encode([
            'type' => 'simultaneous_ring_leg',
            'parent_call_control_id' => $call_control_id,
            'user_id' => $user->id,
            'message_id' => $message->id,
            'organization_id' => $organization?->id,
        ])),
    ]);
}
```

**Retry**: If ALL legs fail, retry once after `usleep(2_000_000)` (2 seconds). If still all fail → voicemail.

**Parent call stays parked**: NOT answered yet. PSTN caller hears carrier ringback.

### 1.5 Phase 4: Cache Session Storage

```php
Cache::put("simring:{$call_control_id}", [
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
    'answered' => false,
    'leg_ids' => [],  // Populated by call.initiated webhooks
], now()->addMinutes(10));
```

**TTL**: 10 minutes (refreshed on each cache update).

### 1.6 Phase 5: Leg ID Tracking

Each leg's `call.initiated` webhook populates `leg_ids`:

```php
// onSimultaneousRingLegInitiated()
$ringSession['leg_ids'][] = $legCallControlId;
Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```

### 1.7 Phase 6: Device-Side Reception

**Android**: FCM push → `Z360FirebaseMessagingService` → `PushSynchronizer` (500ms two-push correlation) → `ensureTelnyxSdkConnected()` → `IncomingCallActivity`

**iOS**: PushKit → `PushKitManager` → `PushCorrelator` (500ms-1.5s correlation) → `reportIncomingCall()` to CallKit (must complete within 5s of PushKit delivery) → Native call UI

**Web**: Telnyx WebRTC WebSocket → `useNotification()` → `<IncomingCall />` UI component

### 1.8 Phase 7: Answer + Bridge Coordination

When first device sends SIP 200 OK → Telnyx sends `call.answered` webhook:

```php
// onCallAnswered()
$lock = Cache::lock("simring:{$parentId}:lock", 10);  // 10s TTL
if (!$lock->get()) {
    // Late answerer — hang up this leg
    $call->hangup();
    return;
}

try {
    $ringSession = Cache::get("simring:{$parentId}");
    if ($ringSession && !$ringSession['answered']) {
        // 1. Mark answered
        $ringSession['answered'] = true;
        $ringSession['answered_leg'] = $legCallControlId;
        Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));

        // 2. Answer parent (PSTN caller stops hearing ringback)
        Call::constructFrom(['call_control_id' => $parentId])->answer([
            'client_state' => base64_encode(json_encode([
                'type' => 'simultaneous_ring_parent', ...
            ])),
        ]);

        // 3. Bridge parent ↔ answered leg (audio flows)
        Call::constructFrom(['call_control_id' => $parentId])
            ->bridge(['call_control_id' => $legCallControlId]);

        // 4. Start recording
        Call::constructFrom(['call_control_id' => $parentId])->record_start([...]);

        // 5. Hang up other legs
        foreach ($ringSession['leg_ids'] as $otherLegId) {
            if ($otherLegId !== $legCallControlId) {
                Call::constructFrom(['call_control_id' => $otherLegId])->hangup();
            }
        }

        // 6. Notify other devices
        event(new CallEndedNotification(userId, callSessionId, 'answered_elsewhere', orgId));
        PushNotificationService::sendCallEndedPush(userId, callSessionId);
    }
} finally {
    $lock->release();
}
```

### 1.9 Phase 8: Three-Channel Ring Dismissal

Other devices receive dismissal via three independent channels:

| Channel | Mechanism | Target | Latency |
|---|---|---|---|
| **SIP BYE** | `Call::hangup()` on each leg → Telnyx SIP BYE | All devices with SIP | ~200-500ms |
| **Reverb broadcast** | `CallEndedNotification` event | Web sessions | ~50-200ms |
| **FCM/APNs push** | `sendCallEndedPush()` | Mobile devices | 100ms-30s |

**Android dismissal**: `call_ended` FCM → `ACTION_CALL_ENDED` broadcast → `IncomingCallActivity` finishes + notifications cancelled

**iOS dismissal**: `call_ended` push → `reportCallEnded(reason: .answeredElsewhere)` to CallKit

**Web dismissal**: `.call_ended` Reverb event → `activeCall.hangup()` if in `ringing`/`requesting` state

### 1.10 Phase 9: Call End

**PSTN caller hangs up**: `call.hangup` with `client_state.type = 'simultaneous_ring_parent'` → `onSimultaneousRingParentHangup()` → hang up bridged leg → cleanup cache → send notifications

**Device user hangs up**: SIP BYE → `call.hangup` with `client_state.type = 'simultaneous_ring_leg'` → `onSimultaneousRingLegHangup()` → hang up parent → cleanup cache → send notifications

---

## 2. System Diagrams

### 2.1 High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    PSTN / External Caller                        │
└─────────────────────────┬───────────────────────────────────────┘
                          │ INVITE
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Telnyx Call Control Platform                      │
│                                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │
│  │ Webhooks │  │ SIP Legs │  │  Bridge   │  │  Recording   │    │
│  │  Engine  │  │  Engine  │  │  Engine   │  │   Engine     │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┘    │
└───────┼──────────────┼──────────────┼───────────────────────────┘
        │              │              │
        ▼              │              │
┌───────────────────────────────────────────────────────────────────┐
│                   Z360 Laravel Backend                             │
│                                                                     │
│  ┌─────────────────────────┐  ┌────────────────────────────────┐  │
│  │  TelnyxCallController    │  │  TelnyxInboundWebhookController│  │
│  │  (webhook router)        │  │  - handleCall()                │  │
│  └──────────┬──────────────┘  │  - transferToUser()             │  │
│             │                  │  - onCallAnswered()             │  │
│             ▼                  │  - onSimRingLegHangup()         │  │
│  ┌──────────────────────┐     │  - onSimRingParentHangup()      │  │
│  │  CPaaSService         │     └────────────────────────────────┘  │
│  │  - createDeviceCred() │                                          │
│  │  - handleCredentials()│     ┌────────────────────────────────┐  │
│  └──────────────────────┘     │  Redis Cache                    │  │
│                                │  - simring:{parent_id}         │  │
│  ┌──────────────────────┐     │  - simring:{parent_id}:lock    │  │
│  │  PushNotificationSvc  │     └────────────────────────────────┘  │
│  │  - sendIncomingPush() │                                          │
│  │  - sendCallEndedPush()│     ┌────────────────────────────────┐  │
│  └──────────────────────┘     │  PostgreSQL                     │  │
│                                │  - user_device_tokens           │  │
│  ┌──────────────────────┐     │  - user_telnyx_telephony_creds  │  │
│  │  Laravel Reverb       │     │  - messages (call logging)      │  │
│  │  (WebSocket server)   │     └────────────────────────────────┘  │
│  └──────────────────────┘                                          │
└───────────────────────────────────────────────────────────────────┘
        │              │              │              │
        │ FCM/APNs     │ SIP INVITE   │ SIP INVITE   │ WebSocket
        │ Push         │              │              │ + SIP INVITE
        ▼              ▼              ▼              ▼
┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────────┐
│ Android  │  │    iOS       │  │  Web      │  │  Web Tab 2   │
│          │  │              │  │  Tab 1    │  │  (same user) │
│ Telnyx   │  │ PushKit/     │  │           │  │              │
│ SDK +    │  │ CallKit +    │  │ Telnyx    │  │ Telnyx       │
│ FCM      │  │ Telnyx SDK   │  │ WebRTC    │  │ WebRTC       │
└──────────┘  └──────────────┘  └──────────┘  └──────────────┘
```

### 2.2 Sequence Diagram: Simultaneous Ring (Happy Path)

```
Caller      Telnyx CC      Laravel           Redis           Android        iOS           Web
  │              │             │                │               │             │              │
  │──INVITE─────►│             │                │               │             │              │
  │              │─webhook─────►│               │               │             │              │
  │              │             │                │               │             │              │
  │              │             │ Parse + validate               │             │              │
  │              │             │ Create Message                 │             │              │
  │              │             │                │               │             │              │
  │              │             │──FCM push──────────────────────►│            │              │
  │              │             │──APNs VoIP push────────────────────────────►│              │
  │              │             │──Reverb broadcast──────────────────────────────────────────►│
  │              │             │                │               │             │              │
  │              │             │──Call::create() per device──►  │             │              │
  │              │◄────────────│(3 API calls)   │               │             │              │
  │              │             │                │               │             │              │
  │              │             │─Cache::put─────►│              │             │              │
  │              │             │ simring:{parent}│              │             │              │
  │              │             │ answered:false  │              │             │              │
  │              │             │ leg_ids:[]      │              │             │              │
  │              │             │                │               │             │              │
  │ (ringback)   │──SIP INVITE──────────────────────────────────►│            │              │
  │              │──SIP INVITE────────────────────────────────────────────────►│             │
  │              │──SIP INVITE──────────────────────────────────────────────────────────────►│
  │              │             │                │               │             │              │
  │              │─call.initiated×3─►│          │               │             │              │
  │              │             │─leg_ids[]──────►│              │             │              │
  │              │             │  update         │              │             │              │
  │              │             │                │               │             │              │
  │              │             │                │        PushSync/Correlate   PushCorrelate  │
  │              │             │                │        IncomingCallActivity CallKit UI     │
  │              │             │                │            ┌───RINGING───┐  ┌─RINGING─┐   │
  │              │             │                │            │             │  │         │   │
  │              │             │                │    USER ANSWERS          │  │         │   │
  │              │             │                │            │             │  │         │   │
  │              │◄──SIP 200 OK──────────────────────────────┘             │  │         │   │
  │              │─call.answered─►│             │               │          │  │         │   │
  │              │             │                │               │          │  │         │   │
  │              │             │─lock acquire───►│ ✓            │          │  │         │   │
  │              │             │─Cache update───►│              │          │  │         │   │
  │              │             │ answered:true   │              │          │  │         │   │
  │              │             │                │               │          │  │         │   │
  │              │◄─answer()───│(parent answered)│              │          │  │         │   │
  │◄─audio──────►│             │                │               │          │  │         │   │
  │              │◄─bridge()───│                │               │          │  │         │   │
  │◄═══AUDIO═══►│◄════════════════MEDIA═══════════════════════►│          │  │         │   │
  │              │             │                │               │          │  │         │   │
  │              │◄─hangup()───│(other legs)    │               │          │  │         │   │
  │              │──SIP BYE────────────────────────────────────────────────►│  └─ended──┘   │
  │              │──SIP BYE──────────────────────────────────────────────────────────────────►│
  │              │             │                │               │          │                │
  │              │             │──CallEndedNotification(Reverb)─────────────────────────────►│
  │              │             │──sendCallEndedPush(FCM/APNs)───────────────►│              │
  │              │             │                │               │          │                │
  │              │             │─lock release───►│              │          │                │
  │              │             │                │               │          │                │
  │◄═══CALL IN PROGRESS═══════════════════════════════════════►│          │                │
```

### 2.3 Sequence Diagram: Caller Hangs Up During Ring (Bug)

```
Caller      Telnyx CC      Laravel           Redis        Android (A)    Android (B)
  │              │             │                │              │              │
  │ HANGS UP     │             │                │              │              │
  │──────────────►│            │                │     RINGING  │    RINGING   │
  │              │             │                │              │              │
  │              │─call.hangup─►│               │              │              │
  │              │  (parent, no client_state)   │              │              │
  │              │             │                │              │              │
  │              │             │ sendCallEndedPush───────────►│──────────────►│
  │              │             │ CallEndedNotification(Reverb)│              │
  │              │             │                │              │              │
  │              │             │ if originator_cancel:         │              │
  │              │             │   return  ◄─── BUG: SIP legs NOT cancelled  │
  │              │             │                │              │              │
  │              │             │                │   ┌──────────┼──────────────┤
  │              │             │                │   │ FCM push │ FCM push     │
  │              │             │                │   │ arrives  │ arrives      │
  │              │             │                │   │ (100ms-  │ (100ms-      │
  │              │             │                │   │  30s)    │  30s)        │
  │              │             │                │   │ dismiss  │ dismiss UI   │
  │              │             │                │   │ UI       │              │
  │              │             │                │   └──────────┼──────────────┤
  │              │             │                │              │              │
  │              │             │                │   BUT: SIP legs still alive │
  │              │             │                │   Telnyx SDK may show       │
  │              │             │                │   notification until        │
  │              │             │                │   30s timeout_secs          │
```

---

## 3. Root Cause Analysis

### 3.1 Critical Severity

#### RC-1: Ghost Credentials (No Cleanup Mechanism)

**Symptom**: Phantom SIP legs created to dead devices; wasted Telnyx resources; delayed call setup.

**Root cause**: `CPaaSService::createDeviceCredential()` always creates a new Telnyx credential without checking if one already exists. `DeviceTokenController::destroy()` deletes the DB row but does NOT delete the Telnyx credential. No cleanup on app uninstall. No background job for pruning expired/stale credentials.

**Evidence**:
- `createDeviceCredential()` has no idempotency check — `.claude/skills/voip-backend` skill lines 4368-4389
- `destroy()` only deletes DB row — `.claude/skills/voip-backend` skill lines 2824-2835
- `credential_expires_at` set to 30 days but NEVER checked in `transferToUser()`
- `updateOrCreate` keyed on `fcm_token` can orphan old SIP credentials when token rotates

**Impact**: Every reinstall, re-login, or FCM token rotation creates an orphaned Telnyx credential. Over time, users accumulate ghost credentials that receive SIP INVITEs nobody answers, causing 30-second timeouts per ghost.

#### RC-2: Caller Hangup Doesn't Cancel SIP Legs

**Symptom**: Devices keep ringing after PSTN caller disconnects.

**Root cause**: When parent `call.hangup` arrives with `originator_cancel`, the handler sends push/broadcast notifications but does NOT look up the simring cache to cancel active SIP legs. The `originator_cancel` early return prevents any simring-specific cleanup.

**Evidence**:
- `onCallHangup()` handler — `.claude/skills/voip-backend` skill lines 1702-1751
- Parent call has no `client_state` (never answered/tagged), so sim-ring-specific handlers don't fire
- Outbound SIP legs are independent calls — Telnyx does NOT auto-cancel them when parent hangs up

**Impact**: After caller disconnects, devices ring until either: (a) FCM push arrives and dismisses UI (100ms-30s), or (b) SIP leg times out (30 seconds). Meanwhile, Telnyx SDK may show its own notification (ID 1234) until timeout.

#### RC-3: Bridge Failure Leaves Call in Broken State

**Symptom**: Call answered but no audio; other devices keep ringing.

**Root cause**: In `onCallAnswered()`, all post-bridge operations (hang up other legs, send notifications) are inside the same try block as the bridge call. If `Call::bridge()` fails, everything after it is skipped. The parent has already been answered (caller hears silence). Other legs are never cancelled.

**Evidence**:
- Single try block for answer + bridge + hangup-others + notify — `.claude/skills/voip-backend` skill lines 2078-2170
- No bridge retry mechanism
- No compensation logic for partial failure

**Impact**: Rare but catastrophic. Both parties hear silence. Other devices keep ringing. System recovers only when someone manually hangs up.

#### RC-4: "Kept Ringing After Answer" (Android)

**Symptom**: Other Android devices continue showing incoming call after one device answers.

**Root cause**: Composite failure of all three dismissal channels:
1. **SIP BYE**: Fails if leg_ids weren't populated yet (webhook race — RC-6), or SDK is disconnected/stale
2. **FCM push**: Delayed by Android Doze mode (up to 15 minutes for data messages)
3. **Broadcast receiver**: `IncomingCallActivity` registers receiver in `onStart()`, unregisters in `onStop()` — if Activity is in background, broadcast has no receiver

**Evidence**:
- Leg ID tracking race — `.claude/skills/voip-backend` skill lines 2362-2394 (starts empty, populated async)
- Broadcast receiver lifecycle — `.claude/skills/voip-android` skill lines 4804-4822
- Telnyx SDK notification (ID 1234) persists independently

**Impact**: Common in production. User sees incoming call even after another device answered. Severely degrades trust.

### 3.2 High Severity

#### RC-5: Duplicate Registrations (No Deduplication)

**Symptom**: Same physical device receives multiple SIP INVITEs; duplicate ringing.

**Root cause**: `createDeviceCredential()` creates a new credential without checking if the device token already has one. App reinstall → new FCM token → new DB row with new SIP credential → old row still exists. FCM token rotation → same pattern.

**Evidence**: `createDeviceCredential()` — no check for existing `telnyx_credential_id` — `.claude/skills/voip-backend` skill lines 4368-4389

**Impact**: User's phone rings twice for the same call. Confusing UX.

#### RC-6: Webhook Out-of-Order Race

**Symptom**: "Hang up other legs" loop iterates over empty `leg_ids`; other legs never cancelled.

**Root cause**: `leg_ids` starts empty in the cache and is populated asynchronously by `call.initiated` webhooks. If a device answers before all `call.initiated` webhooks are processed, the hang-up loop has incomplete data.

**Evidence**: Cache initialized with `leg_ids: []` in `transferToUser()` — `.claude/skills/voip-backend` skill lines 1955-1961. Populated by `onSimultaneousRingLegInitiated()` — skill lines 2362-2394. No guarantee of ordering between `call.initiated` and `call.answered` webhooks.

**Impact**: Legs not in `leg_ids` continue ringing until 30-second timeout.

#### RC-7: Lock Expiry Theoretical Risk

**Symptom**: Potential for double processing if answer+bridge+hangup takes >10 seconds.

**Root cause**: Redis lock TTL is 10 seconds. If Telnyx API is slow, lock may expire before `finally { $lock->release() }`. However, the `answered = true` cache flag provides a secondary guard.

**Evidence**: Lock TTL — `.claude/skills/voip-backend` skill line 2057. Laravel Redis locks use owner tokens, so releasing someone else's lock is a no-op.

**Impact**: Very unlikely in practice due to cache flag check. Theoretical concern.

### 3.3 Medium Severity

#### RC-8: Push Notification Unreliability

**Symptom**: Device doesn't ring (missing Telnyx push) or shows raw number (missing Z360 push).

**Root cause**: Two-push system with best-effort delivery. FCM/APNs are not guaranteed. PushSynchronizer has 500ms timeout. If Telnyx push is missing, device never rings via SIP.

#### RC-9: Cache Expiry During Long Calls

**Symptom**: After 10+ minute calls, hangup handler can't find cache → cleanup notifications not sent.

**Root cause**: Cache TTL is 10 minutes. Calls lasting longer lose their simring state. Mitigated by `client_state`-based routing in hangup handlers.

#### RC-10: Cross-Org Call Fragility

**Symptom**: Call fails during org switch; iOS 5-second CallKit deadline exceeded.

**Root cause**: Org switch requires sequential: API call → credential regeneration → SDK reconnect. Inherently slow and fragile under time pressure.

---

## 4. Official Telnyx Recommendations

### 4.1 Telnyx's Position on Simultaneous Ringing

**Z360's manual N-leg approach is the recommended pattern** for Call Control webhook-driven apps with on-demand credentials. Key evidence:

1. **On-demand credentials cannot receive inbound calls**: "The purpose for on demand generated credentials is purely for outbound calls. The typical use case is a call center service... your backend system can route calls to those agents." — [Telnyx Credential Types](https://support.telnyx.com/en/articles/7029684-telephony-credentials-types)

2. **FindMe/FollowMe demo**: Telnyx's own reference implementation uses the same pattern (webhook-driven, client_state for context, park + transfer/bridge) — [demo-findme-ivr](https://github.com/team-telnyx/demo-findme-ivr)

3. **No built-in ring group API**: Telnyx does not offer a first-class ring group entity for Call Control apps.

### 4.2 Telnyx Capabilities NOT Used by Z360

| Capability | Description | Why Not Used |
|---|---|---|
| **SIP Connection sim-ring** | Shared credentials, Telnyx forks INVITE | Requires shared credentials; no per-device identity |
| **Dial API multi-`to`** | Array of destinations in single call | Creates new calls; can't route existing inbound |
| **TeXML `<Dial>` multi-noun** | Declarative sim-ring | Different architecture paradigm; would require complete rewrite |
| **`bridge_on_answer`** | Auto-bridge on answer | Untested with multiple legs to same `link_to`; race conditions unclear |
| **Call Control Queue** | FIFO call distribution | Wrong pattern; sequential not simultaneous |
| **Media forking** | RTP stream duplication | For audio analysis, not call forking |

### 4.3 Credential Lifecycle Best Practices

From Telnyx documentation:

1. **Set `expires_at`** on credentials for security (Z360 does NOT do this)
2. **Use `tag`** for bulk management (e.g., `tag: "org-{org_id}"`)
3. **Filter by status** for cleanup: `filter[status]=expired`
4. **No built-in rotation** — create new → migrate → delete old
5. **No credential limits** per connection or account
6. **Delete revokes immediately**: `DELETE /v2/telephony_credentials/{id}`

### 4.4 Competitor Comparison

| Feature | Z360 (Telnyx CC) | Twilio TwiML | Vonage NCCO |
|---|---|---|---|
| Sim-ring method | Manual N-leg + lock | `<Dial>` multi-noun | `connect` multi-endpoint |
| First-answer-wins | Redis lock (app-level) | Automatic | Automatic |
| Max simultaneous | Unlimited | 10 | 5 (VBC) |
| Per-leg control | Full | None | None |
| Business logic | Full (webhooks) | Limited (XML) | Limited (JSON) |
| Complexity | High | Low | Low |
| Flexibility | Highest | Medium | Medium |

---

## 5. Gap Analysis

### 5.1 Current vs. Target (Credential Management)

| Aspect | Current | Target |
|---|---|---|
| Credential creation | Always creates new; no dedup | Check existing first; delete old before creating new |
| Credential deletion on logout | DB row only; Telnyx credential orphaned | Delete from both DB and Telnyx API |
| Credential expiry | `expires_at` set but never checked | Check in `transferToUser()`; skip expired |
| Credential cleanup | None | Background job: prune stale tokens (>7 days inactive, expired) |
| Telnyx `expires_at` | Not set on creation | Set on creation for security |
| Telnyx `tag` | Not used | Tag with `org-{org_id}` for bulk ops |

### 5.2 Current vs. Target (Call Flow)

| Aspect | Current | Target |
|---|---|---|
| Caller hangup → leg cancellation | Push/broadcast only; SIP legs NOT cancelled | Cancel all SIP legs from simring cache |
| Leg ID tracking | Async via `call.initiated` webhooks (race) | Store `call_control_id` from `Call::create()` response directly |
| Bridge failure recovery | None; all post-bridge ops in same try block | Separate try blocks; bridge retry; compensation |
| Lock TTL | Fixed 10s | Consider extending or using cache flag as primary guard |
| Cache TTL | Fixed 10min | Extend to max call duration (2h) or refresh on bridge |
| Android ringing dismissal | 3 channels (all can fail) | Add 4th channel: periodic backend status poll |
| `usleep(2s)` in webhook | Synchronous blocking | Async dispatch (queue/job) |

---

## 6. Target Architecture

### 6.1 Design Principles

1. **Idempotent credential provisioning**: One credential per device, deduplicated by `device_id`, with cleanup on create/delete
2. **Deterministic winner selection**: Redis lock + cache flag (current), with leg IDs populated synchronously
3. **Fail-safe ring dismissal**: Four independent channels (SIP BYE + FCM push + Reverb broadcast + client-side poll)
4. **Compensation on failure**: Separate error handling for each step; bridge retry; cleanup regardless of bridge success
5. **Active lifecycle management**: Credentials expire, are pruned, and are validated before use

### 6.2 Credential Lifecycle (Target)

```
Device Login
  ├── Check: existing UserDeviceToken for this user + device_id?
  │   ├── Yes: delete old Telnyx credential → create new one → update row
  │   └── No: create new row → create Telnyx credential
  ├── Set Telnyx expires_at (30 days)
  ├── Set Telnyx tag: "org-{org_id}"
  └── Return SIP credentials to device

Device Logout
  ├── Delete Telnyx credential via API: DELETE /v2/telephony_credentials/{id}
  └── Delete UserDeviceToken row

Background Cleanup Job (daily)
  ├── Find tokens where last_active_at < 7 days ago
  ├── Find tokens where credential_expires_at < now()
  ├── For each: delete Telnyx credential → delete DB row
  └── Log pruned count
```

### 6.3 Sim-Ring Flow (Target)

```
transferToUser():
  1. Query user_device_tokens WHERE:
     - sip_username IS NOT NULL
     - last_active_at >= now() - 24h
     - credential_expires_at > now()  // NEW: check expiry

  2. Send push notifications (FCM/APNs) + Reverb broadcast

  3. Create SIP legs (same as current):
     foreach ($sipDestinations as $sip) {
         $response = Call::create([...]);
         $createdLegIds[] = $response->call_control_id;  // NEW: capture immediately
     }

  4. Store ring session with leg IDs populated:
     Cache::put("simring:{$parent}", [
         ...
         'leg_ids' => $createdLegIds,  // NEW: populated immediately, not async
     ], now()->addHours(2));  // NEW: 2-hour TTL

onCallAnswered():
  1. Acquire lock (same as current)
  2. Check answered flag (same as current)
  3. Mark answered + cache update (same as current)

  4. Answer parent (same as current)

  5. Bridge parent ↔ leg:
     try {
         Call::bridge([...]);
     } catch (\Throwable $e) {
         // NEW: Bridge retry (1 attempt, 500ms delay)
         usleep(500_000);
         try { Call::bridge([...]); } catch (\Throwable $e2) {
             // Log and continue — other cleanup must still happen
         }
     }

  6. ALWAYS execute (regardless of bridge success):  // NEW: separate try block
     try {
         Call::record_start([...]);
     } catch (\Throwable $e) { /* log */ }

     foreach ($ringSession['leg_ids'] as $otherLegId) {
         if ($otherLegId !== $legCallControlId) {
             try { Call::hangup($otherLegId); } catch (\Throwable) {}
         }
     }

     event(new CallEndedNotification(...));
     PushNotificationService::sendCallEndedPush(...);

  7. Release lock

onCallerHangupDuringRing():  // NEW handler
  When parent call.hangup arrives with originator_cancel:
  1. Look up simring:{call_control_id} cache
  2. If found and NOT answered:
     - Cancel ALL SIP legs: Call::hangup() for each leg_id
     - Delete cache entry
  3. Send call_ended push + broadcast (existing)
```

### 6.4 Android Hardened Dismissal (Target)

Add a 4th dismissal channel — periodic backend status poll:

```kotlin
// IncomingCallActivity — poll every 3 seconds
private val statusPoller = lifecycleScope.launch {
    while (isActive) {
        delay(3000)
        val response = apiService.getCallStatus(callSessionId)
        if (response.status == "ended" || response.status == "answered_elsewhere") {
            stopRinging()
            finish()
            break
        }
    }
}
```

This provides a guaranteed dismissal path independent of push, broadcast, and SIP reliability.

---

## 7. Implementation Checklist

### P0 — Must Fix (addresses Critical bugs)

- [ ] **7.1** Add caller-hangup SIP leg cancellation
  - In `onCallHangup()`, before `originator_cancel` return, check `simring:{call_control_id}` cache and cancel all legs
  - Delete cache entry after cancelling legs
  - **Files**: `TelnyxInboundWebhookController.php`

- [ ] **7.2** Add Telnyx credential cleanup on logout
  - In `DeviceTokenController::destroy()`, call `TelephonyCredential::delete($telnyx_credential_id)` before deleting DB row
  - **Files**: `DeviceTokenController.php`, `CPaaSService.php`

- [ ] **7.3** Add credential deduplication in `createDeviceCredential()`
  - Check if `$deviceToken->telnyx_credential_id` is set
  - If yes, delete old Telnyx credential first
  - Also check for other `UserDeviceToken` rows with same `device_id` and clean them up
  - **Files**: `CPaaSService.php`

- [ ] **7.4** Separate bridge from post-bridge operations
  - Move "hang up other legs" and "send notifications" outside the try block containing bridge
  - Add bridge retry (1 attempt with 500ms delay)
  - **Files**: `TelnyxInboundWebhookController.php::onCallAnswered()`

- [ ] **7.5** Populate leg_ids synchronously from Call::create() response
  - Store `$response->call_control_id` in `$createdLegIds[]` during the creation loop
  - Put these IDs in the cache immediately (not via async `call.initiated` webhooks)
  - Keep `onSimultaneousRingLegInitiated()` as a secondary update mechanism
  - **Files**: `TelnyxInboundWebhookController.php::transferToUser()`

### P1 — Should Fix (addresses High bugs)

- [ ] **7.6** Add credential expiry check in `transferToUser()`
  - Add `->where('credential_expires_at', '>', now())` to SIP destination query
  - **Files**: `TelnyxInboundWebhookController.php`

- [ ] **7.7** Create background cleanup job for stale credentials
  - Schedule daily: find tokens where `last_active_at < 7 days ago` OR `credential_expires_at < now()`
  - Delete Telnyx credential → delete DB row for each
  - **Files**: New `app/Console/Commands/PruneStaleDeviceTokens.php`, `app/Console/Kernel.php`

- [ ] **7.8** Set `expires_at` when creating Telnyx credentials
  - Pass `expires_at: now()->addDays(30)->toIso8601String()` to `TelephonyCredential::create()`
  - **Files**: `CPaaSService.php::createDeviceCredential()`

- [ ] **7.9** Add Android fallback dismissal (polling)
  - Add periodic backend status check in `IncomingCallActivity`
  - Poll `/api/voip/call-status/{sessionId}` every 3 seconds
  - Backend endpoint checks simring cache or message metadata
  - **Files**: New API endpoint + `IncomingCallActivity.kt`

### P2 — Nice to Have

- [ ] **7.10** Extend simring cache TTL to 2 hours
  - Change `now()->addMinutes(10)` to `now()->addHours(2)`
  - **Files**: `TelnyxInboundWebhookController.php`

- [ ] **7.11** Add Telnyx credential `tag` for bulk management
  - Pass `tag: "org-{organization_id}"` to `TelephonyCredential::create()`
  - **Files**: `CPaaSService.php`

- [ ] **7.12** Remove `usleep(2_000_000)` from webhook handler
  - Replace synchronous retry with queued retry job
  - **Files**: `TelnyxInboundWebhookController.php::transferToUser()`

- [ ] **7.13** Add web cross-tab coordination
  - Use `BroadcastChannel` API for cross-tab call state sync
  - **Files**: `resources/js/components/.../dialpad/context.tsx`

---

## 8. Testing Plan

### 8.1 Multi-Device Race Tests

| Test | Setup | Steps | Expected |
|---|---|---|---|
| T1: Two devices answer within 10ms | 2 Android devices, same user | Initiate call, both answer simultaneously | First lock winner bridges, second gets hangup. Only one active call. |
| T2: Three devices, all answer | 3 devices (Android + iOS + web) | Initiate call, all answer within 1 second | Only one bridge; other two dismissed cleanly |
| T3: Answer before `call.initiated` | 1 fast-answer device | Device auto-answers before leg tracking complete | Bridge succeeds; other legs eventually cancelled via timeout or async cleanup |
| T4: Caller hangup while ringing | 3 devices ringing | Caller disconnects after 5 seconds | All devices stop ringing within 2 seconds (SIP BYE + push) |

### 8.2 Credential Lifecycle Tests

| Test | Setup | Steps | Expected |
|---|---|---|---|
| T5: Reinstall deduplication | 1 Android device | Install → register → uninstall → reinstall → register | Only 1 active credential in `user_device_tokens`; old Telnyx cred deleted |
| T6: Logout cleanup | 1 Android device | Login → register → logout | DB row deleted AND Telnyx credential deleted |
| T7: Token rotation | 1 Android device | FCM rotates token | Old DB row cleaned up; new row with new credential |
| T8: Expired credential | 1 device with expired cred | Incoming call | Expired credential NOT dialed; no SIP leg to dead endpoint |

### 8.3 Failure Recovery Tests

| Test | Setup | Steps | Expected |
|---|---|---|---|
| T9: Bridge failure | Mock `Call::bridge()` to throw | Device answers → bridge fails | Other legs still hung up; notifications still sent; parent not left in silence indefinitely |
| T10: Lock expiry under load | Slow Telnyx API (>10s) | Two devices answer | Second device sees `answered = true` flag → hangs up own leg |
| T11: Network partition | Kill network mid-leg-creation | Backend loses connectivity | Partial legs created; retry fires; voicemail fallback if all fail |
| T12: Push delivery failure | Block FCM to one device | Another device answers | Blocked device still stops ringing via SIP BYE (primary) or poll (fallback) |

### 8.4 Android-Specific Tests

| Test | Setup | Steps | Expected |
|---|---|---|---|
| T13: Doze mode dismissal | Device A in Doze | Device B answers | Device A stops ringing via SIP BYE (if SDK connected) or poll (if not) |
| T14: Activity in background | IncomingCallActivity in onStop | Another device answers | SIP BYE or poll dismisses ringing; broadcast receiver re-registers on next onStart |
| T15: Duplicate notification | 2 SIP credentials for same device | Incoming call | Only 1 ring UI shown (deduplicate by call_session_id) |

### 8.5 iOS-Specific Tests

| Test | Setup | Steps | Expected |
|---|---|---|---|
| T16: CallKit 5s deadline | Slow SDK reconnection | PushKit delivers, answer attempted | Must report to CallKit within 5s or app killed |
| T17: Cross-org answer | Device on Org A, call for Org B | Answer within 5s | Org switch + credential swap + answer succeeds |
| T18: Rapid call_ended | call_ended arrives before call reported | Process call_ended push | Fake call reported to CallKit + immediately ended (PushKit contract satisfied) |

---

## 9. Appendix

### 9.1 Cache Key Reference

| Key Pattern | Purpose | TTL | Set By | Deleted By |
|---|---|---|---|---|
| `simring:{parent_call_control_id}` | Ring session state (legs, answered flag) | 10min (target: 2h) | `transferToUser()` | `onSimRingParentHangup()`, `onSimRingLegHangup()` |
| `simring:{parent_call_control_id}:lock` | Atomic lock for first-answer-wins | 10s | `onCallAnswered()` | Auto-release in `finally` block |

### 9.2 `client_state` Type Reference

| Type | Used On | Purpose | Set By |
|---|---|---|---|
| `simultaneous_ring_leg` | Outbound legs (N per call) | Identifies leg for webhook routing | `transferToUser()` |
| `simultaneous_ring_parent` | Parent call (after answer) | Identifies parent for hangup routing | `onCallAnswered()` |
| `user_call` | Single-device transfer | Simple 1:1 transfer (no simring) | `transferToUser()` (1 device path) |
| `voicemail_parent` | Parent call (voicemail) | Routes to voicemail handler | `transferToVoicemail()` |
| `voicemail_greeting` | Greeting playback | Greeting finished → record | Voicemail flow |

### 9.3 File Index

**Backend (Laravel)**:
| File | Key Functions |
|---|---|
| `app/Http/Controllers/Telnyx/TelnyxCallController.php` | Webhook router |
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | `handleCall()`, `transferToUser()`, `onCallAnswered()`, `onSimRingLegHangup()`, `onSimRingParentHangup()` |
| `app/Services/CPaaSService.php` | `createDeviceCredential()`, `handleCredentials()`, `parseClientState()` |
| `app/Http/Controllers/Api/DeviceTokenController.php` | `store()`, `destroy()` |
| `app/Models/UserDeviceToken.php` | `getFcmTokensForUser()`, `getApnsVoipTokensForUser()` |
| `app/Services/PushNotificationService.php` | `sendIncomingCallPush()`, `sendCallEndedPush()` |
| `app/Events/IncomingCallNotification.php` | Reverb broadcast for incoming call |
| `app/Events/CallEndedNotification.php` | Reverb broadcast for call ended |
| `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php` | Webhook payload parsing |
| `app/Models/AuthenticatedPhoneNumber.php` | Phone → org/user resolution |

**Android**:
| File | Key Functions |
|---|---|
| `Z360FirebaseMessagingService.kt` | `onMessageReceived()`, `handleZ360CallerInfoPush()`, `handleTelnyxMetadataPush()` |
| `TelnyxVoipPlugin.kt` | Capacitor bridge, `connect()`, `answerCall()` |
| `IncomingCallActivity.kt` | `answerDirectly()`, broadcast receiver registration |
| `ActiveCallActivity.kt` | Active call UI, BUG-007 guard |
| `Z360ConnectionService.kt` | Android Telecom framework integration |
| `Z360VoipStore.kt` | Push data persistence, call state |
| `OrgSwitchHelper.kt` | Cross-org credential switch |

**iOS**:
| File | Key Functions |
|---|---|
| `PushKitManager.swift` | `processPushPayload()`, PushKit/CallKit coordination |
| `PushCorrelator.swift` | Two-push correlation by normalized phone |
| `Z360VoIPService.swift` | `answerCall()`, cross-org switch |
| `CallKitManager.swift` | CallKit reporting |
| `TelnyxService.swift` | `answerFromCallKit()`, SDK management |

**Web (React)**:
| File | Key Functions |
|---|---|
| `resources/js/layouts/app-layout.tsx` | `TelnyxRTCProvider` setup |
| `resources/js/components/.../dialpad/context.tsx` | `useNotification()`, `call_ended` listener, answer/hangup |
| `resources/js/plugins/telnyx-voip.ts` | Capacitor VoIP plugin interface |

### 9.4 Telnyx API Calls (Complete)

| Step | API | Parameters | Purpose |
|---|---|---|---|
| Credential create | `POST /v2/telephony_credentials` | `name`, `connection_id` | Per-device SIP credential |
| Leg create (×N) | `POST /v2/calls` | `to`, `from`, `connection_id`, `webhook_url`, `timeout_secs: 30`, `client_state` | Outbound SIP legs |
| Answer parent | `POST /v2/calls/{id}/actions/answer` | `client_state` | Answer parked PSTN call |
| Bridge | `POST /v2/calls/{id}/actions/bridge` | `call_control_id: {leg}` | Connect audio |
| Record | `POST /v2/calls/{id}/actions/record_start` | `format: wav`, `channels: dual` | Start recording |
| Hangup (×N-1) | `POST /v2/calls/{id}/actions/hangup` | — | Dismiss other legs |
| Credential delete | `DELETE /v2/telephony_credentials/{id}` | — | Remove credential (target) |

---

*This whitepaper synthesizes findings from three parallel research tracks: happy-path documentation, failure mode analysis, and alternatives research. All claims are backed by code evidence from the Z360 codebase (via Repomix skills) and official Telnyx documentation.*
