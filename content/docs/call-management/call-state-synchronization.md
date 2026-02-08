---
title: Call State Synchronization
---

# Cross-Platform Call State Synchronization

> **Session 10 Analysis** | Date: 2026-02-08
> **Analyst**: sync-analyst
> **Context**: Z360 VoIP whitepaper research — multi-device state synchronization, web UI coordination, backend state tracking, analytics, and call history

---

## Executive Summary

Z360's call state synchronization employs a **three-channel broadcast system** where the Laravel backend is the authoritative state manager and uses **independent, redundant dismissal channels** to ensure all non-answering devices stop ringing. The architecture is **backend-orchestrated with client-side state reconciliation** — clients do not directly communicate call state to each other, but instead receive coordinated notifications from the backend via three parallel channels:

| Channel | Mechanism | Target | Reliability | Latency |
|---------|-----------|--------|-------------|---------|
| **SIP BYE** | Telnyx Call Control `hangup()` → SDK socket | All devices with active SIP legs | High (if SDK connected) | ~200-500ms |
| **Reverb WebSocket** | Laravel Reverb broadcast on private tenant channel | Web sessions (Echo listener) | High (if browser tab active) | ~50-200ms |
| **FCM/APNs Push** | Firebase/Apple push notification | Mobile devices | Medium (Doze mode delays up to 15min) | 100ms-30s |

**Key findings**:

1. **No direct device-to-device communication**: Devices do not send state to each other. All coordination flows through the backend.
2. **Redis cache is ephemeral coordination state**: `simring:{parent}` cache (10min TTL) coordinates answer lock but is NOT the source of truth for call history.
3. **Message/Conversation models are persistent state**: All call metadata (duration, participants, recording URL, status) is stored in PostgreSQL for call history.
4. **Web UI does NOT display native call status**: When a user answers on native (iOS/Android), the web UI has no "in call" indicator. Web only knows about web-initiated calls.
5. **Analytics are platform-siloed**: Android has `VoipAnalytics` (847 lines), iOS has `CallQualityMonitor` (286 lines), backend logs to Message metadata, but no unified analytics pipeline.

---

## Table of Contents

