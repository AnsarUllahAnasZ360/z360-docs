---
title: iOS Architecture Complete
---

# Z360 iOS Architecture: Complete Reference

> **Scope**: Comprehensive iOS VoIP architecture document synthesizing current implementation state, target architecture, and gap analysis with prioritized implementation roadmap.
>
> **Date**: 2026-02-08
>
> **Source documents**:
> - `ios-current-state.md` — Current implementation across 25 Swift files (10,636 lines)
> - `ios-target-architecture.md` — Target design based on Telnyx SDK patterns, Apple requirements, and Z360 constraints
> - `ios-gap-analysis.md` — 10 gaps identified (1 Critical, 3 High, 4 Medium, 2 Low), plus 8 documented strengths

---

## Executive Summary

Z360's iOS VoIP layer is a **native Swift implementation** operating independently of the Capacitor WebView. It provides full VoIP calling capability using the Telnyx WebRTC SDK, Apple's CallKit for system call UI, and PushKit for VoIP push notification handling. The codebase spans **25 Swift files totaling 10,636 lines**.

### What's Working Well

The implementation demonstrates strong engineering in several critical areas:

1. **Two-phase startup** prevents WebKit IPC starvation (37-43s freeze reduced to ~2s launch)
2. **PushKit → CallKit reporting** meets Apple's 5-second deadline for same-org calls
3. **Audio session lifecycle** correctly delegates activation to CallKit callbacks
4. **Outbound calling** is thoroughly implemented with double-tap prevention, single-call enforcement, and crash recovery
5. **Swift Actor isolation** (VoipStore, PushCorrelator, ActionGuard, ActiveCallGuard) ensures thread safety
6. **Network resilience** with NWPathMonitor, 500ms debouncing, and 30-second reconnection timeout

### What Needs Urgent Attention

1. **Critical**: Cross-org switch timing has only 0.5-1.0s margin against Apple's 5-second CallKit deadline — risk of permanent VoIP push revocation
2. **High**: PushCorrelator cannot update CallKit display after initial fallback report ("Unknown Caller" persists)
3. **High**: Audio session not restored on failed org switch — broken audio state
4. **High**: Cold-start push arrives before Phase 2 initialization completes — delayed/no audio
5. **Architectural**: Z360VoIPService is a 2,253-line God Object with 12+ dependencies that needs decomposition

### Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────┐
│                    iOS App Layer                              │
│                                                              │
│  AppDelegate (Phase 1)  →  SceneDelegate (Phase 2)          │
│  PushKit + minimal wiring   Audio + Firebase + Network       │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    VoIP Orchestration Layer                    │
│                                                              │
│  Z360VoIPService ← Central orchestrator (2,253 lines)        │
│  ├── TelnyxService      (Telnyx SDK wrapper)                 │
│  ├── CallKitManager     (CXProvider + CXCallController)      │
│  ├── PushKitManager     (PKPushRegistry + push dispatch)     │
│  ├── PushCorrelator     (Two-push sync, Swift Actor)         │
│  ├── AudioManager       (Mute/Hold/Speaker/DTMF)            │
│  ├── OrganizationSwitcher (Cross-org credential switch)      │
│  ├── NetworkMonitor     (NWPathMonitor + reconnection)       │
│  ├── ActionGuard        (Double-tap prevention, Actor)       │
│  ├── ActiveCallGuard    (Single-call enforcement, Actor)     │
│  └── VoipStore          (Keychain + UserDefaults, Actor)     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    Bridge Layer                                │
│                                                              │
│  TelnyxVoipPlugin  ← Capacitor CAPBridgedPlugin             │
│  21 @objc methods, 22+ event types to JavaScript             │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    WebView Layer (React SPA)                   │
│                                                              │
│  NativeVoipProvider → useTelnyxVoip hook → UI components     │
│  (Replaces TelnyxRTCProvider on native platforms)            │
└──────────────────────────────────────────────────────────────┘
```

---

## Part 1: Current Implementation State

### 1.1 Component Inventory

| Component | File | Lines | Role |
|-----------|------|------:|------|
| Z360VoIPService | `ios/App/App/VoIP/Services/Z360VoIPService.swift` | 2,253 | Central orchestrator |
| PushKitManager | `ios/App/App/VoIP/Managers/PushKitManager.swift` | 949 | VoIP push handling |
| VoIPLogger | `ios/App/App/VoIP/Utils/VoIPLogger.swift` | 711 | Structured logging |
| TelnyxService | `ios/App/App/VoIP/Services/TelnyxService.swift` | 667 | Telnyx SDK wrapper |
| PushCorrelator | `ios/App/App/VoIP/Services/PushCorrelator.swift` | 611 | Two-push synchronization |
| OrganizationSwitcher | `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | 481 | Cross-org switching |
| CallKitManager | `ios/App/App/VoIP/Managers/CallKitManager.swift` | 456 | System call UI |
| AudioManager | `ios/App/App/VoIP/Managers/AudioManager.swift` | 445 | Audio routing |
| NetworkMonitor | `ios/App/App/VoIP/Utils/NetworkMonitor.swift` | 419 | Connectivity monitoring |
| VoipStore | `ios/App/App/VoIP/Services/VoipStore.swift` | 343 | Persistent state |
| AppDelegate | `ios/App/App/AppDelegate.swift` | 336 | App lifecycle |
| CallQualityMonitor | `ios/App/App/VoIP/Utils/CallQualityMonitor.swift` | 286 | Quality metrics |
| TelnyxVoipPlugin | `ios/App/App/VoIP/TelnyxVoipPlugin.swift` | ~900 | Capacitor bridge |
| KeychainManager | `ios/App/App/VoIP/Utils/KeychainManager.swift` | 111 | Secure credential storage |
| SceneDelegate | `ios/App/App/SceneDelegate.swift` | 89 | Phase 2 trigger |
| Others (10 files) | Various | ~979 | Guards, models, protocols, utils |

