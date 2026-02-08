---
title: Failure Analysis Complete
---

# Failure Analysis: Complete Synthesis

> **Session 14 — Lead Synthesis** | Date: 2026-02-08
> **Scope**: Unified inventory of all race conditions, timing issues, and failure modes across the Z360 VoIP system
> **Sources**: Backend Race Conditions (21 issues), Mobile Race Conditions (12 issues), Network & System Failures (25 issues)

---

## Executive Summary

This document synthesizes findings from three independent research tracks into a single, deduplicated failure inventory for the Z360 VoIP system. After removing overlapping entries across reports, the system contains **48 unique issues** that can cause calls to fail, drop, degrade, or create security vulnerabilities.

### Issue Inventory (Deduplicated)

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Backend Race Conditions | 5 | 7 | 4 | 5 | 21 |
| Mobile Race Conditions | 2 | 3 | 3 | 4 | 12 |
| Network & System Failures | 4 | 5 | 4 | 2 | 15 |
| **Unique Total** | **11** | **15** | **11** | **11** | **48** |

*10 issues appeared in multiple reports and have been deduplicated in this synthesis (see Section 2).*

### The 5 Most Dangerous Issues

| Rank | ID | Title | Why |
|------|----|-------|-----|
| 1 | RC-M-07 / FM-24 | **iOS 5s CallKit deadline exceeded during cross-org switch** | Apple **permanently revokes VoIP push** — app unusable until reinstall |
| 2 | RC-BE-13 / FM-21 | **No webhook signature verification** | Attacker can forge call events, terminate active calls, inject fake data |
| 3 | FM-20 | **FCM token refresh never synced to backend** | All incoming calls silently stop on Android — user gets no error |
| 4 | RC-BE-2 | **Caller hangup doesn't cancel SIP legs** | Devices ring 10-30s after caller hung up — 5-10% of all calls |
| 5 | RC-BE-6 / RC-BE-11 | **Empty leg_ids during fast answer** | Other devices keep ringing after someone answered — common on fast networks |

---

## 1. Production Readiness Classification

All 48 issues are classified into three tiers based on production impact, likelihood, and user-facing severity.

### Tier 1: Must Fix Before Production (18 issues)

Issues that cause call failure, security vulnerabilities, or permanent system degradation. Shipping with these creates unacceptable risk.

| # | ID | Title | Category | Likelihood | Impact |
|---|-----|-------|----------|------------|--------|
| 1 | **RC-M-07** | iOS cross-org switch exceeds 5s CallKit deadline | Mobile | Common | **Permanent VoIP push revocation** |
| 2 | **RC-BE-13** | No webhook signature verification | Backend | Theoretical | **Security: forge/terminate calls** |
| 3 | **FM-20** | FCM token refresh never synced to backend | System | High | **Silent incoming call failure** |
| 4 | **RC-BE-2** | Caller hangup doesn't cancel SIP legs | Backend | Very Common | Devices ring 10-30s after hangup |
| 5 | **RC-BE-6** | Empty leg_ids array during fast answer | Backend | Common | Other devices keep ringing |
| 6 | **RC-BE-3** | Bridge failure leaves call in broken state | Backend | Rare | Both parties hear silence, no recovery |
| 7 | **RC-M-08** | iOS cold-start push before Phase 2 init | Mobile | Common | No audio on cold-start calls |
| 8 | **FM-04** | Android SDK auto-reconnect disabled | System | High | Every network blip drops call |
| 9 | **RC-BE-17** | Redis unavailable during lock acquisition | Backend | Rare | ALL devices hung up, no bridge |
| 10 | **RC-BE-16** | Credential expiry not enforced | Backend | High | SIP legs to dead endpoints |
| 11 | **RC-M-03** | Android SDK not connected on answer | Mobile | Uncommon | 5s delay or failed answer |
| 12 | **RC-M-12** | Org switch during active call drops call | Mobile | Rare | Active call drops unexpectedly |
| 13 | **RC-M-01** | Two-push 500ms timeout — partial caller info | Mobile | 5% of calls | "Unknown Caller" shown |
| 14 | **RC-BE-14** | Concurrent device registration — no transaction | Backend | Uncommon | Ghost Telnyx credentials |
| 15 | **RC-BE-8** | Webhook loss — no recovery | Backend | Rare | Call connects but no audio bridge |
| 16 | **RC-BE-18** | Cache TTL expires mid-call (10 min) | Backend | Common | Device stays active after caller hangs up |
| 17 | **FM-01** | Android network transition — no monitoring | System | High | Calls drop on WiFi↔cellular switch |
| 18 | **FM-03** | Web WebSocket disconnect — incoming calls missed | System | Medium | Web users miss all calls silently |

