---
title: Flows Unified
---

# Z360 Unified Data and Control Flows

This document merges data flow and control flow perspectives into a single coherent view, with sequence diagrams for critical flows, timing dependencies, and race conditions identified.

---

## 1. Critical Flow: Inbound Call (End-to-End)

The most complex flow in the system — involves all layers, all platforms, timing constraints, and race conditions.

### Sequence Diagram

```
PSTN     Telnyx      Z360 Backend       FCM/APNs    Android        iOS          Reverb    Web Browser
Caller   Platform    (Laravel)          (Push)      (Native)       (Native)     (WS)      (React)
  │         │            │                 │           │              │            │           │
  │ dial    │            │                 │           │              │            │           │
  ├────────►│            │                 │           │              │            │           │
  │         │            │                 │           │              │            │           │
  │         │ webhook    │                 │           │              │            │           │
  │         │ call.init  │                 │           │              │            │           │
  │         ├───────────►│                 │           │              │            │           │
  │         │            │                 │           │              │            │           │
  │         │     ┌──────┤                 │           │              │            │           │
  │         │     │ 1. blocked?            │           │              │            │           │
  │         │     │ 2. schedule?           │           │              │            │           │
  │         │     │ 3. find user           │           │              │            │           │
  │         │     │ 4. resolve contact     │           │              │            │           │
  │         │     │    → caller name       │           │              │            │           │
  │         │     │    → avatar URL        │           │              │            │           │
  │         │     │ 5. create Message      │           │              │            │           │
  │         │     └──────┤                 │           │              │            │           │
  │         │            │                 │           │              │            │           │
  │         │            │──── Z360 push ─►│           │              │            │           │
  │         │            │ (caller info)   │──────────►│              │            │           │
  │         │            │                 │───────────────────────►│            │           │
  │         │            │                 │           │              │            │           │
  │         │            │── broadcast ────────────────────────────────────────►│           │
  │         │            │ (IncomingCall)  │           │              │            │──────────►│
  │         │            │                 │           │              │            │           │
  │         │ ◄── SIP legs ──────────────┤           │              │            │           │
  │         │ (per-device credentials)   │           │              │            │           │
  │         │            │                 │           │              │            │           │
  │         │──── Telnyx push ────────────►│           │              │            │           │
  │         │  (call control metadata)     │──────────►│              │            │           │
  │         │                              │───────────────────────►│            │           │
  │         │            │                 │           │              │            │           │
  │  ◄ring──┤   parent   │                 │           │              │            │           │
  │  back   │   PARKED   │                 │    ┌──────┤       ┌──────┤            │           │
  │         │            │                 │    │ Push │       │ Push │            │     DialpadCtx
  │         │            │                 │    │ Sync │       │ Corr │            │     shows
  │         │            │                 │    │500ms │       │500ms │            │     ringing
  │         │            │                 │    └──┬───┤       └──┬───┤            │           │
  │         │            │                 │       │              │                │           │
  │         │            │                 │    ConnSvc        CallKit             │           │
  │         │            │                 │    Incoming       reportIncoming      │           │
  │         │            │                 │    CallAct        Call()              │           │
  │         │            │                 │    shows          (system UI)         │           │
  │         │            │                 │    ringing                            │           │
```

### Timing Dependencies

```
T+0ms      Telnyx webhook arrives at backend
T+5-15ms   Contact resolution + push construction
T+15ms     Z360 push dispatched to FCM/APNs
T+15ms     Reverb broadcast dispatched
T+20ms     SIP legs created to per-device credentials
T+20-25ms  Telnyx SDK push dispatched (by Telnyx platform)
T+100ms    Z360 push received on device (typical)
T+150ms    Telnyx push received on device (typical)
T+100-600ms  Push synchronization window (500ms timeout)
T+200ms    Call UI displayed on device (if both pushes arrive quickly)
T+600ms    Call UI displayed with partial info (if one push times out)

CONSTRAINT (iOS): Must report to CallKit within 5000ms of PushKit delivery
CONSTRAINT (Android): Must avoid ANR — 5000ms for foreground processing
```

### Data Shapes at Each Step

