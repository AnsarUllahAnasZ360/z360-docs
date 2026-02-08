---
title: Web Laravel Architecture Complete
---

# Web/Laravel VoIP Architecture: Complete Analysis

> **Session**: 07 — Web/Laravel Architecture Design
> **Date**: 2026-02-08
> **Scope**: Laravel backend call orchestration + Web client VoIP + Gap analysis + Target architecture
> **Sources**: voip-backend skill, voip-frontend skill, telnyx-php-sdk pack, telnyx-web-sdk pack, live source files
> **Companion documents**: `laravel-current-state.md`, `web-client-current-state.md`, `web-laravel-architecture-and-gaps.md`

---

## Executive Summary

Z360's Web/Laravel VoIP architecture centers on **Telnyx Call Control webhooks** orchestrated by a 1,060-line inbound controller, a 41-line outbound controller, and a 543-line CPaaS service, with the **web client** using `@telnyx/react-client` WebRTC through a dual-provider pattern that isolates web VoIP from native VoIP.

**Key strengths**: Structured webhook parsing (Spatie Data), idempotency guards, dual-credential architecture cleanly separating web JWT from mobile SIP, Redis-backed simultaneous ring coordination, three-channel notification delivery (Push + Broadcast + SIP).

**Critical concerns**: 27 gaps identified — 6 HIGH severity including no webhook signature verification, blocking sleep in webhook handlers, cache-only ring state, unbounded credential growth, no web cross-org call capability, and message-dependent idempotency.

---

## Part 1: Laravel Backend Architecture

### 1.1 Webhook Routing

**File**: `routes/webhooks.php:27-61` (loaded from `routes/web.php:50`)

All Telnyx webhooks are public endpoints (no auth middleware) under `/webhooks`:

| Endpoint | Controller | Purpose |
|----------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/call-control` | `TelnyxInboundWebhookController` | Inbound PSTN calls |
| `POST /webhooks/cpaas/telnyx/call-control/failover` | `TelnyxInboundWebhookController@failover` | Inbound failover |
| `POST /webhooks/cpaas/telnyx/credential` | `TelnyxOutboundWebhookController` | Outbound calls via SIP credentials |
| `POST /webhooks/cpaas/telnyx/credential/failover` | `TelnyxOutboundWebhookController@failover` | Outbound failover |
| `POST /webhooks/cpaas/telnyx/notifications` | `TelnyxNotificationsWebhookController` | Number orders |
| `POST /webhooks/cpaas/telnyx/sms` | `TelnyxSMSWebhookController` | SMS |
| `POST /webhooks/cpaas/telnyx/rcs` | `TelnyxRCSWebhookController` | RCS |
| `POST /webhooks/cpaas/telnyx/a2p` | `TelnyxA2PWebhookController` | 10DLC brand/campaign |

**Critical routing insight**: Inbound calls route to `/call-control` (via Call Control Application). Outbound calls route to `/credential` (via Credential Connection). However, **simultaneous ring legs** are created via `Call::create()` using the Call Control App connection, so their webhooks arrive at the **inbound** controller. The `ensureDirection()` method bypasses the direction mismatch check for sim-ring types.

### 1.2 Webhook Parsing (Data Layer)

**File**: `app/Data/Telnyx/TelnyxWebhook.php:1-58`

All webhooks are parsed via Spatie Laravel Data:

```
TelnyxWebhook
├── data: TelnyxWebhookData
│   ├── event_type: string ("call.initiated", "call.answered", etc.)
│   ├── payload: TelnyxBasePayloadData (polymorphic via TelnyxPayloadCast)
│   └── meta: { attempt, delivered_to }
```

`TelnyxPayloadCast` (`app/Data/Telnyx/Casts/TelnyxPayloadCast.php`) maps:
- `call.*` → `TelnyxBaseCallPayloadData`
- `10dlc.*` → `TelnyxBaseA2PPayloadData`
- `message.*` → `TelnyxSMSPayload`

**Call payload DTOs** (6 types):
| DTO | File | Key Fields |
|-----|------|-----------|
| `TelnyxBaseCallPayloadData` | `app/Data/Telnyx/Calls/` | `call_control_id`, `call_session_id`, `from`, `to`, `client_state`, `direction` |
| `TelnyxCallInitiatedData` | Same dir | `recipient()`, `channel()`, `organization()`, `message()` |
| `TelnyxCallAnsweredData` | Same dir | `message()` resolver |
| `TelnyxCallHangupData` | Same dir | `hangup_cause`, `hangup_source`, `sip_hangup_cause`, `start_time`, `end_time` |
| `TelnyxCallRecordingSavedData` | Same dir | `recording_id`, `recording_urls` |
| `TelnyxCallSpeakEndedData` | Same dir | `message()` resolver |

### 1.3 Controller Hierarchy

#### TelnyxCallController (Base) — 375 lines
**File**: `app/Http/Controllers/Telnyx/TelnyxCallController.php`

Abstract base with common webhook processing:

**`__invoke()`** (lines 42-97): Main entry. Parses webhook → `ensureDirection()` → dispatches to event handlers → child `methodMap` → catches `IdempotencyException`.

**`ensureDirection()`** (lines 107-140): Resolves direction from `client_state` (base64 JSON). Returns `null` (bypasses gate) for types: `simultaneous_ring_leg`, `simultaneous_ring_parent`, `voicemail_parent`, `voicemail_greeting`.

**`callInitiated()`** (lines 145-213): Common call setup — resolves `AuthenticatedPhoneNumber` → `Organization` → sets `CurrentTenant` → creates `Conversation` (type PHONE) → creates `Message` (type PHONE_CALL, keyed by `call_session_id`) → delegates to abstract `handleCall()`.

**`callAnswered()`** (lines 218-259): Starts recording via `$call->record_start()` (WAV, dual channel, trim silence). Skips for sim-ring and voicemail types.

**`callRecordingSaved()`** (lines 264-311): DB transaction with `lockForUpdate()` → saves recording metadata → dispatches transcription → creates `Ledger` entry for billing.

**`ensureIdempotent()`** (lines 322-334): Per-message key-based idempotency via `message.metadata.keys[]`.

#### TelnyxInboundWebhookController — 1,060 lines
**File**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php`

