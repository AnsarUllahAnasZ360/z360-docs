---
title: Simring Failure Modes
---

# Simultaneous Ringing: Failure Mode Analysis

> **Scope**: Every identified failure scenario in Z360's simultaneous ringing implementation, with root causes, step-by-step sequences, user-visible symptoms, and severity assessments.

---

## Table of Contents

1. [Two Devices Answer Simultaneously](#1-two-devices-answer-simultaneously)
2. [Push Notification Delayed or Missing](#2-push-notification-delayed-or-missing)
3. [Stale Device Credential / Device Offline](#3-stale-device-credential--device-offline)
4. [Caller Hangs Up During Ring](#4-caller-hangs-up-during-ring)
5. [Bridge Failure After Answer](#5-bridge-failure-after-answer)
6. [Lock Expiry / Double Bridge](#6-lock-expiry--double-bridge)
7. [Webhook Out of Order](#7-webhook-out-of-order)
8. [Network Partition / Partial Leg Creation](#8-network-partition--partial-leg-creation)
9. [Ghost Credentials (Known Bug)](#9-ghost-credentials-known-bug)
10. [Duplicate Registrations (Known Bug)](#10-duplicate-registrations-known-bug)
11. ["Kept Ringing After Answer" — Android (Known Bug)](#11-kept-ringing-after-answer--android-known-bug)
12. [Web Multi-Tab Conflicts](#12-web-multi-tab-conflicts)
13. [Cross-Organization Call Failure](#13-cross-organization-call-failure)
14. [iOS CallKit / PushKit Edge Cases](#14-ios-callkit--pushkit-edge-cases)
15. [Cache Expiry During Active Call](#15-cache-expiry-during-active-call)

---

## 1. Two Devices Answer Simultaneously

**Severity**: Medium (handled by design, but edge cases exist)

### What the Code Does

The backend uses a Redis atomic lock with 10-second TTL:

```php
// TelnyxInboundWebhookController.php — onCallAnswered()
$lock = \Cache::lock("simring:{$parentId}:lock", 10);
if (!$lock->get()) {
    // Could not acquire lock — another answer in progress
    try {
        $call = \Telnyx\Call::constructFrom(['call_control_id' => $legCallControlId]);
        $call->hangup();
    } catch (\Throwable $e) {}
    return;
}
```
**Source**: `.claude/skills/voip-backend/references/files.md:2057-2067`

Inside the lock, it checks `$ringSession['answered']`:
```php
if ($ringSession && !$ringSession['answered']) {
    // First to answer — bridge with parent
    $ringSession['answered'] = true;
    // ... answer parent, bridge, hang up other legs
} else {
    // Someone already answered — hang up this leg
    $call->hangup();
}
```
**Source**: `.claude/skills/voip-backend/references/files.md:2072-2170`

### Step-by-Step Failure Sequence

1. Device A and Device B both answer within ~10ms
2. `call.answered` webhooks arrive nearly simultaneously at the backend
3. **First webhook** acquires lock, marks `answered = true`, answers parent, bridges, hangs up other legs, sends `call_ended` push/broadcast
4. **Second webhook** either:
   - (a) **Cannot acquire lock** → hangs up this leg immediately (line 2063-2064)
   - (b) **Acquires lock after first releases** → sees `answered = true` → hangs up this leg (line 2164-2166)

### User-Visible Effect

- **Normal case**: Second device shows "call ended" after a brief moment. Works correctly.
- **Edge case**: If the second webhook arrives during the bridge operation (between lock acquire and lock release), the second device's call may already be audibly connected for a fraction of a second before being hung up. The user hears a click then silence.

### Root Cause of Potential Issues

The lock TTL is 10 seconds. The entire answer-bridge-hangup-notify sequence must complete within that window. If the Telnyx API is slow (answer + bridge + N hangup calls), the lock could expire before `finally { $lock->release(); }` executes. See [Failure Mode #6](#6-lock-expiry--double-bridge).

### Gap Analysis

- **No recovery for second device**: When the second device's leg is hung up, the device receives a SIP BYE. The Android `TelnyxSocketEvent.OnCallEnded` handler dismisses the UI (`.claude/skills/voip-android/references/files.md:1429-1434`). This works correctly.
- **Missing: User feedback**: Neither device gets an explicit "answered elsewhere" message from the app — the call just ends.

---

## 2. Push Notification Delayed or Missing

**Severity**: High (impacts user experience, especially on Android)

### Two-Push Architecture

Z360 uses a two-push system:
- **Z360 push** (FCM data message): Contains caller display info (name, number, avatar, org context)
- **Telnyx push** (FCM data message with metadata): Contains SIP call control metadata for the SDK

These are coordinated by `PushSynchronizer` on Android (500ms timeout):

```kotlin
// PushSynchronizer.kt
private const val SYNC_TIMEOUT_MS = 500L

val result = withTimeoutOrNull(SYNC_TIMEOUT_MS) {
    // Wait for the other push to arrive
}
```
**Source**: `.claude/skills/voip-android/references/files.md:42, 213`

### Failure Scenario A: Telnyx Push Arrives, Z360 Push Missing

1. Telnyx SDK push arrives with SIP metadata
2. `PushSynchronizer.onTelnyxPushReceived()` starts 500ms wait for Z360 push
3. **Z360 push doesn't arrive** (FCM delivery failure, backend error, etc.)
4. After 500ms timeout, `IncomingCallActivity` launches with fallback info (raw caller number, no name/avatar)
5. SIP INVITE arrives, device rings

**User experience**: Device rings but shows raw phone number instead of contact name. Call is answerable.

### Failure Scenario B: Z360 Push Arrives, Telnyx Push Missing

1. Z360 backend push arrives with caller display info
2. Stored in `Z360VoipStore`
3. **Telnyx push never arrives** (Telnyx infrastructure issue, FCM token stale for Telnyx)
4. SIP INVITE also doesn't arrive (since Telnyx push triggers SDK connection)
5. Device stores caller info but never rings

**User experience**: Device doesn't ring at all. The backend-created SIP leg times out after 30 seconds. If this is the only device, voicemail triggers via `onSimultaneousRingLegHangup`.

### Failure Scenario C: SIP INVITE Arrives Without Any Push (Web)

On web, there's no push dependency. The TelnyxRTC WebSocket connection receives the SIP INVITE directly. The Reverb `IncomingCallNotification` broadcast provides display info:

```typescript
// dialpad/context.tsx
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);
```
**Source**: `.claude/skills/voip-frontend/references/files.md:678`

If Reverb broadcast fails but WebRTC works, the web shows the incoming call with raw SIP info only.

### Root Cause

- FCM is best-effort delivery — Google does not guarantee delivery timing or order
- Android Doze mode / battery optimization can delay FCM by minutes
- Telnyx push infrastructure is independent from Z360 push infrastructure
- No retry mechanism for either push type
- `sendCallEndedPush` does NOT filter by organization — sends to ALL user devices:
  ```php
  // PushNotificationService.php:162-164
  public static function sendCallEndedPush(int $userId, string $callSessionId): array
  {
      $fcmTokens = UserDeviceToken::getFcmTokensForUser($userId);
      $apnsTokens = UserDeviceToken::getApnsVoipTokensForUser($userId);
  ```
  **Source**: `app/Services/PushNotificationService.php:162-165`

---

## 3. Stale Device Credential / Device Offline

**Severity**: High (directly causes ghost ringing and wasted SIP legs)

### How SIP Destinations Are Selected

```php
// TelnyxInboundWebhookController.php — transferToUser()
$sipDestinations = \App\Models\UserDeviceToken::where('user_id', $user->id)
    ->whereNotNull('sip_username')
    ->where('last_active_at', '>=', now()->subDay())
    ->pluck('sip_username')
    ->toArray();
```
**Source**: `.claude/skills/voip-backend/references/files.md:1845-1849`

### The 24-Hour `last_active_at` Filter

The only staleness check is `last_active_at >= now()->subDay()` (24 hours). This timestamp is updated:
- On device token registration: `'last_active_at' => now()` (line 2814, 2919)
- On successful push send: `$device->update(['last_active_at' => now()])` (line 125-126)

### Failure Sequence

1. User installs app on Phone B, registers device token, gets SIP credential
2. User stops using Phone B (e.g., gets new phone, uninstalls app)
3. Phone B's `last_active_at` stays within 24 hours if any push was recently sent to it
4. Incoming call → backend creates SIP leg to Phone B's credential
5. Telnyx sends SIP INVITE to Phone B's credential → **nobody is listening**
6. INVITE times out after 30 seconds → `call.hangup` with `timeout` cause
7. `onSimultaneousRingLegHangup` removes this leg from the session
8. If Phone B was the last leg → voicemail triggered (even though Phone A might have been available if another leg was created for it)

### Critical Gap: No Credential Expiry Check

The `credential_expires_at` field exists (set to 30 days at creation) but is **never checked**:

```php
// createDeviceCredential() sets it:
'credential_expires_at' => now()->addDays(30),
```
**Source**: `.claude/skills/voip-backend/references/files.md:4386`

But `transferToUser()` only checks `last_active_at`, not `credential_expires_at`. A credential that expired weeks ago will still be dialed if the device was recently pushed to.

### What Happens to the SIP Leg

When Telnyx sends an INVITE to a stale SIP credential:
- If no SDK is connected: INVITE gets 408 Request Timeout or 480 Temporarily Unavailable
- Telnyx fires `call.hangup` webhook with `hangup_cause: timeout` or `sip_hangup_cause: 480`
- This takes **up to 30 seconds** (the `timeout_secs` parameter in `Call::create`)
- During this time, the caller hears ringback and other devices may have already been answered

### Root Cause

1. **No credential validation**: `createDeviceCredential()` creates a new Telnyx credential every time it's called without checking if the device already has one
2. **No expiry enforcement**: `credential_expires_at` is stored but never evaluated
3. **Stale window too large**: 24-hour `last_active_at` window means devices that were active yesterday but offline today still get SIP legs
4. **No cleanup on app uninstall**: There's no mechanism to detect uninstalled apps and remove their credentials

---

## 4. Caller Hangs Up During Ring

**Severity**: Critical (SIP legs not actively cancelled, devices ring for up to 30 seconds after caller disconnects)

### What Actually Happens

When the PSTN caller hangs up while devices are ringing:

1. Telnyx sends `call.hangup` for the **parent** call
2. The parent call has **no client_state** (it was never answered, so no `simultaneous_ring_parent` tag was set)
3. `onCallHangup()` checks client_state types:
   ```php
   if (($csData['type'] ?? null) === 'simultaneous_ring_leg') { ... }
   if (($csData['type'] ?? null) === 'simultaneous_ring_parent') { ... }
   // Falls through to default handler
   ```
   **Source**: `.claude/skills/voip-backend/references/files.md:1702-1711`

4. Default handler sends `call_ended` push + Reverb broadcast (good)
5. Checks `originator_cancel` and **returns early**:
   ```php
   if ($data->hangup_cause === 'originator_cancel') {
       return;
   }
   ```
   **Source**: `.claude/skills/voip-backend/references/files.md:1749-1751`

### Critical Gap: SIP Legs Not Cancelled

The default `onCallHangup` handler does **NOT**:
- Look up the simring cache (`simring:{call_control_id}`)
- Cancel the outbound SIP legs
- Clean up the simring cache entry

The outbound SIP legs created by `Call::create()` are **independent calls** — they are not child legs of the parent. Telnyx does NOT automatically cancel them when the parent is hung up.

### What Devices Experience

**Android / iOS (push-based dismissal)**:
1. Backend sends `call_ended` push via `PushNotificationService::sendCallEndedPush()`
2. FCM delivers the push (best-effort, may be delayed by Doze mode)
3. `Z360FirebaseMessagingService` broadcasts `ACTION_CALL_ENDED`
4. `IncomingCallActivity` receives broadcast and finishes:
   ```kotlin
   // IncomingCallActivity
   VoipLogger.d(LOG_COMPONENT, "Received call_ended broadcast, dismissing incoming call UI")
   stopRinging()
   Z360Connection.notifyDisconnected(android.telecom.DisconnectCause.REMOTE)
   finish()
   ```
   **Source**: `.claude/skills/voip-android/references/files.md:4790-4799`
5. **But**: The Telnyx SIP INVITE is still active. The device's Telnyx SDK may show a SIP-level notification (notification ID 1234) even after the Activity is dismissed.
6. The SIP leg times out after 30 seconds from the `timeout_secs` parameter.

**Web (Reverb-based dismissal)**:
1. `CallEndedNotification` broadcast via Reverb
2. `call_ended` event triggers `activeCall.hangup()`:
   ```typescript
   if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
       activeCall.hangup();
   }
   ```
   **Source**: `.claude/skills/voip-frontend/references/files.md:683-685`
3. This properly terminates the WebRTC call from the client side.

### Timing Analysis

- Push delivery: 100ms–5s (FCM best-effort, worse in Doze mode)
- Reverb broadcast: 50–200ms (WebSocket, reliable if connected)
- SIP leg timeout: 30 seconds (hardcoded in `Call::create`)
- **Gap**: Between caller hangup and device notification, devices ring for push_delivery_time

### Root Cause

The parent call's `call.hangup` webhook arrives with no client_state (the parent was never answered/tagged). The handler doesn't look up the simring cache to find and cancel active legs. The `originator_cancel` early return prevents any further action.

### Recommended Fix

In `onCallHangup()`, before the `originator_cancel` return, check the simring cache and cancel all legs:

```php
// Proposed: look up simring cache for this parent call and cancel legs
$ringSession = \Cache::get("simring:{$data->call_control_id}");
if ($ringSession && !$ringSession['answered']) {
    foreach ($ringSession['leg_ids'] as $legId) {
        try {
            \Telnyx\Call::constructFrom(['call_control_id' => $legId])->hangup();
        } catch (\Throwable $e) {}
    }
    \Cache::forget("simring:{$data->call_control_id}");
}
```

---

## 5. Bridge Failure After Answer

**Severity**: Critical (call answered but no audio, caller in limbo)

### Failure Sequence

1. Device A answers → lock acquired → `answered = true` in cache
2. Parent answered via `Call::answer()` — caller stops hearing ringback
3. `Call::bridge()` **fails** (Telnyx API error, timeout, rate limit)
4. Error caught by the try/catch:
   ```php
   } catch (\Throwable $e) {
       VoipLog::error('Simultaneous ring: bridge failed', $callSessionId, [
           'error' => $e->getMessage(),
           'parent_call_control_id' => $parentId,
       ]);
   }
   ```
   **Source**: `.claude/skills/voip-backend/references/files.md:2156-2160`

### What Happens Next

- The parent call has been **answered** (caller hears silence, no longer ringing)
- The answered leg is connected (device user hears silence)
- Other legs have been **hung up** (they were hung up AFTER the bridge attempt, inside the same try block — **wait, actually they're hung up BEFORE the catch**):

Looking at the code flow inside the try block (lines 2078-2134):
1. Answer parent (line 2088)
2. Bridge parent to leg (line 2102-2103)
3. Start recording (line 2112)
4. Hang up other legs (line 2125-2133)
5. Send call_ended broadcast (line 2141-2155)

If `bridge()` fails at step 2, steps 3-5 are **skipped** because they're all inside the same try block. This means:
- Other legs are **NOT hung up** — they keep ringing
- `call_ended` push/broadcast is **NOT sent** — other devices keep showing incoming call
- The caller hears silence (parent answered but not bridged)
- The answering device hears silence (leg connected but not bridged)

### Recovery

**None implemented.** There is no retry mechanism for bridge failures. The call is in a broken state:
- Parent: answered, unbridged, silent
- Answered leg: active, unbridged, silent
- Other legs: still ringing (never cancelled)
- Other devices: still showing incoming call

The call will eventually end when:
- The caller hangs up (after hearing silence) → parent hangup webhook → `onSimultaneousRingParentHangup` cleans up
- The user hangs up on the answered device → leg hangup webhook → `onSimultaneousRingLegHangup` hangs up parent
- Other legs time out (30 seconds)

### Root Cause

1. Bridge failure has no recovery path — no retry, no fallback
2. All post-bridge operations (hangup other legs, send notifications) are inside the same try block as the bridge call, so they're all skipped on failure
3. The parent has already been answered before the bridge, so the caller hears silence instead of ringback

### Recommended Fix

Restructure so that hanging up other legs and sending notifications happen regardless of bridge success. Consider: answer parent only after bridge succeeds, or implement bridge retry with timeout.

---

## 6. Lock Expiry / Double Bridge

**Severity**: High (theoretical, but catastrophic if it occurs)

### The Lock Configuration

```php
$lock = \Cache::lock("simring:{$parentId}:lock", 10); // 10-second TTL
```
**Source**: `.claude/skills/voip-backend/references/files.md:2057`

### Failure Sequence

1. Device A's `call.answered` webhook acquires lock (t=0)
2. Backend starts processing: answer parent, bridge, etc.
3. Telnyx API calls are slow (rate limiting, network issues)
4. At t=10, lock TTL expires — lock auto-releases
5. Device B's `call.answered` webhook (queued since t=1) now acquires the lock
6. Device B reads cache: `answered = true` (set by Device A at t=2)
7. Device B falls into the else branch: hangs up its own leg. **Safe.**

**Alternative scenario if timing is different:**

1. Device A acquires lock (t=0)
2. Device A sets `answered = true` in cache, calls `Call::answer()` on parent
3. `Call::answer()` takes 8 seconds (API issue)
4. Lock expires at t=10
5. Device B acquires lock, reads cache: `answered = true` → hangs up own leg (safe)
6. Device A finally gets answer response, proceeds to bridge
7. Device A releases lock in `finally` block — but lock was already expired and re-acquired by B
8. `$lock->release()` in A's finally block may release B's lock or be a no-op (depends on Redis lock implementation)

### Gap Analysis

The double-bridge scenario is **unlikely** because:
- The cache check `!$ringSession['answered']` happens inside the lock
- Even if the lock expires, the flag is set before the slow operations
- Redis atomic locks in Laravel use owner tokens, so releasing someone else's lock is a no-op

**However**, if the answer + bridge + hangup sequence takes >10 seconds AND a third webhook arrives, the third webhook could see `answered = false` if the cache write at line 2076 hasn't been reached yet. This would require:
- Lock holder to be blocked BEFORE the cache write
- Which means before line 2074 (immediately after lock acquisition)
- This is a very narrow race window

### Root Cause

The 10-second lock TTL is chosen to prevent deadlocks but creates a theoretical window for double processing. In practice, this is very unlikely due to the cache flag check.

---

## 7. Webhook Out of Order

**Severity**: Medium (handled, but with timing gaps)

### The Leg Tracking Race

When `transferToUser()` creates legs, it stores the ring session in cache:
```php
\Cache::put("simring:{$call_control_id}", [
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
    'answered' => false,
    'leg_ids' => [],    // Empty! Leg IDs are added later via call.initiated webhooks
], now()->addMinutes(10));
```
**Source**: `.claude/skills/voip-backend/references/files.md:1955-1961`

Leg IDs are populated by `onSimultaneousRingLegInitiated()` when each leg's `call.initiated` webhook arrives:
```php
$ringSession['leg_ids'][] = $legCallControlId;
\Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```
**Source**: `.claude/skills/voip-backend/references/files.md:2382-2383`

### Failure Scenario: `call.answered` Before `call.initiated`

1. Backend creates Leg A via `Call::create()`
2. Telnyx processes the leg creation
3. Device A answers **very quickly** (auto-answer, or push arrived early)
4. Telnyx sends `call.answered` for Leg A
5. Backend hasn't yet received `call.initiated` for Leg A

In `onCallAnswered()`:
- Lock is acquired
- Cache is read: `leg_ids = []` (empty, call.initiated not processed yet)
- `answered = true` is set
- Bridge succeeds
- "Hang up other legs" loop: `foreach ($ringSession['leg_ids'] as $otherLegId)` — **nothing to iterate over**

**Result**: Other legs are NOT hung up because their IDs aren't in the cache yet. They continue ringing until their 30-second timeout.

### Failure Scenario: `call.hangup` Before `call.initiated`

If a leg immediately fails (invalid SIP credential):
1. `Call::create()` succeeds (returns call_control_id)
2. Telnyx sends `call.hangup` immediately (invalid SIP endpoint)
3. `onSimultaneousRingLegHangup()` tries to remove leg from `leg_ids` — but it's not there yet
4. `call.initiated` arrives later — leg is added to `leg_ids`
5. This leg will never be removed from `leg_ids` (it already hung up)
6. If all other legs hang up, the count check `empty($ringSession['leg_ids'])` will see this orphan ID and NOT trigger voicemail

### Root Cause

The `leg_ids` array starts empty and is populated asynchronously by webhooks. There's a timing gap between `Call::create()` returning and `call.initiated` arriving. The code assumes leg IDs are available by the time `call.answered` or `call.hangup` arrives, which is not guaranteed.

### Impact on "Hang Up Other Legs"

When Device A answers and tries to hang up other legs, it can only hang up legs whose `call.initiated` has already been processed. Any leg whose `call.initiated` is still in the webhook queue will continue ringing.

---

## 8. Network Partition / Partial Leg Creation

**Severity**: Medium (has retry mechanism, but with issues)

### The Retry Logic

```php
foreach ($sipDestinations as $sip) {
    try {
        \Telnyx\Call::create([...]);
        $createdLegs[] = $sip;
    } catch (\Throwable $e) {
        VoipLog::warning("Failed to create sim-ring leg for {$sip}", ...);
    }
}

if (empty($createdLegs)) {
    // Retry once after 2s
    usleep(2_000_000);
    // ... same loop again ...
    if (empty($createdLegs)) {
        $this->transferToVoicemail($call_control_id, $message);
        return;
    }
}
```
**Source**: `.claude/skills/voip-backend/references/files.md:1889-1946`

### Failure Scenarios

**Partial creation (some legs succeed, some fail)**:
- If 2 of 3 legs are created, the call proceeds with those 2 devices
- The failed device doesn't ring, but push was already sent to all devices
- **User confusion**: Device receives push notification (showing incoming call info) but never rings via SIP

**Total failure with retry**:
- All legs fail on first attempt
- 2-second `usleep()` blocks the HTTP request handler
- **Problem**: This is a synchronous webhook handler — the 2-second sleep blocks the Telnyx webhook response
- Telnyx may retry the webhook if no 200 response within their timeout
- After retry, if all fail again, voicemail is triggered

**Partial failure on retry**:
- First attempt: all fail
- Retry: some succeed
- But the retry creates legs for ALL destinations, including ones that failed initially
- If a destination was temporarily down, the retry might succeed — creating a duplicate leg for the same device
- **However**: Since `Call::create()` creates new calls each time, this doesn't create duplicates on the same SIP credential (each is a new INVITE)

### Root Cause

1. `usleep(2_000_000)` in a webhook handler is blocking — delays webhook response
2. No partial retry — if any legs fail, all are retried (potentially creating extra legs for already-successful destinations — **wait, no**: the retry only fires if `empty($createdLegs)`, meaning ALL legs failed)
3. Push notifications are sent BEFORE legs are created (line 1812-1820), so devices get push even if their SIP leg fails

---

## 9. Ghost Credentials (Known Bug)

**Severity**: Critical (causes phantom SIP legs, wasted Telnyx resources, delayed call setup)

### The Credential Lifecycle

**Creation** — `CPaaSService::createDeviceCredential()`:
```php
public static function createDeviceCredential(User $user, UserDeviceToken $deviceToken): ?UserDeviceToken
{
    $name = "Device-{$deviceToken->device_id}_".Str::random(8);
    $credential = \Telnyx\TelephonyCredential::create([
        'name' => $name,
        'connection_id' => $connectionId,
    ]);
    $deviceToken->update([
        'telnyx_credential_id' => $credential->id,
        'sip_username' => $credential->sip_username,
        'sip_password' => $credential->sip_password,
        'credential_expires_at' => now()->addDays(30),
    ]);
}
```
**Source**: `.claude/skills/voip-backend/references/files.md:4368-4389`

**Deletion** — `DeviceTokenController::destroy()`:
```php
public function destroy(Request $request)
{
    Auth::user()->deviceTokens()
        ->where('fcm_token', $validated['fcm_token'])
        ->delete();
}
```
**Source**: `.claude/skills/voip-backend/references/files.md:2824-2835`

### Critical Gaps

1. **No check for existing credential before creation**: `createDeviceCredential()` always creates a new Telnyx credential. If called twice for the same device token (e.g., app reinstall, re-login), the old Telnyx credential is **orphaned** — it still exists on Telnyx's platform but the reference in the DB is overwritten.

2. **`destroy()` doesn't delete the Telnyx credential**: When a user logs out, `DeviceTokenController::destroy()` deletes the DB row but does NOT call `CPaaSService::deleteTelnyxCredential()` to remove the credential from Telnyx. The credential continues to exist on Telnyx's platform.

3. **No cleanup on app uninstall**: When a user uninstalls the app, the FCM token becomes invalid, but the DB row and Telnyx credential remain.

4. **No expiry enforcement**: `credential_expires_at` is set but never checked by any code path.

5. **Token reassignment without credential cleanup**: `registerToken()` uses `updateOrCreate` keyed on `fcm_token`:
   ```php
   UserDeviceToken::updateOrCreate(
       ['fcm_token' => $validated['fcm_token']],
       ['user_id' => Auth::id(), ...]
   );
   ```
   **Source**: `.claude/skills/voip-backend/references/files.md:2809-2816`

   When a new user logs in on the same device, the token is reassigned. The old SIP credential (belonging to the previous user) is now associated with the new user's device token. The old Telnyx credential still exists and could still receive SIP INVITEs.

### How Ghost Credentials Cause Problems

1. `transferToUser()` queries `user_device_tokens` for `sip_username` where `last_active_at >= subDay()`
2. Finds ghost credentials (old device tokens not cleaned up)
3. Creates SIP legs to ghost credentials
4. SIP INVITE goes to a credential where no SDK is connected
5. INVITE times out after 30 seconds
6. For each ghost credential, the caller waits an extra 30 seconds of ringing to a dead endpoint
7. If ALL credentials are ghost (user only has web), the call goes to voicemail after all legs time out

### Telnyx Resource Impact

Each orphaned credential is a Telnyx `TelephonyCredential` object that:
- Counts toward account credential limits
- May have associated SIP registration state
- Incurs API calls when the backend tries to create legs to it

---

## 10. Duplicate Registrations (Known Bug)

**Severity**: High (causes duplicate ringing on same device)

### How Duplicates Occur

**Scenario A: App reinstall**
1. User installs app, registers device token A, gets SIP credential A
2. User uninstalls app (no logout, no `destroy()` call)
3. User reinstalls app, gets new FCM token B
4. Registers device token B, gets SIP credential B
5. DB now has TWO rows: token A (stale, SIP A) and token B (active, SIP B)
6. Incoming call: `transferToUser()` finds both SIP A and SIP B
7. Two SIP legs created for the same physical device
8. Device may ring twice (two SIP INVITEs arriving at different credentials)

**Scenario B: FCM token refresh**
1. FCM rotates the token (Google does this periodically)
2. App registers new token C
3. `registerToken()` creates new row with token C (or updates if matched by FCM token)
4. **However**: `updateOrCreate` is keyed on `fcm_token`, so a NEW token creates a NEW row
5. Old row with token A still exists (with its SIP credential)
6. SIP credential A is never cleaned up

**Scenario C: Re-login (same device)**
1. User logs out → `destroy()` deletes token row (but not Telnyx credential)
2. User logs back in → new device token registered → new SIP credential created
3. Old SIP credential still exists on Telnyx platform (not cleaned from DB, not deleted from Telnyx)

### Why `createDeviceCredential` Doesn't Prevent This

```php
public static function createDeviceCredential(User $user, UserDeviceToken $deviceToken): ?UserDeviceToken
{
    // No check: does $deviceToken already have a telnyx_credential_id?
    // No check: does another device_token for this device_id already have a credential?
    $credential = \Telnyx\TelephonyCredential::create([...]);
    $deviceToken->update([
        'telnyx_credential_id' => $credential->id,
        ...
    ]);
}
```
**Source**: `.claude/skills/voip-backend/references/files.md:4368-4389`

The method blindly creates a new credential. It should:
1. Check if `$deviceToken->telnyx_credential_id` is already set
2. If so, delete the old credential before creating a new one
3. Check if another `UserDeviceToken` for the same `device_id` exists and clean it up

### Root Cause

1. No deduplication logic in credential creation
2. No cleanup of old credentials when creating new ones
3. `destroy()` doesn't call `deleteTelnyxCredential()`
4. No background job to prune stale/expired device tokens
5. `device_id` field exists but is not used for uniqueness constraints

---

## 11. "Kept Ringing After Answer" — Android (Known Bug)

**Severity**: Critical (reported by users, degrades trust in the product)

### The Three-Channel Dismissal Architecture

When Device A answers, three channels should dismiss ringing on other devices:

| Channel | Mechanism | Latency | Reliability |
|---------|-----------|---------|-------------|
| **SIP BYE** | Backend calls `$otherCall->hangup()` → Telnyx sends SIP BYE to device | ~200-500ms | Depends on SDK connection |
| **Push (FCM)** | `PushNotificationService::sendCallEndedPush()` → FCM → device | 100ms-30s | Best-effort, Doze delays |
| **Reverb broadcast** | `CallEndedNotification` event → WebSocket | 50-200ms | Web only, requires WS connection |

### Root Cause Analysis: Why Android Keeps Ringing

**Path 1: SIP BYE Not Reaching Device**

The backend tries to hang up other legs:
```php
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
**Source**: `.claude/skills/voip-backend/references/files.md:2125-2134`

**But**: As documented in [Failure Mode #7](#7-webhook-out-of-order), `leg_ids` may not contain all legs if `call.initiated` webhooks haven't arrived yet. Legs not in `leg_ids` are never explicitly cancelled.

Even when the hangup is sent, the Telnyx SDK on Android must receive the SIP BYE. If:
- The SDK has disconnected (app killed, battery optimization)
- The SDK is reconnecting (after `ensureTelnyxSdkConnected()`)
- The SIP registration is stale

...the SIP BYE doesn't reach the device.

**Path 2: FCM Push Delayed**

The `call_ended` push is sent but FCM delivery is delayed:
- Android Doze mode: can delay data messages by up to 15 minutes
- App standby buckets: limited delivery frequency
- Network issues: offline device queues messages

**Path 3: Android Broadcast Receiver Registration Timing**

`IncomingCallActivity` registers the `call_ended` broadcast receiver in `onStart()`:
```kotlin
val endedFilter = android.content.IntentFilter(Z360FirebaseMessagingService.ACTION_CALL_ENDED)
registerReceiver(endedReceiver, endedFilter, RECEIVER_NOT_EXPORTED)
```
**Source**: `.claude/skills/voip-android/references/files.md:4804-4806`

And unregisters in `onStop()`:
```kotlin
callEndedReceiver?.let { unregisterReceiver(it) }
callEndedReceiver = null
```
**Source**: `.claude/skills/voip-android/references/files.md:4821-4822`

**If the Activity is not in the started state** when the FCM push arrives (e.g., screen off, Activity in background), the broadcast receiver is unregistered and the push is processed but the broadcast has no receiver.

**Wait** — the FCM `onMessageReceived` sends a system-wide broadcast:
```kotlin
val endIntent = Intent(ACTION_CALL_ENDED).apply {
    putExtra("call_session_id", callSessionId)
}
sendBroadcast(endIntent)
```
**Source**: `.claude/skills/voip-android/references/files.md:730-733`

The receiver is registered with `RECEIVER_NOT_EXPORTED` flag, which should still receive broadcasts from the same app. But if the Activity is destroyed (process killed by OS), no receiver is registered.

**Path 4: BUG-007 Guard Condition**

The `ActiveCallActivity` has a BUG-007 fix that checks `isCallConnected`:
```kotlin
if (isCallConnected) {
    VoipLogger.d(LOG_COMPONENT, "Ignoring call_ended broadcast — call is active on this device")
    return
}
```
**Source**: `.claude/skills/voip-android/references/files.md:2393-2395`

This correctly prevents the answering device from dismissing its own call. But if `isCallConnected` is set to `true` prematurely (before the bridge is actually complete), the device might incorrectly ignore a legitimate `call_ended` broadcast.

### Composite Failure

The "kept ringing" bug likely occurs when:
1. SIP BYE fails to reach the device (SDK disconnected/stale) AND
2. FCM push is delayed (Doze mode) AND
3. The `IncomingCallActivity`'s broadcast receiver was unregistered (Activity in onStop)

All three dismissal channels must fail simultaneously for ringing to persist. This is most common when:
- The ringing device has been in background/Doze for a while
- The SDK connection has gone stale but the push woke it up
- FCM delivery is delayed by Doze

### Telnyx SDK Notification (ID 1234)

Even if the Z360 `IncomingCallActivity` is dismissed, the Telnyx SDK itself may show an ongoing notification (notification ID 1234) via `CallNotificationService`. The FCM handler cancels it:
```kotlin
CallNotificationService.cancelNotification(this)  // Telnyx SDK notification (1234)
```
**Source**: `.claude/skills/voip-android/references/files.md:720`

But this only runs when the `call_ended` push is processed. If the push is delayed, this notification persists.

---

## 12. Web Multi-Tab Conflicts

**Severity**: Low-Medium (edge case but confusing for users)

### How Web Handles Incoming Calls

Each tab has its own TelnyxRTC WebSocket connection (via `TelnyxRTCProvider`). When a SIP INVITE arrives, it's delivered to the WebRTC connection, and each tab independently shows the incoming call UI.

The `call_ended` broadcast handler only acts if the active call is in `ringing` or `requesting` state:
```typescript
if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
    try {
        activeCall.hangup();
    } catch (e) {
        console.debug('[DialpadContext] Failed to hangup from call_ended broadcast', e);
    }
}
```
**Source**: `.claude/skills/voip-frontend/references/files.md:683-688`

### Failure Scenarios

**Scenario A: Answer in one tab, other tabs keep ringing**
1. User has 3 browser tabs open
2. SIP INVITE arrives at all 3 (each has WebRTC connection)
3. User answers in Tab 1
4. Backend sends `call_ended` Reverb broadcast with reason `answered_elsewhere`
5. Tabs 2 and 3 receive the broadcast and hang up their calls
6. **This works correctly** if all tabs are connected to Reverb

**Scenario B: Reverb disconnected in one tab**
1. Tab 3 lost its WebSocket connection (network issue, tab throttled)
2. `call_ended` broadcast doesn't reach Tab 3
3. Tab 3's SIP INVITE is eventually cancelled by the backend hangup (SIP BYE)
4. But if the SIP BYE also fails to reach Tab 3 (WebRTC connection issues), it keeps ringing

**Scenario C: SIP INVITE only reaches one tab**
- The Telnyx org-level credential (used for web JWT auth) creates a single WebRTC connection. If a user has multiple tabs, which tab receives the INVITE depends on Telnyx's SIP registration behavior.
- **Note**: The code explicitly does NOT dial the org-level SIP credential for simring (line 1843-1844: "Dialing it creates a phantom SIP leg that answers first and steals the bridge"). So web tabs receive calls differently from mobile devices.

### Root Cause

Web tabs don't have a coordinated mechanism for call state. Each tab operates independently with its own WebRTC connection. Reverb broadcast is the only cross-tab coordination mechanism, and it's best-effort.

---

## 13. Cross-Organization Call Failure

**Severity**: Medium (affects multi-org users, complex failure modes)

### How Cross-Org Works on Android

When a call arrives for a different organization than the device is currently configured for:

```kotlin
// IncomingCallActivity detects org mismatch
// → OrgSwitchHelper POST /api/voip/switch-org
// → Update Telnyx Profile
// → Answer call
```
**Source**: Simultaneous-Ringing-Architecture.md, Section 9.4

### Failure Scenarios

**Scenario A: Org switch API call fails**
- The `/api/voip/switch-org` endpoint fails (auth expired, server error)
- Device can't switch to the correct org
- The incoming call can't be answered in the correct org context
- The SIP leg times out

**Scenario B: Telnyx SDK reconnection race**
- Cross-org requires new credentials → SDK must disconnect and reconnect
- iOS has a 5-second CallKit deadline for answering
- If reconnection takes >5 seconds, CallKit times out the call
- Rollback to previous org credentials needed but may leave state inconsistent

**Scenario C: Simultaneous calls across orgs**
- User has Org A and Org B
- Call arrives for Org A while device is configured for Org B
- Device starts org switch
- Second call arrives for Org B during the switch
- State machine corruption: which org is the device in?

### Root Cause

Cross-org switching requires sequential: API call → credential regeneration → SDK reconnect. This is inherently slow and fragile in the context of time-sensitive call answering.

---

## 14. iOS CallKit / PushKit Edge Cases

**Severity**: Medium-High (Apple-enforced constraints create unique failure modes)

### PushKit Requirement: Must Report to CallKit

When a VoIP push arrives via PushKit, iOS **requires** that the app report a call to CallKit. If it doesn't, iOS will terminate the app and potentially revoke PushKit privileges.

The `call_ended` push handler must comply:
```swift
// PushKitManager.swift — processPushPayload()
if let pushType = payload["type"] as? String, pushType == "call_ended" {
    if let existingUUID = findExistingCallUUID(callerNumber: nil, telnyxCallId: callSessionId) {
        callKitManager?.reportCallEnded(uuid: existingUUID, reason: .answeredElsewhere)
    } else {
        // Must still report a fake call to CallKit to satisfy PushKit requirements
        let fakeUUID = UUID()
        callKitManager?.reportIncomingCall(uuid: fakeUUID, handle: "Unknown", hasVideo: false) { error in
            self?.callKitManager?.reportCallEnded(uuid: fakeUUID, reason: .remoteEnded)
        }
    }
}
```
**Source**: `.claude/skills/voip-ios/references/files.md:1042-1064`

### Failure Scenario A: Rapid call_ended Before Call Reported

1. Call arrives → Telnyx VoIP push sent to iOS
2. Before iOS processes the Telnyx push, another device answers
3. `call_ended` push arrives at iOS
4. No existing CallKit UUID found (the call was never reported)
5. Fake call reported then immediately ended — user sees a brief flash of incoming call

### Failure Scenario B: Stale CallKit State

From the iOS skill:
```swift
/// Called when call is answered or ended to ensure stale data is removed
```
**Source**: `.claude/skills/voip-ios/references/files.md:1643`

```swift
/// Clean up stale in-memory call display and meta entries.
// Cleaned up X display + Y meta stale entries
```
**Source**: `.claude/skills/voip-ios/references/files.md:3948-3959`

```swift
// If the call is older than 1 hour, it's definitely stale - clean up silently
```
**Source**: `.claude/skills/voip-ios/references/files.md:4393-4396`

iOS has explicit stale state cleanup with a 1-hour threshold, which is reasonable but means calls that fail silently (no hangup event) can leave ghost state for up to 1 hour.

### Failure Scenario C: CallKit Timeout on Answer

CallKit gives the app a limited time to establish media after reporting an incoming call. If the Telnyx SDK takes too long to connect (slow network, cross-org credential switch), CallKit will end the call automatically. The user sees the call appear and then disappear.

---

## 15. Cache Expiry During Active Call

**Severity**: Low (but can cause confusion during long calls)

### The Cache TTL

The simring cache has a 10-minute TTL:
```php
\Cache::put("simring:{$call_control_id}", [...], now()->addMinutes(10));
```
**Source**: `.claude/skills/voip-backend/references/files.md:1955-1961`

Each update refreshes the TTL:
```php
\Cache::put("simring:{$parentId}", $ringSession, now()->addMinutes(10));
```
**Source**: `.claude/skills/voip-backend/references/files.md:2076, 2330, 2383`

### Failure Scenario

1. Call is answered and bridged at t=0
2. Cache updated with `answered = true` at t=0 (TTL: 10 minutes)
3. Call continues for 15 minutes
4. Cache entry expires at t=10
5. At t=15, one party hangs up
6. `onSimultaneousRingLegHangup()` fires:
   ```php
   $ringSession = \Cache::get("simring:{$parentId}");
   if (!$ringSession) {
       return; // Cache expired, no cleanup possible
   }
   ```
   **Source**: `.claude/skills/voip-backend/references/files.md:2265-2268`
7. The handler returns without sending `call_completed` notifications
8. Web/mobile UI may not properly update to show the call ended

### Actual Impact

This is mitigated because:
- The `onSimultaneousRingParentHangup` handler also sends notifications
- SIP BYE from Telnyx SDK provides device-level call end detection
- The cache is mainly needed for the ringing phase (which is <30 seconds)

But for calls lasting >10 minutes, the `onSimultaneousRingLegHangup` path won't find the cache and won't send cleanup notifications. The `onSimultaneousRingParentHangup` path (which handles the other direction) should still work since it reads from client_state, not cache.

---

## Summary: Severity Matrix

| # | Failure Mode | Severity | Likelihood | Data Loss Risk | Current Mitigation |
|---|---|---|---|---|---|
| 1 | Two devices answer simultaneously | Medium | Common | None | Redis lock + cache flag |
| 2 | Push notification delayed/missing | High | Common | None | PushSynchronizer 500ms timeout |
| 3 | Stale credential / device offline | **Critical** | Common | None | 24h `last_active_at` filter (insufficient) |
| 4 | Caller hangs up during ring | **Critical** | Common | None | Push/broadcast dismissal (legs NOT cancelled) |
| 5 | Bridge failure after answer | **Critical** | Rare | None | No recovery; silence for both parties |
| 6 | Lock expiry / double bridge | High | Very rare | None | Cache flag check (theoretical race) |
| 7 | Webhook out of order | Medium | Occasional | None | leg_ids tracking (has race) |
| 8 | Network partition / partial legs | Medium | Rare | None | Retry once after 2s |
| 9 | Ghost credentials | **Critical** | Common | Telnyx resource leak | No cleanup mechanism |
| 10 | Duplicate registrations | High | Common | Telnyx resource leak | No deduplication |
| 11 | Kept ringing after answer (Android) | **Critical** | Occasional | None | 3-channel dismissal (all can fail) |
| 12 | Web multi-tab conflicts | Low-Medium | Occasional | None | Reverb broadcast |
| 13 | Cross-org call failure | Medium | Occasional | None | OrgSwitchHelper with rollback |
| 14 | iOS CallKit/PushKit edge cases | Medium-High | Occasional | None | Fake call reporting, stale cleanup |
| 15 | Cache expiry during long call | Low | Rare | None | Multiple notification paths |

---

## Top Priority Fixes (Ranked)

### P0 — Must Fix

1. **Caller hangup should cancel SIP legs** (#4): When `onCallHangup()` detects `originator_cancel`, look up `simring:{call_control_id}` and explicitly cancel all outbound legs. This is the most impactful single fix.

2. **Ghost credential cleanup** (#9): Implement credential cleanup on:
   - Logout: `destroy()` should call `CPaaSService::deleteTelnyxCredential()`
   - Token refresh: `createDeviceCredential()` should delete old credential first
   - Background job: prune tokens where `last_active_at < 7 days ago` or `credential_expires_at < now()`

3. **Bridge failure recovery** (#5): Move "hang up other legs" and "send notifications" outside the try block that contains the bridge call. Add bridge retry with backoff.

### P1 — Should Fix

4. **Deduplication in credential creation** (#10): `createDeviceCredential()` should check `$deviceToken->telnyx_credential_id` and delete old credential before creating new one.

5. **Leg tracking race** (#7): Instead of populating `leg_ids` from `call.initiated` webhooks, store the `call_control_id` returned by `Call::create()` directly in the cache during `transferToUser()`.

6. **Android ringing persistence** (#11): Add a periodic check in `IncomingCallActivity` that polls the backend for call status, providing a 4th dismissal channel independent of push/Reverb/SIP.

### P2 — Nice to Have

7. **Credential expiry enforcement** (#3): Check `credential_expires_at` in `transferToUser()` and skip expired credentials.

8. **Cache TTL extension** (#15): Extend simring cache TTL to match maximum call duration (e.g., 2 hours) or refresh it periodically.

9. **Web multi-tab coordination** (#12): Use `BroadcastChannel` API or `SharedWorker` for cross-tab call state.

---

*Document generated by failure-analyst agent. All code references point to `.claude/skills/voip-{backend,android,ios,frontend}/references/files.md` line numbers, corresponding to the actual source files listed in the skill index.*
