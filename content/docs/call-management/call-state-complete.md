---
title: Call State Complete
---

# Call State Management: Complete Unified Reference

> **Session 11 Synthesis** | Date: 2026-02-08
> **Sources**: call-state-machine.md (state-machine-designer) + call-state-synchronization.md (sync-analyst)
> **Scope**: Canonical call state machine, cross-platform synchronization, analytics, call history

---

## Executive Summary

Z360's call state management is **distributed across four independent layers with no unified state machine**. Each platform tracks state differently, devices do not communicate state to each other, and the backend maintains only minimal coordination state. This analysis defines the **canonical 14-state model**, maps each platform's actual implementation against it, documents the **three-channel dismissal system** and its failure modes, and proposes a phased hardening plan.

### Architecture at a Glance

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        STATE MANAGEMENT LAYERS                             │
│                                                                            │
│  Layer 1: Telnyx SDK State (Source of Truth for Client Call Lifecycle)     │
│  ├─ iOS SDK:     9 states  (NEW→CONNECTING→RINGING→ACTIVE→HELD→DONE...)  │
│  ├─ Android SDK: 10 states (adds ERROR, RENEGOTIATING)                    │
│  └─ Web SDK:     4 states  (requesting→ringing→active→destroy)           │
│                                                                            │
│  Layer 2: Z360 Platform Extensions (Crash Recovery)                       │
│  ├─ iOS:     PersistableCallState in UserDefaults (ACTIVE only)          │
│  ├─ Android: CallStatePersistence in SharedPreferences (ACTIVE only)     │
│  └─ Web:     None (all state lost on tab close)                          │
│                                                                            │
│  Layer 3: Backend Coordination (Redis Cache)                              │
│  └─ simring:{parent} cache: answered flag, leg_ids, 10min TTL           │
│                                                                            │
│  Layer 4: Persistent Call History (PostgreSQL)                            │
│  └─ Message/Conversation models: duration, recording, participants       │
└───────────────────────────────────────────────────────────────────────────┘
```

### Critical Findings

| Finding | Impact | Severity |
|---------|--------|----------|
| **No unified state model** — iOS has 9 states, Android 10, Web 4, Backend binary flag | Cross-platform debugging impossible; state divergences cause bugs | Critical |
| **No cross-device state sync** — devices don't share state with each other | "Kept ringing after answer" production bug | Critical |
| **Three-channel dismissal can all fail** — SIP BYE + Push + Broadcast all unreliable | Devices ring indefinitely after another device answers | Critical |
| **Backend stateless after ring phase** — no "is user on a call?" query | No collision detection; web UI blind to native calls | High |
| **RINGING state not persisted** — crash during incoming call = invisible missed call | Poor user experience; no record of missed calls after crash | High |
| **Analytics siloed per platform** — no unified call quality dashboard | Cannot correlate quality issues across platforms | Medium |

---

## 1. Canonical Call State Machine

### 1.1 The 14-State Model

This model encompasses every state observed across all platforms:

```
enum UnifiedCallState {
    // Pre-connection
    IDLE,                // No call exists
    REQUESTING,          // Outbound call initiated (web terminology)
    CONNECTING,          // SIP INVITE sent, awaiting provisional response

    // Ringing
    RINGING_INBOUND,     // Incoming call, device is ringing
    RINGING_OUTBOUND,    // Outbound call, waiting for remote answer

    // Connected
    ACTIVE,              // Call connected, audio flowing
    ON_HOLD,             // Local user put call on hold
    REMOTE_HOLD,         // Remote party put call on hold

    // Network recovery
    RECONNECTING,        // Network issue, attempting ICE restart
    RENEGOTIATING,       // Media renegotiation (Android-specific)

    // Terminal
    DISCONNECTING,       // Hangup initiated, awaiting cleanup
    ENDED,               // Call completed normally
    FAILED,              // Call setup or connection failed
    MISSED,              // Inbound call not answered
    DROPPED,             // Call dropped due to network loss
}
```

### 1.2 State Diagram

```
                              ┌──────────┐
                              │   IDLE   │
                              └────┬─────┘
                                   │
                      ┌────────────┼────────────┐
                      │ outbound   │ inbound    │
                      ▼            │            ▼
              ┌─────────────┐     │    ┌───────────────────┐
              │ REQUESTING/ │     │    │ RINGING_INBOUND   │
              │ CONNECTING  │     │    └────┬──────┬───────┘
              └──────┬──────┘     │         │      │
                     │            │    answer│   timeout/decline
              SIP 180│            │         │      │
                     ▼            │         ▼      ▼
              ┌──────────────┐    │    ┌────────┐  ┌────────┐
              │RINGING_OUTBND│    │    │ ACTIVE │  │MISSED/ │
              └──────┬───────┘    │    └───┬────┘  │ ENDED  │
                     │            │        │       └────────┘
              remote │            │        │
              answer │            │   ┌────┼────────────┐
                     └────────────┘   │    │            │
                                      │    ▼            ▼
                                      │ ┌────────┐  ┌──────────────┐
                                 hold─┤ │ON_HOLD │  │ REMOTE_HOLD  │
                                      │ └───┬────┘  └──────┬───────┘
                                      │     │ resume       │ remote resume
                                      │     └──────────────┘
                                      │
                       Network Issues:│              Terminal States:
                      ┌───────────────┤             ┌──────────┐
                 ┌───►│RECONNECTING   ├──timeout───►│ DROPPED  │
                 │    └──────┬────────┘             └────┬─────┘
                 │           │ recover                    │
                 │           ▼                            ▼
                 │    ┌──────────┐     hangup      ┌─────────┐
                 └────┤  ACTIVE  ├────────────────►│  ENDED  │
                      └──────────┘     error       └─────────┘
                           │                            ▲
                           ▼                            │
                      ┌──────────┐                      │
                      │  FAILED  ├──────────────────────┘
                      └──────────┘