| Step | Data Available | What's Missing |
|------|---------------|----------------|
| Telnyx webhook | `from`, `to`, `call_session_id`, `call_control_id` | Contact identity |
| After contact resolution | + `caller_name`, `avatar_path`, `channel_number` | — |
| Z360 push payload | 12 fields: caller_name, avatar, org context, call IDs | Telnyx call control metadata |
| Telnyx push payload | `metadata` with call_id, caller_number (raw digits) | Caller name, avatar, org context |
| After push sync (merged) | Full: name + avatar + org + call control metadata | — |
| WebSocket broadcast | caller_name, caller_number, org_id, org_name | **No avatar**, **no org_slug** |

**Gap identified**: Web browser receives less data than mobile push (no avatar URL, no org_slug in Reverb broadcast).

---

## 2. Critical Flow: Call Answer with Simultaneous Ring

### Sequence Diagram

```
User     Device       Telnyx SDK     Telnyx        Z360 Backend        Other Devices
(taps)   (native)     (local)        Platform      (Laravel)           (ring stops)
  │         │            │              │               │                    │
  │ answer  │            │              │               │                    │
  ├────────►│            │              │               │                    │
  │         │            │              │               │                    │
  │   double-tap guard   │              │               │                    │
  │   (atomic CAS /      │              │               │                    │
  │    ActionGuard)      │              │               │                    │
  │         │            │              │               │                    │
  │   cross-org check    │              │               │                    │
  │   ├─ YES: API call   │              │               │                    │
  │   │  switch org      │              │               │                    │
  │   │  get new creds   │              │               │                    │
  │   │  SDK reconnect   │              │               │                    │
  │   │  (≤5s on iOS)    │              │               │                    │
  │   │                  │              │               │                    │
  │   stop ringtone      │              │               │                    │
  │   wait 250ms (audio) │              │               │                    │
  │         │            │              │               │                    │
  │         │ answer()   │              │               │                    │
  │         ├───────────►│              │               │                    │
  │         │            │ SIP 200 OK   │               │                    │
  │         │            ├─────────────►│               │                    │
  │         │            │              │               │                    │
  │         │            │              │ call.answered  │                    │
  │         │            │              │ webhook        │                    │
  │         │            │              ├──────────────►│                    │
  │         │            │              │               │                    │
  │         │            │              │        ┌──────┤                    │
  │         │            │              │        │LOCK: simring:{parentId}  │
  │         │            │              │        │      :lock               │
  │         │            │              │        │                          │
  │         │            │              │        │ First answerer?          │
  │         │            │              │        │ ├─ YES:                  │
  │         │            │              │        │ │  answer parent (PARKED)│
  │         │            │              │ ◄──────┤ │  bridge parent↔device  │
  │         │            │              │        │ │  start recording       │
  │         │            │              │        │ │  hangup other legs ────────────────────►│
  │         │            │              │        │ │  broadcast CallEnded   │                │
  │         │            │              │        │ │  push call_ended ──────────────────────►│
  │         │            │              │        │ │                        │   SIP BYE      │
  │         │            │              │────────────────────────────────────────────────────►│
  │         │            │              │        │ │                        │                │
  │         │            │              │        │ ├─ NO (second answerer): │                │
  │         │            │              │        │ │  hangup THIS leg       │                │
  │         │            │              │        │                          │                │
  │         │            │              │        └──────┘                   │                │
  │         │            │              │               │                    │                │
  │    CALL ACTIVE       │              │               │              CALL DISMISSED        │
  │    (audio flowing)   │              │               │              (3 channels)          │
```

### Race Condition: Simultaneous Answer

**Scenario**: Two devices answer at the same time.

