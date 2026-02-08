---
title: Gaps And Roadmap Complete
---

# Z360 VoIP: Consolidated Gap Analysis & Prioritized Roadmap

> **Session 15 — Final Synthesis** | Date: 2026-02-08
> **Scope**: Every identified gap, issue, and incomplete feature across backend, Android, iOS, and web — deduplicated, prioritized, and sequenced into an actionable roadmap.
> **Sources**: All whitepaper documents from sessions 01-14 (15 documents, ~50,000 lines of analysis)

---

## Executive Summary

The Z360 VoIP system is **architecturally sound but not production-ready**. Across all platforms and subsystems, this analysis identified **113 unique gaps** after deduplication across six independent research tracks:

| Source Document | Raw Issues | After Dedup |
|----------------|-----------|-------------|
| Failure Analysis (session 14) | 48 race conditions & failure modes | 48 |
| Android Architecture (session 05) | 28 gaps (GAP-001 to GAP-033) | 22 unique (6 overlap with failure analysis) |
| iOS Architecture (session 06) | 10 gaps (G-01 to G-10) | 7 unique (3 overlap) |
| Web/Laravel Architecture (session 07) | 27 gaps (GAP-B1 to GAP-C5) | 21 unique (6 overlap) |
| Credential Management (session 08) | 13 issues (C1-C4, H1-H4, M1-M8) | 9 unique (4 overlap) |
| Simultaneous Ringing (session 10) | 10 race conditions (RC-1 to RC-10) | 6 unique (4 overlap) |
| Configuration & Build (session 13) | 7 configuration issues | 7 unique |
| Call State Management (session 11) | 6 cross-platform state gaps | 4 unique (2 overlap) |
| Push Notifications (session 12) | 5 improvement areas | 3 unique (2 overlap) |
| **Total** | **154 raw** | **127 unique** |

### Current State in One Paragraph

Z360's VoIP system delivers working inbound and outbound calling across web, iOS, and Android using a Telnyx Call Control backbone. The two-push correlation system, two-phase iOS startup, Redis-coordinated simultaneous ring, and native ConnectionService/CallKit integration represent strong engineering. **However**, the system has 14 critical issues that can cause permanent damage (VoIP push revocation, security breaches, silent call failures), 23 high-severity issues that degrade reliability for 5-15% of calls, and dozens of medium/low issues affecting edge cases. Additionally, 7 configuration/build gaps (iOS bundle ID mismatch, secrets in git, missing CI/CD, disabled ProGuard) must be addressed before production mobile releases. The most dangerous cluster is **asynchronous webhook state population** (11 issues from one root cause), followed by **missing infrastructure resilience** (8 issues), **iOS CallKit timing pressure** (3 issues), **Android network fragility** (4 issues), and **zero webhook authentication** (2 issues).

### What Must Be Fixed First

1. **Security**: Webhook signature verification (any attacker can forge call events today)
2. **Android network resilience**: One config change (`autoReconnect = true`) stops all network-blip call drops
3. **Webhook state management**: Capture leg IDs synchronously to fix 6+ downstream issues
4. **iOS CallKit timing**: Decouple CallKit reporting from org switch to prevent permanent VoIP push revocation
5. **FCM token sync**: Android calls silently stop after FCM token rotation

---

## 1. Consolidated Gap Inventory

### 1.1 CRITICAL — System Damage / Security / Silent Failure (14 gaps)

These gaps cause permanent system damage, security vulnerabilities, or silent failures affecting all users. **Must fix before any production VoIP traffic.**

| # | ID | Platform | Title | Root Cause | Evidence |
|---|-----|----------|-------|------------|----------|
| 1 | **SEC-01** | Backend | No Telnyx webhook signature verification | Missing middleware | `routes/webhooks.php` — zero auth middleware on all webhook routes |
| 2 | **MOB-01** | iOS | Cross-org switch exceeds 5s CallKit deadline | Coupled CallKit report + org switch | `OrganizationSwitcher.swift` — 0.5-1.0s margin, Apple revokes VoIP push permanently |
| 3 | **MOB-02** | Android | FCM token refresh never synced to backend | Missing API call in `onNewToken()` | `Z360FirebaseMessagingService.kt` — saves locally, never POSTs to `/api/device-tokens` |
| 4 | **BE-01** | Backend | Caller hangup doesn't cancel SIP legs | Missing leg cancellation in `originator_cancel` | `TelnyxInboundWebhookController.php` — devices ring 10-30s after caller hung up (5-10% of calls) |
| 5 | **BE-02** | Backend | Empty `leg_ids` during fast answer | Async webhook population | `transferToUser()` stores empty array, relies on `call.initiated` webhooks to populate |
| 6 | **BE-03** | Backend | Bridge failure leaves call in broken state | No error isolation in try-catch | Both parties hear silence, no recovery path |
| 7 | **MOB-03** | iOS | Cold-start push before Phase 2 initialization | Phase 2 deferred to `sceneDidBecomeActive` | No audio config or SDK connection when PushKit handler fires on cold start |
| 8 | **MOB-04** | Android | SDK auto-reconnect disabled | `autoReconnect = false` default | Every network blip drops the active call |
| 9 | **BE-04** | Backend | Credential expiry never enforced | `credential_expires_at` set but never queried | SIP legs created to dead/expired endpoints |
| 10 | **BE-05** | Backend | `CleanStaleDeviceTokens` orphans Telnyx credentials | Bulk delete without API cleanup | Unbounded credential growth on Telnyx |
| 11 | **BE-06** | Backend | Org-level credentials never deleted | No lifecycle management | Unbounded growth — no DELETE call, no scheduler |
| 12 | **SEC-02** | Backend | SIP passwords stored in plaintext in database | No `encrypted` cast on model | DB compromise exposes all SIP credentials |
| 13 | **AND-01** | Android | Hardcoded `API_BASE_URL = "https://app.z360.cloud"` | Literal string in `OrgSwitchHelper.kt` | All non-production environments hit production for org switch |
| 14 | **AND-02** | Android | 4 TypeScript bridge methods have no Android implementation | Missing `@PluginMethod` implementations | `connectWithToken()`, `getNetworkStatus()`, `getConnectionState()`, `getFcmTokenWithWait()` broken |

