---
title: Call State Machine
---

# Z360 VoIP Call State Machine: Unified Reference

![Z360 Distributed Call State Machine](/diagrams/distributed-call-state-machine.jpeg)

> **Session 10** | **Date**: 2026-02-08
> **Author**: state-machine-designer
> **Scope**: Canonical call state machine definition across Web, iOS, Android, Backend, and Telnyx SDKs

---

## Executive Summary

Z360's call state management is **distributed across four layers** with **no unified state machine**. Each platform (Web, iOS, Android, Backend) tracks state independently using **different state models**, creating complexity in cross-platform coordination. The system relies on **Telnyx SDK state machines** as the source of truth for client call states, **backend cache flags** for simultaneous ring coordination, and **platform-specific persistence** for crash recovery.

### Key Findings

| Layer | State Model | States Tracked | Persistence | Source |
|-------|-------------|----------------|-------------|--------|
| **Telnyx iOS SDK** | `CallState` enum (9 states) | NEW, CONNECTING, RINGING, ACTIVE, HELD, DONE, RECONNECTING, DROPPED | None (ephemeral) | `.scratchpad/packs/telnyx-ios-sdk.xml` |
| **Telnyx Android SDK** | `CallState` sealed class (10 states) | NEW, CONNECTING, RINGING, ACTIVE, HELD, DONE, ERROR, RENEGOTIATING, RECONNECTING, DROPPED | None (ephemeral) | `.scratchpad/packs/telnyx-android-sdk.xml` |
| **Web (Telnyx React)** | `activeCall.state` (4 states) | requesting, ringing, active, destroy | None (ephemeral) | `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:206` |
| **Z360 Android** | CallStatePersistence (custom) | active call metadata | SharedPreferences | `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt` |
| **Z360 iOS** | PersistableCallState (custom) | active call metadata | UserDefaults | `ios/App/App/VoIP/Models/VoIPModels.swift:118-161` |
| **Backend** | Redis cache flags | `answered: true/false` | Redis (10min TTL) | `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:496` |

### Critical Gaps

1. **No unified state model**: Each platform uses different states (iOS: 9 states, Android: 10 states, Web: 4 states)
2. **No cross-platform state sync**: Platforms don't communicate state changes to each other
3. **Incomplete persistence**: Only "active" calls are persisted; ringing/connecting states lost on crash
4. **Backend is stateless**: Backend only tracks `answered` flag, not full call lifecycle
5. **No state transition validation**: Illegal transitions (e.g., HELD → RINGING) not prevented

---

## 1. Telnyx SDK State Machines (Source of Truth)

### 1.1 Telnyx iOS SDK: `CallState` Enum

**Source**: `.scratchpad/packs/telnyx-ios-sdk.xml` — iOS SDK `CallState.swift`

```swift
public enum CallState: Equatable {
    /// New call has been created in the client.
    case NEW

    /// The outbound call is being sent to the server.
    case CONNECTING

    /// Call is pending to be answered. Someone is attempting to call you.
    case RINGING

    /// Call is active when two clients are fully connected.
    case ACTIVE

    /// Call has been held.
    case HELD

    /// Call has ended.
    case DONE(reason: CallTerminationReason? = nil)

    /// The active call is being recovered. Usually after a network switch or bad network
    case RECONNECTING(reason: Reason)

    /// The active call is dropped. Usually when the network is lost.
    case DROPPED(reason: Reason)
}
```

**State Transitions (iOS)**:

```
NEW → CONNECTING → RINGING → ACTIVE → DONE
 ↓         ↓          ↓         ↓
DONE      DONE       DONE      DONE
                               ↓
                            HELD ⟷ ACTIVE
                               ↓
                            DONE

Network issues:
ACTIVE → RECONNECTING → ACTIVE
       ↘ DROPPED → DONE
```

**Persistence**: None — state is ephemeral, lost on app termination.

**File**: iOS SDK — no direct access, inferred from usage in `ios/App/App/VoIP/Services/Z360VoIPService.swift`

---

### 1.2 Telnyx Android SDK: `CallState` Sealed Class

**Source**: `.scratchpad/packs/telnyx-android-sdk.xml` — Android SDK `CallState.kt`

```kotlin
sealed class CallState {
    /** The call has been created. */
    object NEW : CallState()

    /** The call is being connected to the remote client. */
    object CONNECTING : CallState()

    /** The call invitation has been extended, we are waiting for an answer. */
    object RINGING : CallState()

    /** The call is active and the two clients are fully connected. */
    object ACTIVE : CallState()

    /** The call is being renegotiated (ICE restart or media update). */
    object RENEGOTIATING : CallState()

    /** The user has put the call on hold. */
    object HELD : CallState()

    /** The call is finished - either party has ended the call. */
    data class DONE(val reason: CallTerminationReason? = null) : CallState()

    /** There was an issue creating the call. */
    object ERROR : CallState()

    /** The call was dropped as a result of network issues. */
    data class DROPPED(val callNetworkChangeReason: CallNetworkChangeReason) : CallState()

    /** The call is being reconnected after a network issue. */
    data class RECONNECTING(val callNetworkChangeReason: CallNetworkChangeReason) : CallState()
}
```

