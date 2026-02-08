---
title: Simring Happy Path
---

# Simultaneous Ringing — Happy-Path Flow (Code Evidence)

> **Research Task #1** | Date: 2026-02-08
> **Scope**: Complete happy-path simultaneous ring flow with exact code references for every step
> **Sources**: voip-backend skill, voip-android skill, voip-ios skill, voip-frontend skill

---

## Table of Contents

1. [Scenario Definition](#1-scenario-definition)
2. [Prerequisite: Per-Device SIP Credentials](#2-prerequisite-per-device-sip-credentials)
3. [Phase 1: Call Arrives — Backend Webhook Processing](#3-phase-1-call-arrives)
4. [Phase 2: Notification Dispatch](#4-phase-2-notification-dispatch)
5. [Phase 3: SIP Leg Creation](#5-phase-3-sip-leg-creation)
6. [Phase 4: Cache Session Storage](#6-phase-4-cache-session-storage)
7. [Phase 5: Leg ID Tracking](#7-phase-5-leg-id-tracking)
8. [Phase 6: Device-Side Push + SIP INVITE Reception](#8-phase-6-device-side-reception)
9. [Phase 7: Device Answers](#9-phase-7-device-answers)
10. [Phase 8: Backend Answer Coordination](#10-phase-8-backend-answer-coordination)
11. [Phase 9: Ring Dismissal (Three-Channel)](#11-phase-9-ring-dismissal)
12. [Phase 10: Call In Progress](#12-phase-10-call-in-progress)
13. [Phase 11: Call Ends — PSTN Caller Hangs Up](#13-phase-11-call-ends-pstn-caller)
14. [Phase 12: Call Ends — Device User Hangs Up](#14-phase-12-call-ends-device-user)
15. [Complete Timing Diagram](#15-complete-timing-diagram)
16. [Complete Cache Key Reference](#16-complete-cache-key-reference)
17. [Complete API Call Reference](#17-complete-api-call-reference)

---

## 1. Scenario Definition

**Happy-path scenario**: A PSTN caller dials a Z360 number. The receiving user has **3 devices** registered:
- Android phone (FCM push token + SIP credential)
- iOS phone (APNs VoIP push token + SIP credential)
- Web browser tab (SIP credential + active WebSocket to Telnyx)

All devices ring simultaneously. The **Android phone answers first**. The other two devices dismiss their ringing UI. The call proceeds until the PSTN caller hangs up.

---

## 2. Prerequisite: Per-Device SIP Credentials

Before simultaneous ring can work, each device must have its own SIP credential registered in `user_device_tokens`.

### Credential Creation

**File**: `app/Services/CPaaSService.php` — `createDeviceCredential()` (skill line 4368)

```php
public static function createDeviceCredential(User $user, UserDeviceToken $deviceToken): ?UserDeviceToken
{
    $connectionId = config('cpaas.telnyx.credential_connection_id');
    if (! $connectionId) {
        return null;
    }

    $name = "Device-{$deviceToken->device_id}_".Str::random(8);
    $credential = \Telnyx\TelephonyCredential::create([
        'name' => $name,
        'connection_id' => $connectionId,
    ]);

    $deviceToken->update([
        'telnyx_credential_id' => $credential->id,
        'sip_username' => $credential->sip_username,
        'sip_password' => $credential->sip_password,
        'connection_id' => $connectionId,
        'credential_expires_at' => now()->addDays(30),
    ]);

    return $deviceToken->fresh();
}
```

**Telnyx API call**: `POST /v2/telephony_credentials` via `\Telnyx\TelephonyCredential::create()`

**Result stored in `user_device_tokens`**:
| Column | Value |
|--------|-------|
| `user_id` | User's ID |
| `device_id` | Unique device identifier |
| `platform` | `android`, `ios`, or `web` |
| `fcm_token` | FCM/APNs push token |
| `sip_username` | Telnyx SIP username (e.g., `gendev_abc123`) |
| `sip_password` | Telnyx SIP password |
| `telnyx_credential_id` | Telnyx credential UUID |
| `connection_id` | Telnyx credential connection ID |
| `credential_expires_at` | 30 days from creation |
| `last_active_at` | Updated on device activity |

**Critical rule**: Org-level credentials (`user_telnyx_telephony_credentials.sip_username`) are NEVER dialed. Only per-device SIP credentials from `user_device_tokens` are used for simultaneous ring.

---

## 3. Phase 1: Call Arrives — Backend Webhook Processing

**Trigger**: PSTN call arrives at Z360 number → Telnyx sends `call.initiated` webhook

**Webhook route**: `POST /webhooks/cpaas/telnyx/call-control`
**File**: `routes/webhooks.php:40`

### Step 1.1: Parse Webhook

**File**: `app/Http/Controllers/Telnyx/TelnyxCallController.php` → dispatches to `TelnyxInboundWebhookController`

```php
$data = \App\Data\Telnyx\Calls\TelnyxCallInitiatedData::fromRequest(request());
```

**File**: `app/Data/Telnyx/Calls/TelnyxCallInitiatedData.php`

Resolves:
- `$data->call_control_id` — The parent call's control ID (e.g., `v3:abc123`)
- `$data->call_session_id` — Unique session ID
- `$data->from` — PSTN caller number (e.g., `+15551234567`)
- `$data->to` — Z360 number (e.g., `+15559876543`)
- `$data->channel()` — `AuthenticatedPhoneNumber` matching `$data->to`
- `$data->channel()->receivingUser` — The user configured to receive calls on this number

### Step 1.2: Create Message + Conversation

**File**: `TelnyxInboundWebhookController.php::handleCall()` (skill line 1621)

```php
$message = $data->message();  // Creates Message + Conversation via TelnyxCallInitiatedData
```

The `message()` method:
- Finds or creates an `Identifier` for the caller number
- Finds or creates a `Conversation` between the identifier and the channel
- Creates a `Message` with type `call` and metadata including `call_session_id`, `call_control_id`

### Step 1.3: Validation Checks

**File**: `TelnyxInboundWebhookController.php::handleCall()` (skill lines 1629-1691)

```php
$this->ensureIdempotent($message, 'handleCall:inbound');

// Check blocked caller
if ($callerIdentifier?->is_blocked) { /* answer + speak + hangup */ }

// Check business hours
$isWithin = \App\Services\Utils::withinSchedule($schedule);

// Resolve receiving user
$receivingUser = $data->channel()?->receivingUser;
```

**Happy-path**: Caller is not blocked, within schedule, receiving user exists.

### Step 1.4: Store Metadata + Transfer to User

**File**: `TelnyxInboundWebhookController.php::handleCall()` (skill lines 1664-1674)

```php
$message->updateMetadata('original_from', $data->from);
$message->updateMetadata('received_by', $receivingUser->id);
$message->updateMetadata('parent_call_control_id', $data->call_control_id);
$message->save();

$this->transferToUser($data->call_control_id, $message, $receivingUser);
```

**PSTN caller state**: Hearing carrier ringback tone (parent call is NOT answered yet).

---

## 4. Phase 2: Notification Dispatch

**File**: `TelnyxInboundWebhookController.php::transferToUser()` (skill lines 1790-1974)

### Step 2.1: Gather Push Tokens

```php
$fcmTokens = \App\Models\UserDeviceToken::getFcmTokensForUser($user->id);
$apnsTokens = \App\Models\UserDeviceToken::getApnsVoipTokensForUser($user->id);
```

**File**: `app/Models/UserDeviceToken.php` (skill lines 2937-2961)

```php
// Android tokens
public static function getFcmTokensForUser(int $userId, ?int $organizationId = null): array
{
    $query = static::where('user_id', $userId)->where('platform', 'android');
    if ($organizationId) { $query->where('organization_id', $organizationId); }
    return $query->pluck('fcm_token')->toArray();
}

// iOS tokens (note: column is still 'fcm_token' despite being APNs)
public static function getApnsVoipTokensForUser(int $userId, ?int $organizationId = null): array
{
    $query = static::where('user_id', $userId)->where('platform', 'ios');
    if ($organizationId) { $query->where('organization_id', $organizationId); }
    return $query->pluck('fcm_token')->toArray();
}
```

### Step 2.2: Send Mobile Push Notifications

**File**: `TelnyxInboundWebhookController.php::transferToUser()` (skill lines 1812-1820)

```php
if (!empty($fcmTokens) || !empty($apnsTokens)) {
    $this->sendIncomingCallPush($message, $user);
}
```

**File**: `TelnyxInboundWebhookController.php::sendIncomingCallPush()` (skill lines 1979-2024)

```php
PushNotificationService::sendIncomingCallPush(
    userId: $user->id,
    callSessionId: $message->metadata['call_session_id'] ?? '',
    callControlId: $message->metadata['parent_call_control_id'] ?? '',
    callerNumber: $callerNumber,
    callerName: $callerName,
    channelNumber: $channelNumber,
    organizationId: $organization?->id,
    organizationName: $organization?->name,
    organizationSlug: $organization?->slug,
    callerAvatar: $callerAvatar,
    callId: $callId
);
```

**Push payload sent to Android (FCM) + iOS (APNs VoIP)**:
```json
{
    "type": "incoming_call",
    "call_session_id": "UUID",
    "call_control_id": "v3:xxx",
    "caller_number": "+15551234567",
    "caller_name": "John Doe",
    "channel_number": "+15559876543",
    "caller_avatar": "https://...",
    "call_id": "UUID",
    "organization_id": "123",
    "organization_name": "Acme Inc",
    "organization_slug": "acme",
    "timestamp": "1738972800"
}
```

This is the **Z360 push** (caller info push). Telnyx separately sends its own push with call control metadata.

### Step 2.3: Broadcast to Web Sessions

**File**: `TelnyxInboundWebhookController.php::transferToUser()` (skill lines 1822-1840)

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

**File**: `app/Events/IncomingCallNotification.php` (skill lines 1420-1460)

```php
class IncomingCallNotification implements ShouldBroadcast
{
    public function broadcastOn(): array {
        return [
            new TenantPrivateChannel("App.Models.User.{$this->user->id}", $this->organizationId),
        ];
    }

    public function broadcastAs(): string { return 'incoming_call'; }

    public function broadcastWith(): array {
        return [
            'call_session_id' => $this->callSessionId,
            'call_control_id' => $this->callControlId,
            'caller_number' => $this->callerNumber,
            'caller_name' => $this->callerName,
            'channel_number' => $this->channelNumber,
            'organization_id' => $this->organizationId,
            'organization_name' => $this->organizationName,
        ];
    }
}
```

**Broadcast channel**: `private-tenant.App.Models.User.{userId}.{organizationId}` via Laravel Reverb WebSocket.

**Note**: Web does NOT currently consume this broadcast for incoming call detection — it relies on the SIP INVITE via Telnyx WebSocket. The Reverb broadcast is for informational purposes only. Web DOES consume the `call_ended` broadcast.

---

## 5. Phase 3: SIP Leg Creation

**File**: `TelnyxInboundWebhookController.php::transferToUser()` (skill lines 1842-1973)

### Step 3.1: Query Active Per-Device SIP Credentials

```php
$sipDestinations = \App\Models\UserDeviceToken::where('user_id', $user->id)
    ->whereNotNull('sip_username')
    ->where('last_active_at', '>=', now()->subDay())
    ->pluck('sip_username')
    ->toArray();
```

**Filter**: Only devices with:
- A non-null `sip_username`
- `last_active_at` within the last 24 hours

**Result** (for our 3-device scenario): `['gendev_android1', 'gendev_ios1', 'gendev_web1']`

### Step 3.2: Single vs Multi-Device Branching

```php
if (count($sipDestinations) === 0) {
    // No SIP credentials → voicemail
    $this->transferToVoicemail($call_control_id, $message);
    return;
}

if (count($sipDestinations) === 1) {
    // Single device: simple transfer (no simultaneous ring)
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
} else {
    // Multi-device: simultaneous ring (our happy path)
}
```

**Happy-path**: 3 devices → enters multi-device branch.

### Step 3.3: Create Outbound SIP Legs

```php
$connectionId = config('cpaas.telnyx.call_control_id');
$webhookUrl = CPaaSService::tunnelSafeUrl('/webhooks/cpaas/telnyx/call-control');
$createdLegs = [];

foreach ($sipDestinations as $sip) {
    try {
        \Telnyx\Call::create([
            'to' => "sip:{$sip}@sip.telnyx.com",
            'from' => $message->metadata['original_from'],
            'connection_id' => $connectionId,
            'webhook_url' => $webhookUrl,
            'timeout_secs' => 30,
            'client_state' => base64_encode(json_encode([
                'type' => 'simultaneous_ring_leg',
                'parent_call_control_id' => $call_control_id,
                'user_id' => $user->id,
                'message_id' => $message->id,
                'organization_id' => $organization?->id,
            ])),
        ]);
        $createdLegs[] = $sip;
    } catch (\Throwable $e) {
        VoipLog::warning("Failed to create sim-ring leg for {$sip}", $callSessionId, [
            'error' => $e->getMessage(),
        ]);
    }
}
```

**For each device, the Telnyx API call is**:
```
POST /v2/calls
{
    "to": "sip:gendev_android1@sip.telnyx.com",
    "from": "+15551234567",
    "connection_id": "<TELNYX_CALL_CONTROL_APP_ID>",
    "webhook_url": "https://app.z360.cloud/webhooks/cpaas/telnyx/call-control",
    "timeout_secs": 30,
    "client_state": "<base64-encoded JSON>"
}
```

**client_state decoded**:
```json
{
    "type": "simultaneous_ring_leg",
    "parent_call_control_id": "v3:parent_abc123",
    "user_id": 42,
    "message_id": 789,
    "organization_id": 123
}
```

**What happens at Telnyx**: Each `Call::create()` triggers Telnyx to send a SIP INVITE to the specified SIP endpoint. Telnyx also sends a `call.initiated` webhook back to Z360 for each leg.

### Step 3.4: Retry Logic

If ALL legs fail on first attempt, there's a single retry after 2 seconds:

```php
if (empty($createdLegs)) {
    VoipLog::warning('All sim-ring legs failed, retrying once after 2s...', $callSessionId);
    usleep(2_000_000); // 2 seconds
    // ... retry same loop ...
    if (empty($createdLegs)) {
        $this->transferToVoicemail($call_control_id, $message);
        return;
    }
}
```

**Happy-path**: All 3 legs succeed on first attempt. No retry needed.

### Step 3.5: Parent Call Stays Parked

```php
// Do NOT answer the parent call here — leave it parked so the
// PSTN caller continues to hear ringback from their carrier.
// The parent will be answered in onSimultaneousRingAnswered()
// only when a device actually picks up.
```

**Critical design decision**: The parent call is NOT answered at this point. The PSTN caller continues to hear their carrier's ringback tone. This avoids charging the call and provides natural audio feedback.

---

## 6. Phase 4: Cache Session Storage

**File**: `TelnyxInboundWebhookController.php::transferToUser()` (skill lines 1955-1961)

```php
\Cache::put("simring:{$call_control_id}", [
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
    'answered' => false,
    'leg_ids' => [],
], now()->addMinutes(10));
```

### Cache Key: `simring:{parent_call_control_id}`

| Field | Initial Value | Purpose |
|-------|---------------|---------|
| `parent_call_control_id` | `v3:parent_abc123` | ID of the PSTN parent call |
| `user_id` | `42` | Receiving user ID |
| `message_id` | `789` | Message record ID for call logging |
| `answered` | `false` | Whether any device has answered |
| `leg_ids` | `[]` (empty) | Populated by `onSimultaneousRingLegInitiated()` |
| **TTL** | **10 minutes** | Safety net — cleaned up on hangup |

**Note**: `leg_ids` starts empty and is populated when Telnyx sends `call.initiated` webhooks for each leg (see Phase 5).

---

## 7. Phase 5: Leg ID Tracking

When Telnyx creates each outbound SIP leg, it sends a `call.initiated` webhook. The backend tracks these leg IDs.

**File**: `TelnyxInboundWebhookController.php::onSimultaneousRingLegInitiated()` (skill lines 2362-2394)

```php
private function onSimultaneousRingLegInitiated(): void
{
    $payload = request()->input('data.payload', []);
    $clientState = $payload['client_state'] ?? null;
    $parsed = CPaaSService::parseClientState($clientState);
    $data = $parsed['data'] ?? [];

    if (($data['type'] ?? null) !== 'simultaneous_ring_leg') {
        return;
    }

    $parentId = $data['parent_call_control_id'] ?? null;
    $legCallControlId = $payload['call_control_id'] ?? null;

    $ringSession = \Cache::get("simring:{$parentId}");
    if ($ringSession) {
        $ringSession['leg_ids'][] = $legCallControlId;
        \Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
    }
}
```

**Invoked from**: `TelnyxInboundWebhookController` (skill line 1610) — called when `call.initiated` webhook arrives with `simultaneous_ring_leg` client_state.

**After 3 leg initiations, cache state**:
```php
"simring:v3:parent_abc123" => [
    'parent_call_control_id' => 'v3:parent_abc123',
    'user_id' => 42,
    'message_id' => 789,
    'answered' => false,
    'leg_ids' => [
        'v3:leg_android_001',
        'v3:leg_ios_002',
        'v3:leg_web_003',
    ],
]
```

---

## 8. Phase 6: Device-Side Push + SIP INVITE Reception

At this point, three things happen in parallel for each device:
1. **Push notification** arrives (Z360 push with caller info)
2. **Telnyx push** arrives (call control metadata — mobile only)
3. **SIP INVITE** arrives via the device's Telnyx SDK connection

### 8.1 Android: FCM Push → SDK Connect → UI

**File**: `Z360FirebaseMessagingService.kt::onMessageReceived()` (skill line 688)

#### Z360 Push Handling

```kotlin
override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    val metadataJson = data["metadata"]

    // Login check
    if (!isUserLoggedIn()) { return }

    // call_ended push
    if (data["type"] == "call_ended") { /* dismiss UI */ return }

    // Telnyx SDK push (has metadata)
    if (metadataJson != null) {
        handleTelnyxMetadataPush(metadataJson, data)
        return
    }

    // Z360 backend push (caller info)
    handleZ360CallerInfoPush(data)
}
```

**File**: `Z360FirebaseMessagingService.kt::handleZ360CallerInfoPush()` (skill line 767)

```kotlin
private fun handleZ360CallerInfoPush(data: Map<String, String>) {
    val callerName = data[KEY_CALLER_NAME]
    val callerNumber = data[KEY_CALLER_NUMBER]
    val callerAvatar = data[KEY_CALLER_AVATAR]
    val organizationId = data[KEY_ORGANIZATION_ID]
    val organizationName = data[KEY_ORGANIZATION_NAME]

    // Store in Z360VoipStore for persistence
    store.saveCallDisplayInfo(callId, callerName, callerNumber, avatarUrl)
    store.saveIncomingCallMeta(callId, organizationId, organizationName, channelNumber)

    // Notify PushSynchronizer
    PushSynchronizer.onZ360PushReceived(context, callerNumber, displayInfo)
}
```

#### Telnyx Push Handling

**File**: `Z360FirebaseMessagingService.kt::handleTelnyxMetadataPush()` (skill line 847)

```kotlin
private fun handleTelnyxMetadataPush(metadataJson: String, data: Map<String, String>) {
    val pushMetaData = Gson().fromJson(metadataJson, PushMetaData::class.java)

    // Guard against re-INVITE after caller hung up
    if (store.wasRecentlyEnded(pushMetaData.callerNumber!!)) { return }

    // Two-push synchronization (500ms timeout)
    val syncResult = runBlocking {
        PushSynchronizer.onTelnyxPushReceived(
            context = applicationContext,
            callerNumber = pushMetaData.callerNumber,
            callId = pushMetaData.callId
        )
    }

    // Merge display info from Z360 push + Telnyx push
    val enhancedCallerName = syncResult.displayInfo?.callerName ?: pushMetaData.callerName
    val enhancedCallerNumber = syncResult.displayInfo?.callerNumber ?: pushMetaData.callerNumber

    // Ensure SDK is connected (reconnect with stored creds if needed)
    ensureTelnyxSdkConnected(metadataJson)

    // Show incoming call notification
    showIncomingCallNotification(enhancedPushMetaData, enhancedAvatarUrl, data)
}
```

#### Show Incoming Call UI

**File**: `Z360FirebaseMessagingService.kt::showIncomingCallNotification()` (skill line 1068)

Attempts to use Android Telecom framework first:

```kotlin
val telecomSuccess = Z360ConnectionService.addIncomingCall(this, telecomExtras)
```

**File**: `Z360ConnectionService.kt::addIncomingCall()` (skill line 8926) — Registers with Android Telecom framework

**Result**: `IncomingCallActivity` launches with caller name, number, avatar, org name. Registers `callEndedReceiver` for dismissal.

### 8.2 iOS: PushKit → CallKit → SDK Connect

**File**: `PushKitManager.swift::pushRegistry(_:didReceiveIncomingPushWith:)` (skill line 1793)

```swift
func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
) {
    guard type == .voIP else { completion(); return }
    processPushPayload(payload.dictionaryPayload, completion: completion)
}
```

**File**: `PushKitManager.swift::processPushPayload()` (skill line 1035)

```swift
private func processPushPayload(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
    // Handle call_ended push
    if let pushType = payload["type"] as? String, pushType == "call_ended" { /* ... */ }

    let z360Info = extractZ360CallInfo(from: payload)
    let telnyxMetadata = extractTelnyxMetadata(from: payload)
    let telnyxInfo = telnyxMetadata.flatMap { parseTelnyxInfo(from: $0) }

    // Feed PushCorrelator for two-push coordination
    if let z360Info = z360Info {
        Task { await pushCorrelator.processZ360Push(...) }
    }
    if let telnyxInfo = telnyxInfo {
        Task { await pushCorrelator.processTelnyxPush(...) }
    }

    // If Telnyx push present → report to CallKit immediately
    if let telnyxInfo = telnyxInfo {
        let callUUID = UUID(uuidString: telnyxInfo.callId) ?? z360Info?.callId ?? UUID()
        reportIncomingCall(uuid: callUUID, callInfo: callInfo, telnyxCallId: telnyxInfo.callId, completion: completion)
        processTelnyxPayloadAsync(telnyxMetadata!)
        return
    }

    // Z360-only push → wait up to 1.5s for Telnyx push
    if let z360Info = z360Info {
        Task {
            let telnyxData = await waitForTelnyxData(callerNumber: z360Info.callerNumber, timeout: 1.5)
            let callUUID = telnyxData.flatMap { UUID(uuidString: $0.callId) } ?? z360Info.callId ?? UUID()
            await MainActor.run {
                self.reportIncomingCall(uuid: callUUID, callInfo: z360Info, telnyxCallId: telnyxData?.callId, completion: completion)
            }
        }
    }
}
```

**CRITICAL**: Must report to CallKit within 5 seconds of PushKit delivery or iOS kills the app.

**Result**: Native iOS call UI appears (banner if unlocked, full-screen if locked).

### 8.3 iOS Two-Push Correlation

**File**: `PushCorrelator.swift` (skill lines 2541-2660)

```swift
// Swift Actor for thread safety
func processZ360Push(callId: UUID?, callerName: String, callerNumber: String, ...) {
    let normalizedPhone = normalizePhoneNumber(callerNumber) // Last 10 digits

    // Check if Telnyx push is already waiting
    if var entry = pendingByPhone[normalizedPhone] {
        if entry.telnyxData != nil, let continuation = entry.continuation {
            // Telnyx arrived first — complete immediately
            let merged = mergeData(z360: z360Data, telnyx: entry.telnyxData!)
            continuation.resume(returning: merged)
        }
    } else {
        // Z360 arrived first — store for later
        var entry = SyncEntry(normalizedPhone: normalizedPhone)
        entry.z360Data = z360Data
        pendingByPhone[normalizedPhone] = entry
    }
}

func processTelnyxPush(callId: String, callerNumber: String?, callerName: String?) {
    // Similar pattern — store and match by normalized phone number
}
```

**Correlation key**: Normalized phone number (last 10 digits).
**Timeout**: 500ms–1.5s depending on which push arrives first.

### 8.4 Web: SIP INVITE via WebSocket (Direct)

**File**: `resources/js/components/.../dialpad/context.tsx` (skill lines 672-694)

Web receives the SIP INVITE directly through the Telnyx WebRTC WebSocket — NO push notification needed.

```tsx
const notification = useSafeNotification();  // From @telnyx/react-client
const activeCall = notification && notification.call && notification.call.state !== 'destroy'
    ? notification.call : null;
```

When a SIP INVITE arrives:
1. `useNotification()` fires with a new `call` object
2. `call.state === 'ringing'`
3. UI renders `<IncomingCall />` component

**Also listens for `call_ended` broadcast** (for simultaneous ring dismissal):

```tsx
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);
useEcho<{ call_session_id: string; reason: string }>(callEndedChannel, '.call_ended', (payload) => {
    if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
        try { activeCall.hangup(); } catch (e) { /* ... */ }
    }
});
```

---

## 9. Phase 7: Device Answers

**Happy-path**: User taps "Answer" on Android phone (~3 seconds after ringing started).

### 9.1 Android Answer Flow

**File**: `IncomingCallActivity.kt::answerDirectly()` (skill line 4864)

```kotlin
private fun answerDirectly() {
    stopRinging()  // Stop ringtone first

    lifecycleScope.launch {
        delay(250)  // 250ms audio settle delay

        // Check SDK is connected
        val isConnected = telnyxViewModel.sessionsState.value is TelnyxSessionState.ClientLoggedIn
        if (!isConnected) { showAnswerError(...); return@launch }

        // STRATEGY: Prefer answering by UUID (from actual SIP INVITE)
        val currentCall = telnyxViewModel.currentCall
        val pendingFromPlugin = TelnyxVoipPlugin.getPendingIncomingCall()

        if (currentCall != null) {
            // SDK has pending call — answer directly by UUID
            telnyxViewModel.answerCall(
                viewContext = applicationContext,
                callId = currentCall.callId,
                callerIdNumber = callerNumber,
                debug = false
            )
        } else if (pendingFromPlugin != null) {
            // Plugin tracked pending incoming call
            telnyxViewModel.answerCall(
                viewContext = applicationContext,
                callId = UUID.fromString(pendingFromPlugin.callId),
                callerIdNumber = callerNumber,
                debug = false
            )
        } else if (!pushMetadataJson.isNullOrEmpty()) {
            // Wait up to 5s for SDK INVITE, then fallback to push answer
            val sdkCall = waitForSdkCall(5000L)
            if (sdkCall != null) {
                telnyxViewModel.answerCall(viewContext, callId = sdkCall.callId, ...)
            } else {
                telnyxViewModel.answerIncomingPushCall(viewContext, txPushMetaData = pushMetadataJson, ...)
            }
        }

        // Notify Telecom framework
        Z360Connection.notifyAnswered()

        // Cancel notifications
        notificationManager?.cancel(9999)   // Z360Connection notification
        notificationManager?.cancel(1234)   // Telnyx SDK notification

        // Launch ActiveCallActivity
        ActiveCallActivity.start(
            context = applicationContext,
            callerName = callerName,
            callerNumber = callerNumber,
            callerAvatarUrl = callerAvatarUrl,
            callSessionId = callSessionId,
            isOutgoing = false,
            callConnected = false  // Updates when OnCallAnswered arrives
        )
    }
}
```

**What happens at SDK level**: `telnyxViewModel.answerCall()` sends a SIP 200 OK to Telnyx, accepting the SIP INVITE.

**Double-tap prevention**: `AtomicBoolean` at skill line 4840.

### 9.2 iOS Answer Flow (for reference — not the answering device in this scenario)

**File**: `Z360VoIPService.swift::answerCall()` (skill line 4484)

```swift
func answerCall(uuid: UUID, action: CXAnswerCallAction) {
    Task {
        // Double-tap prevention
        guard await actionGuard.attemptAction(.answer) else { action.fail(); return }

        // Check SDK readiness
        if !telnyxService.isClientReady() {
            let reconnected = await attemptReconnection()
            if !reconnected { action.fail(); return }
        }

        // Wait for push call ready (5s timeout)
        let callAvailable = await waitForPushCallReady(uuid: uuid, timeout: 5.0)

        // Check cross-org
        let isCrossOrg = await voipStore.isCrossOrgCall(uuid: uuid)
        if isCrossOrg { try await performCrossOrgSwitch(uuid, targetOrgId, ...) }

        // Answer via SDK
        telnyxService.answerFromCallKit(answerAction: action)
    }
}
```

**File**: `TelnyxService.swift::answerFromCallKit()` (skill line 3196)

```swift
func answerFromCallKit(answerAction: CXAnswerCallAction) {
    guard let client = txClient else {
        answerAction.fulfill()  // Prevent CallKit hang
        return
    }
    client.answerFromCallkit(answerAction: answerAction, debug: true)
}
```

### 9.3 Web Answer Flow (for reference)

**File**: `resources/js/components/.../dialpad/context.tsx` (skill lines 997-1014)

```tsx
const answer = useCallback(() => {
    if (useNativeVoip) {
        TelnyxVoip.answerCall();
    } else {
        try {
            if (activeCall) activeCall.answer();  // SIP 200 OK via WebSocket
        } catch (e) { /* ... */ }
    }
}, [activeCall, useNativeVoip]);
```

---

## 10. Phase 8: Backend Answer Coordination

After the Android device sends SIP 200 OK, Telnyx receives it and sends a `call.answered` webhook to the backend.

**File**: `TelnyxInboundWebhookController.php::onCallAnswered()` (skill lines 2030-2174)

### Step 8.1: Parse Client State

```php
private function onCallAnswered(): void
{
    $payload = request()->input('data.payload', []);
    $clientState = $payload['client_state'] ?? null;
    $parsed = CPaaSService::parseClientState($clientState);
    $data = $parsed['data'] ?? [];
    $type = $data['type'] ?? null;

    if ($type !== 'simultaneous_ring_leg') { return; }

    $parentId = $data['parent_call_control_id'] ?? null;
    $legCallControlId = $payload['call_control_id'] ?? null;
}
```

### Step 8.2: Acquire Distributed Lock

```php
$lock = \Cache::lock("simring:{$parentId}:lock", 10);
if (!$lock->get()) {
    // Another answer is being processed — hang up this late answerer
    try {
        $call = \Telnyx\Call::constructFrom(['call_control_id' => $legCallControlId]);
        $call->hangup();
    } catch (\Throwable $e) {}
    return;
}
```

**Lock key**: `simring:v3:parent_abc123:lock`
**Lock TTL**: 10 seconds
**Lock mechanism**: Laravel Cache lock (Redis-backed atomic lock)

### Step 8.3: Check Ring Session

```php
try {
    $ringSession = \Cache::get("simring:{$parentId}");

    if ($ringSession && !$ringSession['answered']) {
        // First to answer — proceed with bridge
```

### Step 8.4: Mark Answered in Cache

```php
$ringSession['answered'] = true;
$ringSession['answered_leg'] = $legCallControlId;
\Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```

**Cache state after answer**:
```php
"simring:v3:parent_abc123" => [
    'parent_call_control_id' => 'v3:parent_abc123',
    'user_id' => 42,
    'message_id' => 789,
    'answered' => true,                    // ← changed
    'answered_leg' => 'v3:leg_android_001', // ← set
    'leg_ids' => ['v3:leg_android_001', 'v3:leg_ios_002', 'v3:leg_web_003'],
]
```

### Step 8.5: Answer Parent Call

```php
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])->answer([
    'client_state' => base64_encode(json_encode([
        'type' => 'simultaneous_ring_parent',
        'user_id' => $data['user_id'] ?? null,
        'message_id' => $data['message_id'] ?? null,
        'organization_id' => $data['organization_id'] ?? null,
    ])),
]);
```

**Telnyx API call**: `POST /v2/calls/{parent_call_control_id}/actions/answer`

**What happens**: The PSTN parent call is answered. The PSTN caller stops hearing ringback and enters the call. The parent call's `client_state` is now set to `simultaneous_ring_parent` for future webhook routing.

### Step 8.6: Bridge Parent ↔ Answered Leg

```php
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])
    ->bridge(['call_control_id' => $legCallControlId]);
```

**Telnyx API call**: `POST /v2/calls/{parent_call_control_id}/actions/bridge`
**Body**: `{ "call_control_id": "v3:leg_android_001" }`

**What happens**: Audio flows between the PSTN caller and the Android device. Both parties can now speak.

### Step 8.7: Start Recording

```php
\Telnyx\Call::constructFrom(['call_control_id' => $parentId])->record_start([
    'format' => 'wav',
    'channels' => 'dual',
    'trim' => 'trim-silence',
    'custom_file_name' => (string) $messageId,
]);
```

**Telnyx API call**: `POST /v2/calls/{parent_call_control_id}/actions/record_start`

**Recording is on the PARENT call** so the `call_session_id` matches the original message record.

### Step 8.8: Lock Release

```php
} finally {
    $lock->release();
}
```

---

## 11. Phase 9: Ring Dismissal (Three-Channel)

After the bridge is established, the backend dismisses all non-answering devices via three independent channels:

### Channel 1: SIP BYE (Other Legs)

```php
// Hang up other legs
foreach ($ringSession['leg_ids'] as $otherLegId) {
    if ($otherLegId !== $legCallControlId) {
        try {
            $otherCall = \Telnyx\Call::constructFrom(['call_control_id' => $otherLegId]);
            $otherCall->hangup();
        } catch (\Throwable $e) {
            // Leg may have already ended
        }
    }
}
```

**Telnyx API calls**:
- `POST /v2/calls/v3:leg_ios_002/actions/hangup`
- `POST /v2/calls/v3:leg_web_003/actions/hangup`

**Effect**: Telnyx sends SIP BYE to each device's SDK connection. The SDK fires `OnCallEnded` / `call.state = 'destroy'` events.

### Channel 2: Reverb Broadcast (Web)

```php
event(new CallEndedNotification(
    userId: (int) $userId,
    callSessionId: $callSessionId,
    reason: 'answered_elsewhere',
    organizationId: $organizationId ? (int) $organizationId : null,
));
```

**File**: `app/Events/CallEndedNotification.php` (skill lines 1369-1399)

```php
class CallEndedNotification implements ShouldBroadcast
{
    public function broadcastAs(): string { return 'call_ended'; }
    public function broadcastWith(): array {
        return [
            'call_session_id' => $this->callSessionId,
            'reason' => $this->reason,  // 'answered_elsewhere'
        ];
    }
}
```

**Web handler**: (skill lines 679-689)
```tsx
useEcho<{ call_session_id: string; reason: string }>(callEndedChannel, '.call_ended', (payload) => {
    if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
        try { activeCall.hangup(); } catch (e) { /* ... */ }
    }
});
```

### Channel 3: Push Notification (Mobile)

```php
PushNotificationService::sendCallEndedPush((int) $userId, $callSessionId);
```

**Push payload**:
```json
{
    "type": "call_ended",
    "call_session_id": "UUID"
}
```

**Android handler** (skill lines 714-734):
```kotlin
if (data["type"] == "call_ended") {
    val callSessionId = data["call_session_id"] ?: ""
    CallNotificationService.cancelNotification(this)
    nm?.cancel(9999)   // Z360Connection notification
    Z360VoipStore.getInstance(applicationContext).markCallEnded(callerNumber)
    val endIntent = Intent(ACTION_CALL_ENDED).apply { putExtra("call_session_id", callSessionId) }
    sendBroadcast(endIntent)
    return
}
```

**iOS handler** (skill lines 1041-1067):
```swift
if let pushType = payload["type"] as? String, pushType == "call_ended" {
    if let existingUUID = findExistingCallUUID(callerNumber: nil, telnyxCallId: callSessionId) {
        callKitManager?.reportCallEnded(uuid: existingUUID, reason: .answeredElsewhere)
    } else {
        // Must report fake call to satisfy PushKit contract, then immediately end it
        let fakeUUID = UUID()
        callKitManager?.reportIncomingCall(uuid: fakeUUID, ...) { error in
            if error == nil { self?.callKitManager?.reportCallEnded(uuid: fakeUUID, reason: .remoteEnded) }
        }
    }
}
```

**IncomingCallActivity dismissal** (skill lines 4787-4810):
```kotlin
val endedReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        stopRinging()
        nm?.cancel(9999)   // Z360Connection notification
        nm?.cancel(1234)   // Telnyx SDK notification
        Z360Connection.notifyDisconnected(DisconnectCause.REMOTE)
        store.clearIncomingCallMeta(callSessionId)
        finish()
    }
}
registerReceiver(endedReceiver, IntentFilter(ACTION_CALL_ENDED))
```

---

## 12. Phase 10: Call In Progress

After bridge establishment:
- **PSTN caller ↔ Android device**: Audio flows via WebRTC (Telnyx media servers)
- **Recording**: Dual-channel WAV recording active on parent leg
- **Android**: `ActiveCallActivity` shows with mute/hold/speaker/DTMF controls
- **iOS**: Call UI already dismissed (answered elsewhere)
- **Web**: Call UI already dismissed (call_ended broadcast received)

---

## 13. Phase 11: Call Ends — PSTN Caller Hangs Up

**Trigger**: PSTN caller hangs up → Telnyx sends `call.hangup` webhook with `client_state.type = 'simultaneous_ring_parent'`

**File**: `TelnyxInboundWebhookController.php::onCallHangup()` → dispatches to `onSimultaneousRingParentHangup()` (skill line 1709)

**File**: `TelnyxInboundWebhookController.php::onSimultaneousRingParentHangup()` (skill lines 2181-2244)

```php
private function onSimultaneousRingParentHangup(array $csData, array $payload): void
{
    $parentCallControlId = $payload['call_control_id'] ?? null;
    $userId = $csData['user_id'] ?? null;
    $messageId = $csData['message_id'] ?? null;
    $organizationId = $csData['organization_id'] ?? null;

    $ringSession = $parentCallControlId ? \Cache::get("simring:{$parentCallControlId}") : null;

    // If the call was answered and bridged, hang up the answered leg
    if ($ringSession && ($ringSession['answered'] ?? false)) {
        $answeredLeg = $ringSession['answered_leg'] ?? null;
        if ($answeredLeg) {
            try {
                $legCall = \Telnyx\Call::constructFrom(['call_control_id' => $answeredLeg]);
                $legCall->hangup();
            } catch (\Throwable $e) { /* Leg may have already ended */ }
        }
    }

    // Clean up cache
    \Cache::forget("simring:{$parentCallControlId}");

    // Send call_completed notifications
    if ($userId) {
        PushNotificationService::sendCallEndedPush((int) $userId, $callSessionId);

        event(new CallEndedNotification(
            userId: (int) $userId,
            callSessionId: $callSessionId,
            reason: 'call_completed',
            organizationId: $organizationId ? (int) $organizationId : null,
        ));
    }
}
```

**Sequence**:
1. Hang up the bridged Android leg: `POST /v2/calls/v3:leg_android_001/actions/hangup`
2. Delete cache: `Cache::forget("simring:v3:parent_abc123")`
3. Push `call_ended` to mobile devices
4. Broadcast `call_ended` (reason: `call_completed`) to web sessions

---

## 14. Phase 12: Call Ends — Device User Hangs Up

**Trigger**: User taps "End Call" on Android → SDK sends SIP BYE → Telnyx sends `call.hangup` webhook with `client_state.type = 'simultaneous_ring_leg'` + `answered = true`

**File**: `TelnyxInboundWebhookController.php::onSimultaneousRingLegHangup()` (skill lines 2250-2357)

```php
private function onSimultaneousRingLegHangup(array $csData, array $payload): void
{
    $parentId = $csData['parent_call_control_id'] ?? null;
    $legCallControlId = $payload['call_control_id'] ?? null;

    $lock = \Cache::lock("simring:{$parentId}:lock", 10);
    if (!$lock->get()) { return; }

    try {
        $ringSession = \Cache::get("simring:{$parentId}");

        // If already answered and THIS is the answered leg hanging up
        if ($ringSession['answered']) {
            $answeredLeg = $ringSession['answered_leg'] ?? null;

            if ($answeredLeg === $legCallControlId) {
                // Hang up the parent call (PSTN caller)
                $parentCall = \Telnyx\Call::constructFrom(['call_control_id' => $parentId]);
                $parentCall->hangup();

                // Notify user
                PushNotificationService::sendCallEndedPush((int) $userId, $callSessionId);
                event(new CallEndedNotification(
                    userId: (int) $userId,
                    callSessionId: $callSessionId,
                    reason: 'call_completed',
                    organizationId: $organizationId ? (int) $organizationId : null,
                ));

                \Cache::forget("simring:{$parentId}");
            }
            return;
        }

        // Not answered yet: remove leg from tracked legs
        $ringSession['leg_ids'] = array_values(array_filter(
            $ringSession['leg_ids'],
            fn ($id) => $id !== $legCallControlId
        ));
        \Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));

        // If all legs gone and nobody answered → voicemail
        if (empty($ringSession['leg_ids'])) {
            $this->transferToVoicemail($parentId, $message);
            \Cache::forget("simring:{$parentId}");
        }
    } finally {
        $lock->release();
    }
}
```

---

## 15. Complete Timing Diagram

```
T(ms)    PSTN       Telnyx CC      Laravel Backend        Android           iOS               Web
─────    ────       ─────────      ──────────────         ───────           ───               ───
  0      INVITE ──►

 50                  call.initiated
                     webhook ─────► TelnyxCallController

100                                 Parse webhook
                                    Resolve org + user
                                    Check blocked/schedule
                                    Create Message + Conversation

150                                 ── FCM push ─────────► Z360FirebaseMS
                                    ── APNs VoIP push ──────────────────► PushKitManager
                                    ── Reverb broadcast ────────────────────────────────────► Echo
                                    (broadcast not used for incoming call detection)

200                                 Query user_device_tokens
                                    WHERE sip_username IS NOT NULL
                                    AND last_active_at >= now()-1day
                                    Result: 3 SIP destinations

250                                 Call::create() × 3:
                                    ──► sip:android@sip.telnyx.com
                                    ──► sip:ios@sip.telnyx.com
                                    ──► sip:web@sip.telnyx.com

                                    Cache::put("simring:{parent}", {
                                      answered: false,
                                      leg_ids: []
                                    }, 10min)

300                  SIP INVITE ──► ──────────────────────► Telnyx SDK      ──► Telnyx SDK
                     to each device

                     call.initiated
                     × 3 legs ────► onSimRingLegInitiated()
                                    leg_ids[] << each leg

350                                                         PushSynchronizer   PushCorrelator
                                                            correlate pushes   correlate pushes
                                                            (500ms timeout)    (500ms-1.5s)

400                                                         ensureSdkConnected  reportIncomingCall()
                                                            showNotification    to CallKit (< 5s)

450                                                         IncomingCallActivity  iOS call UI      Dialer shows
                                                            launches              appears          <IncomingCall/>

3000     Hears                                              USER TAPS
         ringback                                           ANSWER

3050                                                        answerDirectly()
                                                            telnyxViewModel
                                                            .answerCall(UUID)
                                                            ──► SIP 200 OK

3100                 call.answered
                     webhook ─────► onCallAnswered()

3150                                Cache::lock("simring:{parent}:lock", 10s)
                                    ✓ Lock acquired

3200                                ringSession.answered = true
                                    ringSession.answered_leg = leg_android

                                    Answer parent:
                                    Call::answer(client_state: "simultaneous_ring_parent")
                                    ──► PSTN caller stops hearing ringback

3250                                Bridge parent ↔ leg_android:
                                    Call::bridge(call_control_id: leg_android)
                                    ──► Audio flows

3300                                record_start(wav, dual, parent)

3350                                Hang up other legs:
                                    Call::hangup(leg_ios)  ─────────────────► SIP BYE
                                    Call::hangup(leg_web)  ──────────────────────────────────► SIP BYE

3400                                CallEndedNotification(answered_elsewhere) ───────────────► .call_ended listener
                                    PushNotificationService::sendCallEndedPush() ──────────► call_ended push
                                                                                 ──────────────► call_ended push

3450                                Lock::release()
                                                                                  CallKit:
                                                                                  .answeredElsewhere  hangup ringing
                                                            ActiveCallActivity
                                                            shows (connected)

3500     Audio ◄────────────────────────────────────── Media flows (WebRTC) ────►

...      CALL IN PROGRESS

120000   Caller
         hangs up

120050               call.hangup
                     webhook ─────► onSimRingParentHangup()

120100                              Call::hangup(leg_android)
                                    Cache::forget("simring:{parent}")
                                    Push call_ended
                                    Broadcast call_completed
                                                            OnCallEnded
                                                            → finish()

120200                                                      ActiveCallActivity
                                                            ─► cleanup
```

---

## 16. Complete Cache Key Reference

### `simring:{parent_call_control_id}`

| Field | Type | Initial | After Leg Init | After Answer |
|-------|------|---------|----------------|--------------|
| `parent_call_control_id` | string | `v3:parent_abc123` | — | — |
| `user_id` | int | `42` | — | — |
| `message_id` | int | `789` | — | — |
| `answered` | bool | `false` | `false` | `true` |
| `answered_leg` | string\|null | not present | not present | `v3:leg_android_001` |
| `leg_ids` | array | `[]` | `[v3:leg_a, v3:leg_i, v3:leg_w]` | unchanged |
| **TTL** | | **10 min** | **10 min** (refreshed) | **10 min** (refreshed) |

**Lifecycle**:
1. Created in `transferToUser()` with `answered: false, leg_ids: []`
2. `leg_ids` populated by `onSimultaneousRingLegInitiated()` (one entry per `call.initiated` webhook)
3. `answered` set to `true` and `answered_leg` set in `onCallAnswered()`
4. Deleted by `Cache::forget()` in either `onSimultaneousRingParentHangup()` or `onSimultaneousRingLegHangup()`

### `simring:{parent_call_control_id}:lock`

| Property | Value |
|----------|-------|
| Type | Laravel atomic cache lock |
| TTL | 10 seconds |
| Used in | `onCallAnswered()`, `onSimultaneousRingLegHangup()` |
| Purpose | Prevents race condition when two devices answer simultaneously |

---

## 17. Complete API Call Reference

### Telnyx API Calls (Backend → Telnyx)

| Step | API Call | Parameters | Purpose |
|------|----------|------------|---------|
| Credential creation | `POST /v2/telephony_credentials` | `name`, `connection_id` | Per-device SIP credential |
| Leg creation (×N) | `POST /v2/calls` | `to`, `from`, `connection_id`, `webhook_url`, `timeout_secs: 30`, `client_state` | Create outbound SIP leg |
| Answer parent | `POST /v2/calls/{parent}/actions/answer` | `client_state` | Answer parked PSTN call |
| Bridge | `POST /v2/calls/{parent}/actions/bridge` | `call_control_id: {answered_leg}` | Connect audio |
| Record | `POST /v2/calls/{parent}/actions/record_start` | `format: wav`, `channels: dual`, `trim: trim-silence`, `custom_file_name` | Start recording |
| Hangup (×N-1) | `POST /v2/calls/{leg}/actions/hangup` | — | Dismiss other legs |
| Hangup (bridged) | `POST /v2/calls/{leg}/actions/hangup` | — | End call (PSTN hung up) |

### Webhooks (Telnyx → Backend)

| Webhook | Handler | Purpose |
|---------|---------|---------|
| `call.initiated` (parent) | `handleCall()` | Route incoming call |
| `call.initiated` (×N legs) | `onSimultaneousRingLegInitiated()` | Track leg IDs |
| `call.answered` (leg) | `onCallAnswered()` | Lock + bridge + dismiss |
| `call.hangup` (leg, answered) | `onSimultaneousRingLegHangup()` | Hang up parent |
| `call.hangup` (leg, unanswered) | `onSimultaneousRingLegHangup()` | Remove from tracking, voicemail if all gone |
| `call.hangup` (parent) | `onSimultaneousRingParentHangup()` | Hang up bridged leg, cleanup |

### Notifications (Backend → Clients)

| Channel | Event | Payload | Recipients |
|---------|-------|---------|------------|
| FCM push | `incoming_call` | Full caller info + org data | Android devices |
| APNs VoIP push | `incoming_call` | Full caller info + org data | iOS devices |
| Reverb broadcast | `incoming_call` | Caller info + org data | Web sessions (unused) |
| FCM push | `call_ended` | `call_session_id` | Android devices |
| APNs VoIP push | `call_ended` | `call_session_id` | iOS devices |
| Reverb broadcast | `call_ended` | `call_session_id`, `reason` | Web sessions (used) |

### client_state Types

| Type | Used On | Purpose |
|------|---------|---------|
| `simultaneous_ring_leg` | Outbound legs (N per call) | Identifies leg for webhook routing |
| `simultaneous_ring_parent` | Parent call (after answer) | Identifies parent for hangup routing |
| `user_call` | Single-device transfer | Simple 1:1 transfer (no simring) |
| `voicemail_parent` | Parent call (voicemail) | Routes to voicemail handler |

---

**End of Happy-Path Document**

*Code evidence sourced from: voip-backend skill (lines 1369-4420), voip-android skill (lines 629-8926), voip-ios skill (lines 559-9328), voip-frontend skill (lines 478-1039)*
