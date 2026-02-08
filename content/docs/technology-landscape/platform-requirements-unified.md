---
title: Platform Requirements Unified
---

# Platform Requirements: Unified Constraints Document

> **Purpose**: This document synthesizes iOS, Android, and Capacitor platform requirements into a single constraints reference that all VoIP architecture and implementation work must respect. It draws from three detailed research documents:
> - `ios-platform-requirements.md` — Apple PushKit, CallKit, AVAudioSession, App Store, lifecycle
> - `android-platform-requirements.md` — ConnectionService, FCM, foreground services, permissions, lifecycle
> - `capacitor-architecture.md` — Plugin bridge, WebView lifecycle, threading, native/web separation
>
> **Audience**: Engineers implementing or extending Z360's VoIP system across any platform.

---

## Table of Contents

1. [Foundational Architecture: The Native/WebView Separation](#1-foundational-architecture)
2. [Push Notification Requirements](#2-push-notification-requirements)
3. [System Call Integration](#3-system-call-integration)
4. [Audio Session Management](#4-audio-session-management)
5. [Background Execution & Lifecycle](#5-background-execution--lifecycle)
6. [Permissions & Entitlements](#6-permissions--entitlements)
7. [Capacitor Bridge Constraints](#7-capacitor-bridge-constraints)
8. [Threading & Concurrency Model](#8-threading--concurrency-model)
9. [Store & Review Requirements](#9-store--review-requirements)
10. [Cross-Platform Constraint Matrix](#10-cross-platform-constraint-matrix)
11. [Identified Gaps & Recommendations](#11-identified-gaps--recommendations)
12. [Key File Reference](#12-key-file-reference)

---

## 1. Foundational Architecture

### The Native/WebView Separation

The single most important architectural constraint for Z360's VoIP implementation:

> **VoIP call handling on mobile operates INDEPENDENTLY of the WebView/Capacitor layer.** The native layer handles push reception, SDK connection, system call UI, and audio — all without requiring the WebView to exist. Capacitor is used only for control commands, state queries, event notifications, and non-VoIP push handling.

This separation is not a design choice — it is **mandated by platform constraints**:

| Constraint | Why Native-Only Is Required |
|---|---|
| iOS 5-second PushKit deadline | WebView takes seconds to load; CallKit must be reported to immediately |
| Android process-killed state | FCM wakes the process, but WebView isn't loaded; native IncomingCallActivity shows directly |
| Lock screen calls | Both platforms require native system APIs (CallKit / ConnectionService) for lock screen UI |
| Audio session ownership | iOS CallKit owns the audio session; Android ConnectionService manages audio focus |
| Bluetooth/car integration | System-level audio routing requires native Telecom/CallKit integration |

### What Happens Where

```
┌──────────────────────────────────────────────────────────────────┐
│  NATIVE LAYER (No WebView required)                              │
│  ════════════════════════════════════                             │
│  • VoIP push reception (PushKit / FCM data-only)                 │
│  • System call UI (CallKit / ConnectionService)                  │
│  • Telnyx SDK connection with persisted credentials              │
│  • WebRTC media (audio capture + playback)                       │
│  • Audio routing (speaker, Bluetooth, car)                       │
│  • Crash recovery (orphan call detection)                        │
│  • Two-push correlation (PushCorrelator / PushSynchronizer)      │
│  • Lock screen incoming/active call UI                           │
│                                                                   │
│  CAPACITOR BRIDGE (WebView required)                             │
│  ═══════════════════════════════════                              │
│  • Session management: connect(), disconnect()                   │
│  • Outbound calls: makeCall() (app must be active)               │
│  • Mid-call controls: mute, hold, speaker, DTMF                 │
│  • State sync: 22+ event types via notifyListeners()             │
│  • Organization context: setCurrentOrganization()                │
│  • Contact resolution: setCallDisplayInfo()                      │
│  • Standard push notifications (non-VoIP)                        │
│  • Deep link navigation on notification tap                      │
│  • Platform detection and UI adaptation                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Push Notification Requirements

### The Two-Push System

Z360 uses a dual-push architecture for incoming calls, requiring coordination between two independent push channels:

| Push | Source | Transport | Contents | Purpose |
|---|---|---|---|---|
| **Z360 Push** | Z360 Laravel backend | iOS: APNs silent / Android: FCM data | Caller name, avatar, org ID/name, channel number | Rich caller display info |
| **Telnyx Push** | Telnyx platform | iOS: PushKit VoIP / Android: FCM data | Call ID, SIP headers, call control metadata | Call establishment |

### Platform-Specific Push Constraints

| Constraint | iOS | Android |
|---|---|---|
| **Push type** | PushKit VoIP (high-priority, wakes from any state) | FCM data-only, HIGH priority |
| **Delivery guarantee** | Wakes app from terminated state | Bypasses Doze mode (10s execution window) |
| **Timing deadline** | **5 seconds** to report to CallKit or app is terminated; repeated failures → push delivery stops entirely | **10 seconds** to show notification or future messages deprioritized |
| **Correlation mechanism** | `PushCorrelator` — normalized phone (last 10 digits), 1.5s timeout | `PushSynchronizer` — `CompletableDeferred`, normalized phone, 500ms timeout |
| **Cold start handling** | `didFinishLaunchingWithOptions` runs → PushKit callback fires → CallKit report | FCM cold-starts process → `onMessageReceived()` → SDK reconnect (5s timeout) → notification |
| **Token management** | PushKit token (hex-encoded `Data`) + FCM token (injected via native→JS event) | FCM token from `onNewToken()` + `registration` Capacitor event |
| **Completion handler** | Must be called after `reportNewIncomingCall`; race condition workaround needed (asyncAfter delay) | N/A |

### Hard Rules

1. **Every PushKit VoIP push MUST result in a CallKit report** — no exceptions (Apple contract)
2. **FCM data-only messages MUST be used** (not notification messages) to ensure `onMessageReceived()` always fires
3. **HIGH priority is mandatory** for FCM VoIP pushes to bypass Doze mode
4. **Login check required** — reject pushes silently when user is logged out (prevents ghost calls)
5. **Busy handling required** — auto-reject when user is already on a call (Z360 is single-call mode)

---

## 3. System Call Integration

### iOS: CallKit

| Component | Purpose | Key Constraint |
|---|---|---|
| `CXProvider` | Reports call state to iOS, receives system events | **Singleton** — only ONE instance per app |
| `CXCallController` | Sends user-initiated actions to system | Actions wrapped in `CXTransaction` |
| `CXProviderDelegate` | 9 callback methods from iOS | Every action **MUST** call `fulfill()` or `fail()` |
| `CXCallUpdate` | Describes incoming call to iOS | Must include handle, caller name, capabilities |

**CallKit owns the audio session.** The app must:
1. Configure `AVAudioSession` category/mode (but NOT activate)
2. Wait for `didActivate(audioSession:)` callback
3. Enable Telnyx SDK audio only in that callback
4. Disable audio in `didDeactivate(audioSession:)` callback

**Z360 CallKit configuration**: Single call, no video, phone number + generic handles, Recents integration enabled, custom icon.

### Android: ConnectionService + Telecom Framework

| Component | Purpose | Key Constraint |
|---|---|---|
| `Z360ConnectionService` | Self-managed ConnectionService | `CAPABILITY_SELF_MANAGED` — app manages own UI |
| `Z360Connection` | Represents a single call lifecycle | States: ringing → active → disconnected → destroyed |
| `PhoneAccount` | Registers VoIP capability with system | SIP + TEL URI schemes |
| `TelecomManager` | System-level call coordination | `addNewIncomingCall()` to register inbound calls |

**What ConnectionService provides that raw notifications don't:**
- Lock screen call display (critical on Android 14+)
- Bluetooth headset answer/reject/hangup
- Car head unit integration
- System-level audio focus management
- Proper interaction with cellular calls

**Fallback path**: If `TelecomManager.addNewIncomingCall()` fails or `onCreateIncomingConnectionFailed` fires, Z360 falls back to Telnyx SDK's notification service or direct `IncomingCallActivity` launch.

### Cross-Platform Comparison

| Feature | iOS (CallKit) | Android (ConnectionService) |
|---|---|---|
| Lock screen UI | System-provided (native iOS call UI) | Custom `IncomingCallActivity` with `showWhenLocked` + `turnScreenOn` |
| Bluetooth integration | Automatic via CallKit | `BluetoothAudioManager` + SCO routing |
| Car integration | Automatic via CallKit | Automatic via ConnectionService |
| Audio ownership | CallKit owns audio session | App manages `AudioFocusRequest` |
| Recents integration | `includesCallsInRecents = true` | Not available for self-managed |
| DTMF | `CXPlayDTMFCallAction` | Custom implementation |
| Hold | `CXSetHeldCallAction` | Custom state management |
| Incoming call UI | System UI (cannot customize) | Fully custom native Activity |

---

## 4. Audio Session Management

### iOS Audio Constraints

```
Category:  .playAndRecord     (two-way audio)
Mode:      .voiceChat         (echo cancellation + noise suppression + AGC)
Options:   .allowBluetoothHFP + .allowBluetoothA2DP
```

**Critical constraint — WebView audio coexistence:**
- `AVAudioSession.setCategory()` triggers the iOS audio daemon
- During app launch, this **starves the WebKit IPC pipe** causing 37-43 second launch delays
- **Solution**: Two-phase startup — Phase 1 (PushKit + CallKit only, ~50ms), Phase 2 (audio + Firebase deferred to `sceneDidBecomeActive`)

**Audio session lifecycle is CallKit-owned:**
1. App configures category/mode (does NOT activate)
2. CallKit activates session → `didActivate` callback → app tells SDK to use the session
3. CallKit deactivates session → `didDeactivate` callback → app tells SDK to release the session
4. App must NEVER call `setActive(true/false)` directly

### Android Audio Constraints

- **Foreground service types**: `phoneCall | microphone` required for Android 14+
- **Audio focus**: Managed via `AudioFocusRequest` with `AUDIOFOCUS_GAIN` during calls
- **Bluetooth**: `BluetoothAudioManager` handles SCO routing, headset detection, connection state
- **Process isolation**: `CallForegroundService` runs in `:call_service` separate process to isolate from WebView crashes
- **Graceful fallback**: Three-tier foreground service type fallback (phoneCall+microphone → phoneCall only → no type)

### Cross-Platform Audio Rules

| Rule | iOS | Android |
|---|---|---|
| Audio activation timing | Only in CallKit `didActivate` callback | When call becomes active (onAnswer/makeCall) |
| Bluetooth support | `.allowBluetoothHFP` + `.allowBluetoothA2DP` | `BluetoothAudioManager` + SCO |
| Speaker toggle | `overrideOutputAudioPort(.speaker)` | Audio route switching |
| Echo cancellation | Built into `.voiceChat` mode | Handled by Telnyx SDK / WebRTC |
| Interruption handling | `AVAudioSession.interruptionNotification` | Audio focus loss callbacks |
| Route change detection | `AVAudioSession.routeChangeNotification` | `BluetoothHeadset` BroadcastReceiver |

---

## 5. Background Execution & Lifecycle

### App State Matrix

| State | iOS Push | iOS Audio | Android Push | Android Audio |
|---|---|---|---|---|
| **Foreground** | PushKit + WebSocket active | Full audio | FCM immediate | Full audio |
| **Background** | PushKit active, WebSocket drops | Active if on call (`audio` bgmode) | FCM immediate (high-priority) | Active via foreground service |
| **Suspended** | PushKit wakes app | Inactive until activated | N/A (Android doesn't suspend like iOS) | N/A |
| **Terminated/Killed** | PushKit launches process in background | Inactive until CallKit activates | FCM cold-starts process (10s window) | Requires foreground service start |
| **Lock screen** | CallKit native UI visible | Active if on call | `showWhenLocked` + `turnScreenOn` Activities | Active via foreground service |

### iOS Background Modes Required

| Mode | Purpose | Apple Enforcement |
|---|---|---|
| `voip` | PushKit VoIP push delivery | Must result in CallKit report or push delivery stops |
| `audio` | Keep alive during active call | Must be actively using audio (not just registered) |
| `remote-notification` | Silent push processing (Z360 caller info push) | 30s execution window |
| `fetch` | Periodic background refresh | Timing determined by iOS usage patterns |

### Android Background Constraints

| Constraint | Impact | Z360 Mitigation |
|---|---|---|
| Doze mode | Defers network, jobs, alarms | FCM high-priority bypasses (10s window) |
| App Standby | Limits background network | FCM high-priority exempt |
| Foreground service timing | Must call `startForeground()` within 10s of `startForegroundService()` | Immediate notification post; BUG-005 fix avoids early return |
| Android 15+ | Cannot start `phoneCall` FGS from `BOOT_COMPLETED` | Use FCM to trigger (not broadcast receiver) |
| Battery optimization | May delay non-high-priority delivery | `requestBatteryOptimizationExemption()` plugin method |

### Cold Start Handling

**iOS two-phase startup** (prevents 37-43s WebKit IPC starvation):
```
Phase 1: didFinishLaunchingWithOptions (~50ms)
  → PushKitManager.initialize()
  → Z360VoIPService.setupMinimal(callKitManager:)
  → NOTHING ELSE (no audio, no Firebase, no WebView init)

Phase 2: sceneDidBecomeActive (deferred)
  → configureAudioSessionForVoIP()
  → Complete VoIP service setup
  → Start NetworkMonitor
```

**Android cold start path**:
```
FCM wakes process → Z360FirebaseMessagingService.onCreate()
  → serviceCreationTime recorded (cold start detection)
  → onMessageReceived()
  → Login check (reject if logged out)
  → ensureTelnyxSdkConnected() with stored credentials (5s timeout)
  → PushSynchronizer correlates Z360 + Telnyx pushes (500ms)
  → ConnectionService → Z360Connection → IncomingCallActivity
  → WebView loads in parallel (not blocking call path)
```

### Network Transitions

| Aspect | iOS | Android |
|---|---|---|
| Detection | `NWPathMonitor` | Implicit via SDK |
| Debounce | 500ms | N/A |
| Reconnection timeout | 30s | 5s (SDK reconnect from push) |
| States | connected / disconnected / reconnecting | Implicit |

---

## 6. Permissions & Entitlements

### iOS Permissions & Entitlements

| Requirement | Type | Purpose |
|---|---|---|
| `aps-environment` entitlement | Build-time | APNs push delivery (VoIP pushes) |
| Background Modes capability | Build-time | voip, audio, remote-notification, fetch |
| `NSMicrophoneUsageDescription` | Info.plist | Runtime microphone permission dialog |
| `NSCameraUsageDescription` | Info.plist | Runtime camera permission (if video) |
| PushKit VoIP certificate/key | Server-side | APNs Auth Key (`.p8`, recommended) or VoIP cert (`.p12`, legacy, expires annually) |

### Android Permissions

| Permission | Runtime? | Purpose | When Required |
|---|---|---|---|
| `INTERNET` | No | WebRTC/SIP connections | Always |
| `RECORD_AUDIO` | **Yes** | Microphone for calls | Before first call |
| `POST_NOTIFICATIONS` | **Yes (API 33+)** | Show call notifications | App startup |
| `READ_PHONE_STATE` | **Yes** | Phone state monitoring | App startup |
| `MANAGE_OWN_CALLS` | No | Self-managed ConnectionService | Manifest |
| `USE_FULL_SCREEN_INTENT` | **Special (API 34+)** | Lock screen incoming call UI | Check + settings redirect |
| `FOREGROUND_SERVICE` | No | Run foreground services | Manifest |
| `FOREGROUND_SERVICE_PHONE_CALL` | No | Phone call type FGS | Manifest |
| `FOREGROUND_SERVICE_MICROPHONE` | No | Microphone type FGS | Manifest |
| `WAKE_LOCK` | No | CPU awake during push handling | Manifest |
| `BLUETOOTH_CONNECT` | **Yes (API 31+)** | Bluetooth headset | Before Bluetooth use |
| `MODIFY_AUDIO_SETTINGS` | No | Audio routing | Manifest |
| `CALL_PHONE` | **Yes** | Required by some OEMs | Manifest |
| `BIND_TELECOM_CONNECTION_SERVICE` | No (system) | ConnectionService binding | Manifest |

### Permission Request Strategy

**Z360 requests three runtime permission groups together** via Capacitor plugin:
1. `microphone` (RECORD_AUDIO)
2. `notifications` (POST_NOTIFICATIONS)
3. `phoneState` (READ_PHONE_STATE)

**Special permissions handled separately:**
- Full-screen intent: Runtime check via `canUseFullScreenIntent()` at API 34+, settings redirect via `openFullScreenIntentSettings()`
- Battery optimization: `requestBatteryOptimizationExemption()` opens system dialog
- Bluetooth: Checked before operations in `BluetoothAudioManager`

---

## 7. Capacitor Bridge Constraints

### Communication Model

All plugin calls are **asynchronous** (Promise-based). The bridge:
1. Serializes JS arguments to JSON
2. Posts message via `WKScriptMessageHandler` (iOS) / JS interface (Android)
3. Native plugin receives `CAPPluginCall` / `PluginCall`
4. Plugin calls `resolve()` or `reject()` → Promise resolves in JS

### Plugin Registration

| Platform | Registration Point | Mechanism | Timing |
|---|---|---|---|
| Android | `MainActivity.onCreate()` | `registerPlugin(TelnyxVoipPlugin::class.java)` before `super.onCreate()` | Before WebView creation |
| iOS | `Z360BridgeViewController.capacitorDidLoad()` | `bridge?.registerPluginType(TelnyxVoipPlugin.self)` | During bridge initialization |
| TypeScript | Module load | `registerPlugin<TelnyxVoipPlugin>('TelnyxVoip', { web: ... })` | At import time |

### WebView Lifecycle Constraints

| Scenario | Problem | Solution |
|---|---|---|
| VoIP push arrives, app killed | WebView doesn't exist yet | iOS: Persist to UserDefaults → `getPendingIncomingCall()`. Android: Native `IncomingCallActivity` bypasses WebView entirely |
| Push notification tap during cold start | Inertia router not ready | Module-level listeners + `visitDeepLink()` queues until router fires `navigate` event |
| WebView calls `connect()` during SDK reconnect | Kills the native SDK socket established during push flow | BUG-003 fix: Check if already connected before reconnecting |
| WebView crashes during active call | Call audio would die if tied to WebView | `:call_service` process isolation (Android); native VoipStore persists state independently |

### Event System

**22+ event types** flow from native → JavaScript via `notifyListeners()`:
- Connection state: `connected`, `disconnected`
- Call lifecycle: `incomingCall`, `callStarted`, `callRinging`, `callAnswered`, `callEnded`, `callError`
- Audio state: `muteStateChanged`, `holdStateChanged`, `speakerStateChanged`, `audioRouteChanged`
- Monitoring: `callQuality`, `callDurationUpdated`, `networkStatusChanged`, `networkTransition`
- Recovery: `callDropped`, `callRejectedBusy`, `orphanCallRecovered`
- Multi-tenancy: `orgSwitchStarted`, `orgSwitchCompleted`, `orgSwitchFailed`

### Web Platform Fallback

On web, `TelnyxVoipWeb` provides stub implementations — the web platform uses `@telnyx/react-client` (React WebRTC hooks) directly instead of the Capacitor plugin. Platform detection via:
```typescript
Capacitor.isNativePlatform()  // true on iOS/Android
Capacitor.getPlatform()       // 'ios' | 'android' | 'web'
```

---

## 8. Threading & Concurrency Model

### Thread Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MAIN THREAD (Both Platforms)                 │
│  ├── WebView rendering + JavaScript execution                    │
│  ├── Capacitor bridge message dispatch                           │
│  ├── TelnyxVoipPlugin method handlers                            │
│  ├── notifyListeners() calls (native → JS events)                │
│  ├── CallKit CXProviderDelegate callbacks (iOS, queue: nil)      │
│  └── ConnectionService callbacks (Android, main thread)          │
│                                                                   │
│                    BACKGROUND THREADS                              │
│  ├── Telnyx SDK WebSocket (SDK-managed thread)                   │
│  ├── PushKit delegate (PushKit queue — iOS)                      │
│  ├── Z360FirebaseMessagingService (FCM thread — Android)         │
│  └── Network monitor (custom queue — iOS)                        │
│                                                                   │
│                    SPECIAL SCOPES                                  │
│  ├── ProcessLifecycleOwner.lifecycleScope (Android, survives     │
│  │   Activity destruction for killed-state answer)               │
│  ├── callsQueue serial queue (iOS, thread-safe call tracking)    │
│  └── VoipStore Swift Actor (iOS, compile-time thread safety)     │
└─────────────────────────────────────────────────────────────────┘
```

### Thread Safety Rules

1. **SDK callbacks → main thread before UI/bridge**: Both platforms dispatch SDK callbacks to main thread before calling `notifyListeners()` or updating UI
2. **Push callbacks need synchronization**: PushKit (iOS) and FCM (Android) callbacks arrive on system threads — native code handles dispatch to main
3. **VoipStore thread safety**: iOS uses Swift Actor (compile-time); Android uses `synchronized` blocks
4. **Coroutine scope**: Android plugin uses `SupervisorJob() + Dispatchers.Main` — failures in one coroutine don't cancel others
5. **Process isolation**: Android `CallForegroundService` runs in `:call_service` process, isolated from WebView process

---

## 9. Store & Review Requirements

### Apple App Store

| Guideline | Requirement | Impact on Z360 |
|---|---|---|
| **2.5.4** | Background modes for intended purpose only | VoIP pushes must result in CallKit calls; no keep-alive abuse |
| **3.1.3(b)** | SaaS exemption from IAP | VoIP subscriptions can be managed outside App Store |
| **4.0** | Design guidelines | CallKit UI must be used for incoming calls |
| Push certificate | APNs Auth Key (`.p8`) or VoIP cert (`.p12`) | Configure on Telnyx portal |

**Rejection risks:**
- Using `voip` background mode for anything other than VoIP calls
- Not reporting to CallKit for every PushKit push
- Custom call UI without CallKit for VoIP apps
- Missing usage description strings for microphone/camera

### Google Play Store

| Requirement | Impact on Z360 |
|---|---|
| Battery optimization exemption | Must justify under "messaging/communication" category |
| Foreground service types | Must declare `phoneCall` + `microphone` types |
| `USE_FULL_SCREEN_INTENT` | May require justification for non-default phone apps |
| Target SDK level | Must target latest SDK; affects permission model |

---

## 10. Cross-Platform Constraint Matrix

### Hard Deadlines

| Deadline | iOS | Android |
|---|---|---|
| Push → call UI | **5 seconds** (app terminated by iOS) | **10 seconds** (notification deprioritized) |
| Foreground service start | N/A | **10 seconds** from `startForegroundService()` |
| Audio session activation | Only in CallKit `didActivate` | After audio focus granted |
| Push correlation | 1.5s (`PushCorrelator`) | 500ms (`PushSynchronizer`) |
| SDK reconnect from killed | Part of 5s budget | 5s timeout (`ensureTelnyxSdkConnected`) |

### Platform Feature Parity

| Feature | iOS | Android | Web |
|---|---|---|---|
| Incoming calls (app killed) | PushKit → CallKit | FCM → ConnectionService | N/A (WebSocket only) |
| Incoming calls (foreground) | WebSocket + PushKit | WebSocket + FCM | WebSocket (WebRTC) |
| Lock screen calls | CallKit native UI | IncomingCallActivity + showWhenLocked | N/A |
| Bluetooth/car | CallKit automatic | ConnectionService + BluetoothAudioManager | N/A |
| Outgoing calls | Capacitor → SDK | Capacitor → SDK | @telnyx/react-client |
| Call quality monitoring | CallQualityMonitor | callQuality events | N/A |
| Network monitoring | NWPathMonitor (debounced) | Implicit via SDK | N/A |
| Crash recovery | Orphan call detection | CrashRecoveryManager | N/A |
| Credential storage | Keychain (secure) | SharedPreferences | Session/memory |
| Multi-org switching | OrganizationSwitcher (5s deadline) | VoipStore org context | Inertia session switch |

### Architectural Patterns Shared Across Platforms

| Pattern | Implementation |
|---|---|
| Two-push correlation | iOS: `PushCorrelator` / Android: `PushSynchronizer` — normalized phone (last 10 digits) |
| Persisted credentials | iOS: Keychain / Android: SharedPreferences — enables call handling without WebView |
| Native → JS events | `notifyListeners(eventName, data)` on both platforms (22+ event types) |
| Cold start recovery | iOS: `getPendingIncomingCall()` from UserDefaults / Android: native Activity bypass |
| Login guard | Both platforms reject pushes when user is logged out |
| Busy guard | Both platforms auto-reject when already on a call |
| Plugin method pattern | Async Promise-based: `call.resolve()` / `call.reject()` |

---

## 11. Identified Gaps & Recommendations

### Gap 1: Android Missing CallStyle Notifications

**Current**: Z360 uses basic `NotificationCompat.Builder` with `fullScreenIntent` for incoming calls.
**Telnyx demo**: Uses `NotificationCompat.CallStyle.forIncomingCall()` (Android 12+) with `Person` builder and `CallStyle.forOngoingCall()` for active calls.
**Impact**: CallStyle provides native call appearance matching the system dialer aesthetic, better UX for answer/reject actions, and is Google's recommended pattern.
**Recommendation**: Implement `CallStyle` notifications for both incoming and ongoing calls on Android 12+, with fallback to current implementation for older versions.

### Gap 2: Android Missing Ongoing Call Notification

**Current**: Z360 relies on `CallForegroundService` notification (generic) during active calls.
**Telnyx demo**: Uses `CallStyle.forOngoingCall()` with caller info, duration, and hangup action.
**Impact**: Users have no branded, informative notification during active calls. The FGS notification is minimal.
**Recommendation**: Add a Z360-branded `CallStyle.forOngoingCall()` notification that shows caller info and call duration.

### Gap 3: iOS Event Parity with Android

**Current**: Several events are iOS-only (`holdStateChanged`, `speakerStateChanged`, `audioRouteChanged`, `callDropped`, `callRejectedBusy`, `orphanCallRecovered`, `orgSwitchStarted/Completed/Failed`, `networkTransition`).
**Impact**: Web UI receives different event sets depending on platform; requires platform-specific handling in React.
**Recommendation**: Implement matching events on Android where applicable (hold, speaker, audio route changes) for UI consistency.

### Gap 4: Android Network Monitoring

**Current**: iOS has comprehensive `NWPathMonitor` with debouncing and reconnection state management. Android relies on implicit SDK behavior.
**Impact**: Android has less visibility into network transitions and less control over reconnection behavior.
**Recommendation**: Add `ConnectivityManager.NetworkCallback` monitoring on Android for parity with iOS.

### Gap 5: Credential Storage Security

**Current**: iOS uses Keychain (hardware-backed secure storage). Android uses SharedPreferences (file-based, not encrypted).
**Impact**: SIP credentials on Android are stored in plaintext on disk.
**Recommendation**: Migrate Android credential storage to `EncryptedSharedPreferences` (AndroidX Security library) or Android Keystore.

---

## 12. Key File Reference

### iOS Native Files

| File | Purpose | Lines |
|---|---|---|
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` | Main VoIP orchestrator | 2,253 |
| `ios/App/App/VoIP/Managers/PushKitManager.swift` | PushKit VoIP push handling | 949 |
| `ios/App/App/VoIP/Services/TelnyxService.swift` | Telnyx SDK wrapper | 667 |
| `ios/App/App/VoIP/Utilities/PushCorrelator.swift` | Two-push synchronization | 611 |
| `ios/App/App/VoIP/Managers/CallKitManager.swift` | CallKit integration | 456 |
| `ios/App/App/VoIP/Managers/AudioManager.swift` | Audio routing + interruptions | 445 |
| `ios/App/App/VoIP/Utilities/NetworkMonitor.swift` | NWPathMonitor + debounce | 419 |
| `ios/App/App/VoIP/Utilities/OrganizationSwitcher.swift` | Cross-org credential rotation | 481 |
| `ios/App/App/VoIP/Utilities/CallQualityMonitor.swift` | Quality metrics | 286 |
| `ios/App/App/VoIP/Utilities/KeychainManager.swift` | Secure credential storage | 111 |
| `ios/App/App/VoIP/TelnyxVoipPlugin.swift` | Capacitor plugin (20 methods) | — |
| `ios/App/App/Z360BridgeViewController.swift` | Capacitor bridge + plugin registration | — |
| `ios/App/App/AppDelegate.swift` | Two-phase startup | — |

### Android Native Files

| File | Purpose |
|---|---|
| `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt` | Capacitor plugin (17 methods) + permissions |
| `android/app/src/main/java/com/z360/app/voip/Z360ConnectionService.kt` | Self-managed ConnectionService |
| `android/app/src/main/java/com/z360/app/voip/Z360Connection.kt` | Call lifecycle (ringing → active → disconnected) |
| `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt` | FCM push handling + dual-push routing |
| `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt` | CompletableDeferred push coordination |
| `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt` | Lock screen incoming call UI |
| `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt` | Active call UI + lifecycle |
| `android/app/src/main/java/com/z360/app/voip/BluetoothAudioManager.kt` | Bluetooth SCO + headset detection |
| `android/app/src/main/java/com/z360/app/voip/AudioDiagnostics.kt` | Audio focus + state logging |
| `android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt` | Abandoned call recovery |
| `android/app/src/main/java/com/z360/app/voip/MissedCallNotificationManager.kt` | Missed call notifications |
| `android/app/src/main/java/com/z360/app/voip/Z360VoipStore.kt` | Persisted org context + caller info |
| `android/app/src/main/java/com/z360/app/MainActivity.kt` | Plugin registration + intent handling |
| `android/app/src/main/AndroidManifest.xml` | Permissions + services + activities |

### Capacitor / TypeScript Files

| File | Purpose |
|---|---|
| `resources/js/plugins/telnyx-voip.ts` | Plugin interface (20+ methods) + `registerPlugin` |
| `resources/js/plugins/telnyx-voip-web.ts` | Web fallback stubs |
| `resources/js/plugins/use-telnyx-voip.ts` | React hook with event listeners |
| `resources/js/hooks/use-push-notifications.ts` | Push notification handling + deep links |
| `resources/js/utils/platform.ts` | Platform detection utilities |
| `capacitor.config.ts` | Capacitor configuration |

---

## Appendix: Source Documents

- **iOS Platform Requirements**: `01-technology-landscape/ios-platform-requirements.md`
- **Android Platform Requirements**: `01-technology-landscape/android-platform-requirements.md`
- **Capacitor Architecture**: `01-technology-landscape/capacitor-architecture.md`
- **System Architecture (prior research)**: `00-system-context/system-architecture-unified.md`
- **Data & Control Flows (prior research)**: `00-system-context/flows-unified.md`