### 1.2 Two-Phase Startup (Current)

**Phase 1** — `AppDelegate.didFinishLaunchingWithOptions` (~50ms):
1. `PushKitManager.shared.initialize()` — PKPushRegistry on main queue
2. `Z360VoIPService.shared.setupMinimal(callKitManager:)` — Delegate wiring only
3. `UNUserNotificationCenter.current().delegate = self`
4. **Nothing else** — no audio, no Firebase, no network

**Phase 2** — `SceneDelegate.sceneDidBecomeActive()`:
1. `configureAudioSessionForVoIP()` — `.playAndRecord` + `.voiceChat`
2. `startNetworkMonitoringIfNeeded()` — NWPathMonitor
3. `initializeFirebase()` — Background queue, Crashlytics + Analytics
4. `checkSessionExpiry()` — 7-day VoIP token TTL
5. `cleanupOrphanCallState()` — Crash recovery

**Why this split**: `AVAudioSession.setCategory()` triggers the `mediaserverd` audio daemon. During cold launch, this daemon initialization starves WebKit's IPC pipe — Mach messages between the WebView process and the app process are blocked. Measured impact: **37-43 seconds** on real devices without mitigation. With two-phase: **~2 seconds**.

### 1.3 Two-Push Correlation System

Z360 uses a **server-mediated push model** generating two independent pushes per incoming call:

| Push Source | Content | Purpose |
|-------------|---------|---------|
| **Z360 Backend** (APNs VoIP) | Caller name, avatar, org context, call ID | Rich display info from contact database |
| **Telnyx Platform** (APNs VoIP) | Call ID, signaling server, SDP info | Call control metadata for SDK connection |

**PushCorrelator** (Swift Actor) matches them by normalized phone number (last 10 digits) within a configurable timeout (500ms-1.5s). Three scenarios:

1. **Z360 first (~60%)**: Report to CallKit with full display → Telnyx arrives → merge and connect
2. **Telnyx first (~35%)**: Report to CallKit with phone only → wait up to 500ms → Z360 arrives → merge
3. **Timeout (~5%)**: Report to CallKit with phone only → proceed with partial info

### 1.4 Delegate Protocol Chain