```

### 1.3 Complete Transition Table

| From | To | Trigger | Platform Support | Side Effects |
|------|-----|---------|-----------------|--------------|
| IDLE | REQUESTING | User initiates outbound (web) | Web | SIP INVITE via WebSocket |
| IDLE | CONNECTING | User initiates outbound (mobile) | iOS, Android | SIP INVITE via SDK |
| IDLE | RINGING_INBOUND | Push + SIP INVITE received | All | Show call UI, play ringtone |
| REQUESTING | RINGING_OUTBOUND | SIP 180/183 received | Web | Show "calling..." UI |
| CONNECTING | RINGING_OUTBOUND | SIP 180/183 received | iOS, Android | Show "calling..." UI |
| CONNECTING | FAILED | SIP 4xx/5xx error | All | Show error, cleanup |
| RINGING_INBOUND | ACTIVE | User answers (SIP 200 OK) | All | Backend bridges, audio starts, dismiss other devices |
| RINGING_INBOUND | MISSED | 30s timeout or caller hangup | All | Backend routes to voicemail |
| RINGING_INBOUND | ENDED | User declines | All | Send SIP 486/603 |
| RINGING_OUTBOUND | ACTIVE | Remote answers (SIP 200 OK) | All | Audio starts, persist call state |
| RINGING_OUTBOUND | FAILED | Remote declines (SIP 486/603) | All | Show "call declined" |
| RINGING_OUTBOUND | MISSED | Timeout or remote no answer | All | Show "no answer" |
| ACTIVE | ON_HOLD | User presses hold | iOS, Android | SIP re-INVITE (sendonly) |
| ON_HOLD | ACTIVE | User resumes | iOS, Android | SIP re-INVITE (sendrecv) |
| ACTIVE | REMOTE_HOLD | Remote sends hold re-INVITE | iOS, Android | Show "on hold" UI |
| ACTIVE | RECONNECTING | Network change detected | iOS, Android | ICE restart attempt |
| ACTIVE | RENEGOTIATING | Media update required | Android only | SIP re-INVITE |
| ACTIVE | ENDED | User or remote hangs up | All | SIP BYE, cleanup, clear persistence |
| ACTIVE | DROPPED | Network lost completely | iOS, Android | Show error, attempt recovery |
| RECONNECTING | ACTIVE | Network restored, ICE succeeds | iOS, Android | Resume audio |
| RECONNECTING | DROPPED | Recovery timeout exceeded | iOS, Android | Give up, end call |
| RENEGOTIATING | ACTIVE | Media update complete | Android | Resume normal state |
| DROPPED | ENDED | Cleanup after drop | iOS, Android | Clear persistence |
| (any) | FAILED | SDK internal error | Android | Force cleanup |

---

## 2. Platform State Comparison

### 2.1 Telnyx SDK State Models

**iOS SDK** (`CallState` enum — 9 states):
```swift
public enum CallState: Equatable {
    case NEW, CONNECTING, RINGING, ACTIVE, HELD
    case DONE(reason: CallTerminationReason? = nil)
    case RECONNECTING(reason: Reason)
    case DROPPED(reason: Reason)
}
```
Source: `.scratchpad/packs/telnyx-ios-sdk.xml`

**Android SDK** (`CallState` sealed class — 10 states):
```kotlin
sealed class CallState {
    object NEW, CONNECTING, RINGING, ACTIVE, RENEGOTIATING, HELD, ERROR
    data class DONE(val reason: CallTerminationReason? = null)
    data class DROPPED(val reason: CallNetworkChangeReason)
    data class RECONNECTING(val reason: CallNetworkChangeReason)
}
```
Source: `.scratchpad/packs/telnyx-android-sdk.xml`

**Web SDK** (`activeCall.state` — 4 states):
```typescript
type CallState = 'requesting' | 'ringing' | 'active' | 'destroy';
```
Source: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:206`

