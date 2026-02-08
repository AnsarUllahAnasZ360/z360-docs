---
title: Simring Alternatives Research
---

# Simultaneous Ringing: Telnyx Patterns & Alternative Approaches

> **Researcher**: telnyx-researcher
> **Date**: 2026-02-08
> **Sources**: Telnyx PHP/Web/iOS/Android SDK packs, Telnyx official docs, Twilio/Vonage docs, Z360 codebase

---

## 1. Executive Summary

Z360's current simultaneous ringing implementation uses a **manual N-leg + cache-lock** approach: the backend creates individual outbound call legs to each registered device's SIP credential, then uses a Redis lock to coordinate "first answer wins" bridging. This research evaluates whether Telnyx offers built-in alternatives and compares with competitor platforms.

**Key Findings**:

1. **Telnyx Dial API supports multi-destination arrays** — the `to` parameter accepts `string | list<string>`, enabling native simultaneous ring with automatic first-answer-wins. However, this works for the **Dial** command (new outbound calls), not for routing inbound calls from webhooks.
2. **Telnyx SIP Connection simultaneous ring** exists but requires **shared credentials** — all devices register under the same username/password. This conflicts with Z360's per-device credential model needed for org-scoping.
3. **On-demand credentials cannot receive inbound calls** — Telnyx explicitly states on-demand credentials are "purely for outbound calls." Z360 works around this by creating outbound legs from the server to each credential.
4. **Z360's manual approach is actually the recommended pattern** for Call Control webhook-driven apps with per-device credentials. It's not a workaround — it's the standard architecture.
5. **Twilio and Vonage offer simpler declarative approaches** (TwiML `<Dial>` with multiple nouns, Vonage NCCO `connect`) but these are XML/JSON-scripted, not webhook-driven.
6. **`bridge_on_answer` + `link_to`** parameters in the Telnyx Dial API could potentially simplify Z360's bridge step, but would not eliminate the need for manual leg cleanup.

---

## 2. Telnyx Built-in Simultaneous Ring Capabilities

### 2.1 SIP Connection-Level Simultaneous Ring

Telnyx offers a **SIP connection-level simultaneous ring** feature for credential-authenticated connections.

**How it works**:
- Multiple SIP devices register under the **same** credentials (username/password) on a single SIP connection
- When an inbound call arrives, Telnyx forks the SIP INVITE to **all registered endpoints**
- First device to answer gets connected; others are disconnected
- Optional overflow to voicemail/IVR after configurable ring timeout

**Configuration**: Enable via Mission Control portal → SIP Connection → Inbound Settings → Simultaneous Ring toggle.

**Critical limitation**: Only **one set of credentials** — all devices share the same username. There is no per-device identification at the SIP level.

