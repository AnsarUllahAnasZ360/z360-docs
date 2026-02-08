---
title: Telnyx Reference Unified
---

# Unified Telnyx Technology Reference

> Synthesized from three research streams: Call Control API, WebRTC SDKs (Android/iOS/Web), and Credential & Push Architecture. This document serves as the definitive Telnyx technology reference for Z360's VoIP implementation.

---

## 1. Telnyx Platform Architecture

### 1.1 Resource Hierarchy

Z360 provisions four infrastructure resources at the Telnyx account level. All are shared across tenants (organizations):

```
Telnyx Account
 │
 ├── Outbound Voice Profile (OVP)
 │    Config: cpaas.telnyx.ovp_id
 │    Purpose: Controls outbound call routing for both connections
 │
 ├── Credential Connection
 │    Config: cpaas.telnyx.credential_connection_id
 │    Purpose: WebRTC SIP registrations (devices connect here)
 │    Contains: N Telephony Credentials (per-user, per-device)
 │    Webhook: /webhooks/cpaas/telnyx/credential
 │
 ├── Call Control Application
 │    Config: cpaas.telnyx.call_control_id
 │    Purpose: PSTN inbound/outbound call management
 │    Webhook: /webhooks/cpaas/telnyx/inbound (and /outbound)
 │
 └── Notification Profile + Channel
      Config: cpaas.telnyx.notifications_profile_id
      Purpose: Telnyx notification events (webhooks)
      Channel: webhook → /webhooks/cpaas/telnyx/notifications
```

**Key insight**: The Credential Connection and Call Control Application are *separate resources* serving different roles. The Credential Connection hosts SIP registrations (devices); the Call Control App handles PSTN call events. Z360 bridges between them programmatically when routing inbound PSTN calls to WebRTC devices.

### 1.2 Protocol Stack

All three Telnyx WebRTC SDKs share the same protocol architecture:

| Layer | Technology | Details |
|-------|-----------|---------|
| Signaling | **Verto** (JSON-RPC over WebSocket) | `wss://rtc.telnyx.com:443` |
| Media | **WebRTC** (SRTP/DTLS) | Peer-to-peer or relayed |
| NAT Traversal | **STUN/TURN** | `stun.telnyx.com:3478` / `turn.telnyx.com:3478` |
| Backend API | **REST** (Call Control v2) | Command/webhook async model |

### 1.3 Interaction Model

```
┌─────────────┐         ┌─────────────┐         ┌──────────────┐
│  PSTN/SIP   │◄───────►│   Telnyx    │◄───────►│  Z360 Backend│
│  Network    │  Media   │  Platform   │ Webhooks│  (Laravel)   │
└─────────────┘         └──────┬──────┘  + REST  └──────┬───────┘
                               │                        │
                        Verto/WebRTC              FCM/APNs Push
                               │                  + Reverb WS
                               ▼                        │
                        ┌──────────────┐                ▼
                        │ WebRTC SDKs  │         ┌──────────────┐
                        │ (Android/iOS │◄────────│  Mobile/Web  │
                        │  /Web)       │  Push   │  Clients     │
                        └──────────────┘         └──────────────┘
```

---

## 2. Authentication & Credentials

### 2.1 Credential Model

Z360 implements a **two-tier credential architecture**:

| Tier | Scope | Storage | Expiry | Purpose |
|------|-------|---------|--------|---------|
| **Org-level** | 1 per (user, organization) | `UserTelnyxTelephonyCredential` | No explicit expiry | Web WebRTC fallback |
| **Per-device** | 1 per (user, org, device) | `UserDeviceToken` | 30 days | Multi-device simultaneous ring |

Both tiers create `TelephonyCredential` resources on the **same Credential Connection**.

### 2.2 Authentication Flow (All Platforms)

```
1. Device registers → POST /api/device-tokens
2. Backend creates TelephonyCredential on Telnyx (if needed)
3. Backend generates JWT via $credential->token() (10h TTL)
4. JWT returned to client
5. Client connects to wss://rtc.telnyx.com with JWT (token login)
6. Verto login → gateway states: UNREGED → TRYING → REGISTER → REGED
7. Client ready for calls
```