**State Transitions (Android)**:

```
NEW → CONNECTING → RINGING → ACTIVE → DONE
 ↓         ↓          ↓         ↓
ERROR    ERROR      ERROR     DONE
                               ↓
                            HELD ⟷ ACTIVE
                               ↓
                            RENEGOTIATING → ACTIVE
                               ↓              ↓
                            DONE           DONE

Network issues:
ACTIVE → RECONNECTING → ACTIVE
       ↘ DROPPED → DONE
       ↘ ERROR
```

**Additional States (not in iOS)**:
- **ERROR**: SDK encountered an error creating or managing the call
- **RENEGOTIATING**: ICE restart or media renegotiation in progress (WebRTC layer)

**Persistence**: None — state is ephemeral.

**File**: Android SDK — observed in `android/telnyx_common/src/main/java/com/telnyx/webrtc/common/TelnyxViewModel.kt:callStateFlow`

---

### 1.3 Web (Telnyx React Client): `activeCall.state`

**Source**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:206`

```typescript
type CallState = 'requesting' | 'ringing' | 'active' | 'destroy';

// Usage:
const activeCall = notification && notification.call && notification.call.state !== 'destroy'
    ? notification.call
    : null;
```

**State Transitions (Web)**:

```
requesting → ringing → active → destroy
    ↓           ↓         ↓
  destroy    destroy   destroy
```

**Mapping to Telnyx SDK states**:
- `requesting` ≈ CONNECTING
- `ringing` ≈ RINGING (inbound) or waiting for answer (outbound)
- `active` ≈ ACTIVE
- `destroy` ≈ DONE (call has ended and should be removed from UI)

**Persistence**: None — state is in React component state only.

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:206-228`

**Usage in Code**:
```typescript
// Line 216-217: Call dismissal check
if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
    activeCall.hangup();
}

// Line 228: Timer starts only when active
const elapsedTime = useCountdown(Boolean(activeCall?.state === 'active'));
```

---

## 2. Z360 Platform-Specific State Extensions

### 2.1 Z360 Android: CallStatePersistence

**Purpose**: Persist active call metadata for crash recovery.

**Source**: `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt`

**Persisted State**:
```kotlin
data class PersistedCallState(
    val callId: String,           // Call session ID
    val callerNumber: String,     // Remote party number
    val callerName: String,       // Remote party display name
    val startTime: Long,          // Unix timestamp
    val callControlId: String?,   // Telnyx call control ID
    val isOutgoing: Boolean       // Direction
)
```

**Storage**: `SharedPreferences` (key: `call_state_prefs`)

**Lifecycle**:
1. **Save**: Called when call becomes ACTIVE (from `ActiveCallActivity`)
2. **Clear**: Called when call ends normally
3. **Detect**: Called on app startup to detect abandoned calls

**File Reference**: `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt:49-56`

**Usage**:
```kotlin
// Save on call answer (ActiveCallActivity.kt ~ line 350)
CallStatePersistence.getInstance(context).saveActiveCall(
    callId = callSessionId,
    callerNumber = callerNumber,
    callerName = callerName,
    callControlId = callControlId,
    isOutgoing = isOutgoing
)

// Clear on call end (ActiveCallActivity.kt ~ line 987-1015)
CallStatePersistence.getInstance(context).clearActiveCall()

// Detect on app start (MainActivity.kt)
CrashRecoveryManager.getInstance(context).checkAndRecoverFromCrash()
```

**Limitations**:
- Only persists ACTIVE state, not RINGING or CONNECTING
- No TTL — orphaned state persists indefinitely until next app launch
- No cleanup if user force-stops app without ending call

---

### 2.2 Z360 iOS: PersistableCallState

**Purpose**: Store call state in UserDefaults for crash recovery.

**Source**: `ios/App/App/VoIP/Models/VoIPModels.swift:118-161`

**Persisted State**:
```swift
struct PersistableCallState: Codable, Sendable {
    let callId: UUID               // CallKit UUID
    let direction: CallDirection   // .incoming or .outgoing
    let callerNumber: String       // Remote party number
    let callerName: String?        // Remote party name
    let avatarUrl: String?         // Avatar URL
    let organizationId: String?    // Org context
    let startTime: Date            // Start timestamp
}
```

**Storage**: `UserDefaults.standard` (managed by `VoipStore.swift`)

**Lifecycle**:
1. **Save**: When call becomes active (tracked in `VoipStore.activeCallState`)
2. **Clear**: When call ends normally via `VoipStore.clearActiveCall()`
3. **Detect**: On app launch via orphan recovery logic

**File Reference**: `ios/App/App/VoIP/Services/VoipStore.swift` (actor-isolated for thread safety)