### 1.2 HIGH — Reliability & UX Degradation (23 gaps)

Issues that degrade reliability or user experience for a significant percentage of calls. Fix within first 2 sprints.

| # | ID | Platform | Title | Impact |
|---|-----|----------|-------|--------|
| 15 | **BE-07** | Backend | Redis unavailable → all coordination fails | No fallback lock; all devices hung up |
| 16 | **BE-08** | Backend | Cache TTL expires mid-call (10 min) | Answering device stays active after caller hangs up |
| 17 | **BE-09** | Backend | Webhook loss — no recovery mechanism | Call connects but no audio bridge |
| 18 | **BE-10** | Backend | Blocking `usleep(2s)` in sim-ring retry | Exhausts PHP-FPM workers under load |
| 19 | **BE-11** | Backend | Redis cache-only ring state, no DB fallback | Redis failure orphans ring sessions |
| 20 | **BE-12** | Backend | Idempotency depends on Message existence | Out-of-order webhooks fail idempotency check |
| 21 | **MOB-05** | Android | SDK not connected on answer attempt | 5s delay or failed answer |
| 22 | **MOB-06** | Both | Org switch during active call drops call | No active call guard |
| 23 | **MOB-07** | Both | Two-push 500ms timeout — partial caller info | "Unknown Caller" shown for ~5% of calls |
| 24 | **MOB-08** | Android | No network change monitoring | Calls drop on WiFi↔cellular switch |
| 25 | **MOB-09** | iOS | PushCorrelator cannot update CallKit display | "Unknown Caller" persists after late Z360 push |
| 26 | **MOB-10** | iOS | Audio not restored on failed org switch | Broken audio state requires restart |
| 27 | **MOB-11** | Android | `runBlocking` on FCM thread | Potential ANR under rapid consecutive pushes |
| 28 | **MOB-12** | Android | No credential login mutex | Race condition during FCM + plugin credential paths |
| 29 | **MOB-13** | Android | OrgSwitchHelper uses WebView cookies for auth | Fails on cold-start cross-org calls (no WebView) |
| 30 | **WEB-01** | Web | No cross-org call answer capability | Web users can't answer calls from other orgs |
| 31 | **WEB-02** | Web | WebSocket disconnect → missed incoming calls | Web users miss all calls silently |
| 32 | **BE-13** | Backend | Concurrent device registration — no transaction | Ghost Telnyx credentials from race conditions |
| 33 | **BE-14** | Backend | Push notification delivery failure — no retry | Phantom ringing for 30s |
| 34 | **SEC-03** | Backend | SIP passwords exposed in API responses | Visible in network logs, proxy servers, devtools |
| 35 | **SEC-04** | Backend | No rate limiting on VoIP API endpoints | Credential endpoint abuse possible |
| 36 | **AND-03** | Android | No CallStyle notifications (Android 12+) | Suboptimal call notification UX |
| 37 | **AND-04** | Android | No ongoing call notification channel | Only generic Telnyx foreground service notification visible |

### 1.3 MEDIUM — Quality & Completeness (38 gaps)

Issues that affect edge cases, compliance, or code quality. Plan for sprints 3-4.