### 2.3 SDK Authentication Comparison

| Aspect | Android | iOS | Web |
|--------|---------|-----|-----|
| Config class | Sealed class `TelnyxConfig` | Struct `TxConfig` | Interface `IClientOptions` |
| Credential login | `CredentialConfig(sipUser, sipPassword, ...)` | `TxConfig(sipUser:, password:)` | `{ login, password }` |
| Token login | `TokenConfig(sipToken, ...)` | `TxConfig(token:)` | `{ login_token }` |
| Anonymous login | `AuthenticateAnonymously` | `AnonymousLoginMessage` | `{ anonymous_login: true }` |
| Push token field | `fcmToken` (FCM) | `pushDeviceToken` (APNs) | N/A |
| Auto-reconnect default | `false` (cred) / `true` (token) | `true` (both) | `true` (both) |

### 2.4 Credential Lifecycle

```
Creation                          Active                          Cleanup
─────────                         ──────                          ───────
Device register →                 JWT expires (10h) →             Stale device (7d inactive) →
  createDeviceCredential()          Client requests new JWT         Delete credential + token
  30-day expiry set                 via getDeviceJwt()
                                                                  Web dedup (max 1/user/org) →
Web app loads VoIP →              Credential expires (30d) →        Delete older web devices
  handleCredentials()               New credential on next
  No explicit expiry                registration                  Push failure (UNREGISTERED) →
                                                                    removeToken()
Org switch →
  handleCredentials()                                             Manual DELETE →
  for target org                                                    deleteTelnyxCredential()
```

### 2.5 Multi-Organization Architecture

- **Single Credential Connection** shared across all organizations (platform-level config)
- Credentials and device tokens scoped per-org in the database
- A user in N organizations has N separate org-level credentials + up to N×D device credentials (D = devices)
- Push payloads include `organization_id` for client-side org context
- Org switching via `POST /api/voip/switch-org` re-provisions credentials for the target org

---

## 3. Call Control API

### 3.1 Command/Webhook Model

Telnyx Call Control is **asynchronous**: the application sends REST commands, and Telnyx sends webhook callbacks with results. Each call leg has a `call_control_id`; related legs share a `call_session_id`.

### 3.2 Actions Used by Z360

| Action | PHP SDK Method | Key Parameters | Expected Webhooks | Z360 Usage |
|--------|---------------|----------------|-------------------|------------|
| **Answer** | `$call->answer()` | `client_state`, `webhook_url` | `call.answered` | Answer inbound calls, attach direction context |
| **Bridge** | `$call->bridge()` | `call_control_id` (target) | `call.bridged` (both legs) | Connect parent PSTN call to winning device leg |
| **Transfer** | `$call->transfer()` | `to` (SIP/DID), `from`, `timeout_secs`, `custom_headers` | `call.initiated`, `call.bridged`, `call.answered`/`call.hangup` | Single-device routing, AI agent transfer |
| **Dial/Create** | `Call::create()` | `to`, `from`, `connection_id`, `webhook_url`, `timeout_secs` | `call.initiated`, `call.answered`/`call.hangup` | Simultaneous ring legs (one per device) |
| **Hangup** | `$call->hangup()` | `client_state` | `call.hangup` | Terminate losing ring legs, blocked callers |
| **Speak** | `$call->speak()` | `payload`, `voice` | `call.speak.started`, `call.speak.ended` | Voicemail greeting, blocked caller message |
| **Record** | `$call->record_start()` | `channels`, `format`, `play_beep` | `call.recording.saved` | Voicemail recording after greeting |

### 3.3 client_state Mechanism

Z360 uses base64-encoded JSON in `client_state` to track context across asynchronous webhook callbacks:

| Type | Context | Key Data |
|------|---------|----------|
| `user_call` | Standard call to user | `user_id`, `organization_id` |
| `simultaneous_ring_leg` | One device leg of multi-ring | `parent_call_control_id`, `user_id`, `message_id` |
| `simultaneous_ring_parent` | Parent call after answer-for-bridge | `user_id` |
| `voicemail_parent` | Recording voicemail | `user_id`, `message_id` |
| `voicemail_greeting` | Playing greeting | `user_id`, `message_id` |