```
Device A                Backend                Device B
   │                      │                      │
   │ SIP 200 OK          │                      │ SIP 200 OK
   ├─────────────────────►│◄─────────────────────┤
   │                      │                      │
   │              call.answered (A)               │
   │              call.answered (B)               │
   │                      │                      │
   │              Lock: simring:{parentId}:lock   │
   │              ┌───────┤                      │
   │              │ A acquires lock              │
   │              │ A = first answerer           │
   │              │ → answer parent              │
   │              │ → bridge parent↔A            │
   │              │ → hangup B's SIP leg  ──────────────────►│ (BYE)
   │              │ → broadcast CallEnded ───────────────────►│
   │              │ → push call_ended ──────────────────────►│
   │              └───────┤                      │
   │                      │                      │
   │              ┌───────┤                      │
   │              │ B acquires lock              │
   │              │ B ≠ first (parent bridged)   │
   │              │ → hangup B's leg (already)   │
   │              └───────┤                      │
   │                      │                      │
   │ ACTIVE CALL         │              DISMISSED │
```

**Protection mechanism**: `Cache::lock("simring:{parentId}:lock", 10)` — distributed Redis lock with 10-second TTL. Only the first device to acquire the lock bridges to the parent.

**Three-channel dismissal** ensures other devices stop ringing regardless of which delivery channel arrives first:
1. **SIP BYE**: Backend hangs up other SIP legs → SDK fires `callEnded`
2. **Reverb broadcast**: `CallEndedNotification` with `reason: answered_elsewhere`
3. **Push notification**: `sendCallEndedPush()` → FCM/APNs

---

## 3. Critical Flow: Credential Lifecycle and SDK Connection

### Sequence Diagram

```
App Start        Frontend JS          Backend API          Telnyx API        Native SDK
                     │                     │                    │                │
                     │                     │                    │                │
              registerAndConnect()         │                    │                │
                     │                     │                    │                │
              1. requestVoipPermissions()  │                    │                │
              2. getDeviceId()             │                    │                │
              3. getFcmToken() / PushKit   │                    │                │
                     │                     │                    │                │
              POST /api/device-tokens      │                    │                │
              {device_id, fcm_token,       │                    │                │
               platform}                   │                    │                │
                     ├────────────────────►│                    │                │
                     │                     │                    │                │
                     │              updateOrCreate(DeviceToken)  │                │
                     │              stale cleanup (>7d)          │                │
                     │                     │                    │                │
                     │              createDeviceCredential()    │                │
                     │                     ├───────────────────►│                │
                     │                     │  TelephonyCredential::create()     │
                     │                     │◄── {id, sip_user, sip_pass}       │
                     │                     │                    │                │
                     │              store sip_* in DeviceToken  │                │
                     │              getDeviceJwt() → token()   │                │
                     │                     ├───────────────────►│                │
                     │                     │◄── JWT (30-day)    │                │
                     │                     │                    │                │
                     │◄── {sip_username,   │                    │                │
                     │     sip_password,   │                    │                │
                     │     jwt_token}      │                    │                │
                     │                     │                    │                │
              TelnyxVoip.connect(creds)    │                    │                │
                     ├──────────────────────────────────────────────────────────►│
                     │                     │                    │         credentialLogin()
                     │                     │                    │         WebSocket connect
                     │                     │                    │         SIP REGISTER
                     │                     │                    │◄───────────────┤
                     │                     │                    │                │
                     │                     │                    │  ClientLoggedIn│
                     │◄── 'connected' event ────────────────────────────────────┤
                     │                     │                    │                │
              SDK READY                    │                    │                │
```

### Credential Type Comparison

| Attribute | Org-Level (Web JWT) | Per-Device (Mobile SIP) |
|-----------|-------------------|----------------------|
| **Storage** | `user_telnyx_telephony_credentials` table | `user_device_tokens.sip_*` columns |
| **Scope** | One per user+org | One per device+org |
| **TTL** | JWT: 10 hours | Credential: 30 days |
| **Auth method** | JWT token for WebRTC | SIP username/password |
| **Creation trigger** | Lazy (Inertia prop access) | Explicit (POST /api/device-tokens) |
| **Why separate** | Browser can't do SIP REGISTER | Each device needs unique SIP registration for simultaneous ring |

### Timing Dependency: SDK Must Be Connected Before Call

```
If SDK not connected when Telnyx push arrives:
  Android: PushSynchronizer.ensureTelnyxSdkConnected() →
           telnyxViewModel.credentialLogin() with 8s timeout
  iOS:     Z360VoIPService auto-connects on push if disconnected

If SDK login takes > 5s (iOS constraint):
  → CallKit already reported incoming call (PushKit mandate)
  → User can see call but answer may fail if SDK not ready
  → iOS TelnyxService.answerFromCallKit() retries with delay
```