```
Apple CallKit System
    ↓ CXProviderDelegate
CallKitManager
    ↓ CallKitManagerDelegate
Z360VoIPService (central orchestrator)
    ↑ TelnyxServiceDelegate
TelnyxService
    ↑ TxClientDelegate
Telnyx SDK (TxClient)

Z360VoIPService
    ↓ Z360VoIPServicePluginDelegate
TelnyxVoipPlugin
    ↓ notifyListeners()
WebView (React SPA via Capacitor bridge)
```

7 delegate protocols define the component communication boundaries:
- `TelnyxServiceDelegate` → Z360VoIPService
- `CallKitManagerDelegate` → Z360VoIPService
- `AudioManagerDelegate` → TelnyxVoipPlugin
- `NetworkMonitorDelegate` → Z360VoIPService
- `CallQualityMonitorDelegate` → Z360VoIPService
- `CallTimerManagerDelegate` → Z360VoIPService
- `Z360VoIPServicePluginDelegate` → TelnyxVoipPlugin

### 1.5 Telnyx SDK Integration

Z360 diverges from the Telnyx demo app in several important ways:

| Aspect | Telnyx Demo | Z360 Implementation |
|--------|-------------|---------------------|
| Push delivery | SDK-managed push binding | Z360 backend sends push directly via APNs |
| Push payload | SDK-defined metadata only | Custom payload with org context, avatar, caller info |
| Push processing | `processVoIPNotification()` | Two-push correlation + custom processing |
| Audio init | Immediate in `didFinishLaunching` | Deferred to `sceneDidBecomeActive` (Phase 2) |
| Audio activation | Direct `setActive(true)` | CallKit-managed via `didActivate` callback only |
| Org switching | None (single-tenant) | Full cross-org with credential regeneration + rollback |
| Connection | `forceRelayCandidate: false` (default) | `forceRelayCandidate: true` (avoids Local Network prompt) |
| Quality metrics | Not enabled | `enableQualityMetrics: true` + CallQualityMonitor |
| Codecs | SDK defaults | Opus @ 48kHz preferred |
| Reconnection | SDK built-in | SDK + OrganizationSwitcher for cross-org |

### 1.6 State Persistence Model

| Data | Storage | Reason |
|------|---------|--------|
| SIP credentials | Keychain (`kSecAttrAccessibleWhenUnlocked`) | Security — accessible when device unlocked |
| VoIP push token | UserDefaults | Needed across restarts, not sensitive |
| Token timestamp | UserDefaults | Session expiry check (7-day TTL) |
| Active call state | UserDefaults + Memory | Crash recovery (US-026) |
| Organization context | UserDefaults | Cross-org detection |
| Call display info | In-memory only | Transient per-call data |
| Incoming call meta | In-memory only | Transient per-call data |
| Pending incoming call | UserDefaults | Cold start recovery (app killed → push) |

### 1.7 Timing Constraints

| Constraint | Value | Consequence of Violation |
|-----------|-------|--------------------------|
| PushKit → CallKit report | **5 seconds** | **App terminated by iOS** |
| Push correlation timeout | 500ms-1.5s | Partial caller info displayed |
| SDK reconnection timeout | 5s | Answer may fail |
| Cross-org switch total | 4.5s max | Switch fails, rollback |
| API request timeout | 4.0s | OrganizationSwitchError |
| Network reconnection | 30s | Call dropped gracefully |
| Ring timeout | 30s | Treated as missed call |
| Session expiry | 7 days | VoIP data cleared |
| Audio activation retry | 5s | Call may have no audio |
| Debounce (network) | 500ms | Filters brief blips |

### 1.8 Known Technical Debt

1. **PushKitManager TODO (line ~1783)**: VoIP token registration with backend not implemented in native code
2. **PushKitManager TODO (line ~1836)**: Token cleanup on invalidation not implemented
3. **`forceRelayCandidate: true`**: Forces all media through TURN relay servers, adding latency — avoids iOS Local Network prompt but at a cost
4. **Cookie-based auth for org switch**: `OrganizationSwitcher` reads cookies from `WKWebsiteDataStore` — fragile coupling between native and WebView state
5. **Dual path for call end**: Both `callStateDidChange(.done)` and `remoteCallEnded()` can fire for same call — deduplicated via `callEndProcessedForUUID` flag but fragile

---

## Part 2: Target Architecture

### 2.1 Initialization Sequence (Target)