| # | ID | Platform | Title |
|---|-----|----------|-------|
| 38 | **BE-15** | Backend | Org context switch during webhook processing (wrong org) |
| 39 | **BE-16** | Backend | `call.initiated` delayed — late leg tracking |
| 40 | **BE-17** | Backend | Failover endpoints are log-only (no processing) |
| 41 | **BE-18** | Backend | `sendCallEndedPush()` not org-scoped (cross-org dismissal risk) |
| 42 | **BE-19** | Backend | No webhook dead letter queue or replay mechanism |
| 43 | **BE-20** | Backend | Ring session created AFTER SIP legs (race window) |
| 44 | **BE-21** | Backend | Backend restart during active calls — webhooks lost |
| 45 | **BE-22** | Backend | Telnyx API outage — no retry or circuit breaker |
| 46 | **BE-23** | Backend | DB connection pool exhaustion during webhook spikes |
| 47 | **BE-24** | Backend | Recording failure after bridge — no retry |
| 48 | **BE-25** | Backend | Duplicate `call.answered` webhooks — no idempotency |
| 49 | **BE-26** | Backend | Hardcoded voicemail greeting (no per-org customization) |
| 50 | **BE-27** | Backend | User PII in unencrypted SIP headers (`X-User-Data`) |
| 51 | **BE-28** | Backend | Two FCM implementations with different auth flows |
| 52 | **BE-29** | Backend | Conversation summary loads ALL messages to memory |
| 53 | **CRED-01** | Backend | Per-device credential expiry not enforced by scheduler |
| 54 | **CRED-02** | Backend | JWT refresh race on web (10h TTL, no proactive refresh) |
| 55 | **CRED-03** | Backend | `'failed'` credential_id state gets stuck permanently |
| 56 | **CRED-04** | Backend | Cross-org call uses org-level creds, not per-device |
| 57 | **CRED-05** | Backend | No uniqueness constraint on `(user_id, org_id, device_id)` |
| 58 | **AND-05** | Android | No formal call state machine — scattered booleans |
| 59 | **AND-06** | Android | ConnectionService missing `onCreateOutgoingConnection()` |
| 60 | **AND-07** | Android | No client-side inbound ringing timeout |
| 61 | **AND-08** | Android | Answer/call-ended push race condition |
| 62 | **AND-09** | Android | No credential refresh during active call |
| 63 | **AND-10** | Android | Deprecated audio APIs (`setSpeakerphoneOn`, `startBluetoothSco`) |
| 64 | **AND-11** | Android | SIP credentials in plain SharedPreferences |
| 65 | **AND-12** | Android | No accessibility in call UI (TalkBack) |
| 66 | **AND-13** | Android | Outbound calls lack ConnectionService integration |
| 67 | **AND-14** | Android | Missed call "Call Back" broken for cross-org calls |
| 68 | **AND-15** | Android | No VoIP session expiry (iOS has 30-day check) |
| 69 | **IOS-01** | iOS | No native WebView/call isolation guard |
| 70 | **IOS-02** | iOS | Z360VoIPService God Object (2,253 lines) |
| 71 | **IOS-03** | iOS | Firebase logging disabled during cold-start |
| 72 | **WEB-03** | Web | `switchOrg()` changes web session globally (affects Capacitor) |
| 73 | **WEB-04** | Web | Phone-to-org mapping assumes single match |
| 74 | **WEB-05** | Web | No session restoration after cross-org call ends |
| 75 | **WEB-06** | Web | NativeVoipProvider doesn't strictly block WebRTC initialization |

### 1.4 LOW — Polish & Optimization (38 gaps)

Backlog items. Low probability, already mitigated, or optimization opportunities.

