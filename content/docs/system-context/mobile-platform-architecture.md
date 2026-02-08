---
title: Mobile Platform Architecture
---

# Z360 Mobile Platform Architecture

## 1. Overview: Capacitor Hybrid Architecture

Z360 mobile apps are Capacitor 8 hybrid applications. The web application (Laravel + React + Inertia.js) runs inside a native WebView, while VoIP functionality runs entirely in native code (Kotlin on Android, Swift on iOS) bypassing the WebView completely.

**The critical architectural insight**: VoIP on mobile does NOT go through the Capacitor WebView. VoIP speaks directly to native Telnyx SDKs. Capacitor handles WebView rendering, standard notifications, and navigation. A Capacitor plugin bridge (`TelnyxVoipPlugin`) provides the communication layer between JavaScript and native VoIP code.

### Capacitor Configuration
- **File**: `capacitor.config.ts`
- **App ID**: `com.z360.app`
- **Web Directory**: `public` (Laravel's public directory)
- **User Agent**: Appends `Z360Capacitor` for server-side detection
- **Server URL**: Configurable via `CAPACITOR_SERVER_URL` env var (dev points to local server)
- **Capacitor Plugins registered**: StatusBar, Keyboard, PushNotifications
- **iOS content inset**: `never` (app manages safe areas via CSS `env(safe-area-inset-*)`)
- **Keyboard resize**: `None` (app handles keyboard avoidance itself)

### Capacitor Plugins (registered via SPM/Gradle)
Both platforms register the same Capacitor plugins:
- `@capacitor/browser` — In-app browser
- `@capacitor/keyboard` — Keyboard control
- `@capacitor/local-notifications` — Local notification display
- `@capacitor/push-notifications` — FCM/APNs push registration
- `@capacitor/status-bar` — Status bar control

**Ref**: `ios/App/CapApp-SPM/Package.swift`, `android/app/capacitor.build.gradle`

---

## 2. The Capacitor <-> Native VoIP Bridge

### Plugin Registration (TypeScript -> Native)

The bridge is defined in `resources/js/plugins/telnyx-voip.ts`:

```typescript
const TelnyxVoip = registerPlugin<TelnyxVoipPlugin>('TelnyxVoip', {
  web: () => import('./telnyx-voip-web').then(m => new m.TelnyxVoipWeb()),
});
```

- On **native platforms** (iOS/Android): Capacitor routes calls to the native `TelnyxVoipPlugin` class
- On **web**: Falls back to `TelnyxVoipWeb` class which logs no-ops (web uses `@telnyx/react-client` WebRTC directly)

### Plugin Interface
The `TelnyxVoipPlugin` interface (defined in `resources/js/plugins/telnyx-voip.ts`) exposes:
- **Connection**: `connect()`, `connectWithToken()`, `disconnect()`, `isConnected()`, `getConnectionState()`, `reconnectWithCredentials()`
- **Call Control**: `makeCall()`, `answerCall()`, `rejectCall()`, `hangup()`
- **In-Call**: `setMute()`, `setSpeaker()`, `setHold()`, `sendDTMF()`
- **Device/Token**: `getDeviceId()`, `getFcmToken()`, `getFcmTokenWithWait()`
- **Display**: `setCallDisplayInfo()`, `setCurrentOrganization()`
- **Permissions**: `requestVoipPermissions()`
- **Cold Start**: `getPendingIncomingCall()`
- **Events** (native -> JS): `connected`, `disconnected`, `incomingCall`, `callStarted`, `callRinging`, `callAnswered`, `callEnded`, `callDurationUpdated`, `muteStateChanged`, `callError`, `callQuality`, `networkStatusChanged`

### NativeVoipProvider
**File**: `resources/js/providers/native-voip-provider.tsx`

On native mobile, `NativeVoipProvider` replaces `TelnyxRTCProvider` to prevent dual WebSocket connections. The native layer owns the Telnyx SDK connection, so the web-based `@telnyx/react-client` must not create its own.

### Platform Detection
**File**: `resources/js/utils/platform.ts` (referenced via `isNativeMobile()`)

The frontend uses `Capacitor.isNativePlatform()` to decide:
- **Native**: Use `TelnyxVoip` Capacitor plugin for all VoIP operations
- **Web**: Use `@telnyx/react-client` (WebRTC in browser)

---

## 3. Android Platform Architecture

### Component Diagram

```
+------------------------------------------------------------------+
|                        Android App                                |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |              Capacitor WebView (MainActivity)               |  |
|  |  +------------------------------------------------------+  |  |
|  |  |  React/Inertia SPA (Z360 Web Application)            |  |  |
|  |  |  +------------------------------------------------+  |  |  |
|  |  |  |  TelnyxVoip Plugin (JS bridge calls)           |  |  |  |
|  |  |  +---------------------+--------------------------+  |  |  |
|  |  +------------------------|--------------------------+  |  |
|  +---------------------------|-----------------------------+  |
|                              | Capacitor Bridge               |
|  +---------------------------v-----------------------------+  |
|  |              TelnyxVoipPlugin (Kotlin)                  |  |
|  |  +--------------------------------------------------+  |  |
|  |  |  TelnyxViewModel (Telnyx SDK wrapper)            |  |  |
|  |  |  +----------------------------------------------+|  |  |
|  |  |  |  Telnyx Android WebRTC SDK                   ||  |  |
|  |  |  |  (SIP/WebSocket/WebRTC)                      ||  |  |
|  |  |  +----------------------------------------------+|  |  |
|  |  +--------------------------------------------------+  |  |
|  +----------------------------------------------------------+  |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |  INDEPENDENT NATIVE COMPONENTS (no WebView needed)          |  |
|  |                                                              |  |
|  |  Z360FirebaseMessagingService --> PushSynchronizer           |  |
|  |       |                                                      |  |
|  |       v                                                      |  |
|  |  Z360ConnectionService (TelecomManager / self-managed)       |  |
|  |       |                                                      |  |
|  |       v                                                      |  |
|  |  IncomingCallActivity --> ActiveCallActivity                  |  |
|  |       |                       |                              |  |
|  |       v                       v                              |  |
|  |  CallNotificationService  BluetoothAudioManager              |  |
|  |  Z360VoipStore            VoipAnalytics                      |  |
|  |  CrashRecoveryManager     CallTimerManager                   |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Native Files (26 files in `android/app/src/main/java/com/z360/app/`)

**FCM Package** (`fcm/`):
| File | Purpose |
|------|---------|
| `PushSynchronizer.kt` | Coordinates Z360 + Telnyx dual-push timing (CompletableDeferred-based, 500ms timeout) |
| `TokenHolder.kt` | FCM token singleton storage |
| `Z360FirebaseMessagingService.kt` | Handles both Z360 backend push (caller info) and Telnyx SDK push (call control metadata) |

**VoIP Package** (`voip/`):
| File | Purpose |
|------|---------|
| `TelnyxVoipPlugin.kt` | **Capacitor plugin** — bridges JS <-> native VoIP. Extends `Plugin()`. |
| `TelnyxViewModelProvider.kt` | Provides singleton access to Telnyx SDK ViewModel |
| `Z360ConnectionService.kt` | Android `ConnectionService` (self-managed PhoneAccount) for Telecom framework integration |
| `Z360Connection.kt` | Individual connection objects for Z360ConnectionService |
| `Z360VoipStore.kt` | SharedPreferences-based persistence for VoIP metadata |
| `IncomingCallActivity.kt` | Full-screen incoming call UI (shows when locked, turns screen on) |
| `ActiveCallActivity.kt` | In-call UI with controls (mute, hold, speaker, DTMF) |
| `CallNotificationService.kt` | Manages incoming call notification |
| `BluetoothAudioManager.kt` | Bluetooth headset audio routing |
| `AudioDiagnostics.kt` | Audio subsystem diagnostic logging |
| `CallStatePersistence.kt` | Persists call state across process death |
| `CallTimerManager.kt` | Call duration tracking |
| `CrashlyticsHelper.kt` | Firebase Crashlytics integration |
| `CrashRecoveryManager.kt` | Recovers from crashes during active calls |
| `MissedCallNotificationManager.kt` | Manages missed call notifications |
| `OrgSwitchHelper.kt` | Cross-organization call credential switching |
| `PhoneNumberFormatter.kt` | Phone number formatting utilities |
| `TelnyxLogTree.kt` | Timber log tree for Telnyx SDK logging |
| `VoipAnalytics.kt` | Firebase Analytics custom VoIP events |
| `VoipLogger.kt` | Structured VoIP logging with call session tracking |
| `VoipPerformance.kt` | Performance timing instrumentation |
| `VoipRemoteConfig.kt` | Firebase Remote Config for VoIP feature flags |

### What Goes Through Capacitor vs. What Is Native-Only

**Through Capacitor Bridge (TelnyxVoipPlugin)**:
- SDK connection management (connect/disconnect from JS-initiated login)
- Outgoing call initiation (user taps dial in WebView -> `TelnyxVoip.makeCall()`)
- In-call controls when initiated from WebView (mute, hold, DTMF)
- Call display info updates (JS resolves contact -> sends to native)
- Event notifications back to JS (call state changes, quality metrics)
- Organization context setting
- Permission requests

**Native-Only (no WebView involvement)**:
- FCM push reception and processing (`Z360FirebaseMessagingService`)
- Push synchronization between Z360 and Telnyx pushes (`PushSynchronizer`)
- Incoming call UI (`IncomingCallActivity` — launched from FCM/ConnectionService, not WebView)
- Active call UI (`ActiveCallActivity` — native Android Activity)
- Android Telecom framework integration (`Z360ConnectionService` — lock screen, Bluetooth, car mode)
- Call notification management (foreground service, heads-up notification)
- Bluetooth audio routing
- Crash recovery and orphan call cleanup
- Call state persistence across process death

### Android Startup Sequence

1. **App Launch** -> `MainActivity` created (Capacitor's BridgeActivity)
2. **Capacitor initializes** -> WebView created, loads web app from `public/` or dev server URL
3. **Capacitor plugin loading** -> `TelnyxVoipPlugin.load()` is called:
   - Initializes `VoipLogger`
   - Initializes `TokenHolder` (FCM token)
   - Registers `Z360ConnectionService` PhoneAccount with TelecomManager
   - Starts observing Telnyx SDK events via `startObservingTelnyx()`
4. **JS app loads** -> React/Inertia SPA renders in WebView
5. **JS calls `TelnyxVoip.connect()`** -> Native plugin receives SIP credentials, calls `telnyxViewModel.credentialLogin()`, waits for `ClientLoggedIn` state (8s timeout)
6. **SDK connected** -> Plugin fires `connected` event to JS

**Ref**: `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:5891-5899` (load method)

**FCM-Initiated Flow (app backgrounded/killed)**:
1. **FCM push arrives** -> `Z360FirebaseMessagingService.onMessageReceived()`
2. **Z360 push** -> Stores caller display info in `Z360VoipStore`, notifies `PushSynchronizer`
3. **Telnyx push** -> Parses metadata, waits up to 500ms for Z360 display info via `PushSynchronizer`
4. **Call routed** -> `Z360ConnectionService.addIncomingCall()` via TelecomManager
5. **ConnectionService** -> Creates `Z360Connection`, sets ringing
6. **`IncomingCallActivity.start()`** -> Full-screen call UI (shows over lock screen)
7. **User answers** -> SDK answers call, `ActiveCallActivity` launches

**Ref**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:625-833`

### AndroidManifest Key Declarations

**File**: `android/app/src/main/AndroidManifest.xml`

**Permissions**:
- `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` — Microphone access
- `READ_PHONE_STATE`, `CALL_PHONE`, `MANAGE_OWN_CALLS` — Telecom integration
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL`, `FOREGROUND_SERVICE_MICROPHONE` — Background call services
- `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT` — Incoming call notification
- `BLUETOOTH_CONNECT` — Bluetooth headset audio routing
- `WAKE_LOCK` — Keep device awake during calls

**Activities**:
- `MainActivity` (singleTask) — Capacitor WebView host, app launcher
- `IncomingCallActivity` (singleTop, showWhenLocked, turnScreenOn) — Incoming call UI
- `ActiveCallActivity` (singleTop, showWhenLocked) — In-call UI

**Services**:
- `Z360FirebaseMessagingService` (priority 10000) — FCM handler
- `Z360ConnectionService` (BIND_TELECOM_CONNECTION_SERVICE) — Android Telecom framework
- `LegacyCallNotificationService` (Telnyx SDK) — Foreground service
- `CallForegroundService` (Telnyx SDK, separate process `:call_service`) — Call foreground service

---

## 4. iOS Platform Architecture

### Component Diagram

```
+------------------------------------------------------------------+
|                          iOS App                                  |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |              Capacitor WebView (WKWebView)                  |  |
|  |  +------------------------------------------------------+  |  |
|  |  |  React/Inertia SPA (Z360 Web Application)            |  |  |
|  |  |  +------------------------------------------------+  |  |  |
|  |  |  |  TelnyxVoip Plugin (JS bridge calls)           |  |  |  |
|  |  |  +---------------------+--------------------------+  |  |  |
|  |  +------------------------|--------------------------+  |  |
|  +---------------------------|-----------------------------+  |
|                              | Capacitor Bridge               |
|  +---------------------------v-----------------------------+  |
|  |              TelnyxVoipPlugin (Swift)                   |  |
|  |  +--------------------------------------------------+  |  |
|  |  |  Z360VoIPService (singleton orchestrator)        |  |  |
|  |  |  +----------------------------------------------+|  |  |
|  |  |  |  TelnyxService (SDK wrapper)                 ||  |  |
|  |  |  |  +------------------------------------------+||  |  |
|  |  |  |  |  TxClient (Telnyx iOS SDK)               |||  |  |
|  |  |  |  |  (SIP/WebSocket/WebRTC)                  |||  |  |
|  |  |  |  +------------------------------------------+||  |  |
|  |  |  +----------------------------------------------+|  |  |
|  |  +--------------------------------------------------+  |  |
|  +----------------------------------------------------------+  |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |  INDEPENDENT NATIVE COMPONENTS (no WebView needed)          |  |
|  |                                                              |  |
|  |  AppDelegate --> PushKitManager (VoIP push token reg)       |  |
|  |       |              |                                       |  |
|  |       |              v                                       |  |
|  |       |         PushCorrelator (Z360 + Telnyx sync)          |  |
|  |       |              |                                       |  |
|  |       |              v                                       |  |
|  |       |         CallKitManager (CXProvider, single instance) |  |
|  |       |              |                                       |  |
|  |       v              v                                       |  |
|  |  Z360VoIPService <---- TelnyxService                         |  |
|  |       |                    |                                 |  |
|  |       v                    v                                 |  |
|  |  AudioManager         CallQualityMonitor                     |  |
|  |  NetworkMonitor       CallTimerManager                       |  |
|  |  VoipStore (Keychain) NotificationHelper                     |  |
|  |  ActionGuard          ActiveCallGuard                        |  |
|  |  OrganizationSwitcher VoIPLogger                             |  |
|  +------------------------------------------------------------+  |
|                                                                   |
|  SceneDelegate --> performDeferredInitialization()                 |
+------------------------------------------------------------------+
```

### Native Files (25 files in `ios/App/App/`)

**Managers** (`VoIP/Managers/`):
| File | Purpose |
|------|---------|
| `AudioManager.swift` | Mute/hold/speaker/DTMF with BUG-012 auto-mute pattern, audio route monitoring |
| `CallKitManager.swift` | Single CXProvider instance, CXCallController, incoming/outgoing call reporting |
| `PushKitManager.swift` | PKPushRegistry for VoIP pushes, two-push correlation, must report to CallKit within 5s |

**Models** (`VoIP/Models/`):
| File | Purpose |
|------|---------|
| `CallInfo.swift` | Call data model (UUID, direction, handle, state) |
| `VoIPModels.swift` | SIPCredentials, CallDirection, PersistableCallState, error types |

**Protocols** (`VoIP/Protocols/`):
| File | Purpose |
|------|---------|
| `CallKitManagerDelegate.swift` | Protocol for CallKit events (answer, end, mute, hold, start) |
| `TelnyxServiceDelegate.swift` | Protocol for Telnyx SDK events (ready, call state, remote ended) |

**Services** (`VoIP/Services/`):
| File | Purpose |
|------|---------|
| `PushCorrelator.swift` | Actor-based coordination of Z360 + Telnyx push timing |
| `TelnyxService.swift` | Wraps TxClient SDK (connect, disconnect, make/answer/end call, codecs) |
| `VoipStore.swift` | Keychain-based credential storage, UserDefaults for tokens/state |
| `Z360VoIPService.swift` | **Central orchestrator** — coordinates TelnyxService, CallKitManager, AudioManager |

**Utils** (`VoIP/Utils/`):
| File | Purpose |
|------|---------|
| `ActionGuard.swift` | Prevents double-tap race conditions (BUG-005) |
| `ActiveCallGuard.swift` | Single-call enforcement (US-014, US-025) |
| `CallQualityMonitor.swift` | MOS/jitter/RTT tracking (US-018) |
| `CallTimerManager.swift` | Call duration tracking (US-015) |
| `KeychainManager.swift` | Keychain read/write for SIP credentials |
| `NetworkMonitor.swift` | NWPathMonitor for WiFi/Cellular transitions (US-024) |
| `NotificationHelper.swift` | Missed call local notification management |
| `OrganizationSwitcher.swift` | Cross-org credential switching |
| `VoIPLogger.swift` | Structured logging with Firebase Crashlytics integration |

**Plugin** (`VoIP/`):
| File | Purpose |
|------|---------|
| `TelnyxVoipPlugin.swift` | **Capacitor plugin** — bridges JS <-> native. CAPBridgedPlugin with 21 methods. |

**App Lifecycle**:
| File | Purpose |
|------|---------|
| `AppDelegate.swift` | Minimal launch (PushKit + CallKit only), deferred initialization |
| `SceneDelegate.swift` | Triggers deferred initialization in `sceneDidBecomeActive` |
| `Info.plist` | Background modes: `voip`, `audio`, `remote-notification`, `fetch` |

### What Goes Through Capacitor vs. What Is Native-Only

**Through Capacitor Bridge (TelnyxVoipPlugin)**:
- SDK connection management (connect/disconnect from JS login flow)
- Outgoing call initiation (`makeCall()` from WebView)
- In-call controls from WebView (mute, hold, speaker, DTMF)
- Call display info updates (JS resolves contact -> native)
- Event notifications to JS (state changes, quality, network status)
- Organization context, permission requests
- Plugin delegate registration (`Z360VoIPService.pluginDelegate = self`)

**Native-Only (no WebView involvement)**:
- PushKit VoIP push reception and token management (`PushKitManager`)
- Push correlation between Z360 and Telnyx pushes (`PushCorrelator`)
- CallKit integration — entire call lifecycle UI (`CallKitManager`)
  - Incoming call banner (iOS system UI, not WebView)
  - Lock screen call UI
  - Call audio routing (speaker, Bluetooth)
- Telnyx SDK WebSocket and WebRTC (managed by `TelnyxService` / `Z360VoIPService`)
- Audio session configuration (`AudioManager`)
- Network monitoring for connectivity changes (`NetworkMonitor`)
- Credential storage in Keychain (`VoipStore` / `KeychainManager`)
- Crash recovery and orphan call cleanup
- Missed call notifications (`NotificationHelper`)
- Firebase Crashlytics and Analytics
- Session expiry checking (30-day token validity)

### iOS Startup Sequence

**CRITICAL PERFORMANCE FIX**: iOS uses a two-phase startup to prevent WebKit IPC starvation.

**Phase 1: `didFinishLaunchingWithOptions` (MINIMAL — ~50ms)**
1. `PushKitManager.shared.initialize()` — Register for VoIP pushes (Apple mandate)
2. `Z360VoIPService.shared.setupMinimal(callKitManager:)` — Set delegates only (no XPC/IPC)
3. Set `UNUserNotificationCenter.delegate`
4. **Everything else is DEFERRED** — No Firebase, no AVAudioSession, no network monitoring

**Ref**: `ios/App/App/AppDelegate.swift:10292-10313`

**Phase 2: `sceneDidBecomeActive` (DEFERRED — after first frame)**
1. `AppDelegate.performDeferredInitialization()` is called from SceneDelegate
2. `configureAudioSessionForVoIP()` — Now safe (WebKit already loaded)
3. `Z360VoIPService.shared.setupMinimal()` — Re-called with full delegates
4. `Z360VoIPService.shared.startNetworkMonitoringIfNeeded()` — NWPathMonitor + delegates
5. `configureFirebase()` — On background queue (`.utility` QoS)
6. `checkSessionExpiry()` — 30-day token validity check
7. `cleanupOrphanCallState()` — Crash recovery (US-026)

**Ref**: `ios/App/App/AppDelegate.swift:10318-10353`, `ios/App/App/SceneDelegate.swift:10733-10751`

**Why two phases?** `AVAudioSession.setCategory()` triggers audio daemon initialization which starves WebKit's IPC, causing 37-43 second WebView launch times on real devices. By deferring all heavy initialization until `sceneDidBecomeActive`, WebKit processes initialize first.

**PushKit-Initiated Flow (app backgrounded/killed)**:
1. **VoIP push arrives** -> `PushKitManager` `pushRegistry(_:didReceiveIncomingPushWith:)` called
2. **MUST report to CallKit within 5 seconds** (Apple mandate, or app is terminated)
3. Extract Z360 caller info and/or Telnyx metadata from payload
4. Feed `PushCorrelator` for two-push coordination
5. `CallKitManager.reportIncomingCall()` — Shows iOS system call UI
6. If user answers -> `CallKitManager` fires `CXAnswerCallAction`
7. `Z360VoIPService` receives delegate callback -> answers via `TelnyxService.answerFromCallKit()`
8. `TelnyxService` calls SDK's `answerFromCallkit(answerAction:)` which fulfills the CXAction

**Ref**: `ios/App/App/VoIP/Managers/PushKitManager.swift:935-1134`

---

## 5. Key Architectural Differences: Android vs iOS

| Aspect | Android | iOS |
|--------|---------|-----|
| **Push delivery** | FCM (Firebase Cloud Messaging) | PushKit (VoIP push type) |
| **Push handler** | `Z360FirebaseMessagingService` | `PushKitManager` (PKPushRegistry) |
| **System call UI** | `Z360ConnectionService` (self-managed PhoneAccount) | `CallKitManager` (CXProvider) |
| **Call UI** | Custom Activities (`IncomingCallActivity`, `ActiveCallActivity`) | iOS system CallKit UI (banner, lock screen) |
| **Push timing constraint** | No hard limit (but ANR after 5s) | MUST report to CallKit within 5s or app killed |
| **Two-push sync** | `PushSynchronizer` (CompletableDeferred, 500ms timeout) | `PushCorrelator` (Actor-based) |
| **Credential storage** | SharedPreferences + Telnyx ProfileManager | Keychain (`KeychainManager`) + UserDefaults |
| **Audio management** | AudioManager system service + BluetoothAudioManager | `AudioManager` (custom) + AVAudioSession |
| **SDK wrapper** | `TelnyxViewModelProvider` (ViewModel pattern) | `TelnyxService` (singleton with delegate pattern) |
| **Plugin base class** | `Plugin()` (Capacitor Android) | `CAPPlugin, CAPBridgedPlugin` (Capacitor iOS) |
| **Startup strategy** | Single-phase (plugin load in WebView init) | Two-phase (minimal launch + deferred init) |
| **Background modes** | Foreground services + TelecomManager | `UIBackgroundModes`: voip, audio, remote-notification, fetch |
| **Lock screen calls** | `showWhenLocked`, `turnScreenOn` Activity flags | CallKit native lock screen integration |

---

## 6. The Two-Push Architecture

Both platforms implement a dual-push system for incoming calls:

1. **Z360 Backend Push** — Contains caller display info (name, avatar, organization ID, channel number)
2. **Telnyx SDK Push** — Contains call control metadata (SIP headers, call ID for SDK)

Either push can arrive first. Both platforms implement synchronization:

- **Android**: `PushSynchronizer` uses `CompletableDeferred` with 500ms timeout
  - **Ref**: `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt`
- **iOS**: `PushCorrelator` uses Swift Actor for thread-safe coordination
  - **Ref**: `ios/App/App/VoIP/Services/PushCorrelator.swift`

If the Z360 push hasn't arrived when Telnyx push triggers the call UI, the UI shows with basic info and updates asynchronously when the Z360 push arrives (via BroadcastReceiver on Android, or direct update on iOS).

### Push Data Flow

```
Z360 Laravel Backend                    Telnyx Platform
       |                                      |
       | FCM/APNs push                        | FCM/APNs push
       | (caller_name, avatar,                | (metadata JSON with
       |  organization_id, channel)           |  SIP call control data)
       |                                      |
       v                                      v
  +--------------------------------------------------+
  |           Mobile Push Handler                     |
  |  Android: Z360FirebaseMessagingService             |
  |  iOS: PushKitManager                               |
  +--------------------------------------------------+
       |                                      |
       v                                      v
  +--------------------------------------------------+
  |           Push Synchronizer / Correlator          |
  |  Android: PushSynchronizer (CompletableDeferred)  |
  |  iOS: PushCorrelator (Swift Actor)                 |
  |  Timeout: 500ms                                    |
  +--------------------------------------------------+
                      |
                      v
              Show Incoming Call UI
              (with best available info)
```

---

## 7. Summary: What Capacitor Handles vs What Is Native

### Capacitor WebView Handles:
- Entire Z360 web application UI (contacts, inbox, tickets, settings, etc.)
- User authentication and session management
- SIP credential retrieval from server (sent to native via bridge)
- Outgoing call initiation (user dials from WebView)
- Contact resolution for incoming call display info
- Navigation and routing
- Standard push notification handling (non-VoIP)

### Native Layer Handles (Independent of WebView):
- Telnyx SDK WebSocket connection and WebRTC media
- All VoIP push notification processing
- Call UI on Android (custom Activities)
- CallKit integration on iOS (system call UI)
- Android Telecom framework integration (ConnectionService)
- Audio session management (earpiece, speaker, Bluetooth)
- Call state persistence and crash recovery
- Firebase Crashlytics and Analytics
- Network monitoring and reconnection
- Lock screen and background call handling

### Why This Separation Matters

This separation ensures that:
1. **Incoming calls work even when the app is killed** — native push handler -> native call UI, no WebView needed
2. **Calls survive WebView navigation/reload** — native SDK connection persists independently
3. **Audio quality is managed by native code** — not constrained by WebView audio APIs
4. **Platform-specific call integration works properly** — CallKit on iOS, TelecomManager on Android
5. **Startup performance is not degraded** — VoIP initialization is deferred on iOS to avoid WebKit IPC starvation