The two-phase startup is architecturally correct and should be preserved. The target adds one refinement:

**Enhancement**: When a VoIP push arrives during cold start (between Phase 1 and Phase 2), trigger Phase 2 initialization from the PushKit handler rather than waiting for `sceneDidBecomeActive`. This ensures audio configuration and SDK connection happen immediately for cold-start calls.

```
Phase 1 (AppDelegate, ~50ms)          Phase 2 (Trigger varies)
├── PushKitManager.initialize()        ├── configureAudioSessionForVoIP()
├── Z360VoIPService.setupMinimal()     ├── startNetworkMonitoring()
├── UNUserNotificationCenter           ├── configureFirebase() [background queue]
└── return true                        ├── checkSessionExpiry()
                                       └── cleanupOrphanCallState()
Trigger:
  Normal launch → sceneDidBecomeActive
  Cold-start push → PushKit handler (NEW)
```

### 2.2 PushKit/CallKit Contract (Target)

The non-negotiable principle: **Report first, correlate later.**

```
VoIP Push arrives (T+0ms)
  ├── Extract caller info from payload (T+1ms)
  ├── Generate or extract CallKit UUID (T+2ms)
  ├── *** REPORT TO CALLKIT IMMEDIATELY *** (T+3ms)
  │   └── CXProvider.reportNewIncomingCall()
  │   └── Use whatever data is available
  ├── iOS shows system call UI (T+5ms)
  └── AFTER CallKit report (async, non-blocking):
      ├── Feed PushCorrelator for two-push sync
      ├── Ensure Telnyx SDK connected (Keychain credentials)
      ├── Persist call info to VoipStore
      └── Update CallKit display when richer data arrives (NEW)

TOTAL: Push → CallKit report in ~5ms
Safety margin: ~4,995ms (1000x margin)
```

**Key target improvement**: Implement `CXCallUpdate` refresh path so CallKit display updates when Z360 push arrives after initial Telnyx-only report.

### 2.3 Call State Machine (Target)

```
                                ┌─────────┐
                                │  IDLE   │
                                └────┬────┘
                    ┌────────────────┼────────────────┐
               VoIP push       JS makeCall()     crash recovery
                    │                │                │
                    ▼                ▼                ▼
              ┌───────────┐   ┌───────────┐    ┌──────────┐
              │RINGING_IN │   │RINGING_OUT│    │  FAILED  │──→ IDLE
              └─────┬─────┘   └─────┬─────┘
           ┌────────┼────┐          │
      user Answer  Decline  timeout │
           │        │    │          │
           │        ▼    ▼          │
           │   DISCONNECTING ◄──────┤ (remote hangs up from any state)
           │        │               │
           │     ENDED → IDLE       │
           │                        │
           ▼                        ▼
     CONNECTING               CONNECTING
           │                        │
     SDP + audio             SDP + audio
           │                        │
           ▼                        ▼
       ACTIVE                   ACTIVE
     ┌────┼──────┐                  │
  hold() network end            (same)
     │    drop    │
     ▼    │       │
  ON_HOLD │  DISCONNECTING
     │    ▼
  unhold RECONNECTING
     │  ┌────┼────┐
     │ success  failure
     │    │       │
     ▼    ▼       ▼
  ACTIVE      FAILED → IDLE
```

**CallKit Action → State Mapping**:

| CallKit Action | From State | To State | Side Effects |
|---|---|---|---|
| `CXAnswerCallAction` | RINGING_IN | CONNECTING | ActionGuard, cross-org switch if needed, SDK answer |
| `CXStartCallAction` | IDLE | RINGING_OUT | ActiveCallGuard acquire, SDK newCall |
| `CXEndCallAction` | Any active | DISCONNECTING | SDK hangup, audio cleanup |
| `CXSetMutedCallAction` | ACTIVE/ON_HOLD | Same | AudioManager.setMute() |
| `CXSetHeldCallAction` | ACTIVE | ON_HOLD | AudioManager.setHold(), auto-mute (BUG-012) |
| `CXPlayDTMFCallAction` | ACTIVE | ACTIVE | AudioManager.sendDTMF() |
| `didActivate audioSession` | CONNECTING | ACTIVE | TelnyxService.enableAudioSession() |
| `didDeactivate audioSession` | Any → ENDED | ENDED | TelnyxService.disableAudioSession() |