---

## 4. Critical Flow: Organization Switch

### Sequence Diagram

```
User        WebView JS      Native Layer       Backend API        Telnyx        SDK
  │              │               │                  │                │            │
  │ answer       │               │                  │                │            │
  │ cross-org    │               │                  │                │            │
  │ call         │               │                  │                │            │
  ├─────────────►│               │                  │                │            │
  │              │               │                  │                │            │
  │         detect org mismatch  │                  │                │            │
  │              │               │                  │                │            │
  │              │ Android: OrgSwitchHelper         │                │            │
  │              │ iOS: OrganizationSwitcher        │                │            │
  │              │               │                  │                │            │
  │              │        [iOS only: save original  │                │            │
  │              │         org context for rollback]│                │            │
  │              │               │                  │                │            │
  │              │        POST /api/voip/switch-org │                │            │
  │              │        {target_organization_id}  │                │            │
  │              │               ├─────────────────►│                │            │
  │              │               │                  │                │            │
  │              │               │           switchTo()              │            │
  │              │               │           handleCredentials()    │            │
  │              │               │                  ├───────────────►│            │
  │              │               │                  │◄── creds ─────┤            │
  │              │               │                  │                │            │
  │              │               │◄── {sip_user,    │                │            │
  │              │               │     sip_pass,    │                │            │
  │              │               │     jwt, org_*}  │                │            │
  │              │               │                  │                │            │
  │              │        [Android]:                │                │            │
  │              │        ProfileManager.save()     │                │            │
  │              │        (deferred SDK reconnect)  │                │            │
  │              │               │                  │                │            │
  │              │        [iOS]:                    │                │            │
  │              │        Keychain.save(creds)      │                │            │
  │              │        SDK disconnect ──────────────────────────────────────►│
  │              │        SDK reconnect(new creds) ──────────────────────────►│
  │              │        wait ClientReady (3s) ◄───────────────────────────────┤
  │              │               │                  │                │            │
  │              │        proceed to answer call    │                │            │
  │              │               │                  │                │            │
  │         [iOS failure path]:  │                  │                │            │
  │         restore original org │                  │                │            │
  │         restore original creds                  │                │            │
  │         show error to user   │                  │                │            │
```

### What Resets vs. What Persists

| Component | Org Switch Behavior |
|-----------|-------------------|
| Backend session tenant | **RESETS** — `switchTo()` changes `CurrentTenant` |
| SIP credentials | **RESETS** — new per-org credentials returned |
| Telnyx SDK connection | **iOS: RESETS** (disconnect + reconnect), **Android: DEFERRED** |
| Push token (FCM/APNs) | **PERSISTS** — tokens are per-user, push delivery checks org scope |
| WebView session cookies | **PERSISTS** — Laravel session valid across orgs |
| Device token registration | **PERSISTS** — backend looks up tokens by user_id within org |
| Local org context | **RESETS** — VoipStore/UserDefaults updated |

---

## 5. Push Notification Payload Correlation

### Two-Push Merge Logic

```
              Z360 Push (rich)                    Telnyx Push (control)
              ┌──────────────────┐                ┌──────────────────┐
              │ type:incoming_call│                │ metadata: {      │
              │ caller_name:     │                │   call_id: uuid, │
              │   "Alice Smith"  │                │   caller_number: │
              │ caller_number:   │                │     "8179398981" │
              │   "+18179398981" │                │ }                │
              │ caller_avatar:   │                │                  │
              │   "https://..."  │                │                  │
              │ organization_id: │                │                  │
              │   "1"            │                │                  │
              │ organization_name│                │                  │
              │   "Acme Corp"   │                │                  │
              │ call_session_id: │                │                  │
              │   "uuid-session" │                │                  │
              └────────┬─────────┘                └────────┬─────────┘
                       │                                    │
                       │ normalize("+" strip, last 10)      │ normalize(last 10)
                       │     "8179398981"                   │     "8179398981"
                       │                                    │
                       └────────────┬───────────────────────┘
                                    │ MATCH
                                    ▼
                         ┌─────────────────────┐
                         │   MERGED RESULT:     │
                         │   callerName: "Alice" │
                         │   callerNumber: full  │
                         │   avatarUrl: "https"  │
                         │   orgId: "1"          │
                         │   orgName: "Acme"     │
                         │   callId: telnyx UUID │
                         │   (for SDK answer)    │
                         └─────────────────────┘
```