### 2.2 State Coverage Matrix

| Canonical State | iOS SDK | Android SDK | Web SDK | Z360 iOS Persist | Z360 Android Persist | Backend Cache |
|----------------|---------|-------------|---------|-----------------|---------------------|--------------|
| IDLE | - | - | - | - | - | - |
| REQUESTING | - | - | `requesting` | - | - | - |
| CONNECTING | `CONNECTING` | `CONNECTING` | - | - | - | - |
| RINGING_INBOUND | `RINGING` | `RINGING` | `ringing` | - | - | `answered:false` |
| RINGING_OUTBOUND | `RINGING` | `RINGING` | `ringing` | - | - | - |
| ACTIVE | `ACTIVE` | `ACTIVE` | `active` | **Persisted** | **Persisted** | `answered:true` |
| ON_HOLD | `HELD` | `HELD` | - | - | - | - |
| REMOTE_HOLD | - | - | - | - | - | - |
| RECONNECTING | `RECONNECTING` | `RECONNECTING` | - | - | - | - |
| RENEGOTIATING | - | `RENEGOTIATING` | - | - | - | - |
| DISCONNECTING | - | - | - | - | - | - |
| ENDED | `DONE` | `DONE` | `destroy` | Cleared | Cleared | Cache deleted |
| FAILED | - | `ERROR` | - | - | - | - |
| MISSED | - | - | - | - | - | - |
| DROPPED | `DROPPED` | `DROPPED` | - | - | - | - |

### 2.3 Key Divergences

1. **Android has ERROR and RENEGOTIATING** — iOS and Web do not track these states
2. **Web has no network recovery** — no RECONNECTING, DROPPED, or HELD states
3. **iOS and Android don't distinguish RINGING_INBOUND from RINGING_OUTBOUND** — both are `RINGING`
4. **No platform tracks REMOTE_HOLD** — user hears silence with no UI indication
5. **No platform tracks DISCONNECTING** — hangup is fire-and-forget
6. **No platform tracks MISSED** — inferred from call log, not real-time state

---

## 3. State Persistence and Crash Recovery

### 3.1 What Survives What

| Scenario | iOS | Android | Web | Backend |
|----------|-----|---------|-----|---------|
| **App crash during ACTIVE** | UserDefaults survives → orphan recovery | SharedPreferences survives → orphan recovery | Lost | Redis survives (if <10min) |
| **App crash during RINGING** | Lost — no persistence | Lost — no persistence | Lost | Redis has `answered:false` |
| **Device reboot during ACTIVE** | UserDefaults survives | SharedPreferences survives | N/A | Redis flushed |
| **Tab close (web)** | N/A | N/A | All state lost | N/A |

### 3.2 Z360 iOS Crash Recovery

**Storage**: `PersistableCallState` in UserDefaults (actor-isolated via `VoipStore`)

```swift
struct PersistableCallState: Codable, Sendable {
    let callId: UUID
    let direction: CallDirection   // .incoming or .outgoing
    let callerNumber: String
    let callerName: String?
    let avatarUrl: String?
    let organizationId: String?
    let startTime: Date
}
```

**Recovery flow**:
1. App crashes during ACTIVE call
2. `PersistableCallState` persists in UserDefaults
3. App restarts → `VoipStore.recoverOrphanCallState()`
4. Reports ended to CallKit → user sees call ended
5. Clears persistence

**Files**: `ios/App/App/VoIP/Models/VoIPModels.swift:118-161`, `ios/App/App/VoIP/Services/VoipStore.swift:170-213`

### 3.3 Z360 Android Crash Recovery

**Storage**: `PersistedCallState` in SharedPreferences (singleton)

```kotlin
data class PersistedCallState(
    val callId: String,
    val callerNumber: String,
    val callerName: String,
    val startTime: Long,
    val callControlId: String?,
    val isOutgoing: Boolean
)
```

**Recovery flow**:
1. App crashes during ACTIVE call
2. `CallStatePersistence` retains state in SharedPreferences
3. App restarts → `CrashRecoveryManager.checkAndRecoverFromCrash()`
4. Stops `CallForegroundService`, cancels notifications
5. Shows recovery notification: "Your call with [Name] was disconnected"

**Files**: `android/app/src/main/java/com/z360/app/voip/CallStatePersistence.kt:49-56`, `android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt:80-105`

### 3.4 Persistence Gap: RINGING Not Saved

**Problem**: If the app crashes while ringing (before the user answers), no record exists. The user has no way to know they missed a call (the backend may route to voicemail, but the device shows nothing on restart).

**Target**: Persist RINGING_INBOUND state on push delivery, clear on answer/decline/timeout, detect as missed call on restart.

---

## 4. Cross-Platform State Synchronization