### Tier 2: Should Fix (16 issues)

Issues that degrade reliability or user experience but don't cause systemic failure. Plan to fix within first few sprints after launch.

| # | ID | Title | Category | Likelihood | Impact |
|---|-----|-------|----------|------------|--------|
| 19 | **RC-BE-15** | Org context switch during webhook processing | Backend | Very Rare | Call routed to wrong org |
| 20 | **RC-BE-20** | Push notification delivery failure — no retry | Backend | Medium | Phantom ringing 30s |
| 21 | **RC-BE-11** | call.initiated delayed — late leg tracking | Backend | Medium | Other devices ring after answer |
| 22 | **RC-M-02** | Android cold-start stale org cache | Mobile | Uncommon | Wrong org badge/credentials |
| 23 | **RC-M-04** | Native + web dual VoIP stack race | Mobile | Theoretical | Two incoming call UIs |
| 24 | **RC-M-09** | iOS audio activation race — didActivate before SDK | Mobile | Rare | No audio, 5s retry |
| 25 | **FM-06** | Call recording failure after bridge — no retry | System | Low | Compliance gap, lost recordings |
| 26 | **FM-13** | Backend restart during active calls | System | High (deploys) | Webhooks lost during restart |
| 27 | **FM-15** | PostgreSQL connection pool exhaustion | System | Low-Medium | Webhook processing stalled |
| 28 | **FM-17** | Multi-region latency — sequential leg creation | System | High | First device has unfair ring advantage |
| 29 | **FM-18** | Telnyx API outage — no retry or circuit breaker | System | Very Low | All call control operations fail |
| 30 | **FM-19** | FCM/APNs push service outage | System | Very Low | All incoming calls missed |
| 31 | **FM-22** | Android Doze mode delays push delivery | System | Medium | Calls delayed up to 15 min |
| 32 | **FM-09** | App crash during call — web has no recovery | System | Low-Medium | Web: all state lost |
| 33 | **RC-BE-5** | Duplicate call.answered webhooks — no idempotency | Backend | Uncommon | Potential double processing |
| 34 | **FM-14** | Redis failure — single point of failure | System | Low | All coordination lost |

### Tier 3: Nice to Fix (14 issues)

Low-probability issues, already-mitigated concerns, or optimizations that improve quality but aren't blocking.

| # | ID | Title | Category | Likelihood | Impact |
|---|-----|-------|----------|------------|--------|
| 35 | **RC-BE-4** | Lock expiry during slow bridge operation | Backend | Theoretical | None (secondary guard) |
| 36 | **RC-BE-7** | Push and webhook arrival order mismatch | Backend | Common | None (mobile syncs) |
| 37 | **RC-BE-9** | Recording webhook arrives before message | Backend | Uncommon | Recording lost |
| 38 | **RC-BE-10** | Duplicate call.hangup webhooks | Backend | Uncommon | None (graceful) |
| 39 | **RC-BE-12** | Webhook replay attack | Backend | Rare | Low (Telnyx rejects) |
| 40 | **RC-BE-19** | Concurrent cache updates to leg_ids | Backend | Low | Some legs not tracked |
| 41 | **RC-BE-21** | Org-level vs device-level credential confusion | Backend | Low | Call routing failure |
| 42 | **RC-M-05** | Android ConnectionService framework delay | Mobile | Rare | Delayed ring |
| 43 | **RC-M-06** | Double answer — AtomicBoolean race | Mobile | Impossible | None (correct pattern) |
| 44 | **RC-M-10** | Multiple calls overlap | Mobile | Uncommon | Handled (auto-reject) |
| 45 | **RC-M-11** | Stale re-INVITE after hangup | Mobile | Rare | Ghost ring (15s cooldown) |
| 46 | **FM-16** | TLS certificate expiry | System | Very Low | Total service outage |
| 47 | **FM-23** | iOS Low Power Mode impact | System | Medium | Slightly degraded quality |
| 48 | **FM-25** | Android 14+ full-screen intent permission | System | Medium | Less noticeable ring |

---

## 2. Cross-Report Deduplication Map