**Usage**:
```swift
// Save active state
await VoipStore.shared.saveActiveCallState(callState)

// Clear on end
await VoipStore.shared.clearActiveCall()

// Recover orphan (called from AppDelegate)
await VoipStore.shared.recoverOrphanCallState()
```

**Implementation** (from `VoipStore.swift:170-213`):
```swift
// MARK: - Active Call State (Crash Recovery)

/// Save active call state for crash recovery
func saveActiveCallState(_ state: PersistableCallState) {
    self.activeCallState = state
    // Persist to UserDefaults
    if let encoded = try? JSONEncoder().encode(state) {
        userDefaults.set(encoded, forKey: Keys.activeCallState)
    }
}

/// Clear active call state (call ended normally)
func clearActiveCall() {
    self.activeCallState = nil
    userDefaults.removeObject(forKey: Keys.activeCallState)
}

/// Recover orphan call state after crash
func recoverOrphanCallState() -> PersistableCallState? {
    // Implementation reads from UserDefaults and reports to CallKit
}
```

**Advantages over Android**:
- Uses Swift Actor for thread safety (no manual synchronization needed)
- Integrates with CallKit to report ended calls on recovery
- Typed `CallDirection` enum vs boolean `isOutgoing`

---

### 2.3 Backend: Redis Cache State Tracking

**Purpose**: Coordinate "first answer wins" simultaneous ring logic.

**Source**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php`

**Cache Structure**:
```php
Cache::put("simring:{parent_call_control_id}", [
    'parent_call_control_id' => string,
    'user_id' => int,
    'message_id' => int,
    'answered' => bool,              // false → true on first answer
    'leg_ids' => array,              // Array of leg call_control_ids
    'answered_leg' => string|null    // Which leg won the race
], now()->addMinutes(10));
```

**Lock for Atomic Answer**:
```php
$lock = Cache::lock("simring:{parent_call_control_id}:lock", 10);
```

**State Transitions**:
```
Cache Created (transferToUser)
  ├─ answered: false
  ├─ leg_ids: []
  ↓
Legs Created (call.initiated webhooks)
  ├─ leg_ids: ["v3:leg-1", "v3:leg-2", ...]
  ↓
First Device Answers (onCallAnswered)
  ├─ Lock acquired
  ├─ answered: true
  ├─ answered_leg: "v3:leg-1"
  ├─ Parent answered + bridged
  ├─ Other legs hung up
  ↓
Call Ends (onSimRingParentHangup or onSimRingLegHangup)
  ├─ Cache deleted
  └─ Cleanup notifications sent
```

**File References**:
- Create: `TelnyxInboundWebhookController.php:377-383`
- Update `answered`: `TelnyxInboundWebhookController.php:492-498`
- Lock acquire: `TelnyxInboundWebhookController.php:479`
- Delete: `TelnyxInboundWebhookController.php:643, 741, 774`

**Limitations**:
- Only tracks binary `answered` flag, not full call lifecycle
- 10-minute TTL — calls longer than 10 minutes lose cache state (mitigated by `client_state` fallback)
- No state history — can't reconstruct what happened if cache expires

---

## 3. Canonical State Machine (Target Architecture)

### 3.1 Unified State Model

Based on analysis of all platforms, here is the **canonical state model** that encompasses all observed states:

```
enum UnifiedCallState {
    // Pre-connection states
    IDLE,                // No call exists
    REQUESTING,          // Outbound call initiated (web term)
    CONNECTING,          // SIP INVITE sent, waiting for provisional response

    // Ringing states
    RINGING_INBOUND,     // Incoming call, device is ringing
    RINGING_OUTBOUND,    // Outbound call, waiting for remote answer

    // Connected states
    ACTIVE,              // Call connected, audio flowing
    ON_HOLD,             // Local user put call on hold
    REMOTE_HOLD,         // Remote party put call on hold

    // Network recovery states
    RECONNECTING,        // Network issue, attempting recovery
    RENEGOTIATING,       // Media renegotiation (Android-specific)

