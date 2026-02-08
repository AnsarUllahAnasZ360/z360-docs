---
title: Android Architecture Complete
---

# Android Architecture Complete — Z360 VoIP

> Unified document combining current state analysis, target architecture design, and gap analysis for Z360's Android VoIP system. This is the definitive reference for the Android VoIP implementation roadmap.

---

## Executive Summary

Z360's Android VoIP layer is a **Capacitor 8 hybrid architecture** with 23 Kotlin files (~8,000+ lines) implementing native call handling independent of the WebView. The system uses a **server-mediated dual-push** architecture (Z360 push for caller info + Telnyx push for call control), a **self-managed ConnectionService** for Android Telecom integration, and a **shared TelnyxViewModel** singleton across the Capacitor plugin and native Activities.

**Current state**: Functionally capable but fragile. Core inbound/outbound calling works. Cross-org calls work. Audio routing, Bluetooth, crash recovery, and observability stacks exist. However, the code has significant gaps in reliability, platform compliance, and maintainability.

**Gap analysis results**: **28 gaps identified** — 4 Critical, 9 High, 10 Medium, 5 Low. Estimated remediation: **35-50 person-days** across 4 sprints.

**Top 3 risks**:
1. **Bridge contract broken** — 4 TypeScript interface methods have no Android implementation (GAP-007, GAP-008, GAP-030)
2. **Push delivery failure** — FCM token refresh never syncs to backend; calls silently stop arriving (GAP-024)
3. **Calls die on network drops** — SDK auto-reconnect defaults to `false` on Android but `true` on iOS/Web (GAP-017)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Inventory](#2-component-inventory)
3. [Capacitor Bridge & Web Communication](#3-capacitor-bridge--web-communication)
4. [Notification & Push Management](#4-notification--push-management)
5. [VoIP Implementation](#5-voip-implementation)
6. [Backend Communication](#6-backend-communication)
7. [Calling UI](#7-calling-ui)
8. [Credential & State Management](#8-credential--state-management)
9. [Analytics & Logging](#9-analytics--logging)
10. [Gap Analysis Summary](#10-gap-analysis-summary)
11. [Remediation Roadmap](#11-remediation-roadmap)

---

## 1. Architecture Overview

### 1.1 System Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                   CAPACITOR WEBVIEW LAYER                         │
│  React 19 SPA (Inertia.js) + NativeVoipProvider                 │
│  useTelnyxVoip hook → Capacitor bridge → JSON/Promise            │
└───────────────────────────────┬─────────────────────────────────┘
                                │
════════════════════════════════╪══════════════════════════════════
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                   NATIVE BRIDGE LAYER                             │
│  TelnyxVoipPlugin (@CapacitorPlugin)                             │
│  - 20 @PluginMethod methods                                      │
│  - Observes TelnyxViewModel.uiState → notifyListeners() to JS   │
│  - Permission management, PhoneAccount registration              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                   NATIVE VOIP CORE LAYER                         │
│  FCM Service + PushSynchronizer + ConnectionService              │
│  IncomingCallActivity + ActiveCallActivity                       │
│  Audio stack + Crash recovery + Observability                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                   TELNYX SDK LAYER                                │
│  TelnyxClient (Verto JSON-RPC over WebSocket)                    │
│  WebRTC media (SRTP/DTLS, ICE, STUN/TURN)                       │
│  wss://rtc.telnyx.com:443                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Design Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| P1 | **Native-first for VoIP** | All call handling is native Kotlin, independent of WebView. WebView may not exist when a push wakes the app from killed state. |
| P2 | **Single source of truth** | `TelnyxViewModel` owns SDK state. `Z360VoipStore` owns Z360 metadata. `CallStatePersistence` owns crash-recovery state. No duplicated state. |
| P3 | **ConnectionService for system integration** | Android 14+ requires ConnectionService for reliable lock screen notifications, Bluetooth/car audio routing, and system call management. |
| P4 | **Capacitor bridge for control, not media** | The bridge carries JS-initiated commands and native-to-JS event notifications. Never for call establishment, media, or time-critical call paths. |
| P5 | **Defensive push handling** | Two pushes (Z360 + Telnyx) arrive in unpredictable order. Architecture handles either arriving first, both arriving, or only one arriving. |
| P6 | **Graceful degradation** | Every integration point (ConnectionService, CallStyle, full-screen intent, Bluetooth) has a fallback path. |
| P7 | **Process isolation for audio** | Foreground service runs in `:call_service` process, isolated from WebView crashes. |
| P8 | **Structured observability** | Every significant state transition is logged with structured metadata and reported to analytics. |

### 1.3 Key Architectural Decisions (Current)

- **Server-mediated push**: Z360 backend sends FCM pushes directly (not Telnyx's native push binding) — needed for org context, caller display info, avatar URLs
- **Two-push correlation**: Z360 push (caller display) + Telnyx push (call control), correlated by normalized phone number (last 10 digits), 500ms timeout
- **Self-managed ConnectionService**: Z360 manages its own call UI via Android Telecom framework
- **Single shared ViewModel**: `TelnyxViewModel` shared across Activities and Capacitor plugin via custom `ViewModelStore`
- **Single call support**: Auto-rejects incoming calls when user is already on a call (US-018)

---

## 2. Component Inventory

### 2.1 All 23 Components

| Component | File | Lines | Primary Responsibility |
|-----------|------|-------|----------------------|
| **TelnyxVoipPlugin** | `voip/TelnyxVoipPlugin.kt` | 789 | Capacitor bridge: routes JS commands to native, forwards events to JS |
| **TelnyxViewModelProvider** | `voip/TelnyxViewModelProvider.kt` | 28 | Singleton access to shared TelnyxViewModel |
| **Z360VoipStore** | `voip/Z360VoipStore.kt` | 324 | Persists Z360 metadata (org context, call display info) |
| **Z360FirebaseMessagingService** | `fcm/Z360FirebaseMessagingService.kt` | 614 | FCM push processing, dual-push routing |
| **PushSynchronizer** | `fcm/PushSynchronizer.kt` | 299 | Correlates Z360 + Telnyx pushes with timeout |
| **TokenHolder** | `fcm/TokenHolder.kt` | 267 | FCM token lifecycle (obtain, refresh, persist) |
| **Z360ConnectionService** | `voip/Z360ConnectionService.kt` | 162 | Android Telecom framework integration |
| **Z360Connection** | `voip/Z360Connection.kt` | 212 | Single call's Telecom framework lifecycle |
| **IncomingCallActivity** | `voip/IncomingCallActivity.kt` | 925 | Incoming call UI (answer/reject, lock screen) |
| **ActiveCallActivity** | `voip/ActiveCallActivity.kt` | 1387 | Active call UI (controls, quality, timer) |
| **BluetoothAudioManager** | `voip/BluetoothAudioManager.kt` | 422 | Bluetooth SCO audio routing |
| **AudioDiagnostics** | `voip/AudioDiagnostics.kt` | 385 | Audio focus management, state logging |
| **CallStatePersistence** | `voip/CallStatePersistence.kt` | 205 | Persists active call state for crash recovery |
| **CrashRecoveryManager** | `voip/CrashRecoveryManager.kt` | 195 | Detects and recovers from abandoned calls |
| **OrgSwitchHelper** | `voip/OrgSwitchHelper.kt` | 137 | Backend API call for org switching during calls |
| **MissedCallNotificationManager** | `voip/MissedCallNotificationManager.kt` | 274 | Missed call notifications with badge count |
| **CallTimerManager** | `voip/CallTimerManager.kt` | 163 | Call duration tracking and broadcasting |
| **VoipLogger** | `voip/VoipLogger.kt` | 640 | Structured logging (Logcat + file + Crashlytics) |
| **VoipAnalytics** | `voip/VoipAnalytics.kt` | 847 | Firebase Analytics events (25+ event types) |
| **VoipPerformance** | `voip/VoipPerformance.kt` | 294 | Firebase Performance custom traces |
| **VoipRemoteConfig** | `voip/VoipRemoteConfig.kt` | 245 | Firebase Remote Config for runtime tuning |
| **CrashlyticsHelper** | `voip/CrashlyticsHelper.kt` | 353 | Structured error logging with custom keys |
| **PhoneNumberFormatter** | `voip/PhoneNumberFormatter.kt` | 40 | US phone number formatting for display |

### 2.2 Inter-Component Communication

```
┌─────────────────────────────────────────────────────────────┐
│                     WebView (JavaScript)                     │
│                  Capacitor plugin bridge                     │
└────────────────────────┬────────────────────────────────────┘
                         │ @PluginMethod calls
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   TelnyxVoipPlugin                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Z360VoipStore│  │TelnyxViewModel│  │  TokenHolder    │    │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘    │
└─────────┼────────────────┼───────────────────┼──────────────┘
          │    ┌───────────▼───────────┐       │
          │    │  Telnyx Common SDK     │       │
          │    └───────────┬───────────┘       │
┌─────────┼────────────────┼───────────────────┼──────────────┐
│ FCM     │                │                   │              │
│ ┌───────▼──────┐   ┌────▼─────────┐   ┌────▼────────┐     │
│ │PushSynchronizer│  │Z360Firebase  │   │  TokenHolder │     │
│ └───────┬──────┘   │  Messaging   │   └─────────────┘     │
│         │          └──────┬──────┘                         │
└─────────┼─────────────────┼────────────────────────────────┘
          │    ┌────────────▼────────────────┐
          │    │  Z360ConnectionService       │
          │    │  └─▶ Z360Connection         │
          │    └────────────┬────────────────┘
          │    ┌────────────▼────────────────┐
          │    │  IncomingCallActivity        │
          │    └────────────┬────────────────┘
          │    ┌────────────▼────────────────┐
          │    │  ActiveCallActivity          │
          │    └─────────────────────────────┘
```

**7 communication mechanisms**: Direct method calls, StateFlow/Flow, BroadcastReceiver, SharedPreferences, Static singletons, CompletableDeferred, Intents/Extras.

---

## 3. Capacitor Bridge & Web Communication

### 3.1 How Android Communicates with WebView

The Capacitor bridge is the sole communication channel between the React SPA and native Android:

**JS → Native** (Commands): Via `@PluginMethod` annotations on `TelnyxVoipPlugin`. The web calls methods like `TelnyxVoip.connect()`, `TelnyxVoip.makeCall()`, etc. These are JSON-serialized and dispatched to the native plugin on the main thread.

**Native → JS** (Events): Via `notifyListeners("eventName", data)`. The plugin observes three Kotlin Flows from `TelnyxViewModel`:
1. `uiState` (TelnyxSocketEvent) — `onConnected`, `onIncomingCall`, `onCallAnswered`, `onCallEnded`, `onCallDropped`, `onRinging`
2. `callQualityMetrics` — MOS/jitter/RTT
3. `connectionStatus` — SDK connection state changes

### 3.2 Plugin Methods (20 exposed)

| Category | Methods |
|----------|---------|
| **Connection** | `connect`, `disconnect`, `reconnectWithCredentials`, `isConnected` |
| **Calling** | `makeCall`, `answerCall`, `rejectCall`, `hangup` |
| **Controls** | `setMute`, `setSpeaker`, `setHold`, `sendDTMF` |
| **State** | `setCurrentOrganization`, `setCallDisplayInfo`, `getFcmToken`, `getDeviceId` |
| **Permissions** | `requestVoipPermissions`, `checkCallPermissions`, `requestBatteryOptimizationExemption`, `openFullScreenIntentSettings` |

### 3.3 Platform Isolation — How Web WebRTC Is Disabled on Native

```
if (Capacitor.isNativePlatform())
  → NativeVoipProvider (Capacitor bridge to native SDK)
else
  → TelnyxRTCProvider (WebRTC in browser, @telnyx/react-client)
```

**NativeVoipProvider** replaces `TelnyxRTCProvider` on native platforms, preventing the web layer from creating its own WebSocket/SIP connection. This is critical — without it, both native Telnyx SDK and web `@telnyx/react-client` would register SIP simultaneously, causing conflicts (newer displaces older).

**BUG-003 prevention**: When WebView loads and React calls `TelnyxVoip.connect()`, the plugin checks if the SDK is already connected (e.g., from push wake). If so, it skips reconnection to preserve the native socket.

### 3.4 Bridge Interface Gaps (CRITICAL)

| Method | TypeScript Interface | Android Native | Status |
|--------|---------------------|---------------|--------|
| `connectWithToken()` | Defined | **NOT implemented** | **BROKEN** (GAP-007) |
| `getNetworkStatus()` | Defined | **NOT implemented** | **BROKEN** (GAP-008) |
| `getConnectionState()` | Defined | **NOT implemented** | **BROKEN** (GAP-008) |
| `getFcmTokenWithWait()` | Defined | **NOT implemented** | **BROKEN** (GAP-008) |
| `requestBatteryOptimization...` | NOT defined | Implemented | Extra (needs TS definition) |
| `checkCallPermissions()` | NOT defined | Implemented | Extra (needs TS definition) |
| `openFullScreenIntentSettings()` | NOT defined | Implemented | Extra (needs TS definition) |

---

## 4. Notification & Push Management

### 4.1 Dual-Push Architecture

Z360 receives **two independent FCM pushes** for each inbound call:

```
Z360 Backend ──FCM Push #1 (caller info)──┐
                                           ├──► Z360FirebaseMessagingService
Telnyx Platform ──FCM Push #2 (call ctrl)──┘         │
                                                      ▼
                                               PushSynchronizer
                                              (500ms correlation)
                                                      │
                                                      ▼
                                           Enhanced call data
                                          (name + avatar + SIP)
```

**Push type discrimination**:
- Z360 push: `data["type"] == "incoming_call"` → `handleZ360CallerInfoPush()`
- Telnyx push: Contains `voice_sdk_id` or `telnyx_` prefix → `handleTelnyxMetadataPush()`
- Dismissal push: `data["type"] == "call_ended"` → Dismiss everything

### 4.2 Push Synchronization (PushSynchronizer)

**Correlation key**: Normalized phone number (last 10 digits). Different call IDs between Z360 and Telnyx make phone number the only reliable correlation point.

**Three scenarios**:

| Scenario | Z360 Push | Telnyx Push | Wait Time | Result |
|----------|-----------|-------------|-----------|--------|
| A: Z360 first | Arrives, stored | Arrives later | 0ms | IMMEDIATE sync |
| B: Telnyx first | Arrives within 500ms | Arrives, waits | ≤500ms | WAITED sync |
| C: Z360 lost | Never arrives / late | Arrives, waits | 500ms timeout | TIMEOUT (partial data) |

**Data structures**: `ConcurrentHashMap<String, SyncEntry>` with `CompletableDeferred<Unit>` for async coordination. `Mutex` for thread safety. Entry expiry: 30 seconds.

### 4.3 FCM Guards and Protections

| Guard | Purpose | Implementation |
|-------|---------|---------------|
| US-014 | Reject pushes when logged out | Check `ProfileManager.isUserLoggedIn` |
| US-018 | Single call support | Check `TelnyxViewModel` for active call, show missed call notification |
| Re-INVITE | Prevent ghost calls after hangup | `Z360VoipStore.wasRecentlyEnded()` — 15s cooldown |
| Notification suppression | Cancel Telnyx SDK's internal notification | Cancel notification ID 1234 (hardcoded — GAP-018) |
| US-013 | Cold start detection | Service creation timestamp comparison |

### 4.4 Notification Channels

| Channel ID | Importance | Purpose | Status |
|------------|-----------|---------|--------|
| `z360_incoming_call` | HIGH | Incoming call full-screen notifications | **Exists** |
| `z360_ongoing_call` | LOW | Active call status | **MISSING** (GAP-002) |
| `z360_crash_recovery` | HIGH | Post-crash recovery | **Exists** |
| `z360_missed_calls` | HIGH | Missed call with badge count | **Exists** |

### 4.5 Notification Gaps

- **No CallStyle notifications** (GAP-001): Uses basic `NotificationCompat.Builder` instead of `CallStyle.forIncomingCall()` (Android 12+). Telnyx demo uses CallStyle.
- **No ongoing call notification** (GAP-002): During active call, only the generic Telnyx `CallForegroundService` notification is visible. No Z360-branded ongoing notification with caller info, duration, or hangup button.
- **FCM token refresh not synced** (GAP-024): `onNewToken()` stores locally but never calls backend `POST /api/device-tokens`. After token rotation, all future pushes fail silently.

---

## 5. VoIP Implementation

### 5.1 Call State Machine

**Current state**: No formal state machine exists (GAP-003). States are tracked via scattered booleans (`isAnswering`, `isCallActive`, `isCallConnected`, `isHeld`) and SDK event observations.

**Target state machine** (10 states, 20 transitions):

```
              ┌──────────┐
        ┌────►│   IDLE   │◄──────────────────────┐
        │     └────┬─────┘                        │
        │    ┌─────┴──────┐                       │
        │    │            │                       │
        │    ▼            ▼                       │
        │  FCM Push    makeCall()                 │
        │    │            │                       │
        │    ▼            ▼                       │
        │ ┌────────────┐ ┌────────────────┐       │
        │ │  RINGING_   │ │   RINGING_     │       │
        │ │  INBOUND    │ │   OUTBOUND     │       │
        │ └──┬───┬──────┘ └───┬───┬────────┘       │
        │    │   │reject      │   │cancel           │
        │    │   └────────────┼───┴──► ENDED/FAILED─┘
        │    │ answer()       │ remote answers
        │    ▼                ▼
        │ ┌──────────────────────────┐
        │ │       CONNECTING         │──timeout──► FAILED
        │ └──────────┬───────────────┘
        │            │ media connected
        │            ▼
        │ ┌──────────────────────────┐
        │ │         ACTIVE           │◄─── RECONNECTING (ok)
        │ └──┬───────────┬──────┬───┘
        │    │ hold()    │      │ network drop
        │    ▼           │      ▼
        │ ON_HOLD        │   RECONNECTING (60s timeout → FAILED)
        │    │ unhold     │
        │    └───► ACTIVE │
        │               │ hangup
        │               ▼
        │       DISCONNECTING (5s timeout)
        │               │
        │               ▼
        └────────── ENDED
```

### 5.2 Inbound Call Flow (Detailed)

```
PSTN Call → Telnyx Platform → Webhook to Z360 Backend
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
                FCM Push #1              FCM Push #2
                (Z360 caller info)       (Telnyx metadata)
                        │                       │
                        ▼                       ▼
              Z360FirebaseMessagingService
                        │
                        ├── Login check (US-014)
                        ├── Active call check (US-018)
                        ├── Re-INVITE guard (15s cooldown)
                        │
                        ├── ensureTelnyxSdkConnected() (5s timeout)
                        ├── PushSynchronizer.waitForZ360Data() (500ms)
                        │
                        ▼
              showIncomingCallNotification()
                        │
                        ├── Tier 1: TelecomManager.addIncomingCall()
                        │     → Z360ConnectionService.onCreateIncomingConnection()
                        │       → Z360Connection → onShowIncomingCallUi()
                        │         → Post fullScreenIntent notification
                        │         → Launch IncomingCallActivity
                        │
                        ├── Tier 2 (fallback): Telnyx SDK notification
                        └── Tier 3 (fallback): Direct Activity launch
```

### 5.3 Inbound Answer Flow

```
User taps Answer
  └─▶ AtomicBoolean.compareAndSet (prevents double-tap, BUG-005)
      └─▶ Is cross-org call? (organizationId != currentOrgId)
          ├─ YES: answerCrossOrgCall()
          │   └─▶ OrgSwitchHelper.switchOrgAndGetCredentials()
          │       └─▶ ProfileManager.update() → answerDirectly()
          └─ NO: answerDirectly()
              └─▶ Stop ringtone → 250ms audio settle delay
                  └─▶ Has currentCall UUID?
                      ├─ YES: telnyxViewModel.answerCall(uuid)
                      ├─ NO: Has plugin pending call?
                      │   ├─ YES: telnyxViewModel.answerCall(pending.uuid)
                      │   └─ NO: Wait up to 5s for SDK INVITE
                      │       ├─ RECEIVED: answerCall(uuid)
                      │       └─ TIMEOUT: answerIncomingPushCall()
                      └─▶ Transition to ActiveCallActivity
```

### 5.4 Outbound Call Flow

```
React SPA                  TelnyxVoipPlugin              ActiveCallActivity
    │                            │                              │
    │ makeCall(number) ────────►│                              │
    │                            │── sendInvite(number) ──►SDK │
    │                            │                              │
    │                            │── Launch Activity ──────────►│
    │                            │                              │── 30s setup timeout (US-016)
    │◄── callStarted event ──── │                              │── observe uiState
    │◄── callRinging event ──── │                              │
    │◄── callAnswered event ─── │                              │── start timer, persist, audio focus
    │                            │                              │
```

**Gap**: Outbound calls bypass ConnectionService entirely — no `onCreateOutgoingConnection()` (GAP-004, GAP-020). No system integration for outbound (Bluetooth buttons, car display, call log).

### 5.5 Simultaneous Ring & Dismissal

- Per-device SIP credentials enable simultaneous ring across devices
- When one device answers, `call_ended` push is sent to other devices
- `ACTION_CALL_ENDED` broadcast dismisses `IncomingCallActivity`
- `Z360VoipStore.markCallEnded()` prevents ghost re-INVITEs (15s cooldown)

**Gap**: Race condition between answer and call_ended push — user can tap answer while dismissal is in flight (GAP-010).

### 5.6 Audio Routing

**Priority**: Bluetooth > Wired headset > Speaker (user-selected) > Earpiece (default)

| Component | Responsibility |
|-----------|---------------|
| `AudioDiagnostics` | `AudioFocusRequest` management, `GAIN_TRANSIENT` (should be `GAIN_TRANSIENT_EXCLUSIVE` — GAP-012), `MODE_IN_COMMUNICATION` |
| `BluetoothAudioManager` | SCO audio routing, headset detection, BroadcastReceiver for BT state |
| `ActiveCallActivity` | UI controls (speaker toggle, BT indicator), proximity sensor (`PROXIMITY_SCREEN_OFF_WAKE_LOCK`) |

**Gap**: Uses deprecated `setSpeakerphoneOn()` and `startBluetoothSco()` — no modern `setCommunicationDevice()` API (API 31+) (GAP-013).

### 5.7 Crash Recovery

```
App crash during active call
    → Process killed
    → User reopens app
    → CrashRecoveryManager.checkAndRecover()
        → CallStatePersistence.checkForAbandonedCall()
        → Clean orphaned resources (FGS, notifications, zombie SDK)
        → Show recovery notification ("Your call was disconnected")
        → Clear persisted state
```

**Design decision**: Does NOT attempt call reconnection — other party will have hung up. Recovery is informational only.

---

## 6. Backend Communication

### 6.1 How Android Works with Laravel

| Communication Path | Method | Purpose |
|-------------------|--------|---------|
| **Push delivery** | Z360 backend → FCM → Android | Caller info for inbound calls |
| **Credential login** | React SPA → Laravel API → Inertia props → Capacitor bridge → native | SIP credentials passed to SDK |
| **Org switch** | Native → HTTP POST `/api/voip/switch-org` → Laravel | Cross-org credential fetch |
| **Device token registration** | React SPA → Laravel API `POST /api/device-tokens` | FCM token for push targeting |
| **Webhook processing** | Telnyx → Laravel webhook controller → FCM push to device | Inbound call notification |

### 6.2 Backend Communication Gaps

| Gap | Issue | Impact |
|-----|-------|--------|
| **GAP-023 (Critical)** | OrgSwitchHelper hardcodes `API_BASE_URL = "https://app.z360.cloud"` | All non-production environments hit production for org switch |
| **GAP-024 (Critical)** | `onNewToken()` never syncs new FCM token to backend | After token rotation, all pushes fail silently |
| **GAP-025 (High)** | OrgSwitchHelper uses WebView cookies for auth | Fails on cold-start cross-org calls (WebView not loaded, no cookies) |

---

## 7. Calling UI

### 7.1 IncomingCallActivity (925 lines)

- Full-screen incoming call UI with accept/reject buttons
- Lock screen support: `setShowWhenLocked(true)`, `setTurnScreenOn(true)`
- System ringtone with looping, vibration pattern (1s on, 1s off)
- Avatar loading via Coil with fallback to initials
- BroadcastReceivers for display info updates and call-ended dismissal
- Cross-org answer flow with OrgSwitchHelper integration

### 7.2 ActiveCallActivity (1387 lines)

- Call controls: mute, hold, speaker, DTMF keypad, end call
- Call quality indicator (MOS/jitter/RTT from SDK)
- Bluetooth indicator (from BluetoothAudioManager broadcasts)
- Proximity sensor for screen-off when near ear
- Call timer via CallTimerManager (survives activity recreation)
- Outgoing call: 30s setup timeout with error categorization (US-016)
- Foreground/background lifecycle tracking for analytics

**Gap**: 1387 lines makes this a potential god class (GAP-022). Handles 10+ distinct responsibilities.

### 7.3 UI Gaps

| Gap | Issue | Impact |
|-----|-------|--------|
| **GAP-014 (Medium)** | No accessibility (`contentDescription`, TalkBack) | ADA/WCAG compliance concern for enterprise SaaS |
| **GAP-021 (Low)** | No Material Design 3 components | Inconsistent with Android ecosystem look and feel |
| **GAP-022 (Low)** | ActiveCallActivity is a god class at 1387 lines | Hard to maintain and test |

---

## 8. Credential & State Management

### 8.1 Credential Lifecycle

```
CREATION:
  WebView authenticates → React calls TelnyxVoip.connect(sipUser, sipPass)
  Backend creates TelephonyCredential on Telnyx (per-device, 30-day expiry)
  Backend generates JWT (10-hour TTL)

STORAGE:
  ProfileManager (Telnyx Common) → SharedPreferences (plain text — GAP-026)
  Z360VoipStore (Z360-specific) → SharedPreferences (plain text)

REFRESH:
  JWT expires (10h) → SDK disconnects → React re-authenticates → new connect()
  Credential expires (30d) → Backend creates new on next device registration

ORG SWITCHING:
  Push includes org_id → compare with current → OrgSwitchHelper API call
  → New credentials → ProfileManager.saveProfile() → SDK reconnect → answer
  Budget: ~10 seconds total (before ring timeout)

CLEANUP:
  Stale devices (7d inactive) → backend auto-deletes
  Logout → ProfileManager clears, isUserLoggedIn = false
```

### 8.2 State Management

| Store | Purpose | Scope | Persistence |
|-------|---------|-------|-------------|
| `TelnyxViewModel` (via Provider) | SDK state, call state, Flows | App lifetime (singleton) | None (in-memory) |
| `Z360VoipStore` | Org context, call display info, call metadata | Cross-component | SharedPreferences |
| `CallStatePersistence` | Active call state for crash recovery | Cross-restart | SharedPreferences |
| `ProfileManager` (Telnyx) | SIP credentials, login state | Cross-restart | SharedPreferences |
| `PushSynchronizer` | Two-push correlation entries | Transient (30s expiry) | In-memory ConcurrentHashMap |

### 8.3 Credential & State Gaps

| Gap | Issue |
|-----|-------|
| **GAP-026 (Medium)** | SIP credentials stored in plain SharedPreferences (should use EncryptedSharedPreferences) |
| **GAP-027 (Low)** | Z360VoipStore cleanup not triggered after call ends — stale entries accumulate |
| **GAP-011 (Medium)** | No credential refresh mechanism during active call |
| **GAP-009 (High)** | No mutex between FCM handler and plugin credential login paths — race condition |

---

## 9. Analytics & Logging

### 9.1 Observability Stack

| Component | Sink | Purpose |
|-----------|------|---------|
| **VoipLogger** (640 lines) | Logcat + local file + Crashlytics breadcrumbs | Structured logging with sections, call state markers, SDK noise filtering |
| **VoipAnalytics** (847 lines) | Firebase Analytics | 25+ event types with `voip_` prefix — call lifecycle, push timing, org switch |
| **CrashlyticsHelper** (353 lines) | Firebase Crashlytics | Custom keys on crash (`voip_call_active`, `voip_call_state`, etc.), non-fatal logging |
| **VoipPerformance** (294 lines) | Firebase Performance | Custom traces: `push_to_ring_ms`, `sdk_connect_ms`, `answer_to_media_ms` |
| **VoipRemoteConfig** (245 lines) | Firebase Remote Config | Runtime tuning: timeouts, feature flags, audio settings, logging verbosity |

### 9.2 Analytics Events (25+ types)

Call lifecycle: `call_initiated`, `call_connected`, `call_ended`, `audio_connected`, `error`
Push analytics: `push_z360_received`, `push_telnyx_received`, `push_sync_completed`, `push_rejected_logged_out`
Outgoing: `outgoing_initiated`, `outgoing_ringback`, `outgoing_failed`
Audio: `audio_focus_gained`, `audio_focus_lost`
Cross-org: `cross_org_call`, `call_missed_busy`
Lifecycle: `app_backgrounded`, `app_foregrounded`

### 9.3 Analytics Gaps

| Gap | Issue |
|-----|-------|
| **GAP-029 (Low)** | SDK version hardcoded as `"3.2.0"` — should read dynamically |

---

## 10. Gap Analysis Summary

### 10.1 All 28 Gaps by Severity

#### Critical (4) — Fix Immediately

| ID | Category | Summary | Effort |
|----|----------|---------|--------|
| **GAP-007** | Bridge | `connectWithToken()` defined in TS but NOT implemented in Android — bridge contract broken | Small |
| **GAP-023** | Backend | Hardcoded `API_BASE_URL = "https://app.z360.cloud"` — breaks non-production | Small |
| **GAP-024** | Backend | FCM `onNewToken()` only saves locally — never syncs to backend, pushes fail | Medium |
| **GAP-030** | Bridge | 4 TS interface methods missing from Android native (connectWithToken, getNetworkStatus, getConnectionState, getFcmTokenWithWait) | Medium |

#### High (9) — Fix Soon

| ID | Category | Summary | Effort |
|----|----------|---------|--------|
| **GAP-001** | Notifications | No CallStyle notifications (Google-recommended since Android 12) | Small |
| **GAP-002** | Notifications | No ongoing call notification channel or notification | Medium |
| **GAP-006** | Push | `runBlocking` on FCM thread — potential ANR under rapid consecutive pushes | Medium |
| **GAP-008** | Bridge | 3 additional TS methods missing from Android (getNetworkStatus, getConnectionState, getFcmTokenWithWait) | Medium |
| **GAP-009** | Race Condition | No mutex between FCM handler and plugin credential login — race during org switch | Medium |
| **GAP-017** | SDK | Auto-reconnect NOT enabled (defaults to `false` on Android) — calls die on brief network drops | Small |
| **GAP-025** | Backend | OrgSwitchHelper uses WebView cookies — fails on cold-start cross-org calls | Medium |
| **GAP-033** | Testing | Zero test coverage for 8,000+ lines of VoIP code | Large |
| **GAP-015** | Platform | No network change monitoring (ConnectivityManager.NetworkCallback) | Medium |

#### Medium (10) — Plan for Next Sprint

| ID | Category | Summary | Effort |
|----|----------|---------|--------|
| **GAP-003** | Architecture | No formal call state machine — scattered booleans instead | Large |
| **GAP-004** | Architecture | ConnectionService missing `onCreateOutgoingConnection()` | Medium |
| **GAP-005** | Flow | No client-side inbound ringing timeout (relies on Telnyx platform) | Small |
| **GAP-010** | Race Condition | Simultaneous answer and call-ended push race — can transition to ActiveCallActivity after dismissal | Small |
| **GAP-011** | Credentials | No credential refresh during active call | Medium |
| **GAP-013** | Platform | No modern audio routing APIs (`setCommunicationDevice`, API 31+) | Medium |
| **GAP-014** | UI | No accessibility support in call UI (contentDescription, TalkBack) | Small |
| **GAP-020** | Outbound | Outbound calls lack ConnectionService integration | Medium |
| **GAP-026** | Credentials | SIP credentials stored in plain SharedPreferences | Medium |
| **GAP-028** | Notifications | Missed call "Call Back" action may not work for cross-org calls | Medium |

#### Low (5) — Backlog

| ID | Category | Summary | Effort |
|----|----------|---------|--------|
| **GAP-012** | Audio | Audio focus uses `GAIN_TRANSIENT` instead of `GAIN_TRANSIENT_EXCLUSIVE` | Small |
| **GAP-016** | Platform | Full-screen intent permission not proactively checked on Android 14+ | Small |
| **GAP-018** | SDK | Hardcoded Telnyx SDK notification ID (1234) for suppression | Small |
| **GAP-019** | SDK | No ICE restart support | Small |
| **GAP-021** | UI | IncomingCallActivity not following Material Design 3 | Medium |
| **GAP-022** | UI | ActiveCallActivity at 1387 lines — potential god class | Large |
| **GAP-027** | State | Z360VoipStore cleanup not triggered after call ends | Small |
| **GAP-029** | Analytics | Hardcoded SDK version "3.2.0" in analytics | Small |
| **GAP-031** | Isolation | Web stubs don't throw/warn for native-only methods | Small |
| **GAP-032** | Isolation | No runtime guard against accidental web WebRTC on native | Small |

### 10.2 Effort Distribution

| Effort Level | Count | Estimated Days |
|-------------|-------|---------------|
| Small (< 1 day) | 14 | ~10 days |
| Medium (1-3 days) | 11 | ~20 days |
| Large (3+ days) | 3 | ~12 days |
| **Total** | **28** | **~35-50 person-days** |

---

## 11. Remediation Roadmap

### Sprint 1: Critical Fixes (~5 days)

| Priority | Gap | Action | Days |
|----------|-----|--------|------|
| 1 | GAP-023 | Replace hardcoded `API_BASE_URL` with BuildConfig | 0.5 |
| 2 | GAP-007 | Implement `connectWithToken()` native method | 0.5 |
| 3 | GAP-030 | Add 3 remaining missing native methods + update TS interface | 2 |
| 4 | GAP-017 | Enable `autoReconnect = true` in all `credentialLogin()` calls | 0.5 |
| 5 | GAP-024 | Sync FCM token to backend on `onNewToken()` | 1.5 |

**Exit criteria**: All TypeScript interface methods have working Android implementations. SDK auto-reconnects on network drops. Push delivery reliable after token rotation. Non-production environments work.

### Sprint 2: High Priority (~10 days)

| Priority | Gap | Action | Days |
|----------|-----|--------|------|
| 1 | GAP-001 | Implement `CallStyle.forIncomingCall()` (API 31+, fallback) | 1 |
| 2 | GAP-002 | Create ongoing call notification with `CallStyle.forOngoingCall()` | 2 |
| 3 | GAP-009 | Add `Mutex` around credential login paths | 2 |
| 4 | GAP-025 | Replace WebView cookie auth with persistent API token | 2 |
| 5 | GAP-006 | Replace `runBlocking` with `CoroutineScope(IO).launch` in FCM handler | 1.5 |
| 6 | GAP-015 | Create `NetworkMonitor` with `ConnectivityManager.NetworkCallback` | 1.5 |

**Exit criteria**: CallStyle notifications on Android 12+. Ongoing call notification visible. No credential race conditions. Cross-org cold-start calls work. Network monitoring active.

### Sprint 3: Medium Priority (~12 days)

| Priority | Gap | Action | Days |
|----------|-----|--------|------|
| 1 | GAP-003 | Implement formal `sealed class VoipCallState` state machine | 4 |
| 2 | GAP-004/020 | Add `onCreateOutgoingConnection()` to ConnectionService | 2 |
| 3 | GAP-013 | Add modern audio routing APIs (API 31+) with legacy fallback | 2 |
| 4 | GAP-005 | Add 35s client-side inbound ringing timeout | 0.5 |
| 5 | GAP-010 | Add dismissed `AtomicBoolean` to prevent answer-after-dismissal race | 0.5 |
| 6 | GAP-014 | Add accessibility (`contentDescription`) to call UI elements | 1 |
| 7 | GAP-026 | Migrate Z360VoipStore to `EncryptedSharedPreferences` | 2 |

**Exit criteria**: Formal state machine governing all call transitions. Outbound calls integrated with ConnectionService. Modern audio routing. Accessibility basics in place.

### Sprint 4: Testing & Low Priority (~10 days)

| Priority | Gap | Action | Days |
|----------|-----|--------|------|
| 1 | GAP-033 | Unit tests for PushSynchronizer, Z360VoipStore, PhoneNumberFormatter, CallStatePersistence, TokenHolder | 5 |
| 2 | GAP-011 | Credential refresh monitoring during active calls | 2 |
| 3 | GAP-028 | Fix cross-org "Call Back" in missed call notifications | 1 |
| 4 | Low gaps | GAP-012, 016, 018, 027, 029, 031 | 2 |

**Exit criteria**: Core logic components have unit tests. Credential refresh handled. Low-priority gaps closed.

---

## Appendix A: Known Bugs and TODOs in Current Code

| ID | Component | Description | Status |
|----|-----------|-------------|--------|
| BUG-001 | TelnyxVoipPlugin | Thread-safe `AtomicReference<PendingIncomingCall?>` | Fixed |
| BUG-003 | TelnyxVoipPlugin, FCM | Skip re-connect if SDK already connected | Fixed |
| BUG-004 | FCM | Pass txPushMetaData to SDK reconnection | Fixed |
| BUG-005 | IncomingCallActivity | `AtomicBoolean.compareAndSet` for double-tap prevention | Fixed |
| BUG-006 | TelnyxVoipPlugin | Wait for `ClientLoggedIn` state before resolving (8s timeout) | Fixed |
| BUG-007 | ActiveCallActivity | Mutex-protected callStateJob prevents duplicate observers | Fixed |
| BUG-008 | ActiveCallActivity, Audio | Ensure `MODE_IN_COMMUNICATION` persists; proper AudioFocusRequest storage | Fixed |
| BUG-012 | TelnyxVoipPlugin | Auto-mute during hold prevents audio HAL noise | Fixed |
| BUG-013 | PushSynchronizer | CompletableDeferred replaces polling-with-backoff | Fixed |
| TODO | OrgSwitchHelper | Hardcoded API_BASE_URL — use BuildConfig or remote config | **Open** |
| TODO | VoipAnalytics | sdk_version hardcoded "3.2.0" — read from SDK at runtime | **Open** |
| TODO | Z360VoipStore | Phone normalization (last 10 digits) — fails for non-US international numbers | **Open** |
| RISK | Z360Connection | Single active connection via AtomicReference — no call waiting/conference | Known limitation |
| RISK | CrashRecoveryManager | Does not attempt call reconnection — user loses call on crash | By design |
| RISK | FCM | Telnyx SDK notification ID (1234) is hardcoded — may break on SDK update | **Open** |

## Appendix B: Telnyx SDK Divergences

| Area | Telnyx SDK/Demo Pattern | Z360 Pattern | Reason |
|------|------------------------|-------------|--------|
| Push handling | SDK binds to FCM internally | Z360 backend sends own FCM push + coordinates two pushes | Need org context, caller display info, avatar URLs |
| Connection management | Simple `connect()`/`disconnect()` | Multiple reconnection paths (BUG-003, BUG-004, cross-org) | Multi-tenant credential switching, background push delivery |
| ViewModel sharing | Activity-scoped ViewModel | Custom `ViewModelStore` singleton | Shared across Capacitor plugin + Activities |
| Call UI | SDK's `CallNotificationService` | Full custom Activities + ConnectionService | Branded UI, org context, Android 14+ lock screen support |
| Audio management | SDK handles basic routing | Explicit AudioDiagnostics + BluetoothAudioManager | Multiple audio bugs (US-008) drove full control |
| Answer flow | Direct `call.answerCall()` | Multi-path: direct, cross-org, push-wait-5s | Background push delivery means SDK call object may not exist yet |
| Codec preferences | SDK default negotiation | Explicit: opus, PCMU, PCMA | Quality preference for opus |

## Appendix C: Manifest Declarations

```xml
<!-- Key VoIP permissions -->
RECORD_AUDIO, READ_PHONE_STATE, POST_NOTIFICATIONS,
FOREGROUND_SERVICE, FOREGROUND_SERVICE_PHONE_CALL,
MANAGE_OWN_CALLS, USE_FULL_SCREEN_INTENT,
BLUETOOTH_CONNECT, REQUEST_IGNORE_BATTERY_OPTIMIZATIONS

<!-- Key components -->
<service .fcm.Z360FirebaseMessagingService />
<service .voip.Z360ConnectionService
    android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE" />
<activity .voip.IncomingCallActivity
    android:showWhenLocked="true" android:turnScreenOn="true" />
<activity .voip.ActiveCallActivity
    android:launchMode="singleTop" />
```

---

*Generated: 2026-02-08 — Session 05: Android Architecture Design*
*Sources: voip-android skill (26 files), voip-frontend skill (16 files), voip-backend skill (41 files), Telnyx Android SDK pack, Telnyx Android demo pack, voip-call-sample-android pack, android-phone-integration-lib pack*
*Research team: current-state-doc (Task #1), target-arch-designer (Task #2), gap-analyst (Task #3), lead synthesis (Task #4)*
