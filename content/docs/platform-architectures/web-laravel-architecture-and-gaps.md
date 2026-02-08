---
title: Web Laravel Architecture And Gaps
---

# Web/Laravel VoIP Architecture: Target Design and Gap Analysis

> Analysis of Z360's backend call orchestration and web client VoIP implementation.
> Identifies current-state gaps and proposes target architecture for each area.

---

## 1. Backend Call Orchestration

### 1.1 Current State

The backend call orchestration centers on two webhook controllers inheriting from `TelnyxCallController`:

- **`TelnyxInboundWebhookController`** — handles incoming PSTN calls (~400 lines of call flow logic)
- **`TelnyxOutboundWebhookController`** — handles outgoing calls (~41 lines, minimal)

**Webhook routing**: All call events arrive at `/webhooks/cpaas/telnyx/call-control` (inbound) or `/webhooks/cpaas/telnyx/credential` (outbound). The base `TelnyxCallController.__invoke()` dispatches events via a `switch` on `event_type`:

```
call.initiated → callInitiated() → handleCall() [abstract]
call.answered  → callAnswered()
call.recording.saved → callRecordingSaved()
[other events] → methodMap dispatch → child controller handlers
```

**Files**:
- `app/Http/Controllers/Telnyx/TelnyxCallController.php` — Base controller (abstract)
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` — Inbound call flow
- `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php` — Outbound call flow
- `app/Services/CPaaSService.php` — Telnyx API wrapper, credential management
- `app/Events/IncomingCallNotification.php` — Reverb broadcast for web
- `app/Events/CallEndedNotification.php` — Reverb broadcast for call dismissal
- `routes/webhooks.php` — 18 webhook endpoints

**Inbound call decision tree** (`TelnyxInboundWebhookController::handleCall()`):
```
webhook arrives → idempotency check → blocked caller? → schedule check
  → receivingUser exists?
    → NO: voicemail
    → YES + within schedule:
      → user_id !== 0: transferToUser()
      → user_id === 0: transferToAgent()
    → YES + outside schedule:
      → unavailability = 'voicemail': voicemail
      → else: transferToAgent()