    // Terminal states
    DISCONNECTING,       // Hangup initiated, waiting for cleanup
    ENDED,               // Call ended successfully
    FAILED,              // Call setup or connection failed
    MISSED,              // Inbound call not answered
    DROPPED,             // Call dropped due to network/error
}
```

### 3.2 Complete State Transition Table

| From State | To State | Trigger | Platform Support | Side Effects |
|------------|----------|---------|------------------|--------------|
| **IDLE** | REQUESTING | User initiates outbound call (web) | Web | Client sends SIP INVITE |
| **IDLE** | CONNECTING | User initiates outbound call (mobile) | iOS, Android | Client sends SIP INVITE |
| **IDLE** | RINGING_INBOUND | Push notification received | iOS, Android, Web | Show call UI, play ringtone |
| **REQUESTING** | RINGING_OUTBOUND | SIP 180/183 received | Web | Show "calling..." UI |
| **CONNECTING** | RINGING_OUTBOUND | SIP 180/183 received | iOS, Android | Show "calling..." UI, play ringback |
| **CONNECTING** | FAILED | SIP 4xx/5xx error | All | Show error, cleanup |
| **RINGING_INBOUND** | ACTIVE | User answers (SIP 200 OK) | All | Backend bridges, audio starts, dismiss other devices |
| **RINGING_INBOUND** | MISSED | Timeout (30s) or caller hangup | All | Backend routes to voicemail, cleanup |
| **RINGING_INBOUND** | ENDED | User declines | All | Send SIP 486/603, cleanup |
| **RINGING_OUTBOUND** | ACTIVE | Remote answers (SIP 200 OK) | All | Audio starts, persist call state |
| **RINGING_OUTBOUND** | FAILED | Remote declines (SIP 486/603) | All | Show "call declined", cleanup |
| **RINGING_OUTBOUND** | MISSED | Timeout or remote no answer | All | Show "no answer", cleanup |
| **ACTIVE** | ON_HOLD | User presses hold | iOS, Android, Web | Send SIP re-INVITE (hold), mute audio |
| **ON_HOLD** | ACTIVE | User resumes | iOS, Android, Web | Send SIP re-INVITE (resume), unmute |
| **ACTIVE** | REMOTE_HOLD | Remote sends hold re-INVITE | iOS, Android, Web | Show "on hold" UI, remote audio stops |
| **ACTIVE** | RECONNECTING | Network change detected | iOS, Android | Attempt ICE restart, show reconnecting UI |
| **ACTIVE** | RENEGOTIATING | Media update required | Android | Send SIP re-INVITE |
| **ACTIVE** | ENDED | User or remote hangs up | All | Send SIP BYE, cleanup, clear persistence |
| **ACTIVE** | DROPPED | Network lost | iOS, Android | Show error, attempt recovery or end |
| **RECONNECTING** | ACTIVE | Network restored, ICE succeeds | iOS, Android | Resume audio, hide reconnecting UI |
| **RECONNECTING** | DROPPED | Recovery timeout exceeded | iOS, Android | Give up, show error, end call |
| **RECONNECTING** | ENDED | User or remote hangs up during recovery | iOS, Android | Abort recovery, cleanup |
| **RENEGOTIATING** | ACTIVE | Media renegotiation complete | Android | Resume normal state |
| **DROPPED** | ENDED | Cleanup after drop | iOS, Android | Show "call dropped", cleanup, clear persistence |
| **DISCONNECTING** | ENDED | SIP BYE acknowledged | All | Final cleanup, clear persistence |
| **(any)** | FAILED | SDK internal error | Android | Show error, force cleanup |

---

### 3.3 State Diagram (ASCII)

```
                         ┌──────────┐
                         │   IDLE   │
                         └────┬─────┘
                              │
                 ┌────────────┼────────────┐
                 │ outbound   │ inbound    │
                 ▼            ▼            │
         ┌─────────────┐  ┌───────────────┴──┐
         │ REQUESTING/ │  │ RINGING_INBOUND   │
         │ CONNECTING  │  │                   │
         └──────┬──────┘  └────┬──────────────┘
                │              │ answer
         SIP 180│              ▼
                ▼         ┌──────────┐
         ┌──────────────┐ │  ACTIVE  │◄──┐
         │RINGING_OUTBND│ └────┬─────┘   │ resume
         └──────┬───────┘      │         │
                │ remote answer│         │
                └──────────────┘    ┌────┴────┐
                                    │ON_HOLD/ │
                                    │REMOTE_H │
                                    └────┬────┘
                                         │ hold
                                         └─────┘


         Network Issues:              Terminal States:
         ┌──────────────┐             ┌──────────┐
    ┌───►RECONNECTING   ├─timeout────►│ DROPPED  │
    │    └──────┬───────┘             └────┬─────┘
    │           │ recover                   │
    │           ▼                           │
    │    ┌─────────────┐                   │
    └────┤   ACTIVE    ├─hangup────────────┼──────┐
         └─────────────┘                   │      │
                │ error                    │      │
                ▼                          ▼      ▼
         ┌──────────┐              ┌─────────┐ ┌────────┐
         │  FAILED  ├──────────────►  ENDED  │ │ MISSED │
         └──────────┘              └─────────┘ └────────┘