### 4.1 Architecture: Backend-Orchestrated, No Device-to-Device Communication

```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│    Android     │     │      iOS       │     │      Web       │
│                │     │                │     │                │
│ SDK State      │     │ SDK State      │     │ SDK State      │
│ (10 states)    │     │ (9 states)     │     │ (4 states)     │
│                │     │                │     │                │
│ ▲ SIP BYE     │     │ ▲ SIP BYE     │     │ ▲ SIP BYE     │
│ ▲ FCM Push    │     │ ▲ APNs Push   │     │ ▲ Reverb WS   │
└────────┬───────┘     └────────┬───────┘     └────────┬───────┘
         │                      │                      │
         │   NO DIRECT COMMUNICATION BETWEEN DEVICES   │
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │   LARAVEL BACKEND     │
                    │                       │
                    │ Redis: simring cache  │
                    │ (10min TTL, ring only)│
                    │                       │
                    │ PostgreSQL: Messages  │
                    │ (permanent call log)  │
                    └───────────────────────┘
```

**Key insight**: Devices never send state to each other. All coordination flows through the backend via three independent channels.

### 4.2 Three-Channel Dismissal System

When one device answers, three parallel channels notify all other devices:

| # | Channel | Mechanism | Target | Reliability | Latency |
|---|---------|-----------|--------|-------------|---------|
| 1 | **SIP BYE** | Backend calls `Call::hangup()` per leg → Telnyx sends BYE | All devices with SIP legs | High (if SDK connected) | ~200-500ms |
| 2 | **Reverb WebSocket** | `CallEndedNotification` event broadcast | Web sessions (Echo listener) | High (if tab active) | ~50-200ms |
| 3 | **FCM/APNs Push** | `PushNotificationService::sendCallEndedPush()` | Mobile devices | Medium (Doze delays up to 15min) | 100ms-30s |

**Source**: `TelnyxInboundWebhookController.php` — `onCallAnswered()` steps 5-8

### 4.3 Per-Platform Dismissal Handling

**Android**:
- SIP BYE → `TelnyxSocketEvent.OnCallEnded` → `ActiveCallActivity.cleanup()` + `finish()`
- FCM → `call_ended` type → `ACTION_CALL_ENDED` broadcast → `IncomingCallActivity.finish()`
- **Gap**: Broadcast receiver registered in `onStart()`, unregistered in `onStop()` — if Activity backgrounded, broadcast has no handler
- **Files**: `Z360FirebaseMessagingService.kt:727-734`, `IncomingCallActivity.kt:4804-4822`

**iOS**:
- SIP BYE → `onRemoteCallEnded()` → `CallKit.reportCallEnded(.remoteEnded)`
- APNs → `call_ended` push → find CallKit UUID → `reportCallEnded(.answeredElsewhere)`
- **PushKit quirk**: Must report every VoIP push to CallKit. If `call_ended` arrives with no matching call, creates fake call + immediately ends it.
- **Files**: `Z360VoIPService.swift:5821-5886`, `PushKitManager.swift:1041-1064`

**Web**:
- SIP BYE → SDK handles via WebSocket (state → `destroy`)
- Reverb → `.call_ended` Echo listener → `activeCall.hangup()` if ringing/requesting
- **Gap**: Does NOT listen for `.incoming_call` broadcast — relies entirely on SIP INVITE
- **Files**: `dialpad/context.tsx:675-694`

### 4.4 Three-Channel Failure Cascade (Known Production Bug)

All three channels can fail simultaneously:

```
Scenario: Device A answers. Device B should stop ringing.

Channel 1 (SIP BYE):    FAILS if leg_ids[] empty (webhook race — RC-6)
                         or SDK disconnected/stale
Channel 2 (FCM Push):   DELAYED up to 15min by Android Doze mode
Channel 3 (Broadcast):  FAILS if IncomingCallActivity in onStop() (backgrounded)

Result: Device B rings until SIP leg timeout (30 seconds)
```

**Root cause**: `leg_ids` starts empty in cache, populated asynchronously by `call.initiated` webhooks. If device answers before all webhooks arrive, the hangup loop has incomplete data.

---

## 5. Backend State Tracking

### 5.1 Redis Cache (Ephemeral — Ring Phase Only)

```php
// Key: simring:{parent_call_control_id}
[
    'parent_call_control_id' => 'v3:xxx',
    'user_id' => 123,
    'message_id' => 456,
    'answered' => false,           // → true on first answer
    'answered_leg' => null,        // → 'v3:leg-2'
    'leg_ids' => [],               // Populated async by call.initiated webhooks
]
// TTL: 10 minutes (NOT refreshed during call)

// Lock: simring:{parent_call_control_id}:lock
// TTL: 10 seconds (Laravel atomic lock)
```

**Critical**: Cache expires while calls are still active (>10min). Hangup handlers fall back to `client_state` routing.