### 2.4 Platform Isolation (Target)

The target uses a **provider swap pattern** to prevent dual VoIP stacks:

```
if (Capacitor.isNativePlatform()) {
  // NativeVoipProvider — bridges to native TelnyxVoipPlugin
  // Does NOT create WebSocket to Telnyx
  // Does NOT import @telnyx/react-client
  // All call handling delegated to native layer
} else {
  // TelnyxRTCProvider — browser-based WebRTC
  // Direct WebSocket connection to Telnyx
}
```

**Target enhancement**: Add native-side `isNativeVoIPActive` flag in TelnyxVoipPlugin to prevent any WebRTC-related JavaScript calls when native VoIP is handling a call (defense-in-depth).

### 2.5 Audio Session Management (Target)

CallKit owns the audio session for VoIP calls:

1. **Phase 2**: Configure only (`setCategory(.playAndRecord, .voiceChat)`) — do NOT activate
2. **Call connects**: CallKit activates internally → `didActivate(audioSession:)` fires → `TelnyxService.enableAudioSession()`
3. **Call ends**: CallKit deactivates → `didDeactivate(audioSession:)` fires → `TelnyxService.disableAudioSession()`

Audio routes: Earpiece (default) ↔ Speaker ↔ Bluetooth (automatic when connected). Hold triggers auto-mute (BUG-012 pattern) with state restoration on unhold.

### 2.6 Outbound Call Flow (Target)

```
User taps Call in WebView
  → Capacitor bridge (~5ms)
  → TelnyxVoipPlugin.makeCall()
  → Z360VoIPService.makeCall()
    ├── Validate destination number
    ├── ActionGuard.tryStartAction(.makeCall)
    ├── ActiveCallGuard.acquire(callId: uuid)
    ├── CXStartCallAction via CallKit
    ├── action.fulfill() (synchronous — critical)
    ├── TelnyxService.makeCall() → Verto INVITE
    ├── Call transitions: NEW → CONNECTING → RINGING → ACTIVE
    ├── CallKit didActivate → audio flows
    └── call.resolve(["callId": callUUID])

Total: user taps → hears ringing in ~300-600ms
```

### 2.7 CallKit UI Customization

| Element | Customizable? | Z360 Config |
|---|---|---|
| App name | At init only | "Z360" (CFBundleDisplayName) |
| App icon | At init only | 40x40pt monochrome PNG template |
| Ringtone | At init only | Custom `.caf` file (<30s) |
| Caller name | Yes, updatable | From Z360 push or "Unknown Caller" |
| Phone number | Yes, updatable | From push payload |
| Recents | Config flag | `includesCallsInRecents = true` |
| Video | Config flag | `supportsVideo = false` |
| Max calls | Config | `maximumCallsPerCallGroup = 1` |

### 2.8 Sign in with Apple (Target — New Feature)

```
User taps "Sign in with Apple"
  → ASAuthorizationController presents system sheet
  → Face ID / Touch ID / password
  → ASAuthorizationAppleIDCredential received
  → POST /api/auth/apple { identity_token, authorization_code, full_name, email }
  → Laravel verifies Apple JWT, creates session
  → Native sets session cookie in WKWebsiteDataStore
  → WebView loads dashboard
  → useTelnyxVoip registers device → SIP credentials provisioned → SDK connects
```

Currently: **zero implementation**. Requires backend API, native authentication flow, and credential lifecycle integration.

---

## Part 3: Gap Analysis

### 3.1 Gap Summary