```

---

## 4. Platform State Comparison

### 4.1 State Coverage Matrix

| State | iOS SDK | Android SDK | Web | Z360 iOS Persist | Z360 Android Persist | Backend Cache |
|-------|---------|-------------|-----|------------------|---------------------|---------------|
| **IDLE** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **NEW** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **REQUESTING** | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **CONNECTING** | ✅ | ✅ | ❌ (≈requesting) | ❌ | ❌ | ❌ |
| **RINGING** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **ACTIVE** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **HELD** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **RECONNECTING** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **RENEGOTIATING** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **DROPPED** | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **DONE** | ✅ | ✅ | ❌ (≈destroy) | ❌ | ❌ | ❌ |
| **ERROR** | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| **answered (flag)** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### 4.2 Persistence Comparison

| Aspect | iOS | Android | Web | Backend |
|--------|-----|---------|-----|---------|
| **Storage** | UserDefaults | SharedPreferences | None | Redis (10min) |
| **What persists** | Active call metadata | Active call metadata | Nothing | `answered` flag only |
| **When saved** | Call becomes active | Call becomes active | Never | On answer |
| **When cleared** | Normal call end | Normal call end | N/A | Call hangup |
| **Survives crash** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes (if <10min) |
| **Survives reboot** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Orphan detection** | ✅ On app start | ✅ On app start | ❌ N/A | ❌ None |
| **Recovery action** | Report ended to CallKit | Show notification | N/A | No recovery |
| **Thread safety** | Swift Actor | Singleton + synchronized | N/A | Redis atomic ops |

---

## 5. State Transition Analysis

### 5.1 Critical State Transitions

#### Inbound Call Flow

**Push arrives → RINGING_INBOUND**

| Platform | Mechanism | Latency | File Reference |
|----------|-----------|---------|----------------|
| Android | FCM → PushSynchronizer (500ms) → IncomingCallActivity | 300-800ms | `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:688-756` |
| iOS | PushKit → PushCorrelator (500ms) → CallKit.report (5s deadline!) | 200-500ms | `ios/App/App/VoIP/Managers/PushKitManager.swift:1821+` |
| Web | SIP INVITE (direct WebSocket) → `useNotification()` | 50-200ms | `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:206` |

**RINGING_INBOUND → ACTIVE**

| Platform | Trigger | Backend Action | File Reference |
|----------|---------|---------------|----------------|
| Android | `answerDirectly()` → `telnyxViewModel.answerCall()` → SIP 200 OK | Acquire lock → answer parent → bridge → record → hangup other legs | `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:4864-4979` |
| iOS | `CXAnswerCallAction` → `Z360VoIPService.answerCall()` → SIP 200 OK | Same as Android | `ios/App/App/VoIP/Services/Z360VoIPService.swift:4484-4604` |
| Web | `activeCall.answer()` → SIP 200 OK via WebSocket | Same as Android | `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:530-547` |

**Backend State Update (CRITICAL)**:
```php
// TelnyxInboundWebhookController.php:492-498
$ringSession['answered'] = true;
$ringSession['answered_leg'] = $legCallControlId;
Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```

#### Outbound Call Flow

**User clicks dial → CONNECTING/REQUESTING**

| Platform | SDK Call | State |
|----------|----------|-------|
| Android | `telnyxViewModel.makeCall()` | NEW → CONNECTING |
| iOS | `TelnyxService.makeCall()` → CallKit.reportOutgoing | NEW → CONNECTING |
| Web | `client.newCall()` | requesting |

**CONNECTING → RINGING_OUTBOUND**

- Trigger: SIP 180 Ringing or 183 Session Progress from Telnyx
- All platforms: Telnyx SDK handles transition automatically
- User sees: "Calling..." UI, hears ringback tone

**RINGING_OUTBOUND → ACTIVE**

- Trigger: Remote party sends SIP 200 OK
- All platforms: Telnyx SDK transitions to ACTIVE
- Side effect: **Persistence starts** (Android/iOS save active call state)

### 5.2 Network Recovery States

**ACTIVE → RECONNECTING**

| Platform | Trigger | Timeout | Recovery Success | Recovery Failure |
|----------|---------|---------|------------------|------------------|
| Android | Network type change (WiFi↔Cellular) | SDK managed | → ACTIVE | → DROPPED → DONE |
| iOS | `NetworkMonitor` detects path change | 30s | → ACTIVE | → DROPPED → DONE |
| Web | Browser handles WebRTC ICE | No explicit timeout | Auto-reconnect or silent fail | Silent fail (no DROPPED state) |

**iOS NetworkMonitor** (file: `ios/App/App/VoIP/Utils/NetworkMonitor.swift:7142-7560`):
- Monitors `NWPathMonitor` for network changes
- 30-second grace period before considering network "lost"
- Notifies Z360VoIPService to trigger ICE restart

**Android**: Relies on Telnyx SDK's built-in network change detection. No custom monitor.

### 5.3 Hold States

**ACTIVE → ON_HOLD**

| Platform | Mechanism | SIP Message | File Reference |
|----------|-----------|-------------|----------------|
| Android | `telnyxViewModel.holdUnholdCurrentCall()` | re-INVITE with `a=sendonly` | `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:904-946` |
| iOS | CallKit hold action → `TelnyxService` | re-INVITE with `a=sendonly` | `ios/App/App/VoIP/Services/TelnyxService.swift` |
| Web | (Not implemented in UI) | re-INVITE with `a=sendonly` | N/A |

**UI State During Hold**:
- Android: Button background changes, status shows "On Hold" in orange
- iOS: CallKit native UI shows "Hold" state
- Web: No hold UI

---

## 6. State Persistence Deep Dive

### 6.1 What Survives Crash?

| State at Crash | iOS Recovery | Android Recovery | Web Recovery |
|---------------|--------------|------------------|--------------|
| **RINGING_INBOUND** | ❌ Lost, no recovery | ❌ Lost, no recovery | ❌ Lost |
| **CONNECTING (outbound)** | ❌ Lost | ❌ Lost | ❌ Lost |
| **ACTIVE** | ✅ Orphan detected → CallKit.reportEnded | ✅ Orphan detected → Notification shown | ❌ Lost |
| **ON_HOLD** | ✅ Treated as ACTIVE, orphan recovery | ✅ Treated as ACTIVE, orphan recovery | ❌ Lost |
| **RECONNECTING** | ❌ Lost (not persisted) | ❌ Lost | ❌ Lost |

**Android Crash Recovery Flow**:
```
1. App crashes during ACTIVE call
   ├─ CallStatePersistence has call metadata in SharedPreferences
   └─ Telnyx SDK foreground service may still be running

