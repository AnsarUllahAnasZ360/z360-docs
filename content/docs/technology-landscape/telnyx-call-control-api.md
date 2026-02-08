---
title: Telnyx Call Control API
---

# Telnyx Call Control API & PHP SDK Reference

> Research output for Z360 VoIP whitepaper. Documents how Z360's Laravel backend interacts with the Telnyx Call Control API through the PHP SDK.

## Table of Contents

1. [Overview: Command/Webhook Model](#1-overview-commandwebhook-model)
2. [API Actions Reference](#2-api-actions-reference)
3. [Webhook Event Sequences](#3-webhook-event-sequences)
4. [client_state Mechanism](#4-client_state-mechanism)
5. [SIP Credential Management](#5-sip-credential-management)
6. [Call Bridging](#6-call-bridging)
7. [Simultaneous Ringing](#7-simultaneous-ringing)
8. [Gaps & Observations](#8-gaps--observations)

---

## 1. Overview: Command/Webhook Model

Telnyx Call Control is an **asynchronous command/webhook API**. The application sends commands (answer, bridge, transfer, hangup, etc.) to Telnyx, and Telnyx responds with webhook events describing what happened. Each call leg is identified by a `call_control_id` and grouped by a `call_session_id`.

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Call Control ID** | Unique identifier for a single call leg. Used to address commands to that leg. |
| **Call Session ID** | Groups related call legs (e.g., inbound + transfer legs) into a logical call session. |
| **Connection ID** | The Call Control App/connection through which calls are routed. Required for `Call::create`/`Dial`. |
| **client_state** | Base64-encoded string passed through webhooks for application-level state tracking. |
| **command_id** | Idempotency key. Telnyx ignores duplicate commands with the same `command_id` for the same `call_control_id`. |

### Interaction Pattern

```
Application                          Telnyx
    |                                   |
    |  <── webhook: call.initiated ───  |   (inbound call arrives)
    |  ── command: answer ──>           |
    |  <── webhook: call.answered ───   |
    |  ── command: bridge ──>           |
    |  <── webhook: call.bridged ───    |   (both legs)
    |  ...                              |
    |  <── webhook: call.hangup ───     |   (one party hangs up)
```

### PHP SDK Usage Pattern

Z360 uses both the **official Telnyx PHP SDK** (for `Call`, `TelephonyCredential` classes) and **direct HTTP via Guzzle** (for some API calls through `CPaaSService::telnyxRequest()`).

**SDK pattern** (used for call control commands):
```php
// Construct a Call object from an existing call_control_id
$call = \Telnyx\Call::constructFrom(['call_control_id' => $callControlId]);

// Issue commands on that call
$call->answer([...]);
$call->bridge([...]);
$call->transfer([...]);
$call->hangup();
$call->speak([...]);
$call->record_start([...]);
```

**Direct HTTP pattern** (used for non-call-control operations):
```php
// CPaaSService::telnyxRequest() wraps Guzzle
$response = CPaaSService::telnyxRequest('GET', '/phone_numbers/' . $phoneNumberId);
```

> **Source**: `app/Services/CPaaSService.php` (lines 4179-4238 in voip-backend skill)

---

## 2. API Actions Reference

The Telnyx PHP SDK provides **35+ Call Control action classes** in `src/Calls/Actions/`. Below are the actions Z360 actively uses, with their key parameters and expected webhook responses.

### 2.1 Answer (`ActionAnswerParams`)

Answers an incoming call leg.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clientState` | string (base64) | No | State propagated to subsequent webhooks |
| `commandID` | string | No | Idempotency key |
| `billingGroupID` | string | No | Override billing group |
| `record` | enum | No | `record-from-answer` to auto-record |
| `sipHeaders` | array | No | Custom SIP headers on INVITE response |
| `customHeaders` | array | No | Custom SIP INVITE response headers |
| `webhookURL` | string | No | Override webhook URL for this call |
| `soundModifications` | object | No | Pitch/audio effects |
| `streamURL` | string | No | WebSocket URL for media streaming |

**Expected webhooks**: `call.answered`; optionally `streaming.started`/`streaming.stopped` if `streamURL` set.

**Z360 usage** (`TelnyxCallController::callInitiated()`):
```php
// Base controller answers inbound calls and attaches direction context
$call->answer([
    'client_state' => base64_encode(json_encode([
        'type' => 'user_call',
        'user_id' => $user->id,
        'organization_id' => $organization?->id,
    ])),
]);
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxCallController.php` (lines 3455-3522 in voip-backend skill)

---

### 2.2 Bridge (`ActionBridgeParams`)

Connects two call legs together so audio flows between them.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `callControlIDToBridgeWith` | string | **Yes** | The other leg's call_control_id |
| `clientState` | string (base64) | No | State for subsequent webhooks |
| `parkAfterUnbridge` | string | No | `self` to park leg after unbridge instead of hangup |
| `playRingtone` | bool | No | Play ringtone if bridge target hasn't answered yet |
| `ringtone` | enum | No | Country-specific ringtone (default: US) |
| `queue` | string | No | Bridge with first call in named queue |
| `videoRoomID` | string | No | Bridge into video room |
| `record` | enum | No | Auto-record on bridge |
| `muteDtmf` | enum | No | Suppress DTMF passthrough |

**Expected webhooks**: `call.bridged` on **both** legs (Leg A and Leg B each receive a `call.bridged` event).

**Z360 usage** (simultaneous ring answer handler):
```php
// After answering the parent call, bridge it to the winning device leg
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])
    ->bridge(['call_control_id' => $legCallControlId]);
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2102-2108 in voip-backend skill)

---

### 2.3 Transfer (`ActionTransferParams`)

Transfers a call to a new destination. Creates a new outbound leg and automatically bridges when the destination answers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | **Yes** | DID or SIP URI destination |
| `from` | string | No | Caller ID (defaults to original `to` number) |
| `fromDisplayName` | string | No | SIP From Display Name (max 128 chars) |
| `clientState` | string (base64) | No | State for subsequent webhooks |
| `targetLegClientState` | string (base64) | No | Separate client_state for the **new** leg |
| `timeoutSecs` | int | No | Answer timeout (5-600 seconds) |
| `timeLimitSecs` | int | No | Max call duration (default 14400s / 4hrs) |
| `answeringMachineDetection` | enum | No | Enable AMD (standard or premium) |
| `audioURL` / `mediaName` | string | No | Audio to play when destination answers before bridge |
| `customHeaders` | array | No | Custom SIP headers on INVITE |
| `sipAuthUsername/Password` | string | No | SIP authentication credentials |
| `sipRegion` | enum | No | SIP region routing |
| `sipTransportProtocol` | enum | No | UDP, TCP, or TLS |
| `earlyMedia` | bool | No | Pass early media to originating leg |
| `mediaEncryption` | enum | No | Encryption on new leg |
| `parkAfterUnbridge` | string | No | `self` to park after unbridge |
| `record` | enum | No | Auto-record |
| `webhookURL` | string | No | Override webhook URL |

**Expected webhooks**: `call.initiated` (new leg), `call.bridged` (both legs), `call.answered` or `call.hangup`; optionally `call.machine.detection.ended` and `call.machine.greeting.ended` if AMD enabled.

**Z360 usage** (single-device transfer):
```php
$call = \Telnyx\Call::constructFrom(['call_control_id' => $call_control_id]);
$call->transfer([
    'to' => "sip:{$sipDestinations[0]}@sip.telnyx.com",
    'from' => $message->metadata['original_from'],
    'timeout_secs' => 30,
    'client_state' => base64_encode(json_encode([
        'type' => 'user_call',
        'user_id' => $user->id,
        'organization_id' => $organization?->id,
    ])),
]);
```

**Z360 usage** (transfer to AI agent with custom SIP headers):
```php
$transferPayload = [
    'to' => config('services.agent.sip_endpoint'),
    'from' => $message->metadata['original_from'],
    'custom_headers' => [
        ['name' => 'X-Tenant-Id', 'value' => base64_encode((string) $tenantId)],
        ['name' => 'X-Thread-Id', 'value' => $threadId],
        ['name' => 'X-Agent-Introduction', 'value' => base64_encode((string) $instructions)],
        ['name' => 'X-Agent-Voice', 'value' => $voice],
        ['name' => 'X-Conversation-Summary', 'value' => $encodedSummary],
    ],
];
$call->transfer($transferPayload);
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 1859-1881, 2510-2576 in voip-backend skill)

---

### 2.4 Dial / Call::create (`CallDialParams`)

Creates a new outbound call leg. Unlike `transfer`, this does **not** automatically bridge — the application must explicitly bridge after the destination answers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `connectionID` | string | **Yes** | Call Control App/connection ID |
| `from` | string | **Yes** | Caller ID in +E164 format |
| `to` | string or array | **Yes** | Destination DID(s) or SIP URI(s) |
| `clientState` | string (base64) | No | State for subsequent webhooks |
| `timeoutSecs` | int | No | Answer timeout (5-600 seconds) |
| `timeLimitSecs` | int | No | Max call duration |
| `webhookURL` | string | No | Override webhook URL |
| `linkTo` | string | No | Share call_session_id with another call |
| `bridgeOnAnswer` | bool | No | Auto-bridge when answered (requires `linkTo`) |
| `bridgeIntent` | bool | No | Signal intent to bridge (requires `linkTo`) |
| `parkAfterUnbridge` | string | No | Park behavior after unbridge |
| `answeringMachineDetection` | enum | No | Enable AMD |
| `customHeaders` | array | No | Custom SIP headers |
| `sipAuthUsername/Password` | string | No | SIP authentication |
| `sipRegion` | enum | No | SIP region |
| `sipTransportProtocol` | enum | No | Transport protocol |
| `superviseCallControlID` | string | No | Call to supervise |
| `supervisorRole` | enum | No | barge, whisper, or monitor |

**Expected webhooks**: `call.initiated`, `call.answered` or `call.hangup`; optionally `call.machine.detection.ended`.

**Z360 usage** (simultaneous ring — create one leg per device):
```php
foreach ($sipDestinations as $sip) {
    \Telnyx\Call::create([
        'to' => "sip:{$sip}@sip.telnyx.com",
        'from' => $message->metadata['original_from'],
        'connection_id' => $connectionId,
        'webhook_url' => CPaaSService::tunnelSafeUrl('/webhooks/cpaas/telnyx/call-control'),
        'timeout_secs' => 30,
        'client_state' => base64_encode(json_encode([
            'type' => 'simultaneous_ring_leg',
            'parent_call_control_id' => $call_control_id,
            'user_id' => $user->id,
            'message_id' => $message->id,
        ])),
    ]);
}
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 1891-1941 in voip-backend skill)

---

### 2.5 Hangup (`ActionHangupParams`)

Terminates a call leg.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `clientState` | string (base64) | No | State for subsequent webhooks |
| `commandID` | string | No | Idempotency key |

**Expected webhooks**: `call.hangup`, `call.recording.saved` (if recording was active).

**Z360 usage** (hang up losing simultaneous ring legs):
```php
$legCall = \Telnyx\Call::constructFrom(['call_control_id' => $answeredLeg]);
$legCall->hangup();
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2205-2209 in voip-backend skill)

---

### 2.6 Speak (`ActionSpeakParams`)

Converts text to speech and plays it on the call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `payload` | string | **Yes** | Text or SSML (max 3000 chars) |
| `voice` | string | **Yes** | Voice identifier: `AWS.Polly.<VoiceId>`, `Azure.<VoiceId>`, `ElevenLabs.<ModelId>.<VoiceId>`, `Telnyx.<ModelId>.<VoiceId>` |
| `clientState` | string (base64) | No | State for subsequent webhooks |
| `language` | enum | No | Language (ignored for Polly voices) |
| `payloadType` | enum | No | `text` or `ssml` |
| `serviceLevel` | enum | No | `basic` or `premium` |
| `stop` | string | No | `current` or `all` to stop queued audio |

**Expected webhooks**: `call.speak.started`, `call.speak.ended`.

**Z360 usage** (voicemail greeting and blocked caller message):
```php
// Play voicemail greeting
$call->speak([
    'payload' => $voicemailGreeting,
    'voice' => 'AWS.Polly.Joanna-Neural',
    'client_state' => base64_encode(json_encode([
        'type' => 'voicemail_greeting',
        ...
    ])),
]);

// Blocked caller
$call->speak(['payload' => 'This number has blocked calls.']);
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2414-2424, 1621-1690 in voip-backend skill)

---

### 2.7 Start Recording (`ActionStartRecordingParams`)

Starts recording audio on a call leg.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channels` | enum | **Yes** | `single` or `dual` |
| `format` | enum | **Yes** | `mp3` or `wav` |
| `clientState` | string (base64) | No | State for subsequent webhooks |
| `playBeep` | bool | No | Play beep at recording start |
| `recordingTrack` | enum | No | `both`, `inbound`, or `outbound` |
| `maxLength` | int | No | Max recording length (0-14400 seconds) |
| `timeoutSecs` | int | No | Silence timeout |
| `trim` | enum | No | `trim-silence` to remove silence |
| `transcription` | bool | No | Enable post-recording transcription |
| `transcriptionEngine` | enum | No | `A` (Google), `B` (Telnyx), `deepgram/nova-3` |
| `customFileName` | string | No | Custom file name (Telnyx appends timestamp) |

**Expected webhooks**: `call.recording.saved` (when recording completes).

**Z360 usage** (after voicemail greeting completes):
```php
$call->record_start([
    'channels' => 'single',
    'format' => 'mp3',
    'play_beep' => true,
    'client_state' => base64_encode(json_encode([
        'type' => 'voicemail_parent',
        ...
    ])),
]);
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2112-2117, 2430-2463 in voip-backend skill)

---

### 2.8 Additional SDK Actions (Not Currently Used by Z360)

The PHP SDK also provides these actions that Z360 does not currently use:

| Action | Description |
|--------|-------------|
| `ActionRejectParams` | Reject incoming call with cause code (e.g., `busy`, `reject`) |
| `ActionGatherParams` | Collect DTMF digits |
| `ActionGatherUsingAIParams` | AI-powered DTMF/speech gathering |
| `ActionGatherUsingSpeakParams` | Speak prompt + collect DTMF |
| `ActionGatherUsingAudioParams` | Play audio + collect DTMF |
| `ActionStartPlaybackParams` | Play audio file (WAV/MP3) by URL or media_name |
| `ActionEnqueueParams` | Place call in a named queue |
| `ActionLeaveQueueParams` | Remove call from queue |
| `ActionReferParams` | SIP REFER (blind transfer) |
| `ActionSendDtmfParams` | Send DTMF tones |
| `ActionSendSipInfoParams` | Send SIP INFO message |
| `ActionStartForkingParams` | Fork media to external destination |
| `ActionStartStreamingParams` | Stream audio to WebSocket |
| `ActionStartTranscriptionParams` | Real-time transcription |
| `ActionStartSiprecParams` | SIPREC-based recording |
| `ActionStartNoiseSuppressionParams` | Noise suppression |
| `ActionStartAIAssistantParams` | Telnyx AI assistant |
| `ActionSwitchSupervisorRoleParams` | Change supervisor role (barge/whisper/monitor) |
| `ActionUpdateClientStateParams` | Update client_state mid-call |

---

## 3. Webhook Event Sequences

Z360 routes all call control webhooks through a single endpoint, with the base `TelnyxCallController` dispatching events to child controllers via the `methodMap` pattern.

### 3.1 Webhook Routing Architecture

```
POST /webhooks/cpaas/telnyx/call-control
    │
    ├── TelnyxCallController::__invoke()
    │   ├── Parse webhook → TelnyxWebhook data object
    │   ├── Determine direction from client_state
    │   ├── Direction gate (skip if mismatch)
    │   │
    │   ├── Base event switch:
    │   │   ├── call.initiated  → callInitiated() → handleCall()
    │   │   ├── call.answered   → callAnswered()
    │   │   └── call.recording.saved → callRecordingSaved()
    │   │
    │   └── Extension methodMap dispatch:
    │       └── $this->methodMap[$eventType]()
    │
    ├── TelnyxInboundWebhookController (direction: 'incoming')
    │   methodMap:
    │   ├── call.hangup     → onCallHangup()
    │   ├── call.answered   → onCallAnswered()
    │   ├── call.initiated  → onSimultaneousRingLegInitiated()
    │   └── call.speak.ended → onSpeakEnded()
    │
    └── TelnyxOutboundWebhookController (direction: 'outgoing')
        (minimal — 41 lines)
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxCallController.php` (lines 3344-3403), `TelnyxInboundWebhookController.php` (lines 1595-1616 in voip-backend skill)

### 3.2 Inbound Call → Single Device

```
Telnyx                     Z360 Backend                    Device
  │                            │                              │
  │── call.initiated ─────────>│                              │
  │                            │ callInitiated()              │
  │                            │   answer() with client_state │
  │<── answer command ─────────│                              │
  │                            │                              │
  │── call.answered ──────────>│                              │
  │                            │ handleCall()                 │
  │                            │   Route: transferToUser()    │
  │                            │   Single SIP → transfer()    │
  │<── transfer command ───────│                              │
  │                            │                              │
  │── call.initiated ─────────>│  (new leg created)           │
  │                       ┌────│                              │
  │                       │    │── SIP INVITE ───────────────>│
  │                       │    │                              │
  │── call.answered ──────┘───>│  (device picks up)           │
  │                            │                              │
  │── call.bridged ──────────>│  (auto-bridge by transfer)   │
  │── call.bridged ──────────>│  (both legs notified)        │
  │                            │                              │
  │      ════ CALL ACTIVE ═══════════════════════════════════ │
  │                            │                              │
  │── call.hangup ───────────>│  (either party hangs up)     │
  │── call.recording.saved ──>│  (if recording was active)   │
```

### 3.3 Inbound Call → Simultaneous Ring (Multiple Devices)

```
Telnyx                     Z360 Backend              Device A    Device B
  │                            │                        │           │
  │── call.initiated ─────────>│                        │           │
  │                            │ answer() parent call   │           │
  │<── answer ─────────────────│                        │           │
  │                            │                        │           │
  │── call.answered ──────────>│                        │           │
  │                            │ handleCall()           │           │
  │                            │ transferToUser()       │           │
  │                            │ Multi-device detected  │           │
  │                            │                        │           │
  │                            │ Call::create (Leg A)   │           │
  │<── create leg A ───────────│                        │           │
  │── call.initiated (A) ────>│                        │           │
  │                            │ Track leg A in cache   │           │
  │                    ┌───────│── SIP INVITE ─────────>│           │
  │                    │       │                        │           │
  │                    │       │ Call::create (Leg B)   │           │
  │<── create leg B ───│───────│                        │           │
  │── call.initiated (B) ────>│                        │           │
  │                    │       │ Track leg B in cache   │           │
  │                    │       │── SIP INVITE ──────────│──────────>│
  │                    │       │                        │           │
  │                    │       │   ┌── RACE: first to answer wins  │
  │── call.answered (A) ─────>│   │                    │           │
  │                    │       │   │ Cache::lock()      │           │
  │                    │       │   │ Mark A as winner   │           │
  │                    │       │   │                    │           │
  │                    │       │   │ answer() parent    │           │
  │<── answer parent ──│───────│   │                    │           │
  │                    │       │   │                    │           │
  │                    │       │   │ bridge(parent ↔ A) │           │
  │<── bridge ─────────│───────│   │                    │           │
  │── call.bridged ───────────>│   │                    │           │
  │                    │       │   │                    │           │
  │                    │       │   │ hangup(B)          │           │
  │<── hangup B ───────│───────│   └                    │           │
  │── call.hangup (B) ───────>│                        │           │
  │                    │       │                        │           │
  │      ═══ CALL ACTIVE ════════════════════════      │           │
  │                    │       │                        │           │
  │── call.hangup ────────────>│ (either party)        │           │
```

**Race condition resolution**: Z360 uses `Cache::lock("simring:{$parentId}:lock", 10)` to serialize the first-to-answer logic. Only the first device to answer wins the lock; subsequent `call.answered` events are ignored.

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2056-2104 in voip-backend skill)

### 3.4 Inbound Call → Voicemail

```
Telnyx                     Z360 Backend
  │                            │
  │── call.initiated ─────────>│
  │                            │ answer()
  │<── answer ─────────────────│
  │── call.answered ──────────>│
  │                            │ handleCall()
  │                            │ No receiving user OR all legs rejected
  │                            │ transferToVoicemail()
  │                            │
  │                            │ speak() voicemail greeting
  │<── speak command ──────────│   client_state: voicemail_greeting
  │                            │
  │── call.speak.ended ───────>│
  │                            │ onSpeakEnded()
  │                            │ record_start()
  │<── record_start command ───│   client_state: voicemail_parent
  │                            │
  │   ═══ RECORDING ═══       │
  │                            │
  │── call.hangup ───────────>│  (caller hangs up)
  │── call.recording.saved ──>│  callRecordingSaved()
  │                            │  Persist recording metadata
```

### 3.5 Inbound Call → AI Agent Transfer

```
Telnyx                     Z360 Backend                    AI Agent SIP
  │                            │                              │
  │── call.initiated ─────────>│                              │
  │                            │ answer() + handleCall()      │
  │                            │ Route: transferToAgent()     │
  │                            │                              │
  │                            │ transfer() with custom       │
  │                            │   SIP headers:               │
  │                            │   X-Tenant-Id                │
  │                            │   X-Thread-Id                │
  │                            │   X-Agent-Introduction       │
  │                            │   X-Agent-Voice              │
  │                            │   X-Conversation-Summary     │
  │<── transfer command ───────│                              │
  │                            │                              │
  │── call.initiated ─────────>│                              │
  │                       ┌────│── SIP INVITE + headers ─────>│
  │── call.answered ──────┘───>│                              │
  │── call.bridged ──────────>│                              │
  │                            │                              │
  │      ═══ AI CONVERSATION ═══════════════════════════════  │
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2495-2577 in voip-backend skill)

### 3.6 Complete Webhook Event Catalog

Events handled by Z360 controllers:

| Event | Handler | Controller | Purpose |
|-------|---------|------------|---------|
| `call.initiated` | `callInitiated()` + `handleCall()` | Base + Inbound | New call arrives → answer & route |
| `call.initiated` | `onSimultaneousRingLegInitiated()` | Inbound (via methodMap) | Track outbound ring leg in cache |
| `call.answered` | `callAnswered()` + `onCallAnswered()` | Base + Inbound | Device answered → lock + bridge |
| `call.hangup` | `onCallHangup()` | Inbound (via methodMap) | Cleanup, fallback to voicemail |
| `call.speak.ended` | `onSpeakEnded()` | Inbound (via methodMap) | Greeting done → start recording |
| `call.recording.saved` | `callRecordingSaved()` | Base | Persist recording URL/metadata |
| `call.bridged` | (not explicitly handled) | — | Implicit; no custom handler |

Events defined in the SDK but **not handled** by Z360:

| Event | Description |
|-------|-------------|
| `call.dtmf.received` | DTMF digit received |
| `call.gather.ended` | DTMF gathering completed |
| `call.playback.started/ended` | Audio playback lifecycle |
| `call.speak.started` | TTS playback started |
| `call.machine.detection.ended` | AMD result |
| `call.machine.greeting.ended` | AMD greeting end detected |
| `streaming.started/stopped/failed` | WebSocket stream lifecycle |
| `call.sip_info.received` | SIP INFO message |
| `siprec.started/stopped/failed` | SIPREC lifecycle |

---

## 4. client_state Mechanism

### 4.1 Encoding/Decoding

`client_state` is a **base64-encoded JSON string** that Telnyx passes back in every subsequent webhook for a call leg. This allows Z360 to maintain context across the asynchronous webhook lifecycle without server-side session state.

**Encoding** (when issuing commands):
```php
'client_state' => base64_encode(json_encode([
    'type' => 'simultaneous_ring_leg',
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
]))
```

**Decoding** (when receiving webhooks):
```php
public static function parseClientState(?string $clientState): array
{
    if (!$clientState) {
        return ['is_outbound' => false, 'user_id' => null, 'data' => null];
    }

    $decoded = base64_decode($clientState, true);
    $json = json_decode($decoded, true);
    $userId = $json['user_id'] ?? null;

    return [
        'is_outbound' => $userId !== null,
        'user_id' => $userId,
        'data' => $json,
    ];
}
```

> **Source**: `app/Services/CPaaSService.php` (lines 4274-4309 in voip-backend skill)

### 4.2 client_state Types

Z360 uses a `type` field within client_state to route webhook processing:

| Type | Context | Carried Data | Purpose |
|------|---------|-------------|---------|
| `user_call` | Standard inbound/transfer | `user_id`, `organization_id` | Normal call routed to a user's device |
| `simultaneous_ring_leg` | Outbound SIP leg to device | `parent_call_control_id`, `user_id`, `message_id` | Identifies this as one leg of a multi-ring |
| `simultaneous_ring_parent` | Original inbound call | `user_id` | Marks the parent call after answer-for-bridge |
| `voicemail_parent` | Call in voicemail mode | `user_id`, `message_id` | Call is recording a voicemail |
| `voicemail_greeting` | During greeting playback | `user_id`, `message_id` | Voicemail greeting is playing |

### 4.3 Direction Gating

The base `TelnyxCallController` uses `client_state` to determine call direction and prevent duplicate processing:

```php
protected function ensureDirection(): ?string
{
    $clientState = request()->input('data.payload.client_state');
    $parsed = CPaaSService::parseClientState($clientState);

    if ($parsed['is_outbound']) {
        return 'outgoing';
    }
    return 'incoming';
}
```

Both `TelnyxInboundWebhookController` (`direction = 'incoming'`) and `TelnyxOutboundWebhookController` (`direction = 'outgoing'`) declare their expected direction. If the webhook's direction doesn't match, the controller returns `204 No Content` and skips processing.

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxCallController.php` (lines 3417-3451 in voip-backend skill)

### 4.4 Idempotency

Z360 uses an `ensureIdempotent()` method to prevent duplicate processing of retried webhooks. If a webhook with the same event ID has already been processed, an `IdempotencyException` is thrown and the controller returns `200 OK`.

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxCallController.php` (lines 3352-3403 in voip-backend skill)

---

## 5. SIP Credential Management

### 5.1 Telnyx TelephonyCredential SDK Class

The PHP SDK's `TelephonyCredential` class (`src/TelephonyCredentials/TelephonyCredential.php`) represents a SIP credential bound to a Call Control connection.

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Credential identifier |
| `sipUsername` | string | Auto-generated SIP username |
| `sipPassword` | string | Auto-generated SIP password |
| `name` | string | Human-readable name |
| `connectionID` | string | Associated Call Control connection |
| `resourceID` | string | Associated resource |
| `expired` | bool | Whether credential has expired (default: false) |
| `expiresAt` | string | ISO-8601 expiration date |
| `createdAt` | string | ISO-8601 creation date |
| `updatedAt` | string | ISO-8601 update date |

**CRUD Operations:**

| Operation | SDK Method | Required Params |
|-----------|-----------|-----------------|
| **Create** | `TelephonyCredential::create()` | `connectionID` (required), `name`, `expiresAt`, `tag` (optional) |
| **Retrieve** | `TelephonyCredential::retrieve($id)` | credential ID |
| **Update** | `TelephonyCredential::update($id)` | `connectionID`, `name`, `expiresAt` (all optional) |
| **Delete** | `TelephonyCredential::delete($id)` | credential ID |
| **List** | `TelephonyCredential::list()` | filter, pagination params |
| **Token** | `$credential->token()` | — (generates JWT) |

### 5.2 Z360 Two-Tier Credential Architecture

Z360 implements a two-tier credential system:

#### Tier 1: Organization-Level Credentials

Created once per user-organization pair. Used for WebRTC browser sessions.

```php
// CPaaSService::handleCredentials()
$telephonyCredential = \Telnyx\TelephonyCredential::create([
    'name' => 'Org-'.$orgId.'_'.Str::random(8),
    'connection_id' => $connectionId,
]);

// Store locally
UserTelnyxTelephonyCredential::create([
    'user_id' => $user->id,
    'organization_id' => $orgId,
    'credential_id' => $telephonyCredential->id,
    'connection_id' => $connectionId,
    'sip_username' => $telephonyCredential->sip_username,
    'sip_password' => $telephonyCredential->sip_password,
]);
```

#### Tier 2: Per-Device Credentials

Created for each mobile device (iOS/Android). Prevents SIP registration conflicts between multiple devices.

```php
// CPaaSService::createDeviceCredential()
$credential = \Telnyx\TelephonyCredential::create([
    'name' => "Device-{$deviceToken->device_id}_".Str::random(8),
    'connection_id' => $connectionId,
]);

$deviceToken->update([
    'telnyx_credential_id' => $credential->id,
    'sip_username' => $credential->sip_username,
    'sip_password' => $credential->sip_password,
    'connection_id' => $connectionId,
    'credential_expires_at' => now()->addDays(30),
]);
```

> **Source**: `app/Services/CPaaSService.php` (lines 4316-4390 in voip-backend skill)

### 5.3 JWT Token Generation

WebRTC clients authenticate using JWT tokens generated from stored credentials:

```php
// CPaaSService::getDeviceJwt() / handleCredentials()
$cred = \Telnyx\TelephonyCredential::retrieve($existing->credential_id);
$token = $cred->token();  // Returns JWT with ~10-hour TTL (36000 seconds)
return is_string($token) ? trim($token) : null;
```

The JWT is passed to the mobile/web client, which uses it to register with Telnyx's WebRTC gateway for SIP signaling.

> **Source**: `app/Services/CPaaSService.php` (lines 4357-4360, 4410-4420 in voip-backend skill)

### 5.4 Credential Lifecycle

```
Device Login
    │
    ├── Check for existing credential in UserTelnyxTelephonyCredential
    │   ├── EXISTS & not expired → Retrieve JWT token
    │   └── NOT EXISTS → Create new TelephonyCredential
    │                    Store sip_username, sip_password locally
    │                    Generate JWT token
    │
    ├── Return JWT to client
    │
Device Active
    │
    ├── JWT expires (~10 hours) → Client requests new JWT
    │   └── Retrieve credential → $cred->token() → new JWT
    │
    ├── Credential expires (30 days for devices) → Create new credential
    │
Device Logout
    │
    └── CPaaSService::deleteTelnyxCredential()
        ├── Delete from Telnyx API
        └── Remove local record
```

### 5.5 Local Storage Model

```php
// UserTelnyxTelephonyCredential model
class UserTelnyxTelephonyCredential extends Model
{
    protected $table = 'user_telnyx_telephony_credentials';
    protected $fillable = [
        'user_id',
        'organization_id',
        'credential_id',       // Telnyx credential ID
        'connection_id',       // Call Control connection ID
        'sip_username',        // Auto-generated by Telnyx
        'sip_password',        // Auto-generated by Telnyx
        'credential_expires_at',
    ];
}
```

> **Source**: `app/Models/UserTelnyxTelephonyCredential.php` (lines 3009-3032 in voip-backend skill)

---

## 6. Call Bridging

### 6.1 Bridge Mechanics

Bridging connects two call legs so audio flows bidirectionally. In Telnyx's model:

1. Both legs must be in the `answered` state (or you can set `playRingtone: true` for unanswered legs).
2. You issue `bridge` on **one** leg, passing the other leg's `call_control_id`.
3. Telnyx sends `call.bridged` webhooks to **both** legs.
4. When either leg hangs up, the bridge breaks. The remaining leg either hangs up (default) or parks (if `parkAfterUnbridge: 'self'`).

### 6.2 Z360 Answer-Then-Bridge Pattern

Z360 uses an explicit answer-then-bridge sequence for simultaneous ringing, rather than the auto-bridge behavior of `transfer`:

```
1. Inbound call arrives → answer parent call (keeps it alive)
2. Create N outbound legs via Call::create (one per device)
3. First device answers → lock acquired
4. Answer parent call again with new client_state (simultaneous_ring_parent)
5. Bridge parent ↔ winning leg
6. Hangup all losing legs
7. Start recording on the bridged call
```

**Code sequence** (from `onCallAnswered()`):

```php
// Step 1: Acquire lock (prevents race conditions)
$lock = \Cache::lock("simring:{$parentId}:lock", 10);
if (!$lock->get()) {
    return; // Another answer already in progress
}

// Step 2: Check if already answered
if ($ringSession && !$ringSession['answered']) {
    // Step 3: Mark as answered
    $ringSession['answered'] = true;
    $ringSession['answered_leg'] = $legCallControlId;
    \Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));

    // Step 4: Answer the parent call
    \Telnyx\Call::constructFrom(['call_control_id' => $parentId])
        ->answer([
            'client_state' => base64_encode(json_encode([
                'type' => 'simultaneous_ring_parent',
                'user_id' => $data['user_id'] ?? null,
            ])),
        ]);

    // Step 5: Bridge parent to winning device
    \Telnyx\Call::constructFrom(['call_control_id' => $parentId])
        ->bridge(['call_control_id' => $legCallControlId]);

    // Step 6: Hangup all other legs
    foreach ($ringSession['legs'] as $otherLeg) {
        if ($otherLeg !== $legCallControlId) {
            \Telnyx\Call::constructFrom(['call_control_id' => $otherLeg])
                ->hangup();
        }
    }
}
```

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 2056-2104 in voip-backend skill)

### 6.3 Bridge Failure Modes

| Failure Mode | Cause | Z360 Handling |
|-------------|-------|---------------|
| **Leg not answered** | Device didn't pick up before bridge | Would fail silently; Z360 only bridges after `call.answered` |
| **Leg already hungup** | Device hung up between answer and bridge | Telnyx API error; caught by try/catch |
| **Lock contention** | Two devices answer simultaneously | `Cache::lock()` serializes; second answer is ignored |
| **All legs rejected** | Every device declined | `onSimultaneousRingLegHangup()` detects all legs done → voicemail fallback |
| **Parent hung up** | Caller hung up during ring | `onSimultaneousRingParentHangup()` → hangup the answered leg |
| **Network timeout** | API call to Telnyx fails | Caught by general exception handler; logged via VoipLog |

---

## 7. Simultaneous Ringing

### 7.1 Architecture Overview

Z360's simultaneous ringing creates **N independent outbound call legs** (one per registered SIP device) and races them against each other. The first to answer wins; all others are hung up.

This differs from `transfer` (which creates a single destination leg with auto-bridge) and requires manual orchestration of:
- Leg creation
- Session tracking
- Answer race resolution
- Bridge establishment
- Loser cleanup
- Fallback routing

### 7.2 Session Tracking via Cache

Z360 stores ring session state in Laravel's cache (Redis):

```
Cache Key: "simring:{$parentCallControlId}"
TTL: 10 minutes