**Source**: `TelnyxInboundWebhookController.php:377-383`

### 5.2 PostgreSQL (Persistent — Call History)

**messages table** (call events):
```sql
metadata (jsonb):
├── call_session_id (UUID)         -- Unique per call
├── parent_call_control_id (str)   -- Telnyx parent leg ID
├── original_from (str)            -- PSTN caller number
├── received_by (int)              -- user_id of recipient
├── recording_started_at (ISO8601)
├── recording_ended_at (ISO8601)
├── recording_urls ({wav: "url"})
├── is_agent (boolean)             -- AI call vs human (billing)
└── call_quality (NOT YET IMPLEMENTED)
```

**conversations table** (call context):
```sql
identifier_id   → Identifier (phone/email/contact resolution)
channel_id      → AuthenticatedPhoneNumber (Z360 number)
organization_id → Organizations (tenant isolation)
```

**Ledger table** (billing):
```php
Ledger::create([
    'unit' => $isAgent ? LedgerUnit::AI_CALL_MINUTE : LedgerUnit::SIMPLE_CALL_MINUTE,
    'quantity' => $durationMinutes,
    'meta' => ['message_id' => ..., 'call_session_id' => ...],
]);
```

**Source**: `TelnyxCallController.php:3609-3620`

### 5.3 No Active Call Tracking

**Finding**: The backend has NO query for "is user X currently on a call?"

- Redis `simring:*` cache only covers the ring phase (and expires after 10min)
- No `active_call:{userId}` cache key exists
- No database table tracks active calls

**Impact**:
- Web UI blind to native calls (no "in call" indicator)
- No collision detection (user can try to make second call while on first)
- Cross-platform call state invisible

---

## 6. Web UI State During Native Calls

### 6.1 Native Call State Tracking

The web UI does track native call state via Capacitor bridge listeners:

```typescript
const [nativeCallState, setNativeCallState] = useState<{
    callId: string;
    status: 'new' | 'connecting' | 'ringing' | 'active' | 'held' | 'done';
    isMuted: boolean;
    elapsedSeconds: number;
} | null>(null);

// Listeners: callStarted, callRinging, callConnected, callEnded
```

**Source**: `dialpad/context.tsx:559-620`

### 6.2 Gap: State Tracked But Not Rendered

The `nativeCallState` variable is tracked but **not rendered anywhere in the UI**. When a user answers on iOS/Android, the web UI shows no "in call" indicator, no active call badge, and no collision prevention.

---

## 7. Analytics and Logging Inventory

### 7.1 Per-Platform Analytics

| Platform | Tool | Events Tracked | Destination | Correlation Key |
|----------|------|---------------|-------------|-----------------|
| **Android** | `VoipAnalytics.kt` (847 lines) | Push sync, call lifecycle, SDK state, errors | Firebase Analytics | `callId` |
| **iOS** | `CallQualityMonitor.swift` (286 lines) | MOS, jitter, RTT, packet loss (5s intervals) | Local state only | - |
| **Backend** | Message metadata | Duration, recording URL, participants, billing | PostgreSQL | `call_session_id` |

### 7.2 Android Analytics Events

```kotlin
VoipAnalytics.logZ360PushReceived(callId, callerNumber, arrivalTime)
VoipAnalytics.logTelnyxPushReceived(callId, callerNumber, arrivalTime)
VoipAnalytics.logPushSyncCompleted(callId, syncType, delay, timeout)
VoipAnalytics.logCallStarted(callId, direction)
VoipAnalytics.logCallAnswered(callId, answerDelay)
VoipAnalytics.logCallEnded(callId, duration, endReason)
VoipAnalytics.logSdkConnected()
VoipAnalytics.logSdkDisconnected(reason)
VoipAnalytics.logError(component, message, metadata)
```

**Source**: `.claude/skills/voip-android/references/files.md` lines 8-111

### 7.3 iOS Call Quality Metrics

```swift
// 5-second refresh, real-time during call
MOS thresholds: Excellent (4.3-5.0), Good (4.0-4.3), Fair (3.6-4.0), Poor (3.1-3.6), Bad (<3.1)
```

**Source**: `CallQualityMonitor.swift` (286 lines), `Z360VoIPService.swift:3404-3414`

### 7.4 Unified Analytics Gap

- **iOS MOS/jitter not sent to backend** — local-only metrics
- **Android callId ≠ backend call_session_id** — no correlation
- **No single dashboard** for cross-platform call quality
- **No call_session_id in Android analytics** — Firebase events don't include the UUID used by backend

---

## 8. Combined Gap Analysis

### 8.1 Critical (P0)