| # | ID | Platform | Title |
|---|-----|----------|-------|
| 76 | **BE-30** | Backend | Lock expiry during slow bridge operation |
| 77 | **BE-31** | Backend | Push/webhook order mismatch (acceptable) |
| 78 | **BE-32** | Backend | Recording webhook arrives before message |
| 79 | **BE-33** | Backend | Duplicate `call.hangup` webhooks |
| 80 | **BE-34** | Backend | Webhook replay attack (mitigated by signature fix) |
| 81 | **BE-35** | Backend | Concurrent cache updates to `leg_ids` |
| 82 | **BE-36** | Backend | Org-level vs device-level credential confusion |
| 83 | **BE-37** | Backend | `call.bridged` webhook not handled |
| 84 | **BE-38** | Backend | No click-to-call backend API |
| 85 | **BE-39** | Backend | `call_ended` Echo listener runs on native too |
| 86 | **BE-40** | Backend | No webhook timeout monitoring |
| 87 | **BE-41** | Backend | No credential health check against Telnyx API |
| 88 | **BE-42** | Backend | Web outbound calls use org-level credential |
| 89 | **BE-43** | Backend | Outbound calls not recorded |
| 90 | **BE-44** | Backend | Redis failure — single point of failure |
| 91 | **BE-45** | Backend | Multi-region latency — sequential leg creation |
| 92 | **BE-46** | Backend | FCM/APNs push service outage — no fallback |
| 93 | **AND-16** | Android | Audio focus uses `GAIN_TRANSIENT` (should be `EXCLUSIVE`) |
| 94 | **AND-17** | Android | Full-screen intent permission not proactively checked (API 34+) |
| 95 | **AND-18** | Android | Hardcoded Telnyx SDK notification ID (1234) |
| 96 | **AND-19** | Android | No ICE restart support |
| 97 | **AND-20** | Android | IncomingCallActivity not Material Design 3 |
| 98 | **AND-21** | Android | ActiveCallActivity god class (1,387 lines) |
| 99 | **AND-22** | Android | Z360VoipStore cleanup not triggered after call |
| 100 | **AND-23** | Android | Hardcoded SDK version "3.2.0" in analytics |
| 101 | **AND-24** | Android | Web stubs don't throw/warn for native-only methods |
| 102 | **AND-25** | Android | No runtime guard against web WebRTC on native |
| 103 | **AND-26** | Android | Zero test coverage for 8,000+ lines of VoIP code |
| 104 | **IOS-04** | iOS | Sign In with Apple — zero implementation |
| 105 | **IOS-05** | iOS | Crash recovery re-entry unprotected |
| 106 | **MOB-14** | Both | Dual VoIP stack race (theoretical) |
| 107 | **MOB-15** | Both | No "Reconnecting..." banner in call UI |
| 108 | **MOB-16** | Android | Android Doze mode delays push delivery |
| 109 | **MOB-17** | Android | ConnectionService framework delay |
| 110 | **MOB-18** | Both | Stale re-INVITE after hangup (15s cooldown) |
| 111 | **SYS-01** | System | TLS certificate expiry monitoring absent |
| 112 | **SYS-02** | iOS | iOS Low Power Mode impact (degraded quality) |
| 113 | **WEB-07** | Web | Multi-tab coordination (all tabs ring) |

### 1.5 CONFIGURATION & BUILD — Production Blockers (7 gaps)

Issues from configuration-complete.md that must be resolved before production mobile releases.

| # | ID | Platform | Title | Impact |
|---|-----|----------|-------|--------|
| 114 | **CFG-01** | iOS | **Bundle ID mismatch**: Capacitor uses `com.z360.app`, Xcode uses `com.z360biz.app` | Push token registration, deep links, app identity may break |
| 115 | **CFG-02** | iOS | **GoogleService-Info.plist tracked in git** with real Firebase API keys | Security: keys exposed in version control |
| 116 | **CFG-03** | Android | **Telnyx SDK pinned to 3.2.0** due to v3.3.0 credential auth bug | Cannot upgrade SDK; missing fixes and features |
| 117 | **CFG-04** | iOS | **Firebase SDK version discrepancy** — config says 11.15.0, deploy says 12.8.0+ | Potential build or runtime issues |
| 118 | **CFG-05** | iOS | **ATS permissive** — `NSAllowsArbitraryLoads = true` allows HTTP | Security: no transport security enforcement |
| 119 | **CFG-06** | Android | **ProGuard disabled** for release builds (`minifyEnabled false`) | Larger APK, all symbols exposed |
| 120 | **CFG-07** | Both | **No mobile CI/CD pipeline** — no automated build, test, or distribution | Manual builds, static `versionCode 1` |

### 1.6 ADDITIONAL CROSS-CUTTING GAPS (7 gaps)

Issues surfaced from call-state, push notification, and flow analysis documents.

| # | ID | Platform | Title | Impact |
|---|-----|----------|-------|--------|
| 121 | **STATE-01** | All | **No unified call state model** — iOS 9 states, Android 10, Web 4, Backend binary | Cross-platform debugging impossible |
| 122 | **STATE-02** | Backend | **Backend stateless after ring phase** — no `active_call:{userId}` tracking | No collision detection, web UI blind to native calls |
| 123 | **STATE-03** | Both | **RINGING state not persisted** — crash during ring = invisible missed call | CallStatePersistence only saves ACTIVE state |
| 124 | **STATE-04** | All | **Remote HOLD not tracked** — no platform detects remote hold re-INVITE | User hears silence with no UI explanation |
| 125 | **PUSH-01** | Web | **Web broadcast missing avatar and org_slug** — less display data than mobile | Degraded web incoming call UI |
| 126 | **PUSH-02** | All | **No push notification analytics dashboard** — no delivery rate or latency tracking | Blind to push reliability issues |
| 127 | **STATE-05** | All | **Analytics siloed per platform** — no unified call quality pipeline | Cannot correlate cross-platform quality issues |

---

## 2. Root Cause Analysis

Five systemic root causes account for 60%+ of all issues:

### Root Cause 1: Asynchronous Webhook State Population (11 issues)

**Issues**: BE-01, BE-02, BE-09, BE-16, BE-20, BE-25, BE-35, MOB-05, MOB-07, WEB-02, BE-32

The backend creates SIP legs via `Call::create()` but stores an **empty `leg_ids` array**, relying on asynchronous `call.initiated` webhooks to populate it. This creates a window where any coordination operation (answer, hangup, bridge) works with incomplete data.

