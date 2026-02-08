---
title: iOS Gap Analysis
---

# iOS VoIP Gap Analysis: Current State vs Target Architecture

> **Purpose**: Comprehensive gap analysis comparing Z360's current iOS VoIP implementation against platform requirements, Telnyx SDK best practices, and target architecture goals. Each gap includes severity rating, evidence, impact assessment, suggested fix, and effort estimate.
>
> **Sources**: `voip-ios` skill (Z360 implementation), `voip-ios-platform` skill (Apple requirements), `telnyx-ios-demo.xml` pack (Telnyx reference), `ios-platform-requirements.md`, `telnyx-sdks-reference.md`, `system-architecture-unified.md`

---

## Table of Contents

1. [Gap Summary Matrix](#1-gap-summary-matrix)
2. [Critical Gaps](#2-critical-gaps)
3. [High-Severity Gaps](#3-high-severity-gaps)
4. [Medium-Severity Gaps](#4-medium-severity-gaps)
5. [Low-Severity Gaps](#5-low-severity-gaps)
6. [Strengths (No Gap)](#6-strengths-no-gap)
7. [Effort Summary](#7-effort-summary)

---

## 1. Gap Summary Matrix

| # | Gap | Severity | Area | Effort |
|---|-----|----------|------|--------|
| G-01 | Cross-org switch timing margin is dangerously thin | Critical | CallKit Timing | Medium |
| G-02 | PushCorrelator cannot update CallKit display after initial report | High | Push Reliability | Medium |
| G-03 | Audio session not restored on failed org switch | High | Audio Conflicts | Small |
| G-04 | Deferred init window: push arrives before Phase 2 completes | High | Initialization | Medium |
| G-05 | No WebView/native call isolation guard | Medium | Platform Isolation | Small |
| G-06 | Z360VoIPService is a God Object (2,253 lines, 12+ dependencies) | Medium | Architecture | Large |
| G-07 | Firebase logging disabled during cold-start calls | Medium | Observability | Small |
| G-08 | No active call protection during org switch | Medium | Call Management | Small |
| G-09 | Sign In with Apple: zero implementation | Low | Authentication | Large |
| G-10 | Crash recovery during recovery itself is unprotected | Low | Resilience | Small |

---

## 2. Critical Gaps

### G-01: Cross-Organization Switch Timing Margin Is Dangerously Thin

**Severity**: Critical
**Area**: CallKit Reporting Timing

**Description**: When an incoming call arrives for a different organization than the currently active one, Z360 must switch organizations, fetch new credentials, reconnect the Telnyx SDK, and answer the call -- all within Apple's 5-second CallKit deadline. The current implementation allocates 4.0 seconds for the API request and caps total switch time at 4.5 seconds, leaving only **0.5-1.0 seconds of margin** for SDK reconnection, credential storage, and call answering.

**Evidence**:
- `OrganizationSwitcher.swift` line 8050-8054:
  ```
  /// Request timeout in seconds (should be well under 5s CallKit deadline)
  private static let requestTimeoutSeconds: TimeInterval = 4.0

  /// Maximum total switch time before giving up (safety margin for 5s deadline)
  private static let maxSwitchTimeSeconds: TimeInterval = 4.5
  ```
- `Z360VoIPService.swift` line 4545:
  ```
  // Must complete within 5-second CallKit deadline
  ```
- `OrganizationSwitcher.swift` line 7929:
  ```
  // Must complete within 5-second CallKit deadline
  ```
- The SDK reconnection uses 50ms poll intervals waiting for `clientReady` state. Under CPU load (cold start, background wake), polling could overshoot.
- `TelnyxService.swift` lines 4343-4346: Cold-start answer timeout was increased from 3.0s to 5.0s -- exactly the deadline.

**Telnyx Demo Comparison**: The Telnyx demo has NO organization switching -- it's single-tenant. Z360's multi-tenant architecture creates this unique timing risk.

**Impact**: If the 5-second deadline is exceeded:
1. Apple **terminates the app process**
2. Repeated violations cause Apple to **permanently stop delivering VoIP pushes** to the app
3. This is the nuclear option -- the app effectively loses VoIP capability until reinstalled

**Suggested Fix**:
1. **Optimistic CallKit reporting**: Report the call to CallKit FIRST with placeholder info, then perform the org switch in the background. Update the CallKit display info via `provider.reportCall(with:updated:)` after the switch completes. This decouples the 5-second deadline from the org switch.
2. **Pre-cache credentials**: When the user has multiple orgs, proactively cache SIP credentials for all orgs during login. This eliminates the API call during the critical path.
3. **Reduce API timeout**: Use 2.0-second API timeout instead of 4.0, allowing more margin for SDK reconnection.

**Effort Estimate**: Medium (architectural change to decouple CallKit reporting from org switch)

---

## 3. High-Severity Gaps

### G-02: PushCorrelator Cannot Update CallKit Display After Initial Report

**Severity**: High
**Area**: Push Reliability / UX

**Description**: The two-push system (Z360 push with caller info + Telnyx push with call control) uses a 500ms sync timeout. If the Z360 push arrives late (or never arrives), CallKit is reported with "Unknown Caller" as a fallback. However, there is **no mechanism to update the CallKit display** when the Z360 push eventually arrives after the initial fallback report.

**Evidence**:
- `PushCorrelator.swift` line 2492-2493:
  ```
  /// Maximum time to wait for the other push (must be < 5 seconds for PushKit)
  private let syncTimeoutMs: Int64 = 500
  ```
- `PushKitManager.swift` line 1530: Falls back to `"Unknown Caller"` when no caller name available
- `PushKitManager.swift` lines 1315-1324: `waitForTelnyxData()` has 1.5-second timeout with 100ms polling -- an additional delay path
- `CallKitManager.swift` line 570: `update.localizedCallerName = callerName ?? "Unknown Caller"`
- **Missing**: No code path calls `provider.reportCall(with:updated:)` after initial CallKit report to update caller display info

**Telnyx Demo Comparison**: The demo uses single-push (Telnyx SDK push only). No correlation needed -- caller info comes directly in the push payload.

**Impact**:
- Users see "Unknown Caller" for legitimate business calls when Z360 push is delayed (network latency, server load)
- Cannot recover to show correct caller name even after Z360 push arrives
- Business context (organization, channel) is lost, reducing call answer rates

**Suggested Fix**:
1. Implement a `CXCallUpdate` refresh path: When Z360 push arrives after timeout, call `provider.reportCall(with: uuid, updated: update)` to update the caller display name
2. Extend `PushCorrelator` to emit a "late match" event that triggers the update
3. Consider increasing sync timeout to 1000ms (still well under 5s) to reduce fallback frequency

**Effort Estimate**: Medium (new event path from PushCorrelator through to CallKitManager)

---

### G-03: Audio Session Not Restored on Failed Organization Switch

**Severity**: High
**Area**: Audio Session Conflicts

**Description**: When a cross-org switch fails mid-execution, `OrganizationSwitcher` restores the original organization context (API session, credentials) via `restoreOriginalOrgContext()`. However, it does **not** restore `AVAudioSession` category/mode or `AudioManager` state. If the audio session was reconfigured during the switch attempt, the failed switch leaves audio in an undefined state.

**Evidence**:
- `OrganizationSwitcher.swift` lines 265-282: `restoreOriginalOrgContext()` restores credentials and org state but makes no mention of audio session
- `AudioManager.swift` lines 231-249: Speaker/route state managed separately from org context
- `CallKitManager.swift` lines 893-900: Audio activation/deactivation delegated to CallKit callbacks, but CallKit doesn't know about org switch failures

**Telnyx Demo Comparison**: No org switching exists in the demo -- audio session is configured once and stays stable.

**Impact**:
- After a failed org switch, active calls on the original org could have broken audio routing
- User might hear no audio, or audio routes to wrong output (speaker vs earpiece mismatch)
- Requires app restart to recover audio state

**Suggested Fix**:
1. Capture `AVAudioSession` configuration (category, mode, output route) before org switch
2. In `restoreOriginalOrgContext()`, also restore the audio session configuration
3. Add an audio session health check after org switch failure

**Effort Estimate**: Small (add audio state save/restore to OrganizationSwitcher)

---

### G-04: Deferred Initialization Window: VoIP Push Arrives Before Phase 2

**Severity**: High
**Area**: Initialization Timing

**Description**: Z360's two-phase startup defers most initialization to `sceneDidBecomeActive` (Phase 2). When the app is cold-launched by a VoIP push, Phase 1 runs (`didFinishLaunchingWithOptions`), then PushKit delivers the push. Phase 2 has NOT run yet. The push handler operates with:
- AVAudioSession NOT configured
- Telnyx SDK NOT connected
- Network monitoring NOT started
- Firebase logging NOT available

While this is architecturally intentional (and CallKit reporting works fine because CallKitManager is wired in Phase 1), the gap is that **audio configuration and SDK connection only happen after the user interacts with the UI** (triggering `sceneDidBecomeActive`).

**Evidence**:
- `AppDelegate.swift` lines 10303-10311:
  ```swift
  // ONLY initialize PushKit + minimal CallKit/VoIP wiring
  PushKitManager.shared.initialize()
  Z360VoIPService.shared.setupMinimal(callKitManager: CallKitManager.shared)
  // All other initialization deferred to sceneDidBecomeActive
  ```
- `SceneDelegate.swift` lines 10733-10749: `performDeferredInitialization()` runs in `sceneDidBecomeActive`
- `Z360VoIPService.swift` lines 4138-4141: `setupMinimal()` sets `isSetUp = true` but doesn't start network monitoring or audio config

**Cold-start call timeline**:
```
VoIP Push arrives → iOS launches app → didFinishLaunchingWithOptions (Phase 1)
  → PushKit handler fires → CallKit reported (OK)
  → User sees CallKit UI → User answers
  → sceneDidBecomeActive fires (Phase 2) → Audio configured → SDK connects
  → Answer processed
```

**The gap**: Between "User answers" and "SDK connects", there's a variable delay. The `TelnyxService.swift` cold-start timeout (5.0 seconds, lines 4343-4346) attempts to handle this, but under poor network conditions, the SDK may not connect in time.

**Telnyx Demo Comparison**: The demo initializes everything in `didFinishLaunchingWithOptions` -- no deferral needed since it's a pure native app without WebView.

**Impact**:
- Cold-start incoming calls may have delayed audio (user answers but hears nothing for several seconds)
- Under poor network: call could time out before SDK connects, resulting in a "ghost answer" where CallKit shows connected but no media flows
- All VoIP logs during cold-start calls are lost (Firebase not initialized)

**Suggested Fix**:
1. **Trigger deferred init from PushKit handler**: When a VoIP push wakes the app, call `performDeferredInitialization()` immediately (before `sceneDidBecomeActive`). This is safe because the push handler runs on a background thread, not blocking WebView.
2. **Add audio-ready gating**: Don't fulfill the CallKit answer action until audio session is confirmed configured.
3. **Persistent logging fallback**: Use `os_log` (always available) as fallback when Firebase isn't ready.

**Effort Estimate**: Medium (modify cold-start initialization path, add audio readiness gating)

---

## 4. Medium-Severity Gaps

### G-05: No WebView/Native Call Isolation Guard

**Severity**: Medium
**Area**: Platform Isolation

**Description**: Z360 uses `NativeVoipProvider` on mobile (replacing `TelnyxRTCProvider` used on web) to prevent dual WebSocket connections at the provider level. However, there is **no iOS-side guard** preventing both the WebView's WebRTC layer and the native Telnyx SDK from attempting to handle the same incoming call simultaneously.

**Evidence**:
- `TelnyxVoipPlugin.swift` lines 104-120: Plugin bridges to JavaScript but has no check for concurrent WebRTC sessions
- `Z360VoIPService.swift`: No code referencing "webview", "web", "isolation", or "dual" -- no defensive logic for this scenario
- `native-voip-provider.tsx` (frontend): Replaces `TelnyxRTCProvider` on native platforms, preventing WebRTC initialization. This is the primary guard, but it operates in JavaScript, not Swift.

**Impact**:
- If the JavaScript provider replacement fails (React error boundary, hot reload edge case), both stacks could activate
- Both would attempt to answer the same call UUID, causing undefined behavior in CallKit
- Low probability but catastrophic if it occurs

**Suggested Fix**:
1. Add a native-side `isNativeVoIPActive` flag in `TelnyxVoipPlugin.swift` that prevents any WebRTC-related JavaScript calls when native VoIP is handling a call
2. Add a `Capacitor.bridge` check to verify the WebView isn't running its own WebRTC session before native SDK processes a call

**Effort Estimate**: Small (add flag check in plugin bridge)

---

### G-06: Z360VoIPService Is a God Object

**Severity**: Medium
**Area**: Architecture / Maintainability

**Description**: `Z360VoIPService.swift` is 2,253 lines with 12+ dependencies and 10+ distinct responsibility areas. It directly coordinates CallKitManager, TelnyxService, PushKitManager, VoipStore, NotificationHelper, CallTimerManager, CallQualityMonitor, NetworkMonitor, AudioManager, ActionGuard, ActiveCallGuard, and OrganizationSwitcher. This violates the Single Responsibility Principle and makes the code difficult to test, debug, and extend.

**Evidence**:
- `Z360VoIPService.swift` lines 4039-4125: 7 lazy-initialized service dependencies + 5 lazy-initialized utility dependencies
- Responsibility areas identified:
  1. Incoming call orchestration (lines 4472+)
  2. Call state management (lines 5000+)
  3. Telnyx SDK coordination (TelnyxServiceDelegate)
  4. CallKit coordination (CallKitManagerDelegate)
  5. Push notification routing
  6. Outbound call handling (lines 4949-5119)
  7. Missed call handling (lines 5428+)
  8. Network and audio monitoring (lines 5731+)
  9. Organization switching (lines 8053+)
  10. Background task management (lines 8213+)
  11. Orphan call recovery (lines 354-427)
  12. Call cancel/timeout logic (lines 4870-4947)

**Telnyx Demo Comparison**: The demo uses separate `TelnyxService`, `VoIPServiceManager`, `CallViewModel`, and `AppDelegate` -- clear separation of concerns across ~1,200 total lines.

**Impact**:
- Adding new features requires understanding 2,253 lines of context
- Bug fixes risk regressions in unrelated call flows
- Testing individual behaviors requires mocking 12+ dependencies
- Code review of changes is error-prone due to file size

**Suggested Fix**: Extract into focused classes:
1. `IncomingCallHandler` — incoming call orchestration, push routing, cross-org detection
2. `OutboundCallHandler` — outbound call initiation, validation, cancel logic
3. `CallStateManager` — state persistence, orphan recovery, crash recovery
4. `CrossOrgSwitchCoordinator` — org switch orchestration (already partially extracted to `OrganizationSwitcher`)
5. Keep `Z360VoIPService` as a thin facade that delegates to these handlers

**Effort Estimate**: Large (significant refactoring, requires comprehensive test coverage first)

---

### G-07: Firebase Logging Disabled During Cold-Start Calls

**Severity**: Medium
**Area**: Observability

**Description**: `VoIPLogger` has an `isFirebaseReady` flag that starts as `false`. Firebase initialization is deferred to Phase 2 (`performDeferredInitialization`). During cold-start incoming calls, all VoIP logging to Firebase Crashlytics is silently dropped.

**Evidence**:
- `VoIPLogger.swift` lines 296-297: `isFirebaseReady` initialized to `false`
- `AppDelegate.swift` line 10337: Firebase configured in `performDeferredInitialization()` (Phase 2)
- No visible code path sets `isFirebaseReady = true` after Firebase initializes

**Impact**:
- Cold-start call failures are invisible in crash reporting
- Most critical call scenario (background wake, answered from lock screen) has zero observability
- Debugging production issues for cold-start calls requires user-reported logs

**Suggested Fix**:
1. Use `os_log` as immediate fallback (always available, no init required)
2. Buffer VoIP log entries during cold start; flush to Firebase once `isFirebaseReady` becomes `true`
3. Ensure `isFirebaseReady` is set to `true` in `performDeferredInitialization()` after Firebase setup

**Effort Estimate**: Small (add os_log fallback and buffering to VoIPLogger)

---

### G-08: No Active Call Protection During Organization Switch

**Severity**: Medium
**Area**: Call Management

**Description**: When a cross-org incoming call triggers an organization switch, `OrganizationSwitcher.switchOrganization()` does **not** check whether there is an active call in the current organization. The switch would disrupt credentials and SDK connection for the ongoing call.

**Evidence**:
- `OrganizationSwitcher.swift` line 8090: `switchOrganization()` takes `targetOrgId` and `targetOrgName` but no `activeCallCheck` parameter
- `Z360VoIPService.swift` lines 4542-4548: Cross-org switch is triggered during incoming call handling without checking `activeCallUUID`
- No guard in the switch path that checks `Z360VoIPService.activeCallUUID != nil`

**Impact**:
- If user is on a call in Org A and receives a call for Org B, answering the Org B call could disconnect the Org A call
- Credential regeneration for Org B invalidates the Org A SIP session
- User loses both calls

**Suggested Fix**:
1. Check `activeCallUUID` before initiating org switch
2. If active call exists, reject the cross-org incoming call with a busy signal
3. Alternatively, queue the cross-org call and present it after the current call ends

**Effort Estimate**: Small (add guard check in performCrossOrgSwitch)

---

## 5. Low-Severity Gaps

### G-09: Sign In with Apple: Zero Implementation

**Severity**: Low (new feature, not a bug)
**Area**: Authentication

**Description**: No Sign In with Apple (SIWA) implementation exists in the iOS codebase. This is a new feature requirement, not a regression.

**Evidence**:
- Zero files matching `ASAuthorization`, `Sign In with Apple`, or `SIWA` patterns in `ios/App/App/`
- No Apple authentication entries in `Info.plist` capabilities
- No keychain integration for Apple ID credentials

**Requirements for implementation**:
1. `ASAuthorizationController` UI in login flow
2. Apple ID credential state monitoring (`ASAuthorizationAppleIDProvider.getCredentialState`)
3. Backend API integration for Apple ID token exchange
4. Keychain storage for Apple ID user identifier
5. Handle credential revocation (user removes app from Apple ID settings)
6. VoIP impact: Ensure SIWA auth state propagates correctly during org switches

**Impact**: Users cannot sign in via Apple ID. Not a VoIP functional gap, but a platform expectation for iOS apps.

**Suggested Fix**: Implement standard SIWA flow using `AuthenticationServices` framework. Consider using `ASAuthorizationController` with both Apple ID and password credential providers.

**Effort Estimate**: Large (new feature across iOS + backend, ~2-3 weeks)

---

### G-10: Crash Recovery During Recovery Is Unprotected

**Severity**: Low
**Area**: Resilience

**Description**: The orphan call recovery system (`checkAndRecoverOrphanCalls`) detects stale calls and cleans them up. However, if the app crashes **during** the recovery process itself (e.g., while calling `CallKit.reportCallEnded`), the partially-recovered state could leave both persisted state and CallKit in an inconsistent state.

**Evidence**:
- `Z360VoIPService.swift` lines 354-427: Recovery reads persisted state, iterates orphan calls, reports to CallKit, clears state
- `VoipStore.swift` lines 238-286: State persisted to UserDefaults -- not transactional
- No "recovery in progress" flag that would prevent re-entry

**Impact**:
- Extremely rare scenario (crash during crash recovery)
- Could leave ghost entries in CallKit that don't correspond to real calls
- User sees phantom "call in progress" indicator until next app restart

**Suggested Fix**:
1. Add a `recoveryInProgress` flag to UserDefaults before starting recovery
2. On next launch, if flag is set, perform a full state wipe (nuclear cleanup)
3. Use atomic write operations for state updates during recovery

**Effort Estimate**: Small (add flag-based re-entry protection)

---

## 6. Strengths (No Gap)

These areas were analyzed and found to be **well-implemented** with no significant gaps:

### S-01: PushKit → CallKit Reporting Path (Same-Org)
The synchronous path from PushKit push receipt to `reportNewIncomingCall` is well-implemented and well within the 5-second deadline for same-org calls. Multiple CRITICAL comments document the timing requirement. The `PushCorrelator` 500ms timeout provides sufficient margin.

**Evidence**: `PushKitManager.swift` lines 1028-1029, `CallKitManager.swift` lines 552-594

### S-02: Two-Phase Startup Design
The deferred initialization pattern successfully prevents the 37-43 second WebKit IPC starvation. Phase 1 handles only Apple-mandated PushKit + minimal CallKit wiring. This is a significant engineering achievement for a hybrid app.

**Evidence**: `AppDelegate.swift` lines 10293-10314, `SceneDelegate.swift` lines 10733-10750

### S-03: Audio Session Lifecycle
Audio activation is correctly delegated to CallKit's `didActivate`/`didDeactivate` callbacks. Z360 does NOT prematurely activate the audio session, unlike the Telnyx demo which calls `setActive(true)` in `configureAudioSession()`.

**Evidence**: `CallKitManager.swift` lines 893-900, `TelnyxService.swift` lines 3247-3263

### S-04: Outbound Calling Implementation
Despite initial appearance, outbound calling is thoroughly implemented with:
- Parameter validation (`validateDestinationNumber`)
- Double-tap prevention (`ActionGuard`)
- Single-call enforcement (`ActiveCallGuard`)
- CallKit integration (`startCall` → `reportOutgoingCallConnected`)
- Cancel support for pending calls
- Firebase analytics logging
- Crash recovery state persistence on `ACTIVE` transition

**Evidence**: `Z360VoIPService.swift` lines 4949-5119, `CallKitManager.swift` lines 661-681, `TelnyxService.swift` lines 3142-3179

### S-05: PushCorrelator Thread Safety
Using a Swift `actor` for `PushCorrelator` ensures thread-safe coordination without manual locking. Entry expiry (30s) prevents memory leaks. Cleanup runs after each push processing.

**Evidence**: `PushCorrelator.swift` lines 2483 (actor), 2495-2496 (expiry), 491-492 (cleanup)

### S-06: Crash Recovery / Orphan Cleanup
Strong implementation detecting stale calls with 1-hour threshold, reporting to CallKit, and notifying JavaScript layer. `VoipStore` provides persistence across app restarts.

**Evidence**: `Z360VoIPService.swift` lines 354-427, `VoipStore.swift` lines 238-286

### S-07: Weak Reference Patterns
Proper use of `[weak self]` in closures throughout TelnyxService, OrganizationSwitcher, and other components prevents retain cycles.

**Evidence**: `TelnyxService.swift` lines 405, 463, 473, 484, 492, 502, 521, 545

### S-08: Network Resilience
Full `NWPathMonitor` implementation with 500ms debouncing, 30-second reconnection timeout, and call-aware state transitions. Significantly beyond the Telnyx demo (which has no network monitoring).

**Evidence**: `NetworkMonitor.swift` lines 7142-7306, 7275-7279

---

## 7. Effort Summary

| Effort | Count | Gaps |
|--------|-------|------|
| Small | 5 | G-03, G-05, G-07, G-08, G-10 |
| Medium | 3 | G-01, G-02, G-04 |
| Large | 2 | G-06, G-09 |

**Recommended Priority Order**:
1. **G-01** (Critical) — Cross-org switch timing. Risk of Apple revoking VoIP push capability.
2. **G-04** (High) — Cold-start initialization. Affects every background-woken call.
3. **G-08** (Medium) — Active call protection. Prevents call drops during org switch.
4. **G-03** (High) — Audio restoration on failed switch. Prevents broken audio state.
5. **G-02** (High) — CallKit display update. Improves UX for delayed pushes.
6. **G-07** (Medium) — Firebase logging. Enables cold-start call debugging.
7. **G-05** (Medium) — WebView isolation guard. Low probability but catastrophic impact.
8. **G-06** (Medium) — God Object decomposition. Long-term maintainability.
9. **G-10** (Low) — Recovery re-entry protection. Edge case hardening.
10. **G-09** (Low) — Sign In with Apple. New feature, not a bug.

---

*Generated: 2026-02-08*
*Sources: voip-ios skill, voip-ios-platform skill, telnyx-ios-demo.xml pack, ios-platform-requirements.md, telnyx-sdks-reference.md, system-architecture-unified.md*
