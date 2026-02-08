---
title: Network And System Failures
---

# Network and System Failure Modes — Complete Reference

> **Session 09 | Task #3** — Comprehensive analysis of every network failure, system failure, and environmental edge case affecting Z360 VoIP reliability across Web, iOS, Android, and Laravel backend.
>
> **Date**: 2026-02-08
> **Scope**: Network transitions, connectivity loss, infrastructure failures, device power management, and recovery mechanisms

---

## Executive Summary

This document catalogs **25 distinct failure modes** across 5 categories that can cause Z360 VoIP calls to fail, drop, or degrade. Each failure mode is analyzed for probability, user impact, current mitigation, and recommended improvements.

### Failure Mode Distribution

| Category | Count | Critical | High | Medium |
|----------|-------|----------|------|--------|
| Network & Connectivity | 8 | 2 | 3 | 3 |
| App Lifecycle | 4 | 1 | 2 | 1 |
| Infrastructure | 5 | 3 | 1 | 1 |
| External Services | 4 | 2 | 1 | 1 |
| Device & Platform | 4 | 0 | 2 | 2 |
| **Total** | **25** | **8** | **9** | **8** |

### Top 5 Most Critical Failures

1. **FM-05** — Backend restart during active call (Redis flushed, all coordination lost)
2. **FM-03** — App crash during active call (call continues on Telnyx side, user unaware)
3. **FM-02** — Complete network loss without recovery (call abandoned, no cleanup)
4. **FM-08** — Firebase/APNs outage (all incoming calls missed silently)
5. **FM-07** — Telnyx API unavailable during credential creation (registration fails permanently)

### What Happens During Each Failure

```
Network Drop (WiFi → None)
  ├─ iOS: NetworkMonitor detects → 30s reconnection timeout → CallKit reports dropped
  ├─ Android: GAP — no network monitoring → call continues until Telnyx timeout
  └─ Web: WebSocket drops → 'destroy' state → UI reverts to dialpad

App Crash (During Active Call)
  ├─ iOS: PersistableCallState persisted → next launch detects orphan → reports ended
  ├─ Android: CallStatePersistence persisted → CrashRecoveryManager shows notification
  ├─ Web: All state lost → user sees blank dialpad
  └─ Telnyx: Call leg stays active until 30s SIP timeout

Backend Deploy (Mid-Call)
  ├─ Laravel processes restart → all in-memory state lost
  ├─ Redis: survives (if not flushed) but connections reset
  ├─ Active calls: continue (Telnyx manages media) but no new inbound routing
  └─ Webhooks: Telnyx retries 3x with exponential backoff
```

---

## Table of Contents