```

**Simultaneous ring flow** (`transferToUser()`):
1. Send Z360 push (FCM + APNs) to all user devices
2. Broadcast `IncomingCallNotification` to web via Reverb
3. Query `UserDeviceToken` for per-device SIP credentials (active within 1 day)
4. If 0 devices → voicemail
5. If 1 device → `$call->transfer()` (simple)
6. If 2+ devices → `Call::create()` per device, store ring session in Redis

**Ring session coordination** (Redis):
- `Cache::put("simring:{$parentId}", [...], 10min)` — stores ring state
- `Cache::lock("simring:{$parentId}:lock", 10)` — prevents race on answer
- First `call.answered` webhook to acquire lock wins → bridges parent, hangs up losers
- Three-channel dismissal: SIP BYE + Reverb broadcast + push notification

### 1.2 Gaps and Issues

#### GAP-B1: No Webhook Signature Verification for Telnyx Call Webhooks [HIGH]

**Current**: Call webhooks (`/webhooks/cpaas/telnyx/call-control` and `/webhooks/cpaas/telnyx/credential`) have no authentication middleware. The `client_state` mechanism provides routing but NOT authentication — anyone who knows the webhook URL can send forged payloads.

**Evidence**: `routes/webhooks.php` — no middleware applied to webhook routes. Telnyx provides signature verification via `telnyx-signature-ed25519` headers, but it's not implemented.

**Risk**: An attacker could forge `call.answered` webhooks to hijack call bridges or forge `call.initiated` webhooks to trigger push notifications to users.

**Severity**: HIGH

#### GAP-B2: Failover Endpoints Are Log-Only [MEDIUM]

**Current**: Every Telnyx webhook has a `/failover` companion endpoint that only logs a warning:

```php
// TelnyxCallController::failover()
public function failover(Request $request): Response
{
    VoipLog::warning('Failover webhook received', $payload['call_session_id'] ?? null);
    return response('', 204);
}
```

**Evidence**: `app/Http/Controllers/Telnyx/TelnyxCallController.php:3409-3414`

**Impact**: If the primary webhook endpoint fails (timeout, 5xx), Telnyx retries to the failover URL, but Z360 just logs and discards the payload. The call is lost — no push notification sent, no ring to devices.

**Severity**: MEDIUM

#### GAP-B3: Blocking `usleep(2_000_000)` in Simultaneous Ring Retry [HIGH]

**Current**: When all SIP leg creation attempts fail, the code sleeps for 2 seconds synchronously inside the webhook handler:

```php
// TelnyxInboundWebhookController::transferToUser()
if (empty($createdLegs)) {
    VoipLog::warning('All sim-ring legs failed, retrying once after 2s...', $callSessionId);
    usleep(2_000_000); // 2 seconds — BLOCKS the PHP worker
    // ... retry loop ...
}
```

**Evidence**: `voip-backend skill, line ~1915-1916`

**Impact**: This blocks a PHP-FPM worker for 2 seconds. During high load, this can exhaust the worker pool. Telnyx expects webhook responses within 20 seconds, and this delay compounds with retry time.

**Severity**: HIGH

#### GAP-B4: Redis Cache Dependency Without Fallback [HIGH]

**Current**: The entire simultaneous ring coordination depends on Redis cache. Ring session state, locking, and answered-flag tracking all use `Cache::put/get/lock`. If Redis is unavailable or data expires prematurely:

- `Cache::get("simring:{$parentId}")` returns null → second answerer can't detect first
- `Cache::lock()` fails → two devices could bridge simultaneously
- TTL of 10 minutes means long calls could lose their ring session metadata

**Evidence**: Lines ~1955, 2057, 2070, 2076 in voip-backend skill

**Severity**: HIGH

#### GAP-B5: Org-Level Credential Not Scoped to SIP Ring Targets [MEDIUM]

**Current**: The org-level credential (`UserTelnyxTelephonyCredential`) is explicitly NOT dialed during simultaneous ring:

```php
// NOTE: Org-level credential ($sipUsername) is NOT dialed — it exists only for web JWT auth.
// Dialing it creates a phantom SIP leg that answers first and steals the bridge.
```

**Evidence**: `voip-backend skill, line ~1843-1844`

**Impact**: This is correct behavior, but it means **web browsers never receive a SIP INVITE for inbound calls**. The web relies entirely on the Reverb `IncomingCallNotification` broadcast to display the ringing UI, and then the WebRTC client must somehow answer the call. The web currently has no mechanism to answer an inbound call via SIP — it can only receive the notification and display UI.

**Severity**: MEDIUM — This is an architectural limitation that affects web-based call answering.

#### GAP-B6: Inconsistent Org-Scoping of Push Notifications [MEDIUM]

**Current**: Incoming call push is sent to ALL user devices across ALL orgs:

```php
// TelnyxInboundWebhookController::transferToUser()
$fcmTokens = UserDeviceToken::getFcmTokensForUser($user->id); // NO org filter
$apnsTokens = UserDeviceToken::getApnsVoipTokensForUser($user->id); // NO org filter
```

But org-scoped methods exist and are unused for incoming calls:
- `getFcmTokensForUserInOrganization()`
- `getApnsVoipTokensForUserInOrganization()`

**Evidence**: `voip-backend skill, lines ~1793-1794` vs `lines ~2978-2996`

**Impact**: A device registered to Org B receives incoming call pushes from Org A. The push payload includes `organization_id` so the native app can detect the cross-org scenario, but this creates unnecessary push traffic and requires cross-org answer handling.

**Severity**: MEDIUM — This is intentional for cross-org call answering but creates complexity.

#### GAP-B7: `call.bridged` Webhook Not Handled [LOW]

**Current**: Telnyx sends `call.bridged` when a bridge is established, but Z360 does not handle it:

```php
// TelnyxCallController::__invoke() switch statement
case 'call.initiated': ...
case 'call.answered': ...
case 'call.recording.saved': ...
default: break; // call.bridged falls through here
```

**Impact**: Bridge success is inferred from command success. If the bridge command succeeds at the HTTP level but the actual bridge fails (rare), there's no detection or recovery.

**Severity**: LOW

#### GAP-B8: No Webhook Retry/Dead Letter Queue [MEDIUM]

**Current**: If a webhook handler throws an exception (excluding IdempotencyException), the controller returns a 204. Telnyx interprets this as success and does not retry. If the handler fails partway through (e.g., push sent but bridge failed), there's no mechanism to replay the webhook.

**Evidence**: `TelnyxCallController::__invoke()` catches `IdempotencyException` but lets other exceptions propagate to Laravel's error handler.

**Impact**: Failed webhooks are lost. No dead-letter queue or retry mechanism exists within Z360.

**Severity**: MEDIUM

### 1.3 Target Architecture

#### T-B1: Implement Webhook Signature Verification

Add middleware that verifies the `telnyx-signature-ed25519` header using the Telnyx public key:

```php
// Proposed: app/Http/Middleware/VerifyTelnyxWebhook.php
// Verify ED25519 signature on every Telnyx webhook route
// Apply via route group in routes/webhooks.php
```

This should use Telnyx's built-in verification from the PHP SDK (`\Telnyx\Webhook::constructEvent()`).

#### T-B2: Active Failover Processing

Failover endpoints should replay the full webhook processing pipeline:

```php
public function failover(Request $request): Response
{
    VoipLog::warning('Failover webhook received', ...);
    // Process the failover as if it were the primary webhook
    return $this->__invoke($request);
}
```

Add idempotency protection (already exists via `ensureIdempotent()`) to prevent double-processing if the primary and failover both succeed.

#### T-B3: Replace Blocking Retry with Queued Job

Replace `usleep(2_000_000)` with a queued delayed job:

```php
if (empty($createdLegs)) {
    // Dispatch a delayed job instead of blocking
    SimRingRetryJob::dispatch($call_control_id, $message->id, $sipDestinations)
        ->delay(now()->addSeconds(2));
    return;
}
```

#### T-B4: Redis Resilience for Ring Coordination

1. Add Redis health check before simultaneous ring
2. Fall back to single-device transfer if Redis unavailable
3. Consider database-backed ring sessions for critical state (Redis for locking, DB for ring session)
4. Add monitoring/alerting for Redis connectivity

#### T-B5: Web SIP Leg for Inbound Calls

Currently, web browsers cannot answer inbound calls via SIP because no SIP leg is created for the org-level credential. Two approaches:

**Option A (recommended)**: Create a SIP leg to the web device's per-device credential (web devices now register per-device credentials via `DeviceTokenController::store()`). This would allow web to receive SIP INVITE and answer natively via WebRTC.

**Option B**: Keep current broadcast-only approach but add a backend-mediated answer flow where the web sends a POST to answer the call, and the backend bridges the parent to the web user's WebRTC session.

#### T-B6: Consistent Push Scoping Strategy

Document the intentional cross-org push delivery as a feature. Add an org-filter option for environments that don't need cross-org calling:

```php
// If org supports cross-org calls, send to all devices
// If not, scope to current org only
if ($organization->supports_cross_org_calls) {
    $fcmTokens = UserDeviceToken::getFcmTokensForUser($user->id);
} else {
    $fcmTokens = UserDeviceToken::getFcmTokensForUserInOrganization($user->id, $organization->id);
}
```

---

## 2. Outbound Calling Backend

### 2.1 Current State

**Outbound from native**: Mobile devices initiate outbound calls through the native Telnyx SDK (`TelnyxVoip.makeCall()`). The SDK creates the call directly via Verto/WebRTC → Telnyx → PSTN. When Telnyx receives the outbound call, it sends a `call.initiated` webhook to the Credential Connection webhook URL (`/webhooks/cpaas/telnyx/credential`).

**Outbound from web**: Web browsers use `@telnyx/react-client` WebRTC SDK. `client.newCall()` creates a call via the web SDK's WebSocket connection. The call also triggers `call.initiated` to the Credential Connection.

**Backend outbound handler** (`TelnyxOutboundWebhookController::handleCall()`):
```php
// 41 lines total
// 1. Idempotency check
// 2. Check blocked/DND
// 3. Transfer the call to the destination
$call->transfer(['to' => $data->to, 'from' => $data->from]);
```

**Evidence**: `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php` (voip-backend skill, lines ~2740-2783)

### 2.2 Gaps and Issues

#### GAP-O1: Web Outbound Calls Use Org-Level Credential, Not Per-Device [MEDIUM]

**Current**: The web `placeCall()` function uses the `client` from `TelnyxRTCProvider`, which authenticates with the org-level credential JWT. When the web initiates an outbound call, the `client_state` contains only `{ user_id }`:

```typescript
client.newCall({
    destinationNumber: sanitizedDest,
    callerNumber: effectiveCallerNumber,
    clientState: btoa(JSON.stringify({ user_id: auth.user.id })),
    ...
});
```

**Evidence**: `voip-frontend skill, lines ~962-969`

**Impact**: The outbound `call.initiated` webhook arrives at the Credential Connection webhook. The `TelnyxOutboundWebhookController` processes it. Since web uses the org-level credential, the outbound webhook payload does NOT include the `direction` field from `client_state` (only `user_id`). The direction gating in `ensureDirection()` may incorrectly route this webhook.

**Severity**: MEDIUM

#### GAP-O2: No Click-to-Call Backend Support [LOW]

**Current**: Outbound calls are initiated entirely from the client side (WebRTC SDK on web, Telnyx SDK on native). There's no server-initiated outbound call API (e.g., "call this contact from the backend").

**Impact**: Cannot implement features like: scheduled callbacks, auto-dialer, AI-initiated outbound calls via the Z360 platform.

**Severity**: LOW (not currently needed but limits future capabilities)

#### GAP-O3: Outbound Call Recording Not Initiated [MEDIUM]

**Current**: The `TelnyxOutboundWebhookController` does a simple `$call->transfer()` without starting recording. Inbound calls start recording in `onSimultaneousRingAnswered()` via `$call->record_start()`, but outbound calls have no equivalent.

**Evidence**: `TelnyxOutboundWebhookController::handleCall()` — no `record_start()` call

**Impact**: Outbound calls are not recorded, which may be needed for compliance, quality monitoring, or AI transcription.

**Severity**: MEDIUM

### 2.3 Target Architecture

#### T-O1: Web Per-Device Credentials for Outbound

Web clients should use their per-device credential (already provisioned in `DeviceTokenController::store()` with `platform: 'web'`) instead of the org-level credential. This would:
- Consistent credential model across all platforms
- Enable web to participate in simultaneous ring as a SIP leg target
- Cleaner outbound call webhook routing

#### T-O2: Backend-Initiated Call API

Add an endpoint for server-initiated outbound calls:
```
POST /api/voip/call
{
    "to": "+1234567890",
    "from": "+1987654321",  // caller ID
    "user_id": 5            // which user's device to bridge to
}
```

This would use `Call::create()` + bridge, similar to the simultaneous ring flow but for outbound.

#### T-O3: Outbound Call Recording

Add `record_start()` in the outbound flow, either:
- In `TelnyxOutboundWebhookController::handleCall()` after transfer
- Or triggered by `call.answered` webhook for the outbound leg

---

## 3. Web/Mobile VoIP Isolation

### 3.1 Current State

The VoIP provider is switched based on platform detection:

```typescript
// resources/js/app.tsx (inferred from provider hierarchy)
// Outermost to innermost:
// [Web: TelnyxRTCProvider | Native: NativeVoipProvider]
```

**Platform detection**: `Capacitor.isNativePlatform()` returns `true` on Android/iOS, `false` on web browsers.

**NativeVoipProvider** (`resources/js/providers/native-voip-provider.tsx`):
- Lightweight React context with `{ isNativeProvider: true }`
- Does NOT create any WebSocket connections
- Prevents `TelnyxRTCProvider` from loading on native platforms
- Provides `useIsNativeVoipProvider()` hook for components to check

**DialpadProvider** (`resources/js/components/identifier-details-sidebar/dialpad/context.tsx`):
- Uses `isNativeMobile()` to route calls between native plugin and WebRTC client
- Wraps Telnyx hooks (`useNotification()`, `useCallbacks()`) in safe wrappers that return null on native
- Native events flow through `TelnyxVoip.addListener()` (Capacitor bridge)
- Web events flow through `TelnyxRTCProvider` context

**Evidence**:
- `voip-frontend skill, lines ~526-544` — `useSafeNotification()`, `useSafeCallbacks()`
- `voip-frontend skill, lines ~2144-2185` — `NativeVoipProvider` implementation
- `voip-frontend skill, lines ~546-550` — DialpadProvider platform check

### 3.2 Gaps and Issues

#### GAP-I1: NativeVoipProvider Doesn't Block WebRTC Connection Attempts [MEDIUM]

**Current**: `NativeVoipProvider` is a simple context with no enforcement. It prevents `TelnyxRTCProvider` from being instantiated (good), but any component that directly imports and calls `@telnyx/react-client` APIs could still create WebSocket connections.

**Evidence**: The DialpadProvider checks `isNativeMobile()` independently:
```typescript
const useNativeVoip = isNativeMobile();
```
This is a separate check from the provider hierarchy. If any code path bypasses this check, it could create a dual WebSocket.

**Severity**: MEDIUM

#### GAP-I2: Web Call Ended Broadcast Listener Runs on Native Too [LOW]

**Current**: The `call_ended` Echo listener is set up regardless of platform:

```typescript
// DialpadProvider
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);
useEcho<{ call_session_id: string; reason: string }>(callEndedChannel, '.call_ended', (payload) => {
    // ...
    if (useNativeVoip) {
        setNativeCallState(null);
    }
});
```

**Evidence**: `voip-frontend skill, lines ~675-694`

**Impact**: On native, the Echo listener receives `call_ended` broadcasts and clears native call state. This is actually useful (it ensures the WebView UI syncs), but it means the native call state is being managed from both the native layer (via Capacitor events) and the web layer (via Echo). Potential for state conflicts.

**Severity**: LOW

#### GAP-I3: No Guard Against Capacitor WebView VoIP While Native Call Active [MEDIUM]

**Current**: When a native call is active (Android `IncomingCallActivity` or iOS CallKit), the Capacitor WebView continues running. If the user navigates within the app (WebView), the DialpadProvider's web call state could conflict with the native call state.

**Evidence**: No guard exists in DialpadProvider to prevent `placeCall()` from being invoked on web while a native call is active. The `isNativeMobile()` check routes to native, but there's no active-call guard.

**Severity**: MEDIUM

### 3.3 Target Architecture

#### T-I1: Enforce VoIP Isolation via Provider

The `NativeVoipProvider` should actively block any WebRTC SDK initialization:

```typescript
export function NativeVoipProvider({ children }: PropsWithChildren) {
    // Block any TelnyxRTC imports from connecting
    return (
        <NativeVoipContext.Provider value={{
            isNativeProvider: true,
            blockWebRTC: true, // Signal to any TelnyxRTC wrapper to no-op
        }}>
            {children}
        </NativeVoipContext.Provider>
    );
}
```

Additionally, the Telnyx SDK should not even be loaded on native platforms. Use dynamic imports:

```typescript
const TelnyxRTCProvider = isNativeMobile()
    ? NativeVoipProvider
    : lazy(() => import('@telnyx/react-client').then(m => ({ default: m.TelnyxRTCProvider })));