The following issues were identified independently by multiple research tracks. This table maps overlapping entries and confirms they describe the same root cause.

| Canonical ID | Backend Report | Mobile Report | Failure Report | Root Cause |
|-------------|---------------|---------------|----------------|------------|
| **RC-M-07** | — | RC-M-07 | FM-24 | iOS 5s CallKit deadline exceeded on cross-org switch |
| **RC-BE-13** | RC-BE-13 | — | FM-21 | No webhook signature verification |
| **RC-BE-17** | RC-BE-17 | — | FM-14 | Redis unavailable during lock acquisition |
| **RC-M-08** | — | RC-M-08 | FM-12 | iOS cold-start push before Phase 2 initialization |
| **RC-BE-3** | RC-BE-3 | — | FM-07 | Bridge failure leaves call broken |
| **RC-BE-8** | RC-BE-8 | — | FM-08 | Webhook loss with no recovery |
| **RC-M-01** | RC-BE-7 | RC-M-01 | — | Two-push timing / push-webhook order mismatch |
| **RC-BE-6** | RC-BE-6, RC-BE-11 | — | — | Empty/incomplete leg_ids (async population) |
| **RC-BE-18** | RC-BE-18 | — | — | Cache TTL expiry during long calls |
| **RC-M-12** | — | RC-M-12 | — | Org switch during active call (no guard) |

---

## 3. Root Cause Analysis

Across all 48 issues, five systemic root causes account for the majority of problems.

### Root Cause 1: Asynchronous Webhook Population of Critical State (11 issues)

**Issues**: RC-BE-2, RC-BE-6, RC-BE-8, RC-BE-9, RC-BE-11, RC-BE-19, RC-BE-20, RC-M-01, RC-M-03, FM-03, FM-08

The backend creates SIP legs via `Call::create()` but stores an **empty `leg_ids` array**, relying on asynchronous `call.initiated` webhooks to populate it. This creates a window where answering, hanging up, or any coordination operation works with incomplete data.

**Systemic Fix**: Capture `call_control_id` from the synchronous `Call::create()` response and store leg IDs immediately. This single change resolves or mitigates 6 issues (RC-BE-2, RC-BE-6, RC-BE-11, RC-BE-19, plus improves RC-BE-2 and RC-BE-8 recovery).

### Root Cause 2: No Graceful Degradation on Infrastructure Failure (8 issues)

**Issues**: RC-BE-17, FM-04, FM-05, FM-13, FM-14, FM-15, FM-18, FM-19

Redis, Telnyx API, and push services are treated as infallible. When any fails, the system either throws an exception (aborting the webhook) or silently drops the operation. No fallback paths, retries, or circuit breakers exist.

**Systemic Fix**: Implement a layered resilience strategy:
1. **Retry with backoff** for transient Telnyx API failures
2. **Database lock fallback** when Redis is unavailable
3. **Circuit breaker** to stop hammering failed services
4. **Graceful shutdown** for zero-downtime deploys

### Root Cause 3: iOS 5-Second PushKit Deadline Coupling (3 issues)

**Issues**: RC-M-07, RC-M-08, FM-24

iOS mandates that `reportNewIncomingCall()` be called within 5 seconds of PushKit delivery. The current implementation couples org switching, credential fetching, and SDK reconnection into this critical path, leaving insufficient margin.

**Systemic Fix**: Decouple CallKit reporting from all backend operations. Report to CallKit immediately with placeholder data, then perform org switch and credential operations asynchronously. Update CallKit display after async operations complete.

### Root Cause 4: Missing Android Network Resilience (4 issues)

**Issues**: FM-01, FM-02, FM-04, RC-M-03

Android lacks network change monitoring (`ConnectivityManager.NetworkCallback`) and has SDK auto-reconnect explicitly disabled (`autoReconnect = false`). iOS has both — `NetworkMonitor.swift` with 500ms debounce and SDK reconnect enabled.

**Systemic Fix**: Two changes:
1. Enable `autoReconnect: true` in all `credentialLogin()` calls (30-minute fix)
2. Implement `NetworkMonitor.kt` matching iOS's `NetworkMonitor.swift` pattern (2-3 days)

### Root Cause 5: Security Gap — No Webhook Authentication (2 issues)

**Issues**: RC-BE-13, FM-21

All Telnyx webhook controllers process requests without signature verification. Telnyx provides ED25519 signatures in headers, but Z360 never validates them. An attacker who discovers the webhook URL can forge call events.