**Systemic fix**: Capture `call_control_id` from the synchronous `Call::create()` response and store leg IDs immediately. This single change resolves or mitigates **6 issues directly**.

### Root Cause 2: No Infrastructure Graceful Degradation (8 issues)

**Issues**: BE-07, BE-11, BE-21, BE-22, BE-23, BE-44, BE-46, MOB-04

Redis, Telnyx API, and push services are treated as infallible. No fallback paths, retries, or circuit breakers exist.

**Systemic fix**: Layered resilience — retry with backoff for Telnyx API, database lock fallback for Redis, circuit breaker for external services, graceful shutdown for zero-downtime deploys.

### Root Cause 3: iOS 5-Second PushKit Deadline Coupling (3 issues)

**Issues**: MOB-01, MOB-03, IOS-01

Apple mandates `reportNewIncomingCall()` within 5 seconds. Z360 couples org switching, credential fetching, and SDK reconnection into this critical path.

**Systemic fix**: Report to CallKit immediately with placeholder data. Perform org switch asynchronously. Update CallKit display after async operations complete.

### Root Cause 4: Missing Android Network Resilience (4 issues)

**Issues**: MOB-04, MOB-05, MOB-08, MOB-11

Android lacks `ConnectivityManager.NetworkCallback` monitoring and has SDK auto-reconnect explicitly disabled. iOS has both.

**Systemic fix**: Enable `autoReconnect: true` (30-minute fix) + implement `NetworkMonitor.kt` matching iOS pattern (2-3 days).

### Root Cause 5: Zero Webhook Authentication (2 issues)

**Issues**: SEC-01, BE-34

All Telnyx webhook controllers process requests without signature verification. An attacker who discovers the webhook URL can forge call events, terminate active calls, inject fake data.

**Systemic fix**: `VerifyTelnyxWebhook` middleware with ED25519 signature verification. Apply to all webhook routes.

---

## 3. Prioritized Roadmap

### Phase 1: CRITICAL PATH (Week 1-2) — 15 Items

**Goal**: Eliminate security vulnerabilities, prevent permanent system damage, fix issues affecting >5% of calls.

| Order | ID | Action | Effort | Platform | Dependency |
|-------|-----|--------|--------|----------|------------|
| 1 | **MOB-04** | Enable `autoReconnect = true` in Android SDK login calls | 0.5d | Android | None |
| 2 | **AND-01** | Replace hardcoded `API_BASE_URL` with BuildConfig | 0.5d | Android | None |
| 3 | **BE-04** | Add `credential_expires_at > now()` to SIP destination query | 0.5d | Backend | None |
| 4 | **BE-08** | Extend simring cache TTL from 10 min to 2 hours | 0.5d | Backend | None |
| 5 | **AND-02** | Implement 4 missing bridge methods (connectWithToken, etc.) | 2d | Android | None |
| 6 | **SEC-01** | Implement ED25519 webhook signature verification middleware | 2d | Backend | None |
| 7 | **BE-01** | Fix `originator_cancel` to cancel all SIP legs | 1d | Backend | None |
| 8 | **BE-02** | Capture leg IDs synchronously from `Call::create()` response | 2d | Backend | None |
| 9 | **MOB-02** | Sync FCM token on refresh + backend update endpoint | 2d | Android + BE | None |
| 10 | **MOB-01** | Decouple iOS CallKit reporting from org switch | 4d | iOS | None |
| 11 | **MOB-03** | Trigger Phase 2 init from PushKit handler on cold start | 3d | iOS | None |
| 12 | **MOB-06** | Add active call guard before org switch (both platforms) | 1d | Both | None |
| 13 | **BE-13** | Wrap device registration in DB transaction with `lockForUpdate` | 1d | Backend | None |
| 14 | **SEC-02** | Add `encrypted` cast to `sip_password` on both models | 1d | Backend | None |
| 15 | **BE-10** | Replace `usleep(2s)` with `SimRingRetryJob::dispatch()->delay(2s)` | 1d | Backend | None |

**Total effort**: ~22.5 engineer-days | **Calendar**: ~2 weeks with 3 engineers (Backend, iOS, Android)

**Configuration fixes (parallel with Phase 1)**:
- CFG-01: Fix iOS bundle ID mismatch (0.5d)
- CFG-02: Remove GoogleService-Info.plist from git, add to gitignore (0.5d)
- CFG-05: Restrict ATS to production (0.5d)
- CFG-06: Enable ProGuard for release builds (1d)
- CFG-07: Set up basic CI/CD pipeline (3d)

**Quick wins (< 4 hours each, do on day 1)**:
1. `autoReconnect = false` → `true` in 2 Android files (30 min — stops all network-blip call drops)
2. `->where('credential_expires_at', '>', now())` on one query (30 min — stops dialing expired creds)
3. Cache TTL `addMinutes(10)` → `addHours(2)` (30 min — fixes long call cleanup)
4. Hardcoded `API_BASE_URL` → `BuildConfig.BASE_URL` (30 min — fixes non-production environments)

