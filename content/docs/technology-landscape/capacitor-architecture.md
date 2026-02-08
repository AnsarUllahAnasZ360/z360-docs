---
title: Capacitor Architecture
---

# Capacitor Architecture for VoIP Bridge

> Z360 uses Capacitor to bridge a React/TypeScript SPA with native iOS (Swift) and Android (Kotlin) VoIP implementations. This document analyzes the bridge architecture, communication model, threading, and the critical separation between native call handling and WebView-based UI.

## 1. Plugin Communication Model

### How a TypeScript Call Reaches Native Code

When JavaScript calls `TelnyxVoip.connect(options)`, the following sequence occurs:

```
┌─────────────────────────────────────────────────────────────────┐
│  JavaScript (WebView)                                           │
│                                                                 │
│  TelnyxVoip.connect({ sipUsername, sipPassword })               │
│       │                                                         │
│       ▼                                                         │
│  registerPlugin('TelnyxVoip', { web: ... })                     │
│  [resources/js/plugins/telnyx-voip.ts:243]                      │
│       │                                                         │
│       ▼                                                         │
│  Capacitor Core: Serializes args to JSON, posts message         │
│  to native bridge via MessageHandler (iOS) / JS interface       │
│  (Android)                                                      │
└───────┬─────────────────────────────────────────────────────────┘
        │  JSON message over WebView bridge
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  Native Bridge                                                  │
│                                                                 │
│  Capacitor deserializes the message, routes to the plugin       │
│  matching name "TelnyxVoip", invokes the method matching        │
│  the call name ("connect")                                      │
│       │                                                         │
│       ▼                                                         │
│  Android: TelnyxVoipPlugin.connect(call: PluginCall)            │
│  [android/.../voip/TelnyxVoipPlugin.kt:118]                    │
│                                                                 │
│  iOS: TelnyxVoipPlugin.connect(_ call: CAPPluginCall)           │
│  [ios/App/App/VoIP/TelnyxVoipPlugin.swift:125]                 │
│       │                                                         │
│       ▼                                                         │
│  Plugin delegates to native service layer                       │
│  (TelnyxViewModel on Android, Z360VoIPService on iOS)           │
│       │                                                         │
│       ▼                                                         │
│  call.resolve() / call.reject() → Promise resolves in JS       │
└─────────────────────────────────────────────────────────────────┘
```

### Synchronous vs Asynchronous

All Capacitor plugin methods are **asynchronous** (Promise-based). The TypeScript interface defines every method as returning `Promise<T>`:

```typescript
// resources/js/plugins/telnyx-voip.ts:3-241
export interface TelnyxVoipPlugin {
  connect(options: { sipUsername: string; sipPassword: string; ... }): Promise<void>;
  makeCall(options: { destinationNumber: string; ... }): Promise<{ callId: string }>;
  isConnected(): Promise<{ connected: boolean }>;
  // ... all 20+ methods return Promises
}
```

On the native side, the plugin receives a `PluginCall` (Android) or `CAPPluginCall` (iOS) object. The method can do work synchronously or asynchronously before calling `call.resolve()` or `call.reject()`, which sends the result back through the bridge to resolve the JavaScript Promise.

**Android example** (connect with timeout):
```kotlin
// android/.../voip/TelnyxVoipPlugin.kt:118-175
@PluginMethod
fun connect(call: PluginCall) {
    scope.launch {
        telnyxViewModel.connect(sipUsername, sipPassword, ...)
        val connected = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
            telnyxViewModel.sessionsState.first { it is ClientLoggedIn }
            true
        } ?: false
        if (connected) call.resolve(JSObject().put("connected", true))
        else call.reject("Connection timed out")
    }
}
```

**iOS example** (connect with async/await):
```swift
// ios/App/App/VoIP/TelnyxVoipPlugin.swift:125-170
@objc func connect(_ call: CAPPluginCall) {
    Task {
        try await voipService.connect(credentials: credentials)
        let connected = await waitForClientReady(timeout: ...)
        if connected { call.resolve() }
        else { call.reject("Connection timed out") }
    }
}
```