**Systemic Fix**: Implement `VerifyTelnyxWebhook` middleware with ED25519 signature verification and timestamp replay protection. Apply to all `/webhooks/cpaas/telnyx/*` routes.

---

## 4. Hardening Roadmap

### Phase 1: Critical Path (Week 1-2) — 13 Items

**Goal**: Eliminate all issues that cause permanent system damage, security vulnerabilities, or affect >5% of calls.

| Order | ID | Action | Effort | Team |
|-------|-----|--------|--------|------|
| 1 | **FM-04** | Enable `autoReconnect: true` in Android SDK login calls | 0.5d | Android |
| 2 | **RC-BE-2** | Fix originator_cancel to cancel all SIP legs | 1d | Backend |
| 3 | **RC-BE-16** | Add `credential_expires_at > now()` to SIP destination query | 0.5d | Backend |
| 4 | **RC-BE-18** | Extend simring cache TTL from 10 min to 2 hours | 0.5d | Backend |
| 5 | **RC-BE-6** | Capture leg IDs synchronously from `Call::create()` response | 2d | Backend |
| 6 | **RC-BE-13** | Implement ED25519 webhook signature verification middleware | 2d | Backend |
| 7 | **FM-20** | Sync FCM token on refresh + add backend update endpoint | 2d | Android + Backend |
| 8 | **RC-M-07** | Decouple iOS CallKit reporting from org switch | 4d | iOS |
| 9 | **RC-M-08** | Trigger Phase 2 init from PushKit handler on cold start | 3d | iOS |
| 10 | **RC-BE-3** | Separate bridge try-block from cleanup; always execute cleanup | 2d | Backend |
| 11 | **RC-M-12** | Add active call guard before org switch (both platforms) | 1d | Android + iOS |
| 12 | **RC-M-01** | Backend: retry Z360 push once after 1s if no ACK | 2d | Backend |
| 13 | **RC-BE-14** | Wrap device registration in DB transaction with `lockForUpdate` | 1d | Backend |

**Total effort**: ~21.5 engineer-days (parallelizable across 3 teams: Backend, iOS, Android)
**Calendar time**: ~2 weeks with 3 engineers in parallel

### Phase 2: Stability Hardening (Week 3-4) — 10 Items

**Goal**: Add resilience to infrastructure failures, improve error recovery, and close remaining high-severity gaps.

| Order | ID | Action | Effort | Team |
|-------|-----|--------|--------|------|
| 14 | **FM-01** | Implement Android `NetworkMonitor.kt` with `ConnectivityManager.NetworkCallback` | 3d | Android |
| 15 | **RC-BE-17** | Add file-based lock fallback when Redis is unavailable | 2d | Backend |
| 16 | **RC-BE-8** | Implement stalled call detection job (everyMinute scheduler) | 3d | Backend |
| 17 | **FM-03** | Add Reverb `.incoming_call` listener as web fallback | 2d | Web |
| 18 | **FM-13** | Implement graceful shutdown + webhook queue persistence | 4d | Backend |
| 19 | **RC-BE-20** | Add exponential backoff retry for push notifications | 1d | Backend |
| 20 | **RC-M-09** | Extend iOS audio activation retry from 5s to 10s | 0.5d | iOS |
| 21 | **FM-18** | Add exponential backoff retry + circuit breaker for Telnyx API | 3d | Backend |
| 22 | **RC-BE-5** | Add webhook idempotency using `event.id` with 1-hour dedup | 1d | Backend |
| 23 | **RC-BE-15** | Audit all webhook handlers to use `client_state.organization_id` | 1d | Backend |

**Total effort**: ~20.5 engineer-days
**Calendar time**: ~2 weeks with 3 engineers in parallel

### Phase 3: Quality & Observability (Week 5-6) — 11 Items

**Goal**: Add monitoring, diagnostics, and optimization to detect issues before they impact users.