| # | Gap | Root Cause | Impact | Recommendation |
|---|-----|-----------|--------|----------------|
| **G-01** | No unified state model | 4 independent implementations | Cross-platform debugging impossible | Define canonical 14-state model; wrap each SDK |
| **G-02** | Three-channel dismissal all fail | SIP BYE: empty leg_ids (webhook race). FCM: Doze mode. Broadcast: Activity backgrounded | "Kept ringing after answer" production bug | Add 4th channel: client-side status polling (3s interval) |
| **G-03** | Caller hangup doesn't cancel SIP legs | `originator_cancel` handler returns before checking simring cache | Devices ring 30s after caller disconnects | Look up `simring:*` cache in parent hangup handler, cancel all legs |
| **G-04** | No bridge failure recovery | Single try block for bridge + cleanup | Both parties hear silence, other devices keep ringing | Separate try blocks; bridge retry; compensating cleanup |

### 8.2 High (P1)

| # | Gap | Root Cause | Impact | Recommendation |
|---|-----|-----------|--------|----------------|
| **G-05** | No active call tracking on backend | Redis cache is ring-phase only; no `active_call:{userId}` key | No collision detection; web UI blind to native calls | Maintain `active_call:{userId}` Redis key (2h TTL) |
| **G-06** | Web UI has no native call indicator | `nativeCallState` tracked but not rendered | User sees no indication of active native call | Render "In Call (Native)" badge in dialpad UI |
| **G-07** | RINGING state not persisted | CallStatePersistence/PersistableCallState only save ACTIVE | Crash during ring = invisible missed call | Persist on push delivery; detect as missed on restart |
| **G-08** | Cache expires during long calls | 10min TTL not refreshed | Hangup handlers can't find cache for calls >10min | Extend TTL to 2h or refresh on bridge |
| **G-09** | leg_ids populated async (webhook race) | `call.initiated` webhooks arrive after `call.answered` | Hangup loop has incomplete data → legs not cancelled | Store `call_control_id` from `Call::create()` response directly |

### 8.3 Medium (P2)

| # | Gap | Root Cause | Impact | Recommendation |
|---|-----|-----------|--------|----------------|
| **G-10** | Analytics siloed per platform | No unified pipeline | Cannot correlate quality issues across platforms | Send iOS metrics to backend; add `call_session_id` to Android analytics |
| **G-11** | Web has no `.incoming_call` listener | Broadcast sent but not consumed | If WebSocket drops, web misses incoming calls entirely | Add Reverb `.incoming_call` fallback listener |
| **G-12** | No state transition validation | SDKs don't prevent illegal transitions | Confusing UI states (e.g., "On Hold" for ended call) | Wrap each SDK in state machine validator |
| **G-13** | Android broadcast receiver lifecycle | Registered in `onStart()`, unregistered in `onStop()` | Backgrounded Activity misses dismissal broadcast | Use `LifecycleObserver` or persistent service |
| **G-14** | REMOTE_HOLD not tracked | No platform detects remote hold re-INVITE | User hears silence with no UI explanation | Add remote hold detection in SDK wrappers |

---

## 9. Target Architecture

### 9.1 Enhanced Backend State Cache

**Current**:
```php
['answered' => false, 'leg_ids' => [], 'answered_leg' => null]
```

**Target**:
```php
[
    'state' => 'ringing',           // ringing | answered | bridged | ended
    'answered' => false,
    'leg_ids' => ['v3:leg-1', ...], // Populated from Call::create() response (sync)
    'answered_leg' => null,
    'bridge_started_at' => null,    // For duration tracking
    'bridge_failed' => false,       // Bridge failure flag
    'all_legs_failed' => false,     // All legs failed → voicemail
]
// TTL: 2 hours
```

### 9.2 Active Call Registry

```php
// On call bridged:
Cache::put("active_call:{$userId}", [
    'call_session_id' => $callSessionId,
    'started_at' => now()->toIso8601String(),
    'device' => $platform,
    'organization_id' => $orgId,
], now()->addHours(2));

// On call ended:
Cache::forget("active_call:{$userId}");

// Query endpoint:
// GET /api/voip/call-status/{callSessionId}
// GET /api/voip/my-active-call
```

### 9.3 Four-Channel Dismissal

Add client-side status polling as 4th channel:

```kotlin
// Android: IncomingCallActivity
private val statusPoller = lifecycleScope.launch {
    while (isActive) {
        delay(3000)
        val response = apiService.getCallStatus(callSessionId)
        if (response.status in listOf("ended", "answered_elsewhere")) {
            stopRinging()
            finish()
            break
        }
    }
}
```

Backend endpoint: `GET /api/voip/call-status/{callSessionId}` checks Redis cache or Message metadata.

### 9.4 Cross-Device State Broadcast

New Reverb event: `CallStateChangedNotification`

```php
// Broadcast on every state transition:
event(new CallStateChangedNotification(
    userId: $user->id,
    callSessionId: $callSessionId,
    state: 'active',           // ringing | active | held | ended
    device: $platform,         // android | ios | web
    organizationId: $orgId,
));
```