The `type` field drives webhook routing. The `is_outbound` flag (derived from presence of `user_id`) enables direction gating between inbound and outbound controllers.

### 3.4 Webhook Routing Architecture

```
POST /webhooks/cpaas/telnyx/call-control
    │
    ├── TelnyxCallController::__invoke()
    │   ├── Parse webhook → TelnyxWebhook data object
    │   ├── Idempotency check (duplicate webhook protection)
    │   ├── Direction gating via client_state
    │   │
    │   ├── Base handlers: call.initiated, call.answered, call.recording.saved
    │   └── Extension methodMap dispatch → child controllers
    │
    ├── TelnyxInboundWebhookController (direction: incoming)
    │   ├── call.hangup → cleanup, voicemail fallback
    │   ├── call.answered → sim-ring race resolution
    │   ├── call.initiated → track new ring legs
    │   └── call.speak.ended → start voicemail recording
    │
    └── TelnyxOutboundWebhookController (direction: outgoing)
        └── Minimal (41 lines)
```

---

## 4. Call Flows

### 4.1 Inbound → Single Device (Transfer)

When only one device is registered:

```
PSTN → Telnyx webhook (call.initiated) → Z360 answers → Z360 transfers to SIP URI
     → Telnyx auto-bridges → call.bridged → CALL ACTIVE
```

Uses `$call->transfer()` which handles bridging automatically.

### 4.2 Inbound → Multiple Devices (Simultaneous Ring)

When 2+ devices are registered:

```
PSTN → Telnyx webhook (call.initiated) → Z360 answers parent call
     → Z360 creates N SIP legs via Call::create (one per device)
     → All devices ring simultaneously
     → First device to answer wins (Cache::lock race resolution)
     → Z360 bridges parent ↔ winner, hangs up all losers
     → CALL ACTIVE
     → If all reject → voicemail fallback
```

Uses `Call::create()` + manual `answer()` + `bridge()` sequence. Cache (Redis) tracks ring session state with 10-minute TTL.

### 4.3 Inbound → Voicemail

When no device answers or no receiving user configured:

```
PSTN → Z360 answers → speak() voicemail greeting
     → call.speak.ended webhook → record_start()
     → Caller leaves message → call.hangup
     → call.recording.saved → persist recording metadata
```

### 4.4 Inbound → AI Agent

```
PSTN → Z360 answers → transfer() to AI SIP endpoint
     → Custom SIP headers: X-Tenant-Id, X-Thread-Id, X-Agent-Introduction,
       X-Agent-Voice, X-Conversation-Summary
     → Auto-bridge → AI conversation active
```

---

## 5. Push Notification Architecture

### 5.1 Server-Mediated Push (Critical Architectural Decision)

**Z360 does NOT use Telnyx's native push credential binding.** Instead, Z360 implements a fully server-mediated push model:

```
PSTN Call → Telnyx Call Control App webhook
         → Z360 Backend receives call.initiated
         → Z360 looks up user's devices
         → Z360 sends push DIRECTLY:
              FCM (Android) via Google FCM HTTP v1 API
              APNs VoIP Push (iOS) via ApnsVoipService
              Reverb WebSocket broadcast (Web)
         → Z360 initiates SIP legs for simultaneous ring
```

### 5.2 Why Server-Mediated?

| Benefit | Explanation |
|---------|-------------|
| Multi-org routing | Push includes `organization_id` for client-side org context |
| Rich payloads | Caller name, avatar, channel number from Z360's contact DB |
| Unified control | Push, WebSocket broadcast, and SIP leg creation coordinated |
| Call correlation | Push includes `call_session_id` and `call_control_id` |

### 5.3 SDK Push Expectations vs Z360 Reality

| Aspect | SDK Expects | Z360 Does |
|--------|-------------|-----------|
| Push sender | Telnyx sends push via registered push credentials | Z360 backend sends push directly via FCM/APNs |
| Push payload | SDK-defined `PushMetaData` / `TxServerConfiguration` | Custom payload with org context, caller info, avatars |
| Push-to-call flow | SDK `handlePushNotification()` connects to specific signaling server from push | Client receives push, connects to standard WebRTC gateway, waits for SIP INVITE |
| Push token registration | Client registers push token during Verto login | Client registers push token with Z360 backend at device registration |