| Order | ID | Action | Effort | Team |
|-------|-----|--------|--------|------|
| 24 | **FM-06** | Add recording health check + retry after 5s | 2d | Backend |
| 25 | **FM-17** | Parallelize SIP leg creation (concurrent `Call::create()`) | 3d | Backend |
| 26 | **FM-22** | Proactive battery optimization exemption request | 1d | Android |
| 27 | **FM-25** | Proactive full-screen intent permission check (Android 14+) | 1d | Android |
| 28 | **RC-M-02** | Trust push org ID over cached data during cold start | 1d | Android |
| 29 | **RC-M-04** | Add native-side `isNativeVoIPActive` flag to prevent dual stacks | 1d | Android + iOS |
| 30 | **FM-02** | Add "Reconnecting..." banner in call UI (both platforms) | 2d | iOS + Android |
| 31 | **FM-15** | Add DB connection pool monitoring + query timeout | 1d | Backend |
| 32 | **FM-09** | Web: store minimal call state in sessionStorage for reload recovery | 1d | Web |
| 33 | All | VoIP analytics dashboard: push delivery, lock failures, network transitions, call quality | 3d | Backend |
| 34 | **FM-16** | Certificate expiry monitoring (backend + APNs) | 1d | Backend |

**Total effort**: ~17 engineer-days
**Calendar time**: ~2 weeks with 3 engineers in parallel

### Phase 4: Polish (Backlog) — 14 Items

Low-priority items to address as time permits. No production blocking.

| ID | Action | Effort |
|----|--------|--------|
| RC-BE-4 | Extend lock TTL from 10s to 30s | 0.5d |
| RC-BE-9 | Add retry mechanism for recording webhook | 1d |
| RC-BE-19 | Use Redis list operations for atomic leg_id append | 1d |
| RC-BE-21 | Add guard against dialing org-level credentials | 0.5d |
| RC-M-05 | Add timeout guard if `onShowIncomingCallUi()` not called within 2s | 1d |
| RC-M-11 | Extend re-INVITE cooldown from 15s to 60s | 0.5d |
| FM-05 | Add ICE connection diagnostics + configurable relay | 2d |
| FM-10 | Monitor OS kill rate during calls | 0.5d |
| FM-23 | Detect iOS Low Power Mode + show banner | 0.5d |
| FM-19 | Add secondary FCM notification channel as fallback (Android) | 2d |
| RC-BE-7 | Document push/webhook order mismatch as acceptable | 0.5d |
| RC-BE-10 | Add webhook idempotency (covered by RC-BE-5 fix) | 0d |
| RC-BE-12 | Covered by RC-BE-13 fix (signature verification) | 0d |
| RC-M-06 | No fix needed — AtomicBoolean pattern is correct | 0d |

---

## 5. Severity-Ranked Master Table

Complete inventory of all 48 unique issues, ranked by production priority.

