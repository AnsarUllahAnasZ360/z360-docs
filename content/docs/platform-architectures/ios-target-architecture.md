---
title: iOS Target Architecture
---

# iOS Target VoIP Architecture

> **Purpose**: Define the target architecture for Z360's iOS VoIP implementation. Every design decision references either Apple platform requirements, Telnyx SDK patterns (from the official demo app), or Z360-specific constraints (Capacitor hybrid, multi-tenant, two-push, simultaneous ring).
>
> **Prerequisite reading**: `00-system-context/` (system architecture, mobile platform, flows), `01-technology-landscape/` (iOS platform requirements, Telnyx SDKs, Capacitor architecture, credentials & push).
>
> **Reference implementations**: Telnyx iOS Demo App (`.scratchpad/packs/telnyx-ios-demo.xml`), Telnyx iOS SDK (`.scratchpad/packs/telnyx-ios-sdk.xml`), Z360 iOS skill (`.claude/skills/voip-ios/`).

---

## Table of Contents

1. [Initialization Sequence](#1-initialization-sequence)
2. [PushKit / CallKit Contract](#2-pushkit--callkit-contract)
3. [Two-Push Correlation Design](#3-two-push-correlation-design)
4. [Call State Machine](#4-call-state-machine)
5. [Platform Isolation](#5-platform-isolation)
6. [Audio Session Management](#6-audio-session-management)
7. [Outbound Call Flow](#7-outbound-call-flow)
8. [CallKit UI Customization](#8-callkit-ui-customization)
9. [Sign in with Apple Integration](#9-sign-in-with-apple-integration)
10. [Component Dependency Map](#10-component-dependency-map)
11. [File Reference Index](#11-file-reference-index)

---

## 1. Initialization Sequence

### 1.1 The Problem: WebKit IPC Starvation

Capacitor hybrid apps must initialize both a native VoIP layer **and** a WKWebView for the React SPA. These two subsystems compete for system resources during cold launch.

**Root cause**: `AVAudioSession.setCategory(.playAndRecord, mode: .voiceChat, ...)` triggers the `mediaserverd` audio daemon. During cold launch, this daemon initialization starves WebKit's IPC pipe — the Mach messages between the WebView process and the app process are blocked while the audio subsystem spins up.

**Measured impact**: Without mitigation, WebView launch takes **37–43 seconds** on real devices (iPhone 12–15, iOS 16–17). With two-phase startup, launch takes **~2 seconds**.

This is a Z360-specific constraint. The Telnyx demo app (pure native, no WebView) configures audio immediately in `didFinishLaunchingWithOptions` without issue.

### 1.2 Two-Phase Startup Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     PHASE 1: didFinishLaunchingWithOptions              │
│                     Budget: ~50ms | MINIMAL — Apple mandates only       │
│                                                                         │
│  1. PushKitManager.shared.initialize()                                  │
│     └── PKPushRegistry(queue: .main)                                    │
│     └── desiredPushTypes = [.voIP]                                      │
│     └── delegate = self                                                 │
│     WHY: Apple mandate. PushKit must be registered at launch or         │
│          pushes may not be delivered.                                    │
│                                                                         │
│  2. Z360VoIPService.shared.setupMinimal(callKitManager: .shared)        │
│     └── Wire CallKitManager.delegate = Z360VoIPService                  │
│     └── Wire TelnyxService.delegate = Z360VoIPService                   │
│     └── NO audio, NO network, NO Firebase                               │
│     WHY: CallKit delegate must be set before PushKit push arrives.      │
│          If push arrives during launch, CallKitManager.reportIncoming() │
│          must have a working delegate chain.                            │
│                                                                         │
│  3. UNUserNotificationCenter.current().delegate = self                  │
│     WHY: Standard notification display management.                      │
│                                                                         │
│  4. return true (NOTHING ELSE)                                          │
│                                                                         │
│  FORBIDDEN in Phase 1:                                                  │
│  ✗ AVAudioSession.setCategory()    — triggers audio daemon              │
│  ✗ FirebaseApp.configure()         — heavy I/O, blocks main thread      │
│  ✗ NWPathMonitor.start()           — unnecessary XPC at launch          │
│  ✗ Any network requests             — no session available yet          │
│  ✗ UserDefaults complex reads       — minimize I/O                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  iOS creates UIScene
                                    │  WebView starts loading
                                    │  First frame renders
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     PHASE 2: sceneDidBecomeActive                       │
│                     Triggered by: SceneDelegate.sceneDidBecomeActive()  │
│                     Guard: hasDeferredInitialization (run once)          │
│                                                                         │
│  1. configureAudioSessionForVoIP()                                      │
│     └── AVAudioSession.setCategory(.playAndRecord,                      │
│            mode: .voiceChat,                                            │
│            options: [.allowBluetoothHFP, .allowBluetoothA2DP])          │
│     WHY: Safe now — WebKit IPC pipe is established.                     │
│     NOTE: Configure only, do NOT activate. CallKit owns activation.     │
│                                                                         │
│  2. Z360VoIPService.shared.completeSetup()                              │
│     └── Start NetworkMonitor (NWPathMonitor)                            │
│     └── Register for audio route change notifications                   │
│     └── Check for orphan call state (crash recovery, US-026)            │
│                                                                         │
│  3. configureFirebase() — on background queue (.utility QoS)            │
│     └── FirebaseApp.configure()                                         │
│     └── Crashlytics initialization                                      │
│     └── Analytics initialization                                        │
│     WHY: Firebase is heavy I/O. Running on utility queue prevents       │
│          blocking the main thread.                                      │
│                                                                         │
│  4. checkSessionExpiry()                                                │
│     └── Read credential_expires_at from VoipStore                       │
│     └── If expired (>30 days), flag for re-registration                 │
│                                                                         │
│  5. cleanupOrphanCallState()                                            │
│     └── Read PersistableCallState from VoipStore                        │
│     └── If stale (app crash during active call), report end to CallKit  │
│     └── Clear persisted state                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Race Condition: Push During Phase 1

If a VoIP push arrives between Phase 1 and Phase 2 (WebView not yet loaded):

```
PushKit push arrives
    │
    ▼
PushKitManager.didReceiveIncomingPush()     ← Phase 1 registered this
    │
    ├── Load credentials from Keychain (synchronous, ~5ms)
    │   └── KeychainManager.loadCredentials() uses Security framework
    │       └── SecItemCopyMatching is synchronous, no daemon needed
    │
    ├── Feed PushCorrelator with push data
    │
    ├── CallKitManager.reportIncomingCall()  ← Phase 1 wired the delegate
    │   └── CXProvider.reportNewIncomingCall(with:update:)
    │   └── iOS shows system call UI (lock screen, banner, full screen)
    │
    └── If Telnyx SDK not connected yet:
        └── Connect with Keychain credentials
        └── Wait for ClientReady (up to 5s)
        └── If SDK ready → answer will work
        └── If SDK not ready → CallKit UI visible but answer may delay
```

**Key insight**: Keychain reads are synchronous and do not require any daemon. This is why credentials are stored in Keychain (via `KeychainManager`) rather than UserDefaults — Keychain is available immediately at any app state.

### 1.4 Initialization Timing Budget

| Step | Budget | Actual | Notes |
|------|--------|--------|-------|
| Phase 1 total | <100ms | ~50ms | PushKit + delegate wiring only |
| PushKit init | <20ms | ~10ms | PKPushRegistry creation + delegate |
| VoIP service minimal | <30ms | ~15ms | Delegate wiring, no I/O |
| Phase 2 total | <500ms | ~300ms | After first frame |
| Audio config | <50ms | ~30ms | setCategory only, no activation |
| Firebase | <200ms | ~150ms | Background queue, non-blocking |
| Network monitor | <20ms | ~10ms | NWPathMonitor start |
| Session check | <50ms | ~20ms | Keychain read |

**Source references**:
- AppDelegate Phase 1: `ios/App/App/AppDelegate.swift`
- SceneDelegate Phase 2: `ios/App/App/SceneDelegate.swift`
- Telnyx demo (single-phase): `telnyx-ios-demo.xml` — `AppDelegate.swift` lines 4021–4089

---

## 2. PushKit / CallKit Contract

### 2.1 Apple's Non-Negotiable Requirements

Apple enforces the following contract for VoIP push notifications (iOS 13+):

| Requirement | Deadline | Consequence of Violation |
|---|---|---|
| Every VoIP push MUST report to CallKit | ~5 seconds | App **terminated by iOS** |
| Repeated violations | Cumulative | iOS **stops delivering VoIP pushes entirely** |
| PushKit completion handler | After CallKit report | Push delivery hangs |
| Only use VoIP push for actual calls | Always | App Store **rejection** (Guideline 2.5.4) |

There is no grace period. There is no recovery from push revocation short of the user reinstalling the app.

### 2.2 Fastest Path: Push to CallKit Report

The target architecture optimizes for the absolute minimum latency between PushKit delivery and CallKit report:

```
┌───────────────────────────────────────────────────────────────────────┐
│ PushKit delivers VoIP push                                            │
│ pushRegistry(_:didReceiveIncomingPushWith:for:completion:)             │
│                                                                       │
│ T+0ms   Extract push type from payload                                │
│         ├── Is Z360 push? (has "type": "incoming_call")               │
│         └── Is Telnyx push? (has "metadata" key)                      │
│                                                                       │
│ T+1ms   Extract caller info                                           │
│         ├── Z360: callerName, callerNumber, orgId from payload        │
│         └── Telnyx: callerNumber from metadata.caller_number          │
│                                                                       │
│ T+2ms   Generate or extract CallKit UUID                              │
│         ├── Z360 push includes call_id → use as UUID                  │
│         └── Telnyx push: generate new UUID                            │
│                                                                       │
│ T+3ms   *** REPORT TO CALLKIT IMMEDIATELY ***                         │
│         CallKitManager.reportIncomingCall(                             │
│             uuid: callKitUUID,                                        │
│             handle: callerNumber,        // always available           │
│             callerName: callerName,      // may be nil if Telnyx-only  │
│             hasVideo: false              // voice only                 │
│         )                                                             │
│                                                                       │
│ T+5ms   CallKit reports success → iOS shows system call UI            │
│                                                                       │
│ T+5ms   AFTER CallKit report (async, non-blocking):                   │
│         ├── Feed PushCorrelator for two-push sync                     │
│         ├── Ensure Telnyx SDK connected (Keychain credentials)        │
│         ├── Persist call info to VoipStore (crash recovery)           │
│         └── Notify plugin delegate if WebView is loaded               │
│                                                                       │
│ T+10ms  Call PushKit completion handler                               │
│         ├── Use DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) │
│         │   to avoid race with CallKit report                         │
│         └── Known Apple bug: completion + reportNewIncoming race      │
│                                                                       │
│ TOTAL: Push → CallKit report in ~5ms                                  │
│ Well within 5-second deadline (1000x safety margin)                   │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.3 Design Principles

1. **Report first, correlate later**. CallKit report happens with whatever data is available. The caller name and avatar can be updated later via `CXCallUpdate`.

2. **Never block on network**. The push handler must never await a network call before reporting to CallKit. Credentials are loaded from Keychain (synchronous). Telnyx SDK connection happens in parallel.

3. **Never block on the other push**. The PushCorrelator waits up to 500ms for the partner push, but CallKit is reported immediately. If the Z360 push arrives with a caller name, great. If only Telnyx push is available, report with phone number only and update the name when Z360 push arrives.

4. **Completion handler delayed**. Apple's `completion()` handler for PushKit has a known race condition with `reportNewIncomingCall`. Delaying the completion call by ~2 seconds avoids this.

### 2.4 CXCallUpdate for Late-Arriving Data

When the Z360 push arrives after CallKit has already been reported (from Telnyx push with number only):

```swift
// PushCorrelator detects Z360 push arrived AFTER CallKit report
func updateCallKitDisplay(uuid: UUID, callerName: String, callerNumber: String) {
    let update = CXCallUpdate()
    update.localizedCallerName = callerName
    update.remoteHandle = CXHandle(type: .phoneNumber, value: callerNumber)

    callKitManager.cxProvider.reportCall(with: uuid, updated: update)
    // CallKit UI updates in real-time — user sees name appear
}
```

This is the correct pattern. CallKit supports updating call metadata after the initial report.

**Source references**:
- PushKitManager: `ios/App/App/VoIP/Managers/PushKitManager.swift`
- CallKitManager.reportIncomingCall: `ios/App/App/VoIP/Managers/CallKitManager.swift`
- Telnyx demo push handling: `telnyx-ios-demo.xml` — `AppDelegate.swift` lines 4330–4383
- Apple PushKit docs: `.claude/skills/voip-ios-platform/SKILL.md`

---

## 3. Two-Push Correlation Design

### 3.1 Why Two Pushes?

Z360 uses a **server-mediated push model** (not Telnyx's native push binding). When an inbound call arrives:

1. **Z360 Backend Push** (via APNs VoIP): Contains rich caller info — name, avatar URL, organization context, call session ID, channel number. This data comes from Z360's contact database.

2. **Telnyx SDK Push** (via APNs VoIP): Contains call control metadata — Telnyx call ID, signaling server address, SDP info. This data is needed by the Telnyx SDK to connect to the correct call.

**Either push can arrive first.** They must be correlated before the call can be fully established.

### 3.2 Correlation Key: Normalized Phone Number

Both pushes contain the caller's phone number. Correlation uses the last 10 digits:

```
Z360 push:   caller_number = "+18179398981"  → normalize → "8179398981"
Telnyx push: caller_number = "8179398981"    → normalize → "8179398981"
                                                             ↓
                                                          MATCH
```

```swift
private func normalizePhoneNumber(_ phone: String) -> String {
    let digits = phone.filter { $0.isNumber }
    return String(digits.suffix(10))  // Last 10 digits handles +1, country codes
}
```

**Limitation**: International numbers with fewer than 10 digits may fail to correlate. This is acceptable for Z360's US-focused market.

### 3.3 PushCorrelator: Swift Actor Design

The PushCorrelator uses Swift's `actor` isolation to guarantee thread safety without locks:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PushCorrelator (Swift Actor)                     │
│                                                                     │
│  State:                                                             │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  pendingByPhone: [NormalizedPhone: SyncEntry]           │       │
│  │                                                         │       │
│  │  SyncEntry {                                            │       │
│  │    z360Data: Z360PushData?                              │       │
│  │    telnyxData: TelnyxPushData?                          │       │
│  │    continuation: CheckedContinuation<MergedData?, Never>?│       │
│  │    createdAt: Date                                      │       │
│  │  }                                                      │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  Methods:                                                           │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  receiveZ360Push(callerName:callerNumber:orgId:...)     │       │
│  │    → void (synchronous store or resume waiting Telnyx)  │       │
│  │                                                         │       │
│  │  receiveTelnyxPush(callId:callerNumber:callerName:...)  │       │
│  │    → async PushSyncResult (waits up to 500ms for Z360)  │       │
│  │                                                         │       │
│  │  cleanup() → void (remove stale entries >10s)           │       │
│  └─────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.4 Correlation Flow: All Scenarios

**Scenario A: Z360 push arrives first (typical, ~60% of cases)**

```
T+0ms    Z360 push arrives via PushKit
         │
         ├── Report to CallKit IMMEDIATELY (callerName available)
         │   └── Full display: "Alice Smith" + phone number
         │
         ├── PushCorrelator.receiveZ360Push(...)
         │   └── Store Z360 data in pendingByPhone["8179398981"]
         │
T+50ms   Telnyx push arrives via PushKit
         │
         ├── CallKit already reported — no second report needed
         │
         ├── PushCorrelator.receiveTelnyxPush(...)
         │   └── Find Z360 data already waiting → IMMEDIATE MERGE
         │   └── Return MergedPushData with full display + Telnyx callId
         │
         └── Route to TelnyxService.processVoIPNotification(...)
             └── SDK connects, waits for SIP INVITE
```

**Scenario B: Telnyx push arrives first (~35% of cases)**

```
T+0ms    Telnyx push arrives via PushKit
         │
         ├── Report to CallKit IMMEDIATELY (phone number only)
         │   └── Partial display: "+18179398981" (no name yet)
         │
         ├── PushCorrelator.receiveTelnyxPush(...)
         │   └── No Z360 data yet → create SyncEntry with continuation
         │   └── WAIT (withCheckedContinuation) up to 500ms
         │
         ├── Route to TelnyxService.processVoIPNotification(...)
         │   └── SDK begins connecting in parallel
         │
T+150ms  Z360 push arrives via PushKit
         │
         ├── PushCorrelator.receiveZ360Push(...)
         │   └── Find waiting continuation → RESUME IMMEDIATELY
         │   └── Telnyx push gets MergedPushData
         │
         ├── Update CallKit display:
         │   └── CXProvider.reportCall(with:updated:)
         │   └── UI updates: "Alice Smith" appears
         │
         └── Total correlation time: 150ms (well within budget)
```

**Scenario C: Z360 push timeout (~5% of cases)**

```
T+0ms    Telnyx push arrives
         ├── Report to CallKit (phone number only)
         ├── PushCorrelator.receiveTelnyxPush(...) → WAIT
         │
T+500ms  TIMEOUT — Z360 push has not arrived
         │
         ├── PushCorrelator returns PushSyncResult with:
         │   └── syncType: .timeout
         │   └── displayInfo: phone number only, no name/avatar
         │
         └── Call proceeds with partial display
             └── If Z360 push arrives later, CallKit display updates
```

**Scenario D: Telnyx push never arrives (call lost, <1% of cases)**

```
T+0ms    Z360 push arrives
         ├── Report to CallKit (full display)
         ├── Store in PushCorrelator
         │
T+5000ms No Telnyx push → no call control metadata
         │
         └── Call cannot be answered (no Telnyx call ID)
             └── PushCorrelator cleanup removes stale entry
             └── CallKit shows call but answer will fail
             └── End call after timeout
```

### 3.5 Data Shapes

**Z360 Push Payload** (rich, from Z360 backend via APNs VoIP push):
```json
{
  "type": "incoming_call",
  "call_session_id": "uuid-session",
  "call_control_id": "uuid-control",
  "caller_number": "+18179398981",
  "caller_name": "Alice Smith",
  "caller_avatar": "https://cdn.z360.com/avatars/abc.jpg",
  "channel_number": "+15551234567",
  "call_id": "uuid-call",
  "organization_id": "42",
  "organization_name": "Acme Corp",
  "organization_slug": "acme-corp",
  "timestamp": "1717000000"
}
```

**Telnyx SDK Push Payload** (minimal, from Telnyx platform via APNs VoIP push):
```json
{
  "metadata": {
    "call_id": "telnyx-uuid",
    "caller_name": "8179398981",
    "caller_number": "8179398981",
    "voice_sdk_id": "sdk-uuid"
  }
}
```

**Merged Result** (after correlation):
```swift
struct MergedPushData {
    let callKitUUID: UUID           // From Z360 push call_id or generated
    let telnyxCallId: String        // From Telnyx metadata.call_id
    let callerName: String          // From Z360 push ("Alice Smith")
    let callerNumber: String        // Full E.164 from Z360 push
    let callerAvatar: String?       // From Z360 push
    let organizationId: String      // From Z360 push
    let organizationName: String?   // From Z360 push
    let callSessionId: String?      // From Z360 push
    let channelNumber: String?      // From Z360 push
}
```

**Source references**:
- PushCorrelator: `ios/App/App/VoIP/Services/PushCorrelator.swift`
- Push payload structure: `app/Services/PushNotificationService.php`
- Telnyx SDK push processing: `telnyx-ios-sdk.xml` — `TxClient.swift`

---

## 4. Call State Machine

### 4.1 State Definitions

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Z360 iOS Call States                          │
├──────────────┬───────────────────────────────────────────────────────┤
│ State        │ Description                                          │
├──────────────┼───────────────────────────────────────────────────────┤
│ IDLE         │ No active call. SDK may or may not be connected.     │
│ RINGING_IN   │ Incoming call reported to CallKit. Awaiting user     │
│              │ action (answer/decline). Telnyx INVITE may be        │
│              │ pending or received.                                  │
│ RINGING_OUT  │ Outgoing call initiated. CXStartCallAction           │
│              │ fulfilled. Waiting for remote party to answer.        │
│ CONNECTING   │ Call answered (user tapped Answer or remote           │
│              │ answered outbound). SDP exchange in progress.         │
│              │ Audio not yet flowing.                                │
│ ACTIVE       │ Call fully established. Audio flowing. Media          │
│              │ session active via CallKit didActivate.               │
│ ON_HOLD      │ Call placed on hold. Telnyx SDK sent MODIFY(hold).   │
│              │ Audio muted. Can resume to ACTIVE.                    │
│ RECONNECTING │ Network disruption detected. SDK attempting to        │
│              │ re-establish WebSocket/media. May recover to          │
│              │ ACTIVE or transition to FAILED.                       │
│ DISCONNECTING│ Call end initiated. CXEndCallAction requested.        │
│              │ Telnyx SDK sending BYE. Cleaning up audio.            │
│ ENDED        │ Call completed normally. Cleanup in progress.         │
│              │ Transitions to IDLE after cleanup.                    │
│ FAILED       │ Call failed (network error, SDK error, answer         │
│              │ timeout). Reported to CallKit with failure reason.     │
│              │ Transitions to IDLE after cleanup.                    │
└──────────────┴───────────────────────────────────────────────────────┘
```

### 4.2 State Transition Diagram

```
                                    ┌─────────┐
                                    │  IDLE   │
                                    └────┬────┘
                                         │
                        ┌────────────────┼────────────────┐
                        │                │                │
                   VoIP push        JS makeCall()     crash recovery
                   arrives          via bridge        orphan found
                        │                │                │
                        ▼                ▼                ▼
                  ┌───────────┐   ┌───────────┐    ┌──────────┐
                  │RINGING_IN │   │RINGING_OUT│    │  FAILED  │
                  └─────┬─────┘   └─────┬─────┘    └────┬─────┘
                        │               │               │
              ┌─────────┼─────┐         │          cleanup
              │         │     │         │               │
         user taps   user taps  timeout │               ▼
          Answer     Decline   (30s)    │          ┌─────────┐
              │         │     │         │          │  IDLE   │
              │         ▼     ▼         │          └─────────┘
              │    ┌──────────────┐     │
              │    │DISCONNECTING │◄────┤ remote hangs up
              │    └──────┬───────┘     │ (any active state)
              │           │             │
              │      BYE sent,          │
              │      cleanup            │
              │           │             │
              │           ▼             │
              │    ┌──────────┐         │
              │    │  ENDED   │         │
              │    └────┬─────┘         │
              │         │               │
              │    timer/cleanup        │
              │         │               │
              │         ▼               │
              │    ┌─────────┐          │
              │    │  IDLE   │          │
              │    └─────────┘          │
              │                         │
              ▼                         ▼
        ┌────────────┐           ┌────────────┐
        │ CONNECTING │           │ CONNECTING │
        └──────┬─────┘           └──────┬─────┘
               │                        │
          SDP exchange             SDP exchange
          audio session            audio session
          activated                activated
               │                        │
               ▼                        ▼
        ┌────────────┐           ┌────────────┐
        │   ACTIVE   │           │   ACTIVE   │
        └──────┬─────┘           └──────┬─────┘
               │                        │
        ┌──────┼──────────┐             │
        │      │          │             │
    hold()  network    end call    same as
        │    drop         │        inbound
        ▼      │          │
  ┌──────────┐ │    ┌──────────────┐
  │ ON_HOLD  │ │    │DISCONNECTING │
  └────┬─────┘ │    └──────────────┘
       │       │
   unhold()    ▼
       │  ┌──────────────┐
       │  │ RECONNECTING │
       │  └──────┬───────┘
       │         │
       │    ┌────┼────┐
       │    │         │
       │  success   failure
       │    │       (60s timeout)
       │    │         │
       ▼    ▼         ▼
  ┌──────────┐  ┌──────────┐
  │  ACTIVE  │  │  FAILED  │
  └──────────┘  └──────────┘
```

### 4.3 CallKit Action → State Transition Mapping

| CallKit Action | Current State | New State | Side Effects |
|---|---|---|---|
| `CXAnswerCallAction` | RINGING_IN | CONNECTING | ActionGuard check, cross-org switch if needed, SDK answer |
| `CXStartCallAction` | IDLE | RINGING_OUT | ActiveCallGuard acquire, SDK newCall |
| `CXEndCallAction` | Any active | DISCONNECTING | SDK hangup, audio cleanup |
| `CXSetMutedCallAction` | ACTIVE, ON_HOLD | Same | AudioManager.setMute() |
| `CXSetHeldCallAction` | ACTIVE → ON_HOLD | ON_HOLD / ACTIVE | AudioManager.setHold(), auto-mute |
| `CXPlayDTMFCallAction` | ACTIVE | ACTIVE | AudioManager.sendDTMF() |
| `didActivate audioSession` | CONNECTING | ACTIVE | TelnyxService.enableAudioSession() |
| `didDeactivate audioSession` | Any → ENDED | ENDED | TelnyxService.disableAudioSession() |

### 4.4 Guards and Constraints

| Guard | Purpose | Mechanism |
|---|---|---|
| **ActionGuard** | Prevent double-tap answer/call | Swift Actor with `tryStartAction()` returns Bool |
| **ActiveCallGuard** | Single call enforcement (US-014, US-025) | Swift Actor with acquire/release |
| **Cross-org check** | Detect if call's org ≠ current org | Compare push orgId vs Organization.current().id |
| **SDK readiness** | Ensure Telnyx client can answer | `waitForPushCallReady(timeout: 5s)` |

### 4.5 Telnyx SDK State to Z360 State Mapping

| Telnyx `CallState` | Z360 State | Notes |
|---|---|---|
| `NEW` | RINGING_IN or RINGING_OUT | Depends on call direction |
| `CONNECTING` | CONNECTING | SDP exchange |
| `RINGING` | RINGING_OUT | Only for outbound calls |
| `ACTIVE` | ACTIVE | Media flowing |
| `HELD` | ON_HOLD | Server-side hold |
| `RECONNECTING(reason)` | RECONNECTING | Network disruption |
| `DROPPED(reason)` | FAILED | Unrecoverable drop |
| `DONE(reason)` | ENDED | Normal termination |

**Source references**:
- Z360VoIPService state handling: `ios/App/App/VoIP/Services/Z360VoIPService.swift`
- CallKitManager delegate: `ios/App/App/VoIP/Managers/CallKitManager.swift`
- Telnyx SDK CallState: `telnyx-ios-sdk.xml` — `TxCallInfo.swift`
- ActionGuard: `ios/App/App/VoIP/Utils/ActionGuard.swift`
- ActiveCallGuard: `ios/App/App/VoIP/Utils/ActiveCallGuard.swift`

---

## 5. Platform Isolation

### 5.1 The Problem: Dual VoIP Layers

Z360 runs as a Capacitor hybrid app. The web SPA includes `@telnyx/react-client` (TelnyxRTCProvider) for browser-based WebRTC calling. On native iOS, calls must use the native Telnyx SDK via CallKit. If both layers are active simultaneously:

- **Dual WebSocket connections** to Telnyx (double registration, SIP stealing)
- **Conflicting audio sessions** (WebView audio vs native audio)
- **Duplicate call handling** (both layers try to process the same INVITE)

### 5.2 NativeVoipProvider Design

The target architecture uses a **provider swap pattern**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Provider Selection (app.tsx)                     │
│                                                                     │
│  if (Capacitor.isNativePlatform()) {                                │
│    // Native: Use NativeVoipProvider                                │
│    // - Bridges to native TelnyxVoipPlugin via Capacitor            │
│    // - Does NOT create TelnyxRTC WebSocket connection              │
│    // - All call handling delegated to native layer                 │
│    <NativeVoipProvider>                                             │
│      <DialpadProvider>                                              │
│        <Page />                                                     │
│      </DialpadProvider>                                             │
│    </NativeVoipProvider>                                            │
│  } else {                                                           │
│    // Web: Use TelnyxRTCProvider                                    │
│    // - Creates WebSocket connection directly from browser           │
│    // - Handles calls via @telnyx/react-client                      │
│    <TelnyxRTCProvider credential={webCredentials}>                   │
│      <DialpadProvider>                                              │
│        <Page />                                                     │
│      </DialpadProvider>                                             │
│    </TelnyxRTCProvider>                                             │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 NativeVoipProvider Responsibilities

```
┌─────────────────────────────────────────────────────────────────────┐
│                     NativeVoipProvider (React)                       │
│                                                                     │
│  On Mount:                                                          │
│  1. Register TelnyxVoip event listeners via Capacitor               │
│  2. Call TelnyxVoip.getPendingIncomingCall() (cold start recovery)  │
│  3. Provide VoIP context to child components                        │
│                                                                     │
│  State Management:                                                  │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  isConnected: boolean       (from 'connected' event)    │       │
│  │  activeCall: CallInfo       (from 'callAnswered' event) │       │
│  │  incomingCall: CallInfo     (from 'incomingCall' event) │       │
│  │  callDuration: number       (from 'callDurationUpdated')│       │
│  │  isMuted: boolean           (from 'muteStateChanged')   │       │
│  │  isSpeakerOn: boolean       (from 'speakerStateChanged')│       │
│  │  networkStatus: string      (from 'networkStatusChanged')│       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  Control Methods (delegated to native via Capacitor bridge):        │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  connect(credentials) → TelnyxVoip.connect(...)         │       │
│  │  disconnect()         → TelnyxVoip.disconnect()         │       │
│  │  makeCall(number)     → TelnyxVoip.makeCall(...)        │       │
│  │  hangup()             → TelnyxVoip.hangup()             │       │
│  │  setMute(bool)        → TelnyxVoip.setMute(...)         │       │
│  │  setSpeaker(bool)     → TelnyxVoip.setSpeaker(...)      │       │
│  │  setHold(bool)        → TelnyxVoip.setHold(...)         │       │
│  │  sendDTMF(digit)      → TelnyxVoip.sendDTMF(...)        │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  What It Does NOT Do:                                               │
│  ✗ Does NOT create WebSocket to Telnyx                              │
│  ✗ Does NOT import @telnyx/react-client                             │
│  ✗ Does NOT handle WebRTC peer connections                          │
│  ✗ Does NOT manage audio sessions                                   │
│  ✗ Does NOT process push notifications                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.4 Native → WebView Event Flow

When native call state changes, the WebView is notified via Capacitor's `notifyListeners`:

```
Native Layer                     Capacitor Bridge               WebView (React)
     │                                │                              │
     │  Call state changes             │                              │
     │  (e.g., callAnswered)          │                              │
     │                                │                              │
     │  TelnyxVoipPlugin              │                              │
     │  .notifyListeners(             │                              │
     │    "callAnswered",             │                              │
     │    data: ["callId": uuid])     │                              │
     │──────────────────────────────►│                              │
     │                                │  JSON serialized over        │
     │                                │  WKWebView bridge            │
     │                                │──────────────────────────────►│
     │                                │                              │
     │                                │                useTelnyxVoip hook
     │                                │                listener fires
     │                                │                setState(...)
     │                                │                UI re-renders
```

### 5.5 Call Survival Across WebView Events

The native VoIP layer is independent of the WebView. Active calls survive:

| WebView Event | Call Impact | Why |
|---|---|---|
| Page navigation (Inertia) | None | Native SDK connection persists |
| WebView reload | None | Listeners re-registered on mount |
| WebView crash | None | Native call continues; state recovered on restart |
| App background | None | `audio` background mode keeps call alive |
| WebView not loaded (cold start) | None | Native handles entire call path |

**Source references**:
- NativeVoipProvider: `resources/js/providers/native-voip-provider.tsx`
- TelnyxVoipPlugin (iOS): `ios/App/App/VoIP/TelnyxVoipPlugin.swift`
- Platform detection: `resources/js/utils/platform.ts`
- useTelnyxVoip hook: `resources/js/plugins/use-telnyx-voip.ts`

---

## 6. Audio Session Management

### 6.1 Audio Session Ownership Model

On iOS, **CallKit owns the audio session** for VoIP calls. The app must not activate or deactivate the audio session directly during a call. Instead:

```
┌───────────────────────────────────────────────────────────────────┐
│                  Audio Session Lifecycle                           │
│                                                                   │
│  App startup (Phase 2):                                           │
│  └── CONFIGURE only: setCategory(.playAndRecord, .voiceChat)     │
│      └── Options: [.allowBluetoothHFP, .allowBluetoothA2DP]      │
│      └── Do NOT call setActive(true)                              │
│                                                                   │
│  Call answered / outbound started:                                │
│  └── CallKit activates audio session internally                   │
│  └── CXProviderDelegate.didActivate(audioSession:) fires          │
│      └── Z360VoIPService receives delegate callback               │
│      └── TelnyxService.enableAudioSession(audioSession:)          │
│          └── TxClient.enableAudioSession(audioSession:)           │
│          └── Audio begins flowing through WebRTC                  │
│                                                                   │
│  Call ended / declined:                                           │
│  └── CallKit deactivates audio session internally                 │
│  └── CXProviderDelegate.didDeactivate(audioSession:) fires        │
│      └── Z360VoIPService receives delegate callback               │
│      └── TelnyxService.disableAudioSession(audioSession:)         │
│          └── TxClient.disableAudioSession(audioSession:)          │
│          └── Audio stops, WebRTC peer connection cleaned up        │
└───────────────────────────────────────────────────────────────────┘
```

### 6.2 Audio Session Configuration

```swift
// Target configuration (identical to current Z360 implementation)
func configureAudioSessionForVoIP() {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(
        .playAndRecord,                    // Two-way audio
        mode: .voiceChat,                   // Echo cancellation + AGC + noise suppression
        options: [
            .allowBluetoothHFP,            // Bluetooth Hands-Free Profile
            .allowBluetoothA2DP            // Bluetooth Advanced Audio Distribution
        ]
    )
    // NOTE: Do NOT call setActive(true) here.
    // CallKit will activate when a call connects.
}
```

**Comparison with Telnyx demo**:
- Demo uses: `.allowBluetooth, .allowBluetoothA2DP` + calls `setActive(true)` immediately
- Z360 must NOT call `setActive(true)` in Phase 2 because audio daemon conflicts with WebKit
- Z360 uses `.allowBluetoothHFP` (HFP is more appropriate for voice calls than generic `.allowBluetooth`)

**Comparison with Telnyx SDK internal config** (from `telnyx-ios-sdk.xml` — `Peer.swift`):
- SDK internally sets: `.duckOthers, .allowBluetooth` with `setPreferredIOBufferDuration(0.01)` for 10ms latency
- SDK's internal config is applied when `enableAudioSession` is called
- Z360's app-level config and SDK's internal config coexist because `enableAudioSession` passes the session object

### 6.3 Audio Route Management

```
┌─────────────────────────────────────────────────────────────────┐
│                    Audio Route State Machine                     │
│                                                                 │
│  Default: EARPIECE (receiver speaker)                           │
│                                                                 │
│  EARPIECE ──── setSpeaker(true) ────► SPEAKER                   │
│     ▲                                    │                      │
│     │                                    │                      │
│     └──── setSpeaker(false) ◄────────────┘                      │
│                                                                 │
│  Bluetooth connected:                                           │
│  └── Audio automatically routes to Bluetooth                    │
│  └── Speaker toggle overrides Bluetooth                         │
│  └── Bluetooth disconnect → fallback to Earpiece or Speaker     │
│                                                                 │
│  Implementation:                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Speaker ON:  audioSession.overrideOutputAudioPort(.speaker)│ │
│  │  Speaker OFF: audioSession.overrideOutputAudioPort(.none)  │ │
│  │  Route check: audioSession.currentRoute.outputs            │ │
│  │  Bluetooth:   Check for .bluetoothHFP / .bluetoothA2DP    │ │
│  │  Monitoring:  AVAudioSession.routeChangeNotification       │ │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 6.4 Mute Control

```swift
// AudioManager.setMute(_ muted: Bool) -> Bool
//
// Mute is LOCAL-ONLY: it disables the local audio track
// in the WebRTC peer connection. The remote party hears silence.
// The audio session remains active (CallKit requires it).
//
// Implementation:
// - mute:   TelnyxService.muteAudio()   → call.muteAudio()
// - unmute: TelnyxService.unmuteAudio() → call.unmuteAudio()
// - State tracked in AudioManager.isMuted (thread-safe via stateQueue)
// - Emitted to WebView via notifyListeners("muteStateChanged")
```

### 6.5 Hold with Auto-Mute (BUG-012)

When a call is placed on hold, the local audio track should be muted to prevent audio leaking during the hold negotiation:

```
User taps HOLD
    │
    ├── Save current mute state (userMuteStateBeforeHold)
    │
    ├── If not already muted:
    │   └── setMute(true)  ← auto-mute
    │   └── autoMutedForHold = true
    │
    ├── TelnyxService.hold()  ← Verto MODIFY(hold)
    │
    ▼
ON_HOLD state

User taps UNHOLD
    │
    ├── TelnyxService.unhold()  ← Verto MODIFY(unhold)
    │
    ├── If autoMutedForHold:
    │   └── setMute(userMuteStateBeforeHold)  ← restore original state
    │   └── autoMutedForHold = false
    │
    ▼
ACTIVE state (with original mute state restored)
```

### 6.6 Audio Session vs WebView Coexistence

| Scenario | Audio Owner | WebView Impact |
|---|---|---|
| No active call | WebView | WebView controls audio (media playback, sounds) |
| Call active | Native (via CallKit) | WebView audio suppressed (CallKit takes priority) |
| Call on hold | Native (via CallKit) | WebView audio still suppressed |
| Call ended | WebView | Audio returns to WebView control |

CallKit's audio session activation takes precedence over any WebView audio configuration. This is automatic and requires no special handling.

**Source references**:
- AudioManager: `ios/App/App/VoIP/Managers/AudioManager.swift`
- TelnyxService audio methods: `ios/App/App/VoIP/Services/TelnyxService.swift`
- CallKit audio callbacks: `ios/App/App/VoIP/Managers/CallKitManager.swift`
- Telnyx SDK audio: `telnyx-ios-sdk.xml` — `Peer.swift`

---

## 7. Outbound Call Flow

### 7.1 Complete Outbound Call Sequence

```
User taps "Call" in WebView
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│ JavaScript (WebView)                                                │
│                                                                     │
│ dialpadContext.makeCall("+15551234567")                              │
│     │                                                               │
│     ▼                                                               │
│ TelnyxVoip.makeCall({                                               │
│   destinationNumber: "+15551234567",                                │
│   callerIdName: "John Doe",           // from user profile          │
│   callerIdNumber: "+18001234567"       // from channel config       │
│ })                                                                  │
│     │                                                               │
│     │ Capacitor bridge (JSON serialization)                         │
│     │                                                               │
└─────┼───────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ TelnyxVoipPlugin.makeCall(_ call: CAPPluginCall)                    │
│     │                                                               │
│     ▼                                                               │
│ Z360VoIPService.makeCall(                                           │
│   destinationNumber: "+15551234567",                                │
│   callerIdName: "John Doe",                                        │
│   callerIdNumber: "+18001234567"                                    │
│ )                                                                   │
│     │                                                               │
│     ├── 1. Validate destination number                              │
│     │                                                               │
│     ├── 2. ActionGuard.tryStartAction(.makeCall)                    │
│     │   └── Prevents double-tap → reject if already making call     │
│     │                                                               │
│     ├── 3. ActiveCallGuard.acquire(callId: uuid)                    │
│     │   └── Ensures only one active call → reject if busy           │
│     │                                                               │
│     ├── 4. Request CallKit start action:                            │
│     │   let action = CXStartCallAction(                             │
│     │     call: callUUID,                                           │
│     │     handle: CXHandle(type: .phoneNumber,                      │
│     │                      value: "+15551234567")                    │
│     │   )                                                           │
│     │   callController.request(CXTransaction(action: action))       │
│     │   └── CXProviderDelegate.perform(CXStartCallAction) fires    │
│     │   └── action.fulfill()                                        │
│     │   └── provider.reportOutgoingCall(                            │
│     │         with: uuid,                                           │
│     │         startedConnectingAt: Date()                           │
│     │       )                                                       │
│     │                                                               │
│     ├── 5. TelnyxService.makeCall(                                  │
│     │     callerName: "John Doe",                                   │
│     │     callerNumber: "+18001234567",                              │
│     │     destinationNumber: "+15551234567",                        │
│     │     callId: callUUID                                          │
│     │   )                                                           │
│     │   └── TxClient.newCall(callerName:callerNumber:               │
│     │         destinationNumber:customHeaders:)                     │
│     │   └── Verto INVITE sent to Telnyx                             │
│     │                                                               │
│     ├── 6. Call transitions: NEW → CONNECTING → RINGING             │
│     │   └── Each state change: notifyListeners to WebView           │
│     │   └── provider.reportOutgoingCall(with: uuid,                 │
│     │         connectedAt: Date()) when ACTIVE                      │
│     │                                                               │
│     ├── 7. Remote answers → ACTIVE                                  │
│     │   └── CallKit didActivate(audioSession:)                      │
│     │   └── TelnyxService.enableAudioSession(audioSession:)         │
│     │   └── Audio flows                                             │
│     │                                                               │
│     └── 8. call.resolve(["callId": callUUID])                       │
│         └── JavaScript Promise resolves                             │
│                                                                     │
│ On failure at any step:                                             │
│   └── ActionGuard.reset(.makeCall)                                  │
│   └── ActiveCallGuard.release(callId: callUUID)                     │
│   └── call.reject("Error description")                              │
│   └── JavaScript Promise rejects                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Timing Budget

| Step | Budget | Notes |
|---|---|---|
| Capacitor bridge | ~5ms | JSON serialization + WKWebView message handler |
| Validation + guards | ~2ms | CPU-only, no I/O |
| CallKit start action | ~10ms | CXCallController.request() |
| TelnyxService.makeCall | ~5ms | Creates Call object, sends INVITE |
| Verto INVITE → remote ring | ~200-500ms | Network latency to Telnyx |
| Remote answer | Variable | User decision |
| Audio session activation | ~50ms | CallKit activates |
| **Total (user taps → hears ringing)** | **~300-600ms** | Acceptable UX |

**Source references**:
- TelnyxVoipPlugin.makeCall: `ios/App/App/VoIP/TelnyxVoipPlugin.swift`
- Z360VoIPService.makeCall: `ios/App/App/VoIP/Services/Z360VoIPService.swift`
- Telnyx demo outbound: `telnyx-ios-demo.xml` — `TelnyxService.swift`

---

## 8. CallKit UI Customization

### 8.1 CXProviderConfiguration

CallKit's UI customization is limited to `CXProviderConfiguration`:

```swift
let config = CXProviderConfiguration()

// App identity
config.localizedName = nil              // nil = use CFBundleDisplayName ("Z360")

// Call capabilities
config.supportsVideo = false            // Voice only
config.maximumCallGroups = 1            // One call at a time
config.maximumCallsPerCallGroup = 1     // No conference
config.supportedHandleTypes = [.phoneNumber, .generic]
config.includesCallsInRecents = true    // Show in Phone app Recents

// Visual customization
config.iconTemplateImageData = UIImage(named: "CallKitIcon")?
    .pngData()                          // 40x40pt monochrome PNG
                                        // Must be single-color template image
                                        // iOS applies system tinting

// Audio customization
config.ringtoneSound = "custom_ring.caf" // Custom ringtone file
                                         // Must be <30 seconds
                                         // Must be in app bundle
                                         // .caf, .wav, or .aiff format
```

### 8.2 Caller Display

| Element | Source | Updatable? |
|---|---|---|
| **Caller name** | `CXCallUpdate.localizedCallerName` | Yes, via `reportCall(with:updated:)` |
| **Phone number** | `CXCallUpdate.remoteHandle` | Yes, via `reportCall(with:updated:)` |
| **App icon** | `CXProviderConfiguration.iconTemplateImageData` | No (set at init) |
| **App name** | `CXProviderConfiguration.localizedName` or bundle | No (set at init) |
| **Ringtone** | `CXProviderConfiguration.ringtoneSound` | No (set at init) |

### 8.3 What Apple Controls (Not Customizable)

| Element | Apple's Design |
|---|---|
| **Lock screen layout** | Fixed: icon, name, slide-to-answer |
| **Banner layout** | Fixed: compact notification with Accept/Decline |
| **Full-screen layout** | Fixed: when in Phone app or from Recents |
| **Button colors** | System green (accept), system red (decline) |
| **Animation** | System animation for incoming/outgoing |
| **Hold music** | None (app must provide audio) |
| **Call duration display** | System timer, not customizable |
| **Recents entry format** | App name + caller info + duration |

### 8.4 CallerID Resolution for Incoming Calls

For incoming calls, the caller name comes from two sources:

1. **From push payload**: Z360 push includes `caller_name` from the backend's contact database
2. **From iOS Contacts**: If the caller's number matches an iOS Contact, iOS shows that name

The priority is:
1. iOS Contact match (system-level, overrides everything)
2. `CXCallUpdate.localizedCallerName` (from app)
3. Phone number (fallback)

### 8.5 Icon Requirements

- **Size**: 40x40 points (80x80 pixels @2x, 120x120 pixels @3x)
- **Format**: PNG with transparency
- **Style**: Monochrome (single color on transparent background)
- **Treatment**: iOS applies system tinting — the icon appears as a silhouette
- **File**: Include in the app bundle (e.g., `CallKitIcon.png`)

**Source references**:
- CallKitManager configuration: `ios/App/App/VoIP/Managers/CallKitManager.swift`
- Telnyx demo configuration: `telnyx-ios-demo.xml` — `AppDelegate.swift` lines 4052–4070
- Apple CallKit docs: `.claude/skills/voip-ios-platform/SKILL.md`

---

## 9. Sign in with Apple Integration

### 9.1 Authentication Flow Design

Sign in with Apple provides a native authentication mechanism on iOS. For Z360, this creates a Laravel session from an Apple identity token.

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Sign in with Apple Flow                            │
│                                                                     │
│  1. User taps "Sign in with Apple" button in WebView                │
│     └── JavaScript calls TelnyxVoip.signInWithApple()               │
│         (or a dedicated AppleAuth Capacitor plugin)                  │
│                                                                     │
│  2. Native layer presents ASAuthorizationController                  │
│     ┌──────────────────────────────────────────────┐               │
│     │  let provider = ASAuthorizationAppleIDProvider()│               │
│     │  let request = provider.createRequest()       │               │
│     │  request.requestedScopes = [.fullName, .email]│               │
│     │                                               │               │
│     │  let controller = ASAuthorizationController(  │               │
│     │    authorizationRequests: [request]            │               │
│     │  )                                            │               │
│     │  controller.delegate = self                   │               │
│     │  controller.presentationContextProvider = self│               │
│     │  controller.performRequests()                 │               │
│     └──────────────────────────────────────────────┘               │
│                                                                     │
│  3. iOS presents system Sign in with Apple sheet                    │
│     └── Face ID / Touch ID / password                               │
│     └── User approves                                               │
│                                                                     │
│  4. ASAuthorizationControllerDelegate callback                      │
│     ┌──────────────────────────────────────────────┐               │
│     │  func authorizationController(                │               │
│     │    controller:,                               │               │
│     │    didCompleteWithAuthorization auth:          │               │
│     │  ) {                                          │               │
│     │    guard let credential =                     │               │
│     │      auth.credential as?                      │               │
│     │      ASAuthorizationAppleIDCredential         │               │
│     │    else { return }                            │               │
│     │                                               │               │
│     │    let identityToken = credential             │               │
│     │      .identityToken  // JWT from Apple        │               │
│     │    let authCode = credential                  │               │
│     │      .authorizationCode                       │               │
│     │    let fullName = credential.fullName          │               │
│     │    let email = credential.email                │               │
│     │  }                                            │               │
│     └──────────────────────────────────────────────┘               │
│                                                                     │
│  5. POST to Laravel backend                                         │
│     ┌──────────────────────────────────────────────┐               │
│     │  POST /api/auth/apple                         │               │
│     │  {                                            │               │
│     │    "identity_token": "eyJ...",  // Apple JWT  │               │
│     │    "authorization_code": "abc...",             │               │
│     │    "full_name": { "given": "...", "family": ".│." },          │
│     │    "email": "user@example.com"                │               │
│     │  }                                            │               │
│     └──────────────────────────────────────────────┘               │
│                                                                     │
│  6. Laravel verifies Apple JWT                                      │
│     └── Verify signature against Apple's public keys                │
│     └── Validate iss, aud, exp claims                               │
│     └── Extract Apple user ID (sub claim)                           │
│     └── Find or create User record                                  │
│     └── Create Laravel session                                      │
│     └── Return session cookie + user data                           │
│                                                                     │
│  7. Native layer loads WebView with authenticated session           │
│     └── Set session cookie in WKWebsiteDataStore                    │
│     └── WebView navigates to dashboard                              │
│     └── Inertia recognizes authenticated session                    │
│                                                                     │
│  8. VoIP credentials provisioned                                    │
│     └── Frontend calls POST /api/device-tokens                      │
│     └── Backend creates per-device SIP credential                   │
│     └── Native connects to Telnyx                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.2 Integration with VoIP Credential Lifecycle

Sign in with Apple creates a fresh session. The VoIP credential lifecycle must handle this:

```
Apple sign-in complete → Laravel session created
    │
    ├── WebView loads → Inertia provides user/org context
    │
    ├── useTelnyxVoip hook mounts → registerAndConnect()
    │   ├── TelnyxVoip.requestVoipPermissions()
    │   ├── TelnyxVoip.getDeviceId()
    │   ├── TelnyxVoip.getFcmToken()
    │   └── POST /api/device-tokens
    │       └── Backend: createDeviceCredential()
    │       └── Returns: sip_username, sip_password, jwt_token
    │
    └── TelnyxVoip.connect({ sipUsername, sipPassword })
        └── Native: TelnyxService.connect()
        └── SDK: TxClient.connect(txConfig)
        └── WebSocket → Verto login → REGED
        └── Ready for calls
```

### 9.3 Design Considerations

| Consideration | Decision | Rationale |
|---|---|---|
| **Where to implement** | Separate Capacitor plugin or native screen | Keep VoIP plugin focused on VoIP |
| **Token storage** | Keychain (alongside SIP credentials) | Secure, survives app updates |
| **Name/email availability** | Only on first sign-in | Apple only provides name/email once; must persist |
| **Credential linking** | Apple user ID (sub) → Z360 user | Unique, stable identifier |
| **Multi-org** | Default org selected after sign-in | User can switch via app UI |

---

## 10. Component Dependency Map

### 10.1 iOS VoIP Component Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    AppDelegate + SceneDelegate                    │  │
│  │  Phase 1: PushKitManager.init + Z360VoIPService.setupMinimal    │  │
│  │  Phase 2: AudioConfig + Firebase + NetworkMonitor + Cleanup      │  │
│  └──────────┬──────────────────────┬────────────────────────────────┘  │
│             │                      │                                    │
│             ▼                      ▼                                    │
│  ┌──────────────────┐   ┌───────────────────────┐                     │
│  │  PushKitManager  │   │  Z360VoIPService      │ ◄── Central         │
│  │  (PushKit VoIP)  │   │  (Orchestrator)       │     Orchestrator    │
│  │                  │   │                       │                     │
│  │  Responsibilities:│   │  Delegates to:        │                     │
│  │  - PKPushRegistry│   │  ┌─────────────────┐  │                     │
│  │  - Token mgmt    │   │  │ CallKitManager  │  │                     │
│  │  - Push dispatch │   │  │ TelnyxService   │  │                     │
│  │  - PushCorrelator│   │  │ AudioManager    │  │                     │
│  │    coordination  │   │  │ VoipStore       │  │                     │
│  └───────┬──────────┘   │  │ ActionGuard     │  │                     │
│          │              │  │ ActiveCallGuard │  │                     │
│          │              │  │ OrgSwitcher     │  │                     │
│          │              │  │ NetworkMonitor  │  │                     │
│          │              │  │ CallQualityMon  │  │                     │
│          │              │  │ CallTimerMgr    │  │                     │
│          │              │  │ NotifHelper     │  │                     │
│          │              │  └─────────────────┘  │                     │
│          │              └───────────┬───────────┘                     │
│          │                          │                                  │
│          ▼                          ▼                                  │
│  ┌──────────────────┐   ┌───────────────────────┐                     │
│  │  PushCorrelator  │   │  TelnyxVoipPlugin     │ ◄── Capacitor      │
│  │  (Swift Actor)   │   │  (Bridge to WebView)  │     Bridge          │
│  │                  │   │                       │                     │
│  │  Responsibilities:│   │  Responsibilities:    │                     │
│  │  - Two-push sync │   │  - JS ↔ Native bridge │                     │
│  │  - 500ms timeout │   │  - Event emission      │                     │
│  │  - Phone normalize│   │  - Promise resolution  │                     │
│  │  - Merge data    │   │  - Plugin registration │                     │
│  └──────────────────┘   └───────────────────────┘                     │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                     Supporting Services                            │ │
│  │                                                                   │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │ │
│  │  │ CallKitMgr   │  │ TelnyxSvc    │  │ AudioManager         │   │ │
│  │  │              │  │              │  │                      │   │ │
│  │  │ CXProvider   │  │ TxClient     │  │ Mute/Hold/Speaker   │   │ │
│  │  │ CXCallCtrl   │  │ connect()    │  │ DTMF                │   │ │
│  │  │ reportIncoming│  │ answer()     │  │ Route monitoring    │   │ │
│  │  │ CXCallActions│  │ makeCall()   │  │ BUG-012 auto-mute  │   │ │
│  │  │ Audio session│  │ enableAudio()│  │                      │   │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘   │ │
│  │                                                                   │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │ │
│  │  │ VoipStore    │  │ OrgSwitcher  │  │ NetworkMonitor       │   │ │
│  │  │              │  │              │  │                      │   │ │
│  │  │ Keychain creds│  │ API switch   │  │ NWPathMonitor       │   │ │
│  │  │ UserDefaults │  │ Cred rotate  │  │ WiFi/Cell detect    │   │ │
│  │  │ Call state   │  │ SDK reconnect│  │ Debounce (500ms)    │   │ │
│  │  │ Tokens       │  │ Rollback     │  │ Reconnection trigger│   │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘   │ │
│  │                                                                   │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │ │
│  │  │ ActionGuard  │  │ ActiveCall   │  │ CallQuality          │   │ │
│  │  │ (Actor)      │  │ Guard(Actor) │  │ Monitor              │   │ │
│  │  │ Double-tap   │  │ Single-call  │  │ MOS/Jitter/RTT      │   │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘   │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                     Data Models                                    │ │
│  │                                                                   │ │
│  │  CallInfo           VoIPModels           KeychainManager          │ │
│  │  (UUID, direction,  (SIPCredentials,     (Keychain R/W            │ │
│  │   handle, state,    CallDirection,        for SIP creds)          │ │
│  │   orgId)            PersistableState,                             │ │
│  │                     error types)                                  │ │
│  │                                                                   │ │
│  │  Protocols:                                                       │ │
│  │  CallKitManagerDelegate    TelnyxServiceDelegate                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### 10.2 Delegation Chain

```
CallKit System
    │
    ▼
CallKitManager (CXProviderDelegate)
    │ delegate
    ▼
Z360VoIPService (CallKitManagerDelegate)
    │
    ├── delegates to TelnyxService for SDK operations
    ├── delegates to AudioManager for audio control
    ├── delegates to VoipStore for persistence
    ├── delegates to OrganizationSwitcher for cross-org
    ├── delegates to ActionGuard for double-tap prevention
    └── delegates to ActiveCallGuard for single-call enforcement

TelnyxService (TxClientDelegate)
    │ delegate
    ▼
Z360VoIPService (TelnyxServiceDelegate)
    │
    └── updates call state, notifies CallKit, notifies plugin

TelnyxVoipPlugin (Z360VoIPServicePluginDelegate)
    │
    └── emits events to WebView via notifyListeners
```

---

## 11. File Reference Index

All design decisions in this document reference these implementation files:

### iOS Native VoIP Files

| File | Component | Lines | Purpose |
|---|---|---|---|
| `ios/App/App/AppDelegate.swift` | App Lifecycle | ~336 | Two-phase startup, PushKit init |
| `ios/App/App/SceneDelegate.swift` | App Lifecycle | ~50 | Deferred initialization trigger |
| `ios/App/App/VoIP/TelnyxVoipPlugin.swift` | Capacitor Bridge | ~900 | JS ↔ Native bridge, 21 methods |
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` | Orchestrator | ~2253 | Central coordinator |
| `ios/App/App/VoIP/Services/TelnyxService.swift` | SDK Wrapper | ~667 | TxClient management |
| `ios/App/App/VoIP/Services/PushCorrelator.swift` | Push Sync | ~611 | Two-push correlation |
| `ios/App/App/VoIP/Services/VoipStore.swift` | Persistence | ~300 | Keychain + UserDefaults |
| `ios/App/App/VoIP/Managers/CallKitManager.swift` | CallKit | ~456 | CXProvider + delegate |
| `ios/App/App/VoIP/Managers/PushKitManager.swift` | PushKit | ~949 | VoIP push handling |
| `ios/App/App/VoIP/Managers/AudioManager.swift` | Audio | ~445 | Mute/Hold/Speaker/DTMF |
| `ios/App/App/VoIP/Utils/ActionGuard.swift` | Race Prevention | ~60 | Double-tap guard |
| `ios/App/App/VoIP/Utils/ActiveCallGuard.swift` | Race Prevention | ~80 | Single-call enforcement |
| `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | Multi-org | ~481 | Cross-org credential switch |
| `ios/App/App/VoIP/Utils/NetworkMonitor.swift` | Network | ~419 | NWPathMonitor + reconnection |
| `ios/App/App/VoIP/Utils/CallQualityMonitor.swift` | Quality | ~286 | MOS/Jitter/RTT tracking |
| `ios/App/App/VoIP/Utils/CallTimerManager.swift` | Timer | ~100 | Call duration tracking |
| `ios/App/App/VoIP/Utils/NotificationHelper.swift` | Notifications | ~100 | Missed call notifications |
| `ios/App/App/VoIP/Utils/KeychainManager.swift` | Security | ~111 | Keychain operations |
| `ios/App/App/VoIP/Utils/VoIPLogger.swift` | Logging | ~711 | Structured logging |
| `ios/App/App/VoIP/Models/CallInfo.swift` | Data Model | ~61 | Call metadata |
| `ios/App/App/VoIP/Models/VoIPModels.swift` | Data Models | ~169 | SIP creds, states, errors |
| `ios/App/App/VoIP/Protocols/CallKitManagerDelegate.swift` | Protocol | ~20 | CallKit event protocol |
| `ios/App/App/VoIP/Protocols/TelnyxServiceDelegate.swift` | Protocol | ~20 | Telnyx event protocol |

### Frontend Files

| File | Purpose |
|---|---|
| `resources/js/plugins/telnyx-voip.ts` | Plugin interface + registration |
| `resources/js/plugins/telnyx-voip-web.ts` | Web fallback (no-op stubs) |
| `resources/js/plugins/use-telnyx-voip.ts` | React hook for VoIP |
| `resources/js/providers/native-voip-provider.tsx` | Native VoIP React provider |
| `resources/js/utils/platform.ts` | Platform detection |

### Telnyx Reference Files

| File | Purpose |
|---|---|
| `telnyx-ios-demo.xml` — `AppDelegate.swift` | Demo initialization + CallKit |
| `telnyx-ios-demo.xml` — `TelnyxService.swift` | Demo TxClient usage |
| `telnyx-ios-demo.xml` — `VoIPServiceManager.swift` | Demo push routing |
| `telnyx-ios-sdk.xml` — `TxClient.swift` | SDK client API |
| `telnyx-ios-sdk.xml` — `Call.swift` | SDK call model |
| `telnyx-ios-sdk.xml` — `Peer.swift` | SDK audio session config |

### Backend Files (Push + Credentials)

| File | Purpose |
|---|---|
| `app/Services/PushNotificationService.php` | FCM/APNs push dispatch |
| `app/Services/ApnsVoipService.php` | APNs VoIP push |
| `app/Services/CPaaSService.php` | Credential management |
| `app/Http/Controllers/Api/DeviceTokenController.php` | Device registration |
| `app/Http/Controllers/Api/VoipCredentialController.php` | VoIP credentials API |

---

*Generated: 2026-02-08*
*Author: Teammate B (Target Architecture Designer)*
*Prerequisite documents: 00-system-context/ (3 docs), 01-technology-landscape/ (5 docs)*
*Reference implementations: Telnyx iOS Demo, Telnyx iOS SDK, Z360 iOS skill*