### 5.4 Platform-Specific Push Handling

| Platform | Push System | SDK Method | OS Integration |
|----------|-------------|-----------|----------------|
| Android | FCM (data-only, HIGH priority, 60s TTL) | `handlePushNotification(txPushMetaData, txConfig)` | — |
| iOS | PushKit VoIP Push + APNs | `processVoIPNotification(txConfig:serverConfiguration:pushMetaData:)` | CallKit required (iOS 13+) |
| Web | N/A (persistent WebSocket) | Reverb broadcast `IncomingCallNotification` event | — |

---

## 6. WebRTC SDK Reference (Cross-Platform)

### 6.1 Connection Model

All SDKs connect via WebSocket to `wss://rtc.telnyx.com` using the Verto JSON-RPC protocol.

| Aspect | Android | iOS | Web |
|--------|---------|-----|-----|
| WS Library | OkHttp | Starscream | Native WebSocket |
| TURN/STUN | Hardcoded `turn.telnyx.com:3478` | Hardcoded `turn.telnyx.com:3478` | From login response |
| Connection class | `TxSocket.kt` | `Socket.swift` | `Connection.ts` |
| Top-level client | `TelnyxClient.kt` | `TxClient.swift` | `TelnyxRTC.ts` |

### 6.2 Call States (Unified Map)

| Android | iOS | Web | Meaning |
|---------|-----|-----|---------|
| `NEW` | `NEW` | `New` | Call object created |
| `CONNECTING` | `CONNECTING` | `Requesting`/`Trying` | Signaling in progress |
| — | — | `Early` | Early media (Web only) |
| `RINGING` | `RINGING` | `Ringing` | Remote party ringing |
| — | — | `Answering` | Answer in progress (Web only) |
| `ACTIVE` | `ACTIVE` | `Active` | Media flowing |
| `RENEGOTIATING` | — | — | SDP renegotiation (Android only) |
| `HELD` | `HELD` | `Held` | Call on hold |
| `RECONNECTING` | `RECONNECTING` | `Recovering` | Call recovery in progress |
| `DROPPED` | `DROPPED` | — | Network drop (mobile only) |
| `ERROR` | — | — | Call error (Android only) |
| `DONE(reason)` | `DONE(reason)` | `Hangup` | Call ended |

### 6.3 Reconnection

| Aspect | Android | iOS | Web |
|--------|---------|-----|-----|
| Auto-reconnect | `false` (cred) / `true` (token) | `true` | `true` |
| Timeout | 60s | 60s | Not specified |
| Max retries | 3 (exponential backoff: 1s → 2s → 4s) | — | `reconnectDelay()` |
| Network monitor | — | NWPathMonitor | Browser online/offline |
| ICE restart | — | Yes (`Call+IceRestart`) | — |
| Session preservation | `sessid` across reconnects | `sessid` across reconnects | `sessid` + `reconnection: true` flag |

### 6.4 Event/Callback Patterns

| Aspect | Android | iOS | Web |
|--------|---------|-----|-----|
| Pattern | LiveData / callbacks | Delegate protocol (`TxClientDelegate`) | EventEmitter (`on`/`off`) |
| Incoming call | `onIncomingCall` callback | `onIncomingCall(call:)` | `telnyx.notification` event |
| State updates | `onCallStateChanged` | `onCallStateUpdated()` | `telnyx.notification` event |
| Ready | `onClientReady` | `onClientReady()` | `telnyx.ready` event |
| Error | `onClientError` | `onClientError()` | `telnyx.error` event |

---

## 7. Discrepancies & Gaps

### 7.1 Z360 Implementation vs SDK Expectations

