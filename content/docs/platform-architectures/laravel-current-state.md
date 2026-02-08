---
title: Laravel Current State
---

# Laravel Backend Call Orchestration: Current State

![Laravel Backend Call Orchestration](/diagrams/laravel-backend-call-orchestration.jpeg)

> **Research date**: 2026-02-08
> **Source**: voip-backend skill (`/.claude/skills/voip-backend/references/files.md`) + live source files
> **Scope**: Complete documentation of the Z360 Laravel backend VoIP call management system

---

## Table of Contents

1. [Webhook Routing Architecture](#1-webhook-routing-architecture)
2. [Data Layer: Webhook Parsing](#2-data-layer-webhook-parsing)
3. [TelnyxCallController (Base Class)](#3-telnyxcallcontroller-base-class)
4. [TelnyxInboundWebhookController](#4-telnyxinboundwebhookcontroller)
5. [TelnyxOutboundWebhookController](#5-telnyxoutboundwebhookcontroller)
6. [Simultaneous Ringing Implementation](#6-simultaneous-ringing-implementation)
7. [Voicemail System](#7-voicemail-system)
8. [AI Agent Transfer](#8-ai-agent-transfer)
9. [CPaaSService](#9-cpaasservice)
10. [Push Notification System](#10-push-notification-system)
11. [Broadcast Events](#11-broadcast-events)
12. [Database Models & Schema](#12-database-models--schema)
13. [Configuration](#13-configuration)
14. [Observability: VoipLog](#14-observability-voiplog)
15. [Analysis: Patterns, Inconsistencies, and Fragilities](#15-analysis-patterns-inconsistencies-and-fragilities)

---

## 1. Webhook Routing Architecture

### Route Definition

**File**: `routes/webhooks.php:27-61`
**Loaded from**: `routes/web.php:50` (`require __DIR__.'/webhooks.php'`)

All webhooks are public endpoints (no auth middleware) under the `/webhooks` prefix:

```
POST /webhooks/cpaas/telnyx/notifications   → TelnyxNotificationsWebhookController   (number orders)
POST /webhooks/cpaas/telnyx/call-control    → TelnyxInboundWebhookController         (inbound calls)
POST /webhooks/cpaas/telnyx/call-control/failover → TelnyxInboundWebhookController@failover
POST /webhooks/cpaas/telnyx/credential      → TelnyxOutboundWebhookController        (outbound calls via credentials)
POST /webhooks/cpaas/telnyx/credential/failover   → TelnyxOutboundWebhookController@failover
POST /webhooks/cpaas/telnyx/a2p             → TelnyxA2PWebhookController             (10DLC brand/campaign)
POST /webhooks/cpaas/telnyx/sms             → TelnyxSMSWebhookController             (SMS)
POST /webhooks/cpaas/telnyx/rcs             → TelnyxRCSWebhookController             (RCS)
```

Each webhook type has a primary endpoint and a `/failover` backup.

### Key Routing Insight: Inbound vs Outbound Split

Telnyx uses two separate webhook destinations configured at the account level:
- **Call Control Application** (`call_control_id`) → routes to `TelnyxInboundWebhookController` via `/call-control`
- **Credential Connection** (`credential_connection_id`) → routes to `TelnyxOutboundWebhookController` via `/credential`

This means inbound calls from PSTN go through the Call Control App webhook, while outbound calls initiated by WebRTC clients (using SIP credentials) go through the Credential Connection webhook.

**Critical nuance**: Simultaneous ring legs are outbound Telnyx calls created via `\Telnyx\Call::create()` using the `call_control_id` connection, so their webhooks (call.initiated, call.answered, call.hangup) arrive at the **inbound** controller endpoint (`/call-control`), not the outbound one. This is handled by the `ensureDirection()` method which bypasses the direction mismatch check for sim-ring types.

---

## 2. Data Layer: Webhook Parsing

### TelnyxWebhook (Spatie Data)

**File**: `app/Data/Telnyx/TelnyxWebhook.php:1-58`

All Telnyx webhooks are parsed using Spatie Laravel Data into a structured hierarchy:

```
TelnyxWebhook
├── data: TelnyxWebhookData
│   ├── event_type: string (e.g., "call.initiated")
│   ├── id: ?string
│   ├── occurred_at: ?string
│   ├── payload: TelnyxBasePayloadData (cast by TelnyxPayloadCast)
│   └── record_type: string
└── meta: TelnyxWebhookMeta
    ├── attempt: int
    └── delivered_to: string
```

### TelnyxPayloadCast

**File**: `app/Data/Telnyx/Casts/TelnyxPayloadCast.php:1-44`

Dynamically casts the `payload` field based on `event_type` prefix:
- `call.*` → `TelnyxBaseCallPayloadData`
- `10dlc.*` → `TelnyxBaseA2PPayloadData`
- `message.*` → `TelnyxSMSPayload`

### Call Payload Data Objects

**Base**: `app/Data/Telnyx/Calls/TelnyxBaseCallPayloadData.php:1-54`
- Fields: `call_control_id`, `call_session_id`, `from`, `to`, `client_state`, `direction`
- All call data objects extend this

**TelnyxCallInitiatedData**: `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php:1-77`
- `recipient()` → returns `from` for incoming, `to` for outgoing
- `channel()` → resolves `AuthenticatedPhoneNumber` from the called/calling number
- `organization()` → resolves org from channel
- `message()` → finds existing Message by `call_session_id`

**TelnyxCallAnsweredData**: `app/Data/Telnyx/Calls/TelnyxCallAnsweredData.php:1-42`
- `message()` → finds Message by `call_session_id`

**TelnyxCallHangupData**: `app/Data/Telnyx/Calls/TelnyxCallHangupData.php:1-26`
- Additional fields: `hangup_cause`, `hangup_source`, `sip_hangup_cause`, `start_time`, `end_time`
- `message()` → finds Message by `call_session_id`

**TelnyxCallRecordingSavedData**: `app/Data/Telnyx/Calls/TelnyxCallRecordingSavedData.php:1-26`
- Additional fields: `recording_id`, `recording_started_at`, `recording_ended_at`, `recording_urls`

**TelnyxCallSpeakEndedData**: `app/Data/Telnyx/Calls/TelnyxCallSpeakEndedData.php:1-13`
- Only adds `message()` resolver

---

## 3. TelnyxCallController (Base Class)

**File**: `app/Http/Controllers/Telnyx/TelnyxCallController.php:1-375`
**Lines**: 375

### Architecture

Abstract base controller. Extensions must define:
- `protected string $direction` — `'incoming'` or `'outgoing'`
- `abstract protected function handleCall(): void` — flow-specific logic
- `protected array $methodMap` — maps event types to callables

### `__invoke(Request $request): JsonResponse` (lines 42-97)

Main webhook entry point:
1. Parses webhook via `TelnyxWebhook::from($request)`
2. Calls `ensureDirection()` to derive and validate direction
3. If direction mismatch with controller, returns 204 (silently ignored)
4. Dispatches to switch on `$eventType`:
   - `call.initiated` → `$this->callInitiated()`
   - `call.answered` → `$this->callAnswered()`
   - `call.recording.saved` → `$this->callRecordingSaved()`
5. Then dispatches `$this->methodMap[$eventType]` if exists
6. Catches `IdempotencyException` and returns 200 with idempotent flag

### `ensureDirection()` (lines 107-140)

Direction resolution logic:
1. Parses `client_state` from payload (base64-encoded JSON)
2. If type is `simultaneous_ring_leg`, `simultaneous_ring_parent`, `voicemail_parent`, or `voicemail_greeting` → **returns null** (bypasses direction gate)
3. If `client_state` has `direction` key, uses that
4. Fallback: uses `payload.direction` from Telnyx

**Why this matters**: Sim-ring outbound legs are created via the Call Control App connection but are technically "outgoing" direction. Without this bypass, the inbound controller would reject them.

### `callInitiated()` (lines 145-213)

The common call setup:
1. Skips full setup if `client_state.type === 'simultaneous_ring_leg'` (these are just ring attempts)
2. Parses `TelnyxCallInitiatedData`
3. Resolves channel (`AuthenticatedPhoneNumber`) and organization
4. Sets tenant context: `CurrentTenant::set($org)`
5. Creates/finds `Conversation` with type `PHONE`
6. Creates `Message` with type `PHONE_CALL`, keyed by `call_session_id`
7. Delegates to `$this->handleCall()` (implemented by subclass)

### `callAnswered()` (lines 218-259)

Base recording logic:
1. Skips if client_state type is sim-ring or voicemail
2. Resolves message by `call_session_id`
3. Starts recording via `\Telnyx\Call->record_start()` (WAV, dual channel, trim silence)
4. Custom file name = message ID for correlation

### `callRecordingSaved()` (lines 264-311)

Post-call recording processing:
1. Resolves message
2. Uses DB transaction with `lockForUpdate()` for idempotency
3. Updates message metadata: `recording_started_at`, `recording_ended_at`, `recording_id`
4. Dispatches transcription request to agent service
5. Creates `Ledger` entry for PAYG billing (AI_CALL_MINUTE or SIMPLE_CALL_MINUTE)

### `ensureIdempotent(Message, string $key)` (lines 322-334)

Idempotency guard per-message:
- Stores processed keys in `message.metadata.keys[]`
- Throws `IdempotencyException` if key already exists
- Prevents duplicate processing of retried webhooks

### `dispatchTranscriptionRequest()` (lines 336-374)

- For non-agent calls: sends `recording_url` (WAV) to agent layer `/transcribe`
- For agent calls: skips (agent layer handles its own transcription)
- Uses `CPaaSService::tunnelSafeUrl()` for callback URL

---

## 4. TelnyxInboundWebhookController

**File**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:1-1060`
**Lines**: 1,060 — the largest controller in the VoIP system
**Extends**: `TelnyxCallController`

### Constructor: Method Map Registration

```php
$this->methodMap = [
    'call.hangup'      => fn() => $this->onCallHangup(),
    'call.answered'     => fn() => $this->onCallAnswered(),
    'call.initiated'    => fn() => $this->onSimultaneousRingLegInitiated(),
    'call.speak.ended'  => fn() => $this->onSpeakEnded(),
];
```

Note: These run **after** the base class handlers. So for `call.initiated`, the base `callInitiated()` runs first (conversation/message setup), then `onSimultaneousRingLegInitiated()` runs for tracking. For `call.answered`, base `callAnswered()` runs first (recording), then `onCallAnswered()` runs for sim-ring bridging.

### `handleCall()` — Main Inbound Call Routing

**Lines**: ~1621-1692

This is the central decision tree for every incoming call:

```
call.initiated arrives
  ├── Parse TelnyxCallInitiatedData
  ├── ensureIdempotent(message, 'handleCall:inbound')
  ├── Is caller blocked? → Answer, speak "blocked", hangup
  ├── Check schedule: withinSchedule(cpaas_schedule)?
  ├── Resolve receivingUser from channel
  │
  ├── No receivingUser → transferToVoicemail
  ├── Within schedule + receivingUser.id !== 0 → transferToUser
  ├── Within schedule + receivingUser.id === 0 → transferToAgent (AI)
  ├── Outside schedule + unavailability_option === 'voicemail' → transferToVoicemail
  └── Outside schedule + unavailability_option !== 'voicemail' → transferToAgent
```

**Key insight**: `receivingUser.id === 0` is a sentinel value meaning "route to AI agent instead of a human."

### `transferToUser()` — Universal Session Alerting

**Lines**: ~1790-1974

This is the core multi-device alerting and ringing logic:

1. **Gather device info**: SIP username (org-level credential), FCM tokens (Android), APNs tokens (iOS)
2. **Send push notifications** to mobile devices (Android FCM + iOS APNs VoIP)
3. **Broadcast `IncomingCallNotification`** to all web sessions via Reverb WebSocket
4. **Collect per-device SIP credentials** from `UserDeviceToken` table (only active within last 24h)

**Critical comment at line 1843-1844**: _"Org-level credential ($sipUsername) is NOT dialed — it exists only for web JWT auth. Dialing it creates a phantom SIP leg that answers first and steals the bridge."_

Then routing by device count:

#### Single device (lines 1859-1881):
- Simple `\Telnyx\Call->transfer()` to `sip:{username}@sip.telnyx.com`
- Timeout: 30s
- Client state: `{ type: 'user_call', user_id, organization_id }`
- On failure → voicemail

#### Multiple devices (lines 1882-1973): Simultaneous Ring
- Creates outbound legs via `\Telnyx\Call::create()` for each SIP destination
- Uses `connection_id` from config and webhook URL pointing back to `/webhooks/cpaas/telnyx/call-control`
- Client state per leg: `{ type: 'simultaneous_ring_leg', parent_call_control_id, user_id, message_id, organization_id }`
- If all legs fail on first attempt → **retry once after 2s sleep** (blocking!)
- If still all fail → voicemail
- Stores ring session in cache: `Cache::put("simring:{$call_control_id}", ...)`
- **Does NOT answer parent call** — leaves it parked so PSTN caller hears ringback

### `sendIncomingCallPush()` — Mobile Push Dispatch

**Lines**: ~1979-2024

Constructs push payload with:
- `call_session_id`, `call_control_id`, `callerNumber`, `callerName`, `channelNumber`
- `callerAvatar` (contact photo URL)
- Organization context (`organizationId`, `organizationName`, `organizationSlug`)
- `callId` (= `call_session_id` for Z360/Telnyx push correlation)

Delegates to `PushNotificationService::sendIncomingCallPush()`.

### `onCallAnswered()` — Unified Answer Handler

**Lines**: ~2030-2174

Routes by `client_state.type`:
- `voicemail_parent` → `onVoicemailParentAnswered()`
- `simultaneous_ring_leg` → sim-ring answer flow
- Anything else → ignored

#### Simultaneous Ring Answer Flow:
1. Acquires Redis lock: `Cache::lock("simring:{$parentId}:lock", 10)`
2. If lock not acquired → hang up this leg (another device won the race)
3. Check `ringSession['answered']`:
   - **First to answer**:
     a. Set `answered = true`, `answered_leg = legCallControlId`
     b. Answer the parked parent call with `simultaneous_ring_parent` client_state
     c. Bridge parent ↔ answered leg: `parentCall->bridge(['call_control_id' => $legCallControlId])`
     d. Start recording on parent call
     e. Hang up all OTHER legs
     f. Broadcast `CallEndedNotification` with reason `'answered_elsewhere'`
     g. Send `sendCallEndedPush()` to dismiss mobile UI
   - **Already answered**: Hang up this late leg

### `onCallHangup()` — Hangup Handler

**Lines**: ~1694-1788

Parses `client_state` to determine hangup type:

1. **`simultaneous_ring_leg`** → delegates to `onSimultaneousRingLegHangup()`
2. **`simultaneous_ring_parent`** → delegates to `onSimultaneousRingParentHangup()`
3. **Regular hangup**:
   - Resolves userId and organizationId from message metadata
   - Sends `sendCallEndedPush()` and broadcasts `CallEndedNotification`
   - If `originator_cancel` → stop (caller hung up)
   - If `user_busy`, SIP 480, `no_answer`, or `timeout`:
     - Check if call was already answered (sim-ring session `answered === true`) → skip voicemail
     - Otherwise → `transferToVoicemail()`

### `onSimultaneousRingParentHangup()`

**Lines**: ~2181-2244

When PSTN caller hangs up (or bridge ends):
1. If sim-ring was answered, hang up the bridged leg
2. Clean up cache: `Cache::forget("simring:{$parentCallControlId}")`
3. Send `call_completed` notifications (push + broadcast)

### `onSimultaneousRingLegHangup()`

**Lines**: ~2250-2357

When an individual ring leg hangs up:
1. Acquire lock
2. If already answered:
   - If this is the answered leg → hang up parent, send `call_completed`
   - If not → ignore
3. If not answered:
   - Remove this leg from `ringSession['leg_ids']`
   - If all legs gone → `transferToVoicemail()`, cleanup cache

### `onSimultaneousRingLegInitiated()`

**Lines**: ~2362-2394

Tracks outbound leg IDs for sim-ring coordination:
- If `client_state.type === 'simultaneous_ring_leg'`:
  - Add `call_control_id` to `ringSession['leg_ids']`
  - Update cache

---

## 5. TelnyxOutboundWebhookController

**File**: `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php:1-41`
**Lines**: 41 — very thin
**Extends**: `TelnyxCallController`

```php
protected string $direction = 'outgoing';

protected function handleCall(): void
{
    $data = TelnyxCallInitiatedData::fromRequest(request());
    $message = $data->message();
    $this->ensureIdempotent($message, 'handleCall:outbound');

    // Block check (is_blocked or dnd_status)
    $identifier = $message->identifier;
    if ($identifier?->is_blocked || $identifier?->dnd_status) {
        $call->speak([...blocked/DND message...]);
        $call->hangup();
        return;
    }

    // Simple transfer to destination
    $call->transfer(['to' => $data->to, 'from' => $data->from]);
}
```

Outbound is straightforward:
1. Block/DND check on the callee's identifier
2. Simple transfer (no sim-ring, no voicemail)

The base class handles recording start on `call.answered` and recording save processing.

**No `methodMap` overrides** — uses only base class event handling.

---

## 6. Simultaneous Ringing Implementation

### Architecture Overview

```
PSTN Caller → Telnyx Call Control App → call.initiated webhook
                                              │
                                              ▼
                                       handleCall()
                                              │
                                              ▼
                                       transferToUser()
                                              │
                                    ┌─────────┼─────────┐
                                    ▼         ▼         ▼
                              Telnyx::Call  Telnyx::Call  Reverb broadcast
                              ::create()   ::create()    + FCM/APNs push
                              (leg 1)      (leg 2)
                                    │         │
                                    ▼         ▼
                              SIP ring    SIP ring
                              Device A    Device B
                                    │
                                    ▼ (Device A answers first)
                              call.answered webhook
                                    │
                                    ▼
                              Lock acquired
                              Answer parent
                              Bridge parent↔A
                              Hangup leg B
                              Broadcast call_ended
```

### Cache Keys

| Key | Purpose | TTL |
|-----|---------|-----|
| `simring:{parent_call_control_id}` | Ring session state | 10 min |
| `simring:{parent_call_control_id}:lock` | Race condition lock | 10 sec |

### Ring Session Structure

```php
[
    'parent_call_control_id' => string,
    'user_id' => int,
    'message_id' => int,
    'answered' => bool,
    'answered_leg' => ?string,  // added when answered
    'leg_ids' => string[],      // populated by onSimultaneousRingLegInitiated
]
```

### Client State Types

| Type | Used By | Purpose |
|------|---------|---------|
| `simultaneous_ring_leg` | Outbound SIP legs | Identifies leg for coordination |
| `simultaneous_ring_parent` | Parent call after answer | Identifies parent for hangup handling |
| `user_call` | Single-device transfer | Simple user transfer |
| `voicemail_parent` | Parent when going to voicemail | Triggers greeting on answered |
| `voicemail_greeting` | After greeting plays | Triggers recording start |

### Race Condition Handling

The system uses Redis-backed `Cache::lock()` for answer coordination:
- Lock key: `simring:{parentId}:lock` with 10-second timeout
- If lock not acquired → hang up the late answering leg
- Lock is released in `finally` block

**Potential issue**: The 10-second lock timeout is a hard limit. If Telnyx API calls in the critical section (answer + bridge + record_start + hangup other legs) take longer than 10 seconds, the lock could expire mid-operation, allowing another leg to interfere.

### Retry Logic

If all sim-ring legs fail initially, there's a **synchronous 2-second sleep** (`usleep(2_000_000)`) followed by a retry. This blocks the webhook response thread, which could cause issues under load or trigger Telnyx webhook retries.

---

## 7. Voicemail System

### Flow

```
transferToVoicemail(call_control_id, message)
    │
    ├── Mark message: metadata['is_voicemail'] = true
    ├── Answer parent call with client_state: { type: 'voicemail_parent', message_id }
    │
    ▼ (call.answered webhook arrives)
onVoicemailParentAnswered()
    │
    ├── TTS greeting: "We're not available. Please leave a message after the tone."
    ├── Voice: AWS.Polly.Joanna-Neural
    ├── client_state: { type: 'voicemail_greeting', message_id }
    │
    ▼ (call.speak.ended webhook arrives)
onSpeakEnded()
    │
    ├── Start recording: WAV, single channel, trim-silence, play_beep: true
    └── custom_file_name: message_id
```

**Recording handling** (after caller hangs up):
1. `call.recording.saved` fires
2. Base `callRecordingSaved()` saves metadata + dispatches transcription
3. Ledger entry created for billing

**Key observation**: Voicemail greeting is hardcoded in PHP. No per-org customization.

---

## 8. AI Agent Transfer

### `transferToAgent()`

**Lines**: ~2495-2578

When call routes to AI agent (receivingUser.id === 0 or outside schedule):

1. Create thread UUID
2. Mark message: `metadata['thread_id']`, `metadata['is_agent']`
3. Build conversation summary (cached by text message count)
4. Answer the call
5. Transfer to `config('services.agent.sip_endpoint')` (LiveKit SIP)

**Custom SIP headers passed**:
- `X-Org-Id` — tenant ID
- `X-Thread-Id` — conversation thread
- `X-Base-Url` — agent API base URL
- `X-User-Status` — `'registered'` (has contact) or `'unregistered'`
- `X-User-Data` — base64 JSON with name/email/phone (TODO: encryption noted)
- `X-Transcript-Callback-Url` — for transcription webhook
- `X-Agent-Introduction` — base64 intro instructions (if configured)
- `X-Agent-Voice` — voice selection
- `X-Agent-Personality` — personality setting
- `X-Conversation-Summary` — base64 summary of prior text messages

### `encodedConversationSummaryForAgent()`

**Lines**: ~2580-2637

Intelligent caching of conversation summaries:
1. Check `conversation.metadata['agent_call_summary']` cache
2. If cache hit and text_message_count matches → return cached
3. Otherwise, fetch all text messages, format as role/content pairs
4. Call `AgentService::gatewayRequest('POST', '/summarize', ...)` to AI summarize
5. Cache the summary on the conversation

**Notable**: Disabled for beta environment (`str_contains(config('app.url'), 'beta')`)

---

## 9. CPaaSService

**File**: `app/Services/CPaaSService.php:1-543`
**Lines**: 543

### Telnyx API Client

`telnyxRequest(string $method, string $path, array $payload)` (lines 11-68)
- Guzzle HTTP client, 45s timeout
- Bearer token auth from `config('cpaas.telnyx.api_key')`
- Returns `['status' => int, 'json' => mixed, 'raw' => string]`
- Throws `RuntimeException` on 4xx/5xx

### URL Helper

`tunnelSafeUrl(string $path)` (lines 77-94)
- Prefers `config('app.tunnel_host')` for development (ngrok)
- Falls back to `url($path)`

### Client State Parser

`parseClientState(?string $clientState)` (lines 104-139)
- Decodes base64 → JSON
- Returns `['is_outbound' => bool, 'user_id' => mixed, 'data' => array]`

### Credential Management

#### Org-Level: `handleCredentials(?User $user)` (lines 146-192)
- Per user+org: creates `UserTelnyxTelephonyCredential` if missing
- Creates via `\Telnyx\TelephonyCredential::create()` with `credential_connection_id`
- Returns JWT token (10-hour TTL) for web WebRTC
- **Used by web client for JWT-based authentication**

#### Device-Level: `createDeviceCredential(User $user, UserDeviceToken $deviceToken)` (lines 198-220)
- Creates per-device credential for mobile SIP registration
- Updates `UserDeviceToken` with `telnyx_credential_id`, `sip_username`, `sip_password`, `connection_id`
- 30-day expiration (`credential_expires_at`)
- **Used by mobile devices for per-device SIP identity**

#### `deleteTelnyxCredential(string $credentialId)` (lines 225-235)
- Deletes credential via Telnyx API
- Silently catches errors (logs warning)

#### `getDeviceJwt(UserDeviceToken $deviceToken)` (lines 240-250)
- Retrieves JWT from device's `telnyx_credential_id`
- For mobile SIP authentication

### Dual Credential Architecture

```
Organization Level (web):
  UserTelnyxTelephonyCredential
    ├── credential_id
    ├── sip_username (used ONLY for JWT auth, NOT for call routing)
    ├── sip_password
    └── connection_id

Device Level (mobile):
  UserDeviceToken
    ├── telnyx_credential_id
    ├── sip_username (used for SIP REGISTER + call routing)
    ├── sip_password
    └── connection_id
```

**Design reason**: Web uses the org-level credential only for JWT authentication (WebRTC). Mobile devices each get their own SIP credential so they can independently register and be dialed for simultaneous ring. The org-level SIP username is explicitly NOT used for call routing (see comment at `TelnyxInboundWebhookController.php:1843-1844`).

---

## 10. Push Notification System

### PushNotificationService

**File**: `app/Services/PushNotificationService.php:1-321`

#### `sendIncomingCallPush()` (lines 20-157)

Sends to all user devices in the relevant organization:

**FCM Payload** (Android via HTTP v1 API):
```json
{
  "type": "incoming_call",
  "call_session_id": "...",
  "call_control_id": "...",
  "caller_number": "+1...",
  "caller_name": "John Doe",
  "channel_number": "+1...",
  "timestamp": "1707000000",
  "caller_avatar": "https://...",
  "call_id": "...",
  "organization_id": "1",
  "organization_name": "Acme Corp",
  "organization_slug": "acme"
}
```

FCM message config: `priority: high`, `ttl: 60s`

**APNs VoIP Payload** (iOS):
Same data fields, plus:
```json
{
  "aps": { "content-available": 1 }
}
```

#### `sendCallEndedPush()` (lines 162-228)

Simplified payload:
```json
{
  "type": "call_ended",
  "call_session_id": "..."
}
```

Sent to both FCM and APNs. **Note**: Does NOT scope by organization — sends to ALL user devices.

#### FCM HTTP v1 API (`sendFcmMessage()`, lines 233-288)

- Uses OAuth2 service account auth via `google/auth`
- Token cached in static properties with 5-minute buffer
- Data-only messages (no `notification` block) — all values cast to strings
- Invalid tokens (`UNREGISTERED`, `INVALID_ARGUMENT`) are auto-removed

### ApnsVoipService

**File**: `app/Services/ApnsVoipService.php:1-182`

#### `sendVoipPush()` (lines 16-120)

Direct APNs HTTP/2 push:
- **Topic**: `{bundle_id}.voip`
- **Push type**: `voip`
- **Priority**: 10 (immediate)
- **Expiration**: 0 (don't store if device offline)
- Supports collapse ID for call deduplication

**Auth modes**:
1. **Token-based** (preferred): ES256 JWT with team ID + key ID
   - JWT cached for 50 minutes (Apple requires < 1 hour)
   - Private key loaded from file
2. **Certificate-based** (fallback): TLS client certificate
   - Supports separate cert + key files
   - Optional passphrase

**Environment routing**:
- Production: `api.push.apple.com`
- Development: `api.sandbox.push.apple.com`

### FcmChannel (Laravel Notification Channel)

**File**: `app/Channels/FcmChannel.php:1-137`

A different notification path used for general push notifications (not VoIP-specific):

1. Iterates all `$notifiable->deviceTokens()`
2. Builds `CloudMessage` via `kreait/firebase-php` SDK
3. Includes notification title/body AND data payload
4. Injects organization context (org name prefix in title, org_id in deep link)
5. Android config: configurable channel_id, priority, TTL
6. Invalid tokens auto-removed on `NotFound`/`InvalidMessage`
7. Re-throws last transient error for queue retry (accepts duplicate risk)

**Key difference**: FcmChannel uses `kreait/firebase-php` SDK (notification + data message), while PushNotificationService uses direct HTTP v1 API (data-only message). VoIP pushes go through PushNotificationService; regular notifications go through FcmChannel.

---

## 11. Broadcast Events

### IncomingCallNotification

**File**: `app/Events/IncomingCallNotification.php:1-57`

- **Implements**: `ShouldBroadcast`
- **Channel**: `TenantPrivateChannel("App.Models.User.{$userId}", $organizationId)`
  → Resolves to: `private-org.{orgId}.App.Models.User.{userId}`
- **Event name**: `incoming_call`
- **Payload**:
  ```json
  {
    "call_session_id": "...",
    "call_control_id": "...",
    "caller_number": "+1...",
    "caller_name": "John Doe",
    "channel_number": "+1...",
    "organization_id": 1,
    "organization_name": "Acme Corp"
  }
  ```

### CallEndedNotification

**File**: `app/Events/CallEndedNotification.php:1-46`

- **Implements**: `ShouldBroadcast`
- **Channel**: `TenantPrivateChannel("App.Models.User.{$userId}", $organizationId)`
- **Event name**: `call_ended`
- **Payload**:
  ```json
  {
    "call_session_id": "...",
    "reason": "answered_elsewhere|call_completed|unknown|..."
  }
  ```

### TenantPrivateChannel

**File**: `app/Broadcasting/TenantPrivateChannel.php:1-25`

Wraps Laravel's `PrivateChannel` with tenant namespace:
- `new TenantPrivateChannel("App.Models.User.5", 1)` → `"private-org.1.App.Models.User.5"`
- Falls back to no org prefix if tenant not resolved

---

## 12. Database Models & Schema

### UserDeviceToken

**File**: `app/Models/UserDeviceToken.php:1-166`

**Schema** (assembled from migrations):
```sql
CREATE TABLE user_device_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id BIGINT NULLABLE,        -- added later
    device_id VARCHAR NULLABLE,              -- added later
    fcm_token VARCHAR(500) UNIQUE NOT NULL,
    platform ENUM('android', 'ios') DEFAULT 'android',
    app_version VARCHAR NULLABLE,            -- added later
    device_name VARCHAR NULLABLE,            -- added later
    last_active_at TIMESTAMP NULLABLE,
    telnyx_credential_id VARCHAR(255) NULLABLE,  -- per-device SIP
    sip_username VARCHAR(255) NULLABLE,          -- per-device SIP
    sip_password VARCHAR(255) NULLABLE,          -- per-device SIP
    connection_id VARCHAR(255) NULLABLE,          -- cached config ref
    credential_expires_at TIMESTAMP NULLABLE,     -- 30-day expiry
    created_at TIMESTAMP,
    updated_at TIMESTAMP,

    INDEX (user_id),
    INDEX (sip_username)
);
```

**Key relationships**:
- `user()` → BelongsTo User
- `organization()` → BelongsTo Organization

**Static query methods**:
- `getFcmTokensForUser(userId, ?orgId)` — Android FCM tokens
- `getApnsVoipTokensForUser(userId, ?orgId)` — iOS "FCM" tokens (actually APNs VoIP tokens stored in `fcm_token` column!)
- `getTokensForUserInOrganization(userId, orgId)` — org-scoped
- `registerToken(userId, fcmToken, platform, ...)` — upsert by `fcm_token`
- `removeToken(fcmToken)` — delete by token

**Design issue**: The `fcm_token` column stores APNs VoIP tokens for iOS devices despite the column name. `getApnsVoipTokensForUser()` queries `platform = 'ios'` from the `fcm_token` column. This is a naming inconsistency.

### UserTelnyxTelephonyCredential

**File**: `app/Models/UserTelnyxTelephonyCredential.php:1-22`

**Schema**:
```sql
CREATE TABLE user_telnyx_telephony_credentials (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id BIGINT NULLABLE,     -- added later
    credential_id VARCHAR UNIQUE NOT NULL,
    connection_id VARCHAR NULLABLE,      -- added later
    sip_username VARCHAR UNIQUE NULLABLE,
    sip_password VARCHAR NULLABLE,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
```

**Purpose**: Stores org-level Telnyx telephony credentials. One per user per organization. Used exclusively for web WebRTC JWT authentication, NOT for SIP call routing.

### AuthenticatedPhoneNumber

**File**: `app/Models/AuthenticatedPhoneNumber.php` (referenced, not in skill)

Key relationship: `receivingUser()` → BelongsTo User via `receiving_user_id`
- This determines which user receives calls to a given phone number
- `receivingUser.id === 0` is sentinel for AI agent routing

---

## 13. Configuration

### Telnyx (`config/cpaas.php`)

```php
'telnyx' => [
    'api_key'                  => env('TELNYX_API_KEY'),
    'call_control_id'          => env('TELNYX_CALL_CONTROL_APP_ID'),        // inbound call routing
    'ovp_id'                   => env('TELNYX_OUTBOUND_VOICE_PROFILE_ID'),  // outbound caller ID
    'credential_connection_id' => env('TELNYX_CREDENTIAL_CONNECTION_ID'),   // SIP credential connection
    'notifications_profile_id' => env('TELNYX_NOTIFICATIONS_PROFILE_ID'),   // number orders
]
```

### Firebase FCM (`config/services.php`)

```php
'firebase' => [
    'project_id'       => env('FIREBASE_PROJECT_ID', 'z360-c7d9e'),
    'credentials_path' => env('FIREBASE_CREDENTIALS_PATH', storage_path('z360-c7d9e-firebase-adminsdk-fbsvc-dca3e28ad0.json')),
]
```

### APNs VoIP (`config/services.php`)

```php
'apns_voip' => [
    'enabled'         => env('APNS_VOIP_ENABLED', false),        // off by default
    'environment'     => env('APNS_VOIP_ENV', 'development'),    // development | production
    'bundle_id'       => env('APNS_VOIP_BUNDLE_ID'),
    // Token-based auth (preferred)
    'key_id'          => env('APNS_VOIP_KEY_ID'),
    'team_id'         => env('APNS_VOIP_TEAM_ID'),
    'key_path'        => env('APNS_VOIP_KEY_PATH'),
    // Certificate-based auth (fallback)
    'cert_path'       => env('APNS_VOIP_CERT_PATH'),
    'cert_passphrase' => env('APNS_VOIP_CERT_PASSPHRASE'),
    'cert_key_path'   => env('APNS_VOIP_CERT_KEY_PATH'),
]
```

### Agent SIP Endpoint (`config/services.php`)

```php
'agent' => [
    'sip_endpoint' => env('AGENT_SIP_URL', 'sip:+10000000000@3tdlxrqvb2u.sip.livekit.cloud'),
]
```

---

## 14. Observability: VoipLog

**File**: `app/Support/VoipLog.php:1-51`

Structured logging helper writing to the dedicated `voip` log channel:
- Automatically prefixes messages with first 8 chars of `call_session_id` for grep
- Methods: `debug()`, `info()`, `warning()`, `error()`
- All VoIP code uses this instead of `Log::` directly

---

## 15. Analysis: Patterns, Inconsistencies, and Fragilities

### Positive Patterns

1. **Idempotency**: `ensureIdempotent()` prevents duplicate webhook processing using metadata keys
2. **Structured data layer**: Spatie Data objects provide type-safe webhook parsing
3. **Direction bypass**: `ensureDirection()` correctly handles sim-ring legs arriving at the wrong controller
4. **Dual credential architecture**: Clean separation between web JWT auth and mobile SIP registration
5. **VoipLog**: Dedicated structured logging with call_session_id correlation
6. **Lock-based answer coordination**: Redis lock prevents race conditions in simultaneous ring
7. **Comprehensive push**: Both FCM and APNs covered with proper token cleanup

### Inconsistencies & Technical Debt

1. **Column naming**: `fcm_token` column stores APNs VoIP tokens for iOS. `getApnsVoipTokensForUser()` reads from `fcm_token`. This is confusing and error-prone.

2. **Hardcoded voicemail greeting**: `"We're not available. Please leave a message after the tone."` is hardcoded in PHP. No per-org customization, no localization.

3. **Sentinel user ID 0**: `receivingUser.id === 0` as AI agent routing sentinel is fragile. No documentation of this convention outside the code.

4. **Two FCM implementations**: `PushNotificationService` uses direct HTTP v1 API with Google OAuth, while `FcmChannel` uses `kreait/firebase-php` SDK. Different auth flows, different message structures.

5. **TODO comments**:
   - `TelnyxInboundWebhookController.php:1630`: `"TODO: Remove block logic from here and OutboundWebhookController and use it in core TelnyxCallController"` — block check is duplicated
   - `TelnyxInboundWebhookController.php:2533`: `"TODO: Add encryption"` for X-User-Data SIP header — user PII sent base64-encoded but not encrypted

6. **`sendCallEndedPush()` not org-scoped**: Unlike `sendIncomingCallPush()` which scopes by organization, `sendCallEndedPush()` sends to ALL user devices regardless of org. This could cause cross-org call dismissal.

### Fragilities & Risk Areas

1. **Blocking sleep in webhook handler**: The 2-second `usleep()` retry in `transferToUser()` (line 1916) blocks the webhook response thread. Under concurrent load, this could exhaust PHP-FPM workers. Telnyx may also retry the webhook before the response returns.

2. **10-second lock timeout**: The `Cache::lock(..., 10)` for sim-ring coordination could expire during slow Telnyx API sequences (answer + bridge + record_start + hangup multiple legs), leaving the critical section unprotected.

3. **No webhook signature verification**: Webhook routes have no middleware for Telnyx signature validation. Any HTTP POST to these endpoints would be processed.

4. **Cache-only state**: Simultaneous ring state exists only in Redis cache (`simring:{id}`) with 10-minute TTL. No database fallback. Cache eviction or Redis restart mid-call would orphan ring sessions.

5. **Message.metadata as state machine**: Call state is tracked via JSON metadata fields on the Message model (`keys[]`, `parent_call_control_id`, `is_voicemail`, `is_agent`, `received_by`, `recording_started_at`, etc.). This is flexible but:
   - No schema validation
   - No explicit state machine
   - Race conditions possible on concurrent metadata updates (only `callRecordingSaved` uses `lockForUpdate`)

6. **Single-device vs multi-device divergence**: The single-device path uses `transfer()` (Telnyx manages the bridge), while multi-device uses `Call::create()` + manual `answer()` + `bridge()`. Different failure modes, different cleanup logic.

7. **APNs token stored as fcm_token**: If the application ever needs to differentiate between FCM and APNs tokens for other purposes (e.g., different payload formats), the current schema makes this error-prone.

8. **No call timeout monitoring**: There's no server-side timeout for rings that neither answer nor hang up. The 30-second Telnyx `timeout_secs` handles this on the SIP level, but if the timeout webhook is lost, the parent call would remain parked indefinitely.

9. **Conversation summary for agent**: The `encodedConversationSummaryForAgent()` function loads ALL text messages for a conversation into memory. For long-lived conversations with hundreds of messages, this could cause memory issues.

10. **User PII in SIP headers**: Contact name, email, and phone are passed as base64-encoded (not encrypted) custom SIP headers to the agent service. These could be logged by SIP intermediaries.