| # | Gap | Severity | Effort | Impact |
|---|-----|----------|--------|--------|
| **G-01** | Cross-org switch timing margin (0.5-1.0s) | **Critical** | Medium | Apple revokes VoIP push permanently |
| **G-02** | No CallKit display update after fallback | **High** | Medium | "Unknown Caller" persists for legitimate calls |
| **G-03** | Audio not restored on failed org switch | **High** | Small | Broken audio state, requires restart |
| **G-04** | Cold-start push before Phase 2 init | **High** | Medium | Delayed/no audio on cold-start calls |
| **G-05** | No native WebView/call isolation guard | **Medium** | Small | Both VoIP stacks could handle same call |
| **G-06** | Z360VoIPService God Object (2,253 lines) | **Medium** | Large | Maintenance burden, regression risk |
| **G-07** | Firebase logging disabled during cold-start | **Medium** | Small | Zero observability for critical calls |
| **G-08** | No active call check before org switch | **Medium** | Small | Both calls dropped during switch |
| **G-09** | Sign In with Apple — zero implementation | **Low** | Large | Missing platform expectation |
| **G-10** | Crash recovery re-entry unprotected | **Low** | Small | Ghost calls on extremely rare double-crash |

### 3.2 Critical Gap Detail: G-01 Cross-Org Switch Timing

**The problem**: Apple's PushKit contract demands CallKit reporting within 5 seconds. Z360's cross-org switch allocates:
- 4.0s for API request (`requestTimeoutSeconds`)
- 4.5s total cap (`maxSwitchTimeSeconds`)
- Remaining: **0.5-1.0s** for SDK reconnection + credential storage + call answering

Under CPU load (cold start, background wake), the 50ms polling intervals for SDK readiness could overshoot.

**Evidence**: `OrganizationSwitcher.swift:8050-8054`, `Z360VoIPService.swift:4545`

**Recommended fix**: **Decouple CallKit reporting from org switch.** Report to CallKit immediately with placeholder info. Perform org switch in background. Update CallKit display via `provider.reportCall(with:updated:)` after switch completes. This gives the full 5 seconds for the CallKit report (used in ~5ms) and unlimited time for the org switch (runs in parallel).

### 3.3 High Gap Details

**G-02 — PushCorrelator display update**: When Z360 push arrives after the 500ms timeout, the "Unknown Caller" display persists. Fix: Add `CXCallUpdate` refresh path triggered by late PushCorrelator matches.

**G-03 — Audio restoration on failed org switch**: `OrganizationSwitcher.restoreOriginalOrgContext()` restores credentials and org state but ignores AVAudioSession and AudioManager state. Fix: Save/restore audio configuration alongside credential rollback.

**G-04 — Cold-start initialization gap**: Between Phase 1 and Phase 2, the push handler operates without audio config, SDK connection, or Firebase. Fix: Trigger deferred initialization from the PushKit handler on cold-start wake, before `sceneDidBecomeActive`.

### 3.4 Documented Strengths

These areas are well-implemented with no gaps:

| Area | Status | Evidence |
|------|--------|----------|
| PushKit → CallKit path (same-org) | Strong | Well within 5s, multiple CRITICAL comments |
| Two-phase startup design | Strong | 37-43s → ~2s launch time |
| Audio session lifecycle | Strong | CallKit-managed activation, no premature setActive |
| Outbound calling | Strong | Full validation, guards, crash recovery, cancel support |
| PushCorrelator thread safety | Strong | Swift Actor, entry expiry, cleanup |
| Crash recovery / orphan cleanup | Strong | Persisted state, 1-hour threshold, CallKit reporting |
| Weak reference patterns | Strong | Consistent `[weak self]` throughout |
| Network resilience | Strong | NWPathMonitor, debouncing, call-aware transitions |

---

## Part 4: Implementation Roadmap

### Phase 1: Critical Fixes (Week 1-2)

| Priority | Gap | Action | Effort |
|----------|-----|--------|--------|
| 1 | **G-01** | Decouple CallKit reporting from org switch — report first, switch in background | Medium |
| 2 | **G-04** | Trigger Phase 2 init from PushKit handler on cold-start wake | Medium |
| 3 | **G-08** | Add active call guard before org switch initiation | Small |

**Rationale**: G-01 is the only gap that risks permanent VoIP capability loss. G-04 affects every cold-start call. G-08 prevents call drops during the org switch.

### Phase 2: High-Priority UX & Reliability (Week 3-4)

| Priority | Gap | Action | Effort |
|----------|-----|--------|--------|
| 4 | **G-03** | Add audio state save/restore to OrganizationSwitcher | Small |
| 5 | **G-02** | Implement CXCallUpdate refresh for late Z360 push matches | Medium |
| 6 | **G-07** | Add os_log fallback + log buffering in VoIPLogger | Small |