> **Source**: [Telnyx Release Notes: Simultaneous Ring for SIP Trunking](https://telnyx.com/release-notes/simultaneous-ring-sip-trunking), [SIP Connection Inbound Settings](https://support.telnyx.com/en/articles/4404448-sip-connection-inbound-outbound-settings)

**Why Z360 can't use this**: Z360 requires **per-device credentials** because:
- Credentials are scoped by organization (multi-tenant)
- Each device needs independent SIP registration for org-switching
- The backend needs to know which specific device answered (for logging, presence)
- Shared credentials provide no device-level accountability

### 2.2 Call Control Dial API with Multi-Destination `to`

The Telnyx Dial API's `to` parameter accepts an **array of strings**:

```php
// From Telnyx PHP SDK: src/Calls/CallDialParams/To.php
// "The DID or SIP URI to dial out to. Multiple DID or SIP URIs can be provided
//  using an array of strings."
// @phpstan-type ToVariants = string|list<string>
public string|array $to;
```

**Behavior with multiple destinations**:
- Telnyx dials all destinations simultaneously
- First to answer gets connected to the caller
- Other legs are automatically hung up
- Single `call_leg_id`, `call_control_id`, `call_session_id` in response

**Relevant Dial parameters for bridging**:
| Parameter | Type | Purpose |
|---|---|---|
| `to` | `string \| list<string>` | Destination(s) to dial — supports array for sim-ring |
| `link_to` | `string` | Call Control ID to share session with |
| `bridge_intent` | `bool` | Signal intent to bridge with `link_to` call |
| `bridge_on_answer` | `bool` | Auto-bridge to `link_to` call when answered |
| `client_state` | `string` | Base64-encoded state for webhook correlation |
| `timeout_secs` | `int` | Ring timeout (default 30s) |

> **Source**: [Telnyx Dial API](https://developers.telnyx.com/api/call-control/dial-call), PHP SDK `src/Calls/CallDialParams.php`

**Why Z360 doesn't use this directly**: The Dial command creates **new outbound calls**. Z360's flow starts with an **inbound** call arriving via webhook. The inbound call must be parked while outbound legs ring. Dial with array `to` creates a single logical call — it doesn't let you park an existing inbound call and bridge on answer.

### 2.3 Call Control Transfer API (Single Destination)

The Transfer command routes an existing call to a new destination:

```php
// From Telnyx PHP SDK: src/Calls/Actions/ActionTransferParams.php
// "The DID or SIP URI to dial out to."
// to: string  (NOT array — single destination only)
public string $to;
```

**Transfer is single-destination only** — it cannot take an array. Z360 uses Transfer for the **single-device case** (when only one SIP credential exists). For multi-device, it falls back to the manual N-leg approach.

> **Source**: PHP SDK `src/Calls/Actions/ActionTransferParams.php` line 8938: `to: string`

### 2.4 Call Control Queue API

Telnyx offers a queue primitive:

```php
// src/Calls/Actions/ActionEnqueueParams.php
// "Put the call in a queue."
public string $queueName;
public ?bool $keepAliveAfterHangup;
public ?int $maxSize;
public ?int $maxWaitTimeSecs;
```

Queues hold calls until an agent is available, with bridge-to-queue support:

```php
// src/Calls/Actions/ActionBridgeParams.php
// "The name of the queue you want to bridge with...bridging with the first call in the queue"
public ?string $queue;
```

**Queue is for sequential/round-robin patterns**, not simultaneous ring. It's a FIFO mechanism where agents pull calls, not a broadcast mechanism.

### 2.5 Media Forking (Not Call Forking)

The `fork_start` / `fork_stop` commands are for **media streaming**, not call forking:

```php
// src/Calls/Actions/ActionStartForkingParams.php
// "Call forking allows you to stream the media from a call to a specific target in realtime.
//  This stream can be used to enable realtime audio analysis..."
public ?string $rx;  // RTP target for incoming media
public ?string $tx;  // RTP target for outgoing media
```

This is for recording, AI analysis, and monitoring — **completely unrelated to simultaneous ringing**.

> **Source**: PHP SDK `src/Calls/Actions/ActionStartForkingParams.php`

---

## 3. Telnyx Credential Lifecycle & Best Practices

### 3.1 Credential Types

| Type | Created Via | Inbound Calls? | Use Case |
|---|---|---|---|
| **SIP Connection Credentials** | Portal | Yes | Desk phones, softphones |
| **On-Demand Credentials** | REST API (`POST /v2/telephony_credentials`) | **No** | WebRTC platforms, call centers |
| **JWT Tokens** | REST API (from on-demand cred) | **No** (inherits from parent) | Temporary access, 24h TTL |

**Critical**: On-demand credentials (what Z360 uses) **cannot receive inbound calls directly**. The documented workaround is exactly Z360's pattern:

> "The purpose for on demand generated credentials is purely for outbound calls. The typical use case is a call center service. You have a programmable voice application associated with a number. When a call is received to that number, you see which agents are logged in with the on demand generated credentials and your backend system can route calls to those agents."

> **Source**: [Telephony Credentials: Types](https://support.telnyx.com/en/articles/7029684-telephony-credentials-types)

### 3.2 Credential Create Parameters

```php
// src/TelephonyCredentials/TelephonyCredentialCreateParams.php
public string $connectionID;    // Required: Credential Connection ID
public ?string $expiresAt;      // ISO-8601 expiry ("for security when many are expected")
public ?string $name;           // Human-readable name
public ?string $tag;            // Tag for filtering (max 1000 creds per tag)
```

**Credential response fields**:
```php
// src/TelephonyCredentials/TelephonyCredential.php
public string $id;
public string $sipUsername;      // Auto-generated, starts with "gencred"
public string $sipPassword;      // Auto-generated
public string $resourceId;       // Connection reference
public string $status;           // active, expired
```

### 3.3 Lifecycle Best Practices

Based on the Telnyx documentation and API:

1. **Creation**: Use `POST /v2/telephony_credentials` with `connection_id`. Add `expires_at` for time-limited credentials. Add `tag` for bulk management (e.g., tag by org).
2. **Listing/Filtering**: Filter by `status=expired`, `tag=org-{id}`, `resource_id=connection:{connection_id}`.
3. **Rotation**: There is no built-in rotation. Pattern: create new credential → update device registration → delete old credential. Expired credentials enter terminal state (cannot be updated, only deleted).
4. **Deletion**: `DELETE /v2/telephony_credentials/{id}` revokes voice capabilities immediately.
5. **No limits**: "There are no limits on credential counts per connection or account."
6. **Password strength**: "At least 12-16 characters, mix of upper and lower case letters, numbers, and special characters."

> **Source**: [Telnyx Telephony Credentials Docs](https://developers.telnyx.com/docs/voice/webrtc/auth/telephony-credentials)

### 3.4 Z360's Credential Management

Z360 stores credentials in two tables:

| Table | Purpose | Credential Type |
|---|---|---|
| `user_telnyx_telephony_credentials` | Web login (JWT) | On-demand → JWT (10h TTL) |
| `user_device_tokens` | Mobile SIP credentials | On-demand (SIP username/password) |

Key code paths:
- `CPaaSService::handleCredentials()` — creates org-level credentials for web
- `CPaaSService::createDeviceCredential()` — creates per-device credentials for mobile
- `DeviceTokenController::store` — stores device SIP credentials

**Gap**: Z360 does not set `expires_at` on credentials, does not implement rotation, and does not clean up orphaned credentials. This should be addressed in the implementation plan.

---

## 4. Z360's Current Approach: Manual N-Leg + Cache-Lock

### 4.1 Architecture

```
Inbound PSTN Call
  → Telnyx webhook (call.initiated)
  → Laravel backend:
      1. Resolve org + receiving user
      2. Collect SIP credentials from user_device_tokens
      3. If 1 device: call.transfer(to: sip:credential@sip.telnyx.com)
      4. If N devices:
         a. Park parent call (don't answer)
         b. Call::create() for each SIP credential (N separate API calls)
         c. Store ring session in cache: simring:{parent_call_control_id}
      5. On call.answered for any leg:
         a. Acquire Redis lock: simring:{parent}:lock
         b. First to lock → answer parent, bridge parent↔leg, hang up others
         c. Send call_ended broadcast + push to non-answered devices
```

### 4.2 Why This Architecture

| Design Choice | Reason |
|---|---|
| Per-device credentials | Multi-tenant org scoping; device-level identity |
| Manual Call::create() per leg | On-demand credentials can't receive inbound; Transfer is single-dest |
| Redis cache lock | Atomic first-answer-wins in distributed environment |
| Parent call parked | Caller hears ringback while legs ring |
| Push + broadcast for cleanup | Dismiss ringing UI on devices that didn't answer |

### 4.3 Assessment

Z360's approach is **architecturally sound and follows Telnyx's recommended pattern** for Call Control apps with on-demand credentials. The manual N-leg creation is not a workaround — it's the standard approach when:
- You need per-device credential isolation
- You need server-side control over routing logic
- You need to integrate with push notification + UI dismissal

---

## 5. Alternative Approaches Evaluated

### 5.1 Telnyx Dial with Array `to` + `bridge_on_answer`

**Concept**: Instead of creating N individual legs, use a single Dial command with multiple SIP URIs in the `to` array, with `link_to` pointing to the parent call.

```php
// Hypothetical: single Dial with array to
$response = Telnyx\Call::dial([
    'connection_id' => config('cpaas.connection_id'),
    'from' => $callerNumber,
    'to' => [
        'sip:gencred-device1@sip.telnyx.com',
        'sip:gencred-device2@sip.telnyx.com',
        'sip:gencred-device3@sip.telnyx.com',
    ],
    'link_to' => $parentCallControlId,
    'bridge_on_answer' => true,
    'client_state' => base64_encode(json_encode(['type' => 'simultaneous_ring_leg'])),
]);
```

**Pros**:
- Single API call instead of N calls (reduced latency)
- Telnyx handles first-answer-wins automatically (cancels unanswered legs)
- `bridge_on_answer` could auto-bridge to parent (eliminates manual bridge step)
- Fewer webhooks to process

**Cons**:
- Returns a **single** `call_control_id` / `call_leg_id` — no per-leg identification
- Cannot control individual legs independently (e.g., hang up specific device)
- Unknown behavior: does `bridge_on_answer` work correctly with multi-`to` + `link_to`?
- **Untested combination** — Telnyx docs don't explicitly document multi-`to` + `link_to` + `bridge_on_answer` together
- Still need manual push + broadcast for UI cleanup (Telnyx only cancels SIP legs, not app UI)
- Parent call still needs to be answered before bridge
- Loss of per-leg webhooks means less visibility into which device answered

**Verdict**: **Potentially viable but risky** — the multi-`to` + `bridge_on_answer` + `link_to` combination is undocumented for this use case. Testing required before adoption.

### 5.2 Telnyx TeXML Approach

**Concept**: Use TeXML (XML-based call scripting) instead of Call Control webhooks:

```xml
<Response>
  <Dial record="record-from-answer-dual" timeout="30">
    <Sip>sip:gencred-device1@sip.telnyx.com</Sip>
    <Sip>sip:gencred-device2@sip.telnyx.com</Sip>
    <Sip>sip:gencred-device3@sip.telnyx.com</Sip>
  </Dial>
  <Redirect>/voicemail</Redirect>
</Response>
```

**Pros**:
- Declarative, simple
- Telnyx handles all ring/bridge/cleanup logic
- Built-in timeout → fallback (voicemail redirect)
- No Redis lock needed

**Cons**:
- **Requires switching from Call Control to TeXML** — fundamentally different architecture
- TeXML is stateless XML scripting; Call Control is stateful webhook-driven
- Z360's entire call handling infrastructure is built on Call Control webhooks
- Less programmatic control over business logic (blocked callers, schedules, etc.)
- Cannot easily integrate push notifications into TeXML flow
- Cannot correlate which device answered
- Migration cost is enormous

**Verdict**: **Not viable** — would require complete rewrite of call handling infrastructure. TeXML is a different paradigm from Call Control.

### 5.3 Shared Credential with SIP Connection Simultaneous Ring

**Concept**: All devices for a user share one credential; enable Telnyx SIP connection simultaneous ring.

**Pros**:
- Zero application-level sim-ring logic
- Telnyx handles everything at SIP level
- No outbound leg creation needed

**Cons**:
- **Shared credential = no per-device identity** (can't tell which device answered)
- **Credential auth limitation**: only one device can be registered at a time with basic credentials ([source](https://support.telnyx.com/en/articles/1130715-register-multiple-devices-on-one-connection))
- **No org-scoping**: shared credential means all devices see all orgs' calls
- Can't implement cross-org switching per device
- No server-side routing logic (blocked callers, schedules, DND)

**Verdict**: **Not viable** — fundamentally incompatible with Z360's multi-tenant, per-device architecture.

### 5.4 Hybrid: N-Leg Creation with `bridge_on_answer`

**Concept**: Keep manual N-leg creation but use `bridge_on_answer` + `link_to` on each leg to auto-bridge.

```php
// For each device credential
Telnyx\Call::dial([
    'connection_id' => config('cpaas.connection_id'),
    'from' => $callerNumber,
    'to' => 'sip:' . $credential->sip_username . '@sip.telnyx.com',
    'link_to' => $parentCallControlId,
    'bridge_on_answer' => true,
    'client_state' => base64_encode(json_encode([
        'type' => 'simultaneous_ring_leg',
        'parent_call_control_id' => $parentCallControlId,
    ])),
]);
```

**Pros**:
- Eliminates manual bridge step (Telnyx auto-bridges on answer)
- Per-device credentials preserved
- Per-leg identification preserved
- Reduces webhook processing (no need to handle bridge manually)

**Cons**:
- **Race condition concern**: if two legs answer near-simultaneously, does `bridge_on_answer` handle mutual exclusion? Or could both legs bridge to parent?
- Still need Redis lock for safety
- Still need manual cleanup of unanswered legs
- Still need push + broadcast for UI dismissal
- Savings are incremental (one fewer API call per answer event)

**Verdict**: **Marginal improvement** — reduces one API call per answer event but doesn't eliminate the core complexity. Risk of undocumented race conditions with multiple `bridge_on_answer` legs pointing to the same `link_to`.

### 5.5 Queue-Based Pattern

**Concept**: Put incoming call in a Telnyx queue; agents/devices pull from queue.

**Pros**:
- Built-in queue management
- Overflow and max-wait-time support

**Cons**:
- Queues are FIFO (first-in-first-out) — designed for call centers, not sim-ring
- Devices must actively "pull" calls (bridge-to-queue), not receive INVITEs
- Completely different UX — no ringing on devices
- Not suitable for real-time sim-ring

**Verdict**: **Not applicable** — wrong pattern for simultaneous ringing.

---

## 6. Competitor Comparison

### 6.1 Twilio

**Approach**: TwiML `<Dial>` verb with multiple nested nouns.

```xml
<Response>
  <Dial timeout="30" callerId="+18005551234">
    <Number>+18005550001</Number>
    <Sip>sip:agent1@example.com</Sip>
    <Client>browser-client</Client>
  </Dial>
</Response>
```

**Key features**:
- Up to **10 simultaneous endpoints** (Number, SIP, Client nouns can mix)
- First answer wins — automatic cancellation of other legs
- `action` callback with `DialCallStatus` for fallback logic
- Built-in `<Queue>` noun for queue-based bridging
- Stateless XML scripting (like Telnyx TeXML)

**Architecture difference**: Twilio's model is **declarative** — you provide TwiML describing what should happen. Telnyx Call Control is **imperative** — you respond to webhooks and issue commands.

**Advantage over Z360**: Simpler to implement basic sim-ring (one XML response vs. N API calls + lock + bridge). But less programmatic control for complex routing.

**Limitation**: Cannot mix Number and SIP nouns in the same Dial (contradicted by some docs — may depend on account type). Max 10 endpoints.

> **Sources**: [Twilio Dial Verb](https://www.twilio.com/docs/voice/twiml/dial), [Twilio Simultaneous Dialing Blog](https://www.twilio.com/en-us/blog/dialing-multiple-numbers-simultaneously-with-twilio-html)

### 6.2 Vonage (Nexmo)

**Approach**: NCCO (Nexmo Call Control Object) `connect` action.

```json
[
  {
    "action": "connect",
    "timeout": 30,
    "from": "+18005551234",
    "endpoint": [
      { "type": "phone", "number": "+18005550001" },
      { "type": "sip", "uri": "sip:agent1@example.com" },
      { "type": "websocket", "uri": "wss://example.com/socket" }
    ]
  }
]
```

**Key features**:
- JSON-based call scripting (easier to generate dynamically than XML)
- Multiple endpoint types: phone, SIP, websocket, app, VBC
- Vonage Business Cloud has built-in sim-ring for up to **5 numbers/extensions**
- Contact center best practices documentation available

**Architecture difference**: Like Twilio, NCCO is declarative scripting. The API handles first-answer-wins and cleanup internally.

> **Source**: [Vonage NCCO Reference](https://developer.vonage.com/en/voice/voice-api/ncco-reference), [Vonage Simultaneous Ring](https://businesssupport.vonage.com/articles/answer/Simultaneous-Ring-24817)

### 6.3 Comparison Matrix

| Feature | Z360 (Telnyx CC) | Telnyx TeXML | Twilio TwiML | Vonage NCCO |
|---|---|---|---|---|
| **Sim-ring method** | Manual N-leg + lock | `<Dial>` multi-noun | `<Dial>` multi-noun | `connect` multi-endpoint |
| **First-answer-wins** | Redis lock (app-level) | Automatic | Automatic | Automatic |
| **Leg cleanup** | Manual hangup + push | Automatic | Automatic | Automatic |
| **Max simultaneous** | Unlimited (N API calls) | Unknown | 10 | 5 (VBC) |
| **Per-leg control** | Full | None | None | None |
| **Per-leg identity** | Yes (per-device cred) | No | No | No |
| **Business logic integration** | Full (webhooks) | Limited (XML) | Limited (XML) | Limited (JSON) |
| **Push notification integration** | Custom (app-level) | Custom (app-level) | Custom (app-level) | Custom (app-level) |
| **Complexity** | High | Low | Low | Low |
| **Flexibility** | Highest | Low | Medium | Medium |

---

## 7. Telnyx FindMe/FollowMe Demo Pattern

Telnyx provides a reference implementation ([demo-findme-ivr](https://github.com/team-telnyx/demo-findme-ivr)) that demonstrates the Call Control approach to call routing:

### Architecture
1. Incoming call → `call.initiated` webhook
2. Park incoming call (don't answer)
3. Create outbound leg with `telnyx.calls.create()` to forwarding number
4. Use `client_state` (base64 JSON) to track call context across webhooks
5. On answer: IVR prompt (press 1 to accept, 2 to reject)
6. On accept: `bridge()` inbound ↔ outbound legs
7. On reject: route to voicemail

### Key Pattern: Client State for Flow Control

The demo uses base64-encoded `client_state` to maintain context across webhook events — exactly the pattern Z360 uses with `simultaneous_ring_leg`, `simultaneous_ring_parent`, etc.

### Difference from Z360
This demo is a **sequential/single-destination** forwarding pattern (FindMe), not simultaneous ring to multiple devices. Z360 extends this pattern to N simultaneous legs with Redis-based coordination.

> **Source**: [Telnyx FindMe IVR Demo](https://github.com/team-telnyx/demo-findme-ivr)

---

## 8. Answers to Research Questions

### Q1: Does Telnyx have built-in simultaneous ring / ring group / fork?

**Yes, but with significant limitations**:
- **SIP Connection simultaneous ring**: Built-in, but requires shared credentials (one username for all devices). Not suitable for per-device credential architectures.
- **Dial API multi-`to`**: Supported, but creates new outbound calls — doesn't route existing inbound calls.
- **TeXML `<Dial>` multi-noun**: Declarative sim-ring with auto first-answer-wins, but requires TeXML architecture (not Call Control).
- **No "ring group" as a first-class API entity**: No dedicated ring group management API. Ring groups must be implemented at the application level.
- **Media forking** (`fork_start`): Streams audio for analysis — completely unrelated to call forking/sim-ring.

### Q2: Can Call Control API `transfer` take multiple destinations?

**No**. The Transfer command's `to` parameter is `string` (single destination). Only the **Dial** command supports `to: string | list<string>`.

### Q3: What's the recommended "first answer wins" pattern?

For **Call Control** webhook-driven apps: **Manual N-leg + application-level lock** (exactly Z360's approach). This is evidenced by:
- Telnyx's own demo-findme-ivr using this pattern (single-leg version)
- Telnyx's call center documentation describing webhook-driven agent routing
- The on-demand credentials documentation explicitly describing this workflow
- No built-in "first answer wins" API for Call Control webhook apps

For **TeXML** apps: Declare multiple nouns in `<Dial>` — Telnyx handles first-answer-wins automatically.

### Q4: Is the manual N-leg + cache-lock approach standard?

**Yes**, it is the standard and recommended approach for:
- Call Control (webhook-driven) applications
- Applications using on-demand credentials
- Applications requiring per-device credential isolation
- Applications needing server-side business logic integration

The cache-lock (Redis) for first-answer-wins is a standard distributed systems pattern.

### Q5: Credential lifecycle best practices — creation, rotation, cleanup?

**Best practices from Telnyx docs**:
1. **Set `expires_at`** on credentials for security (Z360 currently does not)
2. **Use `tag`** for bulk management (e.g., `tag: "org-{org_id}"`)
3. **Filter by status** for cleanup: `filter[status]=expired`
4. **No built-in rotation** — create new → migrate → delete old
5. **No credential limits** per connection or account
6. **JWTs expire after 24 hours** (Z360 uses 10h TTL for web credentials)
7. **Password strength**: 12-16 chars, mixed case, numbers, special chars (auto-generated for on-demand)

**Z360 gaps**:
- No `expires_at` on device credentials
- No periodic cleanup of orphaned/expired credentials
- No credential rotation strategy

### Q6: How do Twilio/Vonage handle this more simply?

Both use **declarative call scripting**:
- **Twilio**: `<Dial>` with up to 10 `<Number>/<SIP>/<Client>` nouns. Platform handles sim-ring + first-answer-wins + cleanup.
- **Vonage**: `connect` action with multiple `endpoint` objects in NCCO JSON. Similar automatic handling.

**Why they're "simpler"**: The sim-ring logic is offloaded to the platform. The app just declares "ring these N endpoints simultaneously."

**Why Z360 can't just adopt this**: Z360's architecture is webhook-driven Call Control (imperative), not scripted (declarative). Switching would require a complete rewrite of call handling. The webhook-driven approach gives Z360 full control over business logic (blocked callers, schedules, org routing, push notifications) that declarative approaches don't provide.

---

## 9. Recommendations

### 9.1 Keep Current Architecture (Recommended)

Z360's manual N-leg + Redis-lock approach is:
- The standard pattern for Telnyx Call Control apps
- Necessary for per-device credential isolation
- Required for integration with push notifications and UI
- Provides maximum flexibility for business logic

**No architectural change recommended.** Focus on hardening the existing approach.

### 9.2 Incremental Improvements

1. **Credential lifecycle**: Add `expires_at` to device credentials, implement periodic cleanup job
2. **Credential tagging**: Use `tag: "org-{org_id}"` for bulk management
3. **Consider `bridge_on_answer`**: Test whether `bridge_on_answer` + `link_to` on individual Dial calls can eliminate the manual bridge step. Verify race condition behavior with multiple legs.
4. **Batch leg creation**: If Telnyx adds batch API support, investigate creating multiple legs in a single HTTP request to reduce latency.
5. **Webhook processing optimization**: Pre-warm Redis connections, use pipeline for lock + cache operations.

### 9.3 Future Considerations

- **Telnyx Ring Group API**: If Telnyx adds a first-class ring group entity to Call Control, evaluate migration
- **WebRTC-only future**: If Z360 moves to pure WebRTC (no SIP credentials), the architecture might be simplified with Telnyx's built-in sim-ring on credential connections
- **Telnyx Flow**: Telnyx is developing visual call flow builders — evaluate if they provide sim-ring primitives with Call Control integration

---

## 10. Source References

### Telnyx Official Documentation
- [Telnyx Dial API](https://developers.telnyx.com/api/call-control/dial-call)
- [Telnyx Simultaneous Ring Release Notes](https://telnyx.com/release-notes/simultaneous-ring-sip-trunking)
- [SIP Connection Inbound Settings](https://support.telnyx.com/en/articles/4404448-sip-connection-inbound-outbound-settings)
- [Telephony Credentials: Types](https://support.telnyx.com/en/articles/7029684-telephony-credentials-types)
- [Telephony Credentials Authentication](https://developers.telnyx.com/docs/voice/webrtc/auth/telephony-credentials)
- [Register Multiple Devices on One Connection](https://support.telnyx.com/en/articles/1130715-register-multiple-devices-on-one-connection)
- [Telnyx Call Center Guide](https://developers.telnyx.com/docs/voice/programmable-voice/call-center)
- [Telnyx TeXML Dial Verb](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/dial)
- [Telnyx FindMe/FollowMe Demo](https://github.com/team-telnyx/demo-findme-ivr)
- [Telnyx Call Center TeXML Demo](https://github.com/team-telnyx/demo-python-telnyx/blob/master/call-center-texml/call_center/infrastructure/TeXML/inbound.xml)

### Telnyx SDK Sources (from packed repos)
- `telnyx-php-sdk.xml` → `src/Calls/CallDialParams.php` — Dial parameters with `to: string|array`
- `telnyx-php-sdk.xml` → `src/Calls/CallDialParams/To.php` — Multi-destination type definition
- `telnyx-php-sdk.xml` → `src/Calls/Actions/ActionTransferParams.php` — Transfer (single `to: string`)
- `telnyx-php-sdk.xml` → `src/Calls/Actions/ActionBridgeParams.php` — Bridge with queue support
- `telnyx-php-sdk.xml` → `src/Calls/Actions/ActionStartForkingParams.php` — Media forking (not call forking)
- `telnyx-php-sdk.xml` → `src/Calls/Actions/ActionEnqueueParams.php` — Queue management
- `telnyx-php-sdk.xml` → `src/TelephonyCredentials/TelephonyCredentialCreateParams.php` — Credential creation
- `telnyx-php-sdk.xml` → `src/TelephonyCredentials/TelephonyCredential.php` — Credential model

### Z360 Codebase
- `temp/Simultaneous-Ringing-Architecture.md` — Current sim-ring architecture doc
- `app/Services/CPaaSService.php` — Credential management
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` — Sim-ring implementation
- `app/Models/UserDeviceToken.php` — Per-device credential storage

### Competitor Documentation
- [Twilio TwiML Dial Verb](https://www.twilio.com/docs/voice/twiml/dial)
- [Twilio Simultaneous Dialing Blog](https://www.twilio.com/en-us/blog/dialing-multiple-numbers-simultaneously-with-twilio-html)
- [Vonage NCCO Reference](https://developer.vonage.com/en/voice/voice-api/ncco-reference)
- [Vonage Simultaneous Ring](https://businesssupport.vonage.com/articles/answer/Simultaneous-Ring-24817)