### Plugin Registration on TypeScript Side

The plugin is registered using Capacitor's `registerPlugin` with a web fallback:

```typescript
// resources/js/plugins/telnyx-voip.ts:243-245
const TelnyxVoip = registerPlugin<TelnyxVoipPlugin>('TelnyxVoip', {
  web: () => import('./telnyx-voip-web').then(m => new m.TelnyxVoipWeb()),
});
```

**Platform routing**: On native platforms, `registerPlugin` routes calls to the native plugin. On web, it lazy-loads `TelnyxVoipWeb` which provides stub implementations (the web platform uses `@telnyx/react-client` directly instead of the Capacitor plugin).

```typescript
// resources/js/plugins/telnyx-voip-web.ts:8-145
export class TelnyxVoipWeb implements TelnyxVoipPlugin {
  async connect(): Promise<void> {
    console.log('[TelnyxVoipWeb] connect() - Web uses @telnyx/react-client');
  }
  // ... stubs for all methods
}
```

**Platform detection** is centralized in a utility:
```typescript
// resources/js/utils/platform.ts
export function isNativeAndroid(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
export function isNativeIOS(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}
export function isWeb(): boolean {
    return !Capacitor.isNativePlatform();
}
```

---

## 2. WebView Lifecycle

### When Does the WebView Load?

The WebView loads as part of Capacitor's `BridgeActivity` (Android) / `CAPBridgeViewController` (iOS) lifecycle:

**Android**: `MainActivity` extends `BridgeActivity`. The WebView is created during `onCreate()`, loads the web content from `webDir: 'public'` (or the remote `CAPACITOR_SERVER_URL` in dev mode), and becomes interactive once the page JavaScript executes.

```kotlin
// android/.../MainActivity.kt:35-48
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        registerPlugin(TelnyxVoipPlugin::class.java)  // BEFORE super.onCreate()
        super.onCreate(savedInstanceState)  // Triggers WebView creation
        handleNotificationIntent(intent)
    }
}
```

**iOS**: `Z360BridgeViewController` extends `CAPBridgeViewController`. Plugin registration occurs in `capacitorDidLoad()`:

```swift
// ios/App/App/Z360BridgeViewController.swift:184-190
override func capacitorDidLoad() {
    bridge?.registerPluginType(TelnyxVoipPlugin.self)
}
```

### VoIP Push Arrives Before WebView Is Ready

This is a critical scenario. When the app is killed and a VoIP push arrives:

**iOS Solution — Persist and Retrieve**:
1. `PushKitManager` receives the VoIP push in `didReceiveIncomingPushWith` (`ios/App/App/VoIP/Managers/PushKitManager.swift`)
2. It must report to CallKit within 5 seconds (Apple requirement)
3. Call data is persisted to `UserDefaults` (`PushKitManager.swift:697-733`)
4. When WebView finally loads and the `useTelnyxVoip` hook mounts, it calls `TelnyxVoip.getPendingIncomingCall()` which reads from `UserDefaults`

```swift
// ios/App/App/VoIP/TelnyxVoipPlugin.swift:520-546
@objc func getPendingIncomingCall(_ call: CAPPluginCall) {
    // Reads persisted call from UserDefaults, returns to JS, clears persistence
}
```

**Android Solution — Native Activity Bypass**:
1. `Z360FirebaseMessagingService` receives FCM push even when app is killed (`android/.../fcm/Z360FirebaseMessagingService.kt`)
2. ConnectionService creates a `Z360Connection` and launches `IncomingCallActivity` — a **pure native Activity** — no WebView needed
3. If user answers, `MainActivity` handles the answer intent in `onCreate()` / `onNewIntent()`
4. WebView loads in parallel; native code doesn't wait for it