**Rationale**: G-03 and G-02 directly impact call quality/UX. G-07 enables debugging of the cold-start path fixed in Phase 1.

### Phase 3: Defensive Hardening (Week 5-6)

| Priority | Gap | Action | Effort |
|----------|-----|--------|--------|
| 7 | **G-05** | Add native-side `isNativeVoIPActive` flag in TelnyxVoipPlugin | Small |
| 8 | **G-10** | Add recovery-in-progress flag and re-entry protection | Small |

**Rationale**: Low probability but important defense-in-depth measures.

### Phase 4: Architecture & New Features (Week 7+)

| Priority | Gap | Action | Effort |
|----------|-----|--------|--------|
| 9 | **G-06** | Decompose Z360VoIPService into focused handlers | Large |
| 10 | **G-09** | Implement Sign In with Apple (iOS + backend) | Large |

**Recommended decomposition for G-06**:
1. `IncomingCallHandler` — incoming call orchestration, push routing, cross-org detection
2. `OutboundCallHandler` — outbound call initiation, validation, cancel logic
3. `CallStateManager` — state persistence, orphan recovery, crash recovery
4. `CrossOrgCoordinator` — org switch orchestration (builds on existing `OrganizationSwitcher`)
5. `Z360VoIPService` remains as thin facade delegating to these handlers

### Additional Technical Debt to Address

| Item | File | Description |
|------|------|-------------|
| VoIP token registration | PushKitManager ~line 1783 | TODO: Send token to Z360 backend |
| Token cleanup | PushKitManager ~line 1836 | TODO: Notify backend to remove old token |
| TURN relay forcing | TelnyxService | `forceRelayCandidate: true` adds latency — investigate selective approach |
| Cookie-based auth | OrganizationSwitcher | WKWebsiteDataStore coupling — consider API token-based auth |
| Dual call-end handling | Z360VoIPService | Fragile `callEndProcessedForUUID` dedup flag |

---

## Part 5: Key Architecture Patterns Reference

### Pattern 1: Two-Phase Startup
**Problem**: AVAudioSession starves WebKit IPC.
**Solution**: Phase 1 (PushKit + CallKit only), Phase 2 (everything else after WebView loads).
**Files**: `AppDelegate.swift`, `SceneDelegate.swift`

### Pattern 2: Two-Push Correlation
**Problem**: Two independent push systems must be correlated.
**Solution**: PushCorrelator Swift Actor, phone normalization (last 10 digits), 500ms timeout.
**Files**: `PushCorrelator.swift`, `PushKitManager.swift`

### Pattern 3: Report First, Correlate Later
**Problem**: Must report to CallKit within 5 seconds.
**Solution**: Report immediately with available data. Update display info asynchronously.
**Files**: `PushKitManager.swift`, `CallKitManager.swift`

### Pattern 4: Actor Isolation
**Problem**: Thread-safe state across concurrent contexts.
**Solution**: Swift Actors for VoipStore, PushCorrelator, ActionGuard, ActiveCallGuard.
**Files**: Respective actor files

### Pattern 5: Cross-Org Rollback
**Problem**: Org switch can fail mid-way through credential regeneration.
**Solution**: Capture original context, switch, rollback on any failure.
**Files**: `OrganizationSwitcher.swift`

### Pattern 6: Auto-Mute on Hold (BUG-012)
**Problem**: Audio leaks during hold negotiation.
**Solution**: Save mute state → auto-mute → hold → unhold → restore mute state.
**Files**: `AudioManager.swift`

### Pattern 7: Lazy Initialization
**Problem**: Singleton cascade starves WebKit during load.
**Solution**: All Z360VoIPService dependencies are `lazy var`.
**Files**: `Z360VoIPService.swift`

### Pattern 8: Cold Start Persistence
**Problem**: App killed, VoIP push arrives, WebView not loaded.
**Solution**: Persist call data to UserDefaults. Plugin reads on WebView load.
**Files**: `PushKitManager.swift`, `TelnyxVoipPlugin.swift`