### Correlation Edge Cases

| Scenario | Result | Risk |
|----------|--------|------|
| Both pushes arrive within 200ms | Perfect merge — full caller info | None |
| Z360 push first, Telnyx 200ms later | Z360 stored, Telnyx merges instantly | None |
| Telnyx push first, Z360 within 500ms | Telnyx waits, Z360 arrives, merge | None |
| Telnyx push first, Z360 after 500ms | Timeout — display number only, no name/avatar | Poor UX, but functional |
| Z360 push arrives, Telnyx never arrives | Z360 stored but never consumed — no call rings | Call lost (SDK push required) |
| Neither push arrives | No ringing on device | Call lost to device (web Reverb may still ring) |
| Phone number format mismatch | Normalization to last 10 digits handles +1, country codes | International numbers with <10 digits could fail |

---

## 6. Timing Constraints Summary

| Constraint | Value | Enforced By | Consequence of Violation |
|------------|-------|-------------|------------------------|
| PushKit → CallKit report | **5 seconds** | Apple (iOS) | App terminated by OS |
| Push sync timeout | **500ms** | PushSynchronizer / PushCorrelator | Display with partial info |
| SDK login timeout | **8 seconds** (Android) | TelnyxVoipPlugin | Connection failure, retry needed |
| SDK reconnect on org switch | **3 seconds** (iOS) | OrganizationSwitcher | Org switch failure, rollback |
| Cross-org switch for answer | **<5 seconds** total (iOS) | CallKit deadline | Answer fails gracefully |
| Audio settle delay | **250ms** (Android) | IncomingCallActivity | Audio artifacts (BUG-003) |
| Simultaneous ring lock | **10 seconds** TTL | Redis distributed lock | Lock expires, second answer may re-bridge |
| SIP ring timeout | **30 seconds** | Telnyx transfer command | No answer → voicemail |
| JWT token validity | **10 hours** (web) | Telnyx credential API | WebRTC auth expires |
| Device credential validity | **30 days** (mobile) | CPaaSService | Credential renewal required |
| Stale device cleanup | **7 days** | DeviceTokenController | Old devices removed |
| APNs expiration | **0** (immediate only) | ApnsVoipService | No store-and-forward |
| FCM TTL | **60 seconds** | PushNotificationService | Push dropped after 60s |

---

## 7. Race Conditions and Synchronization

### 7.1 Double-Tap Prevention (BUG-005)

| Platform | Mechanism | File |
|----------|-----------|------|
| Android | `AtomicBoolean.compareAndSet(false, true)` in `onAnswerCall()` | `IncomingCallActivity.kt` |
| iOS | `ActionGuard` Swift actor — `tryStartAction() → isAllowed` | `ActionGuard.swift` |
| Web | N/A (single answer button, disabled on click) | `context.tsx` |

### 7.2 Active Call Guard (US-014, US-025)

Only one active call allowed at a time. If a second incoming call arrives while one is active:
- **Android**: `PushSynchronizer` checks active call state → shows "busy" notification or rejects
- **iOS**: `ActiveCallGuard` prevents second call → `CallKitManager` rejects with busy reason

### 7.3 SDK Connection Race on Push Wake

When app is killed and push arrives:
- SDK may not be connected yet
- **Android**: `ensureTelnyxSdkConnected()` attempts credential login with 8s timeout
- **iOS**: `Z360VoIPService` deferred connect — must happen before answer

### 7.4 WebView Cookie Staleness

Native API calls use WebView cookies for auth. Risk:
- WebView session expires while native holds old cookies
- **Mitigation**: `AdjustMobileSessionLifetime` middleware extends mobile session TTL
- **iOS**: `OrganizationSwitcher` reads fresh cookies from `WKWebsiteDataStore` on each call

