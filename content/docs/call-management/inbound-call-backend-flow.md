---
title: Inbound Call Backend Flow
---

# Backend Inbound Call Flow: Complete Laravel Trace

> **Research Date**: 2026-02-08
> **Researcher**: Backend Call Flow Tracer
> **Sources**: Live Z360 Laravel codebase + voip-backend skill

---

## Executive Summary

This document traces the complete inbound call flow through the Z360 Laravel backend, from the moment Telnyx receives a PSTN call until it terminates. The flow involves webhook processing, simultaneous ring orchestration, distributed locking, push notifications, WebSocket broadcasting, and call recording.

**Key Infrastructure**:
- **Webhook Entry**: `POST /webhooks/cpaas/telnyx/call-control` → `TelnyxInboundWebhookController`
- **Orchestration**: Simultaneous ring to all user devices (native mobile + web sessions)
- **Coordination**: Redis-based distributed locking + cache for ring session state
- **Notifications**: FCM (Android) + APNs (iOS) + Reverb (Web)
- **Recording**: Dual-channel WAV on bridged parent call

---

## Table of Contents

1. [Webhook Infrastructure](#1-webhook-infrastructure)
2. [Step 1: Call Arrives (call.initiated)](#2-step-1-call-arrives-callinitiated)
3. [Step 2: Simultaneous Ring Setup](#3-step-2-simultaneous-ring-setup)
4. [Step 3: Device Answers (call.answered)](#4-step-3-device-answers-callanswered)
5. [Step 4: Call In Progress](#5-step-4-call-in-progress)
6. [Step 5: Call Ends (call.hangup)](#6-step-5-call-ends-callhangup)
7. [Payload Structures](#7-payload-structures)
8. [Cache Key Structures](#8-cache-key-structures)
9. [Error Handling & Edge Cases](#9-error-handling--edge-cases)
10. [Gaps & Issues](#10-gaps--issues)

---

## 1. Webhook Infrastructure

### 1.1 Route Definition

**File**: `routes/webhooks.php:40-42`

```php
Route::post('/cpaas/telnyx/call-control', TelnyxInboundWebhookController::class);
Route::post('/cpaas/telnyx/call-control/failover', [TelnyxInboundWebhookController::class, 'failover']);
```

All webhooks are **public endpoints** (no auth middleware). Telnyx sends webhooks for all call events to this URL.

### 1.2 Controller Hierarchy

**Base Controller**: `app/Http/Controllers/Telnyx/TelnyxCallController.php` (375 lines)
- Abstract base class defining common webhook handling logic
- `__invoke(Request $request)`: Main entry point (lines 42-97)
  1. Parses webhook via `TelnyxWebhook::from($request)`
  2. Validates direction via `ensureDirection()`
  3. Dispatches to event-specific methods based on `$eventType`
  4. Handles idempotency via `IdempotencyException`

**Inbound Controller**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` (1,060 lines)
- Extends `TelnyxCallController`
- `protected string $direction = 'incoming'` (line 19)
- Method map (lines 21-38):
  - `call.initiated` → `onSimultaneousRingLegInitiated()`
  - `call.answered` → `onCallAnswered()`
  - `call.hangup` → `onCallHangup()`
  - `call.speak.ended` → `onSpeakEnded()` (for voicemail)

### 1.3 Data Layer: Webhook Parsing

**Data Objects**: `app/Data/Telnyx/`

```
TelnyxWebhook
├── data: TelnyxWebhookData
│   ├── event_type: string (e.g., "call.initiated")
│   ├── payload: TelnyxBaseCallPayloadData (polymorphic cast)
│   │   ├── call_control_id: string
│   │   ├── call_session_id: string
│   │   ├── from: string
│   │   ├── to: string
│   │   ├── direction: 'incoming' | 'outgoing'
│   │   └── client_state: ?string (base64-encoded JSON)
│   └── ...
└── meta: TelnyxWebhookMeta
```

**client_state Structure**: All Telnyx calls include a base64-encoded JSON payload with metadata:

```json
{
  "type": "simultaneous_ring_leg" | "simultaneous_ring_parent" | "voicemail_parent" | "user_call",
  "parent_call_control_id": "v3:xxx",
  "user_id": 123,
  "message_id": 456,
  "organization_id": 789
}
```

Parsed via `CPaaSService::parseClientState()` (`app/Services/CPaaSService.php:119-152`)

---

## 2. Step 1: Call Arrives (call.initiated)

### 2.1 Webhook Event

**Trigger**: Telnyx receives PSTN inbound call to a Z360 phone number
**Webhook**: `POST /webhooks/cpaas/telnyx/call-control`
**Event Type**: `call.initiated`

**Controller Method**: `TelnyxInboundWebhookController::handleCall()` (lines 43-114)

### 2.2 Call Processing Flow

#### 2.2.1 Data Extraction

```php
$data = \App\Data\Telnyx\Calls\TelnyxCallInitiatedData::fromRequest(request());
$message = $data->message();
```

**File**: `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php`

- `message()`: Finds `Message` by `call_session_id` or creates new one
- `channel()`: Resolves `AuthenticatedPhoneNumber` from the called number (`to` for incoming)
- `organization()`: Resolves organization from channel
- `recipient()`: Returns caller's number (`from` for incoming)

#### 2.2.2 Blocked Caller Check

**Lines 51-73**: If `$message->identifier->is_blocked`:
1. Answer call: `\Telnyx\Call::answer()`
2. Speak message: `\Telnyx\Call::speak()` with "This number has blocked calls."
3. Hang up: `\Telnyx\Call::hangup()`
4. Return early

#### 2.2.3 Schedule Check

**Lines 76-78**: Check if call is within business hours
```php
$settings = OrganizationSetting::get(['cpaas_schedule', 'unavailability_option']);
$schedule = $settings->cpaas_schedule;
$isWithin = \App\Services\Utils::withinSchedule($schedule);
```

#### 2.2.4 Receiving User Resolution

**Lines 80-81**:
```php
$receivingUser = $data->channel()?->receivingUser;
```

The `AuthenticatedPhoneNumber` model has a `receivingUser` relationship that determines which user should receive calls to this number.

#### 2.2.5 Routing Decision Tree

**Lines 82-113**:

```
if (!$receivingUser):
    → transferToVoicemail()
else:
    if ($isWithin):  // Within business hours
        if ($receivingUser->id !== 0):  // Real user (not AI agent)
            → transferToUser()
        else:
            → transferToAgent()  // AI agent transfer
    else:  // Outside business hours
        if ($unavailability_option === 'voicemail'):
            → transferToVoicemail()
        else:
            → transferToAgent()
```

**Metadata Updates** (lines 86-93):
```php
$message->updateMetadata('original_from', $data->from);
$message->updateMetadata('received_by', $receivingUser->id);
$message->updateMetadata('parent_call_control_id', $data->call_control_id);
$message->save();
```

This metadata is critical for correlation throughout the call lifecycle.

---

## 3. Step 2: Simultaneous Ring Setup

### 3.1 Entry Point

**Method**: `TelnyxInboundWebhookController::transferToUser()` (lines 212-396)

**Parameters**:
- `$call_control_id`: Parent call control ID from Telnyx webhook
- `$message`: Message model instance
- `$user`: User model instance (receiving user)

### 3.2 Device Token Collection

**Lines 214-223**: Query all device tokens and SIP credentials for the user

```php
$sipUsername = $user?->telnyxCredential?->sip_username;  // Org-level (NOT dialed)
$fcmTokens = UserDeviceToken::getFcmTokensForUser($user->id);  // Android
$apnsTokens = UserDeviceToken::getApnsVoipTokensForUser($user->id);  // iOS
$organization = CurrentTenant::get();
```

**Critical Context** (lines 264-266):
```php
// NOTE: Org-level credential ($sipUsername) is NOT dialed — it exists only for web JWT auth.
// Dialing it creates a phantom SIP leg that answers first and steals the bridge.
```

### 3.3 Push Notification Dispatch

#### 3.3.1 Mobile Push (Android + iOS)

**Lines 234-242**: Send push to mobile devices via `sendIncomingCallPush()`

**Method**: `TelnyxInboundWebhookController::sendIncomingCallPush()` (lines 401-446)
**Service**: `PushNotificationService::sendIncomingCallPush()` (lines 20-157)

**Push Payload Structure**:

```php
[
    'type' => 'incoming_call',
    'call_session_id' => 'xxx',          // For correlation
    'call_control_id' => 'v3:xxx',       // Parent call control ID
    'caller_number' => '+15551234567',   // Original caller
    'caller_name' => 'John Doe',         // From contact lookup
    'channel_number' => '+15559876543',  // Called number
    'caller_avatar' => 'https://...',    // Optional
    'call_id' => 'xxx',                  // Same as call_session_id
    'organization_id' => '123',
    'organization_name' => 'Acme Inc',
    'organization_slug' => 'acme',
    'timestamp' => '1234567890',
]
```

**Delivery**:
- **Android**: FCM HTTP v1 API via `PushNotificationService::sendFcmMessage()`
  - Priority: `high`, TTL: `60s`
  - Data-only message (no notification, pure data payload)
- **iOS**: APNs VoIP via `ApnsVoipService::sendVoipPush()`
  - VoIP push channel (wakes app even if terminated)
  - Payload includes `aps: { content-available: 1 }`

#### 3.3.2 Web Broadcast

**Lines 246-262**: Always broadcast to web sessions via Laravel Reverb

**Event**: `App\Events\IncomingCallNotification` (implements `ShouldBroadcast`)

```php
event(new IncomingCallNotification(
    user: $user,
    callSessionId: $callSessionId,
    callControlId: $call_control_id,
    callerNumber: $callerNumber,
    callerName: $callerName,
    channelNumber: $channelNumber,
    organizationId: $organization?->id,
    organizationName: $organization?->name,
));
```

**Broadcast Details** (`app/Events/IncomingCallNotification.php`):
- Channel: `TenantPrivateChannel("App.Models.User.{$user->id}", $organizationId)`
- Event Name: `incoming_call`
- Payload: Same fields as above (lines 46-55)

### 3.4 SIP Destination Collection

**Lines 267-278**: Query per-device SIP credentials

```php
$sipDestinations = UserDeviceToken::where('user_id', $user->id)
    ->whereNotNull('sip_username')
    ->where('last_active_at', '>=', now()->subDay())  // Only recently active devices
    ->pluck('sip_username')
    ->toArray();
```

**Why per-device credentials?** Each device gets its own SIP identity for simultaneous ring. Telnyx can fork SIP INVITEs to multiple destinations.

**No devices? Route to voicemail** (lines 273-278).

### 3.5 Single Device Transfer (Lines 281-303)

If only 1 device SIP credential exists, use simple transfer:

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

**Result**: Parent call is transferred to single SIP destination. Call rings on that device.

### 3.6 Multi-Device Simultaneous Ring (Lines 304-395)

When multiple device SIP credentials exist, Z360 implements **manual simultaneous ring**:

#### 3.6.1 Create Outbound Legs (Lines 311-333)

For each SIP destination, create a new Telnyx outbound call leg:

```php
foreach ($sipDestinations as $sip) {
    \Telnyx\Call::create([
        'to' => "sip:{$sip}@sip.telnyx.com",
        'from' => $message->metadata['original_from'],
        'connection_id' => config('cpaas.telnyx.call_control_id'),  // Call Control App
        'webhook_url' => CPaaSService::tunnelSafeUrl('/webhooks/cpaas/telnyx/call-control'),
        'timeout_secs' => 30,
        'client_state' => base64_encode(json_encode([
            'type' => 'simultaneous_ring_leg',              // LEG marker
            'parent_call_control_id' => $call_control_id,   // Parent reference
            'user_id' => $user->id,
            'message_id' => $message->id,
            'organization_id' => $organization?->id,
        ])),
    ]);
    $createdLegs[] = $sip;
}
```

**Key Points**:
- `connection_id`: Uses Call Control Application (not Credential Connection)
- `webhook_url`: Points back to same inbound webhook endpoint
- `client_state.type`: `"simultaneous_ring_leg"` marks this as a ring leg
- `parent_call_control_id`: Links leg to parent for coordination

**Retry Logic** (lines 335-368): If all legs fail to create, retry once after 2 seconds. If still failed, route to voicemail.

#### 3.6.2 Parent Call State: PARKED

**Lines 371-374**: The parent call is **NOT answered** during ring setup

```php
// Do NOT answer the parent call here — leave it parked so the
// PSTN caller continues to hear ringback from their carrier.
// The parent will be answered in onSimultaneousRingAnswered()
// only when a device actually picks up.
```

**What the caller hears**: The PSTN caller continues hearing carrier-provided ringback tone. The parent call remains in "ringing" state until a device answers.

#### 3.6.3 Ring Session Cache (Lines 377-383)

```php
\Cache::put("simring:{$call_control_id}", [
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
    'answered' => false,
    'leg_ids' => [],  // Populated as call.initiated webhooks arrive
], now()->addMinutes(10));
```

**TTL**: 10 minutes (far exceeds typical 30-second ring timeout)

#### 3.6.4 Leg Tracking (Lines 784-816)

As each outbound leg initiates, Telnyx sends `call.initiated` webhook with the leg's `call_control_id`.

**Method**: `onSimultaneousRingLegInitiated()` (lines 784-816)

```php
$legCallControlId = $payload['call_control_id'];
$ringSession = \Cache::get("simring:{$parentId}");
if ($ringSession) {
    $ringSession['leg_ids'][] = $legCallControlId;
    \Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
}
```

**Result**: `leg_ids` array is populated with all active ring leg `call_control_id` values for later cleanup.

---

## 4. Step 3: Device Answers (call.answered)

### 4.1 Webhook Event

**Trigger**: One of the SIP destinations (mobile device) answers the call
**Webhook**: `POST /webhooks/cpaas/telnyx/call-control`
**Event Type**: `call.answered`

**client_state**:
```json
{
  "type": "simultaneous_ring_leg",
  "parent_call_control_id": "v3:parent-xxx",
  "user_id": 123,
  "message_id": 456,
  "organization_id": 789
}
```

### 4.2 Answer Handler Routing

**Method**: `TelnyxInboundWebhookController::onCallAnswered()` (lines 452-596)

**Lines 454-469**: Parse `client_state` and route based on type:
- `type: "voicemail_parent"` → `onVoicemailParentAnswered()` (voicemail greeting)
- `type: "simultaneous_ring_leg"` → Process answer (continue below)
- Other types: Return early

### 4.3 Distributed Lock Acquisition

**Lines 479-489**: Acquire distributed lock to prevent race condition

```php
$lock = \Cache::lock("simring:{$parentId}:lock", 10);  // 10-second timeout
if (!$lock->get()) {
    // Another device already answered, hang up this leg
    \Telnyx\Call::constructFrom(['call_control_id' => $legCallControlId])->hangup();
    return;
}
```

**Why lock?** If two devices answer within milliseconds, only one should bridge to the parent. The lock ensures atomic "check answered flag + set answered flag" operation.

### 4.4 Ring Session State Check

**Lines 492-498**: Check if this is the first device to answer

```php
$ringSession = \Cache::get("simring:{$parentId}");
if ($ringSession && !$ringSession['answered']) {
    // First to answer — proceed with bridge
    $ringSession['answered'] = true;
    $ringSession['answered_leg'] = $legCallControlId;
    \Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```

### 4.5 Bridge Establishment

#### 4.5.1 Answer Parent Call (Lines 502-517)

```php
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])->answer([
    'client_state' => base64_encode(json_encode([
        'type' => 'simultaneous_ring_parent',  // Parent type for hangup routing
        'user_id' => $data['user_id'],
        'message_id' => $data['message_id'],
        'organization_id' => $data['organization_id'],
    ])),
]);
```

**Key Change**: Parent call transitions from "parked/ringing" to "answered". PSTN caller now hears silence (or Telnyx default comfort noise) until bridge completes.

#### 4.5.2 Bridge Parent to Answered Leg (Lines 519-525)

```php
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])
    ->bridge(['call_control_id' => $legCallControlId]);
```

**Result**: Telnyx establishes audio bridge between:
- **Parent Call** (PSTN caller)
- **Answered Leg** (SIP device that answered)

Audio flows bidirectionally. Caller and answerer can now speak.

#### 4.5.3 Start Recording (Lines 532-544)

```php
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])->record_start([
    'format' => 'wav',
    'channels' => 'dual',          // Separate tracks for each party
    'trim' => 'trim-silence',
    'custom_file_name' => (string) $messageId,
]);
```

**Recording on parent**: Ensures `call_session_id` matches parent's message for easy correlation.

### 4.6 Cleanup: Hang Up Other Legs

**Lines 546-556**: Terminate all other ringing legs

```php
foreach ($ringSession['leg_ids'] as $otherLegId) {
    if ($otherLegId !== $legCallControlId) {
        \Telnyx\Call::constructFrom(['call_control_id' => $otherLegId])->hangup();
    }
}
```

**Result**: Other devices stop ringing immediately.

### 4.7 Dismiss Notifications on Other Devices

#### 4.7.1 Web Broadcast

**Lines 558-573**: Broadcast `CallEndedNotification` to web sessions

```php
event(new CallEndedNotification(
    userId: $userId,
    callSessionId: $callSessionId,
    reason: 'answered_elsewhere',
    organizationId: $organizationId,
));
```

**Event**: `App\Events\CallEndedNotification` (implements `ShouldBroadcast`)
- Channel: `TenantPrivateChannel("App.Models.User.{$userId}", $organizationId)`
- Event Name: `call_ended`
- Payload: `{ call_session_id, reason: 'answered_elsewhere' }`

#### 4.7.2 Mobile Push

**Line 576**: Send push to dismiss mobile ringing UI

```php
PushNotificationService::sendCallEndedPush($userId, $callSessionId);
```

**Push Payload**:
```php
[
    'type' => 'call_ended',
    'call_session_id' => 'xxx',
]
```

Both FCM (Android) and APNs (iOS) receive this payload.

### 4.8 Lock Release

**Lines 593-595**: Always release lock in `finally` block

```php
} finally {
    $lock->release();
}
```

### 4.9 Already Answered Race Condition

**Lines 584-592**: If lock was acquired but `$ringSession['answered']` is already true (edge case):

```php
else {
    // Someone already answered — hang up this leg
    \Telnyx\Call::constructFrom(['call_control_id' => $legCallControlId])->hangup();
}
```

This handles the race where two `call.answered` webhooks arrive nearly simultaneously, and the first one sets `answered: true` before the second acquires the lock.

---

## 5. Step 4: Call In Progress

### 5.1 Bridge State

After successful bridge:
- **Parent call**: Answered + bridged to device leg + recording
- **Answered leg**: Answered + bridged to parent
- **Other legs**: Hung up
- **Web sessions**: Dismissed via `CallEndedNotification`
- **Mobile devices**: Dismissed via `call_ended` push

### 5.2 Webhooks During Call

Telnyx may send additional webhooks during the bridged call:
- `call.bridged`: Confirms bridge establishment
- `call.recording.saved`: Fired when recording completes (after hangup)

These are handled by the base controller or ignored if not in `methodMap`.

### 5.3 Call Duration Tracking

Call duration is tracked via Telnyx webhook timestamps:
- `call.initiated` → `start_time`
- `call.hangup` → `end_time`

Duration calculation occurs in the `call.hangup` handler.

---

## 6. Step 5: Call Ends (call.hangup)

### 6.1 Webhook Event

**Trigger**: Either party hangs up (PSTN caller or SIP device)
**Webhook**: `POST /webhooks/cpaas/telnyx/call-control`
**Event Type**: `call.hangup`

**Payload Fields** (`TelnyxCallHangupData`):
- `call_control_id`
- `call_session_id`
- `hangup_cause`: `originator_cancel`, `normal_clearing`, `user_busy`, `no_answer`, etc.
- `hangup_source`: `caller`, `callee`, etc.
- `sip_hangup_cause`: SIP response code (e.g., `480`, `486`)
- `start_time`, `end_time`: ISO timestamps

### 6.2 Hangup Handler Routing

**Method**: `TelnyxInboundWebhookController::onCallHangup()` (lines 116-210)

**Lines 119-127**: Parse `client_state` and route based on type:
- `type: "simultaneous_ring_leg"` → `onSimultaneousRingLegHangup()`
- `type: "simultaneous_ring_parent"` → `onSimultaneousRingParentHangup()`
- Other types → Process as normal call hangup (continue below)

### 6.3 Normal Call Hangup (Non-Simring)

**Lines 135-209**: Handle hangup for single-device or already-bridged calls

#### 6.3.1 Find Message & User

**Lines 138-146**:
```php
$message = $data->message();  // Find by call_session_id
$userId = $message->metadata['received_by'] ?? $message->conversation?->channel?->receiving_user_id;
$organizationId = $message->conversation?->channel?->organization_id;
```

#### 6.3.2 Dismiss Notifications

**Lines 148-162**: Send `call_ended` push + broadcast

```php
if ($userId) {
    PushNotificationService::sendCallEndedPush($userId, $data->call_session_id);

    event(new CallEndedNotification(
        userId: $userId,
        callSessionId: $data->call_session_id,
        reason: $data->hangup_cause ?? 'unknown',
        organizationId: $organizationId,
    ));
}
```

**Purpose**: Ensure web sessions and mobile devices dismiss any active call UI, even if call ended unexpectedly.

#### 6.3.3 Early Return: Originator Cancel

**Lines 171-173**: If caller hung up before anyone answered:

```php
if ($data->hangup_cause === 'originator_cancel') {
    return;  // No voicemail fallback needed
}
```

#### 6.3.4 Voicemail Fallback

**Lines 177-209**: Route to voicemail if call was never answered

```php
$shouldFallbackToVoicemail = $data->hangup_cause === 'user_busy'
    || $data->sip_hangup_cause == '480'  // Temporarily Unavailable
    || $data->hangup_cause === 'no_answer'
    || $data->hangup_cause === 'timeout';

if ($shouldFallbackToVoicemail) {
    // Check if call was already answered
    $parentId = $message->metadata['parent_call_control_id'];
    $ringSession = \Cache::get("simring:{$parentId}");
    if ($ringSession && ($ringSession['answered'] ?? false)) {
        // Call was bridged, skip voicemail
        return;
    }

    $this->transferToVoicemail($parentId, $message);
}
```

### 6.4 Simultaneous Ring Parent Hangup

**Method**: `onSimultaneousRingParentHangup()` (lines 603-666)

**Trigger**: Parent call hung up (PSTN caller ended call after bridge)

**client_state**:
```json
{
  "type": "simultaneous_ring_parent",
  "user_id": 123,
  "message_id": 456,
  "organization_id": 789
}
```

#### 6.4.1 Find Bridged Leg

**Lines 620-638**:
```php
$ringSession = \Cache::get("simring:{$parentCallControlId}");
if ($ringSession && ($ringSession['answered'] ?? false)) {
    $answeredLeg = $ringSession['answered_leg'];
    if ($answeredLeg) {
        \Telnyx\Call::constructFrom(['call_control_id' => $answeredLeg])->hangup();
    }
}
```

**Result**: When parent hangs up, the bridged device leg is also hung up, ending the call on both sides.

#### 6.4.2 Cleanup Cache

**Lines 642-644**:
```php
\Cache::forget("simring:{$parentCallControlId}");
```

#### 6.4.3 Notify User

**Lines 647-664**: Send `call_completed` push + broadcast

```php
PushNotificationService::sendCallEndedPush($userId, $callSessionId);

event(new CallEndedNotification(
    userId: $userId,
    callSessionId: $callSessionId,
    reason: 'call_completed',
    organizationId: $organizationId,
));
```

### 6.5 Simultaneous Ring Leg Hangup

**Method**: `onSimultaneousRingLegHangup()` (lines 672-779)

**Trigger**: One of the ring legs hung up (device rejected, timeout, or answered device ended call)

#### 6.5.1 Already Answered: End Call

**Lines 694-743**: If this is the **answered leg** hanging up:

```php
if ($ringSession['answered']) {
    $answeredLeg = $ringSession['answered_leg'];
    if ($answeredLeg === $legCallControlId) {
        // Answered device hung up, end parent call
        \Telnyx\Call::constructFrom(['call_control_id' => $parentId])->hangup();

        // Notify user
        PushNotificationService::sendCallEndedPush($userId, $callSessionId);
        event(new CallEndedNotification(
            userId: $userId,
            callSessionId: $callSessionId,
            reason: 'call_completed',
            organizationId: $organizationId,
        ));

        \Cache::forget("simring:{$parentId}");
    }
    return;
}
```

**Result**: When the answering device hangs up, the parent call is terminated, ending the call for both parties.

#### 6.5.2 Ring Phase: Track Leg Removal

**Lines 748-752**: If call not yet answered, remove this leg from tracking:

```php
$ringSession['leg_ids'] = array_values(array_filter(
    $ringSession['leg_ids'],
    fn ($id) => $id !== $legCallControlId
));
\Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```

#### 6.5.3 All Legs Failed: Voicemail Fallback

**Lines 764-774**: If all legs ended without answer:

```php
if (empty($ringSession['leg_ids'])) {
    if ($message) {
        $this->transferToVoicemail($parentId, $message);
    }
    \Cache::forget("simring:{$parentId}");
}
```

**Result**: If all devices reject or timeout, route to voicemail.

---

## 7. Payload Structures

### 7.1 Incoming Call Push Notification

**Target**: Mobile devices (Android FCM + iOS APNs)

```json
{
  "type": "incoming_call",
  "call_session_id": "0193ee0c-5b13-7ee7-8f23-af1cd68ba76d",
  "call_control_id": "v3:T02llbml0UhhZGRy...",
  "caller_number": "+15551234567",
  "caller_name": "John Doe",
  "channel_number": "+15559876543",
  "caller_avatar": "https://z360.app/storage/avatars/123.jpg",
  "call_id": "0193ee0c-5b13-7ee7-8f23-af1cd68ba76d",
  "organization_id": "123",
  "organization_name": "Acme Inc",
  "organization_slug": "acme",
  "timestamp": "1738972800",

  // iOS-only (APNs)
  "aps": {
    "content-available": 1
  }
}
```

### 7.2 Call Ended Push Notification

```json
{
  "type": "call_ended",
  "call_session_id": "0193ee0c-5b13-7ee7-8f23-af1cd68ba76d",

  // iOS-only (APNs)
  "aps": {
    "content-available": 1
  }
}
```

### 7.3 Web Broadcast: IncomingCallNotification

**Channel**: `private-org-{org_id}.App.Models.User.{user_id}`
**Event**: `incoming_call`

```json
{
  "call_session_id": "0193ee0c-5b13-7ee7-8f23-af1cd68ba76d",
  "call_control_id": "v3:T02llbml0UhhZGRy...",
  "caller_number": "+15551234567",
  "caller_name": "John Doe",
  "channel_number": "+15559876543",
  "organization_id": 123,
  "organization_name": "Acme Inc"
}
```

### 7.4 Web Broadcast: CallEndedNotification

**Channel**: `private-org-{org_id}.App.Models.User.{user_id}`
**Event**: `call_ended`

```json
{
  "call_session_id": "0193ee0c-5b13-7ee7-8f23-af1cd68ba76d",
  "reason": "answered_elsewhere" | "call_completed" | "originator_cancel" | "no_answer"
}
```

### 7.5 Telnyx Call Create (Simring Leg)

**API**: `\Telnyx\Call::create()`

```json
{
  "to": "sip:device-abc123@sip.telnyx.com",
  "from": "+15551234567",
  "connection_id": "1234567890",
  "webhook_url": "https://z360.app/webhooks/cpaas/telnyx/call-control",
  "timeout_secs": 30,
  "client_state": "eyJ0eXBlIjoic2ltdWx0YW5lb3VzX3JpbmdfbGVnIiwicGFyZW50X2NhbGxfY29udHJvbF9pZCI6InYzOlQwMmxsYm1sMFVoaFpHUnkuLi4iLCJ1c2VyX2lkIjoxMjMsIm1lc3NhZ2VfaWQiOjQ1Niwib3JnYW5pemF0aW9uX2lkIjo3ODl9"
}
```

**client_state decoded**:
```json
{
  "type": "simultaneous_ring_leg",
  "parent_call_control_id": "v3:T02llbml0UhhZGRy...",
  "user_id": 123,
  "message_id": 456,
  "organization_id": 789
}
```

### 7.6 Telnyx Call Answer (Parent)

**API**: `\Telnyx\Call::answer()`

```json
{
  "call_control_id": "v3:T02llbml0UhhZGRy...",
  "client_state": "eyJ0eXBlIjoic2ltdWx0YW5lb3VzX3JpbmdfcGFyZW50IiwidXNlcl9pZCI6MTIzLCJtZXNzYWdlX2lkIjo0NTYsIm9yZ2FuaXphdGlvbl9pZCI6Nzg5fQ=="
}
```

**client_state decoded**:
```json
{
  "type": "simultaneous_ring_parent",
  "user_id": 123,
  "message_id": 456,
  "organization_id": 789
}
```

### 7.7 Telnyx Call Bridge

**API**: `\Telnyx\Call::bridge()`

```json
{
  "call_control_id": "v3:parent-call-control-id",
  "bridge_to_call_control_id": "v3:answered-leg-call-control-id"
}
```

Result: Audio flows between parent and answered leg.

### 7.8 Telnyx Recording Start

**API**: `\Telnyx\Call::record_start()`

```json
{
  "call_control_id": "v3:parent-call-control-id",
  "format": "wav",
  "channels": "dual",
  "trim": "trim-silence",
  "custom_file_name": "456"
}
```

Recording URL delivered later via `call.recording.saved` webhook.

---

## 8. Cache Key Structures

### 8.1 Ring Session Cache

**Key**: `simring:{parent_call_control_id}`
**TTL**: 10 minutes

**Value**:
```json
{
  "parent_call_control_id": "v3:T02llbml0UhhZGRy...",
  "user_id": 123,
  "message_id": 456,
  "answered": false,
  "leg_ids": [
    "v3:leg-1-call-control-id",
    "v3:leg-2-call-control-id",
    "v3:leg-3-call-control-id"
  ],
  "answered_leg": null
}
```

**After Answer**:
```json
{
  "parent_call_control_id": "v3:T02llbml0UhhZGRy...",
  "user_id": 123,
  "message_id": 456,
  "answered": true,
  "leg_ids": [...],
  "answered_leg": "v3:leg-2-call-control-id"
}
```

### 8.2 Ring Lock

**Key**: `simring:{parent_call_control_id}:lock`
**TTL**: 10 seconds (lock timeout)

**Value**: Laravel lock mechanism (internal)

**Usage**: Prevents race condition when multiple devices answer simultaneously. Only one device acquires lock and bridges to parent.

---

## 9. Error Handling & Edge Cases

### 9.1 All Simring Legs Fail to Create

**Location**: Lines 335-368
**Scenario**: Telnyx API fails for all `Call::create()` requests
**Handling**:
1. Retry once after 2-second delay
2. If still failed, route to voicemail
3. Log error: "All simultaneous ring legs failed after retry"

### 9.2 No Device Tokens or SIP Credentials

**Location**: Lines 273-278
**Scenario**: User has no active device tokens or SIP credentials
**Handling**: Route to voicemail immediately

### 9.3 Bridge Failure

**Location**: Lines 578-583
**Scenario**: `Call::bridge()` throws exception
**Handling**: Log error, but no automatic recovery (call legs remain active but not bridged)

**Gap**: No automatic fallback to voicemail if bridge fails.

### 9.4 Lock Acquisition Timeout

**Location**: Lines 479-489
**Scenario**: Second device answers while first is still bridging
**Handling**: Second device fails to acquire lock, hangs up its leg immediately

### 9.5 Caller Hangs Up During Ring Phase

**Location**: Lines 171-173
**Scenario**: PSTN caller cancels before anyone answers
**Handling**: `hangup_cause: "originator_cancel"` → Early return, no voicemail

### 9.6 Parent Already Answered Check

**Location**: Lines 192-199
**Scenario**: `call.hangup` fires for a leg but call was already answered
**Handling**: Skip voicemail fallback by checking `simring:{parent}` cache for `answered: true`

### 9.7 Blocked Caller

**Location**: Lines 51-73
**Scenario**: Identifier has `is_blocked: true`
**Handling**: Answer, speak message, hang up immediately

### 9.8 Outside Business Hours

**Location**: Lines 76-111
**Scenario**: Call arrives outside configured schedule
**Handling**: Route to voicemail OR AI agent based on `unavailability_option` setting

---

## 10. Gaps & Issues

### 10.1 Org-Level Credential Risk

**Location**: Lines 264-266, 267-271
**Issue**: Org-level SIP credential (`$user->telnyxCredential->sip_username`) is NOT dialed during simultaneous ring. Code comment explains:

> "Dialing it creates a phantom SIP leg that answers first and steals the bridge."

**Why this is fragile**: If logic changes and org-level credential is accidentally included in `$sipDestinations`, it will break simultaneous ring by auto-answering.

**Current Mitigation**: Query explicitly filters for per-device credentials in `UserDeviceToken` table.

### 10.2 No Bridge Failure Recovery

**Location**: Lines 578-583
**Issue**: If `Call::bridge()` fails (Telnyx API error), the error is logged but no recovery action is taken.

**Impact**: Parent call and answered leg remain active but not bridged. Caller and device hear silence. No automatic fallback to voicemail or re-ring.

**Recommendation**: Add fallback logic: hang up parent + route to voicemail.

### 10.3 Race Condition: Simultaneous Answer

**Current Handling**: Distributed lock (`simring:{parent}:lock`) prevents race.

**Edge Case**: If Redis/cache layer is unavailable, lock acquisition fails. Code treats this as "someone else answered" and hangs up. This is safe but may result in no devices bridging if cache is down.

**Recommendation**: Add monitoring for lock acquisition failures.

### 10.4 Push Notification Failures

**Location**: Lines 234-242, 427-445
**Issue**: If push notification fails (FCM/APNs unreachable), error is logged but no retry or alternative alerting.

**Impact**: Mobile devices don't wake up, but web sessions still receive Reverb broadcast and SIP legs still ring.

**Recommendation**: Acceptable as push is best-effort. SIP ring provides fallback.

### 10.5 Ring Session Cache TTL

**TTL**: 10 minutes
**Typical call flow**: Ring for 30 seconds, bridge, talk for 5 minutes, hang up

**Issue**: Cache persists for 10 minutes even after call ends. This wastes memory but is harmless.

**Recommendation**: Clean up cache immediately in `onSimultaneousRingParentHangup()` and `onSimultaneousRingLegHangup()` (already done at lines 642-644, 741).

### 10.6 No Visibility into Telnyx Call State

**Issue**: Z360 relies on webhooks for all state changes. If a webhook is lost (network issue, Telnyx bug), backend state diverges from actual call state.

**Example**: If `call.answered` webhook is lost, Z360 never bridges the call, and devices remain ringing forever.

**Recommendation**: Implement periodic polling or Telnyx API call to verify state for calls older than 2 minutes.

### 10.7 Idempotency Tracking

**Location**: Base controller `ensureIdempotent()` (not shown in this trace)
**Purpose**: Prevent duplicate processing if Telnyx retries webhooks

**Gap**: Idempotency keys are stored per-message. If `call.initiated` is retried before `Message` is created, idempotency check may not work.

**Recommendation**: Use `call_session_id` as idempotency key instead of message ID.

---

## Summary: Complete Flow Timeline

### T=0ms: Call Arrives
- Telnyx receives PSTN call to Z360 number
- Webhook: `POST /call-control` with `call.initiated`
- Parse webhook → Find channel → Resolve user
- Metadata: `original_from`, `parent_call_control_id`

### T=100ms: Push Notifications Sent
- Query FCM + APNs tokens from `user_device_tokens`
- Send FCM push to Android devices (high priority, 60s TTL)
- Send APNs VoIP push to iOS devices
- Broadcast `IncomingCallNotification` to web sessions via Reverb

### T=200ms: Simring Legs Created
- Query per-device SIP credentials from `user_device_tokens`
- For each device, `Telnyx\Call::create()` with SIP URI
- Telnyx dials each device via SIP
- Parent call remains parked (caller hears ringback)

### T=250ms: Leg IDs Tracked
- Telnyx sends `call.initiated` for each leg
- Backend tracks leg IDs in `simring:{parent}` cache

### T=3000ms: First Device Answers
- User picks up on mobile device
- Webhook: `POST /call-control` with `call.answered`
- Acquire lock: `simring:{parent}:lock`
- Answer parent call
- Bridge parent ↔ answered leg
- Start dual-channel recording on parent
- Hang up other legs
- Broadcast `CallEndedNotification` to web + mobile

### T=3200ms: Other Devices Dismissed
- Web sessions receive `call_ended` via Reverb
- Mobile devices receive `call_ended` push
- All ringing UI dismissed

### T=3000ms - T=120000ms: Call In Progress
- Audio flows between PSTN caller and device
- Recording captures both audio tracks

### T=120000ms: Caller Hangs Up
- Webhook: `POST /call-control` with `call.hangup`
- `client_state.type: "simultaneous_ring_parent"`
- Hang up bridged leg
- Send `call_completed` push + broadcast
- Clean up cache: `\Cache::forget("simring:{parent}")`
- Recording saved webhook arrives later

---

## Files Referenced

- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` (1,060 lines)
- `app/Http/Controllers/Telnyx/TelnyxCallController.php` (375 lines)
- `app/Models/UserDeviceToken.php` (166 lines)
- `app/Services/PushNotificationService.php` (321 lines)
- `app/Services/CPaaSService.php` (partial: lines 1-152)
- `app/Events/IncomingCallNotification.php` (57 lines)
- `app/Events/CallEndedNotification.php` (46 lines)
- `app/Data/Telnyx/TelnyxWebhook.php`
- `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php`
- `app/Data/Telnyx/Calls/TelnyxCallAnsweredData.php`
- `app/Data/Telnyx/Calls/TelnyxCallHangupData.php`
- `routes/webhooks.php:40-42`

---

**End of Backend Inbound Call Flow Trace**