The core inbound call routing engine. Method map:
```php
$this->methodMap = [
    'call.hangup'      => fn() => $this->onCallHangup(),
    'call.answered'     => fn() => $this->onCallAnswered(),
    'call.initiated'    => fn() => $this->onSimultaneousRingLegInitiated(),
    'call.speak.ended'  => fn() => $this->onSpeakEnded(),
];
```

**`handleCall()`** — Inbound call decision tree:
```
call.initiated → idempotency check → blocked caller check → schedule check
  → receivingUser exists?
    → NO: voicemail
    → YES + within schedule:
      → user_id !== 0: transferToUser() (human)
      → user_id === 0: transferToAgent() (AI agent — sentinel value)
    → YES + outside schedule:
      → unavailability_option === 'voicemail': voicemail
      → else: transferToAgent()
```

**`transferToUser()`** (~lines 1790-1974) — The multi-device alerting system:
1. Gathers SIP credentials + FCM/APNs tokens
2. Sends push notifications (FCM + APNs VoIP) to all mobile devices
3. Broadcasts `IncomingCallNotification` to web via Reverb
4. Collects per-device SIP credentials from `UserDeviceToken` (active within 24h)
5. Single device → `$call->transfer()` (simple)
6. Multiple devices → `Call::create()` per device + Redis ring session

**Critical comment (line 1843-1844)**: _"Org-level credential ($sipUsername) is NOT dialed — it exists only for web JWT auth. Dialing it creates a phantom SIP leg that answers first and steals the bridge."_

**Simultaneous ring answer** (`onCallAnswered()`, ~lines 2030-2174):
1. Acquires Redis lock: `Cache::lock("simring:{$parentId}:lock", 10)`
2. First to acquire → bridges parent ↔ answered leg, hangs up all other legs, broadcasts `CallEndedNotification`
3. Lock not acquired → hangs up this late leg

**Hangup handling** (`onCallHangup()`, ~lines 1694-1788):
- `simultaneous_ring_leg` hangup → removes from ring session, if all legs gone → voicemail
- `simultaneous_ring_parent` hangup → hangs up bridged leg, cleans up cache
- Regular hangup → notifications + voicemail routing if unanswered