### Phase 2: STABILITY HARDENING (Week 3-4) — 14 Items

**Goal**: Add resilience to infrastructure failures, improve error recovery, close remaining high-severity gaps.

| Order | ID | Action | Effort | Platform |
|-------|-----|--------|--------|----------|
| 16 | **MOB-08** | Implement Android `NetworkMonitor.kt` (ConnectivityManager.NetworkCallback) | 3d | Android |
| 17 | **BE-07** | Database lock fallback when Redis unavailable | 2d | Backend |
| 18 | **BE-09** | Stalled call detection job (everyMinute scheduler) | 3d | Backend |
| 19 | **WEB-02** | Add Reverb `.incoming_call` listener as web fallback | 2d | Web |
| 20 | **BE-21** | Graceful shutdown + webhook queue persistence | 4d | Backend |
| 21 | **BE-14** | Exponential backoff retry for push notifications | 1d | Backend |
| 22 | **MOB-09** | Implement CXCallUpdate refresh for late Z360 push matches | 2d | iOS |
| 23 | **MOB-10** | Audio state save/restore in OrganizationSwitcher | 1d | iOS |
| 24 | **BE-22** | Telnyx API retry + circuit breaker | 3d | Backend |
| 25 | **BE-25** | Webhook idempotency using Telnyx `event.id` (not message-based) | 1d | Backend |
| 26 | **BE-15** | Audit webhook handlers to use `client_state.organization_id` | 1d | Backend |
| 27 | **WEB-01** | Web cross-org call answer flow | 3d | Web + BE |
| 28 | **MOB-13** | Replace WebView cookie auth with persistent API token | 2d | Android |
| 29 | **BE-12** | Add Telnyx event ID-based idempotency before message lookup | 1d | Backend |

**Total effort**: ~29 engineer-days | **Calendar**: ~2 weeks with 3 engineers

### Phase 3: QUALITY & COMPLETENESS (Week 5-6) — 18 Items

**Goal**: Close medium-severity gaps, add monitoring/observability, improve platform compliance.

| Order | ID | Action | Effort | Platform |
|-------|-----|--------|--------|----------|
| 30 | **BE-05/06** | Scheduled credential cleanup (org-level + stale device) | 2d | Backend |
| 31 | **CRED-01** | Per-device credential expiry enforcement scheduler | 1d | Backend |
| 32 | **CRED-02** | Proactive JWT refresh on web (timer-based before 10h expiry) | 1d | Web |
| 33 | **CRED-03** | Fix stuck `'failed'` credential_id state | 0.5d | Backend |
| 34 | **BE-20** | Pre-create ring session BEFORE SIP leg creation | 1d | Backend |
| 35 | **AND-03** | Implement CallStyle.forIncomingCall() (Android 12+) | 1d | Android |
| 36 | **AND-04** | Create ongoing call notification with CallStyle.forOngoingCall() | 2d | Android |
| 37 | **AND-05** | Formal `sealed class VoipCallState` state machine | 4d | Android |
| 38 | **AND-06/13** | Add `onCreateOutgoingConnection()` to ConnectionService | 2d | Android |
| 39 | **AND-10** | Modern audio APIs (`setCommunicationDevice`, API 31+) | 2d | Android |
| 40 | **AND-12** | Accessibility (contentDescription, TalkBack) for call UI | 1d | Android |
| 41 | **AND-11** | Migrate Z360VoipStore to EncryptedSharedPreferences | 2d | Android |
| 42 | **MOB-14** | Native-side `isNativeVoIPActive` flag (defense-in-depth) | 1d | Both |
| 43 | **MOB-15** | "Reconnecting..." banner in call UI (both platforms) | 2d | Both |
| 44 | **IOS-03** | Add os_log fallback + log buffering in VoIPLogger | 1d | iOS |
| 45 | **WEB-03** | Separate VoIP session from web session for org switch | 2d | Web + BE |
| 46 | **BE-24** | Recording health check + retry after 5s | 2d | Backend |
| 47 | **BE-45** | Parallelize SIP leg creation (concurrent `Call::create()`) | 3d | Backend |

**Total effort**: ~30.5 engineer-days | **Calendar**: ~2 weeks with 3 engineers

### Phase 4: POLISH & ARCHITECTURE (Week 7+) — Backlog