1. [Network & Connectivity Failures (FM-01 to FM-08)](#1-network--connectivity-failures)
2. [App Lifecycle Failures (FM-09 to FM-12)](#2-app-lifecycle-failures)
3. [Infrastructure Failures (FM-13 to FM-17)](#3-infrastructure-failures)
4. [External Service Failures (FM-18 to FM-21)](#4-external-service-failures)
5. [Device & Platform Failures (FM-22 to FM-25)](#5-device--platform-failures)
6. [Severity × Probability Matrix](#6-severity--probability-matrix)
7. [Cross-Reference with Prior Research](#7-cross-reference-with-prior-research)
8. [Implementation Roadmap](#8-implementation-roadmap)

---

## 1. Network & Connectivity Failures

### FM-01: Network Transition (WiFi ↔ Cellular)

**Scenario**:
1. User on active VoIP call via WiFi at home
2. User walks out of WiFi range during call
3. Device transitions to cellular (LTE/5G)
4. IP address changes, existing WebSocket to Telnyx is now invalid
5. WebRTC ICE candidates must re-gather on new network interface

**Probability**: **High** — happens multiple times daily for mobile users

**User Impact**:
- **iOS**: Brief audio gap (1-3 seconds), then call resumes automatically
- **Android**: Call may drop completely (**GAP-015**: no network monitoring)
- **Web**: N/A (browser handles, but mobile browsers typically reload)

**Current Handling**:

**iOS** — **STRONG**:
- `NetworkMonitor.swift` (line 7142-7560) uses `NWPathMonitor`
- 500ms debounce to filter brief blips (line 7227)
- `onNetworkChanged()` → checks if call active → triggers reconnection
- 30-second reconnection timeout before reporting call dropped (line 7428)
- File: `ios/App/App/VoIP/Utils/NetworkMonitor.swift`

```swift
private func handlePathUpdate(_ path: NWPath) {
    let newStatus = path.status == .satisfied
    let newInterface = path.availableInterfaces.first?.type

    // Debounce network changes (500ms)
    debounceTimer?.invalidate()
    debounceTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
        self?.processNetworkChange(isConnected: newStatus, interface: newInterface)
    }
}
```

**Android** — **WEAK** (GAP-015):
- No `ConnectivityManager.NetworkCallback` implementation
- No network change detection
- SDK auto-reconnect exists but not enabled by default (GAP-017)
- Falls back to Telnyx SDK's internal reconnection (if `autoReconnect: true`)

**Web**:
- Browser's WebRTC handles ICE restart internally
- `@telnyx/react-client` SDK manages reconnection
- No explicit Z360 monitoring

**SDK-Level Behavior**:

**Telnyx iOS SDK** (from pack):
```swift
// TxConfig.swift
public internal(set) var reconnectClient: Bool = true
public internal(set) var reconnectTimeout: Double = 60.0 // DEFAULT_TIMEOUT

// If network changes during call:
// 1. SDK detects ICE connection failure
// 2. Triggers ICE restart with 500ms delay
// 3. Renegotiates media path
// 4. If successful within 60s → call continues
// 5. If timeout → .reconnectFailed error
```

**Telnyx Android SDK** (from pack):
```kotlin
// TelnyxClient.kt
data class TelnyxConfig(
    val autoReconnect: Boolean = true,  // Must be explicitly enabled
    // ...
)

// CallState.kt
sealed class CallState {
    data class RECONNECTING(val callNetworkChangeReason: CallNetworkChangeReason)
    data class DROPPED(val callNetworkChangeReason: CallNetworkChangeReason)
}

// ICE_RESTART_DELAY_MS = 500L
```

**Recovery Path**:
- **iOS**: Automatic via NetworkMonitor + SDK reconnect
- **Android**: Manual — requires `autoReconnect: true` in `credentialLogin()` (currently missing)
- **Web**: Automatic via browser

**Recommended Improvement**:

**Priority: High**

1. **Android**: Implement `NetworkMonitor` class with `ConnectivityManager.NetworkCallback`
   - Detect WiFi ↔ Cellular transitions
   - Trigger SDK reconnect on network change during active call
   - File: New `android/.../voip/NetworkMonitor.kt`
   - Effort: Medium (2-3 days)

2. **Android**: Enable `autoReconnect: true` in all SDK login calls (GAP-017)
   - Current: `credentialLogin(sipUser, sipPass, autoReconnect = false)` — **WRONG**
   - Target: `credentialLogin(sipUser, sipPass, autoReconnect = true)`
   - Files: `TelnyxVoipPlugin.kt:643`, `Z360FirebaseMessagingService.kt:1045`
   - Effort: Small (0.5 day)

3. **All platforms**: Log network transitions with call state to VoIP analytics
   - Track: transition type, ICE restart duration, success/failure
   - Effort: Small (0.5 day)

**File References**:
- iOS: `ios/App/App/VoIP/Utils/NetworkMonitor.swift:7142-7560`
- Android (missing): No `NetworkMonitor` implementation
- Android SDK usage: `TelnyxVoipPlugin.kt:643`, `Z360FirebaseMessagingService.kt:1045`
- Telnyx iOS SDK: `.scratchpad/packs/telnyx-ios-sdk.xml` (search "reconnect")
- Telnyx Android SDK: `.scratchpad/packs/telnyx-android-sdk.xml` (search "autoReconnect")

---

### FM-02: Complete Network Loss (Tunnel/Elevator)

**Scenario**:
1. User on active call enters elevator or tunnel
2. All connectivity lost (WiFi + cellular both unavailable)
3. WebRTC media stops, WebSocket to Telnyx closes
4. Telnyx platform waits for reconnection
5. Network returns after 10s / 30s / 60s — can call resume?

**Probability**: **Medium** — daily for urban/commuter users

**User Impact**:
- **0-30s loss**: Call should resume (media restarts, no hangup)
- **30-60s loss**: Telnyx may terminate call (SIP session timeout)
- **>60s loss**: Call definitely terminated

**Current Handling**:

**Client-Side**:
- **iOS**: NetworkMonitor sets `hasNetwork = false` → triggers reconnection when network returns
  - 30-second timeout before reporting call dropped (line 7428)
  - If network returns within 30s: SDK reconnects, media resumes
  - If >30s: `CallKit.reportCallEnded(.failed)`
  - File: `NetworkMonitor.swift:7428-7445`

- **Android**: No explicit handling (GAP-015) — relies on SDK
  - SDK will eventually fire `OnCallDropped` event
  - No client-side timeout enforcement

- **Web**: WebSocket disconnect → `activeCall.state → 'destroy'` → UI reverts
  - No resume path — user must redial

**Server-Side** (Telnyx Platform):
- SIP session timeout: ~60 seconds of no media/signaling
- After timeout, Telnyx sends `call.hangup` webhook with `hangup_cause: "timeout"`
- Backend handles as normal call end (see `TelnyxInboundWebhookController.php:1758`)

**Backend** (Z360):
```php
// Check if hangup was due to timeout
$isTimeout = $data->hangup_cause === 'timeout';

if ($isTimeout || $data->hangup_cause === 'no_answer') {
    // Route to voicemail if timeout during ring phase
}
```
File: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:1758`

**Recovery Path**:
- **<30s loss (iOS)**: SDK reconnects, call continues
- **<30s loss (Android)**: SDK may reconnect if `autoReconnect: true` (currently not enabled)
- **30-60s loss**: Race between client reconnect and Telnyx timeout
- **>60s loss**: Telnyx terminates, no recovery possible

**Recommended Improvement**:

**Priority: High**

1. **iOS**: Add user feedback during network loss
   - Show "Reconnecting..." banner in CallKit UI
   - Display countdown: "Reconnecting (25s left)"
   - File: `Z360VoIPService.swift` (add UI state for reconnecting)
   - Effort: Small (1 day)

2. **Android**: Implement network loss detection + reconnection (same as FM-01)
   - Effort: Medium (2-3 days)

3. **Backend**: Add heartbeat/keepalive for long calls
   - Periodic ping to Telnyx API to check call status
   - If backend thinks call is active but Telnyx says it's ended → clean up
   - File: New `app/Jobs/CallHealthCheckJob.php`
   - Effort: Medium (2-3 days)

4. **All platforms**: Implement "call quality" indicator in UI
   - Green: good (MOS > 4.0, jitter < 30ms)
   - Yellow: degraded (MOS 3.0-4.0, jitter 30-100ms)
   - Red: poor (MOS < 3.0, jitter > 100ms, packet loss > 5%)
   - iOS already has `CallQualityMonitor.swift` — expose to UI
   - Effort: Medium (2 days)

**File References**:
- iOS: `ios/App/App/VoIP/Utils/NetworkMonitor.swift:7428-7445`
- iOS quality: `ios/App/App/VoIP/Utils/CallQualityMonitor.swift`
- Android (missing): No network monitoring
- Backend: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:1758`

---

### FM-03: WebSocket Disconnect (Web Platform Only)

**Scenario**:
1. Web user's browser WebSocket to Telnyx disconnects
2. Causes: Network blip, server restart, rate limiting, browser throttling
3. If disconnected during active call: media stops
4. If disconnected during incoming call: SIP INVITE never received

**Probability**: **Medium** — affected by browser power saving, network quality

**User Impact**:
- **Active call**: Call drops immediately, UI reverts to dialpad
- **Incoming call**: Call never appears (completely missed)

**Current Handling**:

**Web**:
```typescript
// dialpad/context.tsx:675-694
Echo.private(`users.${userId}.${organizationId}`)
    .listen('.call_ended', (event) => {
        if (activeCall?.state === 'ringing') {
            activeCall.hangup();
        }
    });

// BUT: No listener for '.incoming_call' broadcast!
// WebSocket disconnect = no incoming calls
```
File: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:675-694`

**Backend sends Reverb broadcast** but web doesn't listen:
```php
// Backend broadcasts IncomingCallNotification
event(new IncomingCallNotification($user->id, $callData));

// Web: NO LISTENER for '.incoming_call'
// Web relies ONLY on direct SIP INVITE via WebSocket
```

**Recovery Path**:
- **Active call**: No recovery — user must redial
- **Incoming call**: Missed silently, no notification

**Recommended Improvement**:

**Priority: Critical** (GAP — identified in `inbound-call-flow-unified.md` RC-6)

1. **Add Reverb `.incoming_call` listener as fallback**:
   ```typescript
   Echo.private(`users.${userId}.${organizationId}`)
       .listen('.incoming_call', (event) => {
           // If WebSocket is disconnected, show call UI from Reverb data
           // Fall back to backend-provided caller info
           showIncomingCallFromReverb(event);
       });
   ```
   File: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx`
   Effort: Medium (2 days)

2. **WebSocket connection monitoring**:
   - Detect WebSocket disconnect
   - Show banner: "Offline — incoming calls may be missed"
   - Auto-reconnect on network restoration
   - Effort: Medium (2 days)

3. **Service Worker + Web Push API** for backgrounded tabs:
   - Register Service Worker
   - Backend sends Web Push alongside Reverb
   - Service Worker shows notification even when tab is backgrounded
   - Effort: Large (4-5 days)

**File References**:
- Web context: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:675-694`
- Backend broadcast: `app/Events/IncomingCallNotification.php`
- Prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:649-651` (RC-6)

---

### FM-04: SDK Auto-Reconnect Disabled (Android Only)

**Scenario**:
1. Android user on call experiences brief network blip (2-5 seconds)
2. Telnyx SDK `autoReconnect` is `false` (default) — **Z360 never enabled it**
3. SDK closes connection, does not attempt reconnection
4. Call drops completely

**Probability**: **High** — network blips are common

**User Impact**:
- Every brief network issue drops the call
- User experiences poor call reliability
- Reputational damage to Z360 ("calls drop all the time")

**Current Handling**:

**Android** — **BROKEN** (GAP-017):
```kotlin
// TelnyxVoipPlugin.kt:643
client.credentialLogin(
    sipUser = sipUser,
    password = sipPass,
    ringtoneManager = ringtoneManager,
    autoReconnect = false  // ← DEFAULT, NEVER CHANGED
)
```
File: `android/.../voip/TelnyxVoipPlugin.kt:643`

**Telnyx SDK** expects `autoReconnect: true` for resilience:
```kotlin
// From telnyx-android-sdk.xml
data class TelnyxConfig(
    val autoReconnect: Boolean = true,  // SDK default
    // ...
)

// Z360 overrides to false without reason
```

**iOS** — **CORRECT**:
```swift
// iOS SDK has reconnection enabled by default
let config = TxConfig(
    // ...
    reconnectClient: true,  // Default
    reconnectTimeOut: 60.0  // 60 seconds
)
```

**Recovery Path**:
- Current: No recovery — call drops permanently
- With fix: SDK reconnects automatically within 60s

**Recommended Improvement**:

**Priority: Critical** (easy fix, high impact)

1. **Enable `autoReconnect: true` everywhere** (GAP-017):
   - Change in `TelnyxVoipPlugin.kt:643`
   - Change in `Z360FirebaseMessagingService.kt:1045`
   - Verify in all `credentialLogin()` call sites
   - Effort: Small (0.5 day)

2. **Test reconnection behavior**:
   - Simulate network blip during active call
   - Verify SDK reconnects and call continues
   - Measure reconnection time (should be <5s)
   - Effort: Small (0.5 day)

**File References**:
- Android plugin: `android/.../voip/TelnyxVoipPlugin.kt:643`
- Android FCM: `android/.../fcm/Z360FirebaseMessagingService.kt:1045`
- Telnyx Android SDK: `.scratchpad/packs/telnyx-android-sdk.xml` (search "autoReconnect")
- Prior research: `.scratchpad/whitepaper/02-platform-architectures/android-architecture-complete.md` (GAP-017)

---

### FM-05: ICE Connection Failure (No STUN/TURN)

**Scenario**:
1. User is behind restrictive firewall (corporate/school network)
2. Direct peer-to-peer WebRTC fails (symmetric NAT, blocked UDP ports)
3. STUN server unreachable or ineffective
4. TURN relay server unreachable
5. ICE gathering fails, no audio path established

**Probability**: **Low-Medium** — depends on network environment

**User Impact**:
- Call appears to connect but no audio
- Both parties see "active" call but hear nothing
- Confusing UX ("my call doesn't work")

**Current Handling**:

**iOS** — **FORCED RELAY** (adds latency but avoids failure):
```swift
// TelnyxService.swift:75-108
let config = TxConfig(
    // ...
    forceRelayCandidate: true  // ← Forces TURN relay
)

// TRADE-OFF:
// + Avoids iOS Local Network privacy prompt
// + Works in all network environments
// - Adds 50-150ms latency (media routes via TURN server)
```
File: `ios/App/App/VoIP/Services/TelnyxService.swift:75-108`

**Android** — **DEFAULT BEHAVIOR**:
- SDK uses default ICE candidate gathering
- STUN + TURN + host candidates
- Prefers direct connection, falls back to TURN if needed

**Web** — **DEFAULT BEHAVIOR**:
- Browser's WebRTC handles ICE
- `@telnyx/react-client` SDK manages server configuration

**Telnyx Infrastructure**:
- STUN servers: Provided by Telnyx
- TURN servers: Provided by Telnyx (relay for restrictive networks)
- Both should be configured in SDK automatically

**Recovery Path**:
- If ICE fails: Call setup fails, user sees error
- No audio = call unusable, must hang up and retry

**Recommended Improvement**:

**Priority: Low** (rare, mostly handled by TURN fallback)

1. **Add ICE connection diagnostics**:
   - Log: ICE candidate types gathered (host, srflx, relay)
   - Log: Selected candidate pair
   - Detect if TURN was required
   - Send to analytics for network quality monitoring
   - Effort: Small (1 day)

2. **iOS: Make `forceRelayCandidate` configurable**:
   - Default: `false` (prefer direct, fall back to TURN)
   - Firebase Remote Config flag: `ios_force_relay`
   - Monitor latency impact via analytics
   - Effort: Small (1 day)

3. **Add "No audio?" troubleshooting button** in call UI:
   - Shows diagnostic info (candidate type, latency, jitter)
   - Suggests: check firewall, restart call, enable VPN
   - Effort: Medium (2 days)

**File References**:
- iOS: `ios/App/App/VoIP/Services/TelnyxService.swift:75-108`
- Telnyx SDK docs: STUN/TURN configuration
- Prior research: `.scratchpad/whitepaper/02-platform-architectures/ios-architecture-complete.md:1212` (TODO: investigate `forceRelayCandidate`)

---

### FM-06: Call Recording Failure After Bridge

**Scenario** (from `inbound-call-flow-unified.md` RC-4):
1. Backend successfully bridges parent ↔ answered leg
2. Backend calls `Call::record_start()` to record the call
3. Telnyx API returns error (rate limit, bad request, Telnyx outage)
4. Recording never starts, but call continues

**Probability**: **Low** — Telnyx API is generally reliable

**User Impact**:
- Call is not recorded (compliance/legal issue if recording is mandatory)
- No visible indicator to user that recording failed
- Discovered only later when user tries to access recording

**Current Handling**:

**Backend** — **LOGS BUT NO RETRY**:
```php
// TelnyxInboundWebhookController.php:532-544
try {
    Call::record_start([
        'call_control_id' => $parentId,
        'format' => 'wav',
        'channels' => 'dual',
    ]);
    VoipLog::info('Started recording on parent leg', $callSessionId);
} catch (\Exception $e) {
    VoipLog::error('Failed to start recording on parent leg', $callSessionId, [
        'error' => $e->getMessage(),
    ]);
    // NO RETRY, NO CLEANUP, CALL CONTINUES
}
```
File: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:532-544`

**Recovery Path**:
- Current: None — recording is lost
- User never notified

**Recommended Improvement**:

**Priority: Medium** (compliance risk if recording is legally required)

1. **Add recording health check**:
   - After 5 seconds, verify recording is active via Telnyx API
   - If not active: retry `record_start()` once
   - If still fails: log critical alert + notify user ("Call not recorded")
   - Effort: Medium (2 days)

2. **Add backend flag for mandatory recording**:
   - If recording fails on mandatory call: hang up call immediately
   - Better to fail fast than have unrecorded call in prod
   - Effort: Small (1 day)

3. **Add recording indicator in call UI**:
   - Show red dot "Recording" badge during call
   - If recording fails: show yellow warning "Recording unavailable"
   - Effort: Small (1 day)

**File References**:
- Backend: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:532-544`
- Prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:636-640` (RC-4)

---

### FM-07: Bridge Failure After Answer (Already Documented)

See prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:636-640` (RC-4)

**Recommendation**: Separate try blocks for bridge + post-bridge operations (already in roadmap)

---

### FM-08: Webhook Loss (Already Documented)

See prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:643-646` (RC-5)

**Recommendation**: Heartbeat polling for calls >60s (already in roadmap)

---

## 2. App Lifecycle Failures

### FM-09: App Crash During Active Call

**Scenario**:
1. User on active call (ACTIVE state)
2. App crashes (unhandled exception, system OOM kill)
3. Process terminates immediately
4. Telnyx SIP leg remains active (no hangup sent)

**Probability**: **Low-Medium** — depends on app stability

**User Impact**:
- **User**: Call audio stops, UI gone
- **Remote party**: Hears silence, eventually timeout
- **Telnyx**: Leg remains active until SIP timeout (~60s)

**Current Handling**:

**iOS** — **STRONG** (crash recovery implemented):
```swift
// VoipStore.swift:170-213
actor VoipStore {
    func saveActiveCall(_ state: PersistableCallState) async {
        // Save to UserDefaults (survives process death)
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(state) {
            userDefaults.set(data, forKey: "z360_active_call_state")
        }
    }

    func recoverOrphanCallState() async -> PersistableCallState? {
        guard let data = userDefaults.data(forKey: "z360_active_call_state") else {
            return nil
        }
        // Decode and return orphaned call
    }
}

// AppDelegate.swift (next launch)
func application(_ application: UIApplication, didFinishLaunchingWithOptions...) {
    // ...
    if let orphanState = await VoipStore.shared.recoverOrphanCallState() {
        // Report ended to CallKit
        Z360VoIPService.shared.checkAndRecoverOrphanCalls(orphanState: orphanState)
    }
}
```
Files:
- `ios/App/App/VoIP/Services/VoipStore.swift:170-213`
- `ios/App/App/AppDelegate.swift`
- `ios/App/App/VoIP/Services/Z360VoIPService.swift:4377-4434` (checkAndRecoverOrphanCalls)

**Android** — **STRONG** (crash recovery implemented):
```kotlin
// CallStatePersistence.kt:49-56
object CallStatePersistence {
    fun saveActiveCall(context: Context, state: PersistedCallState) {
        val prefs = context.getSharedPreferences("z360_voip", Context.MODE_PRIVATE)
        val json = Gson().toJson(state)
        prefs.edit().putString("active_call_state", json).apply()
    }

    fun checkForAbandonedCall(context: Context): PersistedCallState? {
        // Read from SharedPreferences
    }
}

// CrashRecoveryManager.kt:80-105
object CrashRecoveryManager {
    fun checkAndRecoverFromCrash(context: Context) {
        val state = CallStatePersistence.checkForAbandonedCall(context) ?: return

        // Stop foreground service, cancel notifications
        // Show recovery notification: "Your call was disconnected"
        // Clear persisted state
    }
}
```
Files:
- `android/.../voip/CallStatePersistence.kt:49-56`
- `android/.../voip/CrashRecoveryManager.kt:80-105`

**Web** — **NO RECOVERY**:
- All state is in-memory
- Tab close or crash = complete state loss
- Browser may keep WebRTC connection alive briefly, but no UI

**Backend**:
- `simring:*` cache survives (10min TTL)
- Active call: Telnyx keeps SIP leg alive until timeout
- No backend-side detection of crashed client

**Recovery Path**:
- **iOS/Android**: Next app launch detects orphan, cleans up, shows notification
- **Web**: No recovery — call lost

**Recommended Improvement**:

**Priority: Low** (already well-handled on mobile)

1. **Backend: Detect stale active calls**:
   - Periodic job checks Telnyx API for active calls
   - If call is active on Telnyx but client hasn't sent keepalive in 2+ minutes:
     - Assume client crashed
     - Hang up Telnyx leg
     - Clean up cache
   - File: New `app/Jobs/DetectStalledCallsJob.php`
   - Effort: Medium (2 days)

2. **Web: Add "Restore session" on reload**:
   - Store minimal call state in `sessionStorage`
   - On page reload: check if call was active
   - Show message: "Call was interrupted. Redial?"
   - Effort: Small (1 day)

**File References**:
- iOS: `ios/App/App/VoIP/Services/VoipStore.swift:170-213`
- iOS: `ios/App/App/VoIP/Services/Z360VoIPService.swift:4377-4434`
- Android: `android/.../voip/CallStatePersistence.kt:49-56`
- Android: `android/.../voip/CrashRecoveryManager.kt:80-105`
- Prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:455-461` (Section 6.5)

---

### FM-10: App Killed by OS (Low Memory / Background)

**Scenario**:
1. User on active call, app in background
2. iOS/Android OS kills process due to low memory
3. Process terminates without chance to cleanup
4. Different from crash — no opportunity to persist state

**Probability**: **Low** — rare due to foreground service (Android) and CallKit (iOS)

**User Impact**:
- Same as FM-09 (crash) but even less warning

**Current Handling**:

**iOS**:
- **CallKit provides protection**: iOS does not kill app during active CallKit call
- If killed anyway (extremely rare): same recovery as FM-09

**Android**:
- **Foreground service provides protection**: `CallForegroundService` keeps process alive
- Runs in separate process (`:call_service`) — isolated from WebView crashes
- If killed anyway: same recovery as FM-09

**Recovery Path**:
- Same as FM-09

**Recommended Improvement**:

**Priority: Low** (rare, already mitigated)

1. **Monitor OS kill rate via analytics**:
   - Detect: next launch has orphan state + process was killed (not crashed)
   - Log to analytics: "os_killed_during_call"
   - If rate is high: investigate memory leaks
   - Effort: Small (0.5 day)

**File References**:
- Same as FM-09

---

### FM-11: App Killed by User (Swipe Away)

**Scenario**:
1. User on active call
2. User swipes away app in task switcher (Android) or force-quits (iOS)
3. Process terminates immediately

**Probability**: **Very Low** — users rarely kill app during call

**User Impact**:
- Same as FM-09 (crash)

**Current Handling**:
- Same as FM-09

**Recovery Path**:
- Same as FM-09

**Recommended Improvement**:

**Priority: Very Low**

1. **Show warning before allowing force-quit during call** (iOS only):
   - Override `applicationWillTerminate()` to show alert
   - "Call in progress. Are you sure you want to quit?"
   - Effort: Small (0.5 day)

---

### FM-12: Cold Start Push Before Initialization (iOS)

**Scenario** (from iOS architecture research G-04):
1. App is killed (not running)
2. VoIP push arrives via PushKit
3. iOS wakes app → `didFinishLaunchingWithOptions` (Phase 1)
4. Push handled immediately → must report to CallKit within 5s
5. BUT: Phase 2 (audio config, SDK connect, Firebase) not yet done

**Probability**: **High** — every cold-start incoming call

**User Impact**:
- Call UI appears (CallKit works)
- But audio may be delayed or missing
- SDK may not be connected yet

**Current Handling**:

**iOS** — **PARTIAL** (two-phase startup helps, but gap remains):
```swift
// AppDelegate.swift (Phase 1 — ~50ms)
func application(_ application: UIApplication, didFinishLaunchingWithOptions...) {
    PushKitManager.shared.initialize()  // Registers for VoIP push
    Z360VoIPService.shared.setupMinimal(callKitManager: callKitManager)
    // CRITICAL: NO audio config, NO SDK connect
    return true
}

// SceneDelegate.swift (Phase 2 — triggered by sceneDidBecomeActive)
func sceneDidBecomeActive(_ scene: UIScene) {
    configureAudioSessionForVoIP()  // AVAudioSession setup
    startNetworkMonitoringIfNeeded()
    initializeFirebase()  // Background queue
    // ...
}

// PROBLEM: If push arrives BEFORE sceneDidBecomeActive, audio not ready
```
Files:
- `ios/App/App/AppDelegate.swift`
- `ios/App/App/SceneDelegate.swift`

**Recovery Path**:
- Current: Audio delayed until Phase 2 completes
- CallKit shows call, but no audio for 2-5 seconds

**Recommended Improvement**:

**Priority: High** (GAP-04 from iOS architecture)

1. **Trigger Phase 2 from PushKit handler on cold start**:
   ```swift
   func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, ...) {
       // BEFORE reporting to CallKit:
       if !audioSessionConfigured {
           // This is cold start push — trigger Phase 2 immediately
           configureAudioSessionForVoIP()
           startNetworkMonitoringIfNeeded()
           // (Firebase can stay deferred — not critical for call)
       }

       // NOW report to CallKit
       reportIncomingCall(...)
   }
   ```
   File: `ios/App/App/VoIP/Managers/PushKitManager.swift`
   Effort: Medium (2-3 days, requires careful testing)

2. **Test cold-start audio latency**:
   - Kill app completely
   - Send VoIP push
   - Measure: push → CallKit → audio ready
   - Target: <2 seconds end-to-end
   - Effort: Small (1 day)

**File References**:
- iOS: `ios/App/App/AppDelegate.swift`
- iOS: `ios/App/App/SceneDelegate.swift`
- iOS: `ios/App/App/VoIP/Managers/PushKitManager.swift`
- Prior research: `.scratchpad/whitepaper/02-platform-architectures/ios-architecture-complete.md` (GAP-04)

---

## 3. Infrastructure Failures

### FM-13: Backend Restart / Deploy

**Scenario**:
1. Laravel server restarts (deploy, crash, OOM)
2. All in-flight requests aborted
3. In-memory state lost
4. Redis connections reset (but data persists if Redis not restarted)

**Probability**: **High** — multiple deploys per week

**User Impact**:
- **Active calls**: Continue (Telnyx manages media), but no new webhooks processed until backend up
- **Incoming calls**: Missed during downtime (~10-30s for rolling deploy)
- **Credential creation**: Fails, users cannot register

**Current Handling**:

**Laravel**:
- Graceful shutdown: not implemented
- Active HTTP requests: aborted mid-request
- Queued jobs: persist in Redis (if using Redis queue driver)
- WebSockets (Reverb): disconnect, clients must reconnect

**Redis**:
- `simring:*` cache survives (if Redis not restarted)
- Distributed locks reset (connections closed)
- Queue jobs persist

**Telnyx**:
- Active call legs remain active
- Webhooks retry with exponential backoff (3 attempts, 1s/2s/4s delays)
- After 3 failures: webhook is lost

**Backend Webhook Processing**:
```php
// Telnyx webhook retry is configured per webhook URL
// Default: 3 attempts with exponential backoff
// After 3 failures: Telnyx gives up
```

**Recovery Path**:
- Deploy completes (~30s)
- Reverb clients reconnect
- Telnyx webhooks resume (if within retry window)
- Active calls continue, new calls work

**Recommended Improvement**:

**Priority: High**

1. **Implement graceful shutdown**:
   ```php
   // In AppServiceProvider or dedicated shutdown handler
   public function register() {
       pcntl_signal(SIGTERM, function () {
           // Stop accepting new requests
           // Wait for active calls to end (max 30s)
           // Then exit
       });
   }
   ```
   Effort: Medium (2 days)

2. **Add webhook queue persistence**:
   - If webhook processing fails (e.g., during deploy): queue for retry
   - Use database-backed queue (not in-memory)
   - Retry failed webhooks after deploy completes
   - Effort: Large (4-5 days)

3. **Add "Backend unavailable" circuit breaker**:
   - Mobile clients detect repeated API failures
   - Show banner: "Service temporarily unavailable"
   - Prevent spamming backend during restart
   - Effort: Medium (2 days)

4. **Use rolling deploy with health checks**:
   - Load balancer checks `/health` endpoint
   - Only route traffic to healthy instances
   - Zero-downtime deploys
   - Effort: Medium (requires infrastructure changes)

**File References**:
- Backend: No graceful shutdown implemented
- Telnyx webhook retry: configured in Telnyx dashboard
- Queue config: `config/queue.php`

---

### FM-14: Redis Failure

**Scenario**:
1. Redis process crashes or becomes unavailable
2. All cache operations fail
3. Distributed locks unavailable
4. Queue jobs lost (if using Redis queue driver)

**Probability**: **Low** — Redis is generally stable, but single point of failure

**User Impact**:
- **Simultaneous ring coordination lost**: Multiple devices can answer, no lock
- **Cache-based features fail**: Credential caching, session data, etc.
- **Push notifications may fail**: If FCM tokens cached in Redis

**Current Handling**:

**Backend** — **THROWS EXCEPTIONS**:
```php
// TelnyxInboundWebhookController.php:2057
$lock = \Cache::lock("simring:{$parentId}:lock", 10);

if (!$lock->get()) {
    // Lock acquisition failed — what happens?
    // Current: exception thrown, webhook processing aborts
    // Result: ALL devices hang up, NO bridge
}
```
File: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:2057`

**Cache reads**:
```php
$ringSession = \Cache::get("simring:{$parentId}");

// If Redis down:
// - Cache::get() returns null
// - Webhook handler treats as "no session" → skips cleanup → leaks resources
```

**Recovery Path**:
- Current: Manual — restart Redis
- Webhook processing resumes after Redis is back
- Lost lock acquisitions = missed opportunities to bridge calls

**Recommended Improvement**:

**Priority: Critical** (single point of failure)

1. **Add Redis health check in webhook handler**:
   ```php
   try {
       $lock = \Cache::lock("simring:{$parentId}:lock", 10);
       if (!$lock->get()) {
           throw new \Exception("Could not acquire lock");
       }
   } catch (\Exception $e) {
       // Redis unavailable — fall back to database lock
       $dbLock = DB::table('distributed_locks')->lockForUpdate()->where(...)->first();
       // OR: fail gracefully and route to voicemail
   }
   ```
   Effort: Medium (2-3 days)

2. **Implement Redis failover (Redis Sentinel or Cluster)**:
   - Use Redis Sentinel for automatic failover
   - Multiple Redis replicas
   - Application connects via Sentinel, auto-switches on failure
   - Effort: Large (infrastructure + app changes)

3. **Add in-memory fallback for critical locks**:
   - If Redis unavailable: use PHP `flock()` or database row locks
   - Slower but functional
   - Effort: Medium (2 days)

4. **Monitor Redis health in observability**:
   - Alert on Redis connection failures
   - Track lock acquisition failures
   - Effort: Small (1 day)

**File References**:
- Backend lock usage: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:2057`
- Prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:697` (G-10)

---

### FM-15: PostgreSQL Connection Pool Exhausted

**Scenario**:
1. PostgreSQL connection pool reaches max connections (e.g., 100)
2. New requests block waiting for available connection
3. Long-running queries or transactions hold connections
4. Webhook processing stalls

**Probability**: **Low-Medium** — depends on traffic and query efficiency

**User Impact**:
- Webhook processing delayed → call routing delayed
- API endpoints timeout
- Users see "500 Internal Server Error"

**Current Handling**:

**Laravel**:
```php
// config/database.php
'pgsql' => [
    'driver' => 'pgsql',
    'host' => env('DB_HOST', '127.0.0.1'),
    'port' => env('DB_PORT', '5432'),
    'database' => env('DB_DATABASE', 'forge'),
    // ...
    'pool' => [
        'min' => env('DB_POOL_MIN', 2),
        'max' => env('DB_POOL_MAX', 10),  // Laravel default
    ],
],
```

**Webhook handling**:
- Each webhook creates DB connection
- Message creation, conversation updates, etc.
- If Message::create() blocks (table lock, slow query): connection held

**Recovery Path**:
- Connection released after timeout or query completion
- Other requests can proceed

**Recommended Improvement**:

**Priority: Medium**

1. **Monitor connection pool usage**:
   - Log: active connections, waiting requests
   - Alert if >80% pool usage
   - Effort: Small (1 day)

2. **Optimize database queries in webhook path**:
   - Profile slow queries
   - Add indexes on frequently queried columns
   - Reduce N+1 queries
   - Effort: Medium (ongoing)

3. **Increase pool size** (if needed):
   - Benchmark: measure connection usage under load
   - Increase `DB_POOL_MAX` if consistently hitting limit
   - Trade-off: more memory usage
   - Effort: Small (configuration change)

4. **Add query timeout**:
   - Set max query execution time (e.g., 10s)
   - Prevent runaway queries from holding connections
   - Effort: Small (1 day)

**File References**:
- Config: `config/database.php`
- Webhook controllers: `app/Http/Controllers/Telnyx/`

---

### FM-16: TLS Certificate Expiry

**Scenario**:
1. SSL/TLS certificate for Z360 backend expires
2. OR: Telnyx WebSocket TLS certificate rotates unexpectedly
3. OR: APNs certificate for VoIP push expires

**Probability**: **Very Low** — automated renewal should prevent

**User Impact**:
- **Backend cert expiry**: All API calls fail, webhook delivery fails
- **Telnyx WebSocket cert**: SDK cannot connect
- **APNs cert expiry**: All iOS VoIP pushes fail

**Current Handling**:

**Backend**:
- LetsEncrypt auto-renewal (if configured)
- If expires: HTTPS fails, API returns 5xx or connection refused

**Telnyx**:
- Managed by Telnyx
- Certificate rotation should be transparent

**APNs**:
- Z360 manages APNs certificate for VoIP push
- Expiry: 1 year from issuance
- No automated renewal (manual process)

**Recovery Path**:
- Backend: Renew certificate, restart web server
- APNs: Upload new certificate to Telnyx + backend

**Recommended Improvement**:

**Priority: Low** (rare, but critical when it happens)

1. **Monitor certificate expiry**:
   - Alert 30 days before expiry
   - Backend: LetsEncrypt auto-renewal + monitoring
   - APNs: Manual check + calendar reminder
   - Effort: Small (1 day)

2. **Add fallback for WebSocket TLS failure**:
   - SDK connection failure → show user-friendly error
   - "Service temporarily unavailable"
   - Effort: Small (1 day)

**File References**:
- Backend SSL config: Web server configuration
- APNs cert upload: Telnyx dashboard + backend `ApnsVoipService`

---

### FM-17: Multi-Region Latency (Async Webhook Processing)

**Scenario**:
1. Backend in US-East, Telnyx in Dallas, user in Australia
2. Webhook round-trip: Telnyx → Backend → Telnyx (bridge command)
3. High latency: 200ms (Dallas → US-East) + 200ms processing + 200ms (US-East → Dallas) = 600ms
4. Simultaneous ring: legs created sequentially, 200ms between each
5. First device rings 600ms before last device

**Probability**: **High** — geography is fixed

**User Impact**:
- Perceived delay in ringing
- First device has unfair advantage (answers before others hear ring)
- Push delivery to ANZ devices also delayed

**Current Handling**:

**Backend**:
- Synchronous webhook processing (blocking)
- Sequential leg creation:
  ```php
  foreach ($devices as $device) {
      $call = Call::create([...]);  // HTTP call to Telnyx API
      $legIds[] = $call->call_control_id;
  }
  ```
  File: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:311-333`

**Recovery Path**:
- N/A — latency is inherent to geography

**Recommended Improvement**:

**Priority: Low** (optimization, not failure)

1. **Parallelize leg creation**:
   ```php
   use GuzzleHttp\Promise;

   $promises = [];
   foreach ($devices as $device) {
       $promises[] = TelnyxApiClient::createCallAsync([...]);
   }

   $results = Promise\Utils::unwrap($promises);  // Wait for all
   ```
   Effort: Medium (2-3 days)

2. **Use Telnyx edge locations**:
   - If Telnyx supports regional webhooks: route to nearest edge
   - Backend in multiple regions: route to nearest
   - Effort: Large (infrastructure)

3. **Optimize backend processing time**:
   - Profile webhook handler
   - Reduce DB queries, cache checks
   - Target: <50ms processing time
   - Effort: Medium (ongoing)

**File References**:
- Backend: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:311-333`
- Prior research: `.scratchpad/whitepaper/03-call-management/inbound-call-flow-unified.md:100-150` (timing diagram)

---

## 4. External Service Failures

### FM-18: Telnyx API Outage

**Scenario**:
1. Telnyx API returns 500/503 errors
2. Affects: credential creation, call creation, bridge, hangup, recording
3. Duration: minutes to hours (rare, but possible)

**Probability**: **Very Low** — Telnyx SLA is high

**User Impact**:
- **Credential creation fails**: New users cannot register
- **Call initiation fails**: Outbound calls fail
- **Bridge fails**: Inbound calls cannot connect
- **Active calls**: Continue (media is peer-to-peer), but cannot send DTMF, hold, etc.

**Current Handling**:

**Backend** — **THROWS EXCEPTIONS**:
```php
try {
    $call = \Telnyx\Call::create([...]);
} catch (\Telnyx\Exception\ApiErrorException $e) {
    // Log error
    // Re-throw (webhook processing aborts)
}
```

**iOS/Android**:
- SDK connections may work (WebSocket to Telnyx)
- But new calls cannot be initiated

**Recovery Path**:
- Wait for Telnyx to restore service
- Retry failed operations

**Recommended Improvement**:

**Priority: Medium**

1. **Add exponential backoff retry for Telnyx API calls**:
   ```php
   $response = retry(3, function () use ($callData) {
       return \Telnyx\Call::create($callData);
   }, sleepMilliseconds: function ($attempt) {
       return 1000 * (2 ** $attempt);  // 1s, 2s, 4s
   });
   ```
   Effort: Medium (2 days)

2. **Add circuit breaker for Telnyx API**:
   - After 10 consecutive failures: stop retrying for 60s
   - Show user-friendly error: "Service temporarily unavailable"
   - Effort: Medium (2-3 days)

3. **Monitor Telnyx API health**:
   - Track success/failure rate
   - Alert on >5% failure rate
   - Effort: Small (1 day)

**File References**:
- Backend: `app/Services/CPaaSService.php` (all Telnyx API calls)
- Backend: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php`

---

### FM-19: Firebase/APNs Push Service Outage

**Scenario**:
1. FCM (Android) or APNs (iOS) service is unavailable
2. Z360 backend sends push notification → fails
3. Device never learns about incoming call

**Probability**: **Very Low** — Google/Apple infrastructure is highly reliable

**User Impact**:
- **Incoming calls missed** (if app not in foreground with SDK connected)
- No notification, no UI, no indication
- Call rings on other devices, goes to voicemail after timeout

**Current Handling**:

**Backend**:
```php
// PushNotificationService.php:20-157
public function sendIncomingCallPush(...) {
    try {
        // FCM send
        $response = $fcm->send($message);
    } catch (\Exception $e) {
        // Log error
        // NO RETRY
        // Call continues to other devices
    }
}
```
File: `app/Services/PushNotificationService.php:20-157`

**Fallback**:
- If SDK already connected (app in foreground): SIP INVITE arrives directly
- No push needed
- But if app in background/killed: call is missed

**Recovery Path**:
- Wait for FCM/APNs to restore
- No way to re-deliver missed push

**Recommended Improvement**:

**Priority: Low** (very rare, limited fallback options)

1. **Retry push delivery once**:
   - If first push fails: retry after 1s
   - If still fails: log and continue
   - Effort: Small (1 day)

2. **Add secondary notification channel**:
   - If VoIP push fails: send regular (non-VoIP) notification as fallback
   - Less reliable (Doze delays) but better than nothing
   - iOS: Cannot use regular notification as fallback (VoIP push required)
   - Android: Can use regular FCM notification
   - Effort: Medium (2 days, Android only)

3. **Monitor push delivery success rate**:
   - Track: push sent, push delivered (if FCM provides confirmation)
   - Alert on <95% delivery rate
   - Effort: Small (1 day)

**File References**:
- Backend: `app/Services/PushNotificationService.php:20-157`
- iOS: `ios/App/App/VoIP/Managers/PushKitManager.swift`
- Android: `android/.../fcm/Z360FirebaseMessagingService.kt`

---

### FM-20: FCM Token Refresh Never Synced (Android)

**Scenario** (GAP-024 from Android architecture):
1. Android FCM token refreshes (happens periodically or on reinstall)
2. `onNewToken()` is called with new token
3. Z360 stores token locally but **never syncs to backend**
4. Backend has old token in database
5. All future pushes fail silently

**Probability**: **High** — token refresh is common

**User Impact**:
- User stops receiving incoming calls
- No error message, no indication
- Looks like "VoIP stopped working"

**Current Handling**:

**Android** — **BROKEN** (GAP-024):
```kotlin
// Z360FirebaseMessagingService.kt (onNewToken not shown in skill, but mentioned in gap analysis)
override fun onNewToken(token: String) {
    // TODO: Send to backend via POST /api/device-tokens
    // Current: ONLY stores locally, NEVER syncs
    TokenHolder.setFcmToken(context, token)
}
```

**Backend**:
- Expects FCM token from `POST /api/device-tokens` during registration
- No endpoint for updating token alone

**Recovery Path**:
- User must re-register device (logout + login)
- Or: manually trigger credential refresh

**Recommended Improvement**:

**Priority: Critical** (GAP-024, causes permanent failure)

1. **Sync new FCM token to backend immediately**:
   ```kotlin
   override fun onNewToken(token: String) {
       TokenHolder.setFcmToken(context, token)

       // Sync to backend
       lifecycleScope.launch(Dispatchers.IO) {
           try {
               val response = apiClient.post("/api/device-tokens/update-fcm") {
                   json {
                       "device_id" to getDeviceId()
                       "fcm_token" to token
                   }
               }
               VoipLogger.i(TAG, "FCM token updated on backend")
           } catch (e: Exception) {
               VoipLogger.e(TAG, "Failed to sync FCM token", e)
               // Queue for retry
           }
       }
   }
   ```
   File: `android/.../fcm/Z360FirebaseMessagingService.kt`
   Effort: Medium (2 days, includes backend endpoint)

2. **Backend: Add `POST /api/device-tokens/update-fcm` endpoint**:
   ```php
   public function updateFcmToken(Request $request) {
       $validated = $request->validate([
           'device_id' => 'required|string',
           'fcm_token' => 'required|string',
       ]);

       UserDeviceToken::where('device_id', $validated['device_id'])
           ->where('user_id', auth()->id())
           ->update(['fcm_token' => $validated['fcm_token']]);

       return response()->json(['success' => true]);
   }
   ```
   Effort: Small (0.5 day)

3. **Monitor FCM token age**:
   - Track: last token refresh date
   - Alert if token >90 days old (likely stale)
   - Effort: Small (1 day)

**File References**:
- Android: `android/.../fcm/Z360FirebaseMessagingService.kt` (onNewToken method)
- Backend: `app/Http/Controllers/Api/DeviceTokenController.php`
- Prior research: `.scratchpad/whitepaper/02-platform-architectures/android-architecture-complete.md` (GAP-024)

---

### FM-21: Webhook Signature Verification Missing (Security Issue)

**Scenario**:
1. Attacker crafts fake Telnyx webhook payload
2. Sends to Z360 backend at `/webhooks/cpaas/telnyx/call-control`
3. Backend processes without verification
4. Attacker can inject fake call events, terminate calls, etc.

**Probability**: **Very Low** (requires knowledge of webhook URL)

**User Impact**:
- **Security vulnerability**: Attacker can manipulate call state
- Fake `call.answered`, `call.hangup` webhooks
- Fraudulent call logging, billing

**Current Handling**:

**Backend** — **NO VERIFICATION** (Critical security gap from credentials research):
```php
// TelnyxInboundWebhookController.php
public function handleCall(Request $request) {
    // NO signature check
    // NO timestamp validation
    // Directly processes $request->all()
}
```
File: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php`

**Telnyx provides ED25519 signature** in headers:
```
telnyx-signature-ed25519: <base64-encoded-signature>
telnyx-timestamp: <unix-timestamp>
```

**Verification example** (from Telnyx docs):
```php
use Telnyx\Webhook;

$payload = $request->getContent();
$signature = $request->header('telnyx-signature-ed25519');
$timestamp = $request->header('telnyx-timestamp');
$webhookSecret = config('telnyx.webhook_signing_key');

try {
    $event = Webhook::constructEvent($payload, $signature, $timestamp, $webhookSecret);
    // Process verified event
} catch (\Exception $e) {
    return response('Invalid signature', 403);
}
```

**Recovery Path**:
- N/A — this is a prevention issue

**Recommended Improvement**:

**Priority: Critical** (security vulnerability)

1. **Implement webhook signature verification** (from credentials research target architecture):
   ```php
   // app/Http/Middleware/VerifyTelnyxWebhook.php
   class VerifyTelnyxWebhook {
       public function handle(Request $request, Closure $next) {
           $signature = $request->header('telnyx-signature-ed25519');
           $timestamp = $request->header('telnyx-timestamp');

           if (!$signature || !$timestamp) {
               abort(403, 'Missing Telnyx signature headers');
           }

           // Reject stale webhooks (replay protection)
           if (abs(time() - (int)$timestamp) > 300) {
               abort(403, 'Webhook timestamp too old');
           }

           // Verify ED25519 signature
           $publicKey = config('cpaas.telnyx.webhook_public_key');
           $payload = $timestamp . '.' . $request->getContent();

           if (!sodium_crypto_sign_verify_detached(
               base64_decode($signature),
               $payload,
               base64_decode($publicKey)
           )) {
               abort(403, 'Invalid Telnyx webhook signature');
           }

           return $next($request);
       }
   }
   ```
   Apply middleware to all `/webhooks/cpaas/telnyx/*` routes
   Effort: Medium (1-2 days)

2. **Add webhook signing key to environment**:
   ```
   TELNYX_WEBHOOK_PUBLIC_KEY=<base64-encoded-ed25519-public-key>
   ```
   Obtain from Telnyx dashboard
   Effort: Small (0.5 day)

3. **Test with invalid signatures**:
   - Send webhook with wrong signature → expect 403
   - Send webhook with old timestamp → expect 403
   - Send valid webhook → expect 200
   - Effort: Small (0.5 day)

**File References**:
- Backend: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php`
- Prior research: `.scratchpad/whitepaper/03-call-management/credentials-unified.md:373-405` (webhook verification middleware)

---

## 5. Device & Platform Failures

### FM-22: Android Doze Mode Delays Push Delivery

**Scenario**:
1. Android device in Doze mode (screen off, idle for >1 hour)
2. FCM high-priority push sent by Z360 backend
3. Android delays delivery until next maintenance window (up to 15 minutes)
4. User misses incoming call

**Probability**: **Medium** — affects idle devices

**User Impact**:
- Incoming calls missed or severely delayed
- User sees missed call notification 10+ minutes later

**Current Handling**:

**Backend** — **USES HIGH PRIORITY**:
```php
// PushNotificationService.php
$message = CloudMessage::withTarget('token', $token)
    ->withNotification($notification)
    ->withData($data)
    ->withAndroidConfig(
        AndroidConfig::fromArray([
            'priority' => 'high',  // ← Bypasses Doze for ~10 seconds
        ])
    );
```
File: `app/Services/PushNotificationService.php`

**Android**:
- Z360 requests `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission
- But user may deny
- Even with permission: Doze restrictions may apply

**Three-channel dismissal** helps (SIP BYE still works):
- Channel 1 (SIP BYE): Works if SDK connected
- Channel 2 (Reverb): N/A on mobile
- Channel 3 (FCM push): Delayed by Doze

**Recovery Path**:
- High-priority push is delivered within 10s (if battery optimization exempt)
- If user denied exemption: push delayed indefinitely

**Recommended Improvement**:

**Priority: Low** (mitigation already in place)

1. **Proactively request battery optimization exemption**:
   - On first app launch: show dialog
   - Explain: "Allow Z360 to bypass battery optimization for reliable calls"
   - Android: Already has `requestBatteryOptimizationExemption()` method (GAP-016)
   - iOS: Not applicable
   - Effort: Small (0.5 day)

2. **Monitor battery optimization status**:
   - Track: % of devices with exemption granted
   - Show in-app reminder if exemption not granted
   - Effort: Small (1 day)

3. **Add "Missed call due to power settings" detection**:
   - If push delivery delayed >5s: log to analytics
   - Show user: "Enable battery optimization exemption for better reliability"
   - Effort: Medium (2 days)

**File References**:
- Backend: `app/Services/PushNotificationService.php`
- Android: `android/.../voip/TelnyxVoipPlugin.kt:6364-6396` (battery optimization check)
- Android permission: `AndroidManifest.xml` (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)

---

### FM-23: iOS Low Power Mode

**Scenario**:
1. iOS device in Low Power Mode (battery <20% or user-enabled)
2. Some background activities throttled
3. VoIP push should still work (high priority)
4. But audio/network may be affected

**Probability**: **Medium** — common for users with low battery

**User Impact**:
- Incoming calls should work (PushKit is exempt from Low Power Mode)
- Call quality may be degraded (network throttling, reduced CPU)

**Current Handling**:

**iOS**:
- PushKit VoIP pushes are **exempt** from Low Power Mode throttling
- Call should arrive normally
- Audio and network may be affected

**No explicit handling** in Z360 code for Low Power Mode detection

**Recovery Path**:
- N/A — Low Power Mode is user choice

**Recommended Improvement**:

**Priority: Very Low** (mostly handled by iOS, rare issues)

1. **Detect Low Power Mode and show banner**:
   ```swift
   if ProcessInfo.processInfo.isLowPowerModeEnabled {
       // Show banner: "Low Power Mode enabled - call quality may be affected"
   }
   ```
   Effort: Small (0.5 day)

2. **Log Low Power Mode status in analytics**:
   - Track: calls made/received in Low Power Mode
   - Monitor: call quality metrics (MOS, jitter) in Low Power Mode
   - Effort: Small (0.5 day)

**File References**:
- iOS: No current Low Power Mode handling
- iOS quality: `ios/App/App/VoIP/Utils/CallQualityMonitor.swift` (MOS tracking)

---

### FM-24: iOS PushKit 5-Second Deadline Violation (Cross-Org)

**Scenario** (GAP-01 from iOS architecture):
1. Cross-org incoming call (user connected to Org A, call for Org B)
2. PushKit push arrives → must report to CallKit within 5 seconds
3. Z360 performs org switch: API call (4s max) + SDK reconnect (~3s)
4. Total: 7+ seconds → **exceeds 5-second deadline**
5. iOS terminates app, **permanently revokes VoIP push entitlement**

**Probability**: **Low-Medium** — only cross-org calls under heavy load

**User Impact**:
- **Catastrophic**: VoIP push entitlement revoked permanently
- All future VoIP pushes fail
- User must reinstall app to restore entitlement

**Current Handling**:

**iOS** — **FRAGILE** (GAP-01, Critical):
```swift
// OrganizationSwitcher.swift:8050-8054
private let maxSwitchTimeSeconds: TimeInterval = 4.5
private let requestTimeoutSeconds: TimeInterval = 4.0

// PROBLEM: 4.5s total budget, 4.0s for API, leaves only 0.5s for SDK reconnect
// SDK reconnect can take 2-5 seconds under load
// Total: 4.0 + 3.0 = 7.0 seconds → DEADLINE VIOLATED
```
File: `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift:8050-8054`

**Recovery Path**:
- Current: Rollback to original org on failure
- But if deadline already violated: too late, entitlement revoked

**Recommended Improvement**:

**Priority: Critical** (GAP-01, can cause permanent failure)

1. **Decouple CallKit reporting from org switch** (RECOMMENDED):
   ```swift
   func processVoIPNotification(...) {
       // PHASE 1: Report to CallKit IMMEDIATELY (within 5ms)
       let update = CXCallUpdate()
       update.remoteHandle = CXHandle(type: .phoneNumber, value: callerNumber)
       update.localizedCallerName = "Loading..."  // Placeholder
       callKitManager.reportIncomingCall(uuid: uuid, update: update)

       // PHASE 2: Perform org switch in background (no deadline)
       Task {
           await performCrossOrgSwitch(targetOrgId: orgId)

           // Update CallKit display after switch
           let finalUpdate = CXCallUpdate()
           finalUpdate.localizedCallerName = callerName
           callKitManager.updateCall(uuid: uuid, update: finalUpdate)
       }
   }
   ```
   File: `ios/App/App/VoIP/Managers/PushKitManager.swift`
   Effort: Medium (3-4 days, critical testing)

2. **Pre-fetch cross-org credentials during ring phase**:
   - Detect cross-org call during push processing
   - Start API call in background (before user answers)
   - Cache credentials
   - On answer: use cached credentials (no API call)
   - Effort: Medium (3-4 days)

3. **Add 5-second deadline monitoring**:
   - Track: PushKit → CallKit report time
   - Alert if >4.5 seconds
   - Log: cross-org switch duration
   - Effort: Small (1 day)

**File References**:
- iOS: `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift:8050-8054`
- iOS: `ios/App/App/VoIP/Managers/PushKitManager.swift`
- Prior research: `.scratchpad/whitepaper/02-platform-architectures/ios-architecture-complete.md` (GAP-01, Critical)

---

### FM-25: Android Full-Screen Intent Permission Denied (Android 14+)

**Scenario**:
1. Android 14+ requires explicit permission for full-screen intents
2. User denies permission (or never prompted)
3. Incoming call shows as heads-up notification (not full-screen)
4. User misses call (notification may be dismissed accidentally)

**Probability**: **Medium** — Android 14+ adoption increasing

**User Impact**:
- Incoming calls less noticeable
- User may miss calls (especially if phone in pocket)

**Current Handling**:

**Android** — **NOT PROACTIVELY CHECKED** (GAP-016):
```kotlin
// TelnyxVoipPlugin.kt has method but never called automatically
@PluginMethod
fun openFullScreenIntentSettings(call: PluginCall) {
    // Opens settings for user to grant permission
    // BUT: Not called proactively on app launch
}
```
File: `android/.../voip/TelnyxVoipPlugin.kt`

**Recovery Path**:
- User must manually grant permission in Settings

**Recommended Improvement**:

**Priority: Low** (fallback to heads-up notification works)

1. **Proactively check and request permission** (GAP-016):
   ```kotlin
   // On app launch or first incoming call
   if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
       val nm = getSystemService(NotificationManager::class.java)
       if (!nm.canUseFullScreenIntent()) {
           // Show dialog explaining why permission is needed
           // Then open settings
           openFullScreenIntentSettings()
       }
   }
   ```
   File: `android/.../voip/TelnyxVoipPlugin.kt`
   Effort: Small (1 day)

2. **Monitor full-screen intent permission status**:
   - Track: % of devices with permission granted
   - Alert if <80% on Android 14+
   - Effort: Small (0.5 day)

**File References**:
- Android: `android/.../voip/TelnyxVoipPlugin.kt` (openFullScreenIntentSettings method)
- Prior research: `.scratchpad/whitepaper/02-platform-architectures/android-architecture-complete.md` (GAP-016)

---

## 6. Severity × Probability Matrix

| Failure Mode | Severity | Probability | Risk Score | Priority |
|--------------|----------|-------------|------------|----------|
| **FM-05** Backend restart during call | Critical | High | 9 | **P0** |
| **FM-03** App crash during call | Critical | Low-Med | 6 | **P0** |
| **FM-02** Complete network loss | Critical | Medium | 6 | **P0** |
| **FM-08** Firebase/APNs outage | Critical | Very Low | 3 | **P1** |
| **FM-07** Telnyx API outage | Critical | Very Low | 3 | **P1** |
| **FM-14** Redis failure | Critical | Low | 3 | **P0** |
| **FM-20** FCM token refresh not synced | Critical | High | 9 | **P0** |
| **FM-21** No webhook signature verification | Critical | Very Low | 3 | **P0** (security) |
| **FM-24** iOS PushKit deadline violation | Critical | Low-Med | 6 | **P0** |
| **FM-01** Network transition | High | High | 6 | **P1** |
| **FM-04** SDK auto-reconnect disabled | High | High | 6 | **P0** |
| **FM-12** Cold start push before init | High | High | 6 | **P1** |
| **FM-13** Backend deploy | High | High | 6 | **P1** |
| **FM-18** Telnyx API outage | High | Very Low | 2 | **P1** |
| **FM-03** WebSocket disconnect (web) | High | Medium | 4 | **P1** |
| **FM-06** Call recording failure | Medium | Low | 2 | **P2** |
| **FM-09** App killed by OS | Medium | Low | 2 | **P2** |
| **FM-10** App killed by user | Medium | Very Low | 1 | **P3** |
| **FM-15** DB connection pool exhausted | Medium | Low-Med | 3 | **P2** |
| **FM-17** Multi-region latency | Medium | High | 4 | **P2** |
| **FM-19** FCM/APNs push outage | Medium | Very Low | 1 | **P2** |
| **FM-22** Android Doze mode | Medium | Medium | 3 | **P2** |
| **FM-05** ICE connection failure | Low | Low-Med | 2 | **P3** |
| **FM-11** App force-quit | Low | Very Low | 1 | **P3** |
| **FM-16** TLS cert expiry | Low | Very Low | 1 | **P3** |
| **FM-23** iOS Low Power Mode | Low | Medium | 2 | **P3** |
| **FM-25** Android full-screen intent | Low | Medium | 2 | **P3** |

**Risk Score** = Severity (1-3) × Probability (1-3), where:
- Severity: Low=1, Medium=2, High=3, Critical=3
- Probability: Very Low=1, Low=1.5, Medium=2, High=3

---

## 7. Cross-Reference with Prior Research

### From `inbound-call-flow-unified.md` (Section 9)

| ID | Prior Research | This Document |
|----|---------------|---------------|
| RC-4 | Bridge failure after answer | FM-07 (already roadmapped) |
| RC-5 | Webhook loss | FM-08 (already roadmapped) |
| RC-6 | WebSocket disconnect (web) | FM-03 (WebSocket disconnect) |

### From `call-state-complete.md`

| Finding | This Document |
|---------|---------------|
| Three-channel dismissal cascade | FM-05 (backend restart), FM-14 (Redis failure) |
| RINGING state not persisted | Not directly a "failure" — architectural gap |
| Backend stateless after ring | FM-05 (backend restart impact) |

### From `credentials-unified.md` (Edge Cases E1-E22)

| Edge Case | This Document |
|-----------|---------------|
| E1: Session expires during call | Not a failure — call continues |
| E2: Session expires, push arrives | FM-25 (Android full-screen intent), FM-12 (iOS cold start) |
| E3: User deleted | Not a failure mode — administrative action |
| E18: Telnyx API down during credential creation | FM-18 (Telnyx API outage) |
| E19: Telnyx API down during credential deletion | FM-18 (Telnyx API outage) |
| E20: Database down during credential save | FM-15 (DB connection pool) |

### From `ios-architecture-complete.md`

| Gap | This Document |
|-----|---------------|
| G-01: Cross-org timing (0.5-1.0s margin) | FM-24 (iOS PushKit deadline violation) |
| G-04: Cold-start push before Phase 2 | FM-12 (Cold start push before initialization) |

### From `android-architecture-complete.md`

| Gap | This Document |
|-----|---------------|
| GAP-017: Auto-reconnect not enabled | FM-04 (SDK auto-reconnect disabled) |
| GAP-024: FCM token refresh not synced | FM-20 (FCM token refresh) |
| GAP-015: No network monitoring | FM-01 (Network transition) |

---

## 8. Implementation Roadmap

### Sprint 1: Critical Failures (P0) — 10-15 days

| Priority | FM | Action | Effort | Owner |
|----------|-----|--------|--------|-------|
| 1 | FM-04 | Enable `autoReconnect: true` in Android | 0.5d | Android |
| 2 | FM-20 | Sync FCM token on refresh + backend endpoint | 2d | Android + Backend |
| 3 | FM-14 | Add Redis health check + database lock fallback | 3d | Backend |
| 4 | FM-24 | Decouple CallKit from org switch on iOS | 4d | iOS |
| 5 | FM-21 | Implement webhook signature verification | 2d | Backend |
| 6 | FM-05 | Graceful shutdown + webhook queue persistence | 5d | Backend |

**Total**: 16.5 days (parallel work possible)

### Sprint 2: High Priority (P1) — 8-12 days

| Priority | FM | Action | Effort | Owner |
|----------|-----|--------|--------|-------|
| 1 | FM-01 | Android NetworkMonitor + reconnection handling | 3d | Android |
| 2 | FM-02 | iOS reconnecting UI + backend call health check | 3d | iOS + Backend |
| 3 | FM-03 | Web Reverb `.incoming_call` fallback listener | 2d | Web |
| 4 | FM-12 | iOS trigger Phase 2 from PushKit on cold start | 3d | iOS |
| 5 | FM-13 | Backend graceful shutdown + circuit breaker | 3d | Backend |

**Total**: 14 days (parallel work possible)

### Sprint 3: Medium Priority (P2) — 10-15 days

| Priority | FM | Action | Effort | Owner |
|----------|-----|--------|--------|-------|
| 1 | FM-06 | Recording health check + retry | 2d | Backend |
| 2 | FM-15 | DB connection pool monitoring + optimization | 2d | Backend |
| 3 | FM-18 | Telnyx API retry + circuit breaker | 3d | Backend |
| 4 | FM-22 | Battery optimization request + monitoring | 1.5d | Android |
| 5 | FM-17 | Parallelize leg creation | 3d | Backend |

**Total**: 11.5 days

### Sprint 4: Low Priority (P3) — 5-8 days

| Priority | FM | Action | Effort | Owner |
|----------|-----|--------|--------|-------|
| 1 | FM-05 | ICE diagnostics + configurable relay | 2d | iOS/Android |
| 2 | FM-16 | Certificate expiry monitoring | 1d | Backend |
| 3 | FM-23 | iOS Low Power Mode detection + banner | 1d | iOS |
| 4 | FM-25 | Android full-screen intent proactive check | 1d | Android |

**Total**: 5 days

---

## Appendix A: Testing Scenarios

### Network Failure Tests

| Test | Setup | Expected |
|------|-------|----------|
| T1 | Active call, toggle airplane mode for 5s | Call reconnects (iOS/Web), Android drops (before fix) |
| T2 | Active call, WiFi → cellular transition | Brief audio gap <3s, call continues |
| T3 | Active call, enter tunnel (30s no network) | iOS shows "Reconnecting", resumes on exit |
| T4 | Incoming call, WebSocket disconnected (web) | (After fix) Reverb fallback shows call UI |

### Infrastructure Failure Tests

| Test | Setup | Expected |
|------|-------|----------|
| T5 | Active call, restart Laravel backend | Call audio continues, webhooks resume after restart |
| T6 | Incoming call, Redis unavailable | (After fix) Database lock fallback, call bridges |
| T7 | Credential creation, Telnyx API returns 500 | (After fix) Retry 3x with backoff, then fail gracefully |
| T8 | Active call, stop Redis | Call continues, new inbound calls fail until Redis restored |

### Mobile Failure Tests

| Test | Setup | Expected |
|------|-------|----------|
| T9 | Active call, kill app via task switcher | iOS/Android detect orphan on restart, show notification |
| T10 | Incoming call, device in Doze mode | Push delayed up to 15 min (unless battery optimization exempt) |
| T11 | Cross-org call on iOS, slow API (4s response) | (After fix) CallKit reports immediately, org switch in background |
| T12 | Cold start, VoIP push arrives | (After fix) Audio ready within 2s of push |

### Security Tests

| Test | Setup | Expected |
|------|-------|----------|
| T13 | Send webhook with invalid signature | 403 Forbidden |
| T14 | Send webhook with stale timestamp (>5 min old) | 403 Forbidden |
| T15 | Send valid webhook | 200 OK, processed normally |

---

*Document generated: 2026-02-08*
*Research team: failure-modes (Task #3) + Session 01-09 prior research*
*Total failure modes documented: 25*
*Total file references: 80+*
*Total recommendations: 45+*