#### TelnyxOutboundWebhookController — 41 lines
**File**: `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php`

Minimal: idempotency check → block/DND check → `$call->transfer()`. No recording, no sim-ring, no voicemail.

### 1.4 CPaaSService — 543 lines
**File**: `app/Services/CPaaSService.php`

| Method | Purpose |
|--------|---------|
| `telnyxRequest()` | Guzzle HTTP client, 45s timeout, Bearer auth |
| `tunnelSafeUrl()` | Prefers ngrok tunnel host for dev |
| `parseClientState()` | Base64 → JSON with direction derivation |
| `handleCredentials()` | Org-level credential: lazy-create per (user, org), returns JWT (10h TTL) |
| `createDeviceCredential()` | Per-device credential: creates on Telnyx, stores SIP username/password, 30-day expiry |
| `deleteTelnyxCredential()` | Deletes from Telnyx API (silent catch on errors) |
| `getDeviceJwt()` | Returns JWT for a device's Telnyx credential |

**Dual credential architecture**:
```
Org-Level (web JWT auth):           Per-Device (mobile SIP registration):
UserTelnyxTelephonyCredential       UserDeviceToken
├── credential_id                   ├── telnyx_credential_id
├── sip_username (NOT dialed)       ├── sip_username (DIALED for sim-ring)
├── sip_password                    ├── sip_password
└── connection_id                   └── credential_expires_at (30 days)
```

### 1.5 Push Notification System

**PushNotificationService** (`app/Services/PushNotificationService.php:1-321`):
- `sendIncomingCallPush()` — FCM (HTTP v1 API, data-only) + APNs VoIP
- `sendCallEndedPush()` — Simplified `{type: "call_ended", call_session_id}` to both platforms
- FCM uses OAuth2 service account auth with 5-min token cache
- Invalid tokens auto-removed on `UNREGISTERED`/`INVALID_ARGUMENT`