| Rank | ID | Title | Category | Likelihood | Impact | Tier | Phase |
|------|----|-------|----------|------------|--------|------|-------|
| 1 | RC-M-07 | iOS 5s CallKit deadline — cross-org switch | Mobile | Common | Critical (permanent) | T1 | P1 |
| 2 | RC-BE-13 | No webhook signature verification | Backend | Theoretical | Critical (security) | T1 | P1 |
| 3 | FM-20 | FCM token refresh never synced | System | High | Critical (silent failure) | T1 | P1 |
| 4 | RC-BE-2 | Caller hangup doesn't cancel SIP legs | Backend | Very Common | High (UX) | T1 | P1 |
| 5 | RC-BE-6 | Empty leg_ids during fast answer | Backend | Common | High (UX) | T1 | P1 |
| 6 | RC-BE-3 | Bridge failure — broken call state | Backend | Rare | Critical (no recovery) | T1 | P1 |
| 7 | RC-M-08 | Cold-start push before Phase 2 | Mobile | Common | High (no audio) | T1 | P1 |
| 8 | FM-04 | Android SDK auto-reconnect disabled | System | High | High (dropped calls) | T1 | P1 |
| 9 | RC-BE-17 | Redis unavailable during lock | Backend | Rare | Critical (all fail) | T1 | P2 |
| 10 | RC-BE-16 | Credential expiry not enforced | Backend | High | Medium (wasted legs) | T1 | P1 |
| 11 | RC-M-03 | Android SDK not connected on answer | Mobile | Uncommon | High (failed answer) | T1 | P1 |
| 12 | RC-M-12 | Org switch during active call | Mobile | Rare | High (call drops) | T1 | P1 |
| 13 | RC-M-01 | Two-push 500ms timeout | Mobile | 5% of calls | Medium (partial info) | T1 | P1 |
| 14 | RC-BE-14 | Concurrent device registration | Backend | Uncommon | High (ghost creds) | T1 | P1 |
| 15 | RC-BE-8 | Webhook loss — no recovery | Backend | Rare | Critical (no bridge) | T1 | P2 |
| 16 | RC-BE-18 | Cache TTL expires mid-call | Backend | Common | Medium (manual hangup) | T1 | P1 |
| 17 | FM-01 | Android no network monitoring | System | High | High (calls drop) | T1 | P2 |
| 18 | FM-03 | Web WebSocket disconnect | System | Medium | High (missed calls) | T1 | P2 |
| 19 | RC-BE-15 | Org context switch during webhook | Backend | Very Rare | Medium (wrong org) | T2 | P2 |
| 20 | RC-BE-20 | Push delivery failure — no retry | Backend | Medium | Medium (phantom ring) | T2 | P2 |
| 21 | RC-BE-11 | call.initiated delayed | Backend | Medium | High (ring after answer) | T2 | P1* |
| 22 | RC-M-02 | Cold-start stale org cache | Mobile | Uncommon | Medium (wrong badge) | T2 | P3 |
| 23 | RC-M-04 | Dual VoIP stack race | Mobile | Theoretical | Medium (double UI) | T2 | P3 |
| 24 | RC-M-09 | iOS audio activation race | Mobile | Rare | Medium (no audio) | T2 | P2 |
| 25 | FM-06 | Recording failure — no retry | System | Low | Medium (compliance) | T2 | P3 |
| 26 | FM-13 | Backend restart during calls | System | High (deploys) | Medium (webhooks lost) | T2 | P2 |
| 27 | FM-15 | DB connection pool exhaustion | System | Low-Medium | Medium (stalled) | T2 | P3 |
| 28 | FM-17 | Multi-region latency | System | High | Low (unfair ring) | T2 | P3 |
| 29 | FM-18 | Telnyx API outage — no retry | System | Very Low | High (all ops fail) | T2 | P2 |
| 30 | FM-19 | FCM/APNs push outage | System | Very Low | High (calls missed) | T2 | P3 |
| 31 | FM-22 | Android Doze mode delays | System | Medium | Medium (delayed ring) | T2 | P3 |
| 32 | FM-09 | App crash — web no recovery | System | Low-Medium | Medium (state lost) | T2 | P3 |
| 33 | RC-BE-5 | Duplicate webhooks — no idempotency | Backend | Uncommon | Low (mitigated) | T2 | P2 |
| 34 | FM-14 | Redis failure — SPOF | System | Low | Critical (all fail) | T2 | P2 |
| 35 | RC-BE-4 | Lock expiry during slow bridge | Backend | Theoretical | Low (secondary guard) | T3 | P4 |
| 36 | RC-BE-7 | Push/webhook order mismatch | Backend | Common | None (mobile syncs) | T3 | P4 |
| 37 | RC-BE-9 | Recording webhook before message | Backend | Uncommon | Low (recording lost) | T3 | P4 |
| 38 | RC-BE-10 | Duplicate call.hangup webhooks | Backend | Uncommon | None (graceful) | T3 | P4 |
| 39 | RC-BE-12 | Webhook replay attack | Backend | Rare | Low (Telnyx rejects) | T3 | P4 |
| 40 | RC-BE-19 | Concurrent cache updates | Backend | Low | Medium (some legs) | T3 | P4 |
| 41 | RC-BE-21 | Org/device credential confusion | Backend | Low | High (routing) | T3 | P4 |
| 42 | RC-M-05 | ConnectionService framework delay | Mobile | Rare | Low (delayed ring) | T3 | P4 |
| 43 | RC-M-06 | Double answer race | Mobile | Impossible | None (correct) | T3 | — |
| 44 | RC-M-10 | Multiple calls overlap | Mobile | Uncommon | None (handled) | T3 | — |
| 45 | RC-M-11 | Stale re-INVITE after hangup | Mobile | Rare | Low (cooldown) | T3 | P4 |
| 46 | FM-16 | TLS certificate expiry | System | Very Low | Critical (outage) | T3 | P4 |
| 47 | FM-23 | iOS Low Power Mode | System | Medium | Low (quality) | T3 | P4 |
| 48 | FM-25 | Android full-screen intent | System | Medium | Low (notification) | T3 | P3 |

*\*RC-BE-11 is resolved by the same fix as RC-BE-6 (synchronous leg ID capture).*

---

## 6. Quick Wins — High Impact, Low Effort