```kotlin
// android/.../MainActivity.kt:115-187
// Answer from killed state: Uses ProcessLifecycleOwner.lifecycleScope
// to survive activity destruction, handles org switch if needed,
// launches ActiveCallActivity independently of WebView state
```

**JavaScript Cold-Start Safety** — Module-level listeners registered before React mounts:

```typescript
// resources/js/hooks/use-push-notifications.ts:33-61
// These register at module load time, capturing taps during cold start
if (Capacitor.isNativePlatform()) {
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const link = action.notification.data?.link;
        if (link) visitDeepLink(link);  // Queues until Inertia router is ready
    });
}
```

The `visitDeepLink()` function handles the timing gap:
```typescript
// resources/js/hooks/use-push-notifications.ts:22-31
function visitDeepLink(link: string) {
    if (routerReady) {
        router.visit(link);
    } else {
        const off = router.on('navigate', () => {
            off();
            router.visit(link);
        });
    }
}
```

---

## 3. Plugin Registration

### Android Registration

The plugin is registered explicitly in `MainActivity.onCreate()` **before** calling `super.onCreate()`:

```kotlin
// android/.../MainActivity.kt:39
registerPlugin(TelnyxVoipPlugin::class.java)
```

The plugin class uses `@CapacitorPlugin` annotation:

```kotlin
// android/.../voip/TelnyxVoipPlugin.kt:33-49
@CapacitorPlugin(
    name = "TelnyxVoip",
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
        Permission(strings = [Manifest.permission.READ_PHONE_STATE], alias = "phoneState")
    ]
)
class TelnyxVoipPlugin : Plugin() { ... }
```

Methods are exposed via `@PluginMethod` annotation (17 methods total).

### iOS Registration

The plugin is registered via `capacitorDidLoad()`:

```swift
// ios/App/App/Z360BridgeViewController.swift:184-190
override func capacitorDidLoad() {
    bridge?.registerPluginType(TelnyxVoipPlugin.self)
}
```

The plugin class uses `@objc` + `CAPBridgedPlugin` pattern:

```swift
// ios/App/App/VoIP/TelnyxVoipPlugin.swift:17-47
@objc(TelnyxVoipPlugin)
public class TelnyxVoipPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TelnyxVoipPlugin"
    public let jsName = "TelnyxVoip"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        // ... 20 methods total
    ]
}
```