2. User restarts app
   ├─ MainActivity.onCreate()
   └─ CrashRecoveryManager.checkAndRecoverFromCrash()

3. Orphan call detected
   ├─ CallStatePersistence.checkForAbandonedCall() returns state
   ├─ CrashRecoveryManager.cleanupOrphanedResources()
   │   ├─ Stop CallForegroundService
   │   └─ Cancel lingering notifications
   └─ Show recovery notification: "Your call with [Name] was disconnected"

4. Cleanup
   └─ CallStatePersistence.clearActiveCall()
```

**File References**:
- Detection: `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt:162-179`
- Recovery: `android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt:80-105`
- Trigger: `android/app/src/main/java/com/z360/app/MainActivity.kt` (onCreate)

**iOS Crash Recovery Flow**:
```
1. App crashes during ACTIVE call
   ├─ PersistableCallState in UserDefaults has call metadata
   └─ CallKit may still show call as active

2. User restarts app (or app auto-restarts)
   ├─ AppDelegate.didFinishLaunchingWithOptions
   └─ VoipStore.shared.recoverOrphanCallState()

3. Orphan call detected
   ├─ VoipStore reads PersistableCallState from UserDefaults
   ├─ Report ended to CallKit:
   │   CallKitManager.reportCallEnded(uuid, reason: .failed)
   └─ Clear persistence

4. User sees CallKit end call (no explicit notification)
```

**File Reference**: `ios/App/App/VoIP/Services/VoipStore.swift:170-213`

### 6.2 What Survives Device Reboot?

| Data | iOS | Android | Backend |
|------|-----|---------|---------|
| **Active call state** | ✅ UserDefaults survives | ✅ SharedPreferences survives | ❌ Redis is flushed |
| **SIP credentials** | ✅ Keychain survives | ⚠️ Plain SharedPrefs survives (SDK limitation) | ❌ Not stored on device |
| **Org context** | ✅ UserDefaults survives | ✅ SharedPreferences survives | ❌ Session lost |

**Post-Reboot Behavior**:
- iOS: Orphan recovery runs, reports ended calls to CallKit
- Android: Orphan recovery runs, shows notification
- Web: No persistence, fresh start

---

## 7. Gap Analysis

### 7.1 Missing States

| State | Why Needed | Current Workaround |
|-------|-----------|-------------------|
| **DISCONNECTING** | Graceful hangup in progress, prevent duplicate hangup | None — multiple hangup calls are no-ops |
| **FAILED** | Distinguish setup failure from normal end | Android has ERROR, iOS/Web lump into DONE/destroy |
| **REMOTE_HOLD** | Show "other party put you on hold" | Not tracked — user hears silence |

### 7.2 State Synchronization Gaps

**Cross-Device State Sync**:
- ❌ No mechanism for devices to share state
- ❌ Device A answers → Device B shows "ringing" until SIP BYE + push arrive (100ms-30s delay)
- ❌ No shared "call in progress" indicator across devices

**Backend ↔ Client Sync**:
- ❌ Backend only knows `answered: true/false`, not full state
- ❌ Backend can't query "is this user on an active call?" (no API endpoint)
- ❌ Backend can't proactively end a call on client (must send push + hope client processes it)

**Cross-Org State**:
- ❌ Org switch during call → state on old org not transferred to new org
- ❌ Call metadata (duration, quality) not migrated during org switch

### 7.3 Illegal State Transitions

**Not prevented by any platform**:
- HELD → RINGING (if remote sends re-INVITE while on hold)
- RENEGOTIATING → DROPPED (Android-specific WebRTC failure)
- DONE → RECONNECTING (if late SIP messages arrive)

**Consequences**: UI shows confusing states like "On Hold" for an ended call, or ringtone plays during active call.

### 7.4 Persistence Gaps

| Scenario | iOS | Android | Web | Impact |
|----------|-----|---------|-----|--------|
| **Crash during RINGING** | ❌ Lost | ❌ Lost | ❌ Lost | Caller thinks user declined, user has no record |
| **Network loss during ACTIVE** | ⚠️ May recover if orphan detection runs | ⚠️ May recover if orphan detection runs | ❌ Lost | User confused why call disappeared |
| **Crash during RECONNECTING** | ❌ Lost | ❌ Lost | ❌ Lost | No record of attempted call |
| **Backend cache expires (>10min)** | ✅ Client state persists | ✅ Client state persists | ⚠️ Lost on tab close | Backend can't hang up orphan legs |

---

## 8. Proposed Canonical State Machine

### 8.1 Design Principles

1. **Single source of truth**: Telnyx SDK state is authoritative for client state
2. **Backend tracks lifecycle**: Backend cache includes full state, not just `answered` flag
3. **Persistent state for all non-terminal states**: RINGING, CONNECTING, ACTIVE all persisted
4. **Cross-platform state sync**: Devices broadcast state changes via Reverb
5. **Illegal transition prevention**: State machine enforces valid transitions

### 8.2 Enhanced Backend Cache

**Current**:
```php
'answered' => false,           // Binary flag
'leg_ids' => [],
'answered_leg' => null
```

**Proposed**:
```php
'state' => 'ringing',          // ringing | answered | active | ended
'answered' => false,
'leg_ids' => [],
'answered_leg' => null,
'bridge_started_at' => null,   // Timestamp for recording duration
'bridge_failed' => false,      // Track bridge failures
'all_legs_failed' => false     // Track if all legs failed (route to voicemail)
```

### 8.3 Cross-Platform State Broadcast

**Mechanism**: Reverb broadcast on every state transition

**Payload**:
```json
{
  "call_session_id": "...",
  "device_id": "...",
  "state": "active",
  "timestamp": 1738972800,
  "organization_id": "..."
}
```

**Consumers**:
- Other devices: Update UI to show "Call active on [Device Name]"
- Backend: Track device state for analytics
- Web dashboard: Real-time call status

### 8.4 Persistent State for RINGING

**Why**: Crash during incoming call should allow user to see "Missed call" on restart, not silent loss.

**Implementation**:

**iOS**:
```swift
// Save on PushKit delivery (before CallKit report)
await VoipStore.shared.saveIncomingCallState(
    callId: uuid,
    callerNumber: number,
    callerName: name,
    timestamp: Date()
)