1. [Multi-Device State Synchronization Model](#1-multi-device-state-synchronization-model)
2. [Web UI State During Native Calls](#2-web-ui-state-during-native-calls)
3. [Backend State Tracking](#3-backend-state-tracking)
4. [Analytics and Logging Inventory](#4-analytics-and-logging-inventory)
5. [Call History Data Model](#5-call-history-data-model)
6. [Gap Analysis](#6-gap-analysis)
7. [Sequence Diagrams](#7-sequence-diagrams)
8. [File References](#8-file-references)

---

## 1. Multi-Device State Synchronization Model

### 1.1 Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                     LARAVEL BACKEND (Authoritative State)               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Redis Cache (Ephemeral Coordination State)                      │  │
│  │                                                                   │  │
│  │  simring:{parent_call_control_id}                                │  │
│  │  ├─ answered: false → true                                       │  │
│  │  ├─ answered_leg: null → "v3:leg-2"                             │  │
│  │  ├─ leg_ids: ["v3:leg-1", "v3:leg-2", "v3:leg-3"]               │  │
│  │  ├─ user_id, message_id, parent_call_control_id                 │  │
│  │  └─ TTL: 10 minutes (NOT refreshed during call)                 │  │
│  │                                                                   │  │
│  │  simring:{parent}:lock                                           │  │
│  │  └─ TTL: 10 seconds (Laravel atomic lock)                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  PostgreSQL (Persistent Call State)                              │  │
│  │                                                                   │  │
│  │  messages (call logging)                                         │  │
│  │  ├─ metadata->call_session_id (UUID, unique per call)           │  │
│  │  ├─ metadata->parent_call_control_id (Telnyx ID)                │  │
│  │  ├─ metadata->original_from (caller number)                     │  │
│  │  ├─ metadata->received_by (user_id)                             │  │
│  │  ├─ metadata->recording_started_at (ISO8601)                    │  │
│  │  ├─ metadata->recording_ended_at (ISO8601)                      │  │
│  │  ├─ metadata->recording_urls (array: {wav: "url"})              │  │
│  │  ├─ metadata->is_agent (boolean, AI vs human)                   │  │
│  │  ├─ direction (inbound/outbound)                                │  │
│  │  ├─ conversation_id → Conversation model                        │  │
│  │  └─ status (pending/sent/delivered/failed)                      │  │
│  │                                                                   │  │
│  │  conversations                                                   │  │
│  │  ├─ identifier_id → Identifier (phone/email/contact)            │  │
│  │  ├─ channel_id → AuthenticatedPhoneNumber (Z360 number)         │  │
│  │  └─ organization_id (tenant isolation)                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Three-Channel Dismissal System                                  │  │
│  │                                                                   │  │
│  │  1. SIP BYE (TelnyxInboundWebhookController::onCallAnswered)    │  │
│  │     foreach ($ringSession['leg_ids'] as $otherLegId) {          │  │
│  │         if ($otherLegId !== $answeredLegId) {                   │  │
│  │             Call::constructFrom([...])->hangup();               │  │
│  │         }                                                         │  │
│  │     }                                                             │  │
│  │                                                                   │  │
│  │  2. Reverb Broadcast (CallEndedNotification event)              │  │
│  │     event(new CallEndedNotification(                            │  │
│  │         userId: $user->id,                                       │  │
│  │         callSessionId: $callSessionId,                          │  │
│  │         reason: 'answered_elsewhere',                           │  │
│  │         organizationId: $organization->id                       │  │
│  │     ));                                                          │  │
│  │                                                                   │  │
│  │  3. FCM/APNs Push (PushNotificationService)                     │  │
│  │     PushNotificationService::sendCallEndedPush(                 │  │
│  │         userId: $user->id,                                       │  │
│  │         callSessionId: $callSessionId                           │  │
│  │     );                                                           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
                  │                    │                    │
                  │ SIP BYE            │ Reverb WS          │ FCM/APNs
                  ▼                    ▼                    ▼
        ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
        │   ANDROID       │  │      iOS        │  │      WEB        │
        │                 │  │                 │  │                 │
        │ SDK: OnCallEnded│  │ SDK: onCallEnded│  │ Echo: .call_ended│
        │ Push: call_ended│  │ Push: call_ended│  │                 │
        │ Broadcast: ACTION│  │ CallKit: report │  │ activeCall.     │
        │  _CALL_ENDED    │  │  answeredElse   │  │  hangup()       │
        └─────────────────┘  └─────────────────┘  └─────────────────┘
```

### 1.2 Backend → Client State Flow

**Phase 1: Call Rings (Synchronized Broadcast)**

When a device answers, the backend performs these actions in sequence:

```php
// TelnyxInboundWebhookController.php — onCallAnswered()

// Step 1: Acquire distributed lock
$lock = Cache::lock("simring:{$parentId}:lock", 10);  // 10s TTL
if (!$lock->get()) {
    $call->hangup();  // Late answerer — hang up immediately
    return;
}

// Step 2: Mark answered in cache
$ringSession['answered'] = true;
$ringSession['answered_leg'] = $legCallControlId;
Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));

// Step 3: Answer parent call (PSTN caller stops hearing ringback)
Call::constructFrom(['call_control_id' => $parentId])->answer([...]);

// Step 4: Bridge parent ↔ answered leg (audio flows)
Call::constructFrom(['call_control_id' => $parentId])
    ->bridge(['call_control_id' => $legCallControlId]);

// Step 5: Start recording (dual-channel WAV)
Call::constructFrom(['call_control_id' => $parentId])->record_start([...]);

// Step 6: Hang up other legs (SIP BYE channel)
foreach ($ringSession['leg_ids'] as $otherLegId) {
    if ($otherLegId !== $legCallControlId) {
        Call::constructFrom(['call_control_id' => $otherLegId])->hangup();
    }
}

// Step 7: Broadcast dismissal (Reverb channel)
event(new CallEndedNotification(
    userId: $user->id,
    callSessionId: $callSessionId,
    reason: 'answered_elsewhere',
    organizationId: $organization->id
));

// Step 8: Send push notification (FCM/APNs channel)
PushNotificationService::sendCallEndedPush(
    userId: $user->id,
    callSessionId: $callSessionId
);

$lock->release();
```

**Source**: `.claude/skills/voip-backend/references/files.md` lines 2054-2170

### 1.3 Android Dismissal (Three Channels)

**Channel 1: SIP BYE**

```kotlin
// ActiveCallActivity.kt — Telnyx SDK event
telnyxViewModel.telnyxSocket.observe(this) { event ->
    when (event) {
        is TelnyxSocketEvent.OnCallEnded -> {
            // Call ended via SIP BYE
            cleanup()
            finish()
        }
    }
}
```

**Source**: `.claude/skills/voip-android/references/files.md` lines 1203-1214

**Channel 2: FCM Push**

```kotlin
// Z360FirebaseMessagingService.kt — call_ended push handler
when (remoteMessage.data["type"]) {
    "call_ended" -> {
        val callSessionId = remoteMessage.data["call_session_id"]

        // Mark as ended in persistent store
        Z360VoipStore.getInstance(applicationContext)
            .markCallEnded(callerNumber)

        // Broadcast to dismiss IncomingCallActivity
        val endIntent = Intent(ACTION_CALL_ENDED).apply {
            putExtra("call_session_id", callSessionId)
        }
        sendBroadcast(endIntent)
    }
}
```

**Source**: `.claude/skills/voip-android/references/files.md` lines 727-734

**Channel 3: Local Broadcast Receiver**

```kotlin
// IncomingCallActivity.kt — BroadcastReceiver registration
private val callEndedReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == Z360FirebaseMessagingService.ACTION_CALL_ENDED) {
            val sessionId = intent.getStringExtra("call_session_id")
            if (sessionId == this@IncomingCallActivity.callSessionId) {
                finish()
            }
        }
    }
}

override fun onStart() {
    super.onStart()
    registerReceiver(
        callEndedReceiver,
        IntentFilter(Z360FirebaseMessagingService.ACTION_CALL_ENDED)
    )
}
```

**Source**: `.claude/skills/voip-android/references/files.md` lines 4804-4822

**Critical Gap**: If `IncomingCallActivity` is in `onStop()` (backgrounded), the receiver is unregistered and the broadcast has no handler. In this scenario, dismissal relies entirely on SIP BYE (if SDK connected) or FCM push (which may be delayed by Doze mode).

### 1.4 iOS Dismissal (Two Channels)

**Channel 1: SIP BYE**

```swift
// Z360VoIPService.swift — Telnyx SDK delegate
func onRemoteCallEnded() {
    guard let callUUID = currentCallUUID else { return }

    // Report to CallKit
    callKitManager?.reportCallEnded(uuid: callUUID, reason: .remoteEnded)

    // Cleanup
    currentCallUUID = nil
}
```

**Source**: `.claude/skills/voip-ios/references/files.md` lines 5821-5886

**Channel 2: APNs Push**

```swift
// PushKitManager.swift — call_ended push handler
if payload["type"] as? String == "call_ended" {
    let callSessionId = payload["call_session_id"] as? String

    // Find existing CallKit call and report ended
    if let existingUUID = findExistingCallUUID(
        callerNumber: nil,
        telnyxCallId: callSessionId
    ) {
        callKitManager?.reportCallEnded(
            uuid: existingUUID,
            reason: .answeredElsewhere
        )
    } else {
        // PushKit contract: MUST report call even if not found
        let fakeUUID = UUID()
        callKitManager?.reportIncomingCall(
            uuid: fakeUUID,
            phoneNumber: "Unknown",
            callerName: "Call Ended",
            hasVideo: false
        ) { [weak self] error in
            if error == nil {
                self?.callKitManager?.reportCallEnded(
                    uuid: fakeUUID,
                    reason: .remoteEnded
                )
            }
        }
    }
}
```

**Source**: `.claude/skills/voip-ios/references/files.md` lines 1041-1064

**PushKit Contract Quirk**: iOS MUST report every VoIP push to CallKit, even if the call no longer exists. If `call_ended` arrives but no matching call is found (e.g., already ended via SIP BYE), iOS creates a **fake call** and immediately reports it as ended to satisfy the PushKit contract. Failure to do so results in app termination by iOS.

### 1.5 Web Dismissal (Two Channels)

**Channel 1: SIP BYE**

```typescript
// Telnyx SDK handles SIP CANCEL/BYE natively via WebSocket
// No explicit handler needed — SDK fires state change events
```

**Channel 2: Reverb WebSocket**

```typescript
// dialpad/context.tsx — Echo listener
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);

useEcho<{ call_session_id: string; reason: string }>(
    callEndedChannel,
    '.call_ended',
    (payload) => {
        if (!payload?.call_session_id) return;

        console.debug('[DialpadContext] Received call_ended broadcast:', payload);

        // If we have an active ringing call, hang it up
        if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
            try {
                activeCall.hangup();
            } catch (e) {
                console.error('Failed to hangup on call_ended broadcast:', e);
            }
        }

        setNativeCallState(null);
    }
);
```

**Source**: `.claude/skills/voip-frontend/references/files.md` lines 675-694

**Key Insight**: Web does NOT consume the `IncomingCallNotification` broadcast for incoming call detection. Web relies entirely on Telnyx WebRTC WebSocket for SIP INVITE delivery. The `.incoming_call` broadcast exists but has no listener. Only `.call_ended` is listened for.

---

## 2. Web UI State During Native Calls

### 2.1 Native Call State Tracking

The web UI tracks native call state via Capacitor bridge listeners:

```typescript
// dialpad/context.tsx — Native call state tracking
const [nativeCallState, setNativeCallState] = useState<{
    callId: string;
    status: 'new' | 'connecting' | 'ringing' | 'active' | 'held' | 'done';
    isMuted: boolean;
    elapsedSeconds: number;
} | null>(null);

useEffect(() => {
    if (!isNativeMobile()) return;

    const listeners: PluginListenerHandle[] = [];

    const setup = async () => {
        // Call started - connecting
        listeners.push(
            await TelnyxVoip.addListener('callStarted', (data: { callId: string }) => {
                setNativeCallState({
                    callId: data.callId,
                    status: 'connecting',
                    isMuted: false,
                    elapsedSeconds: 0,
                });
            })
        );

        // Call ringing (outgoing call)
        listeners.push(
            await TelnyxVoip.addListener('callRinging', (data: { callId: string }) => {
                setNativeCallState((prev) => ({
                    ...prev!,
                    status: 'ringing',
                }));
            })
        );

        // Call answered (active)
        listeners.push(
            await TelnyxVoip.addListener('callConnected', (data: { callId: string }) => {
                setNativeCallState((prev) => ({
                    ...prev!,
                    status: 'active',
                }));
            })
        );

        // Call ended
        listeners.push(
            await TelnyxVoip.addListener('callEnded', (data: { callId: string }) => {
                setNativeCallState(null);
            })
        );
    };

    setup();

    return () => {
        listeners.forEach((listener) => listener.remove());
    };
}, []);
```

**Source**: `.claude/skills/voip-frontend/references/files.md` lines 559-620

### 2.2 Current Gaps

**Gap 1: Web UI Does Not Display Native Call Status**

When a user answers a call on iOS or Android, the web UI does NOT show an "in call" indicator. The `nativeCallState` is tracked locally but not rendered anywhere in the UI. There is no visual indication on the web that the user is currently on a native call.

**Gap 2: No Collision Detection**

If a user tries to make a web call while on an active native call, there is no validation to prevent the second call. The backend does NOT track "user is currently on a call" state across platforms. Each platform's SDK is independent.

**Gap 3: Backend Has No "Active Call" Query**

The backend Redis cache (`simring:{parent}`) only tracks the ring phase. Once a call is bridged, the cache entry remains for 10 minutes but is not updated. There is no backend API endpoint to query "is user X currently on a call?"

**Evidence**: Searched voip-backend skill for `whereHas.*call|active.*call|ongoing.*call|in_progress` — zero matches for active call queries.

---

## 3. Backend State Tracking

### 3.1 Redis Cache (Ephemeral Coordination State)

**Purpose**: First-answer-wins coordination during simultaneous ring phase only.

**Lifecycle**:
1. **Created**: In `transferToUser()` after SIP legs are created
2. **Updated**: In `onSimultaneousRingLegInitiated()` when each leg reports `call.initiated`
3. **Updated**: In `onCallAnswered()` when first device answers (sets `answered: true`)
4. **Deleted**: In `onSimRingParentHangup()` or `onSimRingLegHangup()` when call ends
5. **Expires**: Automatically after 10 minutes (not refreshed during call)

**Schema**:

```php
[
    'parent_call_control_id' => 'v3:xxx',  // Telnyx parent leg ID
    'user_id' => 123,
    'message_id' => 456,                    // FK to messages table
    'answered' => false,                    // → true on first answer
    'answered_leg' => null,                 // → 'v3:leg-2' on answer
    'leg_ids' => ['v3:leg-1', 'v3:leg-2'],  // Populated async by call.initiated webhooks
]
```

**TTL**: 10 minutes from last update. **Critical**: The TTL is NOT refreshed during the call. For calls longer than 10 minutes, the cache expires while the call is still active. This means hangup webhooks cannot find the cache entry and must rely on `client_state` for routing.

**Source**: `.claude/skills/voip-backend/references/files.md` lines 1955-1961

### 3.2 PostgreSQL (Persistent Call State)

**messages table** (call logging):

```php
// app/Data/Telnyx/Recordings/TelnyxRecordingSavedData.php
class TelnyxRecordingSavedData
{
    public ?string $call_session_id = null;
    public ?string $call_control_id = null;
    public ?string $recording_id = null;
    public ?string $recording_started_at = null;  // ISO8601
    public ?string $recording_ended_at = null;    // ISO8601
    public array $recording_urls = [
        'wav' => null,
    ];
    // ...
}

// TelnyxCallController.php — onRecordingSaved()
$message = Message::query()
    ->where('metadata->call_session_id', $data->call_session_id)
    ->first();

$message->updateMetadata('recording_started_at', $data->recording_started_at);
$message->updateMetadata('recording_ended_at', $data->recording_ended_at);
$message->updateMetadata('recording_urls', $data->recording_urls);
$message->save();

// Duration calculation for billing
$durationMinutes = (int) ceil(
    Carbon::parse($data->recording_ended_at)
        ->diffInSeconds(Carbon::parse($data->recording_started_at)) / 60
);

Ledger::create([
    'organization_id' => $message->organization_id,
    'unit' => ($message->metadata['is_agent'] ?? false)
        ? LedgerUnit::AI_CALL_MINUTE
        : LedgerUnit::SIMPLE_CALL_MINUTE,
    'quantity' => $durationMinutes,
    'meta' => [
        'message_id' => $message->id,
        'call_session_id' => $data->call_session_id,
    ],
]);
```

**Source**: `.claude/skills/voip-backend/references/files.md` lines 3609-3620

**Metadata fields stored**:
- `call_session_id` (UUID) — unique per call, used for correlation
- `parent_call_control_id` (string) — Telnyx parent leg ID
- `original_from` (string) — PSTN caller number
- `received_by` (int) — user_id of recipient
- `recording_started_at` (ISO8601)
- `recording_ended_at` (ISO8601)
- `recording_urls` (array) — `{wav: "https://..."}`
- `is_agent` (boolean) — AI call vs human call (for billing)

**conversations table** (call context):
- Links to `identifiers` (phone number → contact resolution)
- Links to `authenticated_phone_numbers` (receiving Z360 number/channel)
- Organization-scoped (tenant isolation)

**Source**: `.claude/skills/voip-backend/references/files.md` lines 871-875, 927-931

### 3.3 No Active Call Tracking

**Finding**: The backend does NOT maintain a "user is currently on a call" state. The Redis cache is ring-phase-only. Once bridged, there is no backend query for "active calls per user."

**Implication**: No collision detection for:
- User tries to make call while already on a call
- User tries to answer second call while on first call (handled by mobile OS, not Z360)
- Cross-platform call state visibility (web doesn't know about native calls)

---

## 4. Analytics and Logging Inventory

### 4.1 Android Analytics (VoipAnalytics.kt — 847 lines)

**Events tracked**:

```kotlin
// Push synchronization
VoipAnalytics.logZ360PushReceived(callId, callerNumber, arrivalTime)
VoipAnalytics.logTelnyxPushReceived(callId, callerNumber, arrivalTime)
VoipAnalytics.logPushSyncCompleted(callId, syncType, delay, timeout)

// Call lifecycle
VoipAnalytics.logCallStarted(callId, direction)
VoipAnalytics.logCallAnswered(callId, answerDelay)
VoipAnalytics.logCallEnded(callId, duration, endReason)

// SDK state
VoipAnalytics.logSdkConnected()
VoipAnalytics.logSdkDisconnected(reason)
VoipAnalytics.logSdkReconnecting()

// Errors
VoipAnalytics.logError(component, message, metadata)
```

**Destination**: Firebase Analytics (Google Analytics for Firebase)

**Source**: `.claude/skills/voip-android/references/project-structure.md` line 31, `.claude/skills/voip-android/references/files.md` lines 8-111

**Crashlytics**: Android also logs to Firebase Crashlytics for crash reporting and non-fatal errors.

### 4.2 iOS Analytics (CallQualityMonitor.swift — 286 lines)

**Metrics tracked**:

```swift
// Z360VoIPService.swift — call quality callback
call.onCallQualityChange = { [weak self] metrics in
    self?.callQualityMonitor.updateMetrics(
        mos: metrics.mos,           // Mean Opinion Score (1.0-5.0)
        jitter: metrics.jitter,     // ms
        rtt: metrics.rtt,           // Round-trip time (ms)
        packetLoss: metrics.packetLoss  // percentage
    )
}
```

**Refresh interval**: 5 seconds during active call

**MOS thresholds**:
- **Excellent**: 4.3-5.0
- **Good**: 4.0-4.3
- **Fair**: 3.6-4.0
- **Poor**: 3.1-3.6
- **Bad**: <3.1

**Source**: `.claude/skills/voip-ios/references/files.md` lines 3404-3414, `.claude/skills/voip-ios/references/project-structure.md` line 26

**Destination**: Local logging only (not sent to analytics service). Used for real-time quality indicators in UI.

### 4.3 Backend Analytics (Message Metadata)

**Call logs stored in Message model**:
- Duration (calculated from recording start/end)
- Direction (inbound/outbound)
- Participants (caller number, receiving user, org)
- Recording URL (WAV file)
- AI vs human call (for billing classification)

**Billing integration**: `Ledger` model tracks call minutes per organization for PAYG billing.

**Source**: `.claude/skills/voip-backend/references/files.md` lines 3609-3620

### 4.4 Unified Analytics Gap

**Finding**: Each platform tracks analytics independently:
- Android → Firebase Analytics
- iOS → Local logs (CallQualityMonitor)
- Backend → Message metadata + Ledger

**No unified pipeline**: Call quality metrics from iOS are not sent to backend. Android analytics are in Firebase, not PostgreSQL. No single dashboard for cross-platform call quality.

---

## 5. Call History Data Model

### 5.1 Storage Schema

**messages table** (call events):
```sql
id (bigint, PK)
conversation_id (FK → conversations)
organization_id (FK → organizations, tenant isolation)
direction (enum: inbound, outbound)
status (enum: pending, sent, delivered, failed)
metadata (jsonb)
  ├─ call_session_id (UUID)
  ├─ parent_call_control_id (Telnyx ID)
  ├─ original_from (caller number)
  ├─ received_by (user_id)
  ├─ recording_started_at (ISO8601)
  ├─ recording_ended_at (ISO8601)
  ├─ recording_urls (array: {wav: "url"})
  └─ is_agent (boolean)
created_at, updated_at
```

**conversations table** (call context):
```sql
id (bigint, PK)
identifier_id (FK → identifiers, caller/callee)
channel_id (FK → authenticated_phone_numbers, Z360 number)
organization_id (FK → organizations)
last_message_at (timestamp)
created_at, updated_at
```

**identifiers table** (phone/email/contact resolution):
```sql
id (bigint, PK)
contact_id (FK → contacts, nullable)
value (string, e.g., "+15551234567")
type (enum: phone, email, etc.)
organization_id (FK → organizations)
```

### 5.2 Call History Query

To retrieve all calls for a user:

```php
$calls = Message::query()
    ->where('organization_id', CurrentTenant::id())
    ->whereHas('conversation', function ($q) use ($userId) {
        $q->whereHas('channel', function ($q2) use ($userId) {
            // Calls received by this user
            $q2->where('user_id', $userId);
        });
    })
    ->whereNotNull('metadata->call_session_id')
    ->orderBy('created_at', 'desc')
    ->get();
```

**Source**: Inferred from model relationships in `.claude/skills/voip-backend/references/files.md` lines 871-875

### 5.3 Inbox UI Integration

**Finding**: Call history is displayed in the Inbox UI as part of the conversation thread. Each Message with a `call_session_id` in metadata is rendered as a call event in the conversation.

**UI Components**: Located in `resources/js/mobile/pages/inbox/` (skill reference: `.claude/skills/voip-frontend/references/project-structure.md` line 23)

**Data fetching**: Uses Inertia partial reloads to fetch conversation messages, including call metadata.

---

## 6. Gap Analysis

### 6.1 Critical Gaps

| # | Gap | Impact | Evidence |
|---|-----|--------|----------|
| **G1** | **No active call state tracking** | User can try to make second call while on first call; no collision detection | No backend query for "user is currently on a call"; Redis cache expires after 10min |
| **G2** | **Web UI has no native call indicator** | User on web sees no indication they're on a native call; confusing UX | `nativeCallState` tracked but not rendered; no UI component for "in call" badge |
| **G3** | **Three-channel dismissal can all fail** | Devices keep ringing after answer: (1) SIP BYE fails if SDK disconnected, (2) FCM delayed by Doze mode, (3) Broadcast receiver unregistered if Activity backgrounded | Known production bug: "kept ringing after answer" |
| **G4** | **No webhook loss detection** | If `call.answered` webhook is lost, call never bridges; devices ring for 30s then timeout | No heartbeat polling for stale ring sessions |

### 6.2 High Priority Gaps

| # | Gap | Impact | Evidence |
|---|-----|--------|----------|
| **G5** | **Cache expires during long calls** | Hangup webhooks can't find cache entry for calls >10min; relies on `client_state` fallback | Cache TTL: 10min, not refreshed during call |
| **G6** | **No unified analytics** | Call quality metrics from iOS not sent to backend; Android metrics in Firebase; no single view | CallQualityMonitor logs locally only; VoipAnalytics → Firebase |
| **G7** | **No call collision prevention** | Backend doesn't prevent user from answering second call while on first | No "active calls per user" query |
| **G8** | **Web has no `.incoming_call` listener** | Web doesn't consume IncomingCallNotification broadcast; only relies on SIP INVITE | Broadcast sent but no listener; fallback path missing |

### 6.3 Medium Priority Gaps

| # | Gap | Impact | Evidence |
|---|-----|--------|----------|
| **G9** | **Android broadcast receiver lifecycle** | Dismissal broadcast has no handler if Activity in `onStop()` | Receiver registered in `onStart()`, unregistered in `onStop()` |
| **G10** | **No MOS reporting to backend** | iOS call quality metrics (MOS, jitter, packet loss) not aggregated for analytics | CallQualityMonitor updates local state only |
| **G11** | **No call_session_id in analytics** | Android analytics events don't include call_session_id for backend correlation | VoipAnalytics logs callId but not session UUID |

---

## 7. Sequence Diagrams

### 7.1 Three-Channel Dismissal (Happy Path)

```
Device A       Device B       Backend            Redis          Telnyx         Device C (Web)
(Android)      (iOS)
  │               │               │                │               │                │
  │ ◄─────────────┴───SIP INVITE──┴────────────────┴───────────────┴───────────────┤ (all ring)
  │               │               │                │               │                │
  │ USER ANSWERS  │               │                │               │                │
  │───SIP 200 OK──────────────────►                │               │                │
  │               │               │─acquire lock───►               │                │
  │               │               │◄─lock success──┤               │                │
  │               │               │                │               │                │
  │               │               │─Cache update───►               │                │
  │               │               │ answered:true  │               │                │
  │               │               │                │               │                │
  │               │               │─answer()───────────────────────►│               │
  │               │               │─bridge()───────────────────────►│               │
  │               │               │                │               │                │
  │               │               │──hangup()──────────────────────►│──SIP BYE─────►│ (Channel 1)
  │               │◄─────────────────────────────SIP BYE───────────┤               │
  │               │               │                │               │                │
  │               │               │─event(CallEndedNotification)───►───Reverb WS───►│ (Channel 2)
  │               │               │                │               │                │
  │               │◄───────────────FCM push (call_ended)───────────┤               │ (Channel 3)
  │               │               │                │               │                │
  │               │ CallKit:      │                │               │                │
  │               │ reportEnded   │                │               │  activeCall.   │
  │               │ (answered     │                │               │  hangup()      │
  │               │  Elsewhere)   │                │               │                │
  │               └─UI dismissed  │                │               └─UI dismissed   │
```

### 7.2 Dismissal Failure Cascade (Known Bug)

```
Device A       Device B       Backend            Redis          Telnyx
(Android)      (Android)
  │               │               │                │               │
  │ ◄─────────────┴───SIP INVITE──┴────────────────┴───────────────┤ (both ring)
  │               │               │                │               │
  │               │ USER ANSWERS  │                │               │
  │               │───SIP 200 OK──────────────────►                │
  │               │               │                │               │
  │               │               │─leg_ids[]──────► (EMPTY!)      │
  │               │               │ (webhook race) │               │
  │               │               │                │               │
  │               │               │─hangup loop────────────────────►│
  │               │               │ (no leg_ids)   │               │ ✗ SIP BYE NOT SENT
  │               │               │                │               │
  │               │               │─CallEndedNotification───────────► ✗ FCM PUSH SENT
  │               │               │                │               │   but Doze mode
  │               │               │                │               │   delays 15min
  │               │               │                │               │
  │ IncomingCallActivity          │                │               │
  │ in onStop() ───────────────────────────────────┤               │ ✗ Broadcast has
  │ (backgrounded)                │                │               │   no receiver
  │               │               │                │               │
  │ STILL RINGING │               │                │               │
  │ (Telnyx SDK   │               │                │               │
  │  notification)│               │                │               │
  │               │               │                │               │
  └─ Timeout after 30s (SIP leg timeout_secs)     │               │
```

---

## 8. File References

### Backend (Laravel)

| File | Key Functions | Lines |
|------|--------------|-------|
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | `transferToUser()`, `onCallAnswered()`, `onSimRingParentHangup()`, `onSimRingLegHangup()` | 1790-2240 |
| `app/Services/PushNotificationService.php` | `sendIncomingCallPush()`, `sendCallEndedPush()` | 20-157 |
| `app/Events/CallEndedNotification.php` | Reverb broadcast event | Full file |
| `app/Data/Telnyx/Recordings/TelnyxRecordingSavedData.php` | Recording metadata structure | 1025-1033 |
| `app/Http/Controllers/Telnyx/TelnyxCallController.php` | `onRecordingSaved()` | 3529-3660 |

**Skill**: `.claude/skills/voip-backend/references/files.md`

### Android (Kotlin)

| File | Key Functions | Lines |
|------|--------------|-------|
| `Z360FirebaseMessagingService.kt` | `onMessageReceived()`, `handleCallEndedPush()`, `ACTION_CALL_ENDED` broadcast | 626-734 |
| `VoipAnalytics.kt` | `logZ360PushReceived()`, `logPushSyncCompleted()`, analytics events | 8-111 |
| `IncomingCallActivity.kt` | `BroadcastReceiver` registration, `onStart()`/`onStop()` lifecycle | 4804-4822 |
| `ActiveCallActivity.kt` | `TelnyxSocketEvent.OnCallEnded` handler | 1203-1214 |

**Skill**: `.claude/skills/voip-android/references/files.md`

### iOS (Swift)

| File | Key Functions | Lines |
|------|--------------|-------|
| `PushKitManager.swift` | `call_ended` push handler, fake call reporting | 1041-1064 |
| `CallKitManager.swift` | `reportCallEnded(uuid:reason:)` | 644-647 |
| `Z360VoIPService.swift` | `onRemoteCallEnded()`, `setupQualityCallback()` | 5821-5886, 3404-3414 |
| `CallQualityMonitor.swift` | `updateMetrics()`, MOS tracking | 26 (file size: 286 lines) |

**Skill**: `.claude/skills/voip-ios/references/files.md`

### Web (TypeScript/React)

| File | Key Functions | Lines |
|------|--------------|-------|
| `dialpad/context.tsx` | `useEcho('.call_ended')`, `nativeCallState` tracking | 564-620, 675-694 |
| `dialpad/components/dialer.tsx` | Call UI rendering | Full file (274 lines) |
| `providers/native-voip-provider.tsx` | Native platform isolation | Full file (39 lines) |

**Skill**: `.claude/skills/voip-frontend/references/files.md`

### Telnyx SDKs

**Android SDK Events**:
- `TelnyxSocketEvent.OnCallEnded`
- `TelnyxSocketEvent.OnCallAnswered`
- `TelnyxSocketEvent.OnRinging`

**Source**: `.scratchpad/packs/telnyx-android-sdk.xml` (searched for call state events)

**iOS SDK Delegate**:
- `onRemoteCallEnded()`
- `onCallQualityChange(metrics:)`
- Push notification config: `TxPushConfig`

**Source**: `.scratchpad/packs/telnyx-ios-sdk.xml` (searched for delegate callbacks)

**Web SDK States**:
- `call.state`: `'ringing'`, `'active'`, `'destroy'`
- `notification.type`: `'callUpdate'`, `Notification.Ringing`

**Source**: `.scratchpad/packs/telnyx-web-sdk.xml` (searched for state enums)

---

## Recommendations

### Priority 1: Fix Three-Channel Dismissal

**Problem**: All three channels can fail simultaneously, leaving devices ringing after answer.

**Solution**: Add 4th channel — client-side status polling:

```kotlin
// Android: IncomingCallActivity
private val statusPoller = lifecycleScope.launch {
    while (isActive) {
        delay(3000)
        val response = apiService.getCallStatus(callSessionId)
        if (response.status in listOf("ended", "answered_elsewhere")) {
            finish()
            break
        }
    }
}
```

**Backend endpoint**: `GET /api/voip/call-status/{callSessionId}` returns current state from Redis cache or Message metadata.

### Priority 2: Add Active Call State Tracking

**Problem**: No backend query for "is user X on a call?"

**Solution**: Maintain active call registry in Redis:

```php
// On call bridged:
Cache::put("active_call:{$userId}", [
    'call_session_id' => $callSessionId,
    'started_at' => now(),
    'device' => $platform,
], now()->addHours(2));

// On call ended:
Cache::forget("active_call:{$userId}");

// Query endpoint:
Route::get('/api/voip/my-active-call', function () {
    $activeCall = Cache::get("active_call:" . auth()->id());
    return response()->json($activeCall);
});
```

**Web UI**: Show "In Call (Native)" badge when `activeCall` exists but `activeCall.device !== 'web'`.

### Priority 3: Extend Cache TTL or Refresh

**Problem**: Cache expires after 10min during long calls.

**Solution**: Either extend TTL to 2 hours OR refresh cache on every bridge success:

```php
// Option A: Extend TTL
Cache::put("simring:{$parent}", $ringSession, now()->addHours(2));

// Option B: Refresh on bridge
$ringSession['bridged_at'] = now();
Cache::put("simring:{$parent}", $ringSession, now()->addHours(2));
```

### Priority 4: Unified Analytics Pipeline

**Problem**: Call quality metrics siloed per platform.

**Solution**: Send iOS CallQualityMonitor metrics to backend:

```swift
// Z360VoIPService.swift — after call ends
let metrics = callQualityMonitor.getFinalMetrics()
apiService.postCallMetrics(
    callSessionId: callSessionId,
    mos: metrics.avgMOS,
    jitter: metrics.avgJitter,
    rtt: metrics.avgRTT,
    packetLoss: metrics.avgPacketLoss
)
```

**Backend**: Store in `messages.metadata['call_quality']`.

---

**End of Cross-Platform Call State Synchronization Analysis**

*Total files analyzed: 27 core files across 4 platforms*
*Total gaps identified: 11 (4 critical, 4 high, 3 medium)*
*SDK packs consulted: 3 (Android, iOS, Web)*