These items can be completed in under 1 day each and immediately improve system reliability.

| # | ID | Change | Effort | Impact |
|---|-----|--------|--------|--------|
| 1 | FM-04 | Change `autoReconnect = false` → `true` in 2 files | 30 min | Stops all network-blip call drops on Android |
| 2 | RC-BE-16 | Add `->where('credential_expires_at', '>', now())` to one query | 30 min | Stops dialing expired SIP credentials |
| 3 | RC-BE-18 | Change `now()->addMinutes(10)` → `now()->addHours(2)` | 30 min | Fixes long call cleanup failures |
| 4 | RC-BE-2 | Add SIP leg cancellation in `originator_cancel` handler | 2 hours | Fixes "devices ring after hangup" for 5-10% of calls |
| 5 | RC-M-09 | Change iOS audio retry from 5s to 10s | 30 min | Reduces silent-call failures on slow networks |
| 6 | RC-M-11 | Extend re-INVITE cooldown from 15s to 60s | 30 min | Eliminates ghost rings from stale SIP messages |

**Total quick-win effort**: ~5 hours
**Combined impact**: Fixes issues affecting ~15% of all calls

---

## 7. Testing Strategy

### 7.1 Automated Test Requirements (Tier 1 Issues)

| Test | Covers | Assertion |
|------|--------|-----------|
| `test_originator_cancel_cancels_all_sip_legs` | RC-BE-2 | All leg_ids receive `hangup()` on originator_cancel |
| `test_leg_ids_populated_synchronously` | RC-BE-6 | `leg_ids` array contains all IDs after `transferToUser()` |
| `test_bridge_failure_still_cleans_up_legs` | RC-BE-3 | Other legs hung up + notifications sent even if bridge fails |
| `test_webhook_signature_rejects_invalid` | RC-BE-13 | Invalid ED25519 signature returns 403 |
| `test_webhook_replay_protection` | RC-BE-13 | Timestamp >5 min old returns 403 |
| `test_expired_credentials_excluded` | RC-BE-16 | Expired SIP credentials not in destination list |
| `test_device_registration_transaction` | RC-BE-14 | Concurrent registration creates only 1 credential |
| `test_redis_down_fallback_lock` | RC-BE-17 | File-based lock fallback works when Redis unavailable |
| `test_cache_ttl_2_hours` | RC-BE-18 | Simring cache persists for 2 hours |
| `test_fcm_token_sync_endpoint` | FM-20 | `POST /api/device-tokens/update-fcm` updates token |

### 7.2 Manual Test Scenarios

| Scenario | Platforms | Expected Result |
|----------|-----------|-----------------|
| Caller hangs up after 3s of ringing | All | All devices stop ringing within 2s |
| Answer call within 200ms of ring | Android/iOS | All other devices stop ringing immediately |
| WiFi → cellular during active call | Android | Call continues (after FM-04 fix) |
| Network loss for 20s during call | iOS | "Reconnecting..." shown, call resumes |
| Kill app during active call, relaunch | iOS/Android | Orphan detected, notification shown |
| Cross-org incoming call on killed iOS app | iOS | CallKit shows within 5ms, org switch in background |
| Cold-start push on iOS, answer within 1s | iOS | Audio works immediately (after RC-M-08 fix) |
| Send forged webhook to backend | Backend | 403 Forbidden (after RC-BE-13 fix) |
| FCM token refresh on Android | Android | Backend receives new token (after FM-20 fix) |
| Two devices answer simultaneously | All | First device bridges, second hears immediate hangup |

### 7.3 Load Testing

| Scenario | Parameters | Pass Criteria |
|----------|------------|---------------|
| Concurrent webhooks | 100 webhooks/second for 60s | No dropped webhooks, no lock failures |
| Simultaneous device registration | 10 devices, same user, concurrent | Exactly N credentials, no orphans |
| Redis failover | Kill Redis during active calls | Calls continue, new calls use fallback lock |
| Backend rolling deploy | Deploy during 10 active calls | Zero call drops, all webhooks eventually processed |

---

## 8. Cross-Reference to Prior Research

This synthesis draws from and supersedes the following prior whitepaper sections:

| Prior Document | Relevant Section | Status |
|---------------|-----------------|--------|
| `03-call-management/simultaneous-ringing-complete.md` | Section 3: RC-1 through RC-10 | **Superseded** — all re-analyzed with deeper root cause |
| `03-call-management/inbound-call-flow-unified.md` | Section 9: Race Conditions RC-1 to RC-9 | **Superseded** — expanded to 48 issues |
| `03-call-management/call-state-complete.md` | Section 5.3: No Active Call Tracking | **Referenced** — informs RC-M-10, RC-M-12 |
| `03-call-management/credentials-unified.md` | Section 2: Gap List C1, H3 | **Referenced** — informs RC-BE-14, RC-BE-16 |
| `02-platform-architectures/ios-architecture-complete.md` | GAP-01, GAP-04 | **Superseded** — now RC-M-07, RC-M-08 |
| `02-platform-architectures/android-architecture-complete.md` | GAP-015, GAP-017, GAP-024 | **Superseded** — now FM-01, FM-04, FM-20 |

---

## 9. File Reference Summary

### Backend (Laravel)

| File | Issues |
|------|--------|
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` | RC-BE-1 through RC-BE-6, RC-BE-8, RC-BE-11, RC-BE-15, RC-BE-16, RC-BE-17, RC-BE-18, RC-BE-19, RC-BE-21, FM-06, FM-17 |
| `app/Http/Controllers/Api/DeviceTokenController.php` | RC-BE-14, FM-20 |
| `app/Services/CPaaSService.php` | RC-BE-16, RC-BE-21, FM-18 |
| `app/Services/PushNotificationService.php` | RC-BE-20, FM-19, FM-22 |
| `routes/webhooks.php` | RC-BE-13, FM-21 |
| `config/cache.php` | RC-BE-17, FM-14 |

### iOS (Swift)

| File | Issues |
|------|--------|
| `ios/App/App/VoIP/Managers/PushKitManager.swift` | RC-M-01, RC-M-07, RC-M-08, FM-12, FM-24 |
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` | RC-M-07, RC-M-08, RC-M-09, RC-M-12 |
| `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | RC-M-07, RC-M-12, FM-24 |
| `ios/App/App/VoIP/Utils/NetworkMonitor.swift` | FM-01, FM-02 |
| `ios/App/App/VoIP/Services/VoipStore.swift` | FM-09 |
| `ios/App/App/AppDelegate.swift` | RC-M-08, FM-12 |

### Android (Kotlin)

| File | Issues |
|------|--------|
| `android/.../voip/TelnyxVoipPlugin.kt` | FM-04, RC-M-04, FM-25 |
| `android/.../voip/IncomingCallActivity.kt` | RC-M-03, RC-M-06 |
| `android/.../fcm/Z360FirebaseMessagingService.kt` | RC-M-01, RC-M-02, RC-M-03, RC-M-10, RC-M-11, FM-04, FM-20 |
| `android/.../fcm/PushSynchronizer.kt` | RC-M-01 |
| `android/.../voip/OrgSwitchHelper.kt` | RC-M-12 |
| `android/.../voip/Z360VoipStore.kt` | RC-M-02, RC-M-11 |
| `android/.../voip/Z360ConnectionService.kt` | RC-M-05 |
| `android/.../voip/CallStatePersistence.kt` | FM-09 |
| `android/.../voip/CrashRecoveryManager.kt` | FM-09 |

### Web (TypeScript)

| File | Issues |
|------|--------|
| `resources/js/components/identifier-details-sidebar/dialpad/context.tsx` | FM-03 |
| `resources/js/providers/native-voip-provider.tsx` | RC-M-04 |

---

## 10. Summary Metrics

| Metric | Value |
|--------|-------|
| Total unique issues identified | 48 |
| Critical severity | 11 |
| Must-fix-before-production (Tier 1) | 18 |
| Quick wins (< 1 day, high impact) | 6 |
| Total Phase 1 effort (critical path) | ~21.5 engineer-days |
| Total remediation effort (all phases) | ~72 engineer-days |
| Calendar time (3 engineers parallel) | ~6 weeks |
| Files affected | 23 unique files |
| Overlapping issues across reports | 10 |
| Issues already mitigated (no fix needed) | 2 (RC-M-06, RC-M-10) |

---

**End of Failure Analysis Synthesis**

*Synthesized: 2026-02-08*
*Source reports: backend-race-conditions.md (21 issues), mobile-race-conditions.md (12 issues), network-and-system-failures.md (25 issues)*
*Deduplicated total: 48 unique issues*
*Recommended Phase 1 timeline: 2 weeks with 3 parallel engineers*