// Clear on answer or decline
await VoipStore.shared.clearIncomingCallState(uuid)

// Detect on restart
let missedCalls = await VoipStore.shared.detectMissedCalls()
// Show notification: "Missed call from [Name]"
```

**Android**:
```kotlin
// Save on push receive (before IncomingCallActivity)
CallStatePersistence.getInstance(context).saveIncomingCall(
    callId = callId,
    callerNumber = number,
    callerName = name,
    timestamp = System.currentTimeMillis()
)

// Clear on answer or decline
CallStatePersistence.getInstance(context).clearIncomingCall(callId)

// Detect on restart
val missedCalls = CallStatePersistence.getInstance(context).detectMissedCalls()
// Show notification: "Missed call from [Name]"
```

---

## 9. Implementation Roadmap

### Phase 1: Unify State Tracking (Backend)

**Tasks**:
- [ ] Add `state` field to `simring:*` cache
- [ ] Track state transitions: `ringing → answered → bridged → ended`
- [ ] Add API endpoint: `GET /api/voip/call-status/{call_session_id}`
- [ ] Broadcast state changes via Reverb to all user devices

**Files**:
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php`
- New: `app/Http/Controllers/Api/VoipCallStatusController.php`

### Phase 2: Persist RINGING State (Mobile)

**Tasks**:
- [ ] iOS: Add `saveIncomingCallState()` to VoipStore
- [ ] iOS: Detect missed calls on app start, show notifications
- [ ] Android: Add `saveIncomingCall()` to CallStatePersistence
- [ ] Android: Detect missed calls on app start, show notifications

**Files**:
- `ios/App/App/VoIP/Services/VoipStore.swift`
- `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt`
- `android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt`

### Phase 3: Cross-Device State Sync (All Platforms)

**Tasks**:
- [ ] Backend broadcasts state changes on every transition
- [ ] iOS/Android/Web listen to Reverb `.call_state_changed` event
- [ ] Update UI: Show "Call active on [Device]" banner when another device has active call
- [ ] Prevent duplicate answer: If state is already `answered`, decline new answer attempts

**Files**:
- Backend: New event `CallStateChangedNotification`
- iOS: `Z360VoIPService.swift` — add Reverb listener (if feasible, or poll API)
- Android: `Z360FirebaseMessagingService.kt` — handle new push type `call_state_changed`
- Web: `context.tsx` — add `.call_state_changed` Echo listener

### Phase 4: State Transition Validation (SDK Wrappers)

**Tasks**:
- [ ] Create state machine wrapper around Telnyx SDK
- [ ] Prevent illegal transitions (e.g., HELD → RINGING)
- [ ] Log all state transitions for debugging
- [ ] Expose unified state machine to UI layer

**New Files**:
- `ios/App/App/VoIP/Utils/CallStateMachine.swift`
- `android/app/src/main/java/com/z360/app/voip/CallStateMachine.kt`
- `resources/js/lib/call-state-machine.ts`