```

#### T-I2: Unified Call State Manager

Create a single call state source-of-truth that abstracts platform differences:

```typescript
interface CallStateManager {
    activeCall: CallInfo | null;
    platform: 'web' | 'native';
    placeCall(dest: string, callerId: string): void;
    answer(): void;
    hangup(): void;
}
```

The DialpadProvider would consume this instead of conditionally switching between native and web code paths throughout.

#### T-I3: Active Call Guard

Add a guard that prevents web-side call actions when a native call is active:

```typescript
const nativeCallActive = useNativeCallState(); // From Capacitor bridge
const placeCall = useCallback((...) => {
    if (nativeCallActive) {
        toast({ title: 'Call in progress', description: 'Please end the current call first.' });
        return;
    }
    // ... existing logic
}, [nativeCallActive]);
```

---

## 4. Multi-Org Call Routing

### 4.1 Current State

**Session-based tenancy**: `SetCurrentTenant` middleware reads org from the session. All model queries are auto-scoped.

**Webhook tenant resolution**: Call webhooks bypass tenant middleware (no auth). Tenant context is resolved from the incoming phone number:

```php
// TelnyxCallController::callInitiated()
$channel = $data->channel();  // AuthenticatedPhoneNumber lookup by TO number
$org = $data->organization(); // From channel's organization
CurrentTenant::set($org);     // Set tenant for this request
```

**Evidence**: `voip-backend skill, lines ~3474-3487`

**Cross-org call answering**: The `VoipCredentialController::switchOrg()` endpoint handles native cross-org calls:
1. Validate user has access to target org
2. `$organization->switchTo()` — changes session tenant
3. Update `last_organization_id`
4. Get or create credentials for new org
5. Return SIP credentials + JWT for SDK reconnection

**Evidence**: `app/Http/Controllers/Api/VoipCredentialController.php:109-218`

**Push payload includes `organization_id`**: Native clients check if the call's org matches their current org and trigger the switch if needed.

### 4.2 Gaps and Issues

#### GAP-M1: Web Has No Cross-Org Call Answer Capability [HIGH]

**Current**: The web client receives `IncomingCallNotification` broadcasts on a tenant-scoped channel:

```php
new TenantPrivateChannel("App.Models.User.{$this->user->id}", $this->organizationId)
```

If the call arrives for Org A but the user's active web session is in Org B, the broadcast may not be received (if the channel is org-scoped) or the web client has no mechanism to switch orgs and answer.

Native platforms have `OrgSwitchHelper` (Android) and `OrganizationSwitcher` (iOS) with credential regeneration. **Web has no equivalent.**

**Severity**: HIGH

#### GAP-M2: `switchOrg()` Changes Server Session Globally [MEDIUM]

**Current**: `VoipCredentialController::switchOrg()` calls `$organization->switchTo()` which changes the *server-side session* to the new org. This means:

1. Native device answers cross-org call
2. Backend switches session to Org A
3. User's WebView (still showing Org B content) now has an Org A session
4. Any subsequent WebView requests will be in Org A context

**Evidence**: `VoipCredentialController.php:152` — `$organization->switchTo()`

**Impact**: The web UI could show stale Org B data while the session is now Org A. Inertia.js may serve pages with mismatched org context.

**Severity**: MEDIUM

#### GAP-M3: Phone Number to Org Mapping Assumes Single Match [MEDIUM]

**Current**: `TelnyxCallInitiatedData::channel()` looks up `AuthenticatedPhoneNumber` by the called number. If a phone number is shared across organizations (unlikely but possible in multi-tenant), the first match wins.

**Impact**: Call could be routed to the wrong organization if phone numbers aren't unique across tenants.

**Severity**: MEDIUM (low probability, high impact)

#### GAP-M4: No Session Restoration After Cross-Org Call [MEDIUM]

**Current**: After a cross-org call ends on native, the user's session remains in the call's org. iOS has rollback on failure (`OrganizationSwitcher` saves original org context), but on success, the user stays in the new org.

**Evidence**: `VoipCredentialController::switchOrg()` calls `$user->update(['last_organization_id' => $organization->id])` — permanently changes the user's org.

**Impact**: User may find themselves in a different org after answering a call, with no automatic restoration.

**Severity**: MEDIUM

### 4.3 Target Architecture

#### T-M1: Web Cross-Org Call Answer Flow

Implement a web-side org switch mechanism for inbound calls:

1. `IncomingCallNotification` broadcast should include `organization_id` and `organization_slug`
2. Web client detects org mismatch
3. Web client calls `POST /api/voip/switch-org` (same endpoint as native)
4. After switch, web refreshes credentials and WebRTC connection
5. Web answers the call via the new org's credentials

Alternatively, broadcast on a user-level channel (not org-scoped) so cross-org calls are always received.

#### T-M2: Separate VoIP Session from Web Session

The org switch for VoIP should NOT change the web session. Instead:

```php
public function switchOrg(Request $request): JsonResponse
{
    // Don't call $organization->switchTo() which changes the web session
    // Instead, temporarily scope to the target org for credential operations only
    CurrentTenant::set($organization);

    // Get/create credentials in target org context
    $jwtToken = CPaaSService::handleCredentials($user);

    // Restore original session tenant
    // The web session stays in whatever org the user was browsing
}
```

#### T-M3: Phone Number Uniqueness Constraint

Add a database constraint or validation that ensures phone numbers (`AuthenticatedPhoneNumber.number`) are unique across organizations. Or add a routing rule that handles ambiguity.

#### T-M4: Post-Call Org Restoration

After a cross-org call ends, the native app should restore the original org context. This can be:
- Native-side: Store original org ID before switch, restore after `callEnded` event
- Backend-side: Add a `POST /api/voip/restore-org` endpoint that reverts to `previous_organization_id`

---

## 5. Webhook Reliability

### 5.1 Current State

**Idempotency**: The system uses a per-message key-based idempotency mechanism:

```php
// TelnyxCallController::ensureIdempotent()
protected function ensureIdempotent(Message $message, string $key): void
{
    $meta = $message->metadata ?? [];
    $keys = isset($meta['keys']) && is_array($meta['keys']) ? $meta['keys'] : [];
    if (in_array($key, $keys, true)) {
        throw new IdempotencyException("Idempotency key already used: {$key}");
    }
    $keys[] = $key;
    $message->updateMetadata('keys', $keys);
    $message->save();
}
```

**Evidence**: `voip-backend skill, lines ~3629-3643`

**Keys used**:
- `handleCall:inbound` — prevents duplicate inbound call processing
- `handleCall:outbound` — prevents duplicate outbound call processing
- `call.hangup` — prevents duplicate voicemail routing
- `call.answered` — prevents duplicate answer handling
- `call.recording.saved` — prevents duplicate recording processing

**Webhook event ordering**: Telnyx webhooks can arrive out of order. The system handles this via:
- `client_state` carrying context across async webhook callbacks
- Ring session state in Redis providing latest state regardless of arrival order
- Idempotency keys preventing re-processing

**Failover URLs**: Configured for all connections but handlers are log-only (GAP-B2).

### 5.2 Gaps and Issues

#### GAP-W1: Idempotency Depends on Message Existence [HIGH]

**Current**: `ensureIdempotent()` requires a `Message` model instance. If the message hasn't been created yet (e.g., race condition where `call.answered` arrives before `call.initiated` completes), the idempotency check can't run.

**Evidence**: Several webhook handlers call `$data->message()` which may return null, and some handlers don't guard against null messages before calling `ensureIdempotent()`.

**Severity**: HIGH

#### GAP-W2: No Webhook Event Store for Auditing [MEDIUM]

**Current**: Webhook payloads are processed and discarded. There's no persistent record of raw webhook events. If debugging is needed, the only evidence is `VoipLog` entries.

**Impact**: Cannot replay failed webhooks, cannot audit call events, cannot debug timing issues after the fact.

**Severity**: MEDIUM

#### GAP-W3: Out-of-Order `call.answered` Before Ring Session Created [MEDIUM]

**Current**: When simultaneous ring is used, the ring session is stored in Redis AFTER all SIP legs are created:

```php
// 1. Create SIP legs (which trigger call.initiated + call.answered webhooks)
foreach ($sipDestinations as $sip) {
    Call::create([...]); // This may trigger immediate webhooks
}
// 2. THEN store ring session in Redis
Cache::put("simring:{$call_control_id}", [...]);
```

**Evidence**: `voip-backend skill, lines ~1889-1961`

**Impact**: If a device answers extremely quickly (before the Redis `Cache::put` executes), the `onSimultaneousRingAnswered()` handler will find no ring session:

```php
$ringSession = Cache::get("simring:{$parentId}");
// ringSession could be null if answered before Cache::put
```

**Severity**: MEDIUM — unlikely in practice (network latency provides buffer) but theoretically possible.

#### GAP-W4: No Webhook Timeout Monitoring [LOW]

**Current**: No monitoring for how long webhook handlers take to respond. Telnyx has a 20-second timeout for webhooks. If processing (DB queries, push dispatch, Telnyx API calls back) takes too long, Telnyx will retry.

**Severity**: LOW

### 5.3 Target Architecture

#### T-W1: Message-Independent Idempotency

Add a separate idempotency table or Redis-based deduplication:

```php
// Check idempotency BEFORE message lookup
$webhookId = $request->input('data.id'); // Telnyx provides unique event IDs
if (Cache::has("webhook_processed:{$webhookId}")) {
    return response()->json(['ok' => true], 200);
}
Cache::put("webhook_processed:{$webhookId}", true, now()->addHours(1));
```

#### T-W2: Webhook Event Store

Create a `webhook_events` table:

```sql
CREATE TABLE webhook_events (
    id BIGSERIAL PRIMARY KEY,
    source VARCHAR(50),  -- 'telnyx_call', 'telnyx_sms', etc.
    event_type VARCHAR(100),
    event_id VARCHAR(255) UNIQUE,
    payload JSONB,
    processed_at TIMESTAMP,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Store every webhook payload before processing. This enables replay, auditing, and debugging.

#### T-W3: Pre-Create Ring Session

Move ring session creation BEFORE SIP leg creation:

```php
// 1. Pre-create ring session
Cache::put("simring:{$call_control_id}", [
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
    'answered' => false,
    'leg_ids' => [],
], now()->addMinutes(10));

// 2. THEN create SIP legs
foreach ($sipDestinations as $sip) {
    Call::create([...]);
}
```

#### T-W4: Webhook Response Time Monitoring

Add middleware or observer that logs webhook processing duration:

```php
$start = microtime(true);
// ... process webhook ...
$duration = microtime(true) - $start;
if ($duration > 5.0) {
    VoipLog::warning('Webhook processing slow', $callSessionId, ['duration_ms' => $duration * 1000]);
}
```

---

## 6. Credential Management

### 6.1 Current State

**Two-tier credential architecture**:

| Tier | Scope | Storage | Expiry | Purpose |
|------|-------|---------|--------|---------|
| Org-level | 1 per (user, org) | `UserTelnyxTelephonyCredential` | No explicit expiry | Web JWT auth |
| Per-device | 1 per (user, org, device) | `UserDeviceToken` | 30 days | Multi-device SIP registration |

**Creation flows**:
- **Org-level**: `CPaaSService::handleCredentials()` — lazy creation on first access (Inertia prop or API call)
- **Per-device**: `CPaaSService::createDeviceCredential()` — created during `POST /api/device-tokens`

**JWT lifecycle**:
- Generated via `$credential->token()` — 10-hour TTL
- Web: passed as Inertia prop, refreshed on page navigation
- Native: returned from `POST /api/device-tokens`, refreshed on SDK reconnect

**Cleanup mechanisms**:
1. **Stale device cleanup**: When a new device registers, devices of the same platform inactive for 7+ days are deleted along with their Telnyx credentials (`DeviceTokenController::store()`, lines ~132-159)
2. **Web dedup**: Enforces max 1 web device per user+org (`DeviceTokenController::store()`, lines ~57-81)
3. **Device removal**: `DELETE /api/device-tokens/{deviceId}` deletes Telnyx credential before DB row
4. **Push failure cleanup**: `UserDeviceToken::removeToken()` removes token on UNREGISTERED FCM error

**Evidence**: `app/Http/Controllers/Api/DeviceTokenController.php` (full source read above)

### 6.2 Gaps and Issues

#### GAP-C1: Org-Level Credentials Never Expire or Get Cleaned Up [HIGH]

**Current**: `UserTelnyxTelephonyCredential` has no expiry mechanism. Once created, it persists indefinitely in both Z360's database and on Telnyx's platform. There is no cleanup for:
- Users who leave an organization
- Organizations that are deactivated
- Credentials where the underlying Telnyx resource was deleted externally

**Evidence**: `CPaaSService::handleCredentials()` creates credentials but has no cleanup path. No `credential_expires_at` field on `UserTelnyxTelephonyCredential`.

**Impact**: Telnyx credential quota grows unboundedly. Orphaned credentials on Telnyx's side waste resources and could hit account limits.

**Severity**: HIGH

#### GAP-C2: Per-Device Credential Expiry Not Enforced [MEDIUM]

**Current**: `credential_expires_at` is set to `now()->addDays(30)` when created, but there's no job or process that checks for expired credentials and cleans them up. Stale cleanup only happens when a NEW device registers (piggyback cleanup).

**Evidence**: `CPaaSService::createDeviceCredential()` sets `credential_expires_at` but no scheduler job references it.

**Impact**: If a device stops registering but never uninstalls the app, its credential persists on Telnyx for 30 days (by `credential_expires_at`) but the DB row persists indefinitely (only cleaned up if another device of the same platform registers).

**Severity**: MEDIUM

#### GAP-C3: JWT Refresh Race Condition on Web [MEDIUM]

**Current**: Web JWTs have 10-hour TTL. The JWT is passed as an Inertia shared prop, meaning it's refreshed on every full page navigation. But for SPA-style navigation (Inertia partial reloads), the JWT may not refresh.

If a user keeps a tab open for 10+ hours without a full navigation, the JWT expires and the WebRTC connection drops.

**Impact**: Web calls could fail silently after 10 hours of inactivity. The Telnyx web SDK should detect the auth failure and trigger reconnection, but the JWT renewal depends on page navigation.

**Severity**: MEDIUM

#### GAP-C4: Telnyx API Failure During Credential Creation Not Handled Gracefully [MEDIUM]

**Current**: If `TelephonyCredential::create()` fails (Telnyx API down, rate limited), the code stores `'credential_id' => 'failed'` in the database:

```php
$existing = UserTelnyxTelephonyCredential::create([
    'credential_id' => $credentialId ?? 'failed',
    ...
]);
```

**Evidence**: `CPaaSService::handleCredentials()`, line ~4349

**Impact**: A record with `credential_id: 'failed'` is saved. Subsequent calls to `handleCredentials()` find this record and try to retrieve it from Telnyx (`TelephonyCredential::retrieve('failed')`), which will fail every time. The credential is stuck in a broken state.

**Severity**: MEDIUM

#### GAP-C5: No Credential Health Check [LOW]

**Current**: No mechanism to verify that a stored credential still exists on Telnyx's platform. If a credential is deleted externally (manual Telnyx portal action, API cleanup), Z360 will try to use it and fail.

**Severity**: LOW

### 6.3 Target Architecture

#### T-C1: Scheduled Org-Level Credential Cleanup

Add a scheduled artisan command:

```php
// Run daily: clean up orphaned org-level credentials
// 1. Find credentials for users no longer in the organization
// 2. Find credentials for deactivated organizations
// 3. Delete from Telnyx first, then from database
```

#### T-C2: Scheduled Per-Device Credential Expiry Enforcement

Add a scheduled job that runs daily:

```php
// Find device tokens where credential_expires_at < now()
// Delete their Telnyx credentials
// Delete the device token rows
```

#### T-C3: Proactive JWT Refresh

Implement a timer-based JWT refresh on the web client:

```typescript
// In TelnyxRTCProvider wrapper
useEffect(() => {
    const interval = setInterval(async () => {
        const response = await fetch('/api/voip/credentials');
        const { jwt_token } = await response.json();
        // Reconnect SDK with new JWT
    }, 8 * 60 * 60 * 1000); // Every 8 hours (before 10h expiry)
    return () => clearInterval(interval);
}, []);
```

Or use the Telnyx SDK's built-in token refresh callback if available.

#### T-C4: Fix Failed Credential State

Add retry logic when `credential_id` is `'failed'`:

```php
if ($existing && $existing->credential_id === 'failed') {
    $existing->delete(); // Remove broken record
    // Fall through to create new credential
}
```

#### T-C5: Credential Health Check

Add a verification step in `handleCredentials()`:

```php
try {
    $cred = TelephonyCredential::retrieve($existing->credential_id);
} catch (TelnyxException $e) {
    if ($e->getCode() === 404) {
        $existing->delete(); // Credential gone from Telnyx
        // Fall through to create new
    }
}
```

---

## 7. Gap Severity Summary

| ID | Area | Gap Description | Severity |
|----|------|----------------|----------|
| GAP-B1 | Backend | No webhook signature verification | HIGH |
| GAP-B3 | Backend | Blocking usleep in sim-ring retry | HIGH |
| GAP-B4 | Backend | Redis dependency without fallback | HIGH |
| GAP-C1 | Credentials | Org-level credentials never cleaned up | HIGH |
| GAP-M1 | Multi-org | Web has no cross-org call answer | HIGH |
| GAP-W1 | Webhooks | Idempotency depends on message existence | HIGH |
| GAP-B2 | Backend | Failover endpoints are log-only | MEDIUM |
| GAP-B5 | Backend | Web browsers can't receive SIP INVITE | MEDIUM |
| GAP-B6 | Backend | Inconsistent push org-scoping | MEDIUM |
| GAP-B8 | Backend | No webhook dead letter queue | MEDIUM |
| GAP-O1 | Outbound | Web uses org-level credential | MEDIUM |
| GAP-O3 | Outbound | Outbound calls not recorded | MEDIUM |
| GAP-I1 | Isolation | NativeVoipProvider doesn't block WebRTC | MEDIUM |
| GAP-I3 | Isolation | No guard against dual active calls | MEDIUM |
| GAP-M2 | Multi-org | switchOrg changes web session globally | MEDIUM |
| GAP-M3 | Multi-org | Phone-to-org mapping assumes single match | MEDIUM |
| GAP-M4 | Multi-org | No session restoration after cross-org call | MEDIUM |
| GAP-W2 | Webhooks | No webhook event store | MEDIUM |
| GAP-W3 | Webhooks | Out-of-order answer before ring session | MEDIUM |
| GAP-C2 | Credentials | Per-device expiry not enforced | MEDIUM |
| GAP-C3 | Credentials | JWT refresh race on web | MEDIUM |
| GAP-C4 | Credentials | 'failed' credential state stuck | MEDIUM |
| GAP-B7 | Backend | call.bridged not handled | LOW |
| GAP-O2 | Outbound | No click-to-call backend API | LOW |
| GAP-I2 | Isolation | call_ended listener runs on native | LOW |
| GAP-W4 | Webhooks | No webhook timeout monitoring | LOW |
| GAP-C5 | Credentials | No credential health check | LOW |

---

## 8. Priority Recommendations

### Immediate (Before Production VoIP Launch)

1. **GAP-B1**: Implement Telnyx webhook signature verification
2. **GAP-B3**: Replace blocking `usleep()` with queued job
3. **GAP-C4**: Fix stuck 'failed' credential state
4. **GAP-W1**: Add message-independent idempotency (use Telnyx event IDs)
5. **GAP-W3**: Pre-create ring session before SIP legs

### Short-Term (First Sprint After Launch)

6. **GAP-B4**: Add Redis health check and fallback for ring coordination
7. **GAP-C1**: Implement org-level credential cleanup scheduler
8. **GAP-M1**: Implement web cross-org call answer flow
9. **GAP-B2**: Activate failover webhook processing

### Medium-Term (2-3 Sprints)

10. **GAP-M2**: Separate VoIP session from web session
11. **GAP-C2**: Implement per-device credential expiry enforcement
12. **GAP-C3**: Proactive JWT refresh on web
13. **GAP-O3**: Add outbound call recording
14. **GAP-I1**: Strengthen VoIP isolation enforcement
15. **GAP-W2**: Implement webhook event store

### Long-Term (Backlog)

16. **GAP-O2**: Backend-initiated outbound call API
17. **GAP-B5**: Web SIP leg for inbound calls (major architecture change)
18. **GAP-I3**: Active call guard across platforms

---

*Generated: 2026-02-08*
*Sources: voip-backend skill, voip-frontend skill, app/Http/Controllers/Api/VoipCredentialController.php, app/Http/Controllers/Api/DeviceTokenController.php, routes/api.php, routes/webhooks.php, prerequisite docs (system-architecture-unified.md, flows-unified.md, telnyx-reference-unified.md)*