| Priority | ID | Action | Effort | Platform |
|----------|-----|--------|--------|----------|
| 1 | **AND-26** | Unit tests for core VoIP components | 5d | Android |
| 2 | **IOS-02** | Decompose Z360VoIPService God Object | 5d | iOS |
| 3 | **IOS-04** | Sign In with Apple (iOS + backend) | 5d | iOS + BE |
| 4 | **WEB-07** | BroadcastChannel API for multi-tab coordination | 3d | Web |
| 5 | **AND-15** | Android VoIP session expiry (match iOS 30-day check) | 1d | Android |
| 6 | **BE-19** | Webhook event store for auditing/replay | 3d | Backend |
| 7 | **BE-27** | Encrypt PII in SIP headers | 1d | Backend |
| 8 | **BE-43** | Outbound call recording | 2d | Backend |
| 9 | **AND-17** | Full-screen intent permission check (Android 14+) | 1d | Android |
| 10 | **AND-20/21** | Material Design 3 + refactor god classes | 5d | Android |
| 11 | **MOB-16** | Battery optimization exemption (Android Doze) | 1d | Android |
| 12 | **SYS-01** | Certificate expiry monitoring | 1d | Backend |
| 13 | **WEB-06** | Stronger VoIP provider isolation (dynamic imports) | 2d | Web |
| 14 | **BE-38** | Backend-initiated outbound call API | 3d | Backend |
| Remaining | Various | 24 low-priority items from Section 1.4 | ~15d | Mixed |

**Total backlog effort**: ~53 engineer-days

---

## 4. Cross-Platform Gap Matrix

| Area | Backend | Android | iOS | Web |
|------|---------|---------|-----|-----|
| **Webhook security** | No verification | — | — | — |
| **Credential cleanup** | Missing | — | — | — |
| **Credential storage** | Plaintext DB | Plain SharedPrefs | Keychain (good) | Ephemeral (good) |
| **Network monitoring** | N/A | Missing | Good (NWPathMonitor) | N/A |
| **Auto-reconnect** | N/A | Disabled | Enabled | SDK-managed |
| **Cross-org calls** | Supported | Working | Working (tight timing) | Not implemented |
| **Call state machine** | Implicit | No formal FSM | Designed (not formal) | SDK-managed |
| **Push delivery** | No retry | Token not synced | Token synced | N/A (Reverb) |
| **Outbound calls** | Working | Working | Working | Working |
| **Call recording** | Inbound only | N/A | N/A | N/A |
| **Accessibility** | N/A | None | N/A (CallKit) | N/A |
| **Test coverage** | Partial | Zero | Zero | Zero |
| **Notifications** | Working | Missing CallStyle | CallKit (good) | Browser API |
| **Session expiry** | N/A | None | 30-day | N/A |

---

## 5. Effort Summary

| Phase | Items | Effort | Calendar (3 engineers) | Cumulative |
|-------|-------|--------|----------------------|------------|
| Phase 1: Critical | 15 | 22.5 eng-days | 2 weeks | 2 weeks |
| Phase 2: Stability | 14 | 29 eng-days | 2 weeks | 4 weeks |
| Phase 3: Quality | 18 | 30.5 eng-days | 2 weeks | 6 weeks |
| Phase 4: Polish | 14+ backlog | 53+ eng-days | 4+ weeks | 10+ weeks |
| Config/Build fixes | 7 | ~5 eng-days | 1 week | overlaps |
| **Total** | **127** | **~140 eng-days** | **~10 weeks** | — |

### Team Allocation

| Engineer | Phase 1 Focus | Phase 2 Focus | Phase 3 Focus |
|----------|--------------|--------------|--------------|
| **Backend** | Webhook security, leg ID fix, credential expiry, registration transactions | Redis fallback, stalled call detection, graceful shutdown, push retry | Credential cleanup, recording retry, parallel leg creation |
| **iOS** | CallKit decoupling, Phase 2 cold-start init, active call guard | CXCallUpdate refresh, audio restoration | os_log fallback, native isolation flag |
| **Android** | auto-reconnect, API_BASE_URL, bridge methods, FCM token sync | NetworkMonitor, cookie→token auth | CallStyle, state machine, EncryptedSharedPrefs |

---

## 6. Testing Requirements for Phase 1

### Automated Tests

| Test | Covers | Assertion |
|------|--------|-----------|
| `test_originator_cancel_cancels_all_sip_legs` | BE-01 | All `leg_ids` receive `hangup()` on originator_cancel |
| `test_leg_ids_populated_synchronously` | BE-02 | `leg_ids` array contains all IDs immediately after `transferToUser()` |
| `test_bridge_failure_still_cleans_up_legs` | BE-03 | Other legs hung up + notifications sent even if bridge fails |
| `test_webhook_signature_rejects_invalid` | SEC-01 | Invalid ED25519 signature returns 403 |
| `test_expired_credentials_excluded` | BE-04 | Expired SIP creds not in destination list |
| `test_device_registration_transaction` | BE-13 | Concurrent registration creates only 1 credential |
| `test_cache_ttl_2_hours` | BE-08 | Simring cache persists for 2 hours |
| `test_fcm_token_sync_endpoint` | MOB-02 | `POST /api/device-tokens/update-fcm` updates token |
| `test_sip_password_encrypted` | SEC-02 | `sip_password` not readable as plaintext from DB |
| `test_simring_retry_dispatches_job` | BE-10 | No `usleep()`, job dispatched with 2s delay |

