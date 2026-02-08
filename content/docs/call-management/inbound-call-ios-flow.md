---
title: Inbound Call iOS Flow
---

# iOS Inbound Call Flow: Complete Trace

![iOS Inbound Call Flow](/diagrams/ios-call-flow.jpeg)

> **Platform**: iOS (Swift)
> **Sources**: voip-ios skill (`.claude/skills/voip-ios/`), ios-current-state.md, mobile-platform-architecture.md
> **Date**: 2026-02-08

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Constraints](#2-critical-constraints)
3. [Architecture Overview](#3-architecture-overview)
4. [Normal Flow: Push to Completion](#4-normal-flow-push-to-completion)
5. [Two-Push Synchronization Deep Dive](#5-two-push-synchronization-deep-dive)
6. [CallKit Lifecycle](#6-callkit-lifecycle)
7. [Answer Flow](#7-answer-flow)
8. [Call In Progress](#8-call-in-progress)
9. [Call End Scenarios](#9-call-end-scenarios)
10. [Cold Start (App Terminated)](#10-cold-start-app-terminated)
11. [Cross-Organization Calls](#11-cross-organization-calls)
12. [Edge Cases & Failure Modes](#12-edge-cases--failure-modes)
13. [File Reference Map](#13-file-reference-map)

---

## 1. Executive Summary

The iOS inbound call flow is orchestrated across **4 primary components**:

1. **PushKitManager** — Receives VoIP pushes, coordinates dual-push timing, reports to CallKit within 5 seconds
2. **PushCorrelator** — Swift Actor that synchronizes Z360 backend push with Telnyx SDK push
3. **CallKitManager** — Manages iOS system call UI via CXProvider
4. **Z360VoIPService** — Central orchestrator implementing all delegate protocols

**Key characteristics**:
- **5-second deadline**: PushKit → CallKit report must complete within 5 seconds or iOS terminates the app
- **Two-push system**: Z360 push (caller info) + Telnyx push (call control) arrive independently
- **Two-phase startup**: Minimal initialization in `didFinishLaunchingWithOptions`, deferred to `sceneDidBecomeActive`
- **CallKit-driven flow**: All user actions (answer, end, mute, hold) go through CallKit delegate callbacks
- **Cross-org support**: Automatic credential switching with 4.5s deadline and rollback on failure

---

## 2. Critical Constraints

### 2.1 Apple-Mandated Constraints

| Constraint | Value | Consequence of Violation |
|-----------|-------|--------------------------|
| **PushKit → CallKit report** | **5 seconds** | **App terminated by iOS** |
| CallKit action fulfill/fail | "quickly" (no specific timeout) | CallKit UI hangs, poor UX |
| Audio session activation | Only in `didActivate` callback | Audio won't work |
| PushKit registration | Must be in `didFinishLaunchingWithOptions` | Push delivery fails |

**Source**: Apple documentation, observed behavior
**Proof**: `ios/App/App/VoIP/Managers/PushKitManager.swift:934-935` (comments), `ios/App/App/VoIP/Managers/CallKitManager.swift:559-594` (reportIncomingCall implementation)

### 2.2 Z360-Specific Timeouts

| Operation | Timeout | Location |
|-----------|---------|----------|
| Push correlation (Z360 + Telnyx) | 500ms–1.5s | PushCorrelator.swift:2721 |
| Cross-org switch | 4.5s max (5s CallKit - 0.5s safety) | OrganizationSwitcher.swift:8090 |
| SDK reconnection before answer | 5s | Z360VoIPService.swift:4505-4514 |
| Push call ready wait | 5s | Z360VoIPService.swift:4525 |
| Audio activation retry | 5s | Z360VoIPService.swift:6098 |
| Ring timeout (unanswered) | 30s | Z360VoIPService.swift (IC-007 pattern) |
| Network reconnection | 30s | NetworkMonitor.swift:419 |

---

## 3. Architecture Overview

### 3.1 Component Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                      AppDelegate                              │
│  Phase 1 (didFinishLaunchingWithOptions):                    │
│    - PushKitManager.shared.initialize()                      │
│    - Z360VoIPService.shared.setupMinimal(callKitManager:)    │
│  Phase 2 (performDeferredInitialization from Scene):         │
│    - configureAudioSessionForVoIP()                          │
│    - startNetworkMonitoring()                                │
│    - configureFirebase()                                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    PushKitManager                             │
│  PKPushRegistryDelegate (DispatchQueue.main)                 │
│  ├─ pushRegistry(_:didReceiveIncomingPushWith:)             │
│  │    ├─ processPushPayload(_:completion:)                  │
│  │    │    ├─ Feed PushCorrelator (async)                   │
│  │    │    ├─ Deduplication checks                          │
│  │    │    └─ reportIncomingCall() → CallKitManager         │
│  │    └─ MUST call completion() before 5s                   │
│  └─ Dependencies:                                            │
│       - pushCorrelator: PushCorrelator.shared               │
│       - callKitManager: CallKitManager (weak)               │
│       - voipStore: VoipStore.shared                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    PushCorrelator (Actor)                     │
│  Thread-safe two-push synchronization                        │
│  ├─ processZ360Push(callId, callerName, ...)                │
│  ├─ processTelnyxPush(callId, callerNumber, ...)            │
│  └─ awaitMergedData(callerNumber, telnyxCallId)             │
│       ├─ normalizePhoneNumber() → last 10 digits            │
│       ├─ withCheckedContinuation (500ms-1.5s timeout)       │
│       └─ Returns PushSyncResult                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    CallKitManager                             │
│  Single CXProvider instance (iOS requirement)                │
│  ├─ reportIncomingCall(uuid, handle, callerName, ...)       │
│  │    └─ CXProvider.reportNewIncomingCall()                 │
│  │         └─ iOS shows native call UI                      │
│  └─ CXProviderDelegate callbacks:                           │
│       ├─ provider(_:perform:CXAnswerCallAction)             │
│       ├─ provider(_:perform:CXEndCallAction)                │
│       ├─ provider(_:didActivate:AVAudioSession) ★           │
│       └─ provider(_:didDeactivate:AVAudioSession)           │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Z360VoIPService                            │
│  Central orchestrator (2,253 lines)                          │
│  Implements:                                                 │
│    - TelnyxServiceDelegate                                   │
│    - CallKitManagerDelegate                                  │
│    - NetworkMonitorDelegate                                  │
│    - CallQualityMonitorDelegate                              │
│    - CallTimerManagerDelegate                                │
│  ├─ answerCall(uuid, action) ★★                             │
│  │    ├─ ActionGuard double-tap prevention                  │
│  │    ├─ SDK readiness check                                │
│  │    ├─ Cross-org switch (if needed)                       │
│  │    └─ TelnyxService.answerFromCallKit(answerAction)      │
│  ├─ callStateDidChange(callId, state)                       │
│  │    └─ Maps SDK states → CallKit, starts timers           │
│  └─ remoteCallEnded(callId, reason)                         │
│       └─ Handles remote hangup, missed calls                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    TelnyxService                              │
│  Wrapper around TxClient (Telnyx iOS SDK)                   │
│  ├─ answerFromCallKit(answerAction: CXAnswerCallAction)     │
│  │    └─ txClient.answerFromCallkit(answerAction:debug:)    │
│  │         └─ SDK answers SIP INVITE                        │
│  ├─ enableAudioSession(audioSession: AVAudioSession)        │
│  │    └─ txClient.enableAudioSession(audioSession:)         │
│  └─ TxClientDelegate callbacks:                             │
│       ├─ onIncomingCall(call:)                              │
│       ├─ onCallStateUpdated(callState, callId)              │
│       └─ onRemoteCallEnded(callId, reason)                  │
└─────────────────────────────────────────────────────────────┘
```

**Proof**:
- AppDelegate: `ios/App/App/AppDelegate.swift:10292-10313`, `10318-10353`
- PushKitManager: `ios/App/App/VoIP/Managers/PushKitManager.swift:1035-1188`
- PushCorrelator: `ios/App/App/VoIP/Services/PushCorrelator.swift:2674-2770`
- CallKitManager: `ios/App/App/VoIP/Managers/CallKitManager.swift:559-594`, `813-900`
- Z360VoIPService: `ios/App/App/VoIP/Services/Z360VoIPService.swift:4484-4604`, `5662-5819`, `5821-5886`
- TelnyxService: `ios/App/App/VoIP/Services/TelnyxService.swift:3196-3220`, `3247-3254`, `3559-3600`

---

## 4. Normal Flow: Push to Completion

### 4.1 Sequence Diagram

```
iOS Device      PushKitManager   PushCorrelator   CallKitManager   Z360VoIPService   TelnyxService   User
    │                 │                 │                 │                 │                 │          │
    │  VoIP Push ────>│                 │                 │                 │                 │          │
    │  (APNs)         │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │   [CRITICAL: Must complete within 5 seconds]        │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ processPushPayload()             │                 │                 │          │
    │                 │  Extract Z360 + Telnyx data       │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ async ────────>│ processZ360Push()                 │                 │          │
    │                 │                 │ (caller info)   │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ async ────────>│ processTelnyxPush()               │                 │          │
    │                 │                 │ (call control)  │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ Check dedup    │                 │                 │                 │          │
    │                 │  (callUUIDByPhone, callUUIDByTelnyxId)              │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ detectCrossOrg()│                │                 │                 │          │
    │                 │  (sync UserDefaults check)        │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ reportIncomingCall() ──────────>│                 │                 │          │
    │                 │  (uuid, handle, callerName)       │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │─ reportNewIncomingCall()          │          │
    │                 │                 │                 │   CXProvider    │                 │          │
    │                 │                 │                 │                 │                 │          │
    │<──────────────────────────────────────────────────────────────────────────── iOS Call UI│          │
    │                 Native system call banner appears   │                 │                 │          │
    │                 Lock screen: full-screen call UI    │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ completion()   │                 │                 │                 │          │
    │                 │  (MUST happen < 5s from push)     │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ Store display info in VoipStore  │                 │                 │          │
    │                 │─ Register with Z360VoIPService    │                 │                 │          │
    │                 │─ Start 30s ring timeout timer     │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │─ async processTelnyxPayloadAsync()│                 │─────────────────>│          │
    │                 │  (SDK processes push)             │                 │ processVoIPNotification()  │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │                 │<────────>│
    │                 │                 │                 │                 │                 │ User taps │
    │                 │                 │                 │                 │                 │  ANSWER   │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │<─ CXAnswerCallAction ─────────────────────────┤
    │                 │                 │                 │   (iOS CallKit)│                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │─ delegate.didReceiveAnswerAction()│          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │<────────────────┤          │
    │                 │                 │                 │                 │ answerCall()    │          │
    │                 │                 │                 │                 │  [See §7]       │          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │─ answerFromCallKit() ─────>│
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │                 │─ SDK     │
    │                 │                 │                 │                 │                 │  answers │
    │                 │                 │                 │                 │                 │  SIP     │
    │                 │                 │                 │                 │                 │  INVITE  │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │<─ didActivate audioSession ───────────────────┤
    │                 │                 │                 │   (CallKit)     │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │─ delegate.callKitManagerDidActivateAudioSession()
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │─ enableAudioSession() ────>│
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │                 │─ txClient│
    │                 │                 │                 │                 │                 │  .enable │
    │                 │                 │                 │                 │                 │  Audio   │
    │                 │                 │                 │                 │                 │          │
    │<──────────────────────────────────────────────────────────────────────────────────────────────────┤
    │                 Two-way audio established           │                 │                 │          │
    │                 Call in ACTIVE state                │                 │                 │          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │<────── onCallStateUpdated() │
    │                 │                 │                 │                 │        (.active)│          │
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │─ Start timer    │          │
    │                 │                 │                 │                 │─ Start quality monitoring   │
    │                 │                 │                 │                 │─ Network: callDidStart()    │
    │                 │                 │                 │                 │─ Persist state (crash recovery)
    │                 │                 │                 │                 │                 │          │
    │                 │                 │                 │                 │                 │<────────>│
    │                 │                 │                 │                 │                 │   Call   │
    │                 │                 │                 │                 │                 │   in     │
    │                 │                 │                 │                 │                 │ progress │
    │                 │                 │                 │                 │                 │          │
```

**Proof**:
- Push reception: `PushKitManager.swift:1821-1817` (`pushRegistry(_:didReceiveIncomingPushWith:)`)
- Process payload: `PushKitManager.swift:1035-1188` (`processPushPayload`)
- Feed correlator: `PushKitManager.swift:1074-1095`
- Report to CallKit: `PushKitManager.swift:1192-1281` (`reportIncomingCall`)
- Answer flow: `Z360VoIPService.swift:4484-4604` (`answerCall`)
- Audio activation: `Z360VoIPService.swift:6080-6114` (`callKitManagerDidActivateAudioSession`)
- Call state ACTIVE: `Z360VoIPService.swift:5692-5750` (`callStateDidChange(.active)`)

---

## 5. Two-Push Synchronization Deep Dive

### 5.1 The Problem

Each inbound call generates **two independent push notifications**:

1. **Z360 Backend Push** (via APNs):
   - Contains: `caller_name`, `caller_number`, `avatar_url`, `organization_id`, `organization_name`, `call_id` (UUID)
   - Purpose: Rich caller display info
   - Sent by: Z360 Laravel backend via ApnsVoipService

2. **Telnyx SDK Push** (via APNs):
   - Contains: `metadata` JSON string with `call_control_id`, `caller_number`, `caller_name`
   - Purpose: Call control metadata for SDK to answer the SIP INVITE
   - Sent by: Telnyx platform

**Either push can arrive first.** The system must handle all orderings:
- Z360 arrives first → wait for Telnyx
- Telnyx arrives first → wait for Z360
- Only one push arrives → proceed with partial data

**Proof**: `PushCorrelator.swift:2386-2479` (actor definition + comments)

### 5.2 PushCorrelator Design

**Actor**: `PushCorrelator` (Swift Actor for thread-safe access)

**Storage**:
```swift
private var pendingByPhone: [String: SyncEntry] = [:]       // Primary index: normalized phone
private var pendingByZ360UUID: [UUID: String] = [:]          // UUID → phone mapping
private var pendingByTelnyxId: [String: String] = [:]        // Telnyx ID → phone mapping
```

**Phone normalization**: Last 10 digits
```swift
let digits = phone.filter { $0.isNumber }
return String(digits.suffix(10))
```

**Proof**: `PushCorrelator.swift:2483-2496` (storage), `PushCorrelator.swift:2918-2925` (normalization)

### 5.3 Sync Flow: Z360 Push Arrives First

```
┌─────────────────────────────────────────────────────────┐
│ PushKitManager receives Z360 push                       │
│  caller_number: "+18005551234"                          │
│  caller_name: "John Doe"                                │
│  organization_id: "42"                                  │
│  call_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479"       │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ Task { await pushCorrelator.processZ360Push(...) }     │
│  normalizedPhone = "8005551234" (last 10 digits)       │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushCorrelator.processZ360Push()                        │
│  ├─ Check pendingByPhone["8005551234"]                 │
│  │   └─ No Telnyx entry yet                            │
│  ├─ Create new SyncEntry:                              │
│  │    z360Data = Z360PushData(...)                     │
│  │    telnyxData = nil                                 │
│  │    continuation = nil                               │
│  ├─ Store in pendingByPhone["8005551234"]              │
│  └─ Index by Z360 UUID in pendingByZ360UUID            │
└─────────────────────────────────────────────────────────┘
                    │
                    │ [Later: Telnyx push arrives]
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushKitManager receives Telnyx push                     │
│  metadata: { call_control_id: "abc-123",                │
│              caller_number: "+18005551234" }            │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ Task { await pushCorrelator.processTelnyxPush(...) }   │
│  normalizedPhone = "8005551234"                        │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushCorrelator.processTelnyxPush()                      │
│  ├─ Lookup pendingByPhone["8005551234"]                │
│  │   └─ Entry exists with z360Data + continuation!     │
│  ├─ Store telnyxData in entry                          │
│  ├─ If continuation exists:                            │
│  │    ├─ mergeData(z360, telnyx)                       │
│  │    ├─ continuation.resume(returning: merged)        │
│  │    └─ Clear continuation                            │
│  └─ Index by Telnyx ID in pendingByTelnyxId            │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
          [Continuation resumed, awaitMergedData() returns]
```

**Proof**: `PushCorrelator.swift:2541-2610` (processZ360Push), `PushCorrelator.swift:2626-2660` (processTelnyxPush)

### 5.4 Sync Flow: Telnyx Push Arrives First

```
┌─────────────────────────────────────────────────────────┐
│ PushKitManager receives Telnyx push (FIRST)             │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushCorrelator.processTelnyxPush()                      │
│  ├─ No existing entry in pendingByPhone                │
│  ├─ Create new SyncEntry:                              │
│  │    z360Data = nil                                   │
│  │    telnyxData = TelnyxPushData(...)                 │
│  │    continuation = nil (no one waiting yet)          │
│  └─ Store in pendingByPhone["8005551234"]              │
└─────────────────────────────────────────────────────────┘
                    │
                    │ [PushKitManager continues processing]
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushKitManager.reportIncomingCall() called             │
│  ├─ Has Telnyx info, so reports immediately            │
│  │   (can't wait for Z360 - 5s deadline)               │
│  └─ CallKit UI appears with partial info               │
└─────────────────────────────────────────────────────────┘
                    │
                    │ [Later: Z360 push arrives]
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushCorrelator.processZ360Push()                        │
│  ├─ Lookup pendingByPhone["8005551234"]                │
│  │   └─ Entry exists with telnyxData!                  │
│  ├─ Store z360Data in entry                            │
│  ├─ If continuation exists:                            │
│  │    ├─ mergeData(z360, telnyx)                       │
│  │    └─ continuation.resume(returning: merged)        │
│  │         [In this case, no continuation because      │
│  │          CallKit was already reported]              │
│  └─ Entry updated with rich Z360 data                  │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ PushKitManager detects existing CallKit report         │
│  (deduplication check via findExistingCallUUID)        │
│  └─ CallKitManager.updateCallInfo() with Z360 data     │
│       └─ CallKit UI updates with rich caller info      │
└─────────────────────────────────────────────────────────┘
```

**Proof**: `PushKitManager.swift:1144-1160` (Telnyx present path), `PushKitManager.swift:1097-1121` (dedup + update path)

### 5.5 Timeout Handling

If Z360 push never arrives:

```swift
// In awaitMergedData():
let merged: MergedPushData? = await withCheckedContinuation { continuation in
    // Store continuation
    entry.continuation = continuation

    // Schedule timeout (500ms-1.5s)
    Task {
        try? await Task.sleep(nanoseconds: UInt64(syncTimeoutMs) * 1_000_000)
        await self.handleTimeout(normalizedPhone: normalizedPhone, continuation: continuation)
    }
}

if merged == nil {
    // Timeout - proceed with Telnyx data only
    return PushSyncResult(displayInfo: nil, syncType: .timeout, ...)
}
```

**Proof**: `PushCorrelator.swift:2720-2769` (awaitMergedData timeout), `PushCorrelator.swift:2776-2793` (handleTimeout)

---

## 6. CallKit Lifecycle

### 6.1 reportIncomingCall()

**CallKitManager.reportIncomingCall()** is the **critical handoff** to iOS system call UI:

```swift
func reportIncomingCall(
    uuid: UUID,
    handle: String,
    callerName: String?,
    hasVideo: Bool,
    completion: ((Error?) -> Void)?
) {
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .phoneNumber, value: handle)
    update.localizedCallerName = callerName
    update.hasVideo = hasVideo
    update.supportsHolding = true
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = true

    provider.reportNewIncomingCall(with: uuid, update: update) { error in
        if let error = error {
            print("[CallKitManager] Failed to report incoming call: \(error)")
            completion?(error)
        } else {
            // SUCCESS: iOS shows native call UI
            // Store in activeCalls tracking
            let callInfo = CallInfo(
                uuid: uuid,
                direction: .incoming,
                handle: handle,
                callerName: callerName,
                startDate: Date()
            )
            callsQueue.async {
                activeCalls[uuid] = callInfo
            }
            completion?(nil)
        }
    }
}
```

**What iOS does after successful report**:
1. **Unlocked device**: Shows incoming call banner at top of screen
2. **Locked device**: Shows full-screen incoming call UI with answer/decline buttons
3. **Ringtone**: Plays system ringtone (or vibrates if silent mode)
4. **CarPlay/Bluetooth**: Displays call info on connected devices
5. **Recents**: Adds to recent calls list (if `includesCallsInRecents = true` in config)

**Error handling**:
- `CXErrorCodeIncomingCallError.callUUIDAlreadyExists` — UUID collision (should never happen)
- `CXErrorCodeIncomingCallError.filteredByDoNotDisturb` — User has Do Not Disturb enabled
- `CXErrorCodeIncomingCallError.filteredByBlockList` — Caller is on blocked list

**Proof**: `CallKitManager.swift:559-594` (reportIncomingCall implementation), `CallKitManager.swift:524-534` (CXProviderConfiguration)

### 6.2 CallKit UI States

```
┌─────────────────────────────────────────────────────────┐
│                    RINGING STATE                         │
│  (After reportNewIncomingCall succeeds)                 │
│                                                         │
│  iOS UI:                                                │
│  - Banner (unlocked) or full-screen (locked)           │
│  - Answer / Decline buttons                            │
│  - Caller name + number displayed                      │
│  - Ringtone playing                                    │
│                                                         │
│  Duration: Until user action or remote hangup          │
└─────────────────────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌────────────────┐    ┌────────────────┐
│ User taps      │    │ User taps      │
│   ANSWER       │    │   DECLINE      │
└────────────────┘    └────────────────┘
        │                       │
        ▼                       ▼
┌─────────────────────────────────────────────────────────┐
│              CONNECTING STATE                            │
│  (CXAnswerCallAction dispatched)                        │
│                                                         │
│  iOS UI:                                                │
│  - "Connecting..." indicator                           │
│  - No audio yet                                        │
│                                                         │
│  Duration: Until didActivate audioSession callback     │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│                  ACTIVE STATE                            │
│  (After audio session activated + SDK call active)     │
│                                                         │
│  iOS UI:                                                │
│  - Timer counting up                                   │
│  - Mute / Speaker / Hold buttons                       │
│  - Keypad for DTMF                                     │
│  - End call button                                     │
│  - Green status bar (in-call indicator)                │
│                                                         │
│  Duration: Until user hangs up or remote ends          │
└─────────────────────────────────────────────────────────┘
```

**Proof**: Apple CallKit documentation, observed behavior

---

## 7. Answer Flow

### 7.1 User Taps "Answer" in CallKit UI

When the user taps the answer button in the iOS call UI, the following sequence executes:

```
User taps Answer
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ iOS CallKit dispatches CXAnswerCallAction               │
│  action.callUUID = <the call UUID>                      │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ CXProviderDelegate callback fired                       │
│  provider(_:perform:CXAnswerCallAction)                 │
│  ├─ On main thread                                      │
│  └─ MUST call action.fulfill() or action.fail()         │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ CallKitManager.provider(_:perform:action)               │
│  └─ delegate?.didReceiveAnswerAction(action, for: uuid) │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ Z360VoIPService.didReceiveAnswerAction(action, uuid)    │
│  └─ answerCall(uuid: uuid, action: action)              │
└─────────────────────────────────────────────────────────┘
```

**Proof**: `CallKitManager.swift:813-816` (provider callback), `Z360VoIPService.swift:5918-5926` (delegate callback)

### 7.2 Z360VoIPService.answerCall() Detailed Steps

**File**: `ios/App/App/VoIP/Services/Z360VoIPService.swift:4484-4604`

```swift
func answerCall(uuid: UUID, action: CXAnswerCallAction) {
    Task {
        // STEP 1: Double-tap prevention (BUG-005 pattern)
        guard await actionGuard.attemptAction(.answer) else {
            print("[Z360VoIPService] Answer BLOCKED - double-tap prevention")
            action.fail()
            return
        }

        do {
            // STEP 2: SDK readiness check
            if !telnyxService.isClientReady() {
                print("[Z360VoIPService] ⚠️ SDK not ready - attempting reconnection")
                let reconnected = await attemptReconnection()
                if !reconnected {
                    action.fail()
                    await actionGuard.reset(.answer)
                    return
                }
            }

            // STEP 3: Wait for push call to be available in SDK
            // For cold start (app killed, woken by VoIP push), SDK needs time
            // to process the push payload. Wait up to 5s.
            let callAvailable = await waitForPushCallReady(uuid: uuid, timeout: 5.0)
            if !callAvailable {
                print("[Z360VoIPService] ⚠️ Push call not ready after 5s timeout")
                print("[Z360VoIPService] Attempting to answer anyway")
                // Proceed anyway - SDK may have call via different path
            }

            // STEP 4: Cross-org detection and switch
            let isCrossOrg = await voipStore.isCrossOrgCall(uuid: uuid)
            if isCrossOrg {
                if let meta = await voipStore.getIncomingCallMeta(uuid: uuid),
                   let targetOrgId = meta.organizationId {
                    print("[Z360VoIPService] 🔀 Cross-org call - switching org")
                    try await performCrossOrgSwitch(
                        uuid: uuid,
                        targetOrgId: targetOrgId,
                        targetOrgName: meta.organizationName
                    )
                    // performCrossOrgSwitch:
                    // 1. Notify plugin (loading indicator)
                    // 2. OrganizationSwitcher.switchOrganization()
                    //    - Capture original context (for rollback)
                    //    - POST /api/voip/switch-org with WebView cookies
                    //    - Store new credentials in Keychain
                    //    - Update VoipStore org context
                    //    - Disconnect TelnyxService
                    //    - Reconnect with new credentials
                    //    - Wait for isClientReady() (3s timeout, 50ms poll)
                    // 3. On failure: restore original context
                    // 4. Must complete within 4.5s (5s deadline - 0.5s safety)
                }
            }

            // STEP 5: Set active call state
            stateQueue.sync {
                activeCallUUID = uuid
                activeCallDirection = .incoming
                callEndProcessedForUUID = nil
            }

            // STEP 6: Mark as answered (removes from missed call tracking)
            markCallAsAnswered(uuid: uuid)

            // STEP 7: Answer via Telnyx SDK
            telnyxService.answerFromCallKit(answerAction: action)
            // This calls: txClient.answerFromCallkit(answerAction:debug:true)
            // SDK will call action.fulfill() internally after answering SIP INVITE

            // STEP 8: Persist call state for crash recovery (US-026)
            let callInfo = callKitManager?.getCallInfo(uuid: uuid)
            let state = PersistableCallState(
                callId: uuid,
                direction: .incoming,
                callerNumber: callInfo?.handle ?? "Unknown",
                callerName: callInfo?.callerName,
                startTime: Date()
            )
            await voipStore.saveActiveCallState(state)

            print("[Z360VoIPService] Answer call completed successfully")

            // Note: ActionGuard.answer reset happens in callStateDidChange
            // when state becomes ACTIVE

        } catch {
            print("[Z360VoIPService] Answer failed: \(error)")
            action.fail()
            await actionGuard.reset(.answer)
            stateQueue.sync {
                if activeCallUUID == uuid { activeCallUUID = nil }
            }
        }
    }
}
```

**Proof**: `Z360VoIPService.swift:4484-4604` (complete function)

### 7.3 TelnyxService.answerFromCallKit()

**File**: `ios/App/App/VoIP/Services/TelnyxService.swift:3196-3220`

```swift
func answerFromCallKit(answerAction: CXAnswerCallAction) {
    print("[TelnyxService] answerFromCallKit called")

    guard let client = txClient else {
        print("[TelnyxService] ❌ CRITICAL: txClient is nil!")
        // CRITICAL FIX: Still fulfill to prevent CallKit hang
        answerAction.fulfill()
        return
    }

    if !clientReady {
        print("[TelnyxService] ⚠️ Client not ready - attempting answer anyway")
    }

    if currentCall == nil {
        print("[TelnyxService] ⚠️ No current call - attempting answer anyway")
    }

    // Enable debug mode for quality metrics
    // SDK's answerFromCallkit calls action.fulfill() internally
    print("[TelnyxService] Calling SDK answerFromCallkit...")
    client.answerFromCallkit(answerAction: answerAction, debug: true)
    print("[TelnyxService] SDK answerFromCallkit returned")
}
```

**What the SDK does**:
1. Accepts the SIP INVITE (200 OK response)
2. Sets up WebRTC media streams (audio only, no video)
3. Calls `answerAction.fulfill()` to tell CallKit the action completed
4. Triggers `onCallStateUpdated(callState: .active, callId: ...)` delegate callback

**CRITICAL**: The SDK must call `action.fulfill()`. If it doesn't (SDK bug), CallKit hangs. The safety check at lines 3199-3204 ensures fulfill is called even if SDK is nil.

**Proof**: `TelnyxService.swift:3196-3220` (answerFromCallKit)

### 7.4 Audio Session Activation

After the SDK answers, iOS CallKit activates the audio session:

```
SDK answers SIP INVITE
       │
       ▼
CallKit detects call is connecting
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ CallKit activates AVAudioSession                        │
│  ├─ Sets category to .playAndRecord                     │
│  ├─ Sets mode to .voiceChat                             │
│  └─ Activates audio device                              │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ CXProviderDelegate callback                             │
│  provider(_:didActivate audioSession:AVAudioSession)    │
│  ├─ CRITICAL: Enable audio ONLY in this callback        │
│  └─ delegate?.didActivateAudioSession(audioSession)     │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ Z360VoIPService.didActivateAudioSession(audioSession)   │
│  ├─ Store as pendingAudioSession                        │
│  ├─ If SDK is ready:                                    │
│  │    ├─ telnyxService.enableAudioSession(audioSession) │
│  │    └─ Clear pendingAudioSession                      │
│  └─ If SDK not ready:                                   │
│       ├─ Start 5s retry with waitForClientReady()       │
│       └─ Enable when SDK becomes ready                  │
└─────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│ TelnyxService.enableAudioSession(audioSession)          │
│  └─ txClient.enableAudioSession(audioSession:)          │
│       └─ SDK connects audio streams to device           │
└─────────────────────────────────────────────────────────┘
       │
       ▼
   Two-way audio established ✅
```

**Race condition fix**: The audio activation callback can fire BEFORE `telnyxServiceClientReady` fires. The `pendingAudioSession` pattern handles both orderings:
- If SDK ready when callback fires → enable immediately
- If SDK not ready → store session, enable when `telnyxServiceClientReady` fires
- Retry mechanism (5s) as additional safety net

**Proof**:
- CallKit callback: `CallKitManager.swift:893-895`
- Z360 handling: `Z360VoIPService.swift:6080-6114`
- TelnyxService: `TelnyxService.swift:3247-3254`
- ClientReady handling: `Z360VoIPService.swift:5556-5587` (telnyxServiceClientReady)

---

## 8. Call In Progress

Once the call is in the ACTIVE state, several subsystems activate:

### 8.1 Call State: ACTIVE

**Triggered by**: `TelnyxService` receives `onCallStateUpdated(callState: .active, callId: ...)`

**Z360VoIPService.callStateDidChange(.active)**:
```swift
case .active:
    // 1. Reset action guards (call is established, allow new actions)
    Task {
        await actionGuard.reset(.answer)
        await actionGuard.reset(.makeCall)
    }

    // 2. Persist call state for crash recovery (US-026)
    let state = PersistableCallState(
        callId: callKitUUID,
        direction: direction,
        callerNumber: callInfo?.handle ?? "Unknown",
        callerName: callInfo?.callerName,
        startTime: Date()
    )
    await voipStore.saveActiveCallState(state)

    // 3. Set call context for crash reports (Crashlytics)
    VoIPLogger.setCallContext(
        callId: callKitUUID.uuidString,
        direction: direction.rawValue,
        callerNumber: callInfo?.handle
    )

    // 4. Log event to Firebase Analytics
    VoIPLogger.logEvent(.callAnswered, parameters: [
        "direction": direction.rawValue,
        "call_id": callKitUUID.uuidString
    ])

    // 5. Start call duration timer (US-015)
    callTimerManager.startTimer(for: callKitUUID)
    // Emits tick every 1 second:
    // delegate?.callTimerManager(_:didUpdateDuration:elapsedSeconds:formattedDuration:)

    // 6. Start call quality monitoring (US-018)
    callQualityMonitor.startMonitoring(for: callKitUUID)
    telnyxService.startQualityMonitoring(for: callKitUUID)
    // Quality callback fires every 5 seconds with MOS/jitter/RTT metrics

    // 7. Notify network monitor (US-024)
    networkMonitor.callDidStart()
    // Enables 30-second timeout behavior on network loss

    // 8. For outgoing calls: report connected to CallKit
    if callInfo.direction == .outgoing {
        callKitManager?.reportOutgoingCallConnected(uuid: callKitUUID)
    }

    // 9. Emit callAnswered event to plugin (JavaScript)
    pluginDelegate?.voipService(callAnswered: callKitUUID)
```

**Proof**: `Z360VoIPService.swift:5692-5750` (callStateDidChange .active case)

### 8.2 Audio Routing

**AudioManager** handles audio route changes:

```swift
// Listen for route changes
NotificationCenter.default.addObserver(
    forName: AVAudioSession.routeChangeNotification,
    object: nil,
    queue: nil
) { [weak self] notification in
    // Detect route: .earpiece, .speaker, .bluetooth, .headphones, .unknown
    let currentRoute = classifyAudioRoute(AVAudioSession.sharedInstance().currentRoute)

    // Emit event to plugin
    delegate?.audioManager(_:didChangeAudioRoute:previousRoute:)
}
```

**User controls**:
- **Speaker**: `AudioManager.setSpeaker(true)` → `.overrideOutputAudioPort(.speaker)`
- **Earpiece**: `AudioManager.setSpeaker(false)` → `.overrideOutputAudioPort(.none)`
- **Mute**: `AudioManager.setMute(true)` → `telnyxService.getCurrentCall()?.muteUnmuteAudio()`
- **Hold**: `AudioManager.setHold(true)` → `telnyxService.getCurrentCall()?.hold()` + auto-mute (BUG-012 fix)
- **DTMF**: `AudioManager.sendDTMF(digit)` → `telnyxService.getCurrentCall()?.dtmf(digit:)`

**Proof**: `AudioManager.swift:3-448` (complete implementation)

### 8.3 CallKit In-Call UI

During an active call, iOS CallKit provides:
- **Green status bar** at top of screen (in-call indicator)
- **Timer** counting up from 00:00
- **Controls**: Mute, Speaker, Hold, Keypad, End
- **Picture-in-Picture** when user switches apps (minimized call UI)

All control actions flow through `CXProvider` delegate callbacks:
```
User taps Mute → CXSetMutedCallAction
                → provider(_:perform:CXSetMutedCallAction)
                → delegate.didReceiveMuteAction(...)
                → AudioManager.setMute()
```

**Proof**: `CallKitManager.swift:856-870` (mute action), similar for hold/DTMF

### 8.4 Quality Monitoring

**CallQualityMonitor** processes WebRTC stats every 5 seconds:

```swift
call.onCallQualityChange = { [weak self] _, metrics in
    // Extract MOS, jitter, RTT, packet loss from metrics dictionary
    let mos = metrics["mos"] as? Double ?? 0.0
    let jitter = metrics["jitter"] as? Double ?? 0.0
    let rtt = metrics["rtt"] as? Double ?? 0.0
    let packetLoss = metrics["packet_loss"] as? Double ?? 0.0

    // Classify quality
    let quality: CallQualityLevel
    if mos >= 4.0 {
        quality = .good
    } else if mos >= 3.5 {
        quality = .fair
    } else {
        quality = .poor
    }

    // Emit to delegate
    delegate?.callQualityMonitor(
        _:didUpdateQuality: quality,
        mos: mos,
        jitter: jitter,
        rtt: rtt
    )
}
```

**Z360VoIPService** forwards to plugin:
```swift
pluginDelegate?.voipService(
    callQualityUpdated: quality.rawValue,
    mos: mos,
    jitter: jitter,
    rtt: rtt
)
```

**Proof**: `CallQualityMonitor.swift` (286 lines), `Z360VoIPService.swift:6155-6176` (delegate)

### 8.5 Network Monitoring

**NetworkMonitor** tracks WiFi ↔ Cellular handoffs during active calls:

```swift
// NWPathMonitor on background queue
monitor.pathUpdateHandler = { [weak self] path in
    let newStatus: NetworkStatus = path.status == .satisfied ? .connected : .disconnected
    let newType: NetworkType = determineNetworkType(path)

    // Debounce (500ms) to filter brief blips
    scheduleDebounceTimer()

    // If call active and network lost: start 30s timeout
    if isCallActive && newStatus == .disconnected {
        startReconnectionTimeout() // 30s
    }

    // On reconnection: cancel timeout
    if isCallActive && newStatus == .connected {
        cancelReconnectionTimeout()
    }

    // Detect WiFi ↔ Cellular transition
    if previousType != newType {
        delegate?.networkMonitor(_:didTransitionFrom:to:)
    }
}
```

**On 30s timeout during active call**:
```swift
delegate?.networkMonitorDidTimeout(monitor:)
// Z360VoIPService handles: ends call gracefully
```

**Proof**: `NetworkMonitor.swift:7142-7560` (complete implementation), timeout at lines 419+

---

## 9. Call End Scenarios

### 9.1 User Ends Call (Tap "End" in CallKit UI)

```
User taps End Call
       │
       ▼
iOS CallKit dispatches CXEndCallAction
       │
       ▼
CallKitManager.provider(_:perform:CXEndCallAction)
       │
       ▼
Z360VoIPService.didReceiveEndAction(action, uuid)
       │
       ├─ Classify: incoming not answered? → declineCall()
       ├─ Classify: outgoing connecting? → cancelOutgoingCall()
       └─ Classify: active call? → endCall()
              │
              ▼
       endCall(uuid: uuid, action: action)
              ├─ ActionGuard.attemptAction(.endCall)
              ├─ TelnyxService.endCallFromCallKit(endAction:callId:)
              │    └─ txClient.endCallFromCallkit(endAction:callId:)
              │         └─ SDK sends SIP BYE
              └─ action.fulfill()
       │
       ▼
SDK detects call ended
       │
       ▼
TxClientDelegate.onCallStateUpdated(callState: .done, callId: ...)
       │
       ▼
Z360VoIPService.callStateDidChange(.done)
       [See §9.3 for cleanup]
```

**Proof**:
- End action: `CallKitManager.swift:830-838`, `Z360VoIPService.swift:6017-6077`
- Classify: `Z360VoIPService.swift:6022-6047`
- End call: `Z360VoIPService.swift:4787-4849`
- TelnyxService: `TelnyxService.swift:3226-3229`

### 9.2 Remote Hangup (Caller Ends Call)

```
Remote party hangs up
       │
       ▼
Telnyx platform detects SIP BYE
       │
       ▼
Telnyx SDK receives notification
       │
       ▼
TxClientDelegate.onRemoteCallEnded(callId: UUID, reason: CallTerminationReason?)
       │
       ▼
TelnyxService.onRemoteCallEnded()
       │
       ├─ Dispatch to main thread
       └─ delegate?.telnyxService(_:remoteCallEnded:reason:)
              │
              ▼
Z360VoIPService.remoteCallEnded(callId: UUID, reason: String?)
       │
       ├─ Find CallKit UUID (multiple fallbacks):
       │    1. telnyxToCallKitMap[callId]
       │    2. activeCallUUID
       │    3. pendingIncomingCalls.keys.first
       │
       ├─ Check if already processed:
       │    if callEndProcessedForUUID == callKitUUID { return }
       │
       ├─ Mark as processed:
       │    callEndProcessedForUUID = callKitUUID
       │
       ├─ Check if pending (not answered):
       │    if pendingIncomingCalls[callKitUUID] exists:
       │       → handleMissedCall(uuid, pendingCall, reason: .remoteHangup)
       │          ├─ NotificationHelper.showMissedCallNotification()
       │          ├─ pluginDelegate?.voipService(missedCall:...)
       │          └─ CallKit.reportCallEnded(uuid, reason: .remoteEnded)
       │
       └─ Active call cleanup:
              ├─ callTimerManager.stopTimer()
              ├─ callQualityMonitor.stopMonitoring()
              ├─ networkMonitor.callDidEnd()
              ├─ CallKit.reportCallEnded(uuid, reason: .remoteEnded)
              ├─ pluginDelegate?.voipService(callEnded:)
              ├─ Clear state (activeCallUUID, telnyxToCallKitMap)
              └─ Reset guards (actionGuard, activeCallGuard, voipStore)
```

**Proof**:
- TxClientDelegate: `TelnyxService.swift:3582-3600` (onRemoteCallEnded)
- Z360 handling: `Z360VoIPService.swift:5821-5886` (remoteCallEnded)
- Missed call: `Z360VoIPService.swift:4913-4963` (handleMissedCall)

### 9.3 Call State: DONE (Cleanup)

**Triggered by**: `onCallStateUpdated(callState: .done, callId: ...)`

**Z360VoIPService.callStateDidChange(.done)**:
```swift
case .done:
    // 1. Deduplication check (prevents double-processing with remoteCallEnded)
    let alreadyProcessed = stateQueue.sync { callEndProcessedForUUID == callKitUUID }
    if alreadyProcessed {
        print("Call end already processed, skipping duplicate")
        return
    }

    // 2. Mark as processed
    stateQueue.sync { self.callEndProcessedForUUID = callKitUUID }

    // 3. Stop all monitoring
    let duration = callTimerManager.stopTimer()
    callQualityMonitor.stopMonitoring()
    networkMonitor.callDidEnd()

    // 4. Log to Firebase Analytics
    VoIPLogger.logEvent(.callEnded, parameters: [
        "direction": direction,
        "call_id": callKitUUID.uuidString,
        "duration_seconds": duration,
        "reason": "call_done"
    ])

    // 5. Clear call context from Crashlytics
    VoIPLogger.clearCallContext()

    // 6. Report to CallKit
    callKitManager?.reportCallEnded(uuid: callKitUUID, reason: .remoteEnded)

    // 7. Emit to plugin
    pluginDelegate?.voipService(callEnded: callKitUUID)

    // 8. Clear state
    stateQueue.sync {
        if activeCallUUID == callKitUUID {
            activeCallUUID = nil
            activeCallDirection = nil
        }
        telnyxToCallKitMap = telnyxToCallKitMap.filter { $0.value != callKitUUID }
        outgoingCallStarted.remove(callKitUUID)
    }

    // 9. Reset all guards and persistent state
    Task {
        await actionGuard.resetAll()
        await actionGuard.reset(.makeCall)  // Explicit reset for new calls
        await activeCallGuard.release(callId: callKitUUID)
        await voipStore.clearActiveCallState()
    }
```

**Why both `.done` and `remoteCallEnded`?**

The Telnyx SDK can fire both events for the same call end. The `callEndProcessedForUUID` flag prevents duplicate cleanup:
- **Scenario 1**: Remote hangup → `onRemoteCallEnded` fires → `onCallStateUpdated(.done)` fires shortly after
- **Scenario 2**: User ends → `onCallStateUpdated(.done)` fires → `onRemoteCallEnded` may or may not fire

The first event to run sets `callEndProcessedForUUID = callKitUUID`, and the second event sees the flag and returns early.

**Proof**: `Z360VoIPService.swift:5752-5809` (callStateDidChange .done), deduplication comments at lines 4082, 5754-5757, 5832-5848

---

## 10. Cold Start (App Terminated)

### 10.1 Scenario

**Initial state**: App is not running (killed by user or by iOS)

**Trigger**: VoIP push arrives via PushKit

**Requirement**: App must report to CallKit within 5 seconds or iOS terminates it

### 10.2 iOS Wakes the App

When a VoIP push arrives and the app is not running:

1. **iOS launches the app** in the background
2. **`didFinishLaunchingWithOptions`** is called
3. **PushKit delivers the push** to `pushRegistry(_:didReceiveIncomingPushWith:)`
4. **All initialization must be minimal** to meet the 5-second deadline

### 10.3 Two-Phase Startup (CRITICAL PERFORMANCE FIX)

**Problem**: If `AVAudioSession.setCategory()` is called in `didFinishLaunchingWithOptions`, it triggers audio daemon initialization which starves WebKit's IPC channels, causing **37-43 second WebView launch times** on real devices.

**Solution**: Two-phase startup.

#### Phase 1: didFinishLaunchingWithOptions (~50ms)

```swift
func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
) -> Bool {
    // ONLY these three things:

    // 1. Initialize PushKit (Apple mandate - must be here)
    PushKitManager.shared.initialize()

    // 2. Minimal VoIP/CallKit wiring (no heavy initialization)
    Z360VoIPService.shared.setupMinimal(callKitManager: CallKitManager.shared)

    // 3. Set notification center delegate (lightweight)
    UNUserNotificationCenter.current().delegate = self

    print("[AppDelegate] 🚀 MINIMAL launch - PushKit + minimal wiring initialized")
    print("[AppDelegate] ⏳ All other initialization deferred to sceneDidBecomeActive")

    return true
}
```

**What's deferred**:
- ❌ AVAudioSession configuration
- ❌ Firebase initialization
- ❌ Network monitoring
- ❌ Session expiry check
- ❌ Orphan call cleanup

**Proof**: `AppDelegate.swift:10292-10314`

#### Phase 2: performDeferredInitialization (called from SceneDelegate)

```swift
// Called from SceneDelegate.sceneDidBecomeActive()
func performDeferredInitialization() {
    guard !hasDeferredInitialization else { return }
    hasDeferredInitialization = true

    print("[AppDelegate] 🔥 Starting deferred initialization...")

    // Step 1: Configure AVAudioSession (NOW safe - WebKit already loaded)
    configureAudioSessionForVoIP()
    // Sets:
    // - category: .playAndRecord
    // - mode: .voiceChat
    // - options: .allowBluetooth, .allowBluetoothA2DP

    // Step 2: Re-call setupMinimal (with full delegates this time)
    Z360VoIPService.shared.setupMinimal(callKitManager: CallKitManager.shared)

    // Step 3: Start network monitoring
    Z360VoIPService.shared.startNetworkMonitoringIfNeeded()

    // Step 4: Initialize Firebase (on background queue)
    DispatchQueue.global(qos: .utility).async { [weak self] in
        self?.configureFirebase()

        DispatchQueue.main.async {
            // Step 5: Session expiry check (7-day token TTL)
            let sessionValid = self?.checkSessionExpiry() ?? false
            if !sessionValid {
                print("[AppDelegate] Session expired - VoIP auto-connect disabled")
            }

            // Step 6: Orphan call cleanup (crash recovery)
            self?.cleanupOrphanCallState()

            print("[AppDelegate] ✅ Deferred initialization complete")
        }
    }
}
```

**Proof**: `AppDelegate.swift:10318-10353`, called from `SceneDelegate.swift:10733-10751`

### 10.4 Cold Start Push Processing

Even with the app not running, the push must be processed within 5 seconds:

```
iOS launches app (background)
       │
       ▼
didFinishLaunchingWithOptions
       ├─ PushKitManager.initialize()
       │    └─ Registers for VoIP pushes
       └─ Z360VoIPService.setupMinimal()
              └─ Stores CallKitManager reference only
       │
       ▼ (Within milliseconds)
PushKit delivers VoIP push
       │
       ▼
pushRegistry(_:didReceiveIncomingPushWith:completion:)
       │
       ├─ [CRITICAL: Must call completion() < 5s]
       │
       ├─ processPushPayload()
       │    ├─ Feed PushCorrelator (async, non-blocking)
       │    ├─ Deduplication checks (sync, fast)
       │    └─ reportIncomingCall() → CallKit.reportNewIncomingCall()
       │         └─ iOS shows call UI (< 5s from push delivery)
       │
       └─ completion() ✅
              │
              └─ iOS: "Good, app is responsive. Keep it alive."
```

**If completion() is not called within 5 seconds**: iOS terminates the app and logs a crash report with termination reason `0xbadc0ffe` (VoIP push deadline exceeded).

**Proof**: Apple documentation, observed behavior

### 10.5 SDK Connection on Cold Start

**Critical issue**: When the app is cold-started by a push, the Telnyx SDK is **not connected yet**. The SDK connection was lost when the app was killed.

**How calls work**:

1. **PushKit push arrives** → `processPushPayload()` → `reportIncomingCall()` → CallKit UI appears
2. **In parallel**: `processTelnyxPayloadAsync()` passes Telnyx metadata to SDK
3. **SDK processes push**: `TelnyxService.processVoIPNotification(metadata)`
   - SDK reconnects WebSocket using stored credentials
   - SDK extracts call control info from metadata
   - SDK becomes ready to answer the call
4. **User taps answer** → `answerCall()` checks SDK readiness
   - If SDK not ready: `waitForClientReady(timeout: 5.0)`
   - If still not ready after 5s: attempts answer anyway (may fail gracefully)
5. **SDK answers**: `txClient.answerFromCallkit(answerAction:)` accepts SIP INVITE

**Proof**:
- Process push: `PushKitManager.swift:1156-1159` (processTelnyxPayloadAsync)
- SDK process: `TelnyxService.swift:349-382` (processVoIPNotification)
- Wait for ready: `Z360VoIPService.swift:4525-4531` (waitForPushCallReady)

### 10.6 Persistent Call Data for WebView

If the app is cold-started and the user answers before the WebView loads, the call data is persisted:

```swift
// In PushKitManager after successful CallKit report:
UserDefaults.standard.set([
    "callId": uuid.uuidString,
    "callerNumber": callerNumber,
    "callerName": callerName,
    // ...
], forKey: "z360_pending_incoming_call")
```

Later, when the WebView loads:
```swift
// TelnyxVoipPlugin.getPendingIncomingCall()
static func getPendingIncomingCall() -> [String: Any]? {
    return UserDefaults.standard.dictionary(forKey: "z360_pending_incoming_call")
}
```

JavaScript can query this via `TelnyxVoip.getPendingIncomingCall()` to get the call context.

**Proof**: `PushKitManager.swift:1627-1646` (cold start persistence methods)

---

## 11. Cross-Organization Calls

### 11.1 Scenario

User is logged into **Organization A**. An incoming call arrives for **Organization B** (where the user is also a member).

**Detection**: Z360 push contains `organization_id`. PushKitManager compares with `UserDefaults.standard.string(forKey: "z360_current_org_id")`.

### 11.2 Organization Switch Flow

```
PushKitManager.reportIncomingCall()
       │
       ├─ detectCrossOrg(pushOrgId, currentOrgId) → true
       ├─ Format caller name with org badge:
       │    "John Doe [Acme Corp]" (MO-002)
       ├─ Report to CallKit with org-badged name
       └─ Store in VoipStore.isCrossOrgCall = true
       │
       ▼
User taps Answer
       │
       ▼
Z360VoIPService.answerCall(uuid, action)
       │
       ├─ await voipStore.isCrossOrgCall(uuid) → true
       └─ await voipStore.getIncomingCallMeta(uuid) → meta
              │ (contains: organizationId, organizationName, callerNumber)
              │
              ▼
       performCrossOrgSwitch(uuid, targetOrgId, targetOrgName)
              │
              ├─ [CRITICAL: Must complete within 5s CallKit deadline]
              │
              ├─ Notify plugin (loading indicator)
              ├─ pluginDelegate.voipServiceOrgSwitchStarted(...)
              │
              ├─ OrganizationSwitcher.switchOrganization(targetOrgId, targetOrgName)
              │    │
              │    ├─ STEP 1: Capture original context (for rollback)
              │    │    originalOrgId = await voipStore.getCurrentOrganizationId()
              │    │    originalCredentials = await voipStore.getCredentials()
              │    │
              │    ├─ STEP 2: Begin background task (safety net)
              │    │    backgroundTaskId = UIApplication.beginBackgroundTask()
              │    │
              │    ├─ STEP 3: Call API (4s timeout)
              │    │    POST /api/voip/switch-org
              │    │    Headers: cookies from WKWebsiteDataStore
              │    │    Body: { target_organization_id: targetOrgId }
              │    │    Response: { sip_username, sip_password, caller_id_name, ... }
              │    │
              │    ├─ STEP 4: Check time budget
              │    │    elapsed = Date().timeIntervalSince(startTime)
              │    │    if elapsed > 4.5s: warn "Approaching 5s deadline"
              │    │
              │    ├─ STEP 5: Store new credentials
              │    │    await voipStore.saveCredentials(newCredentials)
              │    │    await voipStore.setCurrentOrganization(id:name:)
              │    │
              │    ├─ STEP 6: Reconnect Telnyx SDK
              │    │    reconnectTelnyxService(with: newCredentials)
              │    │      ├─ telnyxService.disconnect()
              │    │      ├─ telnyxService.connect(credentials)
              │    │      └─ Wait for isClientReady() (3s timeout, 50ms poll)
              │    │
              │    ├─ STEP 7: On failure → Rollback
              │    │    restoreOriginalContext()
              │    │      ├─ await voipStore.setCurrentOrganization(originalOrgId, ...)
              │    │      └─ await voipStore.saveCredentials(originalCredentials)
              │    │      └─ Do NOT reconnect SDK (call is ending anyway)
              │    │
              │    └─ End background task
              │
              ├─ Log to Firebase Analytics
              │
              └─ On failure: emit error to plugin
                    pluginDelegate.voipService(orgSwitchFailed:error:)
```

**Proof**:
- Detection: `PushKitManager.swift:1198-1207` (detectCrossOrg + format name)
- Answer check: `Z360VoIPService.swift:4533-4556` (cross-org detection in answerCall)
- Perform switch: `Z360VoIPService.swift:4618-4700` (performCrossOrgSwitch)
- OrganizationSwitcher: `OrganizationSwitcher.swift:8090-8172` (switchOrganization), `8176-8207` (rollback)

### 11.3 Timing Constraints

| Phase | Time Allowed | Cumulative |
|-------|-------------|------------|
| API call (POST /api/voip/switch-org) | 4.0s | 4.0s |
| Store credentials + update VoipStore | ~0.1s | 4.1s |
| Disconnect SDK | ~0.1s | 4.2s |
| Reconnect SDK | 3.0s max | 7.2s ❌ |

**Problem**: Total can exceed 5s CallKit deadline.

**Mitigation**:
1. API timeout is 4.0s (hard limit)
2. Reconnect timeout is 3.0s but pollsterval is 50ms (fails fast if SDK won't connect)
3. Safety margin: OrganizationSwitcher warns if total > 4.5s
4. On any failure: **rollback** to original org

**Proof**: `OrganizationSwitcher.swift:8090` (timing constants at lines 8094-8096)

### 11.4 Rollback on Failure

If any step fails (API error, timeout, SDK reconnect failure):

```swift
do {
    try await performCrossOrgSwitch(...)
} catch {
    // Switch failed - answer call will fail
    action.fail()

    // OrganizationSwitcher already did rollback:
    // - Restored originalOrgId in VoipStore
    // - Restored originalCredentials in Keychain
    // - Did NOT reconnect SDK (call is ending)
}
```

**User experience**:
- CallKit UI shows "Call Failed" or "Answer Failed"
- User remains in original organization
- Credentials unchanged
- Next call attempt will work normally

**Proof**: `Z360VoIPService.swift:4589-4602` (catch block with rollback)

---

## 12. Edge Cases & Failure Modes

### 12.1 Only One Push Arrives

**Scenario 1: Z360 push arrives, Telnyx push never arrives**

```
PushKitManager.processPushPayload()
       │
       ├─ extractZ360CallInfo() → success
       ├─ extractTelnyxMetadata() → nil
       │
       ├─ Feed PushCorrelator.processZ360Push() (async)
       │
       ├─ No Telnyx metadata → wait for Telnyx push:
       │    waitForTelnyxData(callerNumber, timeout: 1.5s)
       │    [Calls PushCorrelator.awaitMergedData internally]
       │       │
       │       └─ After 1.5s timeout:
       │            returns nil
       │
       ├─ Use Z360 call ID as CallKit UUID
       │    callUUID = z360Info.callId ?? UUID()
       │
       └─ reportIncomingCall() with Z360 data only
              └─ CallKit UI shows call with Z360 caller info
```

**Result**: Call is reported to CallKit using Z360's call UUID. When user answers, SDK may not be able to answer because it never received the Telnyx push (no SIP INVITE context). **Likely outcome**: Answer fails.

**Mitigation**: Backend should ensure both pushes are sent. If Telnyx push fails, backend can retry or the call will fail gracefully.

**Proof**: `PushKitManager.swift:1163-1182` (Z360-only path with waitForTelnyxData)

**Scenario 2: Telnyx push arrives, Z360 push never arrives**

```
PushKitManager.processPushPayload()
       │
       ├─ extractZ360CallInfo() → nil
       ├─ extractTelnyxMetadata() → success
       │
       ├─ Feed PushCorrelator.processTelnyxPush() (async)
       │
       ├─ Telnyx metadata present → report immediately:
       │    callUUID = UUID(telnyxInfo.callId) ?? UUID()
       │    callInfo = buildCallInfoFromTelnyx(telnyxInfo)
       │         └─ Uses Telnyx caller_number/caller_name (less rich)
       │
       └─ reportIncomingCall() with Telnyx data only
              └─ CallKit UI shows call with basic Telnyx caller info
```

**Result**: Call is reported to CallKit using Telnyx's call ID. CallKit UI shows caller number (and maybe name from Telnyx) but no avatar, no org badge. Call can be answered successfully because SDK has SIP INVITE context from Telnyx metadata.

**When Z360 push arrives later**: Deduplication logic detects existing CallKit report and calls `updateCallInfo()` to enrich the UI with Z360 data (avatar, org name, etc.).

**Proof**: `PushKitManager.swift:1144-1160` (Telnyx present path), `1097-1121` (dedup + update path)

### 12.2 Duplicate Pushes

**Scenario**: Telnyx sends duplicate push (network retry, backend error).

**Detection**: `PushKitManager` maintains two indexes:
- `callUUIDByPhone: [String: UUID]` — normalized phone → CallKit UUID
- `callUUIDByTelnyxId: [String: UUID]` — Telnyx call ID → CallKit UUID

```swift
if let existingUUID = findExistingCallUUID(
    callerNumber: telnyxInfo.callerNumber,
    telnyxCallId: telnyxInfo.callId
) {
    print("[PushKitManager] 🔁 Duplicate Telnyx push for existing call")

    // Ensure SDK processes metadata even if CallKit already reported
    if let telnyxMetadata = telnyxMetadata {
        processTelnyxPayloadAsync(telnyxMetadata)
    }

    // Update mappings
    storeReportedCall(uuid: existingUUID, ...)

    completion()
    return // Don't report to CallKit again
}
```

**Result**: Duplicate push is ignored for CallKit (no second incoming call UI), but SDK still processes the metadata (in case the first processing failed).

**Proof**: `PushKitManager.swift:1122-1142` (duplicate Telnyx push handling)

### 12.3 App Killed During Active Call

**Scenario**: User is on a call. iOS force-kills the app (low memory, user swipes away).

**Before kill**: `Z360VoIPService` persists call state:
```swift
// In callStateDidChange(.active):
let state = PersistableCallState(
    callId: callKitUUID,
    direction: .incoming,
    callerNumber: callInfo?.handle ?? "Unknown",
    callerName: callInfo?.callerName,
    startTime: Date()
)
await voipStore.saveActiveCallState(state)
```

Stored in: `UserDefaults.standard` with key `"z360_active_call_state"`

**On next launch**: `AppDelegate.performDeferredInitialization()` calls `cleanupOrphanCallState()`:
```swift
func cleanupOrphanCallState() {
    // Read persisted call state
    guard let persistedState = await VoipStore.shared.getActiveCallState() else {
        return
    }

    print("[AppDelegate] 🧹 Orphan call detected: \(persistedState.callId)")

    // Delegate to Z360VoIPService for recovery
    Z360VoIPService.shared.recoverOrphanCallState(persistedState)
}

// In Z360VoIPService:
func recoverOrphanCallState(_ state: PersistableCallState) {
    print("[Z360VoIPService] 🔄 Recovering orphan call: \(state.callId)")

    // Report ended to CallKit (if still in CallKit's memory)
    callKitManager?.reportCallEnded(uuid: state.callId, reason: .failed)

    // Clear persisted state
    Task {
        await voipStore.clearActiveCallState()
    }

    // Could emit event to plugin (US-026)
}
```

**Result**: Call is cleaned up gracefully on next launch. CallKit UI is dismissed if still present.

**Proof**:
- Persist: `Z360VoIPService.swift:5700-5714` (saveActiveCallState in .active)
- Cleanup: `AppDelegate.swift:10398-10428` (cleanupOrphanCallState), `Z360VoIPService.swift:4107-4136` (recoverOrphanCallState)

### 12.4 `call_ended` Push (Answered Elsewhere)

**Scenario**: User has two devices (iPhone + iPad). Call rings on both. User answers on iPad. iPhone should dismiss the incoming call UI.

**Backend sends**: `call_ended` push to iPhone with type `"call_ended"` and `call_session_id`.

**iPhone processing**:
```swift
if let pushType = payload["type"] as? String, pushType == "call_ended" {
    let callSessionId = payload["call_session_id"] as? String ?? ""

    // Find existing CallKit call
    if let existingUUID = findExistingCallUUID(
        callerNumber: nil,
        telnyxCallId: callSessionId
    ) {
        print("[PushKitManager] Reporting call ended: \(existingUUID)")
        callKitManager?.reportCallEnded(
            uuid: existingUUID,
            reason: .answeredElsewhere
        )
    } else {
        // PushKit mandate: MUST report a call even if no match found
        // Otherwise iOS terminates the app for violating VoIP push contract
        print("[PushKitManager] No matching call - reporting fake call")

        let fakeUUID = UUID()
        callKitManager?.reportIncomingCall(
            uuid: fakeUUID,
            handle: "Unknown",
            hasVideo: false
        ) { [weak self] error in
            if error == nil {
                // Immediately end the fake call
                self?.callKitManager?.reportCallEnded(
                    uuid: fakeUUID,
                    reason: .remoteEnded
                )
            }
        }
    }

    completion()
    return
}
```

**Why the "fake call" hack?**

Apple's PushKit contract: **Every VoIP push must result in a CallKit report** (either `reportNewIncomingCall` or `reportCallUpdated`). If the app doesn't report a call, iOS terminates it.

In the case where the `call_ended` push arrives but no CallKit call exists (race condition: push arrived before the call was reported, or call already ended), the app **must still report something** to satisfy PushKit. The "fake call" is reported and immediately ended.

**Proof**: `PushKitManager.swift:1041-1067` (call_ended handling)

### 12.5 User Already on Call (US-025)

**Scenario**: User is on an active call. A second incoming call arrives.

**Detection**: `PushKitManager.reportIncomingCall()` checks:
```swift
let isAlreadyOnCall = checkIfAlreadyOnCall()
if isAlreadyOnCall {
    print("[PushKitManager] 📵 US-025: Already on active call - will reject")
}
```

**Still reports to CallKit** (PushKit contract), but:

```swift
callKitManager.reportIncomingCall(...) { [weak self] error in
    if error == nil {
        if isAlreadyOnCall {
            // Reject immediately
            self?.handleSimultaneousCallRejection(uuid: uuid)
        } else {
            // Normal flow
        }
    }
}

func handleSimultaneousCallRejection(uuid: UUID) {
    // Reject via TelnyxService (sends SIP 486 Busy)
    Z360VoIPService.shared.rejectIncomingCall(uuid: uuid, reason: .busy)

    // Report ended to CallKit
    callKitManager?.reportCallEnded(uuid: uuid, reason: .declined)

    // Show missed call notification
    NotificationHelper.shared.showMissedCallNotification(...)
}
```

**Result**: Second call is auto-rejected. User on active call is not interrupted. Second caller hears busy signal. iPhone shows missed call notification.

**Proof**: `PushKitManager.swift:1209-1213` (US-025 check), `1252-1275` (simultaneous rejection handling - specific implementation varies)

### 12.6 Cross-Org Switch Timeout

**Scenario**: Cross-org API call takes > 4.5s (slow backend, network latency).

**Handling**:
```swift
do {
    try await performCrossOrgSwitch(uuid, targetOrgId, targetOrgName)
} catch OrganizationSwitchError.timeout {
    print("[Z360VoIPService] ❌ Org switch timed out")

    // action.fail() already called by catch block

    // OrganizationSwitcher.switchOrganization threw timeout:
    // 1. Detected elapsed time > 4.5s
    // 2. Aborted API call (URLSession timeout)
    // 3. Did rollback: restored original org + credentials

    // Emit error to plugin
    let delegate = self.pluginDelegate
    await MainActor.run {
        delegate?.voipService(
            orgSwitchFailed: uuid,
            error: "Timeout switching organization",
            errorType: .networkError
        )
    }

    // User sees: "Answer Failed" or "Call Failed" in CallKit UI
    // User remains in original organization
}
```

**Proof**: `Z360VoIPService.swift:4589-4602` (catch block), `OrganizationSwitcher.swift:8090-8172` (timeout detection)

### 12.7 SDK Not Ready When Answering

**Scenario**: User answers call before SDK has finished connecting (cold start, slow network).

**Handling**:
```swift
// In answerCall():
if !telnyxService.isClientReady() {
    print("[Z360VoIPService] ⚠️ SDK not ready - attempting reconnection")

    let reconnected = await attemptReconnection()
    // attemptReconnection():
    //   1. Read credentials from VoipStore
    //   2. telnyxService.connect(credentials)
    //   3. waitForClientReady(timeout: 5.0)
    //        └─ Polls isClientReady() every 100ms for up to 5s

    if !reconnected {
        print("[Z360VoIPService] ❌ SDK reconnection failed - cannot answer")
        action.fail()
        await actionGuard.reset(.answer)
        return
    }
}

// Additional safety net: wait for push call to be ready
let callAvailable = await waitForPushCallReady(uuid: uuid, timeout: 5.0)
if !callAvailable {
    print("[Z360VoIPService] ⚠️ Push call not ready after 5s")
    print("[Z360VoIPService] Attempting to answer anyway")
    // Proceed - SDK may have call via different path
}

// Finally answer
telnyxService.answerFromCallKit(answerAction: action)
```

**Proof**: `Z360VoIPService.swift:4500-4531` (SDK readiness + push call ready checks)

---

## 13. File Reference Map

This section provides a complete mapping of all iOS VoIP components to their file locations for verification.

### 13.1 Core Managers

| Component | File | Line Range | Key Methods |
|-----------|------|------------|-------------|
| PushKitManager | `ios/App/App/VoIP/Managers/PushKitManager.swift` | 912-1860 | `initialize()`, `processPushPayload()`, `reportIncomingCall()` |
| CallKitManager | `ios/App/App/VoIP/Managers/CallKitManager.swift` | 452-907 | `reportIncomingCall()`, `provider(_:perform:)` delegates |
| AudioManager | `ios/App/App/VoIP/Managers/AudioManager.swift` | 3-448 | `setMute()`, `setHold()`, `setSpeaker()`, `sendDTMF()` |

### 13.2 Services

| Component | File | Line Range | Key Methods |
|-----------|------|------------|-------------|
| Z360VoIPService | `ios/App/App/VoIP/Services/Z360VoIPService.swift` | 4019-6270 | `answerCall()`, `callStateDidChange()`, `remoteCallEnded()` |
| TelnyxService | `ios/App/App/VoIP/Services/TelnyxService.swift` | 3001-3667 | `connect()`, `answerFromCallKit()`, `enableAudioSession()` |
| VoipStore | `ios/App/App/VoIP/Services/VoipStore.swift` | 3672-4014 | `saveCredentials()`, `getCallDisplayInfo()`, `isCrossOrgCall()` |
| PushCorrelator | `ios/App/App/VoIP/Services/PushCorrelator.swift` | 2386-2996 | `processZ360Push()`, `processTelnyxPush()`, `awaitMergedData()` |

### 13.3 Utilities

| Component | File | Line Range | Purpose |
|-----------|------|------------|---------|
| ActionGuard | `ios/App/App/VoIP/Utils/ActionGuard.swift` | - | Double-tap prevention (BUG-005) |
| ActiveCallGuard | `ios/App/App/VoIP/Utils/ActiveCallGuard.swift` | - | Single-call enforcement (US-014, US-025) |
| CallQualityMonitor | `ios/App/App/VoIP/Utils/CallQualityMonitor.swift` | 7564-7849 | MOS/jitter/RTT tracking (US-018) |
| CallTimerManager | `ios/App/App/VoIP/Utils/CallTimerManager.swift` | - | Call duration tracking (US-015) |
| NetworkMonitor | `ios/App/App/VoIP/Utils/NetworkMonitor.swift` | 7142-7560 | WiFi/Cellular monitoring, 30s timeout (US-024) |
| NotificationHelper | `ios/App/App/VoIP/Utils/NotificationHelper.swift` | - | Missed call local notifications (US-013) |
| OrganizationSwitcher | `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | 7918-8398 | Cross-org credential switching (US-022, US-023) |
| KeychainManager | `ios/App/App/VoIP/Utils/KeychainManager.swift` | 7035-7138 | Secure credential storage |
| VoIPLogger | `ios/App/App/VoIP/Utils/VoIPLogger.swift` | 6274-6984 | Firebase Crashlytics + Analytics integration |

### 13.4 App Lifecycle

| Component | File | Line Range | Key Methods |
|-----------|------|------------|-------------|
| AppDelegate | `ios/App/App/AppDelegate.swift` | 10263-10598 | `didFinishLaunchingWithOptions` (Phase 1), `performDeferredInitialization()` (Phase 2) |
| SceneDelegate | `ios/App/App/SceneDelegate.swift` | 10695-10770 | `sceneDidBecomeActive()` triggers Phase 2 |

### 13.5 Capacitor Bridge

| Component | File | Line Range | Purpose |
|-----------|------|------------|---------|
| TelnyxVoipPlugin | `ios/App/App/VoIP/TelnyxVoipPlugin.swift` | - | Capacitor plugin with 21 @objc methods, bridges JS ↔ native |

### 13.6 Models

| Component | File | Purpose |
|-----------|------|---------|
| CallInfo | `ios/App/App/VoIP/Models/CallInfo.swift` | Call metadata stored by CallKitManager |
| VoIPModels | `ios/App/App/VoIP/Models/VoIPModels.swift` | SIPCredentials, CallDirection, CallDisplayInfo, etc. |

### 13.7 Protocols

| Protocol | File | Implementer |
|----------|------|-------------|
| CallKitManagerDelegate | `ios/App/App/VoIP/Protocols/CallKitManagerDelegate.swift` | Z360VoIPService |
| TelnyxServiceDelegate | `ios/App/App/VoIP/Protocols/TelnyxServiceDelegate.swift` | Z360VoIPService |
| AudioManagerDelegate | `ios/App/App/VoIP/Protocols/AudioManagerDelegate.swift` | TelnyxVoipPlugin |
| NetworkMonitorDelegate | `ios/App/App/VoIP/Protocols/NetworkMonitorDelegate.swift` | Z360VoIPService |
| CallQualityMonitorDelegate | `ios/App/App/VoIP/Protocols/CallQualityMonitorDelegate.swift` | Z360VoIPService |
| CallTimerManagerDelegate | `ios/App/App/VoIP/Protocols/CallTimerManagerDelegate.swift` | Z360VoIPService |
| Z360VoIPServicePluginDelegate | `ios/App/App/VoIP/Protocols/Z360VoIPServicePluginDelegate.swift` | TelnyxVoipPlugin |

---

## End of Document

**Total Components Traced**: 25+ Swift files
**Total Lines of Native Code**: ~10,636 lines
**Critical Paths Documented**:
- Push reception → CallKit report (5s deadline)
- Two-push synchronization (PushCorrelator)
- Answer flow (10+ steps)
- Cross-org switch (7 steps with rollback)
- Call end scenarios (3 paths)
- Cold start (two-phase startup)

**All claims backed by file references** from `.claude/skills/voip-ios/`.