**ApnsVoipService** (`app/Services/ApnsVoipService.php:1-182`):
- Direct HTTP/2 push to APNs
- Token-based (ES256 JWT, 50-min cache) or certificate-based auth
- Priority 10 (immediate), expiration 0 (don't store)

**FcmChannel** (`app/Channels/FcmChannel.php:1-137`):
- Separate notification path using `kreait/firebase-php` SDK
- Used for non-VoIP pushes (notification + data messages)
- Different auth flow from PushNotificationService

### 1.6 Broadcast Events

| Event | Channel | Payload |
|-------|---------|---------|
| `IncomingCallNotification` | `private-org.{orgId}.App.Models.User.{userId}` | `call_session_id`, `call_control_id`, `caller_number`, `caller_name`, `channel_number`, `organization_id/name` |
| `CallEndedNotification` | Same channel pattern | `call_session_id`, `reason` (answered_elsewhere/call_completed) |

Both use `TenantPrivateChannel` which prefixes with `org.{orgId}`.

### 1.7 Database Models

**UserDeviceToken** (`app/Models/UserDeviceToken.php`) — 16 columns:
- Core: `user_id`, `organization_id`, `device_id`, `fcm_token` (stores APNs tokens too!), `platform` (android/ios/web)
- SIP: `telnyx_credential_id`, `sip_username`, `sip_password`, `connection_id`, `credential_expires_at`
- Meta: `app_version`, `device_name`, `last_active_at`

**UserTelnyxTelephonyCredential** (`app/Models/UserTelnyxTelephonyCredential.php`) — 8 columns:
- `user_id`, `organization_id`, `credential_id`, `connection_id`, `sip_username`, `sip_password`

### 1.8 Voicemail System

Two-phase async flow:
1. `transferToVoicemail()` → answers parent with `voicemail_parent` client_state
2. `onVoicemailParentAnswered()` → TTS greeting (hardcoded: "We're not available...") via AWS Polly Joanna-Neural
3. `onSpeakEnded()` → starts recording (WAV, single channel, beep)
4. `call.recording.saved` → transcription + billing

### 1.9 AI Agent Transfer

`transferToAgent()` (~lines 2495-2578):
- Creates thread UUID, answers call, transfers to LiveKit SIP endpoint
- Custom SIP headers: `X-Org-Id`, `X-Thread-Id`, `X-Base-Url`, `X-User-Status`, `X-User-Data` (base64 PII), `X-Agent-Introduction/Voice/Personality`, `X-Conversation-Summary`
- Conversation summary cached and AI-generated via `/summarize` endpoint

### 1.10 Observability

**VoipLog** (`app/Support/VoipLog.php:1-51`):
- Structured logging to dedicated `voip` channel
- Auto-prefix with first 8 chars of `call_session_id`
- Methods: `debug()`, `info()`, `warning()`, `error()`

---

## Part 2: Web Client VoIP Architecture

### 2.1 Dual-Provider Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   GlobalAppProviders                     │
│              (resources/js/layouts/app-layout.tsx)       │
├────────────────────┬────────────────────────────────────┤
│   isWeb() = true   │       isNativeMobile() = true      │
├────────────────────┼────────────────────────────────────┤
│ TelnyxRTCProvider  │       NativeVoipProvider            │
│ (WebRTC/WebSocket) │  (no-op context, native handles)   │
├────────────────────┴────────────────────────────────────┤
│                    DialpadProvider (645 lines)           │
│   Unified call state, routes to web SDK or native       │
├─────────────────────────────────────────────────────────┤
│              Dialpad UI Components                       │
└─────────────────────────────────────────────────────────┘
```

Provider switching in `app-layout.tsx:134-146`:
```typescript
{isWeb() ? (
    <TelnyxRTCProvider credential={{ login_token: webLoginToken }}>
        {voipContent}
    </TelnyxRTCProvider>
) : (
    <NativeVoipProvider>
        {voipContent}
    </NativeVoipProvider>
)}
```

Platform detection (`resources/js/utils/platform.ts:1-37`): `isWeb()`, `isNativeMobile()`, `isNativeAndroid()`, `isNativeIOS()` — all wrapping `Capacitor.isNativePlatform()`.

### 2.2 TelnyxRTCProvider (Web VoIP)

Initialized with JWT token. Creates WebSocket to Telnyx SIP gateway, handles SIP REGISTER, manages WebRTC peer connections.

**Audio element**: Hidden `<Audio>` component with `id="dialpad-remote-audio"` in `WebAppOverlays`.

**Connection monitoring**: `useSafeCallbacks()` wraps `onReady`/`onSocketError` (sets `isSocketError` state).

### 2.3 NativeVoipProvider

**File**: `resources/js/providers/native-voip-provider.tsx:1-39`

Minimal context: `{ isNativeProvider: true }`. No WebSocket, no SIP, no WebRTC. Exists to prevent `TelnyxRTCProvider` from loading on native and causing duplicate SIP registrations.

### 2.4 Credential Management (Web)

**Per-device flow** (`resources/js/hooks/useWebVoipCredentials.ts:1-170`):
1. Generate persistent browser device ID (`web_${crypto.randomUUID()}` in `localStorage`)
2. POST to `/api/device-tokens` with `device_id`, `fcm_token: web_${id}`, `platform: 'web'`
3. Backend returns SIP credentials + JWT
4. JWT passed to `TelnyxRTCProvider`

**Fallback JWT** (`app-layout.tsx:55-66`): Per-user JWT from Inertia prop, cached in `sessionStorage` for 30 minutes, auto-refreshed via Inertia partial reload.

**Token priority**: per-device JWT > fallback per-user JWT > string `'undefined'` (silent auth failure).

### 2.5 DialpadProvider — Unified Call State

**File**: `resources/js/components/.../dialpad/context.tsx` (645 lines)

The central call state manager routing all operations:

```typescript
const call = useMemo(() => {
    if (useNativeVoip && nativeCallState) {
        return { identifier, status: nativeCallState.status, isMuted, elapsedTime };
    }
    return activeCall ? { identifier, status: activeCall?.state, isMuted, elapsedTime } : null;
}, [...]);
```

**Exports**: `placeCall()`, `answer()`, `hangUp()`, `toggleMute()`, `sendDTMF()`, `call` state, `callIdentifier`, audio device management.

### 2.6 Call Flows

**Outbound (web)**:
1. User selects caller ID → enters number → taps call
2. `placeCall()` validates → `client.newCall()` with `destinationNumber`, `callerNumber`, `clientState`
3. TelnyxRTC sends SIP INVITE via WebSocket
4. Call state updates via SDK events → `useNotification()` → UI transitions

**Inbound (web)**:
1. Telnyx sends SIP INVITE to registered WebSocket
2. `useNotification()` fires with `notification.call` (state `'ringing'`)
3. Lazy-loads caller identifier from backend via Inertia partial reload
4. UI shows `<IncomingCall>` with accept/reject buttons
5. `call_ended` Reverb broadcast dismisses ringing on other devices/tabs

### 2.7 Dialpad UI Components

| Component | File | Purpose |
|-----------|------|---------|
| `CallAsSelect` | `.../dialpad/components/call-as-select.tsx` | Caller ID dropdown |
| `ToInput` | `.../dialpad/components/to-input.tsx` | Dual mode: phone number / contact search |
| `Suggestions` | `.../dialpad/components/suggestions.tsx` | Contact suggestions (lazy-loaded) |
| `Dialer` | `.../dialpad/components/dialer.tsx` | 4 states: socket error, incoming, on-call, numpad |
| `CallDisplay` | `.../dialpad/components/call-display.tsx` | Persistent sidebar widget for active calls |
| `MobileDialpad` | `mobile/pages/inbox/components/mobile-dialpad.tsx` | Mobile bottom drawer variant |

### 2.8 Multi-Tab Behavior

**Problem**: All tabs share `localStorage` device ID → same SIP credentials → each tab creates separate WebSocket → all tabs receive SIP INVITE → all tabs ring.

**Partial mitigation**: `call_ended` Reverb broadcast dismisses ringing in other tabs when one answers. But there's a race window, and the backend must emit the broadcast (asynchronous).

**No tab-to-tab communication**: No BroadcastChannel API, SharedWorker, or other cross-tab synchronization.

### 2.9 Audio Device Management

Web-only feature (`context.tsx:792-825`): Enumerates input/output devices via `client.getAudioInDevices()`/`getAudioOutDevices()`. Listens for `navigator.mediaDevices.devicechange`. Output routing via `HTMLMediaElement.setSinkId()` (limited browser support).

---

## Part 3: Gap Analysis

### 3.1 All Gaps by Severity

#### HIGH (6 gaps — must fix before production VoIP)

| ID | Area | Description | Evidence |
|----|------|-------------|----------|
| **GAP-B1** | Backend | **No Telnyx webhook signature verification** — any HTTP POST to webhook URLs is processed | `routes/webhooks.php` — no auth middleware |
| **GAP-B3** | Backend | **Blocking `usleep(2s)` in sim-ring retry** — exhausts PHP-FPM workers under load | `TelnyxInboundWebhookController.php:~1915-1916` |
| **GAP-B4** | Backend | **Redis cache-only ring state** — no DB fallback; Redis failure orphans ring sessions | `Cache::put("simring:{id}")` at ~lines 1955, 2057, 2070 |
| **GAP-C1** | Credentials | **Org-level credentials never expire or cleaned up** — unbounded growth on Telnyx | `CPaaSService::handleCredentials()` — no cleanup path |
| **GAP-M1** | Multi-org | **Web has no cross-org call answer** — native has OrgSwitchHelper, web has nothing | No web equivalent of `VoipCredentialController::switchOrg()` |
| **GAP-W1** | Webhooks | **Idempotency depends on Message existence** — fails on out-of-order webhooks where Message not yet created | `ensureIdempotent()` requires `Message` instance |

#### MEDIUM (16 gaps)

| ID | Area | Description |
|----|------|-------------|
| **GAP-B2** | Backend | Failover endpoints are log-only (no processing) |
| **GAP-B5** | Backend | Web browsers can't receive SIP INVITE (no SIP leg for web credentials) |
| **GAP-B6** | Backend | `sendCallEndedPush()` not org-scoped (potential cross-org dismissal) |
| **GAP-B8** | Backend | No webhook dead letter queue or replay mechanism |
| **GAP-O1** | Outbound | Web outbound calls use org-level credential, not per-device |
| **GAP-O3** | Outbound | Outbound calls not recorded |
| **GAP-I1** | Isolation | NativeVoipProvider doesn't strictly block WebRTC initialization |
| **GAP-I3** | Isolation | No guard against placing web call while native call is active |
| **GAP-M2** | Multi-org | `switchOrg()` changes web session globally (affects Capacitor WebView) |
| **GAP-M3** | Multi-org | Phone-to-org mapping assumes single match |
| **GAP-M4** | Multi-org | No session restoration after cross-org call ends |
| **GAP-W2** | Webhooks | No webhook event store for auditing/replay |
| **GAP-W3** | Webhooks | Ring session created AFTER SIP legs (race window) |
| **GAP-C2** | Credentials | Per-device credential expiry not enforced by scheduler |
| **GAP-C3** | Credentials | JWT refresh race on web (10h TTL, no proactive refresh) |
| **GAP-C4** | Credentials | `'failed'` credential_id state gets stuck permanently |

#### LOW (5 gaps)

| ID | Area | Description |
|----|------|-------------|
| **GAP-B7** | Backend | `call.bridged` webhook not handled |
| **GAP-O2** | Outbound | No click-to-call backend API |
| **GAP-I2** | Isolation | `call_ended` Echo listener runs on native too (potential state conflict) |
| **GAP-W4** | Webhooks | No webhook timeout monitoring |
| **GAP-C5** | Credentials | No credential health check against Telnyx API |

### 3.2 Additional Code Quality Issues

From laravel-researcher and web-researcher findings:

| Issue | Location | Type |
|-------|----------|------|
| `fcm_token` column stores APNs tokens for iOS | `UserDeviceToken` schema | Naming confusion |
| Hardcoded voicemail greeting (no per-org) | `TelnyxInboundWebhookController` | Feature gap |
| Sentinel `receivingUser.id === 0` for AI routing | `handleCall()` | Fragile convention |
| Two FCM implementations with different auth | `PushNotificationService` vs `FcmChannel` | Duplication |
| User PII in unencrypted SIP headers | `transferToAgent()` X-User-Data | Security |
| Duplicate `normalizeNumber`/`numbersMatch` utilities | `context.tsx` + `use-telnyx-voip.ts` | Code duplication |
| Dual logging: `voipLogger` vs raw `console.debug` | `use-telnyx-voip.ts` vs `context.tsx` | Inconsistency |
| `'undefined'` string as JWT fallback | `useWebVoipCredentials.ts:161` | Silent failure |
| `useSafeNotification` always calls `useNotification()` | `context.tsx:528-534` | Fragile hook pattern |
| Conversation summary loads ALL messages to memory | `encodedConversationSummaryForAgent()` | Memory risk |

---

## Part 4: Target Architecture

### 4.1 Backend Call Orchestration Target

#### T-B1: Webhook Signature Verification
Add `VerifyTelnyxWebhook` middleware using ED25519 signature from `telnyx-signature-ed25519` header:
```php
// app/Http/Middleware/VerifyTelnyxWebhook.php
// Apply via route group in routes/webhooks.php
// Use \Telnyx\Webhook::constructEvent() from PHP SDK
```

#### T-B2: Active Failover Processing
Failover endpoints should replay the full webhook pipeline (idempotency via `ensureIdempotent()` prevents double-processing).

#### T-B3: Replace Blocking Retry with Queued Job
```php
// Replace usleep(2_000_000) with:
SimRingRetryJob::dispatch($call_control_id, $message->id, $sipDestinations)
    ->delay(now()->addSeconds(2));
```

#### T-B4: Redis Resilience
1. Health check before sim-ring
2. Fallback to single-device transfer if Redis unavailable
3. Consider DB-backed ring sessions (Redis for locking, DB for state)
4. Monitoring/alerting for Redis connectivity

### 4.2 Web Client Target

#### T-W-Creds: Web Per-Device Credentials for All Flows
Web clients should consistently use per-device credentials (already provisioned via `DeviceTokenController`) instead of org-level credentials. This enables web to participate in sim-ring as a proper SIP leg target.

#### T-W-Refresh: Proactive JWT Refresh
Timer-based refresh before 10-hour expiry:
```typescript
useEffect(() => {
    const interval = setInterval(async () => {
        const { jwt_token } = await fetch('/api/voip/credentials').then(r => r.json());
        // Reconnect SDK with new JWT
    }, 8 * 60 * 60 * 1000);
    return () => clearInterval(interval);
}, []);
```

#### T-W-MultiTab: Tab Coordination
Options: BroadcastChannel API for cross-tab state sync, or SharedWorker for single WebSocket connection across tabs. Minimum: use BroadcastChannel to coordinate "answered elsewhere" across tabs without depending on Reverb latency.

#### T-W-Isolation: Stronger VoIP Provider Isolation
Dynamic import `@telnyx/react-client` only on web (lazy import). NativeVoipProvider should actively prevent any WebRTC SDK loading. Add active call guard preventing web-side call actions while native call is in progress.

### 4.3 Multi-Org Target

#### T-M1: Web Cross-Org Call Answer
1. Broadcast `IncomingCallNotification` on a non-org-scoped channel (or broadcast to all user orgs)
2. Web client detects org mismatch → calls `POST /api/voip/switch-org`
3. Refresh credentials + WebRTC connection → answer call

#### T-M2: Separate VoIP Session from Web Session
`switchOrg()` should NOT call `$organization->switchTo()`. Instead, temporarily scope credential operations to the target org without changing the web session:
```php
CurrentTenant::set($organization);
$jwt = CPaaSService::handleCredentials($user);
// Don't persist the org switch to the session
```

### 4.4 Webhook Reliability Target

#### T-WH1: Message-Independent Idempotency
Use Telnyx's event ID (`data.id`) for deduplication BEFORE message lookup:
```php
$webhookId = $request->input('data.id');
if (Cache::has("webhook_processed:{$webhookId}")) {
    return response()->json(['ok' => true], 200);
}
```

#### T-WH2: Webhook Event Store
```sql
CREATE TABLE webhook_events (
    id BIGSERIAL PRIMARY KEY,
    source VARCHAR(50),
    event_type VARCHAR(100),
    event_id VARCHAR(255) UNIQUE,
    payload JSONB,
    processed_at TIMESTAMP,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

#### T-WH3: Pre-Create Ring Session
Move `Cache::put("simring:{id}")` BEFORE `Call::create()` to prevent race condition where a fast answer arrives before ring session exists.

### 4.5 Credential Management Target

#### T-C1: Scheduled Cleanup
- Daily artisan command for org-level credential cleanup (users no longer in org, deactivated orgs)
- Daily job checking `credential_expires_at` on device tokens, deleting expired credentials from Telnyx + DB

#### T-C2: Fix Failed Credential State
```php
if ($existing && $existing->credential_id === 'failed') {
    $existing->delete(); // Remove broken record, fall through to create
}
```

#### T-C3: Credential Health Check
Verify stored credentials still exist on Telnyx; delete and recreate on 404.

---

## Part 5: Implementation Roadmap

### Phase 1: Immediate (Before Production VoIP Launch)
| Priority | Gap | Action |
|----------|-----|--------|
| P0 | GAP-B1 | Implement Telnyx webhook signature verification middleware |
| P0 | GAP-B3 | Replace `usleep()` with `SimRingRetryJob::dispatch()->delay(2s)` |
| P0 | GAP-C4 | Fix stuck `'failed'` credential state |
| P0 | GAP-W1 | Add Telnyx event ID-based idempotency before message lookup |
| P0 | GAP-W3 | Pre-create ring session before SIP leg creation |

### Phase 2: Short-Term (First Sprint After Launch)
| Priority | Gap | Action |
|----------|-----|--------|
| P1 | GAP-B4 | Redis health check + single-device fallback |
| P1 | GAP-C1 | Scheduled org-level credential cleanup |
| P1 | GAP-M1 | Web cross-org call answer flow |
| P1 | GAP-B2 | Activate failover webhook processing |
| P1 | GAP-C3 | Proactive JWT refresh on web |

### Phase 3: Medium-Term (2-3 Sprints)
| Priority | Gap | Action |
|----------|-----|--------|
| P2 | GAP-M2 | Separate VoIP session from web session |
| P2 | GAP-C2 | Per-device credential expiry enforcement |
| P2 | GAP-O3 | Outbound call recording |
| P2 | GAP-I1 | Stronger VoIP isolation (dynamic imports) |
| P2 | GAP-W2 | Webhook event store |
| P2 | GAP-B6 | Org-scope sendCallEndedPush |

### Phase 4: Long-Term (Backlog)
| Priority | Gap | Action |
|----------|-----|--------|
| P3 | GAP-O2 | Backend-initiated outbound call API |
| P3 | GAP-B5 | Web SIP leg for inbound calls (major arch change) |
| P3 | GAP-I3 | Active call guard across platforms |
| P3 | Multi-tab | BroadcastChannel/SharedWorker for tab coordination |

---

## Appendix: File Reference Index

### Backend
| File | Lines | Role |
|------|-------|------|
| `routes/webhooks.php` | 61 | Webhook route definitions |
| `app/Http/Controllers/Telnyx/TelnyxCallController.php` | 375 | Abstract base controller |
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | 1,060 | Inbound call routing |
| `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php` | 41 | Outbound call handling |
| `app/Services/CPaaSService.php` | 543 | Telnyx API client + credential management |
| `app/Services/PushNotificationService.php` | 321 | FCM + APNs push dispatch |
| `app/Services/ApnsVoipService.php` | 182 | Direct APNs HTTP/2 push |
| `app/Channels/FcmChannel.php` | 137 | Laravel notification FCM channel |
| `app/Events/IncomingCallNotification.php` | 57 | Reverb broadcast (incoming) |
| `app/Events/CallEndedNotification.php` | 46 | Reverb broadcast (ended) |
| `app/Broadcasting/TenantPrivateChannel.php` | 25 | Org-scoped channel |
| `app/Models/UserDeviceToken.php` | 166 | Device token model |
| `app/Models/UserTelnyxTelephonyCredential.php` | 22 | Org credential model |
| `app/Http/Controllers/Api/DeviceTokenController.php` | ~200 | Device registration API |
| `app/Http/Controllers/Api/VoipCredentialController.php` | ~220 | Credential + org switch API |
| `app/Support/VoipLog.php` | 51 | Structured VoIP logger |
| `app/Data/Telnyx/TelnyxWebhook.php` | 58 | Webhook DTO |
| `app/Data/Telnyx/Casts/TelnyxPayloadCast.php` | 44 | Polymorphic payload casting |

### Frontend
| File | Lines | Role |
|------|-------|------|
| `resources/js/layouts/app-layout.tsx` | 308 | Provider switching + credential init |
| `resources/js/utils/platform.ts` | 37 | Platform detection |
| `resources/js/providers/native-voip-provider.tsx` | 39 | No-op native context |
| `resources/js/hooks/useWebVoipCredentials.ts` | 170 | Per-device browser registration |
| `resources/js/hooks/useSessionCache.ts` | 74 | Session-scoped JWT cache |
| `resources/js/components/.../dialpad/context.tsx` | 645 | Unified call state manager |
| `resources/js/components/.../dialpad/dialpad.tsx` | 33 | Desktop dialpad page |
| `resources/js/components/.../dialpad/components/dialer.tsx` | 274 | Numpad / incoming / on-call UI |
| `resources/js/components/.../dialpad/components/call-as-select.tsx` | 26 | Caller ID dropdown |
| `resources/js/components/.../dialpad/components/to-input.tsx` | 63 | Phone/search input |
| `resources/js/components/.../dialpad/components/suggestions.tsx` | 65 | Contact suggestions |
| `resources/js/components/.../dialpad/components/call-display.tsx` | 15 | Sidebar call widget |
| `resources/js/hooks/use-push-notifications.ts` | 206 | Non-VoIP push handling |
| `resources/js/lib/voip-logger.ts` | 57 | Browser console logger |
| `resources/js/plugins/telnyx-voip.ts` | 247 | Capacitor plugin interface |
| `resources/js/plugins/use-telnyx-voip.ts` | 458 | Native VoIP hook |

---

*Generated: 2026-02-08 | Session 07 | Sources: voip-backend skill, voip-frontend skill, telnyx-php-sdk pack, telnyx-web-sdk pack, live source*