**Consumers**:
- Web: Show "In Call on [Device]" badge
- Mobile: Update UI if listening on Reverb (or receive via push)
- Backend: Track device state for analytics

### 9.5 RINGING State Persistence

**iOS**:
```swift
// Save on PushKit delivery (before CallKit report)
await VoipStore.shared.saveIncomingCallState(callId, callerNumber, callerName, Date())

// Clear on answer/decline/timeout
await VoipStore.shared.clearIncomingCallState(uuid)

// Detect on restart
let missedCalls = await VoipStore.shared.detectMissedCalls()
// Show notification: "Missed call from [Name]"
```

**Android**:
```kotlin
// Save on push receive (before IncomingCallActivity)
CallStatePersistence.getInstance(context).saveIncomingCall(callId, number, name, timestamp)

// Clear on answer/decline/timeout
CallStatePersistence.getInstance(context).clearIncomingCall(callId)

// Detect on restart
val missedCalls = CallStatePersistence.getInstance(context).detectMissedCalls()
```

---

## 10. Implementation Roadmap

### Phase 1: Critical Fixes (Sprint 1) — P0

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1.1 | Add caller-hangup SIP leg cancellation | `TelnyxInboundWebhookController.php` | Low |
| 1.2 | Populate `leg_ids` synchronously from `Call::create()` response | `TelnyxInboundWebhookController.php::transferToUser()` | Low |
| 1.3 | Separate bridge from post-bridge operations (separate try blocks) | `TelnyxInboundWebhookController.php::onCallAnswered()` | Low |
| 1.4 | Add bridge retry (1 attempt, 500ms delay) | `TelnyxInboundWebhookController.php::onCallAnswered()` | Low |
| 1.5 | Extend simring cache TTL to 2 hours | `TelnyxInboundWebhookController.php` | Trivial |

### Phase 2: State Tracking (Sprint 2) — P1

| # | Task | Files | Effort |
|---|------|-------|--------|
| 2.1 | Add `state` field to simring cache | `TelnyxInboundWebhookController.php` | Low |
| 2.2 | Add `active_call:{userId}` Redis key | `TelnyxInboundWebhookController.php` | Low |
| 2.3 | Create `GET /api/voip/call-status/{id}` endpoint | New: `VoipCallStatusController.php` | Medium |
| 2.4 | Create `GET /api/voip/my-active-call` endpoint | Same controller | Low |
| 2.5 | Add 4th dismissal channel: client-side polling | `IncomingCallActivity.kt`, `PushKitManager.swift` | Medium |

### Phase 3: Persistence + Web UI (Sprint 3) — P1

| # | Task | Files | Effort |
|---|------|-------|--------|
| 3.1 | Persist RINGING state on iOS | `VoipStore.swift` | Medium |
| 3.2 | Persist RINGING state on Android | `CallStatePersistence.kt`, `CrashRecoveryManager.kt` | Medium |
| 3.3 | Render "In Call (Native)" badge on web | `dialpad/context.tsx`, `dialer.tsx` | Low |
| 3.4 | Add web `.incoming_call` Reverb fallback listener | `dialpad/context.tsx` | Medium |

### Phase 4: Cross-Device Sync + Analytics (Sprint 4-5) — P2

| # | Task | Files | Effort |
|---|------|-------|--------|
| 4.1 | Create `CallStateChangedNotification` Reverb event | New event class | Medium |
| 4.2 | Web listener for `.call_state_changed` | `dialpad/context.tsx` | Low |
| 4.3 | Add `call_session_id` to Android analytics | `VoipAnalytics.kt` | Low |
| 4.4 | Send iOS CallQualityMonitor metrics to backend | `Z360VoIPService.swift`, new API endpoint | Medium |
| 4.5 | State transition validation wrappers | New: `CallStateMachine.swift`, `.kt`, `.ts` | High |

---

## 11. Testing Plan

### 11.1 State Persistence Tests

| Test | Setup | Steps | Expected |
|------|-------|-------|----------|
| T1 | Device with active call | Kill app → restart | Orphan detected, CallKit/notification shown |
| T2 | Device with incoming call ringing | Kill app → restart | Missed call detected (after Phase 3 implementation) |
| T3 | Outbound call connecting | Kill app → restart | No orphan (CONNECTING not persisted) |
| T4 | Active call, reboot device | Reboot → start app | Orphan detected after reboot |

### 11.2 Cross-Platform Sync Tests

| Test | Setup | Steps | Expected |
|------|-------|-------|----------|
| T5 | 3 devices ringing | Answer on Android | iOS: CallKit ends (answeredElsewhere). Web: hangup via Reverb. Both within 1s. |
| T6 | Android + iOS ringing, both in Doze | Answer on iOS | Android: SIP BYE primary. If fails: polling endpoint dismisses within 3s. |
| T7 | Active call on iOS | Check web UI | Web shows "In Call (Native)" badge (after Phase 3) |
| T8 | Active call on Android | Try outbound on web | Backend returns "user already on call" (after Phase 2) |