---

## 8. Data-Control Coupling Points

These are places where data availability directly affects control flow decisions:

| Control Decision | Depends On (Data) | Failure If Missing |
|-----------------|-------------------|-------------------|
| Route call to user | `channel.receivingUser` (from authenticated phone config) | → voicemail |
| Display caller name | Contact resolution (`identifier.contact.full_name`) | → show phone number only |
| Choose SIP legs | `UserDeviceToken.sip_username` NOT NULL + active within 1 day | → fewer/no ring targets |
| Cross-org answer | `organization_id` in push payload ≠ current org | → org switch API call required |
| Push channel selection | `UserDeviceToken.platform` ('android' → FCM, 'ios' → APNs) | → wrong push channel |
| Web vs. native VoIP | `Capacitor.isNativePlatform()` detection | → dual SDK connection |
| Merge push data | Normalized phone number match (last 10 digits) | → no merge, partial display |
| Lock winner (simring) | First `call.answered` webhook to acquire Redis lock | → loser device hung up |
| JWT validity | `credential_expires_at` (30-day) or JWT TTL (10h) | → SDK auth failure |

---

## 9. Identified Gaps and Risks

### 9.1 Data Gaps

1. **Web broadcast missing avatar**: `IncomingCallNotification` broadcast does not include `caller_avatar` or `organization_slug` — web gets less display data than mobile push.

2. **Call ended push is NOT org-scoped**: Uses `UserDeviceToken::getFcmTokensForUser()` (all orgs) instead of org-scoped query. This means a call_ended push might dismiss a ringing UI for a different org's call if call_session_ids overlap (unlikely but theoretically possible).

3. **International phone number correlation**: Push correlation uses last 10 digits normalization. International numbers with fewer than 10 digits may fail to correlate, showing raw number instead of contact name.

### 9.2 Timing Risks

1. **iOS 5-second cliff**: If the Z360 backend is slow to process the webhook (heavy DB load, queue congestion), the Z360 push arrives late. Meanwhile, Telnyx push arrives but PushCorrelator times out at 500ms. CallKit is reported with partial info. If the total time exceeds 5s from PushKit delivery, iOS kills the app.

2. **SDK not ready at answer time**: If app was killed and push wakes it, SDK connection (8s timeout) may not complete before user taps answer. Android has a 5-second wait-for-SDK-invite fallback. iOS fulfills CallKit action optimistically.

3. **Org switch + answer timing compound**: Cross-org answer on iOS requires: API call (network latency) + Keychain write + SDK disconnect + SDK reconnect (3s timeout) — all within CallKit's 5-second window.

### 9.3 Synchronization Risks

1. **Distributed lock TTL**: The simring lock has 10-second TTL. If backend processing is slow enough that the lock expires before bridge completes, a second device could attempt to bridge — creating a race on the parent call.

2. **Three-channel dismissal ordering**: SIP BYE, Reverb broadcast, and push notification arrive independently. If SIP BYE arrives before the device has finished rendering the call UI, the UI may flash briefly.

---

## 10. Summary: Critical Path Analysis

The **single most critical path** in the system is the inbound call flow from push receipt to call answer:

```
Push arrives → PushSync (500ms) → CallKit/ConnSvc → User sees call
→ User taps answer → [cross-org switch if needed] → SDK answer → SIP 200 OK
→ Backend lock → Bridge parent → Audio flows → Call active
```

**Total latency budget** (iOS worst case):
- Push delivery: ~100ms
- Push sync: 0-500ms
- CallKit report: <5000ms (hard deadline)
- User decision time: variable
- Cross-org switch: ~2000ms (API + reconnect)
- SDK answer: ~100ms
- Backend bridge: ~200ms

**Weakest links**:
1. Push correlation timing (500ms window)
2. iOS CallKit 5-second mandate
3. Cross-org credential switch during answer
4. Simultaneous ring lock coordination

---

*Synthesized from: data-flows.md and control-flows.md*
*Generated: 2026-02-08*