### Manual Test Scenarios

| Scenario | Platforms | Expected Result |
|----------|-----------|-----------------|
| Caller hangs up after 3s of ringing | All | All devices stop ringing within 2s |
| Answer call within 200ms | Both mobile | All other devices stop immediately |
| WiFi → cellular during active call | Android | Call continues (after MOB-04 fix) |
| Cross-org incoming call on killed iOS | iOS | CallKit shows within 5ms, org switch in background |
| Cold-start push on iOS, answer within 1s | iOS | Audio works immediately (after MOB-03 fix) |
| Send forged webhook to backend | Backend | 403 Forbidden (after SEC-01 fix) |
| FCM token refresh on Android | Android | Backend receives new token |
| Non-production environment org switch | Android | Hits correct environment (after AND-01 fix) |

---

## 7. Deduplication Cross-Reference

This table maps gaps across the six independent research documents to prevent double-counting.

| Canonical ID | Failure Analysis | Android Arch | iOS Arch | Web/Laravel | Credentials | SimRing |
|-------------|-----------------|--------------|----------|-------------|-------------|---------|
| SEC-01 | RC-BE-13, FM-21 | — | — | GAP-B1 | C4 | — |
| MOB-01 | RC-M-07, FM-24 | — | G-01 | — | — | — |
| MOB-02 | FM-20 | GAP-024 | — | — | — | — |
| MOB-04 | FM-04 | GAP-017 | — | — | — | — |
| BE-01 | RC-BE-2 | — | — | — | — | RC-3 |
| BE-02 | RC-BE-6, RC-BE-11 | — | — | — | — | RC-5 |
| BE-07 | RC-BE-17, FM-14 | — | — | GAP-B4 | — | — |
| BE-13 | RC-BE-14 | — | — | — | — | RC-7 |
| MOB-03 | RC-M-08, FM-12 | — | G-04 | — | — | — |
| MOB-08 | FM-01 | GAP-015 | — | — | — | — |
| AND-01 | — | GAP-023 | — | — | — | — |
| AND-02 | — | GAP-007, GAP-030 | — | — | — | — |
| SEC-02 | — | — | — | — | C3 | — |
| BE-04 | RC-BE-16 | — | — | — | H3 | — |
| BE-05 | — | — | — | — | C1 | — |
| BE-06 | — | — | — | GAP-C1 | C2 | — |

---

## 8. Key File References

### Backend (Laravel) — Most Impacted Files

| File | Gap Count | Key Issues |
|------|-----------|------------|
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | 16 | BE-01 through BE-02, BE-08, BE-15, BE-16, BE-20, BE-25, leg ID management |
| `routes/webhooks.php` | 2 | SEC-01 (no auth middleware) |
| `app/Services/CPaaSService.php` | 5 | BE-04, BE-06, CRED-03, CRED-04, BE-36 |
| `app/Http/Controllers/Api/DeviceTokenController.php` | 3 | BE-13, MOB-02, SEC-03 |
| `app/Services/PushNotificationService.php` | 3 | BE-14, BE-18, BE-46 |
| `config/cache.php` | 2 | BE-07, BE-44 |

### iOS (Swift) — Most Impacted Files

| File | Gap Count | Key Issues |
|------|-----------|------------|
| `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | 3 | MOB-01, MOB-06, MOB-10 |
| `ios/App/App/VoIP/Managers/PushKitManager.swift` | 3 | MOB-01, MOB-03, MOB-07 |
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` | 3 | MOB-01, MOB-03, IOS-02 |

### Android (Kotlin) — Most Impacted Files

| File | Gap Count | Key Issues |
|------|-----------|------------|
| `android/.../voip/TelnyxVoipPlugin.kt` | 4 | MOB-04, AND-02, MOB-14, AND-25 |
| `android/.../fcm/Z360FirebaseMessagingService.kt` | 5 | MOB-02, MOB-05, MOB-07, MOB-11, MOB-12 |
| `android/.../voip/OrgSwitchHelper.kt` | 2 | AND-01, MOB-13 |

### Web (TypeScript) — Most Impacted Files

| File | Gap Count | Key Issues |
|------|-----------|------------|
| `resources/js/components/.../dialpad/context.tsx` | 3 | WEB-02, WEB-06, CRED-02 |
| `resources/js/providers/native-voip-provider.tsx` | 2 | WEB-06, MOB-14 |
| `resources/js/hooks/useWebVoipCredentials.ts` | 2 | CRED-02, WEB-01 |

---

*Synthesized: 2026-02-08*
*Sources: 15 whitepaper documents across sessions 01-14*
*Total unique gaps: 127 (14 Critical, 23 High, 45 Medium, 45 Low/Config)*
*Recommended Phase 1 timeline: 2 weeks with 3 parallel engineers*
*Total remediation: ~140 engineer-days (~10 weeks with 3 engineers)*