### 11.3 Dismissal Channel Tests

| Test | Setup | Steps | Expected |
|------|-------|-------|----------|
| T9 | Block SIP BYE to Device B | Answer on A | Device B: dismissed via FCM push or polling (channels 3/4) |
| T10 | Block FCM to Device B | Answer on A | Device B: dismissed via SIP BYE (channel 1) |
| T11 | Device B backgrounded (no broadcast receiver) | Answer on A | Device B: dismissed via SIP BYE or polling |
| T12 | All three channels fail for Device B | Answer on A | Device B: dismissed via polling endpoint within 3s (channel 4) |

### 11.4 State Transition Tests

| Test | Trigger | Expected |
|------|---------|----------|
| T13 | HELD → attempt RINGING | Rejected by state machine (after Phase 4) |
| T14 | DONE → attempt RECONNECTING | Rejected — late SIP messages ignored |
| T15 | Two devices answer within 10ms | Redis lock ensures only one bridges |

---

## 12. File Index

### Backend (Laravel)

| File | Key Functions |
|------|--------------|
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | `handleCall()`, `transferToUser()`, `onCallAnswered()`, `onSimRingParentHangup()`, `onSimRingLegHangup()` |
| `app/Http/Controllers/Telnyx/TelnyxCallController.php` | `onRecordingSaved()`, webhook routing |
| `app/Services/PushNotificationService.php` | `sendIncomingCallPush()`, `sendCallEndedPush()` |
| `app/Services/CPaaSService.php` | `createDeviceCredential()`, `handleCredentials()` |
| `app/Events/CallEndedNotification.php` | Reverb broadcast for call ended |
| `app/Events/IncomingCallNotification.php` | Reverb broadcast for incoming call (web doesn't consume) |
| `app/Models/UserDeviceToken.php` | Device token + SIP credential storage |

### Android (Kotlin)

| File | Key Functions |
|------|--------------|
| `Z360FirebaseMessagingService.kt` | FCM handler, `call_ended` push, `ACTION_CALL_ENDED` broadcast |
| `IncomingCallActivity.kt` | Incoming call UI, broadcast receiver lifecycle |
| `ActiveCallActivity.kt` | Active call UI, `TelnyxSocketEvent.OnCallEnded` handler |
| `CallStatePersistence.kt` | Persist/recover active call state |
| `CrashRecoveryManager.kt` | Orphan detection + cleanup |
| `VoipAnalytics.kt` | Firebase Analytics events (847 lines) |
| `TelnyxVoipPlugin.kt` | Capacitor bridge, state events to web |

### iOS (Swift)

| File | Key Functions |
|------|--------------|
| `PushKitManager.swift` | PushKit handler, `call_ended` push, fake call for PushKit contract |
| `CallKitManager.swift` | `reportCallEnded()`, `reportIncomingCall()` |
| `Z360VoIPService.swift` | Central orchestrator, `onRemoteCallEnded()`, quality callbacks |
| `TelnyxService.swift` | SDK wrapper, `answerFromCallKit()` |
| `VoipStore.swift` | Actor-isolated persistence, `recoverOrphanCallState()` |
| `CallQualityMonitor.swift` | MOS/jitter/RTT tracking (286 lines) |
| `NetworkMonitor.swift` | Network change detection → RECONNECTING |
| `VoIPModels.swift` | `PersistableCallState` data model |

### Web (TypeScript/React)

| File | Key Functions |
|------|--------------|
| `dialpad/context.tsx` | VoIP state management, `.call_ended` listener, `nativeCallState` tracking |
| `dialpad/components/dialer.tsx` | Call UI (IncomingCall, OnCall, DialPad) |
| `hooks/useWebVoipCredentials.ts` | Browser credential management |
| `providers/native-voip-provider.tsx` | Native platform isolation |

### Telnyx SDKs

| SDK | State Model | Source |
|-----|-------------|--------|
| iOS | `CallState` enum (9 states) | `.scratchpad/packs/telnyx-ios-sdk.xml` |
| Android | `CallState` sealed class (10 states) | `.scratchpad/packs/telnyx-android-sdk.xml` |
| Web | `activeCall.state` (4 states) | `@telnyx/react-client` via `.scratchpad/packs/telnyx-web-sdk.xml` |

---

*Document generated: 2026-02-08*
*Synthesized from: call-state-machine.md (state-machine-designer) + call-state-synchronization.md (sync-analyst)*
*Total states in canonical model: 14*
*Total gaps identified: 14 (4 critical, 5 high, 5 medium)*
*Total files referenced: 30+ across 4 platforms + 3 SDK packs*