---

## 10. Testing Plan

### 10.1 State Persistence Tests

| Test | Setup | Steps | Expected |
|------|-------|-------|----------|
| **T1: Crash during ACTIVE** | Device with active call | Kill app → restart | Orphan detected, notification shown, CallKit reports ended |
| **T2: Crash during RINGING** | Device with incoming call | Kill app → restart | Missed call detected, notification shown |
| **T3: Crash during CONNECTING** | Outbound call connecting | Kill app → restart | No orphan (CONNECTING not persisted yet) |
| **T4: Device reboot during ACTIVE** | Active call, reboot device | Reboot → start app | Orphan detected after reboot |

### 10.2 Cross-Platform State Sync Tests

| Test | Setup | Steps | Expected |
|------|-------|-------|----------|
| **T5: Answer on Device A** | 2 devices ringing | Answer on A | Device B shows "Answered on [A]", stops ringing within 500ms |
| **T6: Hold on Device A** | Active call on A | Press hold on A | Backend + other devices (if any) aware of hold state |
| **T7: Org switch during call** | Active call on Org A | Switch to Org B | Call continues on A, state preserved, B shows "Call on [A]" |

### 10.3 Illegal Transition Tests

| Test | Setup | Steps | Expected |
|------|-------|-------|----------|
| **T8: Hold during RINGING** | Incoming call ringing | Press hold | Rejected, error message, state stays RINGING |
| **T9: Answer during ACTIVE** | Already active call | Second call arrives, answer | State machine rejects, shows "Already on a call" |

---

## 11. File Index

### Z360 Android
| File | Purpose | Key States |
|------|---------|----------|
| `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt` | Persist active call for crash recovery | PersistedCallState (ACTIVE only) |
| `android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt` | Detect and recover orphan calls | N/A (orchestrator) |
| `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt` | Active call UI | Uses Telnyx SDK CallState |
| `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt` | Incoming call UI | RINGING (not persisted) |
| `android/telnyx_common/src/main/java/com/telnyx/webrtc/common/TelnyxViewModel.kt` | Telnyx SDK wrapper | Observes `callStateFlow` |

### Z360 iOS
| File | Purpose | Key States |
|------|---------|----------|
| `ios/App/App/VoIP/Models/VoIPModels.swift` | Data models | PersistableCallState (ACTIVE only) |
| `ios/App/App/VoIP/Services/VoipStore.swift` | Thread-safe persistence | Actor-isolated state management |
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` | Central VoIP orchestrator | Reacts to Telnyx SDK state changes |
| `ios/App/App/VoIP/Utils/NetworkMonitor.swift` | Network change detection | Triggers RECONNECTING |
| `ios/App/App/VoIP/Utils/CallTimerManager.swift` | Call duration tracking | Tied to ACTIVE state |

### Z360 Web
| File | Purpose | Key States |
|------|---------|----------|
| `resources/js/components/identifier-details-sidebar/dialpad/context.tsx` | VoIP state management | requesting, ringing, active, destroy |

### Z360 Backend
| File | Purpose | Key States |
|------|---------|----------|
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | Webhook handler + sim-ring | `answered: false → true` |
| `app/Services/CPaaSService.php` | Telnyx API wrapper | N/A |

### Telnyx SDKs
| SDK | State Model | Source |
|-----|-------------|--------|
| iOS SDK | `CallState` enum (9 states) | `.scratchpad/packs/telnyx-ios-sdk.xml` |
| Android SDK | `CallState` sealed class (10 states) | `.scratchpad/packs/telnyx-android-sdk.xml` |
| Web SDK | `activeCall.state` (4 states) | `@telnyx/react-client` |

---

## 12. Conclusion

Z360's call state management is **functionally distributed** with **no canonical state machine**. Each layer tracks what it needs:
- **Telnyx SDKs** provide rich state machines (9-10 states) for client call lifecycle
- **Z360 mobile apps** persist only ACTIVE state for crash recovery
- **Backend** tracks only `answered` flag for simultaneous ring coordination
- **Web** has minimal state tracking (4 states)

**Strengths**:
- ✅ Each layer is optimized for its specific concerns
- ✅ Crash recovery works well for active calls
- ✅ Simultaneous ring coordination is robust (Redis lock)

**Critical Weaknesses**:
- ❌ No cross-platform state synchronization
- ❌ RINGING state not persisted → missed calls invisible after crash
- ❌ Backend has incomplete view of call lifecycle
- ❌ No enforcement of legal state transitions

**Recommended Priority**:
1. **Phase 1** (P0): Backend state tracking + API endpoint
2. **Phase 2** (P1): Persist RINGING state for missed call detection
3. **Phase 3** (P2): Cross-device state sync via Reverb
4. **Phase 4** (P3): State transition validation wrappers

---

*Document generated: 2026-02-08*
*Research scope: 4 platforms, 3 SDKs, 15+ source files*
*Total states identified: 14 canonical, 9 SDK iOS, 10 SDK Android, 4 Web*