| Area | Discrepancy | Impact |
|------|-------------|--------|
| **Push delivery** | SDKs expect Telnyx-native push; Z360 sends push directly | Z360 push payloads differ from SDK `PushMetaData` format. Mobile clients must parse Z360's custom payload instead of SDK-expected fields |
| **Push-to-call flow** | SDKs expect `rtcIP`/`signalingServer` in push for direct connection | Z360 doesn't provide signaling server in push; devices connect to default gateway |
| **Auto-reconnect default** | Android credential login defaults to `false`; iOS/Web default to `true` | Android devices may not auto-reconnect unless explicitly configured |
| **Call states** | Android has `RENEGOTIATING`/`ERROR` states; Web has `Requesting`/`Trying`/`Early`/`Answering` | Platform-specific state handling needed in client code |
| **Gateway states** | Android has `DOWN` state; iOS/Web do not | Minor — only affects edge case handling |
| **ICE restart** | Only iOS SDK has explicit ICE restart support | Android/Web may need custom handling for media path recovery without full reconnection |
| **call.bridged not handled** | Z360 doesn't process `call.bridged` events | No bridge confirmation; bridge success is inferred from command success |

### 7.2 Unused SDK Capabilities (Potential Improvements)

| Capability | What It Does | Potential Z360 Benefit |
|-----------|-------------|----------------------|
| `bridgeOnAnswer` + `linkTo` | Auto-bridge when leg answers | Could simplify simultaneous ring (eliminate manual bridge) |
| `command_id` | Idempotency for outbound commands | Prevent duplicate bridge/hangup on retries |
| `parkAfterUnbridge` | Park call after bridge ends | Enable hold/transfer without hangup |
| `ActionRejectParams` | Reject with SIP cause code | Cleaner blocked-caller handling (no need to answer first) |
| `ActionStartPlaybackParams` | Play audio files | Pre-recorded voicemail greetings instead of TTS |
| `ActionGatherParams` | DTMF collection | IVR menus, phone-based navigation |
| `ActionStartStreamingParams` | Real-time audio to WebSocket | AI-powered real-time call processing |
| `ActionStartTranscriptionParams` | Live transcription | Call transcription, compliance recording |

### 7.3 Architectural Constraints

These constraints **must be respected** by any platform architecture:

1. **Verto is the only signaling protocol** — All SDKs use Verto JSON-RPC over WebSocket. There is no REST-based call signaling alternative.

2. **SIP registration stealing** — If two devices register with the same SIP credential, the newer registration displaces the older one. Per-device credentials are required for simultaneous ring.

3. **WebSocket must be connected for calls** — Even push-initiated calls require the SDK to establish a WebSocket connection and complete Verto login before the call can be answered.

4. **10-hour JWT TTL** — JWTs expire after ~10 hours. Clients must refresh tokens before expiry to maintain connectivity.

5. **30-second ring timeout** — Z360 uses 30-second `timeout_secs` for all ring legs. After timeout, Telnyx sends `call.hangup`.

6. **Cache dependency for simultaneous ring** — Ring session coordination depends on Redis cache with 10-minute TTL. Cache failure breaks multi-device ringing.

7. **Single webhook endpoint** — All call events route through one URL, filtered by direction. Both inbound and outbound events share the same endpoint.

8. **Server-mediated push is a hard dependency** — Z360's push infrastructure (FCM/APNs) is independent of Telnyx. If push fails, devices won't wake for incoming calls even though SIP legs are created.

9. **CallKit required on iOS** — iOS 13+ requires CallKit integration for VoIP push. PushKit delivery must immediately report to CallKit or the app may be terminated.

10. **Single Credential Connection across all orgs** — All tenants share one connection. This simplifies provisioning but means a Telnyx-side connection issue affects all orgs.

---

## 8. Source Documents

This synthesis is derived from three detailed research documents:

| Document | Scope | Location |
|----------|-------|----------|
| Call Control API Reference | PHP SDK actions, webhook sequences, client_state, bridging, sim-ring | `.scratchpad/whitepaper/01-technology-landscape/telnyx-call-control-api.md` |
| WebRTC SDK Reference | Android/iOS/Web connection, auth, call lifecycle, push, reconnection, states | `.scratchpad/whitepaper/01-technology-landscape/telnyx-sdks-reference.md` |
| Credentials & Push Architecture | Credential model, push notification flow, lifecycle, multi-org | `.scratchpad/whitepaper/01-technology-landscape/telnyx-credentials-and-push.md` |

For detailed code examples, file path references, and implementation specifics, refer to the individual documents above.