### Pattern 9: Crash Recovery (US-026)
**Problem**: App crashes during active call.
**Solution**: Persist PersistableCallState on call active. Detect and clean up on next launch.
**Files**: `VoipStore.swift`, `AppDelegate.swift`, `Z360VoIPService.swift`

### Pattern 10: Double-Tap Prevention (BUG-005)
**Problem**: Users can double-tap answer/decline/call buttons.
**Solution**: ActionGuard actor with atomic check-and-set.
**Files**: `ActionGuard.swift`, `Z360VoIPService.swift`

---

## Appendix: File Reference Index

### iOS Native VoIP Files

| File | Lines | Purpose |
|---|---|---|
| `ios/App/App/AppDelegate.swift` | 336 | Two-phase startup |
| `ios/App/App/SceneDelegate.swift` | 89 | Phase 2 trigger |
| `ios/App/App/VoIP/TelnyxVoipPlugin.swift` | ~900 | Capacitor bridge (21 methods) |
| `ios/App/App/VoIP/Services/Z360VoIPService.swift` | 2,253 | Central orchestrator |
| `ios/App/App/VoIP/Services/TelnyxService.swift` | 667 | Telnyx SDK wrapper |
| `ios/App/App/VoIP/Services/PushCorrelator.swift` | 611 | Two-push sync |
| `ios/App/App/VoIP/Services/VoipStore.swift` | 343 | Keychain + UserDefaults |
| `ios/App/App/VoIP/Managers/CallKitManager.swift` | 456 | CXProvider + CXCallController |
| `ios/App/App/VoIP/Managers/PushKitManager.swift` | 949 | VoIP push handling |
| `ios/App/App/VoIP/Managers/AudioManager.swift` | 445 | Mute/Hold/Speaker/DTMF |
| `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | 481 | Cross-org credential switch |
| `ios/App/App/VoIP/Utils/NetworkMonitor.swift` | 419 | NWPathMonitor + reconnection |
| `ios/App/App/VoIP/Utils/CallQualityMonitor.swift` | 286 | MOS/Jitter/RTT |
| `ios/App/App/VoIP/Utils/VoIPLogger.swift` | 711 | Structured logging + Crashlytics |
| `ios/App/App/VoIP/Utils/KeychainManager.swift` | 111 | Keychain operations |
| `ios/App/App/VoIP/Utils/ActionGuard.swift` | ~60 | Double-tap prevention |
| `ios/App/App/VoIP/Utils/ActiveCallGuard.swift` | ~80 | Single-call enforcement |
| `ios/App/App/VoIP/Utils/CallTimerManager.swift` | ~100 | Call duration |
| `ios/App/App/VoIP/Utils/NotificationHelper.swift` | ~100 | Missed call notifications |
| `ios/App/App/VoIP/Models/CallInfo.swift` | 61 | Call metadata |
| `ios/App/App/VoIP/Models/VoIPModels.swift` | 169 | SIP creds, states, errors |

### Frontend Files

| File | Purpose |
|---|---|
| `resources/js/plugins/telnyx-voip.ts` | Plugin interface + registration |
| `resources/js/plugins/telnyx-voip-web.ts` | Web fallback (no-op stubs) |
| `resources/js/plugins/use-telnyx-voip.ts` | React hook for VoIP |
| `resources/js/providers/native-voip-provider.tsx` | Native VoIP React provider |
| `resources/js/utils/platform.ts` | Platform detection |

### Backend Files

| File | Purpose |
|---|---|
| `app/Services/PushNotificationService.php` | FCM/APNs push dispatch |
| `app/Services/ApnsVoipService.php` | APNs VoIP push |
| `app/Services/CPaaSService.php` | Credential management |
| `app/Http/Controllers/Api/DeviceTokenController.php` | Device registration |
| `app/Http/Controllers/Api/VoipCredentialController.php` | VoIP credentials API |

---

*Generated: 2026-02-08*
*Team: ios-architecture (3 teammates + lead)*
*Sources: voip-ios skill, voip-ios-platform skill, voip-architecture skill, telnyx-ios-sdk.xml pack, telnyx-ios-demo.xml pack, prerequisite whitepaper documents (Sessions 01-04)*