Value: {
    "parent_call_control_id": "v3:abc...",
    "legs": ["v3:leg1...", "v3:leg2...", "v3:leg3..."],
    "answered": false,
    "answered_leg": null,
    "user_id": 42,
    "message_id": 123
}
```

### 7.3 Leg Lifecycle

Each outbound leg goes through these webhook events:

```
Call::create()
    │
    ├── call.initiated  → onSimultaneousRingLegInitiated()
    │                     Track leg ID in cache session
    │
    ├── call.answered   → onCallAnswered()
    │   ├── Win race    → Answer parent + Bridge + Hangup others
    │   └── Lose race   → Ignored (lock not acquired)
    │
    └── call.hangup     → onSimultaneousRingLegHangup()
        ├── Rejected by device → Check if all legs done
        │   ├── All done, none answered → transferToVoicemail()
        │   └── Others still ringing → Wait
        └── Hung up by Z360 (loser) → No action needed
```

### 7.4 Single vs Multi-Device Decision

Z360 chooses between `transfer` (simple) and `Call::create` (simultaneous ring) based on the number of registered SIP destinations:

```php
// TelnyxInboundWebhookController::transferToUser()
if (count($sipDestinations) === 1) {
    // Simple: use transfer() with auto-bridge
    $call->transfer([
        'to' => "sip:{$sipDestinations[0]}@sip.telnyx.com",
        ...
    ]);
} else {
    // Multi-device: use Call::create() for each + manual bridge
    foreach ($sipDestinations as $sip) {
        \Telnyx\Call::create([
            'to' => "sip:{$sip}@sip.telnyx.com",
            'connection_id' => $connectionId,
            'webhook_url' => CPaaSService::tunnelSafeUrl('/webhooks/cpaas/telnyx/call-control'),
            ...
        ]);
    }
}
```

**Key difference**: `transfer` handles bridging automatically, while `Call::create` requires the application to explicitly `answer()` the parent and `bridge()` the two legs together.

> **Source**: `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` (lines 1859-1946 in voip-backend skill)

### 7.5 Call::create Parameters for Ring Legs

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `to` | `sip:{credential_sip_username}@sip.telnyx.com` | SIP URI targeting specific device credential |
| `from` | Original caller's phone number | Preserves caller ID |
| `connection_id` | Organization's Call Control connection | Required for outbound calls |
| `webhook_url` | `CPaaSService::tunnelSafeUrl(...)` | Ensures webhooks reach the correct endpoint (supports ngrok tunnels) |
| `timeout_secs` | `30` | Ring for 30 seconds before giving up |
| `client_state` | Base64 JSON with `type: simultaneous_ring_leg` | Identifies this as a ring leg with parent reference |

### 7.6 Webhook URL Management

Z360 uses `CPaaSService::tunnelSafeUrl()` to generate webhook URLs that work in both production and development environments:

```php
public static function tunnelSafeUrl(string $path = '/'): string
{
    $host = config('app.tunnel_host');
    $normalizedPath = '/'.ltrim($path, '/');

    if ($host !== '') {
        return (str_starts_with($host, 'http') ? '' : 'https://') . rtrim($host, '/') . $normalizedPath;
    }

    return url($normalizedPath);
}
```

This allows development with ngrok or similar tunneling tools while using the standard `url()` helper in production.

> **Source**: `app/Services/CPaaSService.php` (lines 4247-4264 in voip-backend skill)

---

## 8. Gaps & Observations

### 8.1 SDK Capabilities Not Used by Z360

| SDK Feature | Potential Use Case |
|-------------|-------------------|
| `ActionRejectParams` | Reject calls with SIP cause codes instead of answering + speaking a blocked message |
| `ActionGatherParams` / `ActionGatherUsingSpeakParams` | IVR menus, DTMF-based routing |
| `ActionStartPlaybackParams` | Pre-recorded audio playback (currently uses `speak` for TTS only) |
| `ActionEnqueueParams` / `ActionLeaveQueueParams` | Call queuing for contact centers |
| `ActionReferParams` | SIP REFER for blind transfers |
| `ActionStartStreamingParams` | Real-time audio streaming to WebSocket (for AI processing) |
| `ActionStartTranscriptionParams` | Live call transcription |
| `ActionStartNoiseSuppressionParams` | Noise cancellation |
| `ActionSwitchSupervisorRoleParams` | Call supervision (barge/whisper/monitor) |
| `ActionUpdateClientStateParams` | Mid-call client_state updates |
| `parkAfterUnbridge` | Call parking after bridge ends (used in transfer but not explicitly for hold) |
| `bridgeOnAnswer` / `linkTo` in `CallDialParams` | Automatic bridge on answer without manual bridge command |

### 8.2 Z360 Patterns vs SDK Patterns

| Aspect | Z360 Approach | SDK Alternative |
|--------|---------------|-----------------|
| **HTTP Client** | Mixed: SDK for call control, Guzzle for phone number/messaging APIs | SDK provides unified client for all APIs |
| **Simultaneous Ring** | Manual `Call::create` + cache + lock | Could use `bridgeOnAnswer: true` + `linkTo` in `CallDialParams` to simplify |
| **Blocked Caller** | `answer()` + `speak()` blocked message | Could use `ActionRejectParams` with `cause: 'reject'` to save a call leg |
| **Voicemail Audio** | TTS via `speak()` | Could use `ActionStartPlaybackParams` for pre-recorded greetings |
| **Recording** | `record_start()` after speak ends | `record: 'record-from-answer'` param available on `answer()`, `bridge()`, and `transfer()` |

### 8.3 Potential Improvements

1. **`bridgeOnAnswer` simplification**: `CallDialParams` supports `bridgeOnAnswer: true` with `linkTo` (parent call_control_id). This could eliminate the manual answer→bridge sequence in simultaneous ringing, though it would remove the ability to hang up losing legs before bridge.

2. **`command_id` for idempotency**: Z360 uses application-level idempotency (`ensureIdempotent()` on webhooks), but does not appear to use `command_id` on outgoing commands. Adding `command_id` to critical commands (bridge, hangup) would prevent duplicate command execution on retries.

3. **`call.bridged` event handling**: Z360 does not explicitly handle `call.bridged` events. While not strictly necessary (bridge success is implied by the command succeeding), handling it could provide better observability and error detection.

4. **`parkAfterUnbridge` for hold**: The bridge command supports `parkAfterUnbridge: 'self'` which could enable call hold functionality without hanging up.

### 8.4 Architectural Notes

- **No outbound call origination**: Z360 currently only handles inbound calls. The `TelnyxOutboundWebhookController` exists but is minimal (41 lines). All `Call::create` usage is for simultaneous ring legs, not user-initiated outbound calls.

- **Single webhook endpoint**: All call control events route through one URL path, with direction-based controller selection. This is clean but means both inbound and outbound events hit the same endpoint and must be filtered.

- **Cache dependency for state**: Simultaneous ring session state lives in cache (Redis) with 10-minute TTL. If cache is flushed or expires mid-call, ring session coordination would break. The `TelnyxWebhook` data objects provide call metadata in each webhook, but the ring session coordination requires the cache.

- **Tunnel URL pattern**: The `tunnelSafeUrl()` helper is critical for development with ngrok but introduces a configuration dependency. If `app.tunnel_host` is misconfigured, all outbound call legs would have unreachable webhook URLs.

---

## Appendix: File Reference Index

| Component | File Path |
|-----------|-----------|
| Base webhook controller | `app/Http/Controllers/Webhooks/Telnyx/TelnyxCallController.php` |
| Inbound webhook controller | `app/Http/Controllers/Webhooks/Telnyx/TelnyxInboundWebhookController.php` |
| Outbound webhook controller | `app/Http/Controllers/Webhooks/Telnyx/TelnyxOutboundWebhookController.php` |
| CPaaS service (credentials, HTTP, utils) | `app/Services/CPaaSService.php` |
| Credential model | `app/Models/UserTelnyxTelephonyCredential.php` |
| Device token model | `app/Models/UserDeviceToken.php` |
| Webhook data: call initiated | `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php` |
| Webhook data: base | `app/Data/Telnyx/TelnyxWebhook.php` |
| Route registration | `routes/web.php` → `/webhooks/cpaas/telnyx/call-control` |

### PHP SDK Pack References

| Component | Pack Path |
|-----------|-----------|
| Answer params | `src/Calls/Actions/ActionAnswerParams.php` |
| Bridge params | `src/Calls/Actions/ActionBridgeParams.php` |
| Transfer params | `src/Calls/Actions/ActionTransferParams.php` |
| Hangup params | `src/Calls/Actions/ActionHangupParams.php` |
| Speak params | `src/Calls/Actions/ActionSpeakParams.php` |
| Recording params | `src/Calls/Actions/ActionStartRecordingParams.php` |
| Dial/Create params | `src/Calls/CallDialParams.php` |
| Telephony credential | `src/TelephonyCredentials/TelephonyCredential.php` |
| Credential create params | `src/TelephonyCredentials/TelephonyCredentialCreateParams.php` |
