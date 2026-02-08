---
title: Inbound Call Flow Unified
---

# Inbound Call Flow — Unified End-to-End Analysis

![Unified End-to-End Inbound Call Flow](/diagrams/unified-inbound-call-flow.jpeg)

> **Session 09 Synthesis** | Date: 2026-02-08
> **Sources**: Backend trace (36KB), Android trace (60KB), iOS trace (92KB), Web trace (52KB)
> **Scope**: Complete inbound call lifecycle from PSTN caller to call completion across all platforms

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Diagram](#2-system-diagram)
3. [End-to-End Sequence Diagram](#3-end-to-end-sequence-diagram)
4. [Phase-by-Phase Synchronized View](#4-phase-by-phase-synchronized-view)
5. [Cross-Platform Coordination Points](#5-cross-platform-coordination-points)
6. [Platform Divergences](#6-platform-divergences)
7. [Data Flow Diagram](#7-data-flow-diagram)
8. [Outbound Call Flow](#8-outbound-call-flow)
9. [Race Conditions & Timing Issues](#9-race-conditions--timing-issues)
10. [Gap Analysis](#10-gap-analysis)
11. [Target Architecture](#11-target-architecture)
12. [Implementation Checklist](#12-implementation-checklist)

---

## 1. Executive Summary

Z360's inbound call system uses a **backend-orchestrated simultaneous ring** architecture where the Laravel backend is the single controller of call state, with three client platforms (Android, iOS, Web) operating as independent endpoints.

### Who Controls What

| Responsibility | Controller | Mechanism |
|---------------|-----------|-----------|
| **Call routing** | Backend (Laravel) | Telnyx webhook → `transferToUser()` |
| **Simultaneous ring** | Backend | Creates N Telnyx outbound legs to SIP endpoints |
| **Answer coordination** | Backend | Redis distributed lock (`simring:{parent}:lock`) |
| **Ring dismissal** | Backend | SIP BYE + Reverb broadcast + Push notification (3-channel) |
| **Push delivery** | Backend → FCM/APNs | `PushNotificationService` sends to all device tokens |
| **Call recording** | Backend | `Call::record_start()` on parent leg after bridge |
| **Call logging** | Backend | Message/Conversation model updates |
| **Audio/media** | Client (Telnyx SDK) | WebRTC peer connection managed by each platform's SDK |
| **Call UI** | Client (native) | Platform-specific: CallKit (iOS), ConnectionService (Android), React (Web) |
| **Two-push sync** | Client (mobile) | PushSynchronizer (Android) / PushCorrelator (iOS) |
| **Cross-org switch** | Client + Backend | Client calls `/api/voip/switch-org`, reconnects SDK |

### The Core Loop

```
PSTN Call → Telnyx Platform → Webhook to Backend → Backend creates N SIP legs
                                                  → Backend sends push to mobile
                                                  → Backend broadcasts to web
                                                  → Telnyx SIP INVITEs to devices
                                                  → First device to answer wins lock
                                                  → Backend bridges parent ↔ winner
                                                  → Backend hangs up losers
                                                  → Three-channel dismissal
```

---

## 2. System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            PSTN CALLER                                   │
│                          (external phone)                                │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         TELNYX PLATFORM                                  │
│                                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────────┐   │
│  │ SIP Gateway  │  │ Call Control │  │ Push Infrastructure          │   │
│  │ (WebRTC+SIP) │  │ (webhooks)   │  │ (APNs VoIP + FCM)           │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────────┬───────────────┘   │
│         │                │                          │                    │
└─────────┼────────────────┼──────────────────────────┼────────────────────┘
          │                │                          │
          │                ▼                          │
          │   ┌────────────────────────┐              │
          │   │    LARAVEL BACKEND     │              │
          │   │                        │              │
          │   │  Webhook Controller    │              │
          │   │  ├─ call.initiated     │              │
          │   │  ├─ call.answered      │              │
          │   │  └─ call.hangup        │              │
          │   │                        │              │
          │   │  Orchestration:        │              │
          │   │  ├─ transferToUser()   │              │
          │   │  ├─ Redis lock         │              │
          │   │  ├─ Bridge calls       │              │
          │   │  └─ Recording          │              │
          │   │                        │              │
          │   │  Notifications:        │              │
          │   │  ├─ FCM push ──────────┼──► Android   │
          │   │  ├─ APNs VoIP push ────┼──► iOS       │
          │   │  └─ Reverb broadcast ──┼──► Web       │
          │   └────────────────────────┘              │
          │                                           │
          ├───────────────────────────────────────────┤
          │          SIP INVITE to devices            │
          │      (parallel to all SIP endpoints)      │
          │                                           │
    ┌─────┴──────┐   ┌──────┴──────┐   ┌─────┴──────┐
    │  ANDROID   │   │    iOS      │   │    WEB     │
    │            │   │             │   │            │
    │ FCM push   │   │ PushKit     │   │ WebSocket  │
    │ + Telnyx   │   │ + Telnyx    │   │ SIP INVITE │
    │ push       │   │ push        │   │ (direct)   │
    │            │   │             │   │            │
    │ Connection │   │ CallKit UI  │   │ React UI   │
    │ Service    │   │ (native)    │   │ (browser)  │
    │ + Custom   │   │             │   │            │
    │ Activity   │   │             │   │            │
    └────────────┘   └─────────────┘   └────────────┘
```

---

## 3. End-to-End Sequence Diagram

```
T(ms)  PSTN      Telnyx     Backend        Android         iOS             Web
─────  ─────     ──────     ───────        ───────         ───             ───
  0    Call ────► Receive
                  call

 50              ─────────► call.initiated
                             webhook

100                          Parse webhook
                             Resolve user
                             Check schedule

150                          ─── FCM push ──────────────► Z360FirebaseMS
                             ─── APNs VoIP push ──────────────────────► PushKitManager
                             ─── Reverb broadcast ─────────────────────────────────► Echo listener

200                          Query device
                             SIP credentials

250                          Telnyx::Call::create()
                             for each SIP dest
                             ──► SIP INVITE ──────► Telnyx SDK       ──► Telnyx SDK

                             Cache simring:
                             {parent} session

300              SIP INVITE ─────────────────────────────────────────────────────► TelnyxRTC
                 via WebSocket                                                     WebSocket

350                                         PushSynchronizer    PushCorrelator
                                            correlate 2 pushes  correlate 2 pushes
                                            (500ms timeout)     (500ms-1.5s timeout)

400                                         Z360Connection      CallKit.report
                                            Service.add         IncomingCall()
                                            IncomingCall()      ✓ < 5s deadline

450                                         IncomingCall        iOS call UI        Dialer shows
                                            Activity            appears            <IncomingCall/>
                                            launches            (banner/fullscreen)

3000   Hears                                USER TAPS           USER TAPS          USER CLICKS
       ringback                             ANSWER              ANSWER             ANSWER

3050                                        answerCall()        CXAnswerCallAction  activeCall
                                            via TelnyxViewModel ─► Z360VoIPService  .answer()
                                            ─► Telnyx SDK       ─► TelnyxService    ─► SIP 200 OK
                                            SIP 200 OK          SIP 200 OK          via WebSocket

3100             ──────────► call.answered
                             webhook

3150                         Acquire lock
                             simring:{parent}:lock

3200                         Answer parent
                             Telnyx::Call::answer()

3250                         Bridge parent ↔ leg
                             Telnyx::Call::bridge()

3300                         Start recording
                             dual-channel WAV

3350                         Hang up other legs
                             Loop: Call::hangup()

3400                         ─── call_ended push ──► dismiss UI    ──► dismiss CallKit
                             ─── Reverb broadcast ──────────────────────────────────► hangup ringing

3500   Audio ◄──────────────────────────── Media flows ──────────────────────────────►
       bridge                              (WebRTC audio)
       established

...    CALL IN PROGRESS (both parties can speak)

120000 Caller
       hangs up

120050           ──────────► call.hangup
                             webhook

120100                       Find bridged leg
                             Hang up device leg

120150                       ─── call_ended push ──► cleanup       ──► CallKit.reportEnd
                             ─── Reverb broadcast ──────────────────────────────────► UI revert

120200                       Clean cache
                             Log call
```

---

## 4. Phase-by-Phase Synchronized View

### Phase 1: Call Arrives (T=0-100ms)

| Layer | Action | File Reference |
|-------|--------|---------------|
| **Telnyx** | Receives PSTN call on Z360 number | — |
| **Backend** | Receives `call.initiated` webhook at `POST /webhooks/cpaas/telnyx/call-control` | `routes/webhooks.php:40` |
| **Backend** | Parses via `TelnyxCallInitiatedData::fromRequest()` | `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php` |
| **Backend** | Resolves `AuthenticatedPhoneNumber` → org → receiving user | `TelnyxInboundWebhookController.php:80-81` |
| **Backend** | Checks blocked caller, business hours schedule | `TelnyxInboundWebhookController.php:51-78` |
| **PSTN caller** | Hears carrier ringback tone | — |

### Phase 2: Notification Dispatch (T=100-300ms)

| Layer | Action | File Reference |
|-------|--------|---------------|
| **Backend** | Sends FCM data push to Android devices (high priority, 60s TTL) | `PushNotificationService.php:20-157` |
| **Backend** | Sends APNs VoIP push to iOS devices | `ApnsVoipService::sendVoipPush()` |
| **Backend** | Broadcasts `IncomingCallNotification` to Reverb | `IncomingCallNotification.php` |
| **Backend** | Queries per-device SIP credentials from `user_device_tokens` | `TelnyxInboundWebhookController.php:267-278` |
| **Backend** | Creates outbound SIP legs via `Telnyx\Call::create()` for each device | `TelnyxInboundWebhookController.php:311-333` |
| **Backend** | Stores `simring:{parent}` cache with `answered:false`, empty `leg_ids` | `TelnyxInboundWebhookController.php:377-383` |
| **Telnyx** | Sends SIP INVITE to each device via respective SDK connections | — |
| **Telnyx** | Sends Telnyx push (call control metadata) to mobile via APNs/FCM | — |
| **Android** | `Z360FirebaseMessagingService.onMessageReceived()` | `Z360FirebaseMessagingService.kt:688-756` |
| **iOS** | `PushKitManager.pushRegistry(_:didReceiveIncomingPushWith:)` | `PushKitManager.swift:1821+` |
| **Web** | TelnyxRTC WebSocket receives SIP INVITE directly | `@telnyx/react-client` → `useNotification()` |
| **Web** | (Note: Does NOT use Reverb `.incoming_call` broadcast) | — |

### Phase 3: Two-Push Synchronization (T=300-800ms, mobile only)

| Layer | Action | Timeout | File Reference |
|-------|--------|---------|---------------|
| **Android** | `PushSynchronizer.onZ360PushReceived()` or `onTelnyxPushReceived()` | 500ms | `PushSynchronizer.kt:33-230` |
| **Android** | Normalizes phone to last 10 digits for correlation | — | `PushSynchronizer.kt:386-393` |
| **Android** | If Telnyx first: creates `CompletableDeferred`, waits 500ms for Z360 | 500ms | `PushSynchronizer.kt:365-379` |
| **iOS** | `PushCorrelator.processZ360Push()` or `processTelnyxPush()` | 500ms-1.5s | `PushCorrelator.swift:2541-2660` |
| **iOS** | Uses Swift Actor for thread safety | — | `PushCorrelator.swift:2386-2479` |
| **iOS** | CRITICAL: Must report to CallKit within 5s of PushKit delivery | **5s hard deadline** | `PushKitManager.swift:934-935` |
| **Web** | No two-push sync needed (receives SIP INVITE directly via WebSocket) | — | — |

### Phase 4: Call UI Display (T=400-500ms)

| Layer | Action | File Reference |
|-------|--------|---------------|
| **Android** | `Z360ConnectionService.addIncomingCall()` → Telecom framework | `Z360ConnectionService.kt:8873-8979` |
| **Android** | `Z360Connection.onShowIncomingCallUi()` → notification + `IncomingCallActivity` | `Z360Connection.kt:8655-8769` |
| **Android** | Displays caller name, number, avatar, org name | `IncomingCallActivity.kt:4378-4574` |
| **Android** | Lock screen: `showWhenLocked`, `turnScreenOn` flags | AndroidManifest flags |
| **iOS** | `CallKitManager.reportIncomingCall()` → `CXProvider.reportNewIncomingCall()` | `CallKitManager.swift:559-594` |
| **iOS** | Native iOS call UI: banner (unlocked) or full-screen (locked) | iOS system |
| **iOS** | Displays `localizedCallerName` + phone handle | `CXCallUpdate` properties |
| **Web** | `useNotification()` → `activeCall.state = 'ringing'` → `<IncomingCall />` component | `context.tsx:205-206`, `dialer.tsx:228-274` |
| **Web** | Lazy-loads caller identity via Inertia partial reload | `context.tsx:265-276` |

### Phase 5: Device Answers (T=3000ms+)

| Layer | Action | File Reference |
|-------|--------|---------------|
| **Android** | `IncomingCallActivity.answerDirectly()` → `telnyxViewModel.answerCall()` → SIP 200 OK | `IncomingCallActivity.kt:4864-4979` |
| **Android** | Multi-path answer: SDK `currentCall` → pending from plugin → wait 5s for INVITE → push fallback | `IncomingCallActivity.kt:4700-4748` |
| **Android** | Double-tap prevention via `AtomicBoolean` | `IncomingCallActivity.kt:4840-4843` |
| **iOS** | `CXAnswerCallAction` → `CallKitManager` → `Z360VoIPService.answerCall()` | `Z360VoIPService.swift:4484-4604` |
| **iOS** | SDK readiness check + 5s reconnection attempt | `Z360VoIPService.swift:4500-4514` |
| **iOS** | Wait for push call ready (5s timeout) | `Z360VoIPService.swift:4525-4531` |
| **iOS** | `TelnyxService.answerFromCallKit(answerAction:)` → SDK SIP 200 OK | `TelnyxService.swift:3196-3220` |
| **iOS** | Double-tap prevention via `ActionGuard` | `Z360VoIPService.swift:4487-4490` |
| **Web** | `activeCall.answer()` → SIP 200 OK via WebSocket | `context.tsx:530-547` |
| **Backend** | Receives `call.answered` webhook | `TelnyxInboundWebhookController.php:452-596` |
| **Backend** | Acquires `simring:{parent}:lock` (10s timeout) | `TelnyxInboundWebhookController.php:479-489` |
| **Backend** | Sets `ringSession.answered = true`, records `answered_leg` | `TelnyxInboundWebhookController.php:492-498` |
| **Backend** | Answers parent: `Telnyx\Call::answer()` | `TelnyxInboundWebhookController.php:502-517` |
| **Backend** | Bridges parent ↔ answered leg: `Telnyx\Call::bridge()` | `TelnyxInboundWebhookController.php:519-525` |
| **Backend** | Starts dual-channel WAV recording on parent | `TelnyxInboundWebhookController.php:532-544` |

### Phase 6: Ring Dismissal (T=3200ms+)

Three-channel dismissal for non-answering devices:

| Channel | Target | Action | File Reference |
|---------|--------|--------|---------------|
| **SIP BYE** | All SIP endpoints | `Call::hangup()` for each non-answered leg | `TelnyxInboundWebhookController.php:546-556` |
| **Reverb broadcast** | Web sessions | `CallEndedNotification` with `reason: 'answered_elsewhere'` | `CallEndedNotification.php` |
| **Push notification** | Mobile devices | `PushNotificationService::sendCallEndedPush()` | `PushNotificationService.php` |

**Client handling**:
- **Android**: `ACTION_CALL_ENDED` broadcast → `IncomingCallActivity` finishes | `Z360FirebaseMessagingService.kt:59-71`
- **iOS**: `call_ended` push → find existing CallKit UUID → `reportCallEnded(.answeredElsewhere)` | `PushKitManager.swift:1041-1067`
- **iOS**: If no matching call → **must still report fake call** (PushKit contract) then immediately end it | `PushKitManager.swift:1696-1714`
- **Web**: `.call_ended` Echo listener → `activeCall.hangup()` if state is `ringing` | `context.tsx:208-227`

### Phase 7: Call In Progress (T=3500ms+)

| Layer | Active During Call | File Reference |
|-------|-------------------|---------------|
| **Backend** | Webhooks: `call.bridged`, `call.recording.saved` | `TelnyxCallController.php` |
| **Android** | `ActiveCallActivity` with mute/hold/speaker/DTMF controls | `ActiveCallActivity.kt:1240-1402` |
| **Android** | `CallTimerManager` singleton (survives config changes) | `CallTimerManager.kt:12-52` |
| **Android** | `BluetoothAudioManager`, proximity sensor, audio diagnostics | `ActiveCallActivity.kt:905-916` |
| **iOS** | CallKit in-call UI (green bar, timer, mute/hold/speaker) | iOS system |
| **iOS** | `CallTimerManager` (1s tick), `CallQualityMonitor` (5s MOS/jitter) | `Z360VoIPService.swift:5692-5750` |
| **iOS** | `NetworkMonitor` (WiFi↔Cellular handoff, 30s timeout) | `NetworkMonitor.swift:7142-7560` |
| **Web** | `<OnCall />` with mute, mic/speaker dropdowns, DTMF dialpad | `dialer.tsx:96-226` |
| **Web** | `useCountdown()` elapsed time display | `useCountdown.ts:1-47` |

### Phase 8: Call Ends (T=120000ms+)

**PSTN caller hangs up**:

| Layer | Action | File Reference |
|-------|--------|---------------|
| **Backend** | `call.hangup` webhook with `client_state.type: "simultaneous_ring_parent"` | `TelnyxInboundWebhookController.php:603-666` |
| **Backend** | Hangs up bridged device leg | `TelnyxInboundWebhookController.php:620-638` |
| **Backend** | Cleans up `simring:{parent}` cache | `TelnyxInboundWebhookController.php:642-644` |
| **Backend** | Sends `call_completed` push + Reverb broadcast | `TelnyxInboundWebhookController.php:647-664` |
| **Android** | `TelnyxSocketEvent.OnCallEnded` → cleanup + `finish()` | `ActiveCallActivity.kt:1203-1214` |
| **Android** | `Z360Connection.notifyDisconnected()`, timer stop, audio reset | `ActiveCallActivity.kt:2183-2205` |
| **iOS** | `onRemoteCallEnded()` → `remoteCallEnded()` → `CallKit.reportCallEnded(.remoteEnded)` | `Z360VoIPService.swift:5821-5886` |
| **iOS** | Deduplication: `callEndProcessedForUUID` prevents double cleanup | `Z360VoIPService.swift:5832-5848` |
| **Web** | `activeCall.state → 'destroy'` → `call = null` → UI reverts to `<DialPad />` | `context.tsx:205-206` |

**Device user hangs up**:

| Layer | Action | File Reference |
|-------|--------|---------------|
| **Android** | `endCall()` → `telnyxViewModel.endCall()` → SIP BYE + 5s timeout fallback | `ActiveCallActivity.kt:2207-2242` |
| **iOS** | `CXEndCallAction` → `endCall()` → `TelnyxService.endCallFromCallKit()` → SIP BYE | `Z360VoIPService.swift:4787-4849` |
| **Web** | `activeCall.hangup()` → SIP BYE via WebSocket | `context.tsx:511-528` |
| **Backend** | `call.hangup` webhook with `client_state.type: "simultaneous_ring_leg"` + `answered: true` | `TelnyxInboundWebhookController.php:694-743` |
| **Backend** | Hangs up parent call, cleans cache, notifies user | `TelnyxInboundWebhookController.php:756-769` |

---

## 5. Cross-Platform Coordination Points

### 5.1 Push Payload Contract

All three platforms must handle the same push payload. Any change breaks mobile:

```json
{
  "type": "incoming_call",
  "call_session_id": "UUID",
  "call_control_id": "v3:xxx",
  "caller_number": "+15551234567",
  "caller_name": "John Doe",
  "channel_number": "+15559876543",
  "caller_avatar": "https://...",
  "call_id": "UUID",
  "organization_id": "123",
  "organization_name": "Acme Inc",
  "organization_slug": "acme",
  "timestamp": "1738972800"
}
```

**Android**: Parses in `handleZ360CallerInfoPush()` using string keys
**iOS**: Parses in `PushKitManager.processPushPayload()` from APNs dictionary
**Web**: Does NOT receive this push — gets SIP INVITE directly via WebSocket

### 5.2 call_ended Dismissal Contract

Three-channel dismissal must be consistent:

| Channel | Payload | Receiver |
|---------|---------|----------|
| SIP BYE | Telnyx hangs up leg | All SDK instances |
| Push `call_ended` | `{ type: "call_ended", call_session_id }` | Android FCM + iOS APNs |
| Reverb `.call_ended` | `{ call_session_id, reason }` | Web Echo listener |

### 5.3 Cross-Org Switch API

Both mobile platforms call the same endpoint:

- **Endpoint**: `POST /api/voip/switch-org`
- **Auth**: WebView cookies (`CookieManager` on Android, `WKWebsiteDataStore` on iOS)
- **Body**: `{ target_organization_id: "..." }`
- **Response**: `{ sip_username, sip_password, caller_id_name, caller_id_number, ... }`

**Android timeout**: 10s connect + 10s read
**iOS timeout**: 4.0s (hard limit, must leave 1s for SDK reconnect within 5s CallKit deadline)

### 5.4 SIP Credential Scope

```
Per-Org Level:
  └─ user.telnyxCredential.sip_username → Used for web JWT auth ONLY (never dialed)

Per-Device Level:
  └─ user_device_tokens.sip_username → Dialed during simultaneous ring
     ├─ Android device 1
     ├─ Android device 2
     ├─ iOS device 1
     └─ Web browser tab 1
```

**Critical rule**: Backend MUST only dial per-device SIP credentials. Dialing the org-level credential creates a phantom leg that auto-answers and steals the bridge.

---

## 6. Platform Divergences

### 6.1 How Incoming Calls Are Detected

| Platform | Primary Signal | Secondary Signal | Fallback |
|----------|---------------|-----------------|----------|
| **Android** | FCM data push (Z360) + FCM data push (Telnyx) | SIP INVITE via SDK | If only one push: 500ms timeout, proceed with partial data |
| **iOS** | APNs VoIP push (Z360) + APNs VoIP push (Telnyx) | SIP INVITE via SDK | If only one push: 500ms-1.5s timeout, proceed with partial data |
| **Web** | SIP INVITE via WebSocket (direct from Telnyx) | — | None. If WebSocket disconnected, call is missed |

**Key insight**: Web does NOT use the Reverb `IncomingCallNotification` broadcast for incoming call detection. The backend broadcasts it, but no web listener exists for `.incoming_call`.

### 6.2 Answer Mechanism

| Platform | UI Action | SDK Call | Fallback |
|----------|-----------|---------|----------|
| **Android** | Tap answer button | `telnyxViewModel.answerCall(callId)` | Wait 5s for INVITE → `answerIncomingPushCall(txPushMetaData)` |
| **iOS** | CallKit answer button | `txClient.answerFromCallkit(answerAction:)` | Wait 5s for client ready → proceed anyway |
| **Web** | Click answer button | `activeCall.answer()` | None |

### 6.3 Call UI Framework

| Platform | Framework | Lock Screen | Bluetooth | Multi-call |
|----------|-----------|-------------|-----------|------------|
| **Android** | Custom `IncomingCallActivity` + `ActiveCallActivity` + Self-managed `ConnectionService` | Yes (`showWhenLocked`, `turnScreenOn`) | `BluetoothAudioManager` SCO routing | Auto-reject (US-018) |
| **iOS** | Native CallKit UI (banner/full-screen) | Yes (native) | CallKit handles automatically | Report + auto-reject (US-025) |
| **Web** | React components in sidebar dialpad | N/A | N/A | N/A (single-tab limitation) |

### 6.4 Audio Session Management

| Platform | Initialization | During Call | Cleanup |
|----------|---------------|-------------|---------|
| **Android** | `AudioManager.MODE_IN_COMMUNICATION` immediately in `ActiveCallActivity.onCreate()` | Speaker/earpiece via `AudioManager.isSpeakerphoneOn` | `AudioDiagnostics.resetAfterCall()` |
| **iOS** | **Only in `didActivate` callback** (CallKit mandate) → `TelnyxService.enableAudioSession()` | Speaker via `overrideOutputAudioPort(.speaker)` | Auto via `didDeactivate` callback |
| **Web** | Browser handles via `getUserMedia()` + WebRTC | Mic/speaker selection via `setSinkId()` + `setAudioInDevice()` | Automatic on stream close |

### 6.5 Crash Recovery

| Platform | Mechanism | Recovery Action |
|----------|-----------|----------------|
| **Android** | `CallStatePersistence` saves to SharedPreferences | `CrashRecoveryManager` detects orphan on next launch |
| **iOS** | `PersistableCallState` saved to UserDefaults | `recoverOrphanCallState()` reports ended to CallKit |
| **Web** | None (tab close = call end) | Browser handles WebRTC cleanup |

---

## 7. Data Flow Diagram

### 7.1 Tokens & Credentials Flow

```
┌───────────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL LIFECYCLE                                │
│                                                                       │
│  1. User logs in → Backend creates org-level TelnyxCredential         │
│     └─ sip_username, sip_password for web JWT auth only               │
│                                                                       │
│  2. Device registers → Backend creates UserDeviceToken                │
│     ├─ Android: FCM token + sip_username via CPaaSService             │
│     ├─ iOS: APNs VoIP token + sip_username via CPaaSService           │
│     └─ Web: browser_device_id + sip_username → JWT token              │
│                                                                       │
│  3. Per-device SIP creds used for simultaneous ring:                  │
│     └─ Backend: "sip:{device_sip_user}@sip.telnyx.com"               │
│                                                                       │
│  4. Activity filter: last_active_at >= now() - 1 day                  │
│     └─ Only recently active devices get SIP legs                      │
│                                                                       │
│  5. Web JWT lifecycle:                                                │
│     ├─ Per-device: POST /api/device-tokens → JWT (no explicit TTL)    │
│     └─ Fallback: Inertia prop with 30-min session cache + auto-refresh│
└───────────────────────────────────────────────────────────────────────┘
```

### 7.2 Call State Machine

```
                          ┌──────────┐
                          │  IDLE    │
                          └────┬─────┘
                               │
                    call.initiated webhook
                               │
                          ┌────▼─────┐
                          │ RINGING  │ ← Parent parked, legs created
                          │          │   Caller hears ringback
                          └────┬─────┘
                               │
                    ┌──────────┼──────────┐
                    │          │          │
              No answer    Device     All legs
              (30s)        answers    fail
                    │          │          │
              ┌─────▼────┐ ┌──▼──────┐ ┌─▼──────────┐
              │VOICEMAIL │ │ANSWERED │ │VOICEMAIL   │
              │          │ │Lock +   │ │(retry once)│
              └──────────┘ │Bridge   │ └────────────┘
                           └────┬────┘
                                │
                           Bridge success
                                │
                          ┌─────▼────┐
                          │ BRIDGED  │ ← Audio flows, recording active
                          │          │   Other legs hung up
                          └────┬─────┘
                               │
                    ┌──────────┼──────────┐
                    │                     │
              Caller hangs up       Device hangs up
                    │                     │
              ┌─────▼────┐          ┌─────▼────┐
              │ ENDED    │          │ ENDED    │
              │(parent   │          │(leg      │
              │ hangup)  │          │ hangup)  │
              └────┬─────┘          └────┬─────┘
                   │                     │
                   ├── Hang up bridged leg   ├── Hang up parent
                   ├── Clean cache           ├── Clean cache
                   ├── Push call_ended       ├── Push call_ended
                   └── Reverb broadcast      └── Reverb broadcast
```

### 7.3 Cache Key Structure

```
Redis Cache Keys:

  simring:{parent_call_control_id}
  ├── parent_call_control_id: "v3:xxx"
  ├── user_id: 123
  ├── message_id: 456
  ├── answered: false → true
  ├── leg_ids: ["v3:leg-1", "v3:leg-2", "v3:leg-3"]
  └── answered_leg: null → "v3:leg-2"
  TTL: 10 minutes

  simring:{parent_call_control_id}:lock
  └── Laravel atomic lock
  TTL: 10 seconds
```

---

## 8. Outbound Call Flow

### 8.1 Web Outbound

```
User clicks call → placeCall() → client.newCall({
    destinationNumber, callerNumber,
    clientState: btoa(JSON.stringify({ user_id })),
    micId, speakerId, remoteElement
})
→ TelnyxRTC sends SIP INVITE via WebSocket
→ Telnyx routes to PSTN
→ Webhook: call.initiated → TelnyxOutboundWebhookController (logging only)
→ State: requesting → ringing → active
```

**File**: `context.tsx:412-508`

### 8.2 Android Outbound (via Capacitor Bridge)

```
Web dialer → TelnyxVoip.makeCall({ destinationNumber, callerIdNumber, ... })
→ TelnyxVoipPlugin.makeCall() (Capacitor plugin)
→ telnyxViewModel.makeCall(destinationNumber, callerIdName, callerIdNumber, codecs)
→ Telnyx SDK sends SIP INVITE
→ ActiveCallActivity.start(isOutgoing=true, callConnected=false)
→ 30s setup timeout (canceled on OnRinging)
→ State: CALLING → OnRinging → OnCallAnswered
```

**File**: `TelnyxVoipPlugin.kt:6046-6130`

### 8.3 iOS Outbound (via Capacitor Bridge)

```
Web dialer → TelnyxVoip.makeCall(...)
→ TelnyxVoipPlugin → Z360VoIPService
→ TelnyxService.makeCall() → txClient SIP INVITE
→ CallKit: reportOutgoingCall (CXStartCallAction)
→ State progression tracked by callStateDidChange()
```

### 8.4 Backend Role in Outbound

Backend is **passive** for outbound calls:
- Receives `call.initiated` webhook with `client_state.user_id`
- Logs call in Message/Conversation models
- Does NOT orchestrate routing (Telnyx handles PSTN routing directly)

---

## 9. Race Conditions & Timing Issues

### 9.1 Simultaneous Answer Race (MITIGATED)

**Scenario**: Two devices answer within milliseconds
**Mitigation**: Redis distributed lock `simring:{parent}:lock` (10s TTL)
**Code**: `TelnyxInboundWebhookController.php:479-489`
**Residual risk**: If Redis is unavailable, lock acquisition fails → all devices get hung up → no one bridges → call goes to voicemail

### 9.2 Two-Push Ordering Race (MITIGATED)

**Scenario**: Z360 push and Telnyx push arrive in either order
**Android**: `PushSynchronizer` with `CompletableDeferred` + 500ms timeout
**iOS**: `PushCorrelator` (Swift Actor) with `withCheckedContinuation` + 500ms-1.5s timeout
**Residual risk**: If Z360 push never arrives, caller info is limited to Telnyx metadata (no avatar, no org name)

### 9.3 iOS 5-Second PushKit Deadline (CRITICAL)

**Scenario**: VoIP push must result in CallKit report within 5 seconds or iOS kills app
**Mitigation**: Two-phase startup (minimal init in `didFinishLaunchingWithOptions`), report to CallKit before any heavy work
**Residual risk**: Cross-org switch during answer adds latency (API call + SDK reconnect). Total can exceed 5s. OrganizationSwitcher has 4.5s safety margin but SDK reconnect adds 3s worst case.

### 9.4 Bridge Failure After Answer (NOT MITIGATED)

**Scenario**: `Call::bridge()` fails after parent is answered and other legs are hung up
**Impact**: Parent and answered leg are active but not bridged. Both parties hear silence. No automatic recovery.
**Code**: `TelnyxInboundWebhookController.php:578-583` (logs error only)
**Recommendation**: Add fallback: hang up both legs + voicemail

### 9.5 Webhook Loss (NOT MITIGATED)

**Scenario**: Telnyx `call.answered` webhook is lost (network issue)
**Impact**: Backend never bridges call. Devices ring for 30s then timeout. Caller hears ringback, then silence.
**Recommendation**: Implement heartbeat polling for calls older than 60s

### 9.6 WebSocket Disconnect on Web (NOT MITIGATED)

**Scenario**: Browser WebSocket to Telnyx drops (network, sleep, throttling)
**Impact**: Web client misses incoming call entirely. No fallback path (Reverb `.incoming_call` not listened for).
**Recommendation**: Add Reverb `.incoming_call` listener as secondary signal

### 9.7 Cross-Org SDK Reconnection Timing (PARTIALLY MITIGATED)

**Scenario**: Cross-org call requires credential switch + SDK reconnect on answer
**Android**: 10s timeout for API + unbounded SDK reconnect
**iOS**: 4.5s max for entire operation (API + credential store + disconnect + reconnect)
**Risk**: If SDK reconnect takes >3s on iOS, total exceeds 5s CallKit deadline → `action.fail()`
**Mitigation**: Rollback to original org on failure

### 9.8 Stale Re-INVITE After Hangup (MITIGATED)

**Scenario**: Telnyx sends re-INVITE after user already hung up
**Android**: `Z360VoipStore.wasRecentlyEnded()` with 15s cooldown
**iOS**: Deduplication via `callUUIDByPhone` and `callUUIDByTelnyxId` indexes
**Web**: SDK handles internally

### 9.9 Multi-Tab Web Ringing (NOT MITIGATED)

**Scenario**: User has multiple browser tabs open, all ring simultaneously
**Impact**: Brief UI flicker in multiple tabs before `call_ended` dismisses non-answering tabs
**Recommendation**: Single-tab coordinator via `localStorage` + `storage` event

---

## 10. Gap Analysis

### 10.1 Critical Gaps

| # | Gap | Impact | Platform | Recommendation |
|---|-----|--------|----------|----------------|
| G-1 | **No bridge failure recovery** | Caller + device hear silence after answer | Backend | Add fallback: hang up both + voicemail transfer |
| G-2 | **No webhook loss detection** | Stuck calls, phantom ringing | Backend | Periodic Telnyx API polling for calls >60s |
| G-3 | **Web has no incoming call fallback** | Missed calls if WebSocket drops | Web | Add Reverb `.incoming_call` listener |
| G-4 | **Cross-org exceeds iOS deadline** | Failed answer on cross-org calls | iOS | Pre-fetch credentials during ring phase (before user answers) |

### 10.2 Moderate Gaps

| # | Gap | Impact | Platform | Recommendation |
|---|-----|--------|----------|----------------|
| G-5 | **Outbound `<IncomingCall />` text bug** | "Incoming" shown for outbound ringing | Web | Check `activeCall.direction` in component |
| G-6 | **Multi-tab simultaneous ring** | Brief duplicate UI in multiple tabs | Web | Single-tab coordinator |
| G-7 | **No web push for incoming calls** | Backgrounded tabs miss calls | Web | Service Worker + Web Push API |
| G-8 | **Per-device JWT no auto-refresh** | Stale credentials after long session | Web | Add TTL + refresh mechanism |
| G-9 | **Org-level credential accidentally dialed** | Phantom leg steals bridge | Backend | Add assertion/guard in `transferToUser()` |
| G-10 | **Redis unavailable during answer** | All devices get hung up, no bridge | Backend | Implement in-memory fallback or idempotent retry |

### 10.3 Low-Priority Gaps

| # | Gap | Impact | Platform | Recommendation |
|---|-----|--------|----------|----------------|
| G-11 | **Cache TTL 10min after call ends** | Wasted memory | Backend | Already cleaned on hangup, TTL is safety net |
| G-12 | **Idempotency uses message_id** | Weak idempotency before message creation | Backend | Use `call_session_id` as idempotency key |
| G-13 | **Push failure no retry** | Mobile doesn't ring if push fails | Backend | Acceptable — SIP ring provides fallback |
| G-14 | **`'undefined'` token fallback** | Socket error instead of clear message | Web | Validate token before provider mount |

### 10.4 Platform-Specific Issues Found

**Android**:
- `OrgSwitchHelper` uses hardcoded base URL for API (`https://app.z360.cloud`)
- Cross-org SDK reconnect has no explicit timeout (waits 5s via `ensureTelnyxSdkConnected`)

**iOS**:
- PushKit "fake call" hack for `call_ended` push (Apple contract requirement)
- `performCrossOrgSwitch` can theoretically exceed 5s (4s API + 3s reconnect = 7s)
- Audio activation race: `didActivate` can fire before SDK is ready (mitigated by `pendingAudioSession` pattern)

**Web**:
- `IncomingCallNotification` broadcast is sent but never consumed by web client
- Audio `setSinkId()` not universally supported (Firefox needs flag)
- `REMOTE_AUDIO_ELEMENT_ID` is a single global DOM element

---

## 11. Target Architecture

### 11.1 Immediate Fixes (Sprint 1)

1. **G-1: Bridge failure recovery**
   - In `onCallAnswered()`, wrap `bridge()` in try-catch
   - On failure: hang up parent + answered leg, transfer to voicemail
   - File: `TelnyxInboundWebhookController.php:519-525`

2. **G-5: Outbound "Incoming" text bug**
   - Add direction check in `<IncomingCall />`: if outbound, show "Calling..." instead
   - File: `dialer.tsx:262`

3. **G-9: Org-level credential guard**
   - Add explicit filter in SIP destination query: `WHERE sip_username != user.telnyxCredential.sip_username`
   - File: `TelnyxInboundWebhookController.php:267-278`

### 11.2 Short-Term Improvements (Sprint 2-3)

4. **G-3: Web incoming call Reverb fallback**
   - Add `useEcho()` listener for `.incoming_call` in DialpadContext
   - If WebSocket disconnected, show notification from Reverb data
   - Fall back to backend-provided caller info
   - Files: `context.tsx`, `app-layout.tsx`

5. **G-4: Pre-fetch cross-org credentials**
   - During ring phase (not answer phase), detect cross-org and start API call
   - Store prefetched credentials in memory
   - On answer: use cached credentials instead of blocking API call
   - Files: `Z360VoIPService.swift`, `IncomingCallActivity.kt`

6. **G-8: Per-device JWT refresh**
   - Add 12-hour TTL to per-device JWT
   - Implement refresh loop in `useWebVoipCredentials`
   - File: `useWebVoipCredentials.ts`

### 11.3 Medium-Term Architecture (Sprint 4-6)

7. **G-2: Webhook loss detection**
   - Background job: poll Telnyx API for calls with `simring:*` cache entries older than 60s
   - If call state != bridged, clean up and transfer to voicemail
   - New file: `app/Jobs/StalledCallCleanupJob.php`

8. **G-6: Multi-tab coordinator**
   - Implement `localStorage`-based tab election (one "master" tab handles calls)
   - Other tabs show "Call handled in another tab" message
   - Files: `useWebVoipCredentials.ts`, `context.tsx`

9. **G-7: Web push for incoming calls**
   - Register Service Worker for Web Push
   - Backend sends Web Push alongside Reverb broadcast
   - Service Worker shows notification even when tab is backgrounded
   - New files: `resources/js/service-worker.js`, backend Web Push integration

### 11.4 Strict State Machine Rules

```
RULE 1: Backend is the source of truth for call state
  - Only backend decides bridging, recording, and cleanup
  - Clients report actions (answer/hangup) via SIP, backend reacts via webhook

RULE 2: Every call must resolve to exactly one of:
  - BRIDGED (one device answered)
  - VOICEMAIL (no device answered, timeout/busy/failure)
  - CALLER_CANCELLED (caller hung up during ring)
  - ERROR (bridge failure → treat as VOICEMAIL)

RULE 3: Idempotency for all webhook handlers
  - Use call_session_id as idempotency key
  - Tolerate duplicate call.answered webhooks
  - Tolerate duplicate call.hangup webhooks

RULE 4: Three-channel dismissal is mandatory
  - SIP BYE + Push + Reverb for every state transition
  - Never rely on a single channel

RULE 5: iOS 5-second deadline is inviolable
  - All iOS push processing must report to CallKit within 5s
  - Cross-org and SDK reconnection happen AFTER CallKit report
  - Anything that blocks must have a strict timeout <4s

RULE 6: Per-device credentials only
  - Never dial org-level SIP credentials
  - Only dial from user_device_tokens.sip_username
  - Enforce with database query + assertion
```

---

## 12. Implementation Checklist

### Priority 1: Critical (Must Fix)

- [ ] **G-1**: Add bridge failure recovery in `onCallAnswered()` → voicemail fallback
- [ ] **G-4**: Pre-fetch cross-org credentials during ring phase on iOS
- [ ] **G-9**: Add guard to prevent org-level credential from being dialed

### Priority 2: Important (Should Fix)

- [ ] **G-3**: Add Reverb `.incoming_call` listener as web fallback
- [ ] **G-5**: Fix outbound call "Incoming" text in web UI
- [ ] **G-8**: Add per-device JWT TTL + refresh on web
- [ ] **G-2**: Implement stalled call cleanup job (60s threshold)
- [ ] **G-10**: Add in-memory lock fallback for Redis unavailability

### Priority 3: Nice to Have

- [ ] **G-6**: Multi-tab coordinator for web
- [ ] **G-7**: Web Push API for backgrounded tabs
- [ ] **G-12**: Use `call_session_id` for idempotency instead of `message_id`
- [ ] **G-14**: Validate JWT token before mounting `TelnyxRTCProvider`

### Testing Plan

For each fix:
1. **Unit test**: Verify the specific code change
2. **Integration test**: Verify end-to-end flow with the fix
3. **Failure injection**: Verify the fix handles the failure mode correctly
4. **Multi-device test**: Verify simultaneous ring with 2+ devices after fix

**Critical test scenarios**:
- [ ] Bridge failure → voicemail fallback
- [ ] Cross-org call on iOS with slow network (>3s API response)
- [ ] Webhook loss simulation (block `call.answered` webhook)
- [ ] Web WebSocket disconnect during incoming call
- [ ] Redis unavailable during simultaneous answer
- [ ] Two devices answer within 50ms
- [ ] Call arrives while app is killed (cold start on both platforms)
- [ ] `call_ended` push arrives before call was reported to CallKit

---

## Files Referenced (Complete Index)

### Backend
| File | Purpose |
|------|---------|
| `routes/webhooks.php:40-42` | Webhook routes |
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` (1,060 lines) | Main inbound controller |
| `app/Http/Controllers/Telnyx/TelnyxCallController.php` (375 lines) | Abstract base controller |
| `app/Services/PushNotificationService.php` (321 lines) | FCM + APNs push |
| `app/Services/CPaaSService.php` | Telnyx API wrapper |
| `app/Events/IncomingCallNotification.php` (57 lines) | Reverb broadcast event |
| `app/Events/CallEndedNotification.php` (~50 lines) | Reverb dismissal event |
| `app/Models/UserDeviceToken.php` (166 lines) | Device token model |
| `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php` | Webhook data object |

### Android
| File | Purpose |
|------|---------|
| `android/.../fcm/Z360FirebaseMessagingService.kt` (1,192 lines) | FCM push handler |
| `android/.../fcm/PushSynchronizer.kt` (299 lines) | Two-push correlation |
| `android/.../voip/Z360ConnectionService.kt` (162 lines) | Telecom framework |
| `android/.../voip/Z360Connection.kt` (212 lines) | Connection object |
| `android/.../voip/IncomingCallActivity.kt` (925 lines) | Incoming call UI |
| `android/.../voip/ActiveCallActivity.kt` (1,387 lines) | Active call UI |
| `android/.../voip/TelnyxVoipPlugin.kt` (789 lines) | Capacitor bridge |
| `android/.../voip/Z360VoipStore.kt` (324 lines) | VoIP state store |
| `android/.../voip/CallTimerManager.kt` (163 lines) | Call duration timer |

### iOS
| File | Purpose |
|------|---------|
| `ios/App/App/VoIP/Managers/PushKitManager.swift` (948 lines) | PushKit handler |
| `ios/App/App/VoIP/Managers/CallKitManager.swift` (455 lines) | CallKit integration |
| `ios/App/App/VoIP/Managers/AudioManager.swift` (448 lines) | Audio routing |
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` (2,253 lines) | Central orchestrator |
| `ios/App/App/VoIP/Services/TelnyxService.swift` (667 lines) | SDK wrapper |
| `ios/App/App/VoIP/Services/PushCorrelator.swift` (610 lines) | Two-push sync |
| `ios/App/App/VoIP/Services/VoipStore.swift` (342 lines) | State persistence |
| `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` (480 lines) | Cross-org switch |
| `ios/App/App/AppDelegate.swift` | Two-phase startup |

### Web
| File | Purpose |
|------|---------|
| `resources/js/layouts/app-layout.tsx` (308 lines) | Provider switching |
| `resources/js/providers/native-voip-provider.tsx` (39 lines) | Native isolation |
| `resources/js/hooks/useWebVoipCredentials.ts` (170 lines) | Browser credentials |
| `resources/js/components/.../dialpad/context.tsx` (646 lines) | Core VoIP logic |
| `resources/js/components/.../dialpad/components/dialer.tsx` (274 lines) | UI components |
| `resources/js/hooks/useCountdown.ts` (47 lines) | Elapsed timer |

---

**End of Unified Inbound Call Flow Analysis**

*Total codebase analyzed: ~10,500+ lines across 4 platforms*
*Total gaps identified: 14 (4 critical, 6 moderate, 4 low)*
*Total files referenced: 27 core files*
