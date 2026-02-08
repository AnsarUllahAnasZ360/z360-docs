---
title: iOS Platform Requirements
---

# iOS Platform Requirements for VoIP

> **Scope**: Apple's requirements and constraints that govern VoIP application behavior on iOS. Covers PushKit, CallKit, background modes, AVAudioSession, App Store guidelines, and app lifecycle impact.
>
> **Sources**: Z360 iOS implementation (`voip-ios` skill), Apple platform documentation (`voip-ios-platform` skill), Telnyx iOS SDK/demo packs, Apple Developer Forums, and web search.

---

## Table of Contents

1. [PushKit Requirements](#1-pushkit-requirements)
2. [CallKit Architecture](#2-callkit-architecture)
3. [Background Modes](#3-background-modes)
4. [AVAudioSession](#4-avaudiosession)
5. [App Store Requirements](#5-app-store-requirements)
6. [App Lifecycle Impact](#6-app-lifecycle-impact)
7. [Telnyx Demo vs Z360 Comparison](#7-telnyx-demo-vs-z360-comparison)

---

## 1. PushKit Requirements

### 1.1 Apple's Contract for VoIP Pushes

PushKit is Apple's mechanism for delivering VoIP push notifications. Unlike regular APNs, PushKit pushes:

- **Wake the app from any state** — foreground, background, suspended, or terminated
- **Launch the app if not running** — iOS starts the process in the background
- **Deliver with high priority** — no batching or delay
- **Do not display visible alerts** — the app must present UI via CallKit

**In exchange, Apple enforces a strict contract (iOS 13+):**

> Every VoIP push **MUST** result in a call reported to CallKit via `CXProvider.reportNewIncomingCall()`. There are no exceptions.

**Source**: `.claude/skills/voip-ios-platform/SKILL.md` — PushKit section

### 1.2 Timing Constraints

| Constraint | Value | Consequence of Violation |
|---|---|---|
| Report to CallKit | **Within ~5 seconds** of receiving push | iOS **terminates the app** |
| Repeated failures | Multiple pushes without CallKit report | iOS **stops delivering VoIP pushes entirely** |
| Completion handler | Must be called after reporting | Push delivery hangs if not called |

The 5-second window is not formally documented as an exact number — Apple says "immediately" — but empirical testing and the Z360 codebase treat it as a hard 5-second deadline.

**Z360 implementation comment** (`.claude/skills/voip-ios/references/files.md` — PushKitManager.swift, line 1028):
```
// CRITICAL: Must report to CallKit within 5 seconds or iOS will terminate the app
```

**Z360 CallKitManager** (line 552):
```
// CRITICAL: Must be called within 5 seconds of receiving VoIP push
```

### 1.3 PushKit Delegate Methods

Three delegate methods from `PKPushRegistryDelegate`:

```swift
// 1. Token received — send to backend for push delivery
func pushRegistry(_ registry: PKPushRegistry,
                  didUpdate pushCredentials: PKPushCredentials,
                  for type: PKPushType)

// 2. Incoming VoIP push — MUST report to CallKit synchronously
func pushRegistry(_ registry: PKPushRegistry,
                  didReceiveIncomingPushWith payload: PKPushPayload,
                  for type: PKPushType,
                  completion: @escaping () -> Void)

// 3. Token invalidated — notify backend to stop sending pushes
func pushRegistry(_ registry: PKPushRegistry,
                  didInvalidatePushTokenFor type: PKPushType)
```

**Source**: `.claude/skills/voip-ios/references/files.md` — PushKitManager.swift, lines 1764–1787

### 1.4 Token Handling

PushKit tokens are `Data` objects that must be converted to hex strings for transmission to the backend:

```swift
// CRITICAL: Convert token to hex string correctly.
// NEVER use .description - it has different formats on iOS 12 vs iOS 13+
let hexToken = credentials.token.map { String(format: "%02x", $0) }.joined()
```

**Source**: `.claude/skills/voip-ios/references/files.md` — PushKitManager.swift, lines 1771–1773; Data hex extension at lines 1855–1861

### 1.5 Initialization Timing

PushKit **MUST** be initialized at app launch in `AppDelegate.didFinishLaunchingWithOptions`. Deferring initialization to a later point risks missing pushes that arrive before registration completes.

```swift
// AppDelegate.swift, lines 10304–10305
PushKitManager.shared.initialize()
Z360VoIPService.shared.setupMinimal(callKitManager: CallKitManager.shared)
```

### 1.6 Completion Handler Race Condition

A known issue exists when calling `reportNewIncomingCall` and the push completion handler simultaneously while the app is not in the foreground. The CallKit reporting method can get stuck and never fire its completion block.

**Workaround**: Delay the completion handler call using `DispatchQueue.main.asyncAfter` by a few seconds after `reportNewIncomingCall` completes.

**Source**: Apple Developer Forums — [iOS 13 PushKit VoIP restrictions](https://developer.apple.com/forums/thread/117939)

### 1.7 iOS 26 Changes

Starting in iOS 26, Apple introduces new dialogs warning apps about VoIP push-related issues. These alerts appear **only on development and TestFlight builds**, not on App Store builds. This aids debugging but does not change the underlying contract.

**Source**: [Apple Developer Forums — PushKit tag](https://developer.apple.com/forums/tags/pushkit/)

---

## 2. CallKit Architecture

### 2.1 Core Components

CallKit provides four primary classes:

| Class | Purpose |
|---|---|
| `CXProvider` | Receives system events (user answered, user ended) and reports call state to iOS |
| `CXCallController` | Sends user-initiated actions to the system (start call, end call) |
| `CXCallAction` | Represents a single action (answer, end, hold, mute, DTMF) |
| `CXTransaction` | Groups one or more actions into an atomic operation |

**Singleton requirement**: Only ONE `CXProvider` instance is allowed per app. Creating a second instance causes undefined behavior.

### 2.2 CXProvider Configuration

```swift
let config = CXProviderConfiguration()
config.supportsVideo = false
config.maximumCallGroups = 1          // Single call at a time
config.maximumCallsPerCallGroup = 1   // No conference support
config.supportedHandleTypes = [.phoneNumber, .generic]
config.includesCallsInRecents = true  // Show in iOS Recents
// CallKit icon: 40x40pt monochrome PNG
config.iconTemplateImageData = iconData
```

**Source**: `.claude/skills/voip-ios/references/files.md` — CallKitManager.swift, lines 522–546

### 2.3 Reporting Incoming Calls

The critical method that satisfies Apple's PushKit contract:

```swift
func reportIncomingCall(uuid: UUID, handle: String, callerName: String?,
                        hasVideo: Bool, completion: @escaping (Error?) -> Void) {
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .phoneNumber, value: handle)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsHolding = true
    update.supportsDTMF = true
    update.supportsGrouping = false
    update.supportsUngrouping = false

    provider.reportNewIncomingCall(with: uuid, update: update) { error in
        completion(error)
    }
}
```

**Source**: `.claude/skills/voip-ios/references/files.md` — CallKitManager.swift, lines 559–594

### 2.4 CXProviderDelegate Callbacks

The app receives these callbacks from iOS via `CXProviderDelegate`:

| Callback | Trigger | Requirement |
|---|---|---|
| `perform CXAnswerCallAction` | User tapped Answer | Must call `action.fulfill()` or `action.fail()` |
| `perform CXStartCallAction` | App initiated outgoing call | Must call `action.fulfill()` or `action.fail()` |
| `perform CXEndCallAction` | User tapped End/Decline | Must call `action.fulfill()` or `action.fail()` |
| `perform CXSetHeldCallAction` | User toggled hold | Must call `action.fulfill()` or `action.fail()` |
| `perform CXSetMutedCallAction` | User toggled mute | Must call `action.fulfill()` or `action.fail()` |
| `perform CXPlayDTMFCallAction` | User entered keypad digits | Must call `action.fulfill()` or `action.fail()` |
| `timedOutPerforming action` | Action exceeded system timeout | Should attempt to fulfill |
| `didActivate audioSession` | Audio session activated by iOS | **MUST** enable audio here |
| `didDeactivate audioSession` | Audio session deactivated by iOS | **MUST** disable audio here |

**Critical rule**: Every action handler **MUST** call either `action.fulfill()` or `action.fail()`. Failing to do so leaves CallKit in an inconsistent state.

**Source**: `.claude/skills/voip-ios/references/files.md` — CallKitManager.swift CXProviderDelegate extension, lines 787–909

### 2.5 Audio Session Integration

CallKit **owns** the audio session. The app must not activate or deactivate the audio session on its own. Instead:

1. **Configure** the audio session category/mode at setup time (but do NOT activate)
2. **Wait** for `provider(_:didActivate audioSession:)` callback
3. **Enable** audio (tell Telnyx SDK to use the session) only in that callback
4. **Disable** audio in `provider(_:didDeactivate audioSession:)` callback

```swift
// CORRECT: Enable audio only when CallKit says so
func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    telnyxClient?.enableAudioSession(audioSession: audioSession)
}

func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    telnyxClient?.disableAudioSession(audioSession: audioSession)
}
```

**Source**: `.claude/skills/voip-ios/references/files.md` — TelnyxService.swift, lines 3247–3263; CallKitManager.swift, lines 893–900

### 2.6 CXTransaction for User-Initiated Actions

When the app needs to request an action (e.g., end a call programmatically):

```swift
let endAction = CXEndCallAction(call: callUUID)
let transaction = CXTransaction(action: endAction)
callController.request(transaction) { error in
    if let error = error {
        // Handle failure
    }
}
```

**Source**: `.claude/skills/voip-ios/references/files.md` — CallKitManager.swift, lines 693–738

---

## 3. Background Modes

### 3.1 Required UIBackgroundModes

Z360 declares four background modes in `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
    <string>voip</string>
    <string>audio</string>
    <string>remote-notification</string>
    <string>fetch</string>
</array>
```

**Source**: `.claude/skills/voip-ios/references/files.md` — Info.plist, lines 10631–10637

### 3.2 What Each Mode Enables

| Mode | Purpose | Required For |
|---|---|---|
| `voip` | Enables PushKit VoIP push registration and delivery. App is launched/woken when VoIP push arrives. | Receiving incoming calls when app is not running |
| `audio` | Keeps the app alive in the background while audio is actively playing/recording. iOS will not suspend the app during an active audio session. | Maintaining call audio when user switches to another app |
| `remote-notification` | Allows the app to process silent push notifications in the background. App gets ~30 seconds of execution time. | Non-call push notifications (e.g., Z360 push with caller info) |
| `fetch` | Allows iOS to wake the app periodically for background content refresh. Timing is determined by iOS based on usage patterns. | Background data sync (optional for VoIP) |

### 3.3 Apple's Enforcement

**Guideline 2.5.4**: Apps may only use background modes for their intended purposes. Using `voip` mode for anything other than VoIP calls (e.g., keep-alive pings, data sync) will result in App Store rejection.

Apple specifically checks that every VoIP push results in a CallKit call report. Using PushKit as a general-purpose background execution mechanism is explicitly forbidden.

---

## 4. AVAudioSession

### 4.1 Category and Mode for VoIP

The correct AVAudioSession configuration for VoIP calling:

| Setting | Value | Purpose |
|---|---|---|
| **Category** | `.playAndRecord` | Two-way audio (microphone + speaker) |
| **Mode** | `.voiceChat` | Enables echo cancellation, noise suppression, and automatic gain control (AGC) |
| **Options** | `.allowBluetoothHFP` | Bluetooth Hands-Free Profile for headsets |
| **Options** | `.allowBluetoothA2DP` | Bluetooth Advanced Audio Distribution Profile |

**Z360 configuration** (`.claude/skills/voip-ios/references/files.md` — AppDelegate.swift, lines 10486–10510):
```swift
func configureAudioSessionForVoIP() {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetoothHFP, .allowBluetoothA2DP]
    )
}
```

**Telnyx SDK internal configuration** (from `telnyx-ios-sdk.xml` — Peer.swift):
```swift
try rtcAudioSession.setCategory(AVAudioSession.Category.playAndRecord,
                               mode: AVAudioSession.Mode.voiceChat,
                               options: [.duckOthers, .allowBluetooth])
try rtcAudioSession.setPreferredIOBufferDuration(0.01) // 10ms for low latency
```

### 4.2 Configuration vs Activation

**Critical distinction**: The audio session category/mode should be **configured** during setup, but **activation** (`setActive(true)`) must only happen inside CallKit's `didActivate` callback. Activating the audio session prematurely can cause conflicts with other audio sources and violates CallKit's ownership model.

### 4.3 WebView Audio Coexistence

Z360 uses Capacitor (WebView) alongside native VoIP. The WebView may also use audio (e.g., notification sounds, media playback). This creates a critical coexistence problem:

**Problem**: `AVAudioSession.setCategory()` triggers the audio daemon initialization. If called during `didFinishLaunchingWithOptions`, it causes **WebKit IPC starvation** — the WebView process launch is delayed by **37–43 seconds**.

**Z360 solution — Two-phase startup**:
- **Phase 1** (`didFinishLaunchingWithOptions`): Only PushKit + minimal CallKit wiring. No audio session configuration.
- **Phase 2** (`sceneDidBecomeActive`): Configure audio session after WebView has loaded and first frame has rendered.

**Source**: `.claude/skills/voip-ios/references/files.md` — AppDelegate.swift, lines 10293–10301

### 4.4 Audio Route Management

**Speaker control** (`.claude/skills/voip-ios/references/files.md` — AudioManager.swift, lines 231–249):
```swift
// Switch to speaker
try audioSession.overrideOutputAudioPort(.speaker)

// Switch back to earpiece
try audioSession.overrideOutputAudioPort(.none)
```

**Route change monitoring** (AudioManager.swift, lines 330–376):
- Subscribe to `AVAudioSession.routeChangeNotification`
- Handle Bluetooth connect/disconnect events
- Bluetooth connection overrides speaker selection
- Must track current route to update UI accurately

### 4.5 Interruption Handling

Audio interruptions occur when:
- Another app starts playing audio
- A FaceTime/cellular call arrives
- Siri activates

The app should monitor `AVAudioSession.interruptionNotification` and:
- On `.began`: Pause or reduce audio activity
- On `.ended` with `.shouldResume`: Resume audio

CallKit handles most interruption scenarios automatically for VoIP calls, but the app must be prepared for edge cases (e.g., cellular call during VoIP call).

---

## 5. App Store Requirements

### 5.1 Required Entitlements

| Entitlement | Purpose |
|---|---|
| `aps-environment` | APNs push notifications (VoIP pushes route through APNs infrastructure) |
| Background Modes capability | Must enable VoIP, Audio, Remote notifications, Background fetch in Xcode |

CallKit does **not** require a separate entitlement — it is available to all apps. However, the `voip` background mode must be enabled in the app's capabilities.

### 5.2 Required Info.plist Keys

| Key | Value | Purpose |
|---|---|---|
| `NSMicrophoneUsageDescription` | "Z360 needs access to your microphone to make and receive phone calls." | Runtime microphone permission |
| `NSCameraUsageDescription` | "Z360 needs access to your camera for video calls." | Runtime camera permission (if video supported) |
| `UIBackgroundModes` | `[voip, audio, remote-notification, fetch]` | Background execution |

**Source**: `.claude/skills/voip-ios/references/files.md` — Info.plist, lines 10680–10683

### 5.3 Apple Review Guidelines

| Guideline | Impact |
|---|---|
| **2.5.4** — Background execution | Background modes must only be used for their stated purpose. Using `voip` for keep-alive or data sync → **rejection**. |
| **3.1.3(b)** — SaaS exemption | SaaS companion apps (like Z360) are **exempt** from in-app purchase requirements for VoIP services. Subscriptions can be managed outside the App Store. |
| **4.0** — Design guidelines | CallKit UI must be used for incoming calls. Custom call UI without CallKit → likely rejection for VoIP apps. |

### 5.4 Push Certificate Requirements

VoIP pushes require a dedicated APNs certificate or key:

- **APNs Auth Key** (recommended): A single `.p8` key file that works for all push types (VoIP, regular, silent). Does not expire.
- **APNs VoIP Certificate** (legacy): A `.p12` certificate specific to VoIP pushes. Expires annually and must be renewed.

The push credential (token or certificate) must be configured on the server side (Telnyx portal or via API) to enable push delivery.

### 5.5 LiveCommunicationKit (iOS 17.4+)

Apple introduced `LiveCommunicationKit` as an alternative to CallKit starting in iOS 17.4:
- No Recents integration (calls don't appear in Phone app)
- No full-screen lock screen UI
- Suitable for apps that want VoIP without the full phone integration

Z360 uses **CallKit** (not LiveCommunicationKit) because full phone integration and Recents are desirable for a business communications platform.

---

## 6. App Lifecycle Impact

### 6.1 State Matrix

| App State | WebSocket | PushKit | CallKit | Audio | Notes |
|---|---|---|---|---|---|
| **Foreground** | Connected | Listening | Active | Available | Full functionality |
| **Background** | Disconnects | Listening | Active | Active if on call | WebSocket drops (no heartbeat) |
| **Suspended** | Disconnected | Listening | Available | Inactive | iOS may suspend after ~30s in background |
| **Terminated** | N/A | **Wakes app** | Available | Inactive until activated | PushKit launches process in background |
| **Locked screen** | Depends | Listening | **Native UI visible** | Active if on call | User sees CallKit lock screen UI |

### 6.2 Foreground

- Telnyx WebSocket is connected and maintaining heartbeat
- All VoIP features fully operational
- Network monitor active via `NWPathMonitor`
- Call quality monitoring running

### 6.3 Background

When the app moves to background:
- **WebSocket disconnects** — Telnyx SDK stops heartbeat, connection drops
- **PushKit remains active** — VoIP pushes still delivered
- **Active calls continue** — The `audio` background mode keeps the process alive while audio is playing
- **Network monitoring suspended** — Resumes when app returns to foreground

**Source**: `.claude/skills/voip-ios/references/files.md` — NetworkMonitor.swift, lines 7142–7306

### 6.4 Terminated

When the app is terminated (killed by user or iOS memory pressure):
- **PushKit wakes the app** — iOS launches the process in the background
- `didFinishLaunchingWithOptions` runs with limited time
- **Must report to CallKit synchronously** — the 5-second deadline applies
- After reporting, the app stays alive long enough for the user to answer/decline
- If the user answers, the app transitions to active with full functionality

### 6.5 Locked Screen

When the device is locked during a call:
- **CallKit provides native lock screen UI** — answer/decline buttons, caller info
- **Audio remains active** — WebRTC media continues flowing
- **Screen wake** — incoming call wakes the screen to show CallKit UI
- User can answer/decline without unlocking the device

### 6.6 Z360's Two-Phase Startup for Cold Launch

Z360 optimizes cold launch to handle the terminated → incoming call scenario:

**Phase 1: `didFinishLaunchingWithOptions` (~50ms budget)**
- Initialize PushKit (Apple mandate)
- Wire minimal CallKit/VoIP service
- Set notification center delegate
- **Nothing else** — no audio, no Firebase, no WebView initialization

**Phase 2: `sceneDidBecomeActive` (deferred)**
- Configure AVAudioSession (safe now — WebKit already loaded)
- Complete VoIP service setup
- Start network monitoring
- Full initialization

**Why**: AVAudioSession.setCategory() during Phase 1 triggers audio daemon initialization, causing WebKit IPC starvation (37–43s delay). Deferring to Phase 2 avoids this.

**Source**: `.claude/skills/voip-ios/references/files.md` — AppDelegate.swift, lines 10293–10336; SceneDelegate.swift, lines 10733–10750

### 6.7 Network Transitions

The app handles network changes (WiFi ↔ Cellular) via `NWPathMonitor`:

| Property | Value |
|---|---|
| Detection latency | < 1 second |
| Debounce window | 500ms (filters brief blips) |
| Reconnection timeout | 30 seconds |
| States | `connected`, `disconnected`, `reconnecting` |

**Source**: `.claude/skills/voip-ios/references/files.md` — NetworkMonitor.swift, lines 7142–7306

---

## 7. Telnyx Demo vs Z360 Comparison

### 7.1 Architecture Comparison

| Aspect | Telnyx iOS Demo | Z360 |
|---|---|---|
| **App type** | Native iOS only | Capacitor hybrid (WebView + native) |
| **PushKit init** | `AppDelegate.didFinishLaunchingWithOptions` | Same — Phase 1 of two-phase startup |
| **CallKit config** | Basic CXProviderConfiguration | Extended with icon, Recents integration |
| **Audio config** | SDK handles internally (`.duckOthers`, `.allowBluetooth`) | App-level config (`.allowBluetoothHFP`, `.allowBluetoothA2DP`) + deferred init |
| **Audio session timing** | Immediate in `didFinishLaunching` | **Deferred** to `sceneDidBecomeActive` (WebKit coexistence) |
| **Background modes** | `voip`, `audio` | `voip`, `audio`, `remote-notification`, `fetch` |
| **Network monitoring** | Not implemented | Full `NWPathMonitor` with debouncing and reconnection |
| **Token storage** | `UserDefaults` | `KeychainManager` (secure storage) |
| **Push system** | Single push (Telnyx SDK push only) | **Two-push system** (Z360 push + Telnyx push, correlated) |
| **Multi-org** | N/A | `OrganizationSwitcher` handles cross-org credential rotation |
| **Call quality** | Not implemented | `CallQualityMonitor` tracks metrics |
| **Logging** | Basic `print()` | `VoIPLogger` with structured logging (711 lines) |

### 7.2 Key Differences Explained

**Two-push system**: Z360 sends its own push notification (with caller info, organization context) alongside the Telnyx SDK push (with call control data). The `PushCorrelator` (611 lines) matches these using normalized phone numbers (last 10 digits) with a 500ms sync timeout.

**Deferred audio initialization**: The Telnyx demo can configure audio immediately because it's a pure native app. Z360 must defer because Capacitor's WebView and the audio daemon compete for system resources during cold launch.

**Secure token storage**: The Telnyx demo stores push tokens in `UserDefaults`. Z360 uses `KeychainManager` for secure credential storage, which is necessary for a production SaaS app handling business communications.

**Network resilience**: The Telnyx demo relies on the SDK's built-in reconnection. Z360 adds `NWPathMonitor` for proactive network state awareness, debounced change detection, and a 30-second reconnection timeout with UI state feedback.

### 7.3 Shared Patterns

Both implementations follow these Apple-mandated patterns identically:

1. **PushKit → CallKit synchronous reporting** — Both report incoming calls within the 5-second window
2. **Audio activation in `didActivate` only** — Neither activates the audio session prematurely
3. **`enableAudioSession` / `disableAudioSession` delegation** — Both delegate audio session lifecycle to the Telnyx SDK
4. **Action fulfill/fail pattern** — Both properly fulfill or fail every CXCallAction

### 7.4 Z360-Specific Concerns

| Concern | Impact | Mitigation |
|---|---|---|
| WebView audio conflict | Audio daemon init delays WebKit by 37–43s | Two-phase startup |
| Cross-org calls | Credential regeneration + SDK reconnect needed | 5-second CallKit deadline with rollback on failure |
| Simultaneous ring | Multiple devices ring for same call | Redis distributed lock for answer coordination |
| Push correlation | Two independent push systems must sync | `PushCorrelator` with 500ms timeout, phone number normalization |

---

## Appendix A: Z360 iOS VoIP Component Map

| Component | Lines | File Path | Purpose |
|---|---|---|---|
| Z360VoIPService | 2,253 | `ios/App/App/VoIP/Services/Z360VoIPService.swift` | Main orchestrator |
| PushKitManager | 949 | `ios/App/App/VoIP/Managers/PushKitManager.swift` | VoIP push handling |
| TelnyxService | 667 | `ios/App/App/VoIP/Services/TelnyxService.swift` | Telnyx SDK wrapper |
| VoIPLogger | 711 | `ios/App/App/VoIP/Utilities/VoIPLogger.swift` | Structured logging |
| PushCorrelator | 611 | `ios/App/App/VoIP/Utilities/PushCorrelator.swift` | Two-push sync |
| OrganizationSwitcher | 481 | `ios/App/App/VoIP/Utilities/OrganizationSwitcher.swift` | Cross-org calls |
| CallKitManager | 456 | `ios/App/App/VoIP/Managers/CallKitManager.swift` | CallKit integration |
| AudioManager | 445 | `ios/App/App/VoIP/Managers/AudioManager.swift` | Audio routing |
| NetworkMonitor | 419 | `ios/App/App/VoIP/Utilities/NetworkMonitor.swift` | Network detection |
| CallQualityMonitor | 286 | `ios/App/App/VoIP/Utilities/CallQualityMonitor.swift` | Quality metrics |
| VoIPModels | 169 | `ios/App/App/VoIP/Models/VoIPModels.swift` | Data models |
| KeychainManager | 111 | `ios/App/App/VoIP/Utilities/KeychainManager.swift` | Secure storage |
| CallInfo | 61 | `ios/App/App/VoIP/Models/CallInfo.swift` | Call state model |

---

## Appendix B: External References

- [Apple PushKit Documentation](https://developer.apple.com/documentation/PushKit)
- [Apple CallKit Documentation](https://developer.apple.com/documentation/CallKit)
- [Apple Developer Forums — PushKit iOS 13 Restrictions](https://developer.apple.com/forums/thread/117939)
- [Apple Developer Forums — CallKit Issues](https://developer.apple.com/forums/thread/114076)
- [VoIP Push Notification Troubleshooting Guide](https://connectycube.com/2025/11/06/troubleshooting-common-issues-with-voip-push-notifications-on-ios/)
- [Vonage — How To Handle VoIP Push Notifications using iOS CallKit](https://developer.vonage.com/en/blog/handling-voip-push-notifications-with-callkit)
