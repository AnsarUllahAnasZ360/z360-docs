---
title: iOS Current State
---

# iOS VoIP Current State — Z360

![iOS Component Diagram](/diagrams/ios-component-diagram.jpeg)

> **Scope**: Complete documentation of the current Z360 iOS VoIP implementation across 25 Swift files (10,724 lines).
> **Date**: 2026-02-08
> **Sources**: voip-ios skill (`.claude/skills/voip-ios/`), Telnyx iOS SDK pack (`telnyx-ios-sdk.xml`), prerequisite whitepaper documents.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Component Documentation](#3-component-documentation)
   - 3.1 [AppDelegate.swift](#31-appdelegateswift)
   - 3.2 [SceneDelegate.swift](#32-scenedelegateswift)
   - 3.3 [VoipStore.swift](#33-voipstoreswift)
   - 3.4 [KeychainManager.swift](#34-keychainmanagerswift)
   - 3.5 [PushCorrelator.swift](#35-pushcorrelatorswift)
   - 3.6 [AudioManager.swift](#36-audiomanagerswift)
   - 3.7 [NetworkMonitor.swift](#37-networkmonitorswift)
   - 3.8 [CallKitManager.swift](#38-callkitmanagerswift)
   - 3.9 [PushKitManager.swift](#39-pushkitmanagerswift)
   - 3.10 [TelnyxService.swift](#310-telnyxserviceswift)
   - 3.11 [OrganizationSwitcher.swift](#311-organizationswitcherswift)
   - 3.12 [Z360VoIPService.swift](#312-z360voipserviceswift)
4. [Supporting Components](#4-supporting-components)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Telnyx SDK Integration Patterns](#6-telnyx-sdk-integration-patterns)
7. [Known Issues and Technical Debt](#7-known-issues-and-technical-debt)
8. [Architectural Patterns Summary](#8-architectural-patterns-summary)

---

## 1. Executive Summary

The Z360 iOS VoIP implementation is a **native Swift layer** that operates independently of the Capacitor WebView. It provides full VoIP calling capability using the Telnyx WebRTC SDK, Apple's CallKit for system call UI, and PushKit for VoIP push notification handling.

### Key Characteristics

- **25 Swift files** totaling **10,636 lines** of native code, plus 1 Info.plist
- **Singleton-based architecture** with a central orchestrator (`Z360VoIPService`) coordinating all VoIP components
- **Two-phase startup** pattern prevents WebKit IPC starvation (37-43s freeze)
- **Two-push synchronization** via `PushCorrelator` actor correlates Z360 backend pushes with Telnyx SDK pushes
- **Cross-organization call support** with credential regeneration, SDK reconnect, and rollback on failure
- **Swift Actor isolation** for thread-safe storage (`VoipStore`) and push correlation (`PushCorrelator`)
- **7 delegate protocols** define component communication boundaries

### Component Size Distribution

| Component | Lines | Role |
|-----------|------:|------|
| Z360VoIPService.swift | 2,253 | Central orchestrator |
| PushKitManager.swift | 949 | VoIP push handling |
| VoIPLogger.swift | 711 | Structured logging |
| TelnyxService.swift | 667 | Telnyx SDK wrapper |
| PushCorrelator.swift | 611 | Two-push synchronization |
| OrganizationSwitcher.swift | 481 | Cross-org switching |
| CallKitManager.swift | 456 | System call UI |
| AudioManager.swift | 445 | Audio routing |
| NetworkMonitor.swift | 419 | Connectivity monitoring |
| VoipStore.swift | 343 | Persistent state |
| CallQualityMonitor.swift | 286 | Quality metrics |
| AppDelegate.swift | 336 | App lifecycle |
| Others (13 files) | ~1,679 | Utilities, models, plugin |

---

## 2. Architecture Overview

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│                    AppDelegate                           │
│  Phase 1: PushKitManager.initialize() +                 │
│           Z360VoIPService.setupMinimal()                │
│  Phase 2: performDeferredInitialization() (from Scene)  │
└───────────────┬─────────────────────────────────────────┘
                │ triggers Phase 2
┌───────────────▼─────────────────────────────────────────┐
│                   SceneDelegate                          │
│  sceneDidBecomeActive → AppDelegate.performDeferred()   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              Z360VoIPService (Orchestrator)               │
│  Implements: TelnyxServiceDelegate, CallKitManagerDelegate│
│             CallQualityMonitorDelegate,                   │
│             CallTimerManagerDelegate, NetworkMonitorDelegate│
├─────────────────────────────────────────────────────────┤
│  Lazy Dependencies:                                      │
│  ├── TelnyxService (SDK wrapper)                        │
│  ├── VoipStore (Actor - Keychain + UserDefaults)        │
│  ├── ActionGuard (Actor - double-tap prevention)        │
│  ├── ActiveCallGuard (Actor - single-call enforcement)  │
│  ├── NotificationHelper (missed calls)                  │
│  ├── CallTimerManager (call duration)                   │
│  ├── CallQualityMonitor (MOS/jitter/RTT)               │
│  └── NetworkMonitor (WiFi/Cellular transitions)         │
│  Weak References:                                        │
│  ├── CallKitManager (set via setup)                     │
│  └── pluginDelegate: Z360VoIPServicePluginDelegate      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              PushKitManager (Push Handling)               │
│  Implements: PKPushRegistryDelegate                      │
│  Dependencies:                                           │
│  ├── PushCorrelator (Actor - two-push sync)             │
│  ├── VoipStore (Actor)                                  │
│  ├── KeychainManager (sync credential access)           │
│  ├── CallKitManager (weak - report calls)               │
│  └── TelnyxService (weak - process payloads)            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│           TelnyxVoipPlugin (Capacitor Bridge)            │
│  CAPBridgedPlugin — 21 @objc methods                    │
│  ├── Z360VoIPService.shared (via pluginDelegate)        │
│  ├── AudioManager.shared                                │
│  └── TelnyxService.shared                               │
└─────────────────────────────────────────────────────────┘
```

### Delegate Protocol Map

| Protocol | Implemented By | Events |
|----------|---------------|--------|
| `TelnyxServiceDelegate` | Z360VoIPService | connect, disconnect, ready, error, incoming call, call state, remote ended |
| `CallKitManagerDelegate` | Z360VoIPService | reset, answer, start, end, hold, mute, DTMF, audio activate/deactivate |
| `AudioManagerDelegate` | TelnyxVoipPlugin | mute, hold, speaker state changes; audio route changes |
| `NetworkMonitorDelegate` | Z360VoIPService | status change, network transition, timeout |
| `CallQualityMonitorDelegate` | Z360VoIPService | quality update (MOS, jitter, RTT, packet loss) |
| `CallTimerManagerDelegate` | Z360VoIPService | duration tick (every second) |
| `Z360VoIPServicePluginDelegate` | TelnyxVoipPlugin | all VoIP events forwarded to JavaScript (22+ event types) |

---

## 3. Component Documentation

### 3.1 AppDelegate.swift

**File**: `ios/App/App/AppDelegate.swift` (336 lines)
**Skill reference**: `files.md:10263-10598`

#### Purpose
Application lifecycle coordinator implementing the **two-phase startup** pattern to prevent WebKit IPC starvation.

#### Phase 1: `didFinishLaunchingWithOptions` (lines 10292-10313)
Performs **absolute minimum** work (~50ms):
1. `PushKitManager.shared.initialize()` — Registers for PushKit VoIP pushes (Apple mandate)
2. `Z360VoIPService.shared.setupMinimal(callKitManager:)` — Stores weak reference to CallKitManager only
3. `UNUserNotificationCenter.current().delegate = self` — Lightweight notification delegate

**Critical constraint**: No `AVAudioSession.setCategory()`, no Firebase, no network monitoring. These trigger audio daemon initialization which starves WebKit's IPC channels.

#### Phase 2: `performDeferredInitialization()` (lines 10318-10353)
Called from `SceneDelegate.sceneDidBecomeActive()` after WebKit has loaded:
1. `configureAudioSessionForVoIP()` — `.playAndRecord` category, `.voiceChat` mode, Bluetooth options
2. `Z360VoIPService.shared.startNetworkMonitoringIfNeeded()` — Starts NWPathMonitor
3. `initializeFirebase()` — Configures Crashlytics, Analytics (background queue)
4. `checkSessionExpiry()` — 7-day VoIP token TTL check
5. `cleanupOrphanCallState()` — Crash recovery for calls active when app was killed

#### Additional Responsibilities
- **Firebase initialization** (lines 10431-10479): Validates `GoogleService-Info.plist` is not placeholder, initializes on background queue, sets `VoIPLogger.setFirebaseReady()`
- **Session expiry** (lines 10357-10396): 7-day window on VoIP token; if expired, clears VoIP data but keeps web login
- **Orphan call cleanup** (lines 10398-10428): Reads `PersistableCallState` from UserDefaults, delegates to `Z360VoIPService.recoverOrphanCallState()`
- **MessagingDelegate** (line 10543): Handles FCM token refresh
- **UNUserNotificationCenterDelegate** (line 10557): Shows notifications as banners when in foreground

#### Issues/Notes
- Audio session configuration is `try-catch` with non-fatal error — retried when actual call is answered
- Session expiry check reads UserDefaults synchronously AND asynchronously (dual path for synchronous return value)

---

### 3.2 SceneDelegate.swift

**File**: `ios/App/App/SceneDelegate.swift` (89 lines)
**Skill reference**: `files.md:10695-10770`

#### Purpose
Triggers Phase 2 of the two-phase startup when the scene becomes active.

#### Key Method: `sceneDidBecomeActive()` (lines 10733-10751)
```swift
if let appDelegate = UIApplication.shared.delegate as? AppDelegate {
    appDelegate.performDeferredInitialization()
}
```

**Why here**: By `sceneDidBecomeActive`:
1. WebKit processes have already initialized (no IPC starvation)
2. First frame has rendered (UI is responsive)
3. System daemons are available (no contention)

#### Other Lifecycle Methods
- `scene(_:willConnectTo:)` — Handles URL contexts from connection options (deep links)
- `sceneDidDisconnect()` — Logs only
- `sceneWillResignActive()` — Logs only
- `sceneWillEnterForeground()` — Logs only
- `sceneDidEnterBackground()` — Logs only

#### Notes
- All VoIP initialization is explicitly deferred to here — the plugin's `capacitorDidLoad()` only sets weak delegate references
- Deep link handling extracts URL from `connectionOptions.urlContexts`

---

### 3.3 VoipStore.swift

**File**: `ios/App/App/VoIP/Services/VoipStore.swift` (343 lines)
**Skill reference**: `files.md:3672-4014`

#### Purpose
Thread-safe persistence layer using Swift `actor` isolation. Provides unified access to Keychain (sensitive data) and UserDefaults (non-sensitive metadata).

#### Actor Design
```swift
actor VoipStore {
    static let shared = VoipStore()
    private let userDefaults = UserDefaults.standard
    private let keychain = KeychainManager()
    // All methods are actor-isolated
}
```

#### Storage Categories

**1. Organization Context** (UserDefaults):
- `setCurrentOrganization(id:name:)` / `getCurrentOrganizationId()` / `clearCurrentOrganization()`
- Used for cross-org call detection

**2. Call Display Info** (In-Memory, Dual-Index):
- Primary: `callDisplayInfoByUUID: [UUID: CallDisplayInfo]`
- Secondary: `callDisplayInfoByPhone: [String: CallDisplayInfo]` (normalized last 10 digits)
- `getCallDisplayInfoWithFallback(uuid:phoneNumber:)` — tries UUID, then phone number
- Handles case where Telnyx SDK and Z360 backend have different call IDs

**3. Incoming Call Metadata** (In-Memory):
- `incomingCallMeta: [UUID: IncomingCallMeta]` — stores organizationId, callerNumber for cross-org detection
- `isCrossOrgCall(uuid:)` — compares call's orgId with current org

**4. SIP Credentials** (Keychain):
- `saveCredentials(_ credentials: SIPCredentials)` — writes sipUsername, sipPassword, callerIdName, callerIdNumber to Keychain
- `getCredentials()` — reads from Keychain
- `clearCredentials()` — deletes all credential entries

**5. VoIP Token** (UserDefaults):
- `saveVoIPToken(_ token: String)` — hex-encoded APNs token + timestamp
- `getVoIPToken()` / `getVoIPTokenDate()`

**6. Active Call State** (Memory + UserDefaults):
- `saveActiveCallState(_ state: PersistableCallState)` — persisted for crash recovery
- Memory-first with UserDefaults fallback
- `clearActiveCallState()` — clears both

**7. `clearAll()`**: Wipes everything — in-memory collections, Keychain credentials, UserDefaults entries

#### Data Types

```swift
struct CallDisplayInfo: Codable, Sendable {
    let callerName: String
    let callerNumber: String
    let avatarUrl: String?
    let organizationId: String?
    let organizationName: String?
    let isCrossOrg: Bool
}

struct IncomingCallMeta: Codable, Sendable {
    let callId: String
    let organizationId: String?
    let organizationName: String?
    let callerNumber: String
}

struct SIPCredentials: Codable, Sendable {
    let sipUsername: String
    let sipPassword: String
    let callerIdName: String?
    let callerIdNumber: String?
}

struct PersistableCallState: Codable, Sendable {
    let callId: UUID
    let direction: CallDirection
    let callerNumber: String
    let callerName: String?
    let startTime: Date
}
```

---

### 3.4 KeychainManager.swift

**File**: `ios/App/App/VoIP/Utils/KeychainManager.swift` (111 lines)
**Skill reference**: `files.md:7035-7138`

#### Purpose
Thread-safe Keychain wrapper for securely storing SIP credentials.

#### Implementation
- Service identifier: `"com.z360.voip"`
- Uses `kSecAttrAccessibleWhenUnlocked` — credentials accessible when device is unlocked
- Implements delete-before-save pattern (deletes existing, then adds new)
- String operations: `save(_:forKey:)`, `get(_:) -> String?`, `delete(_:)`, `deleteAll()`

#### Error Types
```swift
enum KeychainError: Error {
    case saveFailed(OSStatus)
    case readFailed(OSStatus)
    case deleteFailed(OSStatus)
    case encodingFailed
    case decodingFailed
}
```

#### Notes
- Used directly by `PushKitManager` for synchronous credential access during push handling (cannot `await` actor)
- `VoipStore` wraps `KeychainManager` for actor-isolated access from async contexts

---

### 3.5 PushCorrelator.swift

**File**: `ios/App/App/VoIP/Services/PushCorrelator.swift` (611 lines)
**Skill reference**: `files.md:2386-2996`

#### Purpose
Coordinates the **two-push synchronization** system. Each incoming call generates two independent pushes:
1. **Z360 Push** (via APNs): Rich caller info (name, avatar, organization)
2. **Telnyx Push** (via PushKit): Call control metadata (call ID, signaling server)

The `PushCorrelator` matches them by normalized phone number (last 10 digits) within a configurable timeout.

#### Actor Design
```swift
actor PushCorrelator {
    static let shared = PushCorrelator()
    private var pendingByPhone: [String: SyncEntry] = [:]       // Primary index
    private var pendingByZ360UUID: [UUID: String] = [:]          // UUID -> phone
    private var pendingByTelnyxId: [String: String] = [:]        // Telnyx ID -> phone
}
```

#### Key Data Types

```swift
struct Z360PushData: Sendable {
    let callId: UUID?, callerName: String, callerNumber: String
    let avatarUrl: String?, organizationId: String?, organizationName: String?
    let arrivalTime: Date
}

struct TelnyxPushData: Sendable {
    let callId: String, callerNumber: String?, callerName: String?
    let arrivalTime: Date
}

struct SyncEntry {
    let normalizedPhone: String
    var z360Data: Z360PushData?
    var telnyxData: TelnyxPushData?
    var continuation: CheckedContinuation<MergedPushData?, Never>?
}
```

#### Processing Flow

**`processZ360Push()`** (lines 2541-2610):
1. Normalizes phone number to last 10 digits
2. Checks if Telnyx push already waiting in `pendingByPhone`
3. If Telnyx present with active continuation → merges immediately, resumes continuation
4. If Telnyx not present → stores Z360 data for later

**`processTelnyxPush()`** (lines 2626-2660):
1. Normalizes phone, stores in `pendingByPhone`
2. Indexes by Telnyx call ID in `pendingByTelnyxId`
3. Does NOT resume continuations (Telnyx push processing happens differently)

**`awaitMergedData()`** (lines 2674-2794):
1. Checks if Z360 data already available → returns immediately with merged data
2. If not available → creates `CheckedContinuation`, stores in SyncEntry
3. Schedules timeout task (configurable, default 500ms-1.5s)
4. On timeout → `handleTimeout()` resumes continuation with nil
5. Returns `PushSyncResult` with merged data or timeout state

#### Merge Logic
- `mergeData(z360:telnyx:)` combines caller info from Z360 with call control from Telnyx
- `validateUUIDConsistency()` logs warnings if Z360 UUID differs from Telnyx call ID

#### Cleanup
- `clearAll()` removes all pending entries (for testing/app reset)
- Direct lookup methods: `getDisplayInfo(byUUID:)`, `getDisplayInfo(byTelnyxId:)`, `getDisplayInfoWithFallback(uuid:telnyxId:callerNumber:)`

---

### 3.6 AudioManager.swift

**File**: `ios/App/App/VoIP/Managers/AudioManager.swift` (445 lines)
**Skill reference**: `files.md:3-448`

#### Purpose
Centralized audio control for in-call features: mute, hold, speaker, DTMF. Implements audio route monitoring for Bluetooth/wired headphone detection.

#### Singleton Pattern
```swift
final class AudioManager: NSObject {
    static let shared = AudioManager()
    weak var delegate: AudioManagerDelegate?
    private let telnyxService = TelnyxService.shared
    private let stateQueue = DispatchQueue(label: "com.z360.audiomanager.state")
}
```

#### Features

**Mute Control (IF-001)** — `setMute(_:)`:
- Calls `telnyxService.getCurrentCall()?.muteUnmuteAudio()` — but only if state actually changes
- Thread-safe via `stateQueue`; emits `delegate?.audioManager(_:didChangeMuteState:)` on main thread

**Hold Control (IF-002, BUG-012 Pattern)** — `setHold(_:)`:
- Calls `telnyxService.getCurrentCall()?.hold()` / `.unhold()`
- **BUG-012 auto-mute**: When placing on hold, saves `wasUserMuted` state and auto-mutes to prevent audio leak
- On unhold, restores previous mute state
- Emits both hold state and mute state change events

**Speaker Control (IF-003)** — `setSpeaker(_:)`:
- Manipulates `AVAudioSession.sharedInstance()` route
- Speaker: `.overrideOutputAudioPort(.speaker)`
- Earpiece: `.overrideOutputAudioPort(.none)`
- **Bluetooth override**: If Bluetooth connected and speaker disabled, routes to Bluetooth

**DTMF Control (IF-004)** — `sendDTMF(_:)`:
- Calls `telnyxService.getCurrentCall()?.dtmf(digit:)`
- Adds haptic feedback via `UIImpactFeedbackGenerator(.medium)`
- Validates digits 0-9, *, #

**Audio Route Monitoring** (lines 328-420):
- Observes `AVAudioSession.routeChangeNotification`
- Classifies routes: `.earpiece`, `.speaker`, `.bluetooth`, `.headphones`, `.unknown`
- Emits `delegate?.audioManager(_:didChangeAudioRoute:previousRoute:)`

**State Reset** — `resetState()`:
- Called on call end, resets muted/hold/speaker/auto-mute flags

#### Audio Route Enum
```swift
enum AudioRoute: String {
    case earpiece, speaker, bluetooth, headphones, unknown
}
```

---

### 3.7 NetworkMonitor.swift

**File**: `ios/App/App/VoIP/Utils/NetworkMonitor.swift` (419 lines)
**Skill reference**: `files.md:7142-7560`

#### Purpose
Monitors network connectivity using `NWPathMonitor` for detecting WiFi ↔ Cellular handoffs during active calls. Implements debouncing to filter brief network blips.

#### Design
```swift
final class NetworkMonitor {
    static let shared = NetworkMonitor()
    private let monitor: NWPathMonitor
    private let monitorQueue = DispatchQueue(label: "com.z360.networkmonitor", qos: .utility)
    private let stateQueue = DispatchQueue(label: "com.z360.networkmonitor.state")
    weak var delegate: NetworkMonitorDelegate?
}
```

#### State Model
```swift
enum NetworkStatus: String { case connected, disconnected, reconnecting }
enum NetworkType: String { case wifi, cellular, wired, other, none }
```

#### Key Features

**Debouncing (ID-001)**: 500ms timer filters brief network blips
- `debounceTimer: DispatchSourceTimer?`
- Path changes queue a debounce; only if status persists after 500ms does delegate fire

**Reconnection Timeout (ID-004)**: 30-second timeout for network loss during active calls
- `reconnectionTimeoutTimer: DispatchSourceTimer?`
- When call is active and network lost → starts 30s timer
- On timeout → `delegate?.networkMonitorDidTimeout(monitor:)` → call should be dropped

**Call-Aware Monitoring**:
- `callDidStart()` — marks call active, enables 30s timeout behavior
- `callDidEnd()` — clears call active flag, cancels timeout timer

**Delegate Events**:
- `networkMonitor(_:didChangeStatus:)` — status changes after debouncing
- `networkMonitor(_:didTransitionFrom:to:)` — WiFi ↔ Cellular handoff
- `networkMonitorDidTimeout(_:)` — 30s reconnection timeout

#### Network Info
```swift
func getNetworkInfo() -> [String: Any] {
    ["status": currentStatus.rawValue, "type": currentNetworkType.rawValue, "isCallActive": isCallActive]
}
```

---

### 3.8 CallKitManager.swift

**File**: `ios/App/App/VoIP/Managers/CallKitManager.swift` (456 lines)
**Skill reference**: `files.md:452-907`

#### Purpose
Manages iOS system call UI via CXProvider and CXCallController. **Must be a singleton** — iOS only allows one CXProvider per app.

#### Configuration
```swift
CXProviderConfiguration {
    localizedName = "Z360"
    supportsVideo = false
    maximumCallGroups = 1
    maximumCallsPerCallGroup = 1
    includesCallsInRecents = true
    supportedHandleTypes = [.phoneNumber]
    iconTemplateImageData = UIImage(named: "CallKitIcon")?.pngData()
}
```

#### Call Tracking
```swift
private var activeCalls: [UUID: CallInfo] = [:]
private let callsQueue = DispatchQueue(label: "com.z360.callkit.calls")  // Serial queue
```

`CallInfo` stores: direction (incoming/outgoing), handle, callerName, startDate.

#### Incoming Call Reporting (lines 559-594)
```swift
func reportIncomingCall(uuid: UUID, handle: String, callerName: String?, hasVideo: Bool, completion: ((Error?) -> Void)?)
```
- Creates `CXCallUpdate` with handle type `.phoneNumber`
- `CXProvider.reportNewIncomingCall()` — **must complete within 5 seconds of PushKit delivery**
- On success: stores in `activeCalls`
- On failure: logs `CXErrorCodeIncomingCallError` details (DND, block list, UUID collision)

#### Call Updates (lines 598-621)
- `updateCallInfo(uuid:callerName:callerNumber:)` — updates display after initial report (when rich Z360 data arrives later)
- `reportOutgoingCallStartedConnecting(uuid:)` / `reportOutgoingCallConnected(uuid:)`

#### User-Initiated Actions (lines 653+)
Via `CXCallController`:
- `requestStartCall(uuid:handle:)` — wraps in `CXStartCallAction` + `CXTransaction`
- `requestEndCall(uuid:)` — wraps in `CXEndCallAction`
- `requestSetHeld(uuid:onHold:)` — wraps in `CXSetHeldCallAction`
- `requestSetMuted(uuid:muted:)` — wraps in `CXSetMutedCallAction`

#### CXProviderDelegate (lines 787-907)

Every action handler delegates to `CallKitManagerDelegate`:
- `performAnswerAction` → `delegate?.callKitManager(_:didReceiveAnswerAction:for:)` — **delegate must call action.fulfill()/fail()**
- `performStartCallAction` → `delegate?.callKitManager(_:didReceiveStartAction:for:handle:)`
- `performEndCallAction` → `delegate?.callKitManager(_:didReceiveEndAction:for:)`
- `performHoldAction` → `delegate?.callKitManager(_:didReceiveHoldAction:for:onHold:)`
- `performMuteAction` → `delegate?.callKitManager(_:didReceiveMuteAction:for:muted:)`
- `performDTMFAction` → `delegate?.callKitManager(_:didReceiveDTMFAction:for:digits:)`
- `performGroupCallAction` → `action.fail()` (conference not supported)

**Audio Session Callbacks (Critical)**:
- `didActivate audioSession` → `delegate?.callKitManagerDidActivateAudioSession(_:audioSession:)` — **enable audio ONLY here**
- `didDeactivate audioSession` → `delegate?.callKitManagerDidDeactivateAudioSession(_:audioSession:)`

#### Notes
- Provider delegate queue is `nil` (main queue) — all callbacks on main thread
- Group call actions always fail (Z360 doesn't support conference calling)

---

### 3.9 PushKitManager.swift

**File**: `ios/App/App/VoIP/Managers/PushKitManager.swift` (949 lines)
**Skill reference**: `files.md:912-1860`

#### Purpose
Handles VoIP push notification registration, reception, and CallKit reporting. Implements the **two-push deduplication** logic and feeds the `PushCorrelator`.

#### Dependencies
- `PKPushRegistry` on `DispatchQueue.main`
- `CallKitManager` (weak), `TelnyxService` (weak), `PushCorrelator`, `VoipStore`, `KeychainManager`

#### Initialization (lines 986-1004)
Called from `AppDelegate.didFinishLaunchingWithOptions`:
1. Gets singleton references to `CallKitManager.shared`, `TelnyxService.shared`
2. Creates `PKPushRegistry(queue: .main)`
3. Sets delegate and registers for `.voIP` type

#### PKPushRegistryDelegate

**Token Handling**:
- Converts push token to hex string
- Stores via `VoipStore.saveVoIPToken()`
- **TODO** (line 1783): Send token to Z360 backend
- **TODO** (line 1836): Notify backend to remove old token on invalidation

**Push Reception**: `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)`:
- Calls `processPushPayload(_:completion:)` which is the main entry point

#### Push Processing Flow (lines 1035-1188)

1. **call_ended push**: If `type == "call_ended"`, finds existing call UUID and reports ended (`.answeredElsewhere`). If no existing call found, reports a fake call and immediately ends it (PushKit mandate).

2. **Payload extraction**: `extractZ360CallInfo(from:)` and `extractTelnyxMetadata(from:)` (parses from `"telnyx"` or `"metadata"` JSON string)

3. **Feed PushCorrelator**: Both Z360 and Telnyx data are fed asynchronously to `PushCorrelator` for two-push tracking

4. **Deduplication**: Checks `callUUIDByPhone` and `callUUIDByTelnyxId` for existing CallKit reports
   - If Z360 push for existing call → updates display info via `callKitManager.updateCallInfo()`
   - If duplicate Telnyx push → processes metadata but doesn't re-report

5. **Telnyx push present**: Reports immediately using Telnyx call ID as UUID (must match SDK), processes Telnyx payload asynchronously

6. **Z360-only push**: Waits up to 1.5s for Telnyx push via `waitForTelnyxData()`, then reports with best available UUID

7. **Fallback**: Unknown payload → reports with placeholder data

#### reportIncomingCall (private) (lines 1192-1281)

1. Detects cross-org synchronously (compares push orgId with UserDefaults `z360_current_org_id`)
2. Formats caller name with org badge for cross-org calls (MO-002)
3. **US-025**: Checks `checkIfAlreadyOnCall()` before reporting
4. Calls `CallKitManager.reportIncomingCall()`
5. On success:
   - If already on call → `handleSimultaneousCallRejection()` (rejects, shows missed call notification)
   - Normal flow → stores display info, persists pending call, registers with `Z360VoIPService`

#### Cold Start Persistence (lines 1627-1646)
```swift
static func getPendingIncomingCall() -> [String: Any]?
static func clearPendingIncomingCall()
```
When app is killed and VoIP push arrives, call data is persisted to UserDefaults. Plugin reads it later when WebView loads.

#### Phone Normalization
```swift
private func normalizePhoneNumber(_ phone: String) -> String {
    let digits = phone.filter { $0.isNumber }
    return String(digits.suffix(10))
}
```

---

### 3.10 TelnyxService.swift

**File**: `ios/App/App/VoIP/Services/TelnyxService.swift` (667 lines)
**Skill reference**: `files.md:3001-3667`

#### Purpose
Wrapper around the Telnyx iOS WebRTC SDK (`TxClient`). Manages connection lifecycle, call control, and delegates.

#### Design
```swift
final class TelnyxService: NSObject {
    static let shared = TelnyxService()
    private var txClient: TxClient?
    private var clientReady = false
    private var sessionId: String?
    private var currentCall: Call?
    weak var delegate: TelnyxServiceDelegate?
    private lazy var callQualityMonitor = CallQualityMonitor.shared
}
```

#### Connection Management

**`connect(sipUser:password:pushToken:logLevel:)`** (lines 3077-3110):
```swift
let txConfig = TxConfig(
    sipUser: sipUser,
    password: password,
    pushDeviceToken: pushToken,
    logLevel: .warning,
    customLogger: TelnyxSDKLogger(),
    forceRelayCandidate: true,      // Avoids iOS "Local Network Access" dialog
    enableQualityMetrics: true       // US-018 call quality
)
let serverConfig = TxServerConfiguration()  // Default production
try txClient?.connect(txConfig: txConfig, serverConfiguration: serverConfig)
```

Key SDK configuration:
- `forceRelayCandidate: true` — forces TURN relay to avoid iOS Local Network permission prompt
- `enableQualityMetrics: true` — enables MOS/jitter/RTT tracking
- `customLogger: TelnyxSDKLogger()` — integrates SDK logs with VoIPLogger/Crashlytics
- Uses `TxServerConfiguration()` default (production `wss://rtc.telnyx.com`)

**`disconnect()`**: Disconnects client, resets all state flags.

**`isConnected()`** / **`isClientReady()`**: Check WebSocket and gateway registration states respectively.

#### Call Management

**`makeCall(callerName:callerNumber:destinationNumber:callId:customHeaders:)`** (lines 3152-3187):
- Guards: `clientReady`, no existing call
- `client.newCall(preferredCodecs: Self.preferredCodecs, debug: true)` — US-041 Opus @ 48kHz
- Sets up quality metrics callback

**`answerFromCallKit(answerAction:)`** (lines 3196-3220):
- Critical safety: if `txClient` is nil, still calls `answerAction.fulfill()` to prevent CallKit hang
- If client not ready, attempts answer anyway (logged as warning)
- Calls `client.answerFromCallkit(answerAction:debug:true)`

**`endCallFromCallKit(endAction:callId:)`** / **`hangup()`**: End call through SDK.

#### Audio Session Management
- `enableAudioSession(audioSession:)` — **must only be called from `CXProviderDelegate.didActivate`**
- `disableAudioSession(audioSession:)` — called from `didDeactivate`
- These delegate to `txClient?.enableAudioSession()` / `txClient?.disableAudioSession()`

#### TxClientDelegate (lines 3457-3600)

All callbacks dispatch to main thread via `DispatchQueue.main.async`:

- `onSocketConnected()` → `delegate?.telnyxServiceDidConnect()`
- `onSocketDisconnected()` → `delegate?.telnyxServiceDidDisconnect()`, resets `clientReady`
- `onClientReady()` → sets `clientReady = true`, `delegate?.telnyxServiceClientReady()`
- `onClientError(error:)` → `delegate?.telnyxService(_:didReceiveError:)`
- `onSessionUpdated(sessionId:)` → stores session ID
- `onIncomingCall(call:)` → stores as `currentCall`, sets up quality callback, `delegate?.telnyxService(_:didReceiveIncomingCall:)`
- `onCallStateUpdated(callState:callId:)` → maps SDK state to Z360 state, cleans up on `.done`
- `onRemoteCallEnded(callId:reason:)` → `cleanupAfterCall()`, `delegate?.telnyxService(_:remoteCallEnded:reason:)`

#### Call Quality Monitoring (US-018)
- `setupQualityCallback(for call:)` — attaches `call.onCallQualityChange` handler
- Forwards metrics to `CallQualityMonitor.processMetrics()`
- `startQualityMonitoring(for:)` / `stopQualityMonitoring()`

#### SDK State Mapping
```swift
private func mapCallState(_ sdkState: CallState) -> Z360CallState {
    // Maps: NEW, CONNECTING, RINGING, ACTIVE, HELD, DONE(reason), RECONNECTING → Z360 states
}
```

#### Preferred Codecs (US-041)
```swift
static let preferredCodecs = [TxCodecCapability(.opus, clockRate: 48000)]
```

---

### 3.11 OrganizationSwitcher.swift

**File**: `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` (481 lines)
**Skill reference**: `files.md:7918-8398`

#### Purpose
Handles cross-organization call switching when an incoming call belongs to a different organization than the user's current context. Must complete within the **5-second CallKit deadline**.

#### Design
```swift
final class OrganizationSwitcher {
    static let shared = OrganizationSwitcher()
    private lazy var voipStore = VoipStore.shared
    private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
    private let switchQueue = DispatchQueue(label: "com.z360.orgswitcher")
}
```

#### Constants
```swift
static let apiBaseURL = "https://app.z360.cloud"
static let switchOrgEndpoint = "/api/voip/switch-org"
static let requestTimeoutSeconds: TimeInterval = 4.0
static let maxSwitchTimeSeconds: TimeInterval = 4.5  // Safety margin for 5s deadline
```

#### switchOrganization() Flow (lines 8090-8172)

Full async flow with rollback:

1. **Capture original context** (US-023): Saves `originalOrgId`, `originalOrgName`, `originalCredentials` for rollback
2. **Begin background task**: `UIApplication.beginBackgroundTask` as safety net
3. **Call API**: `callSwitchOrgAPI(targetOrgId:targetOrgName:)` — POST to `/api/voip/switch-org` with WebView cookies
4. **Check time budget**: Warns if approaching 5s deadline
5. **Store new credentials**: `voipStore.saveCredentials(result.credentials)`
6. **Update org context**: `voipStore.setCurrentOrganization(id:name:)`
7. **Reconnect SDK**: `reconnectTelnyxService(with:credentials)` — disconnect + reconnect + wait for ready
8. **On failure**: `restoreOriginalContext()` — restores original org/credentials

#### API Call (lines 8247-8338)

`callSwitchOrgAPI()`:
1. Gets cookies from `WKWebsiteDataStore.default().httpCookieStore.getAllCookies()`
2. Builds POST request with `{"target_organization_id": Int}`
3. Uses `URLSession.shared.data(for:request)` with 4s timeout
4. Parses JSON response: `sip_username`, `sip_password`, `caller_id_name`, `caller_id_number`, `organization_id`

#### Cookie Retrieval (lines 8341-8359)

```swift
private func getCookies(for urlString: String) async -> [HTTPCookie] {
    // Main thread: WKWebsiteDataStore.default().httpCookieStore.getAllCookies
    // Filters by domain matching
}
```

**Note**: Must dispatch to main thread for `WKWebsiteDataStore` access.

#### Rollback (lines 8176-8207)

`restoreOriginalContext()`:
1. Restores organization context in `VoipStore`
2. Restores original SIP credentials in Keychain
3. Does **NOT** reconnect TelnyxService (call is ending anyway, service reconnects naturally on next call)

#### Error Types
```swift
enum OrganizationSwitchError: LocalizedError {
    case noOrganizationId
    case networkError(String)
    case apiError(String, Int)
    case parseError(String)
    case timeout
    case switchFailed(String)
    case credentialStoreFailed(String)
}

enum CrossOrgErrorType: String {
    case networkError, apiError, credentialError, connectionError
}
```

#### Background Task Management
- `beginBackgroundTask()` — registers with `UIApplication.shared.beginBackgroundTask(withName: "OrgSwitchTask")`
- `endBackgroundTask()` — always called in `defer` block
- Expiration handler logs warning

---

### 3.12 Z360VoIPService.swift

**File**: `ios/App/App/VoIP/Services/Z360VoIPService.swift` (2,253 lines)
**Skill reference**: `files.md:4019-6270`

#### Purpose
**Central orchestrator** for all Z360 VoIP functionality. Single entry point for all VoIP operations. Implements both `TelnyxServiceDelegate` and `CallKitManagerDelegate` for event coordination.

#### Design
```swift
final class Z360VoIPService: NSObject {
    static let shared = Z360VoIPService()

    // LAZY dependencies (STARTUP PERFORMANCE FIX)
    private lazy var telnyxService = TelnyxService.shared
    private lazy var voipStore = VoipStore.shared
    private lazy var actionGuard = ActionGuard.shared
    private lazy var activeCallGuard = ActiveCallGuard.shared
    private lazy var notificationHelper = NotificationHelper.shared
    private lazy var callTimerManager = CallTimerManager.shared
    private lazy var callQualityMonitor = CallQualityMonitor.shared
    private lazy var networkMonitor = NetworkMonitor.shared

    private weak var callKitManager: CallKitManager?
    weak var pluginDelegate: Z360VoIPServicePluginDelegate?
}
```

**Startup Performance Fix**: All dependencies are `lazy` to prevent cascade of XPC connections during WebView load that caused 37-43s launch times. Dependencies initialize on first access, not during `init()`.

#### State Management
```swift
private var activeCallUUID: UUID?
private var activeCallDirection: CallDirection?
private var callEndProcessedForUUID: UUID?         // Prevents duplicate call-end handling
private var telnyxToCallKitMap: [UUID: UUID] = [:]  // Telnyx ID → CallKit UUID
private var pendingIncomingCalls: [UUID: PendingIncomingCall] = [:]
private var ringTimeoutTimers: [UUID: DispatchSourceTimer] = [:]
private var outgoingCallStarted: Set<UUID> = []
private let stateQueue = DispatchQueue(label: "com.z360.voipservice.state")
private var pendingAudioSession: AVAudioSession?
```

#### Responsibilities (organized by MARK sections)

**1. Setup**:
- `setupMinimal(callKitManager:)` — Phase 1: stores weak CallKit reference, sets TelnyxService delegate
- `startNetworkMonitoringIfNeeded()` — Phase 2: starts NetworkMonitor, sets delegate

**2. Connection Management**:
- `connect(credentials:)` — Saves to VoipStore, connects TelnyxService with optional push token
- `connectWithStoredCredentials()` — Retrieves from VoipStore, connects
- `disconnect()` — Disconnects, clears state
- `waitForClientReady(timeout:)` — Polls `isClientReady()` every 100ms
- `attemptReconnection()` — Tries stored credentials, used before answer/call when SDK not ready

**3. Incoming Call Handling**:
- `registerPendingIncomingCall(uuid:callerNumber:callerName:organizationId:avatarUrl:)` — Tracks pending calls for missed call detection (US-013)
- Ring timeout: 30-second timer per `IC-007`
- `markCallAsAnswered(uuid:)` — Removes from pending, cancels timeout

**4. Answer Flow** — `answerCall(uuid:action:)` (lines 4484-4603):
   1. ActionGuard double-tap prevention (BUG-005)
   2. SDK readiness check → attempt reconnection if needed
   3. Wait for push call ready in SDK (5s timeout safety net)
   4. Cross-org detection → `performCrossOrgSwitch()` if needed (US-022)
   5. Set active call state + direction
   6. `telnyxService.answerFromCallKit(answerAction:)`
   7. Persist call state for crash recovery

**5. Cross-Org Switch** — `performCrossOrgSwitch(uuid:targetOrgId:targetOrgName:)` (lines 4618-4700):
   1. Notifies plugin (loading indicator)
   2. Delegates to `OrganizationSwitcher.switchOrganization()`
   3. Logs to Firebase Analytics
   4. On failure: emits error event to plugin with `CrossOrgErrorType`

**6. Outgoing Call** — `makeCall(destinationNumber:displayName:callerIdName:callerIdNumber:)` (lines 4968-5110):
   1. ActionGuard prevents double-tap
   2. Validates destination number (3+ digits, valid chars)
   3. SDK readiness check → attempt reconnection
   4. ActiveCallGuard enforces single call
   5. Requests CXStartCallAction via CallKitManager
   6. Actual Telnyx call made in `didReceiveStartAction` delegate callback

**7. Decline/End/Cancel Call**:
   - `declineCall(uuid:action:)` — Incoming not yet answered (with ActionGuard)
   - `endCall(uuid:action:)` — Active call
   - `cancelOutgoingCall(uuid:action:)` — Outgoing in CONNECTING/RINGING (US-016)

**8. Orphan Call Recovery (US-026)** — `recoverOrphanCallState(_:)`:
   - Reads `PersistableCallState` from UserDefaults
   - Reports to CallKit as ended
   - Clears persisted state

**9. Missed Call Tracking (US-013)**:
   - `handleMissedCall(uuid:pendingCall:reason:)` — Shows notification via `NotificationHelper`, emits event to plugin
   - Reasons: `.remoteHangup`, `.timeout`, `.declined`, `.rejectedSimultaneous`

#### TelnyxServiceDelegate Implementation (lines 5167-5887)

**Connection events**:
- `telnyxServiceDidConnect` → `pluginDelegate?.voipServiceDidConnect()`
- `telnyxServiceDidDisconnect` → `pluginDelegate?.voipServiceDidDisconnect()`
- `telnyxServiceClientReady` → checks for `pendingAudioSession` (race condition fix), emits event
- `telnyxService(_:didReceiveError:)` → emits error event

**Call state handling** — `callStateDidChange(_:callId:state:)`:
- `.connecting` → emits `callStarted`
- `.ringing` → emits `callRinging`
- `.active` → persists call state (US-026), starts timer/quality/network monitoring, emits `callAnswered`
- `.done` → stops timer/quality/network, reports to CallKit, resets guards, clears state
  - **Deduplication**: `callEndProcessedForUUID` prevents handling both `callStateDidChange(.done)` and `remoteCallEnded` for same call
- `.held` → no action (tracked by CallKitManager)

**Remote call ended** — `remoteCallEnded(callId:reason:)`:
- Finds CallKit UUID from: Telnyx-to-CallKit map → active call → pending incoming calls
- If pending → treats as missed call (US-013)
- Otherwise → normal cleanup

#### CallKitManagerDelegate Implementation (lines 5889-6122)

**`callKitManagerDidReset`**: Full state cleanup — stops timer/quality/network, ends Telnyx call, resets all guards

**`didReceiveAnswerAction`**: Delegates to `answerCall(uuid:action:)`

**`didReceiveStartAction`** (outgoing):
1. Marks call as "started" immediately (prevents background cancellation)
2. Reports outgoing call connecting
3. `action.fulfill()` synchronously (CRITICAL — delayed fulfill prevents CallKit UI)
4. Async: makes Telnyx call, maps IDs, handles failure

**`didReceiveEndAction`**: Classifies as decline/cancel/end based on call state

**`didReceiveHoldAction`**: `AudioManager.shared.setHold(onHold)`, `action.fulfill()`

**`didReceiveMuteAction`**: `AudioManager.shared.setMute(muted)`, `action.fulfill()`

**`didReceiveDTMFAction`**: `AudioManager.shared.sendDTMF()` for each digit

**`didActivateAudioSession`** (CRITICAL):
- Stores as `pendingAudioSession`
- If SDK ready → `telnyxService.enableAudioSession()` immediately
- If SDK not ready → starts retry with `waitForClientReady(timeout: 5.0)`
  - **Race condition fix**: Both this path and `telnyxServiceClientReady` can activate audio
  - `pendingAudioSession` cleared after activation to prevent double-activation

**`didDeactivateAudioSession`**: `telnyxService.disableAudioSession()`

---

## 4. Supporting Components

### 4.1 ActionGuard.swift
**File**: `ios/App/App/VoIP/Utils/ActionGuard.swift`

Swift Actor preventing double-tap race conditions (BUG-005):
```swift
actor ActionGuard {
    enum ActionType { case answer, decline, endCall, makeCall }
    func attemptAction(_ action: ActionType) -> Bool  // Atomic check-and-set
    func reset(_ action: ActionType)
    func resetAll()
}
```

### 4.2 ActiveCallGuard.swift
**File**: `ios/App/App/VoIP/Utils/ActiveCallGuard.swift`

Enforces single active call (US-014, US-025):
```swift
actor ActiveCallGuard {
    func tryAcquire(callId: UUID, direction: CallDirection) -> Bool
    func release(callId: UUID)
    func forceRelease()
    func getActiveCallInfo() -> ActiveCallInfo?
}
```

### 4.3 CallQualityMonitor.swift
**File**: `ios/App/App/VoIP/Utils/CallQualityMonitor.swift` (286 lines)

Processes WebRTC quality metrics every 5 seconds during active calls:
- MOS (Mean Opinion Score): 1.0-5.0
- Jitter (ms), RTT (ms), Packet Loss (%)
- Quality classification: `.good` (MOS ≥ 4.0), `.fair` (≥ 3.5), `.poor` (< 3.5), `.unknown`

### 4.4 CallTimerManager.swift
**File**: `ios/App/App/VoIP/Utils/CallTimerManager.swift`

Tracks call duration with 1-second tick:
- `startTimer(for callUUID:)` / `stopTimer() -> Int`
- `getFormattedDuration() -> String` (MM:SS or HH:MM:SS)
- `delegate?.callTimerManager(_:didUpdateDuration:elapsedSeconds:formattedDuration:)`

### 4.5 NotificationHelper.swift
**File**: `ios/App/App/VoIP/Utils/NotificationHelper.swift`

Creates local notifications for missed calls:
- `showMissedCallNotification(callUUID:callerNumber:callerName:organizationName:)`
- `removeMissedCallNotification(callUUID:)`
- `clearAllMissedCallNotifications()`

### 4.6 VoIPLogger.swift
**File**: `ios/App/App/VoIP/Utils/VoIPLogger.swift` (711 lines)

Structured logging with Firebase Crashlytics integration:
- `setFirebaseReady()` — gate for Firebase operations
- `setCallContext(callId:direction:callerNumber:)` — Crashlytics custom keys
- `logEvent(_:parameters:)` — Firebase Analytics events
- `recordError(_:context:)` — Crashlytics non-fatal errors

### 4.7 TelnyxVoipPlugin.swift (Capacitor Bridge)
**File**: `ios/App/App/VoIP/TelnyxVoipPlugin.swift`

`CAPBridgedPlugin` with 21 `@objc` methods bridging JavaScript ↔ native:
- Connection: `connect`, `disconnect`, `reconnect`
- Call control: `call`, `answer`, `hangup`, `decline`
- Audio: `setMute`, `toggleMute`, `setHold`, `toggleHold`, `setSpeaker`, `toggleSpeaker`, `sendDTMF`
- State: `getDeviceId`, `getFcmToken`, `getFcmTokenWithWait`, `getNetworkStatus`, `getConnectionState`, `getPendingIncomingCall`

Emits 22+ event types to JavaScript via `notifyListeners()`.

---

## 5. Cross-Cutting Concerns

### 5.1 Threading Model

| Thread/Queue | Components | Operations |
|-------------|------------|------------|
| **Main thread** | WebView, Capacitor Bridge, Plugin `@objc`, CallKit delegate (`queue: nil`) | UI updates, CXProvider callbacks, plugin method invocations |
| **Swift Actors** | `VoipStore`, `PushCorrelator`, `ActionGuard`, `ActiveCallGuard` | Thread-safe state access via actor isolation |
| **Serial queues** | `callsQueue` (CallKit), `stateQueue` (multiple), `switchQueue` (OrgSwitcher) | Thread-safe access to non-actor state |
| **Background** | TelnyxService WebSocket, NWPathMonitor, Firebase init | Network I/O, monitoring |
| **DispatchQueue.main.async** | TelnyxService delegate callbacks | All TxClientDelegate events dispatched to main |

### 5.2 Error Handling Strategy

- **CXCallAction**: Every action MUST call `.fulfill()` or `.fail()` — not doing so leaves CallKit in inconsistent state
- **TelnyxService**: If `txClient` is nil during answer, still fulfills action to prevent CallKit hang
- **OrganizationSwitcher**: Full rollback on any failure (credentials + org context)
- **ActionGuard**: Reset on failure to allow retry
- **Network**: 30-second timeout on loss during active call → graceful drop

### 5.3 State Persistence

| Data | Storage | Reason |
|------|---------|--------|
| SIP credentials | Keychain (`kSecAttrAccessibleWhenUnlocked`) | Security — accessible only when device unlocked |
| VoIP push token | UserDefaults | Needed across restarts, not sensitive |
| Token date | UserDefaults | Session expiry check (7-day TTL) |
| Active call state | UserDefaults + Memory | Crash recovery (US-026) |
| Organization context | UserDefaults | Cross-org detection |
| Call display info | In-memory only | Transient per-call data |
| Incoming call meta | In-memory only | Transient per-call data |
| Pending incoming call | UserDefaults | Cold start recovery (app killed → push) |

### 5.4 Timing Constraints

| Constraint | Value | Enforced By | Consequence of Violation |
|-----------|-------|-------------|--------------------------|
| PushKit → CallKit report | **5 seconds** | Apple iOS | **App terminated** |
| Push correlation timeout | 500ms-1.5s | PushCorrelator | Partial caller info displayed |
| SDK reconnection timeout | 5s | waitForClientReady | Answer may fail |
| Cross-org switch total | 4.5s max | OrganizationSwitcher | Switch fails, rollback |
| API request timeout | 4.0s | URLSession | OrganizationSwitchError |
| Network reconnection | 30s | NetworkMonitor | Call dropped gracefully |
| Ring timeout | 30s | Z360VoIPService | Treated as missed call |
| Session expiry | 7 days | AppDelegate | VoIP data cleared |
| Audio activation retry | 5s | Z360VoIPService | Call may have no audio |
| Debounce (network) | 500ms | NetworkMonitor | Filters brief blips |

---

## 6. Telnyx SDK Integration Patterns

### 6.1 Z360 vs Standard SDK Usage

| Aspect | Standard SDK Pattern | Z360 Implementation |
|--------|---------------------|---------------------|
| **Push delivery** | Telnyx sends push via registered credentials | Z360 backend sends push directly via APNs |
| **Push payload** | SDK-defined `TxServerConfiguration` | Custom payload with org context, avatar |
| **Push processing** | `processVoIPNotification()` only | Two-push correlation then SDK processing |
| **Connection** | `TxConfig(sipUser:password:)` | Same, plus `forceRelayCandidate: true`, `enableQualityMetrics: true`, `customLogger` |
| **Server config** | Custom signaling server from push | Default `TxServerConfiguration()` (production) |
| **Token registration** | During Verto login | Separate registration with Z360 backend |
| **Reconnection** | SDK handles internally (`reconnectClient: true`) | Z360 adds OrganizationSwitcher for cross-org reconnection |
| **Audio codecs** | SDK defaults | Opus @ 48kHz preferred (US-041) |

### 6.2 SDK Methods Used by Z360

**TxClient**:
- `connect(txConfig:serverConfiguration:)` — Initial connection
- `disconnect()` — Teardown
- `isConnected()` — WebSocket state
- `answerFromCallkit(answerAction:debug:)` — Answer push-initiated call
- `endCallFromCallkit(endAction:callId:)` — End call
- `newCall(callerName:callerNumber:destinationNumber:callId:customHeaders:preferredCodecs:debug:)` — Outgoing
- `enableAudioSession(audioSession:)` / `disableAudioSession(audioSession:)` — CallKit audio
- `processVoIPNotification(txConfig:serverConfiguration:pushMetaData:)` — NOT used directly (Z360 uses custom push handling)

**Call**:
- `muteUnmuteAudio()` — Toggle mute
- `hold()` / `unhold()` — Hold control
- `hangup()` — End call
- `dtmf(digit:)` — DTMF tones
- `onCallQualityChange` — Quality metrics callback

### 6.3 SDK Features NOT Used

- `processVoIPNotification()` — Z360 handles push processing independently
- `disablePushNotifications()` — Token deregistration handled by Z360 backend
- Token-based login (`TxConfig(token:)`) — Uses SIP credential login instead
- AI Assistant features (`AIAssistantManager`) — Not used

---

## 7. Known Issues and Technical Debt

### 7.1 TODOs in Code

1. **PushKitManager (line ~1783)**: `// TODO: Send VoIP token to Z360 backend` — Token registration with backend not yet implemented in native code
2. **PushKitManager (line ~1836)**: `// TODO: Notify backend to remove old token` — Token cleanup on invalidation not implemented

### 7.2 Architectural Concerns

**1. Z360VoIPService God Object** (2,253 lines):
The central orchestrator has accumulated significant responsibility. It implements 5 delegate protocols and manages multiple concurrent concerns (connection, calls, cross-org, missed calls, crash recovery). Consider decomposing into focused coordinators.

**2. Singleton Coupling**:
All components use singleton pattern (`*.shared`) creating tight coupling. While functional, this makes testing difficult and creates implicit dependencies. The `lazy` keyword partially mitigates startup performance but doesn't address testability.

**3. Dual Path for Call End Handling**:
Both `callStateDidChange(.done)` and `remoteCallEnded()` can fire for the same call. The `callEndProcessedForUUID` flag prevents double-processing, but this is a fragile pattern that could miss edge cases with rapid successive calls.

**4. Audio Activation Race Condition**:
The `pendingAudioSession` pattern in `callKitManagerDidActivateAudioSession` has a complex race between CallKit audio activation and SDK readiness (`telnyxServiceClientReady`). Both paths can activate audio, requiring careful coordination.

**5. PushKit 5-Second Cliff**:
If any combination of backend latency + push correlation timeout + cross-org switch exceeds 5 seconds from PushKit delivery, iOS terminates the app. The `call_ended` push handler uses a "fake call" workaround when no matching call exists, which is a necessary but unclean pattern.

**6. Cookie-Based Auth for Org Switch**:
`OrganizationSwitcher` reads cookies from `WKWebsiteDataStore` for API authentication. If WebView session expires while native holds stale cookies, the org switch fails. This coupling between native and WebView state is fragile.

**7. `forceRelayCandidate: true`**:
While this avoids the iOS Local Network permission dialog, it forces all media through TURN relay servers, adding latency and bandwidth overhead. A more targeted solution could detect whether the prompt has been shown.

### 7.3 Missing Features

1. **No SRTP/SRDES key verification** — relies on SDK defaults
2. **No call recording support** — not yet implemented
3. **No conference/multi-party calling** — `CXSetGroupCallAction` always fails
4. **No call transfer** — not implemented
5. **No explicit ICE restart handling** — relies on SDK's built-in reconnection

---

## 8. Architectural Patterns Summary

### Pattern 1: Two-Phase Startup
**Problem**: AVAudioSession initialization starves WebKit IPC for 37-43s.
**Solution**: Phase 1 (AppDelegate) does PushKit + minimal wiring only. Phase 2 (SceneDelegate.sceneDidBecomeActive) does everything else.
**Files**: `AppDelegate.swift`, `SceneDelegate.swift`, `Z360VoIPService.swift`

### Pattern 2: Two-Push Correlation
**Problem**: Two independent push systems (Z360 + Telnyx) must be correlated.
**Solution**: `PushCorrelator` actor indexes by normalized phone (last 10 digits), 500ms-1.5s timeout, graceful degradation.
**Files**: `PushCorrelator.swift`, `PushKitManager.swift`

### Pattern 3: Singleton Orchestrator
**Problem**: Multiple components need coordinated lifecycle management.
**Solution**: `Z360VoIPService` as single entry point implementing all delegate protocols.
**Files**: `Z360VoIPService.swift` (2,253 lines)

### Pattern 4: Actor Isolation
**Problem**: Thread-safe state access across concurrent contexts.
**Solution**: Swift Actors for `VoipStore`, `PushCorrelator`, `ActionGuard`, `ActiveCallGuard`.
**Files**: `VoipStore.swift`, `PushCorrelator.swift`, `ActionGuard.swift`, `ActiveCallGuard.swift`

### Pattern 5: Double-Tap Prevention (BUG-005)
**Problem**: Users can double-tap answer/decline/call buttons.
**Solution**: `ActionGuard` actor with `attemptAction()` atomic check-and-set, reset on failure or state transition.
**Files**: `ActionGuard.swift`, `Z360VoIPService.swift`

### Pattern 6: Cross-Org Rollback (US-023)
**Problem**: Org switch can fail mid-way through credential regeneration.
**Solution**: Capture original context before switch, restore on any failure, don't reconnect on rollback.
**Files**: `OrganizationSwitcher.swift`, `Z360VoIPService.swift`

### Pattern 7: Auto-Mute on Hold (BUG-012)
**Problem**: Audio leaks when call is on hold.
**Solution**: Automatically mute on hold, save user's previous mute state, restore on unhold.
**Files**: `AudioManager.swift`

### Pattern 8: Lazy Initialization for Startup Performance
**Problem**: Singleton cascade during WebView load starves WebKit.
**Solution**: All `Z360VoIPService` dependencies are `lazy var` — initialize on first access, not during init.
**Files**: `Z360VoIPService.swift`

### Pattern 9: Cold Start Persistence
**Problem**: App killed, VoIP push arrives, WebView not loaded yet.
**Solution**: Persist call data to UserDefaults during push handling. Plugin reads `getPendingIncomingCall()` when WebView loads.
**Files**: `PushKitManager.swift`, `TelnyxVoipPlugin.swift`

### Pattern 10: Crash Recovery (US-026)
**Problem**: App crashes during active call, leaving orphan state.
**Solution**: Persist `PersistableCallState` to UserDefaults on call active. On next launch, detect and clean up.
**Files**: `VoipStore.swift`, `AppDelegate.swift`, `Z360VoIPService.swift`
