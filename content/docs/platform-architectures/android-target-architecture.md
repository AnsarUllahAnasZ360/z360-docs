---
title: Android Target Architecture
---

# Android VoIP Target Architecture

> Defines the ideal architecture for Z360's Android VoIP implementation. Designed from first principles using patterns from the Telnyx Android SDK, Telnyx demo app, Android platform requirements, and Capacitor bridge constraints. Every design decision is justified by reference to platform requirements, SDK patterns, or Z360-specific needs.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Component Architecture](#2-component-architecture)
3. [Component Responsibilities](#3-component-responsibilities)
4. [Initialization Sequence](#4-initialization-sequence)
5. [Call State Machine](#5-call-state-machine)
6. [Inbound Call: Push Handling Flow](#6-inbound-call-push-handling-flow)
7. [Outbound Call Flow](#7-outbound-call-flow)
8. [Platform Isolation: Native VoIP vs Web WebRTC](#8-platform-isolation-native-voip-vs-web-webrtc)
9. [Audio Routing](#9-audio-routing)
10. [Crash Recovery](#10-crash-recovery)
11. [Credential Management](#11-credential-management)
12. [Analytics & Logging](#12-analytics--logging)
13. [Notification Management](#13-notification-management)
14. [Threading Model](#14-threading-model)
15. [Key Sequence Diagrams](#15-key-sequence-diagrams)

---

## 1. Design Principles

These principles govern all architectural decisions:

| # | Principle | Rationale |
|---|-----------|-----------|
| P1 | **Native-first for VoIP** | All call handling is native Kotlin, independent of WebView. WebView may not exist when a push wakes the app from killed state. (Ref: Capacitor architecture doc §7, "THE WEBVIEW MAY NOT EVEN EXIST DURING STEPS 1-6") |
| P2 | **Single source of truth** | `TelnyxViewModel` owns SDK state. `Z360VoipStore` owns Z360 metadata. `CallStatePersistence` owns crash-recovery state. No duplicated state. |
| P3 | **ConnectionService for system integration** | Android 14+ requires ConnectionService for reliable lock screen notifications, Bluetooth/car audio routing, and system call management. Telnyx demo skips this; Z360 must not. (Ref: Android platform requirements §1) |
| P4 | **Capacitor bridge for control, not media** | The Capacitor bridge carries JS-initiated commands and native-to-JS event notifications. Never for call establishment, media, or time-critical call paths. (Ref: Capacitor architecture doc §7) |
| P5 | **Defensive push handling** | Two pushes (Z360 + Telnyx) arrive in unpredictable order. The architecture must handle either arriving first, both arriving, or only one arriving, within a bounded timeout. (Ref: Telnyx reference §5.3) |
| P6 | **Graceful degradation** | Every integration point (ConnectionService, CallStyle notifications, full-screen intent, Bluetooth) has a fallback path for devices/API levels that don't support it. |
| P7 | **Process isolation for audio** | Foreground service runs in separate process (`:call_service`) to isolate from WebView crashes. (Ref: Android platform requirements §2, Z360 current implementation) |
| P8 | **Structured observability** | Every significant state transition is logged with structured metadata and reported to analytics. Logs enable post-hoc debugging of production call failures. |

---

## 2. Component Architecture

### 2.1 Master Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CAPACITOR WEBVIEW LAYER                            │
│                                                                             │
│  ┌──────────────────────────┐   ┌────────────────────────────────────────┐  │
│  │ React SPA (Inertia.js)  │   │ useTelnyxVoip Hook                     │  │
│  │ NativeVoipProvider      │◄──┤ addListener('connected', ...)           │  │
│  │ DialpadProvider         │   │ addListener('incomingCall', ...)        │  │
│  └──────────┬───────────────┘   │ addListener('callEnded', ...)          │  │
│             │ JS→Native          └────────────┬───────────────────────────┘  │
│             ▼                                  │                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    Capacitor Bridge (JSON/Promise)                    │   │
│  │  TelnyxVoip.connect() / makeCall() / setMute() / isConnected()      │   │
│  └──────────────────────────────┬───────────────────────────────────────┘   │
└─────────────────────────────────┼───────────────────────────────────────────┘
                                  │
══════════════════════════════════╪════════════════════════════════════════════
                                  │
┌─────────────────────────────────▼───────────────────────────────────────────┐
│                         NATIVE BRIDGE LAYER                                 │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ TelnyxVoipPlugin (@CapacitorPlugin)                                 │   │
│  │ - Routes JS commands to native services                             │   │
│  │ - Observes TelnyxViewModel.uiState → notifyListeners() to JS       │   │
│  │ - Manages permissions (microphone, notifications, phoneState)       │   │
│  │ - Registers PhoneAccount on load()                                  │   │
│  └──────────┬────────────────────────────────┬─────────────────────────┘   │
│             │ Delegates to                    │ Observes                     │
│             ▼                                 ▼                             │
│  ┌──────────────────────┐          ┌──────────────────────────────┐        │
│  │ TelnyxViewModelProv. │          │ Z360VoipStore                │        │
│  │ (shared ViewModel)   │          │ (SharedPreferences)          │        │
│  └──────────┬───────────┘          │ - Org context (id, name)    │        │
│             │                      │ - Call display info          │        │
│             ▼                      │ - Call metadata              │        │
│  ┌──────────────────────┐          └──────────────────────────────┘        │
│  │ TelnyxViewModel      │                                                  │
│  │ (Telnyx Common lib)  │                                                  │
│  │ - sessionsState Flow │                                                  │
│  │ - uiState Flow       │                                                  │
│  │ - credentialLogin()  │                                                  │
│  │ - sendInvite()       │                                                  │
│  │ - answerCall()       │                                                  │
│  │ - endCall()          │                                                  │
│  └──────────┬───────────┘                                                  │
└─────────────┼──────────────────────────────────────────────────────────────┘
              │
══════════════╪═══════════════════════════════════════════════════════════════
              │
┌─────────────▼──────────────────────────────────────────────────────────────┐
│                         NATIVE VOIP CORE LAYER                              │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ Z360FirebaseMessaging    │  │ Z360ConnectionService                  │   │
│  │ Service                  │  │ (Self-managed ConnectionService)       │   │
│  │ - onMessageReceived()    │  │ - onCreateIncomingConnection()         │   │
│  │ - Dual-push routing      │──►│ - PhoneAccount registration           │   │
│  │ - Login check (US-014)   │  │ - Z360Connection lifecycle             │   │
│  │ - SDK reconnect (BUG-003)│  │ - Fallback to direct notification      │   │
│  │ - Busy detection (US-018)│  └────────────┬──────────────────────────┘   │
│  └──────────┬───────────────┘               │                              │
│             │                               │                              │
│             ▼                               ▼                              │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ PushSynchronizer         │  │ Z360Connection                        │   │
│  │ - CompletableDeferred    │  │ - PROPERTY_SELF_MANAGED               │   │
│  │ - 500ms timeout          │  │ - setRinging() → onAnswer()           │   │
│  │ - Normalized phone key   │  │   → setActive() → setDisconnected()   │   │
│  │ - Three sync outcomes    │  │ - onShowIncomingCallUi()               │   │
│  └──────────────────────────┘  │ - Notification + fullScreenIntent     │   │
│                                └───────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ IncomingCallActivity     │  │ ActiveCallActivity                     │   │
│  │ - showWhenLocked=true    │  │ - Call controls (mute, hold, speaker) │   │
│  │ - turnScreenOn=true      │  │ - CallStatePersistence                │   │
│  │ - Ringtone + vibration   │  │ - Lifecycle observer (background)     │   │
│  │ - Org switch handling    │  │ - BluetoothAudioManager integration   │   │
│  │ - Answer/reject actions  │  │ - AudioDiagnostics integration        │   │
│  │ - Display info receiver  │  │ - Call quality monitoring              │   │
│  └──────────────────────────┘  │ - DTMF / keypad support               │   │
│                                └───────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ BluetoothAudioManager    │  │ AudioDiagnostics                      │   │
│  │ - SCO routing            │  │ - AudioFocusRequest management        │   │
│  │ - Headset detection      │  │ - Focus gain/loss tracking            │   │
│  │ - BroadcastReceiver      │  │ - Audio state logging                 │   │
│  │ - Fallback routing       │  │ - Post-call reset                     │   │
│  └──────────────────────────┘  └───────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ CrashRecoveryManager     │  │ OrgSwitchHelper                       │   │
│  │ - checkAndRecover()      │  │ - switchOrgAndGetCredentials()         │   │
│  │ - CallStatePersistence   │  │ - Cookie-based API call               │   │
│  │ - Recovery notification  │  │ - Credential regeneration             │   │
│  │ - Orphan cleanup         │  │ - ProfileManager update               │   │
│  └──────────────────────────┘  └───────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ MissedCallNotification   │  │ CallForegroundService                  │   │
│  │ Manager                  │  │ (Telnyx Common, :call_service process) │   │
│  │ - Badge counting         │  │ - phoneCall|microphone FGS type        │   │
│  │ - Notification channel   │  │ - Three-tier startForeground fallback │   │
│  │ - Inbox deep link        │  │ - START_STICKY restart policy          │   │
│  └──────────────────────────┘  └───────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ VoipLogger               │  │ VoipAnalytics                          │   │
│  │ - Structured logging     │  │ - Firebase Analytics events            │   │
│  │ - Section markers        │  │ - voip_ event prefix                   │   │
│  │ - Call state transitions │  │ - Push timing, call lifecycle          │   │
│  │ - Noisy SDK tag filter   │  │ - Org switch tracking                  │   │
│  └──────────────────────────┘  └───────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────┐  ┌───────────────────────────────────────┐   │
│  │ TokenHolder              │  │ ProfileManager                         │   │
│  │ - FCM token management   │  │ (Telnyx Common)                       │   │
│  │ - Retry on failure       │  │ - SIP credential storage               │   │
│  │ - Token refresh handling │  │ - Login state tracking                 │   │
│  └──────────────────────────┘  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TELNYX SDK LAYER                                     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ TelnyxClient (Verto JSON-RPC over WebSocket)                        │   │
│  │ - wss://rtc.telnyx.com:443 connection                               │   │
│  │ - SIP registration (gateway: UNREGED → TRYING → REGISTER → REGED)  │   │
│  │ - Call signaling (INVITE, BYE, CANCEL)                              │   │
│  │ - WebRTC media (SRTP/DTLS, ICE, STUN/TURN)                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Layer Boundaries

| Layer | Responsibility | Can Access | Cannot Access |
|-------|---------------|------------|---------------|
| **Capacitor WebView** | React UI, user navigation, non-VoIP features | Capacitor Bridge (via `registerPlugin`) | Native classes directly |
| **Native Bridge** | Command translation, event forwarding, permission management | TelnyxViewModel, Z360VoipStore | Activities directly (launches via Intent) |
| **Native VoIP Core** | Call lifecycle, push handling, audio, notifications, system integration | All native components, SDK | WebView (except via `notifyListeners`) |
| **Telnyx SDK** | WebRTC signaling, media, SIP registration | Network (WebSocket, ICE) | Z360-specific logic |

---

## 3. Component Responsibilities

### 3.1 Responsibility Matrix

Each class has ONE primary responsibility. This prevents the "god class" problem.

| Component | Primary Responsibility | Secondary | File | Lines |
|-----------|----------------------|-----------|------|-------|
| **TelnyxVoipPlugin** | Capacitor bridge: routes JS commands to native, forwards events to JS | Permission management, PhoneAccount registration | `voip/TelnyxVoipPlugin.kt` | ~789 |
| **TelnyxViewModelProvider** | Singleton access to shared TelnyxViewModel | None | `voip/TelnyxViewModelProvider.kt` | ~28 |
| **Z360VoipStore** | Persists Z360 metadata (org context, call display info) | Phone number normalization | `voip/Z360VoipStore.kt` | ~324 |
| **Z360FirebaseMessagingService** | FCM push processing, dual-push routing | SDK reconnection, login gating | `fcm/Z360FirebaseMessagingService.kt` | ~614 |
| **PushSynchronizer** | Correlates Z360 + Telnyx pushes with timeout | None | `fcm/PushSynchronizer.kt` | ~299 |
| **TokenHolder** | FCM token lifecycle (obtain, refresh, persist) | None | `fcm/TokenHolder.kt` | ~267 |
| **Z360ConnectionService** | Android Telecom framework integration | PhoneAccount registration | `voip/Z360ConnectionService.kt` | ~162 |
| **Z360Connection** | Single call's Telecom framework lifecycle | Incoming call notification | `voip/Z360Connection.kt` | ~212 |
| **IncomingCallActivity** | Incoming call UI (answer/reject, lock screen) | Org switch initiation, ringtone | `voip/IncomingCallActivity.kt` | ~925 |
| **ActiveCallActivity** | Active call UI (controls, quality, timer) | Audio routing coordination | `voip/ActiveCallActivity.kt` | ~1387 |
| **BluetoothAudioManager** | Bluetooth SCO audio routing | Headset connection detection | `voip/BluetoothAudioManager.kt` | ~422 |
| **AudioDiagnostics** | Audio focus management, state logging | None | `voip/AudioDiagnostics.kt` | ~385 |
| **CallStatePersistence** | Persists active call state for crash recovery | None | `voip/CallStatePersistence.kt` | ~205 |
| **CrashRecoveryManager** | Detects and recovers from abandoned calls | Recovery notification | `voip/CrashRecoveryManager.kt` | ~195 |
| **OrgSwitchHelper** | Backend API call for org switching during calls | None | `voip/OrgSwitchHelper.kt` | ~137 |
| **MissedCallNotificationManager** | Missed call notifications with badge count | None | `voip/MissedCallNotificationManager.kt` | ~274 |
| **CallTimerManager** | Call duration tracking and broadcasting | None | `voip/CallTimerManager.kt` | ~163 |
| **VoipLogger** | Structured logging with sections and call state | SDK noise filtering | `voip/VoipLogger.kt` | ~640 |
| **VoipAnalytics** | Firebase Analytics events for VoIP lifecycle | None | `voip/VoipAnalytics.kt` | ~847 |
| **VoipPerformance** | Performance metric collection | None | `voip/VoipPerformance.kt` | ~294 |
| **VoipRemoteConfig** | Firebase Remote Config for feature flags | None | `voip/VoipRemoteConfig.kt` | ~245 |
| **CrashlyticsHelper** | Structured Crashlytics reporting | None | `voip/CrashlyticsHelper.kt` | ~353 |
| **PhoneNumberFormatter** | US phone number formatting for display | None | `voip/PhoneNumberFormatter.kt` | ~40 |

### 3.2 Dependency Rules

These rules prevent circular dependencies and ensure testability:

```
RULE 1: Activities depend on TelnyxViewModel + Z360VoipStore + system managers.
        Activities do NOT depend on each other.

RULE 2: Z360FirebaseMessagingService depends on PushSynchronizer + Z360VoipStore +
        TelnyxViewModelProvider + Z360ConnectionService.
        It does NOT depend on Activities (launches them via Intent).

RULE 3: TelnyxVoipPlugin depends on TelnyxViewModel + Z360VoipStore.
        It does NOT depend on Activities (except for notifyListeners events).

RULE 4: PushSynchronizer depends only on Z360VoipStore.
        It is a pure coordination utility with no platform dependencies.

RULE 5: Z360ConnectionService depends on Z360Connection.
        Z360Connection depends on nothing except Android framework classes.

RULE 6: BluetoothAudioManager and AudioDiagnostics are standalone utilities.
        They depend only on Android framework classes.

RULE 7: VoipLogger and VoipAnalytics are cross-cutting concerns.
        Any component may use them, but they depend on nothing else.
```

```
┌─────────────────────────────────────────┐
│           Dependency Direction           │
│                                          │
│  TelnyxVoipPlugin ──┐                   │
│                      ▼                   │
│  FCM Service ──► TelnyxViewModel ◄── Activities
│      │                                   │
│      ▼                                   │
│  PushSynchronizer ──► Z360VoipStore ◄────┘
│      │                                   │
│      ▼                                   │
│  ConnectionService ──► Z360Connection    │
│                                          │
│  BluetoothAudioManager  (standalone)     │
│  AudioDiagnostics       (standalone)     │
│  CallStatePersistence   (standalone)     │
│  VoipLogger / VoipAnalytics (cross-cut) │
└─────────────────────────────────────────┘
```

---

## 4. Initialization Sequence

### 4.1 Normal App Launch (User Opens App)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Step │ Component                │ Action                             │
├──────┼──────────────────────────┼────────────────────────────────────┤
│  1   │ MainActivity.onCreate()  │ installSplashScreen()              │
│  2   │ MainActivity             │ registerPlugin(TelnyxVoipPlugin)   │
│  3   │ MainActivity             │ super.onCreate() → WebView starts  │
│  4   │ TelnyxVoipPlugin.load()  │ VoipLogger.init(context)           │
│  5   │ TelnyxVoipPlugin.load()  │ TokenHolder.initialize(context)    │
│  6   │ TelnyxVoipPlugin.load()  │ ConnectionService.registerPhone()  │
│  7   │ TelnyxVoipPlugin.load()  │ startObservingTelnyx()             │
│  8   │ MainActivity             │ CrashRecoveryManager.check()       │
│  9   │ MainActivity             │ handleNotificationIntent(intent)   │
│ 10   │ WebView                  │ React SPA loads                    │
│ 11   │ useTelnyxVoip            │ TelnyxVoip.connect(credentials)    │
│ 12   │ TelnyxVoipPlugin         │ telnyxViewModel.connect(...)       │
│ 13   │ TelnyxViewModel          │ WebSocket → wss://rtc.telnyx.com   │
│ 14   │ TelnyxViewModel          │ Verto login → sessionsState = REGED│
│ 15   │ TelnyxVoipPlugin         │ notifyListeners("connected")       │
└──────┴──────────────────────────┴────────────────────────────────────┘
```

**Design decision**: Plugin registration happens BEFORE `super.onCreate()` (step 2) so that the plugin is available as soon as the WebView bridge is initialized. The `startObservingTelnyx()` call in `load()` (step 7) sets up `uiState` collection before any calls arrive.

**Justification**: The Telnyx demo initializes its ViewModel in the Activity's `onCreate()`. Z360 uses `TelnyxViewModelProvider` for a shared instance across Activities + Plugin, which is the correct pattern for a Capacitor hybrid app where multiple components need SDK access.

### 4.2 Push Wake from Killed State (Cold Start)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Step │ Component                │ Action                             │
├──────┼──────────────────────────┼────────────────────────────────────┤
│  1   │ Android OS               │ FCM high-priority wakes process    │
│  2   │ FCM Service.onCreate()   │ Record serviceCreationTime (US-013)│
│  3   │ FCM Service              │ onMessageReceived(message)         │
│  4   │ FCM Service              │ isUserLoggedIn() check (US-014)    │
│  5   │ FCM Service              │ Route: Z360 push or Telnyx push    │
│  6   │ FCM Service              │ ensureTelnyxSdkConnected() (5s TO) │
│  7   │ TelnyxViewModel          │ credentialLogin(pushMetaData)      │
│  8   │ FCM Service              │ showIncomingCallNotification()     │
│  9   │ ConnectionService        │ addNewIncomingCall(extras)         │
│ 10   │ ConnectionService        │ onCreateIncomingConnection()       │
│ 11   │ Z360Connection           │ setRinging()                       │
│ 12   │ Z360Connection           │ onShowIncomingCallUi()             │
│ 13   │ Z360Connection           │ Post fullScreenIntent notification │
│ 14   │ IncomingCallActivity     │ Launches (showWhenLocked=true)     │
│ 15   │ ── PARALLEL ──           │ WebView/MainActivity NOT involved  │
└──────┴──────────────────────────┴────────────────────────────────────┘
```

**Critical timing constraint**: Steps 1-14 must complete within **10 seconds** of FCM delivery (Android OS requirement). The `ensureTelnyxSdkConnected()` timeout of 5 seconds (step 6) leaves ~5 seconds for the remaining steps.

**Design decision**: The push path does NOT wait for or depend on WebView loading. `IncomingCallActivity` launches directly from the native notification. If the user answers, `ActiveCallActivity` launches independently. Only after these native paths complete does `MainActivity` (with WebView) potentially load.

**Justification**: This mirrors the Capacitor architecture doc's §7 insight: "THE WEBVIEW MAY NOT EVEN EXIST DURING STEPS 1-6." The iOS platform solves this similarly with PushKit → CallKit → native UI, deferring WebView load.

### 4.3 Answer from Killed State (Complex Flow)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Step │ Component                │ Action                             │
├──────┼──────────────────────────┼────────────────────────────────────┤
│  1   │ IncomingCallActivity     │ User taps "Answer"                 │
│  2   │ IncomingCallActivity     │ AtomicBoolean.compareAndSet (BUG5) │
│  3   │ IncomingCallActivity     │ If switchOrg → org switch flow     │
│  3a  │ OrgSwitchHelper          │ switchOrgAndGetCredentials(orgId)  │
│  3b  │ ProfileManager           │ saveProfile(new credentials)       │
│  3c  │ Z360VoipStore            │ setCurrentOrganization(orgId)      │
│  4   │ IncomingCallActivity     │ telnyxViewModel.answerCall()       │
│  5   │ IncomingCallActivity     │ Launch ActiveCallActivity          │
│  6   │ ActiveCallActivity       │ callStatePersistence.saveCall()    │
│  7   │ ActiveCallActivity       │ observeCallState(uiState)         │
│  8   │ CallForegroundService    │ startService() (separate process)  │
│  9   │ Z360Connection           │ setActive()                        │
│ 10   │ AudioDiagnostics         │ requestAudioFocus()                │
│ 11   │ BluetoothAudioManager    │ onCallStarted()                    │
│ 12   │ ── IN PARALLEL ──        │ MainActivity may start (WebView)   │
└──────┴──────────────────────────┴────────────────────────────────────┘
```

**Design decision**: Step 3 (org switch) happens BEFORE answering the call. This is critical because answering a call for a different organization requires fresh SIP credentials for that org. The Telnyx SDK needs to reconnect with the new credentials before it can accept the SIP INVITE.

**Justification**: The Z360 backend uses per-org SIP credentials (Telnyx reference §2.5: "A user in N organizations has N separate org-level credentials"). Answering with wrong-org credentials would fail.

---

## 5. Call State Machine

### 5.1 State Definitions

| State | Description | Entry Condition | Persisted? |
|-------|-------------|-----------------|------------|
| `IDLE` | No active call, SDK may or may not be connected | Initial state; after call ends | No |
| `RINGING_INBOUND` | Push received, native call UI shown, waiting for user action | FCM push processed, ConnectionService created | No (transient) |
| `RINGING_OUTBOUND` | Outbound call initiated, remote party ringing | `sendInvite()` succeeded, SDK reports `RINGING` | No (transient) |
| `CONNECTING` | User answered (inbound) or call initiated (outbound), WebRTC negotiating | User taps answer / `sendInvite()` called | No (transient) |
| `ACTIVE` | Media flowing, call in progress | WebRTC connected, SDK reports `ACTIVE` | **Yes** (CallStatePersistence) |
| `ON_HOLD` | Call placed on hold by local user | User taps hold | Yes |
| `RECONNECTING` | Network drop detected, SDK attempting to recover | Network transition, WebSocket drop | Yes (preserves ACTIVE state) |
| `DISCONNECTING` | Hangup initiated, waiting for SDK confirmation | User taps end / remote hangup received | Yes (transitional) |
| `ENDED` | Call terminated normally | SDK reports `DONE(reason)` | Cleared |
| `FAILED` | Call could not be established or was interrupted | SDK reports `ERROR` / timeout | Cleared |

### 5.2 State Machine Diagram

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    ▼                                         │
              ┌──────────┐                                    │
              │          │                                    │
        ┌────►│   IDLE   │◄───────────────────────┐          │
        │     │          │                         │          │
        │     └────┬─────┘                         │          │
        │          │                               │          │
        │    ┌─────┴──────┐                        │          │
        │    │            │                        │          │
        │    ▼            ▼                        │          │
        │  FCM Push    makeCall()                  │          │
        │    │            │                        │          │
        │    ▼            ▼                        │          │
        │ ┌────────────┐ ┌────────────────┐       │          │
        │ │  RINGING_   │ │   RINGING_     │       │          │
        │ │  INBOUND    │ │   OUTBOUND     │       │          │
        │ └──┬───┬──────┘ └───┬───┬────────┘       │          │
        │    │   │            │   │                │          │
        │    │   │ reject/    │   │ cancel/        │          │
        │    │   │ timeout    │   │ remote busy    │          │
        │    │   │            │   │                │          │
        │    │   ▼            │   ▼                │          │
        │    │ ┌────────┐    │ ┌────────┐          │          │
        │    │ │ ENDED/ │    │ │ ENDED/ │          │          │
        │    │ │ FAILED │────┘ │ FAILED │──────────┘          │
        │    │ └────────┘      └────────┘                     │
        │    │                                                │
        │    │ answer()       remote answers                  │
        │    │                    │                            │
        │    ▼                    ▼                            │
        │ ┌──────────────────────────┐                        │
        │ │       CONNECTING         │                        │
        │ │  (WebRTC negotiating)    │                        │
        │ └──────────┬───────────────┘                        │
        │            │                                        │
        │            │ timeout / ICE failure                   │
        │            ├─────────────────────────► FAILED ──────┤
        │            │                                        │
        │            │ media connected                        │
        │            ▼                                        │
        │ ┌──────────────────────────┐                        │
        │ │         ACTIVE           │◄──────────────────┐    │
        │ │  (media flowing, call    │                   │    │
        │ │   state persisted)       │                   │    │
        │ └──┬───────────┬──────┬───┘                    │    │
        │    │           │      │                        │    │
        │    │ hold()    │      │ network drop           │    │
        │    ▼           │      ▼                        │    │
        │ ┌──────────┐  │   ┌──────────────┐             │    │
        │ │ ON_HOLD  │  │   │ RECONNECTING │             │    │
        │ │          │  │   │ (60s timeout) │             │    │
        │ └────┬─────┘  │   └───┬──────┬───┘             │    │
        │      │        │       │      │                  │    │
        │      │unhold  │       │      │ timeout          │    │
        │      │        │       │ ok   │                  │    │
        │      ▼        │       ▼      ▼                  │    │
        │      └────────┼──► ACTIVE    ENDED/FAILED ──────┤    │
        │               │                                 │    │
        │               │ hangup (local or remote)        │    │
        │               ▼                                 │    │
        │       ┌───────────────┐                         │    │
        │       │ DISCONNECTING │                         │    │
        │       │ (5s timeout)  │                         │    │
        │       └───────┬───────┘                         │    │
        │               │                                 │    │
        │               │ SDK confirms / timeout          │    │
        │               ▼                                 │    │
        │        ┌──────────┐                             │    │
        │        │  ENDED   │─────────────────────────────┘    │
        │        └──────────┘                                  │
        │                                                      │
        └──────────────── Crash Recovery ──────────────────────┘
```

### 5.3 State Transition Table

| Current State | Trigger | Next State | Actions |
|---------------|---------|------------|---------|
| IDLE | FCM push (inbound) | RINGING_INBOUND | ConnectionService.addIncomingCall(), show notification, launch IncomingCallActivity |
| IDLE | makeCall() (outbound) | RINGING_OUTBOUND | SDK.sendInvite(), launch ActiveCallActivity, start FGS |
| RINGING_INBOUND | User answers | CONNECTING | SDK.answerCall(), org switch if needed, launch ActiveCallActivity |
| RINGING_INBOUND | User rejects | ENDED | SDK.rejectCall(), Z360Connection.notifyRejected(), cleanup |
| RINGING_INBOUND | Timeout (30s) | ENDED | Auto-dismiss, show missed call notification |
| RINGING_INBOUND | Remote cancel | ENDED | Dismiss UI, show missed call notification |
| RINGING_OUTBOUND | Remote answers | CONNECTING → ACTIVE | Start timer, persist state, request audio focus |
| RINGING_OUTBOUND | User cancels | ENDED | SDK.endCall(), cleanup |
| RINGING_OUTBOUND | Remote busy/reject | FAILED | Show failure toast, cleanup |
| CONNECTING | WebRTC connected | ACTIVE | Start timer, persist call state, begin audio routing |
| CONNECTING | Timeout (30s) | FAILED | Show error, cleanup |
| ACTIVE | User hangs up | DISCONNECTING | SDK.endCall(), start 5s safety timeout |
| ACTIVE | Remote hangs up | ENDED | Stop timer, release audio, cleanup |
| ACTIVE | User holds | ON_HOLD | SDK.holdCall() |
| ACTIVE | Network drop | RECONNECTING | SDK auto-reconnect (60s timeout, 3 retries) |
| ON_HOLD | User unholds | ACTIVE | SDK.unholdCall() |
| RECONNECTING | Reconnected | ACTIVE | Resume media, log recovery |
| RECONNECTING | Timeout (60s) | FAILED | Cleanup, show notification |
| DISCONNECTING | SDK confirms | ENDED | Cleanup resources |
| DISCONNECTING | Safety timeout (5s) | ENDED | Force cleanup |
| ANY (persisted) | App crash → restart | IDLE | CrashRecoveryManager detects, shows notification, cleans up |

### 5.4 State Observation Pattern

The target architecture uses **reactive state observation**, not imperative state checks:

```kotlin
// TARGET PATTERN: Activities observe TelnyxViewModel.uiState as a StateFlow
// This is the Telnyx SDK's own pattern (TelnyxViewModel exposes uiState: StateFlow)
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        telnyxViewModel.uiState.collect { event ->
            when (event) {
                is OnCallAnswered -> transitionTo(ACTIVE)
                is OnCallEnded -> transitionTo(ENDED)
                is OnCallDropped -> transitionTo(RECONNECTING)
                // ... exhaustive handling
            }
        }
    }
}
```

**Justification**: The Telnyx Android SDK exposes `uiState` as a Kotlin `StateFlow`, which is the recommended pattern for UI state observation. The demo app uses this exact pattern. Z360 correctly follows it via `TelnyxViewModelProvider.get()`.

---

## 6. Inbound Call: Push Handling Flow

### 6.1 Dual-Push Architecture

Z360 receives **two independent FCM pushes** for each inbound call:

```
┌──────────────┐          ┌──────────────┐
│ Z360 Backend │          │ Telnyx       │
│ (Laravel)    │          │ Platform     │
└──────┬───────┘          └──────┬───────┘
       │                         │
       │ FCM Push #1             │ FCM Push #2
       │ (caller info)           │ (call control)
       │                         │
       │ Payload:                │ Payload:
       │ - caller_name           │ - metadata (JSON)
       │ - caller_number         │   - call_id
       │ - avatar_url            │   - sip_headers
       │ - organization_id       │   - signaling_server
       │ - organization_name     │ - message (MISSED_CALL flag)
       │ - call_id               │
       │ - channel_number        │
       │                         │
       ▼                         ▼
┌──────────────────────────────────────┐
│   Z360FirebaseMessagingService       │
│   onMessageReceived(message)         │
│                                      │
│   Routing logic:                     │
│   if (data["type"] == "call_ended")  │
│     → Dismiss everything             │
│   elif (metadata JSON present)       │
│     → handleTelnyxMetadataPush()     │
│   else                               │
│     → handleZ360CallerInfoPush()     │
└──────────────────────────────────────┘
```

### 6.2 Push Synchronization Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    PushSynchronizer                              │
│                                                                  │
│  SCENARIO A: Z360 push arrives FIRST                            │
│  ────────────────────────────────────                           │
│  1. handleZ360CallerInfoPush()                                  │
│  2. Save display info to Z360VoipStore                          │
│  3. Broadcast ACTION_CALL_DISPLAY_INFO_UPDATED                  │
│  4. Complete pending deferred (if Telnyx waiting)               │
│                                                                  │
│  Later, when Telnyx push arrives:                               │
│  5. handleTelnyxMetadataPush()                                  │
│  6. PushSynchronizer.waitForZ360Data(callId, callerNumber)      │
│  7. Store already has data → IMMEDIATE sync (0ms wait)          │
│  8. Proceed to showIncomingCallNotification()                   │
│                                                                  │
│  ─────────────────────────────────────────────────              │
│                                                                  │
│  SCENARIO B: Telnyx push arrives FIRST                          │
│  ─────────────────────────────────────                          │
│  1. handleTelnyxMetadataPush()                                  │
│  2. PushSynchronizer.waitForZ360Data(callId, callerNumber)      │
│  3. Creates CompletableDeferred, waits up to 500ms              │
│  4. showIncomingCallNotification() with partial data             │
│                                                                  │
│  Later, when Z360 push arrives (within 500ms):                  │
│  5. handleZ360CallerInfoPush()                                  │
│  6. Completes deferred → LATE_Z360 sync                         │
│  7. Broadcast updates IncomingCallActivity UI                   │
│                                                                  │
│  ─────────────────────────────────────────────────              │
│                                                                  │
│  SCENARIO C: Only Telnyx push arrives (Z360 push lost/late)     │
│  ─────────────────────────────────────────────────              │
│  1. handleTelnyxMetadataPush()                                  │
│  2. PushSynchronizer.waitForZ360Data() → 500ms timeout          │
│  3. Proceed with Telnyx-only data (phone number, no name/avatar)│
│  4. IncomingCallActivity shows number only                      │
│                                                                  │
│  Correlation key: normalized phone number (last 10 digits)      │
│  Timeout: 500ms (generous — typical push latency is 50-200ms)   │
└─────────────────────────────────────────────────────────────────┘
```

**Design decision**: Use normalized phone number (last 10 digits) as the correlation key, NOT call ID. This is because Z360 backend assigns a different call ID than Telnyx platform.

**Justification**: Telnyx reference §5.3 notes "Z360 push payloads differ from SDK `PushMetaData` format." The phone number is the only reliable correlation point between the two independent pushes.

### 6.3 Complete Inbound Call Sequence

```
Z360 Backend    Telnyx        FCM        FCM Service    PushSync    ConnSvc     Z360Conn    IncomingAct
    │            │             │              │            │           │            │            │
    │ ── Push #1 (caller info) ──►           │            │           │            │            │
    │            │             │ ──deliver──► │            │           │            │            │
    │            │             │              │──check     │           │            │            │
    │            │             │              │  login     │           │            │            │
    │            │             │              │──store──►  │           │            │            │
    │            │             │              │  display   │           │            │            │
    │            │             │              │  info      │           │            │            │
    │            │             │              │            │           │            │            │
    │ ── Push #2 (Telnyx metadata) ──►       │            │           │            │            │
    │            │             │ ──deliver──► │            │           │            │            │
    │            │             │              │──ensure    │           │            │            │
    │            │             │              │  SDK conn  │           │            │            │
    │            │             │              │──wait──────►           │            │            │
    │            │             │              │  for Z360  │           │            │            │
    │            │             │              │  (already  │           │            │            │
    │            │             │              │   there!)  │           │            │            │
    │            │             │              │◄─IMMEDIATE─│           │            │            │
    │            │             │              │            │           │            │            │
    │            │             │              │──addIncoming──────────►│            │            │
    │            │             │              │  Call()    │           │            │            │
    │            │             │              │            │           │──create──► │            │
    │            │             │              │            │           │  Incoming  │            │
    │            │             │              │            │           │  Connection│            │
    │            │             │              │            │           │            │──setRing──►│
    │            │             │              │            │           │            │  show UI   │
    │            │             │              │            │           │            │            │
```

### 6.4 Fallback Paths

The target architecture defines three fallback tiers for showing the incoming call UI:

| Tier | Method | When Used | Limitations |
|------|--------|-----------|-------------|
| **Primary** | TelecomManager.addNewIncomingCall() → ConnectionService | API 23+, PhoneAccount registered | May fail on some OEMs |
| **Secondary** | Telnyx SDK's CallNotificationService.showIncomingCallNotification() | ConnectionService fails | No lock screen integration |
| **Tertiary** | Direct IncomingCallActivity.start() launch | Both above fail | Most limited, but guaranteed |

**Design decision**: Three-tier fallback ensures the user always sees the incoming call, even on problematic devices.

**Justification**: Android platform requirements doc §1 notes that TelecomManager can fail (`onCreateIncomingConnectionFailed` fires on some OEMs). The current Z360 implementation already has this three-tier fallback at FCM Service lines 1140-1167.

---

## 7. Outbound Call Flow

### 7.1 Sequence

```
React SPA         Capacitor Bridge      TelnyxVoipPlugin       TelnyxViewModel      SDK           ActiveCallAct
    │                    │                    │                      │                │                │
    │ makeCall(number)   │                    │                      │                │                │
    │───────────────────►│                    │                      │                │                │
    │                    │ PluginCall         │                      │                │                │
    │                    │──────────────────► │                      │                │                │
    │                    │                    │──sendInvite(number)──►│                │                │
    │                    │                    │                      │──INVITE──────► │                │
    │                    │                    │                      │                │──Verto──►      │
    │                    │                    │                      │                │  signaling     │
    │                    │                    │                      │                │                │
    │                    │                    │◄─callStarted event───│                │                │
    │                    │                    │──notifyListeners──►  │                │                │
    │                    │◄───callStarted─────│  ("callStarted")     │                │                │
    │◄──event────────────│                    │                      │                │                │
    │                    │                    │                      │                │                │
    │                    │                    │── Launch ─────────────────────────────────────────────►│
    │                    │                    │  ActiveCallActivity   │                │                │
    │                    │                    │  via Intent           │                │                │
    │                    │                    │                      │                │                │
    │                    │                    │                      │◄─RINGING───────│                │
    │                    │                    │◄─callRinging event───│                │                │
    │                    │                    │──notifyListeners──►  │                │                │
    │◄──event────────────│                    │                      │                │                │
    │                    │                    │                      │                │                │
    │                    │                    │                      │◄─ACTIVE────────│                │
    │                    │                    │◄─callAnswered event──│                │                │
    │                    │                    │                      │                │             ┌──┤
    │                    │                    │                      │                │             │  │
    │                    │                    │                      │                │  observe    │  │
    │                    │                    │                      │                │  uiState    │  │
    │                    │                    │                      │                │             │  │
    │                    │                    │                      │                │  ACTIVE ────┘  │
    │                    │                    │                      │                │  → Start timer │
    │                    │                    │                      │                │  → Persist     │
    │                    │                    │                      │                │  → Audio focus │
```

### 7.2 Web UI During Active Call

When an outbound call is active from the native layer:

1. **Web UI receives events**: `callStarted`, `callRinging`, `callAnswered`, `callEnded` via `notifyListeners()` → `useTelnyxVoip` hook
2. **Web UI shows status**: The DialpadProvider can show call status indicator
3. **Call controls**: Can be sent from either web (via Capacitor bridge) or native ActiveCallActivity
4. **No web WebRTC**: The `NativeVoipProvider` replaces `TelnyxRTCProvider` on native platforms, preventing dual WebSocket connections

**Design decision**: The native `ActiveCallActivity` is the primary call control surface. The web UI shows status but delegates controls to native.

**Justification**: This prevents WebView-native state conflicts. Audio routing, Bluetooth, and system integration are all native. Having two control surfaces (web + native) for the same call creates race conditions.

---

## 8. Platform Isolation: Native VoIP vs Web WebRTC

### 8.1 Isolation Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        ISOLATION MECHANISM                          │
│                                                                    │
│  ┌──────────────────────────┐  ┌──────────────────────────────┐   │
│  │ Web Platform (Browser)   │  │ Native Platform (Capacitor)  │   │
│  │                          │  │                              │   │
│  │ ┌────────────────────┐   │  │ ┌──────────────────────────┐ │   │
│  │ │ TelnyxRTCProvider  │   │  │ │ NativeVoipProvider       │ │   │
│  │ │ @telnyx/react-client│  │  │ │ (replaces TelnyxRTC)     │ │   │
│  │ │ WebRTC in browser  │   │  │ │ Uses Capacitor bridge    │ │   │
│  │ └────────────────────┘   │  │ │ to native TelnyxVoip     │ │   │
│  │                          │  │ └──────────────────────────┘ │   │
│  │ Handles: signaling,     │  │                              │   │
│  │ media, call state       │  │ Native handles: signaling,   │   │
│  │ all in JS               │  │ media, call state all in     │   │
│  │                          │  │ native Kotlin via Telnyx SDK │   │
│  └──────────────────────────┘  └──────────────────────────────┘   │
│                                                                    │
│  DETECTION:                                                        │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ if (Capacitor.isNativePlatform())                            │  │
│  │   → NativeVoipProvider (Capacitor bridge to native SDK)      │  │
│  │ else                                                         │  │
│  │   → TelnyxRTCProvider (WebRTC in browser, @telnyx/react)     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 8.2 Why Isolation Is Critical

| Problem | Without Isolation | With Isolation |
|---------|-------------------|----------------|
| Dual WebSocket | WebView's `@telnyx/react-client` AND native Telnyx SDK both connect → SIP registration conflict (newer displaces older) | Only native SDK connects; web uses stub `TelnyxVoipWeb` |
| Audio conflict | Browser WebRTC audio AND native audio both request audio focus → garbled audio | Only native manages audio via AudioManager/ConnectionService |
| Push handling | Both layers try to handle incoming calls | Native handles exclusively; web receives status events only |
| State divergence | Web and native have independent call state → UI inconsistency | Single source of truth in native; web observes via events |

### 8.3 BUG-003 Prevention

```kotlin
// In TelnyxVoipPlugin.connect():
// When WebView loads and React calls TelnyxVoip.connect(), check if native
// SDK is already connected (from push wake flow). If so, skip reconnection.
if (currentState is TelnyxSessionState.ClientLoggedIn) {
    VoipLogger.d(LOG_COMPONENT, "Already connected, skipping reconnect")
    call.resolve(JSObject().put("status", "already_connected"))
    return
}
```

**Design decision**: The `connect()` method is idempotent. If the SDK is already connected (e.g., from push wake), it returns success without reconnecting.

**Justification**: BUG-003 was caused by WebView's `connect()` killing the native SDK socket established during push flow. The fix ensures the native connection is preserved.

---

## 9. Audio Routing

### 9.1 Audio Component Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  AUDIO ROUTING STACK                      │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ ActiveCallActivity (UI controls)                     │ │
│  │ - Speaker toggle button                              │ │
│  │ - Bluetooth indicator                                │ │
│  │ - Audio route selection                              │ │
│  └──────────────┬────────────────────┬─────────────────┘ │
│                 │                    │                     │
│                 ▼                    ▼                     │
│  ┌──────────────────────┐  ┌────────────────────────────┐ │
│  │ AudioDiagnostics     │  │ BluetoothAudioManager      │ │
│  │ (Focus + Routing)    │  │ (BT SCO + Headset)         │ │
│  │                      │  │                            │ │
│  │ requestAudioFocus()  │  │ onCallStarted()            │ │
│  │ - USAGE_VOICE_COMM   │  │ - Start SCO if headset     │ │
│  │ - GAIN_TRANSIENT_EX  │  │ - Register receiver        │ │
│  │ - Store request obj  │  │                            │ │
│  │                      │  │ onCallEnded()              │ │
│  │ resetAfterCall()     │  │ - Stop SCO                 │ │
│  │ - Abandon focus      │  │ - Unregister receiver      │ │
│  │ - Reset speaker      │  │ - Clear communication dev  │ │
│  │ - Clear comm device  │  │                            │ │
│  │                      │  │ BroadcastReceiver:         │ │
│  │ logAudioState()      │  │ - BT_SCO_STATE_CHANGED     │ │
│  │ - All device info    │  │ - ACL_CONNECTED/DISCONN    │ │
│  │ - Audio mode/focus   │  │ - Fallback to speaker      │ │
│  └──────────────────────┘  └────────────────────────────┘ │
│                 │                    │                     │
│                 ▼                    ▼                     │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Android AudioManager                                  │ │
│  │                                                       │ │
│  │ Modern (API 31+):                                     │ │
│  │   setCommunicationDevice(device)                      │ │
│  │   getAvailableCommunicationDevices()                  │ │
│  │   clearCommunicationDevice()                          │ │
│  │                                                       │ │
│  │ Legacy (pre-API 31):                                  │ │
│  │   setSpeakerphoneOn(true/false)                       │ │
│  │   startBluetoothSco() / stopBluetoothSco()           │ │
│  │   setMode(MODE_IN_COMMUNICATION)                      │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ ConnectionService Audio Integration                   │ │
│  │ - Self-managed PhoneAccount routes audio events       │ │
│  │ - System handles BT answer/reject buttons            │ │
│  │ - Car head unit integration automatic                 │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 Audio Route Priority

| Priority | Device Type | Detection | Routing Method |
|----------|-------------|-----------|----------------|
| 1 (highest) | Bluetooth headset/earbuds | BluetoothAudioManager receiver | SCO audio (legacy) or `setCommunicationDevice` (API 31+) |
| 2 | Wired headset | AudioManager `getDevices(GET_DEVICES_OUTPUTS)` | Automatic routing by AudioManager |
| 3 | Speaker (user-selected) | User taps speaker button | `setSpeakerphoneOn(true)` or `setCommunicationDevice(speaker)` |
| 4 (default) | Earpiece | Default for voice calls | `setSpeakerphoneOn(false)` or `setCommunicationDevice(earpiece)` |

### 9.3 Audio Focus Lifecycle

```
Call starts (ACTIVE state):
  1. AudioDiagnostics.requestAudioFocus()
     - AudioFocusRequest(USAGE_VOICE_COMMUNICATION, AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
     - Store request object in volatile field
     - Register focus change listener
  2. BluetoothAudioManager.onCallStarted()
     - Check for connected BT headset
     - If found: start SCO / setCommunicationDevice
     - Register headset state receiver

During call:
  3. Focus change listener handles:
     - LOSS_TRANSIENT: Log, may pause media
     - LOSS: Log warning (shouldn't happen with EXCLUSIVE)
     - GAIN: Resume normal

Call ends (ENDED state):
  4. AudioDiagnostics.resetAfterCall()
     - abandonAudioFocusRequest(stored request)
     - setSpeakerphoneOn(false)
     - clearCommunicationDevice() (API 31+)
     - setMode(MODE_NORMAL)
  5. BluetoothAudioManager.onCallEnded()
     - stopBluetoothSco()
     - Unregister receivers
```

**Design decision**: Audio focus is requested with `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` to prevent other apps from playing audio during a call.

**Justification**: Android platform requirements doc §61-68 specifies `USAGE_VOICE_COMMUNICATION` for VoIP. The US-008 fix in Z360 stores the `AudioFocusRequest` object for proper abandonment, following the Linphone pattern.

---

## 10. Crash Recovery

### 10.1 What Is Persisted

```
┌──────────────────────────────────────────────────────────────────┐
│                   CallStatePersistence                            │
│                   (SharedPreferences: "call_state_prefs")         │
│                                                                   │
│  PERSISTED DURING ACTIVE/ON_HOLD:                                │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  KEY_CALL_ID           = active_call_id (Telnyx call ID)    │ │
│  │  KEY_CALLER_NUMBER     = caller_number (display number)     │ │
│  │  KEY_CALLER_NAME       = caller_name (display name)         │ │
│  │  KEY_START_TIME        = call_start_time (epoch millis)     │ │
│  │  KEY_CALL_CONTROL_ID   = call_control_id (Telnyx CC ID)    │ │
│  │  KEY_IS_OUTGOING       = is_outgoing (boolean)              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  CLEARED ON:                                                      │
│  - Call ends normally (callStatePersistence.clearActiveCall())    │
│  - Crash recovery completes (CrashRecoveryManager cleans up)    │
│                                                                   │
│  WRITTEN AT:                                                      │
│  - ActiveCallActivity.onCreate() when call state = ACTIVE        │
│  - State transitions that change persisted fields                │
└──────────────────────────────────────────────────────────────────┘
```

### 10.2 Recovery Flow

```
App crash during active call
    │
    ▼
Process killed by OS
    │
    ▼ (Later)
User reopens app / FCM wakes app
    │
    ▼
MainActivity.onCreate()
    │
    ├─► CrashRecoveryManager.checkAndRecoverFromCrash()
    │       │
    │       ├─► CallStatePersistence.checkForAbandonedCall()
    │       │       │
    │       │       ├─ No active call persisted → return false (normal startup)
    │       │       │
    │       │       └─ Active call found → return PersistedCallState
    │       │               (call lasted > 5 seconds AND started > 60 seconds ago)
    │       │
    │       ├─► cleanupOrphanedResources()
    │       │       │
    │       │       ├─ Stop CallForegroundService
    │       │       ├─ Cancel all VoIP notifications
    │       │       └─ Disconnect SDK (if zombie connection)
    │       │
    │       ├─► showRecoveryNotification(abandonedCall)
    │       │       │
    │       │       └─ "Your call with {callerInfo} was disconnected"
    │       │          Channel: z360_crash_recovery (IMPORTANCE_HIGH)
    │       │          Action: Open app
    │       │
    │       └─► CallStatePersistence.clearActiveCall()
    │
    └─► Continue normal startup
```

**Design decision**: Recovery does NOT attempt to reconnect abandoned calls. The other party will have hung up by the time the app recovers.

**Justification**: Current Z360 implementation explicitly states: "We don't attempt to reconnect abandoned calls since the other party will have hung up" (CallStatePersistence line 3420). The recovery is purely informational — notify the user and clean up orphaned resources.

---

## 11. Credential Management

### 11.1 Credential Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   CREDENTIAL LIFECYCLE                            │
│                                                                   │
│  CREATION (Backend → Device):                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  1. WebView authenticates user with Z360 backend             │ │
│  │  2. React calls TelnyxVoip.connect(sipUser, sipPass)        │ │
│  │     OR device registers → backend creates credential         │ │
│  │  3. Backend creates TelephonyCredential on Telnyx            │ │
│  │     via credential connection (per-device, 30-day expiry)    │ │
│  │  4. Backend generates JWT (10-hour TTL) from credential      │ │
│  │  5. Credentials returned to device                           │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  STORAGE (Device):                                               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  ProfileManager (Telnyx Common)                              │ │
│  │  - sipUsername, sipPassword → SharedPreferences               │ │
│  │  - callerIdName, callerIdNumber                              │ │
│  │  - isUserLoggedIn flag                                       │ │
│  │                                                               │ │
│  │  Z360VoipStore (Z360-specific)                               │ │
│  │  - current_org_id, current_org_name                          │ │
│  │  - Per-call metadata (org context, channel)                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  REFRESH:                                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  JWT expires after ~10 hours                                 │ │
│  │  → SDK disconnects → sessionsState changes to disconnected   │ │
│  │  → TelnyxVoipPlugin detects → notifyListeners("disconnected")│ │
│  │  → React triggers re-authentication with backend             │ │
│  │  → New JWT obtained → TelnyxVoip.connect() again             │ │
│  │                                                               │ │
│  │  Credential expires after 30 days                            │ │
│  │  → Backend creates new credential on next device registration│ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ORG SWITCHING:                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  1. Incoming call push includes organization_id              │ │
│  │  2. Compare with Z360VoipStore.getCurrentOrganizationId()    │ │
│  │  3. If different → org switch required before answering      │ │
│  │  4. OrgSwitchHelper.switchOrgAndGetCredentials(orgId)        │ │
│  │     → POST /api/voip/switch-org (with session cookies)       │ │
│  │     → Returns new sipUsername, sipPassword, callerIdName     │ │
│  │  5. ProfileManager.saveProfile(new credentials)              │ │
│  │  6. Z360VoipStore.setCurrentOrganization(newOrgId)           │ │
│  │  7. SDK reconnects with new credentials (if needed)          │ │
│  │  8. Answer the call with correct org credentials             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  CLEANUP:                                                        │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  - Stale devices (7 days inactive) → backend auto-deletes   │ │
│  │  - Logout → ProfileManager clears, isUserLoggedIn = false   │ │
│  │  - Push to logged-out device → silently rejected (US-014)   │ │
│  │  - FCM token refresh → TokenHolder handles re-registration  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 11.2 Org Switch Timing Constraints

| Phase | Max Duration | Action |
|-------|-------------|--------|
| Detect org mismatch | ~0ms | Compare push org_id with stored org_id |
| API call to switch-org | 2-5 seconds | HTTP POST with session cookies |
| Save new credentials | ~10ms | ProfileManager + Z360VoipStore writes |
| SDK reconnect (if needed) | 2-5 seconds | credentialLogin() with new creds |
| Answer call | ~100ms | SDK.answerCall() |
| **Total budget** | **~10 seconds** | Must complete before ring timeout |

**Design decision**: The org switch happens synchronously during the answer flow. If it fails, the answer is aborted and an error is shown.

**Justification**: The Telnyx reference §7.3 constraint: "WebSocket must be connected for calls — Even push-initiated calls require the SDK to establish a WebSocket connection and complete Verto login before the call can be answered."

---

## 12. Analytics & Logging

### 12.1 Structured Logging Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     LOGGING ARCHITECTURE                         │
│                                                                   │
│  VoipLogger (structured, prefixed)                               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  LEVELS:                                                     │ │
│  │    .d(component, message)     - Debug                        │ │
│  │    .i(component, message)     - Info                         │ │
│  │    .w(component, message)     - Warning                      │ │
│  │    .e(component, message)     - Error                        │ │
│  │    .error(comp, action, code, msg, throwable?)               │ │
│  │                                                               │ │
│  │  SPECIAL:                                                     │ │
│  │    .section(title)            - Visual separator in logcat   │ │
│  │    .callState(state, details) - Call state transitions       │ │
│  │    .event(name)               - Lifecycle events             │ │
│  │                                                               │ │
│  │  SDK NOISE FILTER:                                            │ │
│  │    TelnyxLogTree.shouldSuppress(tag, priority)               │ │
│  │    Suppresses VERBOSE/DEBUG from Telnyx SDK prefixes         │ │
│  │    (keeps ERROR and above)                                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  VoipAnalytics (Firebase Analytics events)                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Event Prefix: voip_                                         │ │
│  │                                                               │ │
│  │  CALL LIFECYCLE:                                              │ │
│  │    voip_call_initiated    - direction, callerNumber           │ │
│  │    voip_call_connected    - callId, connectTimeMs             │ │
│  │    voip_call_ended        - callId, durationSec, reason       │ │
│  │    voip_call_failed       - callId, reason, errorCode         │ │
│  │    voip_audio_connected   - callId                            │ │
│  │                                                               │ │
│  │  PUSH ANALYTICS:                                              │ │
│  │    voip_push_received     - pushType, arrivalTimeMs           │ │
│  │    voip_push_sync         - syncType, waitTimeMs              │ │
│  │    voip_push_rejected     - reason (logged_out, busy)         │ │
│  │    voip_push_cold_start   - pushToNotificationMs              │ │
│  │                                                               │ │
│  │  ORG SWITCH:                                                  │ │
│  │    voip_org_switch        - result, durationMs, targetOrg     │ │
│  │                                                               │ │
│  │  AUDIO:                                                       │ │
│  │    voip_audio_route       - device, previousDevice            │ │
│  │    voip_audio_focus       - change (gain/loss)                │ │
│  │                                                               │ │
│  │  ERRORS:                                                      │ │
│  │    voip_error             - component, code, message          │ │
│  │    voip_crash_recovered   - callId, durationSec               │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  CrashlyticsHelper (crash reporting metadata)                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Custom keys set on crash:                                    │ │
│  │    voip_call_active, voip_call_id, voip_call_state           │ │
│  │    voip_sdk_state, voip_org_id, voip_audio_route             │ │
│  │                                                               │ │
│  │  Non-fatal logging:                                           │ │
│  │    CrashlyticsHelper.logNonFatal(component, action, error)   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  VoipPerformance (timing metrics)                                │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Traces:                                                      │ │
│  │    push_to_ring_ms        - FCM arrival → notification shown │ │
│  │    ring_to_answer_ms      - Notification → user answers      │ │
│  │    answer_to_media_ms     - Answer → WebRTC media connected  │ │
│  │    sdk_connect_ms         - credentialLogin → REGED          │ │
│  │    org_switch_ms          - API call → credentials received  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 12.2 Log Points in Call Lifecycle

Every state transition should produce a structured log entry:

| Transition | VoipLogger | VoipAnalytics | CrashlyticsHelper |
|-----------|-----------|--------------|-------------------|
| Push received | `.section("FCM Message Received")` | `logPushReceived()` | Set `voip_call_incoming = true` |
| Push sync complete | `.d("PushSync", "sync completed")` | `logPushSyncCompleted()` | — |
| SDK reconnect start | `.i("FCM", "reconnecting...")` | — | Set `voip_sdk_state = reconnecting` |
| Notification shown | `.callState("RINGING", details)` | `logCallInitiated()` | Set `voip_call_state = ringing` |
| User answers | `.callState("ANSWERING", details)` | — | Set `voip_call_state = answering` |
| Org switch start | `.i("OrgSwitch", "API START")` | — | — |
| Org switch complete | `.d("OrgSwitch", "SUCCESS")` | `logOrgSwitch(result)` | Set `voip_org_id = newId` |
| Call connected | `.callState("ACTIVE", details)` | `logCallConnected()` | Set `voip_call_state = active` |
| Call ended | `.callState("ENDED", reason)` | `logCallEnded()` | Clear all voip keys |
| Crash recovered | `.w("CrashRecovery", details)` | `logCrashRecovered()` | — |

---

## 13. Notification Management

### 13.1 Notification Channel Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    NOTIFICATION CHANNELS                              │
│                                                                       │
│  Channel: z360_incoming_call                                         │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Importance: HIGH (heads-up, sound)                            │  │
│  │  Sound: null (IncomingCallActivity handles ringtone)           │  │
│  │  Used for: Incoming call full-screen notifications             │  │
│  │  Notification style: CallStyle.forIncomingCall() [TARGET]      │  │
│  │  Features: fullScreenIntent, ongoing, auto-cancel=false        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Channel: z360_ongoing_call                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Importance: LOW (persistent, non-intrusive)                   │  │
│  │  Used for: Active call status notification                     │  │
│  │  Notification style: CallStyle.forOngoingCall() [TARGET]       │  │
│  │  Features: ongoing, shows caller + duration + hangup button    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Channel: z360_crash_recovery                                        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Importance: HIGH (must be seen)                               │  │
│  │  Used for: Post-crash recovery notification                    │  │
│  │  Style: Standard notification                                  │  │
│  │  Features: badge, auto-cancel=true, opens app                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Channel: z360_missed_calls                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Importance: HIGH                                              │  │
│  │  Used for: Missed call notifications with badge count          │  │
│  │  Style: Standard notification with count in title              │  │
│  │  Features: badge, auto-cancel=true, deep links to inbox       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 13.2 Target: CallStyle Notifications

The target architecture should adopt `CallStyle` notifications (Android 12+/API 31) following the Telnyx demo pattern:

```kotlin
// TARGET: Incoming call with CallStyle
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    val person = Person.Builder()
        .setName(callerName ?: callerNumber)
        .setImportant(true)
        .build()

    val builder = NotificationCompat.Builder(context, INCOMING_CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_call_answer)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setOngoing(true)
        .setAutoCancel(false)
        .setFullScreenIntent(fullScreenPendingIntent, true)
        .setStyle(
            NotificationCompat.CallStyle.forIncomingCall(
                person,
                declinePendingIntent,
                answerPendingIntent
            )
        )
}

// TARGET: Ongoing call with CallStyle
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    val person = Person.Builder()
        .setName(callerName ?: callerNumber)
        .setImportant(true)
        .build()

    val builder = NotificationCompat.Builder(context, ONGOING_CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_call_active)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setOngoing(true)
        .setStyle(
            NotificationCompat.CallStyle.forOngoingCall(
                person,
                hangUpPendingIntent
            )
        )
}
```

**Design decision**: Adopt CallStyle notifications for both incoming and ongoing calls on Android 12+. Fall back to basic notifications on older API levels.

**Justification**: The Telnyx demo app uses CallStyle notifications. Android platform requirements doc §5 notes: "CallStyle provides native call appearance and is recommended by Google." The current Z360 implementation lacks this (gap identified in platform requirements §8).

### 13.3 Foreground Service Notifications

```
┌──────────────────────────────────────────────────────────────────────┐
│                    FOREGROUND SERVICE STRATEGY                        │
│                                                                       │
│  CallForegroundService (Telnyx Common, :call_service process)        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Type: phoneCall | microphone                                  │  │
│  │  Start: When call becomes ACTIVE                               │  │
│  │  Stop: When call ends (ENDED/FAILED)                           │  │
│  │                                                                │  │
│  │  Three-tier startForeground() fallback:                        │  │
│  │  1. FOREGROUND_SERVICE_TYPE_PHONE_CALL | MICROPHONE            │  │
│  │  2. FOREGROUND_SERVICE_TYPE_PHONE_CALL only (SecurityException)│  │
│  │  3. No type (pre-Q) (second SecurityException)                 │  │
│  │                                                                │  │
│  │  KEY FIX (BUG-005): Never start service with STOP action.     │  │
│  │  Use stopService() directly instead. Starting FGS without      │  │
│  │  calling startForeground() causes crash on Android 14+.       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Z360ConnectionService (Telecom framework)                           │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Type: BIND_TELECOM_CONNECTION_SERVICE                         │  │
│  │  Lifecycle: Managed by Android Telecom framework               │  │
│  │  Used for: Lock screen, Bluetooth, car integration             │  │
│  │  Not a foreground service — system manages its lifecycle       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  Capacitor Push Notifications (@capacitor/push-notifications)        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Separate from VoIP notifications                              │  │
│  │  Handled in WebView layer via use-push-notifications.ts        │  │
│  │  Foreground: Re-scheduled as LocalNotifications for tappability│  │
│  │  Deep links: visitDeepLink() queues until router ready         │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 13.4 Full-Screen Intent Handling (Android 14+)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Android 14+ Full-Screen Intent Permission                           │
│                                                                       │
│  CHECK:                                                               │
│  if (Build.VERSION.SDK_INT >= 34) {                                  │
│      val canUse = notificationManager.canUseFullScreenIntent()       │
│      if (!canUse) {                                                  │
│          // Log warning, prompt user via settings                    │
│          openFullScreenIntentSettings()                              │
│      }                                                               │
│  }                                                                   │
│                                                                       │
│  GRANT:                                                               │
│  TelnyxVoipPlugin.openFullScreenIntentSettings()                     │
│  → Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)        │
│  → User navigates to system settings to grant permission             │
│                                                                       │
│  FALLBACK (if not granted):                                          │
│  - Heads-up notification (IMPORTANCE_HIGH) still shows               │
│  - Lock screen display may be delayed or limited                     │
│  - ConnectionService provides additional lock screen path            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 14. Threading Model

### 14.1 Thread Assignment

```
┌──────────────────────────────────────────────────────────────┐
│                    THREAD MODEL                               │
│                                                               │
│  MAIN THREAD (UI Thread):                                    │
│  ├── WebView / Capacitor Bridge message handling             │
│  ├── TelnyxVoipPlugin @PluginMethod calls                    │
│  ├── notifyListeners() calls (must be on main)               │
│  ├── ConnectionService callbacks (system dispatches to main) │
│  ├── Activity lifecycle methods                              │
│  └── CoroutineScope(Dispatchers.Main) coroutines             │
│                                                               │
│  FCM THREAD (system-managed):                                │
│  └── Z360FirebaseMessagingService.onMessageReceived()        │
│      ├── PushSynchronizer (runs on FCM thread + suspend)     │
│      ├── ensureTelnyxSdkConnected() with runBlocking {}      │
│      └── showIncomingCallNotification()                      │
│                                                               │
│  SDK THREAD (OkHttp WebSocket thread):                       │
│  └── Telnyx SDK WebSocket callbacks                          │
│      └── TelnyxViewModel dispatches to uiState Flow          │
│                                                               │
│  :call_service PROCESS (isolated):                           │
│  └── CallForegroundService                                   │
│      └── Audio keeps alive even if main process crashes      │
│                                                               │
│  COROUTINE DISPATCHERS:                                      │
│  ├── Dispatchers.Main → Plugin methods, UI updates           │
│  ├── Dispatchers.IO → OrgSwitchHelper API calls              │
│  └── ProcessLifecycleOwner.lifecycleScope → Survives         │
│      Activity destruction (answer from killed state)         │
└──────────────────────────────────────────────────────────────┘
```

### 14.2 Thread Safety Rules

| Component | Thread Safety Mechanism | Why |
|-----------|------------------------|-----|
| `TelnyxViewModelProvider` | `synchronized(this)` for singleton creation | Multiple threads may request ViewModel simultaneously |
| `Z360VoipStore` | `synchronized(this)` + `commit()` (synchronous writes) | Race between Z360 push writer and Telnyx push reader |
| `PushSynchronizer` | `Mutex` (Kotlin coroutines) + `CompletableDeferred` | Two FCM messages may arrive nearly simultaneously |
| `CallStatePersistence` | `synchronized(this)` for singleton + `commit()` | Multiple Activities may read/write crash state |
| `BluetoothAudioManager` | `synchronized(this)` for singleton | Activities and BroadcastReceivers access concurrently |
| `TelnyxVoipPlugin.pendingIncomingCall` | `AtomicReference` | FCM thread sets, main thread reads (BUG-001 fix) |
| `IncomingCallActivity.isAnswering` | `AtomicBoolean.compareAndSet()` | Prevents double-tap race condition (BUG-005 fix) |
| `ActiveCallActivity.callStateObserverMutex` | `Mutex` | Prevents duplicate observers during state flapping (BUG-007 fix) |

---

## 15. Key Sequence Diagrams

### 15.1 Complete Inbound Call (Happy Path)

```
PSTN     Telnyx    Z360 Backend     FCM         FCM Svc     PushSync    ConnSvc    IncomingAct   SDK        ActiveAct
  │         │           │            │             │           │           │           │           │            │
  │──call──►│           │            │             │           │           │           │            │            │
  │         │──webhook──►            │             │           │           │           │            │            │
  │         │           │──Push#1───►│             │           │           │           │            │            │
  │         │──Push#2──►│            │──deliver──► │           │           │           │            │            │
  │         │           │            │──deliver──► │           │           │           │            │            │
  │         │           │            │             │──login?──►│           │           │            │            │
  │         │           │            │             │  (yes)    │           │           │            │            │
  │         │           │            │             │──store────►           │           │            │            │
  │         │           │            │             │  Z360 data│           │           │            │            │
  │         │           │            │             │           │           │           │            │            │
  │         │           │            │             │──reconnect─────────────────────────►           │            │
  │         │           │            │             │  SDK (5s) │           │           │ ◄──login──►│            │
  │         │           │            │             │           │           │           │            │            │
  │         │           │            │             │──sync──────►          │           │            │            │
  │         │           │            │             │  (500ms)  │──found!──►│           │            │            │
  │         │           │            │             │◄──IMMEDIATE│          │           │            │            │
  │         │           │            │             │           │           │           │            │            │
  │         │           │            │             │──addIncomingCall──────►           │            │            │
  │         │           │            │             │           │           │──create──►│            │            │
  │         │           │            │             │           │           │ Connection│            │            │
  │         │           │            │             │           │           │           │──ring──►   │            │
  │         │           │            │             │           │           │           │  (user     │            │
  │         │           │            │             │           │           │           │   sees     │            │
  │         │           │            │             │           │           │           │   call)    │            │
  │         │           │            │             │           │           │           │            │            │
  │         │           │            │             │           │           │           │──answer──► │            │
  │         │           │            │             │           │           │           │            │──accept──► │
  │         │           │            │             │           │           │           │            │            │
  │         │           │            │             │           │           │           │  ◄─launch──│            │──start──►
  │         │           │            │             │           │           │           │            │            │ active
  │         │           │            │             │           │           │           │            │            │ call UI
  │         │           │            │             │           │           │           │            │            │
  │◄──media─┼───────────┼───────────┼─────────────┼───────────┼───────────┼───────────┼────────────┼──WebRTC────┤
  │         │           │            │             │           │           │           │            │            │
```

### 15.2 Org Switch During Inbound Answer

```
IncomingCallActivity    OrgSwitchHelper     Z360 Backend     ProfileManager    Z360VoipStore    SDK
        │                     │                  │                 │                │              │
        │──switchOrg=true────►│                  │                 │                │              │
        │  (push org ≠ stored)│                  │                 │                │              │
        │                     │──POST /api/voip/─►                │                │              │
        │                     │  switch-org      │                 │                │              │
        │                     │  (with cookies)  │                 │                │              │
        │                     │                  │──create new────►│                │              │
        │                     │                  │  credential     │                │              │
        │                     │◄──{sipUser,──────│                 │                │              │
        │                     │   sipPass,       │                 │                │              │
        │                     │   callerIdName}  │                 │                │              │
        │                     │                  │                 │                │              │
        │                     │──saveProfile────────────────────► │                │              │
        │                     │  (new creds)     │                 │                │              │
        │                     │──setCurrentOrg──────────────────────────────────► │              │
        │                     │  (new org id)    │                 │                │              │
        │◄──credentials───────│                  │                 │                │              │
        │                     │                  │                 │                │              │
        │──answerCall()─────────────────────────────────────────────────────────────────────────►│
        │  (with new creds)  │                  │                 │                │              │
        │                     │                  │                 │                │              │
```

### 15.3 Crash Recovery

```
ActiveCallActivity    CallStatePersist    OS         MainActivity    CrashRecovery    Notification
        │                   │              │              │               │               │
        │──persist call────►│              │              │               │               │
        │  (ACTIVE state)   │              │              │               │               │
        │                   │              │              │               │               │
        │      ╳ CRASH ╳    │              │              │               │               │
        │                   │              │              │               │               │
        │                   │              │              │               │               │
        │                   │              │──user opens──►               │               │
        │                   │              │  app         │               │               │
        │                   │              │              │──check()─────►│               │
        │                   │              │              │               │──read prefs──►│
        │                   │              │              │               │◄─found call───│
        │                   │              │              │               │               │
        │                   │              │              │               │──stop FGS────►│
        │                   │              │              │               │  cancel notifs│
        │                   │              │              │               │               │
        │                   │              │              │               │──show recovery─►
        │                   │              │              │               │  notification  │
        │                   │              │              │               │               │
        │                   │              │              │               │──clear prefs──►│
        │                   │              │              │◄──handled─────│               │
        │                   │              │              │               │               │
        │                   │              │              │──continue─────►               │
        │                   │              │              │  normal startup               │
```

---

## Design Decision Summary

| Decision | Choice | Alternatives Considered | Justification |
|----------|--------|-------------------------|---------------|
| VoIP path independence from WebView | Native-only critical path | Wait for WebView | WebView may not exist on cold start. iOS does the same with PushKit→CallKit. |
| ConnectionService (self-managed) | Use `CAPABILITY_SELF_MANAGED` | System-managed or no ConnectionService | Lock screen, Bluetooth, car integration. Telnyx demo skips this but Z360 needs it for enterprise use. |
| Shared TelnyxViewModel via Provider | Singleton `TelnyxViewModelProvider` | Per-Activity ViewModel | Multiple components (Plugin, FCM, Activities) need access. Singleton ensures single SDK connection. |
| Dual-push correlation | Phone number (last 10 digits), 500ms timeout | Call ID matching, longer timeout | Different call IDs between Z360 and Telnyx. 500ms is generous for push latency (50-200ms typical). |
| CallStyle notifications | Adopt for incoming + ongoing (API 31+) | Basic notifications only | Google recommendation. Telnyx demo uses it. Native call appearance. |
| Process isolation for FGS | `:call_service` separate process | Same process | Protects audio from WebView crashes. |
| Audio focus strategy | `GAIN_TRANSIENT_EXCLUSIVE` | `GAIN_TRANSIENT`, `GAIN` | Prevents other apps from playing audio during calls. Most appropriate for VoIP per Android docs. |
| Crash recovery strategy | Notify user + cleanup (no reconnect) | Attempt call reconnection | Other party will have hung up. Reconnection is unreliable. Cleanup prevents ghost state. |
| Org switch during answer | Synchronous in answer flow | Background pre-fetch, lazy switch | Credentials must be correct BEFORE answering. Telnyx requires correct SIP credentials for INVITE acceptance. |
| State observation | Reactive StateFlow collection | Polling, imperative checks | Telnyx SDK exposes uiState as StateFlow. Kotlin best practice for reactive UI. |
| SDK reconnect idempotency | Check state before connecting | Always reconnect | BUG-003: WebView connect() was killing native socket from push flow. |

---

*Generated: 2026-02-08*
*Sources: voip-android skill (26 files), voip-android-platform skill, voip-architecture skill, Telnyx reference unified, Android platform requirements, Capacitor architecture, system-architecture-unified*