Each method requires the `@objc` attribute for Objective-C runtime bridging (required by Capacitor's message dispatch).

### Registration Summary

| Aspect | Android | iOS |
|--------|---------|-----|
| Registration point | `MainActivity.onCreate()` | `Z360BridgeViewController.capacitorDidLoad()` |
| Annotation | `@CapacitorPlugin(name = "TelnyxVoip")` | `@objc(TelnyxVoipPlugin)` + `CAPBridgedPlugin` |
| Method exposure | `@PluginMethod` | `@objc` + explicit `pluginMethods` array |
| Name matching | `name` in annotation → JS `registerPlugin('TelnyxVoip')` | `jsName` property → JS `registerPlugin('TelnyxVoip')` |
| Permissions | Declared in `@CapacitorPlugin.permissions` | Handled at OS level (Info.plist) |

---

## 4. Event System (Native → JavaScript)

### notifyListeners Pattern

Both platforms use `notifyListeners(eventName, data)` to push events from native code to JavaScript listeners:

**Android** (`android/.../voip/TelnyxVoipPlugin.kt`):
```kotlin
// Lines 657-667: Incoming call event
notifyListeners("incomingCall", JSObject().apply {
    put("callId", callId)
    put("callerNumber", callerNumber)
    put("callerName", callerName)
    put("timestamp", timestamp)
})

// Lines 754-758: Connection state
notifyListeners("connected", JSObject())
notifyListeners("disconnected", JSObject())

// Lines 775: Call quality metrics
notifyListeners("callQuality", JSObject().apply {
    put("quality", quality); put("mos", mos); put("jitter", jitter); put("rtt", rtt)
})
```

**iOS** (`ios/App/App/VoIP/TelnyxVoipPlugin.swift`):
```swift
// Lines 684-689: Connection state
notifyListeners("connected", data: [:])
notifyListeners("disconnected", data: [:])

// Lines 721-726: Incoming call with display info lookup
notifyListeners("incomingCall", data: data)

// Lines 829-844: Audio state changes
notifyListeners("muteStateChanged", data: ["muted": muted])
notifyListeners("holdStateChanged", data: ["onHold": onHold])
notifyListeners("speakerStateChanged", data: ["enabled": enabled])
notifyListeners("audioRouteChanged", data: ["route": route])
```

### addListener Pattern (JavaScript Side)

The React hook `useTelnyxVoip` sets up typed listeners:

```typescript
// resources/js/plugins/use-telnyx-voip.ts:98-141
const setupListeners = async () => {
  const connectedListener = await TelnyxVoip.addListener('connected', () => {
    setIsConnected(true);
  });
  listenersRef.current.push(connectedListener);

  const incomingCallListener = await TelnyxVoip.addListener('incomingCall', (data) => {
    options.onIncomingCall?.(data);
    if (data?.callId && data?.callerNumber) {
      setPendingIncomingDisplay({ callId: data.callId, callerNumber: data.callerNumber });
      router.reload({ only: ['lazy.call.identifier'], ... });
    }
  });
  listenersRef.current.push(incomingCallListener);
};
```

### Full Event Catalog

| Event | Data | Source |
|-------|------|--------|
| `connected` | `{}` | SDK WebSocket connected |
| `disconnected` | `{}` | SDK WebSocket disconnected |
| `incomingCall` | `{ callId, callerNumber, callerName }` | VoIP push received |
| `callStarted` | `{ callId }` | Outgoing call initiated |
| `callRinging` | `{ callId }` | Remote party ringing |
| `callAnswered` | `{ callId }` | Call connected |
| `callEnded` | `{ callId }` | Call terminated |
| `callError` | `{ error }` | Call failure |
| `callDurationUpdated` | `{ elapsedSeconds }` | Periodic timer |
| `muteStateChanged` | `{ muted }` | Microphone toggled |
| `holdStateChanged` | `{ onHold }` | Hold toggled (iOS) |
| `speakerStateChanged` | `{ enabled }` | Speaker toggled (iOS) |
| `audioRouteChanged` | `{ route }` | Audio output changed (iOS) |
| `callQuality` | `{ quality, mos, jitter, rtt }` | Periodic quality metrics |
| `networkStatusChanged` | `{ status }` | Network state change |
| `networkTransition` | `{ from, to }` | Network type change (iOS) |
| `callDropped` | `{ callId, reason }` | Call dropped (iOS) |
| `callRejectedBusy` | `{ callId, reason }` | Busy rejection (iOS) |
| `orphanCallRecovered` | `{ callId, ... }` | Crash recovery (iOS) |
| `orgSwitchStarted` | `{ organizationId }` | Org switch begins (iOS) |
| `orgSwitchCompleted` | `{ organizationId }` | Org switch done (iOS) |
| `orgSwitchFailed` | `{ error, organizationId }` | Org switch error (iOS) |

---

## 5. Push Notification Plugin

### @capacitor/push-notifications Integration

Z360 uses `@capacitor/push-notifications` for standard (non-VoIP) push notifications. VoIP pushes use a separate native path.

**Architecture**:
```
┌──────────────────────────────────────────────────────────┐
│                  Push Notification Flows                   │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  VoIP Pushes (call alerts)         Standard Pushes        │
│  ─────────────────────            ────────────────         │
│  iOS: PushKit (VoIP type)         iOS: APNs + FCM         │
│  Android: FCM data-only           Android: FCM             │
│       │                                │                  │
│       ▼                                ▼                  │
│  Native handlers directly:        @capacitor/push-        │
│  - PushKitManager (iOS)           notifications plugin    │
│  - Z360FirebaseMessaging-              │                  │
│    Service (Android)                   ▼                  │
│       │                           JS listeners in         │
│       ▼                           use-push-               │
│  CallKit / ConnectionService      notifications.ts        │
│  → native call UI                      │                  │
│                                        ▼                  │
│                                   LocalNotifications      │
│                                   (foreground display)    │
└──────────────────────────────────────────────────────────┘
```

**Key implementation in `use-push-notifications.ts`** (`resources/js/hooks/use-push-notifications.ts`):

1. **Module-level listeners** (lines 33-61): Registered at import time to capture cold-start taps
2. **Permission handling** (lines 87-97): Checks and requests notification permissions
3. **Token management**: Platform-divergent:
   - Android: FCM token from `registration` event (line 116-130)
   - iOS: FCM token injected from native AppDelegate via custom `iosFCMToken` window event (lines 37-48)
4. **Foreground display** (lines 136-157): Re-schedules as `LocalNotifications` because Capacitor's built-in foreground display creates untappable notifications on Android (no PendingIntent)
5. **Deep link navigation** (lines 22-31): `visitDeepLink()` queues navigation until Inertia router is ready

**Capacitor config for push** (`capacitor.config.ts:69-73`):
```typescript
PushNotifications: {
    // 'alert' omitted: foreground handled via LocalNotifications for tappability
    presentationOptions: ['badge', 'sound'],
}
```

---

## 6. Threading Model

### Android Threading

```
┌─────────────────────────────────────────────────────┐
│                Android Thread Model                  │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Main Thread (UI Thread)                             │
│  ├── WebView / Capacitor Bridge                      │
│  ├── TelnyxVoipPlugin methods                        │
│  ├── CoroutineScope(Dispatchers.Main)                │
│  └── notifyListeners() calls                         │
│                                                      │
│  Background Threads                                  │
│  ├── Telnyx SDK WebSocket (own thread)               │
│  ├── Z360FirebaseMessagingService (FCM thread)       │
│  └── ConnectionService callbacks (system thread)     │
│                                                      │
│  ProcessLifecycleOwner.lifecycleScope                │
│  └── Survives Activity destruction (killed state)    │
│       [android/.../MainActivity.kt:130]              │
└─────────────────────────────────────────────────────┘
```

**Key details**:
- `TelnyxVoipPlugin` uses `CoroutineScope(SupervisorJob() + Dispatchers.Main)` for all async work (`TelnyxVoipPlugin.kt:68`)
- SDK delegate callbacks arrive on background threads; the plugin's coroutine scope dispatches to Main before calling `notifyListeners()`
- `Z360FirebaseMessagingService.onMessageReceived()` runs on a background thread managed by FCM
- `ConnectionService` callbacks (`onCreateIncomingConnection`) run on the main thread
- `ProcessLifecycleOwner.lifecycleScope` is used for operations that must survive Activity destruction (answer from killed state — `MainActivity.kt:130`)

### iOS Threading

```
┌─────────────────────────────────────────────────────┐
│                 iOS Thread Model                     │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Main Thread                                         │
│  ├── WebView / Capacitor Bridge                      │
│  ├── TelnyxVoipPlugin @objc methods                  │
│  ├── CallKit CXProviderDelegate                      │
│  │   (provider.setDelegate(self, queue: nil))        │
│  │   [CallKitManager.swift:64]                       │
│  └── notifyListeners() calls                         │
│                                                      │
│  Background Threads                                  │
│  ├── Telnyx SDK WebSocket (SDK-managed)              │
│  ├── TelnyxService delegate callbacks                │
│  │   → DispatchQueue.main.async { ... }              │
│  ├── PushKit didReceiveIncomingPush (PushKit queue)   │
│  └── Network monitor (custom queue)                  │
│                                                      │
│  Serial Queues                                       │
│  └── callsQueue (CallKitManager:47)                  │
│      "com.z360.callkit.calls"                        │
│      Thread-safe call tracking                       │
└─────────────────────────────────────────────────────┘
```

**Key details**:
- Capacitor plugin methods are called on the main thread (via `@objc` Objective-C dispatch)
- `CXProviderDelegate` is configured with `queue: nil` which means main queue (`CallKitManager.swift:64`)
- Telnyx SDK delegate callbacks (`onSocketConnected`, `onIncomingCall`, etc.) arrive on background threads and are dispatched to main via `DispatchQueue.main.async` (`TelnyxService.swift`)
- `CallKitManager` uses a dedicated serial queue (`callsQueue`) for thread-safe call tracking
- PushKit delegate `didReceiveIncomingPush` runs on the PushKit queue (not main thread)
- `VoipStore` is a Swift Actor — provides compile-time thread safety for shared state (`VoipStore.swift`)
- Plugin methods use Swift `Task { }` for async/await, which runs on the main actor by default

### Thread Safety Concerns

1. **Telnyx SDK → Plugin boundary**: SDK callbacks come on background threads. Both platforms dispatch to main before calling `notifyListeners()`. This is correct.
2. **FCM/PushKit → native services**: Push callbacks arrive on system threads. Native code handles synchronization before touching UI or shared state.
3. **VoipStore access**: iOS uses Swift Actor (compile-time safety). Android uses `synchronized` blocks.
4. **CallKit audio session**: The `didActivate(audioSession:)` callback must enable SDK audio — called on main thread, which is correct since Telnyx SDK expects main-thread audio activation.

---

## 7. Critical Separation: Native VoIP vs Capacitor Bridge

This is the most important architectural insight: **VoIP call handling on mobile bypasses Capacitor/WebView entirely for the critical call path. Capacitor is used for control, notifications, navigation, and WebView content — but not for call establishment or media.**

### What Happens Natively (No WebView Required)

```
┌──────────────────────────────────────────────────────────────────┐
│           NATIVE-ONLY CALL PATH (No Capacitor/WebView)           │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  INCOMING CALL (app killed):                                      │
│  1. VoIP push arrives (PushKit/FCM)                               │
│  2. Native handler processes push                                 │
│     - iOS: PushKitManager → CallKit reportIncomingCall()          │
│     - Android: FCM Service → ConnectionService → Z360Connection   │
│  3. Native incoming call UI shown                                 │
│     - iOS: CallKit system UI (lock screen capable)                │
│     - Android: IncomingCallActivity (full-screen notification)    │
│  4. Telnyx SDK connects with persisted credentials                │
│     - iOS: VoipStore reads from Keychain                          │
│     - Android: VoipStore reads from SharedPreferences             │
│  5. User answers → SDK answers call → audio established           │
│     - iOS: CallKit didActivate(audioSession) → SDK enableAudio    │
│     - Android: ConnectionService.onAnswer() → SDK accept          │
│  6. Native active call UI shown                                   │
│     - Android: ActiveCallActivity (pure native)                   │
│     - iOS: CallKit manages system UI                              │
│                                                                   │
│  THE WEBVIEW MAY NOT EVEN EXIST DURING STEPS 1-6                 │
│                                                                   │
│  OUTGOING CALL (app active):                                      │
│  1. JS calls TelnyxVoip.makeCall() → Capacitor bridge             │
│  2. Native plugin calls Telnyx SDK                                │
│     - iOS: Z360VoIPService.makeCall() → TelnyxService → SDK      │
│     - Android: TelnyxViewModel.sendInvite() → SDK                │
│  3. SDK handles WebRTC negotiation, media setup                   │
│  4. Native active call UI shown for ongoing call management       │
│                                                                   │
│  KEY NATIVE COMPONENTS:                                           │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐ │
│  │ Telnyx SDK       │  │ CallKit (iOS)    │  │ ConnectionService│ │
│  │ (WebRTC + SIP)   │  │ / CXProvider     │  │ (Android)       │ │
│  └────────┬────────┘  └────────┬─────────┘  └────────┬────────┘ │
│           │                    │                      │          │
│           ▼                    ▼                      ▼          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ VoipStore (persisted credentials, call state, display info) │ │
│  │ iOS: Keychain + UserDefaults | Android: SharedPreferences   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### What Uses Capacitor Bridge

```
┌──────────────────────────────────────────────────────────────────┐
│            CAPACITOR BRIDGE USAGE (WebView Required)              │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  1. CONTROL COMMANDS (JS → Native):                               │
│     - TelnyxVoip.connect() / disconnect()   (session management) │
│     - TelnyxVoip.makeCall()                 (outbound calls)     │
│     - TelnyxVoip.setMute/setSpeaker/setHold (mid-call controls) │
│     - TelnyxVoip.setCallDisplayInfo()       (contact resolution) │
│     - TelnyxVoip.setCurrentOrganization()   (org context)        │
│                                                                   │
│  2. STATE QUERIES (JS → Native → JS):                             │
│     - TelnyxVoip.isConnected()                                   │
│     - TelnyxVoip.getPendingIncomingCall()   (cold start recovery)│
│     - TelnyxVoip.getNetworkStatus()                              │
│     - TelnyxVoip.getFcmToken()                                   │
│                                                                   │
│  3. EVENT NOTIFICATIONS (Native → JS):                            │
│     - incomingCall, callAnswered, callEnded  (state sync)        │
│     - connected, disconnected                (connection state)  │
│     - callQuality, networkStatusChanged      (monitoring)        │
│     - muteStateChanged, speakerStateChanged  (UI sync)           │
│                                                                   │
│  4. PUSH NOTIFICATIONS (non-VoIP):                                │
│     - @capacitor/push-notifications for messages, reminders      │
│     - Token registration with backend                            │
│     - Deep link navigation on tap                                │
│                                                                   │
│  5. UI/UX:                                                        │
│     - Platform detection (Capacitor.isNativePlatform())          │
│     - Keyboard handling (@capacitor/keyboard)                    │
│     - Status bar configuration                                   │
│     - App appearance/theme                                        │
└──────────────────────────────────────────────────────────────────┘
```

### Why This Separation Matters

1. **Reliability**: Incoming calls work even when app is killed (WebView doesn't exist). Native code handles the entire call setup path.
2. **Performance**: No WebView startup latency in the critical call path. The 5-second iOS CallKit deadline would be impossible to meet if waiting for WebView.
3. **OS Integration**: CallKit (iOS) and ConnectionService (Android) require native code. They provide lock-screen UI, Bluetooth integration, and car system support.
4. **Crash Recovery**: Native VoipStore persists call state independently. If WebView crashes, active calls survive. Orphan call recovery detects and cleans up stale state.
5. **Multi-tenancy**: Native VoipStore persists organization context, enabling cross-org call answering without WebView.

### Two-Push Architecture

Both platforms implement a two-push synchronization system:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ Z360 Backend│────▶│   Push #1    │────▶│ Caller info  │
│             │     │ (Z360 push)  │     │ name, avatar │
│             │     └──────────────┘     │ org context  │
│             │                          └──────┬──────┘
│             │     ┌──────────────┐            │
│             │────▶│   Push #2    │────▶ PushCorrelator /
│  Telnyx     │     │ (Telnyx SDK) │     PushSynchronizer
│  backend    │     └──────────────┘     merges both
└─────────────┘                          │
                                         ▼
                                    Native call UI
                                    with full info
```

- **iOS** (`PushKitManager.swift:156-275`): `PushCorrelator` waits up to 1.5s for both pushes
- **Android** (`Z360FirebaseMessagingService.kt:291-299`): `PushSynchronizer` uses `CompletableDeferred` with 500ms timeout

---

## Capacitor Configuration

**`capacitor.config.ts`** — Key settings:

```typescript
const config: CapacitorConfig = {
    appId: 'com.z360.app',
    appName: 'Z360',
    webDir: 'public',                    // Built web assets directory
    appendUserAgent: 'Z360Capacitor',    // Server-side platform detection
    server: serverUrl ? {
        url: serverUrl,                  // Remote dev server (CAPACITOR_SERVER_URL)
        cleartext: isDev,                // Allow HTTP in dev
        androidScheme: isDev ? 'http' : 'https',
    } : undefined,
    ios: {
        contentInset: 'never',           // CSS env(safe-area-inset-*) handles insets
        backgroundColor: '#FFFFFF',       // Prevents white flash on launch
    },
    plugins: {
        StatusBar: { overlaysWebView: true, style: 'DEFAULT' },
        Keyboard: { resize: KeyboardResize.None, resizeOnFullScreen: true },
        PushNotifications: {
            presentationOptions: ['badge', 'sound'],  // No 'alert' — handled via LocalNotifications
        },
    },
};
```

### iOS Startup Performance Fix

A critical finding from the iOS implementation (`AppDelegate.swift:28-50`):

```swift
// ONLY PushKit and minimal CallKit in didFinishLaunchingWithOptions
func application(_ application: UIApplication, didFinishLaunchingWithOptions ...) -> Bool {
    PushKitManager.shared.initialize()
    Z360VoIPService.shared.setupMinimal(callKitManager: CallKitManager.shared)
    return true
}

// ALL heavy init deferred to sceneDidBecomeActive
// (AVAudioSession, Firebase, NetworkMonitor)
// WHY: AVAudioSession triggers audio daemon which starves WebKit IPC,
// causing 37-43 second launch times
```

This deferred initialization pattern is essential because iOS's `AVAudioSession` configuration triggers the audio daemon, which blocks the WebKit IPC pipe and causes catastrophic 37-43 second launch delays if done during `didFinishLaunchingWithOptions`.

---

## Summary

| Aspect | Implementation | Key Files |
|--------|---------------|-----------|
| Plugin definition (TS) | `registerPlugin<TelnyxVoipPlugin>('TelnyxVoip')` with web fallback | `resources/js/plugins/telnyx-voip.ts` |
| Plugin (Android) | `@CapacitorPlugin` + `@PluginMethod` on `Plugin` subclass | `android/.../voip/TelnyxVoipPlugin.kt` |
| Plugin (iOS) | `@objc` + `CAPBridgedPlugin` with explicit method array | `ios/App/App/VoIP/TelnyxVoipPlugin.swift` |
| Plugin registration (Android) | `registerPlugin()` in `MainActivity.onCreate()` | `android/.../MainActivity.kt` |
| Plugin registration (iOS) | `bridge?.registerPluginType()` in `capacitorDidLoad()` | `ios/App/App/Z360BridgeViewController.swift` |
| Native → JS events | `notifyListeners(eventName, data)` (22+ event types) | Both plugin files |
| JS → Native calls | Promise-based via `call.resolve()` / `call.reject()` | Both plugin files |
| Push notifications | `@capacitor/push-notifications` + `LocalNotifications` for foreground | `resources/js/hooks/use-push-notifications.ts` |
| VoIP pushes | Native-only: PushKit (iOS) / FCM data-only (Android) | `PushKitManager.swift`, `Z360FirebaseMessagingService.kt` |
| Threading | Main thread for bridge + notifyListeners; background for SDK/push | All native files |
| Cold start | Persist to UserDefaults/SharedPreferences → read via `getPendingIncomingCall()` | Plugin files + VoipStore |
| Platform detection | `Capacitor.isNativePlatform()` / `Capacitor.getPlatform()` | `resources/js/utils/platform.ts` |
| Capacitor config | `capacitor.config.ts` with server URL, keyboard, push settings | `capacitor.config.ts` |
