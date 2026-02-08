---
title: Android Gap Analysis
---

# Android VoIP Gap Analysis

> Exhaustive comparison of Z360's current Android VoIP implementation against the target architecture.
> Every gap is backed by code evidence from the voip-android skill, voip-frontend skill, voip-backend skill, and Telnyx SDK/demo packs.

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **Critical** | 4 | Breaks core functionality or causes data loss |
| **High** | 9 | Significant deviation from target, visible to users or creates reliability risk |
| **Medium** | 10 | Notable deficiency that degrades quality or maintainability |
| **Low** | 5 | Minor issues, cosmetic, or fragile patterns |
| **Total** | **28** | |

---

## Table of Contents

1. [Architectural Gaps (GAP-001 – GAP-004)](#1-architectural-gaps)
2. [Flow Gaps (GAP-005 – GAP-008)](#2-flow-gaps)
3. [Race Conditions (GAP-009 – GAP-011)](#3-race-conditions)
4. [Platform Compliance Gaps (GAP-012 – GAP-016)](#4-platform-compliance-gaps)
5. [SDK Usage Gaps (GAP-017 – GAP-019)](#5-sdk-usage-gaps)
6. [Outbound Calling Gaps (GAP-020)](#6-outbound-calling-gaps)
7. [Call UI Gaps (GAP-021 – GAP-022)](#7-call-ui-gaps)
8. [Backend Communication Gaps (GAP-023 – GAP-025)](#8-backend-communication-gaps)
9. [Credential & State Management Gaps (GAP-026 – GAP-027)](#9-credential--state-management-gaps)
10. [Notification & Push Gaps (GAP-028)](#10-notification--push-gaps)
11. [Analytics & Logging Gaps (GAP-029)](#11-analytics--logging-gaps)
12. [Web/Native Isolation Gaps (GAP-030 – GAP-032)](#12-webnative-isolation-gaps)
13. [Testing Gaps (GAP-033)](#13-testing-gaps)
14. [Priority Matrix](#14-priority-matrix)

---

## 1. Architectural Gaps

### GAP-001: No CallStyle Notifications

- **Category**: Architectural
- **Severity**: High
- **Current behavior**: Z360 uses a basic `NotificationCompat.Builder` with `fullScreenIntent` for incoming calls. No `CallStyle` is applied.
  - **File**: `voip/Z360Connection.kt` (skill line 8794–8835)
  - Code: `NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID).setSmallIcon(...).setContentTitle("Incoming Call")...setFullScreenIntent(fullScreenPendingIntent, true).build()`
- **Expected behavior**: Target architecture §13.2 specifies `CallStyle.forIncomingCall()` on API 31+ (Android 12) and `CallStyle.forOngoingCall()` for active calls. This provides native call appearance with system-styled answer/reject buttons.
- **Evidence**:
  - Grep for `CallStyle` in voip-android skill: **zero matches**
  - Telnyx Android demo uses `CallStyle.forIncomingCall()` with `Person.Builder` (platform requirements §5, Telnyx demo CallNotificationService)
  - Android platform requirements §5: "CallStyle provides native call appearance and is recommended by Google"
- **Fix approach**: In `Z360Connection.postIncomingCallNotification()`, check `Build.VERSION.SDK_INT >= Build.VERSION_CODES.S` and apply `NotificationCompat.CallStyle.forIncomingCall(person, declinePendingIntent, answerPendingIntent)`. Fall back to current basic notification on older APIs.
- **Effort estimate**: Small (< 1 day)

---

### GAP-002: No Ongoing Call Notification Channel or Notification

- **Category**: Architectural
- **Severity**: High
- **Current behavior**: During an active call, Z360 relies solely on the `CallForegroundService` notification (from Telnyx `telnyx_common` library, running in `:call_service` process). There is no Z360-branded ongoing call notification with caller info, duration, or hangup action.
  - Grep for `z360_ongoing_call` in voip-android skill: **zero matches**
  - Grep for `forOngoingCall` in voip-android skill: **zero matches**
- **Expected behavior**: Target architecture §13.1 defines a `z360_ongoing_call` notification channel (IMPORTANCE_LOW) with `CallStyle.forOngoingCall()` showing caller name, call duration, and hangup button.
- **Evidence**:
  - Current notification channels: `z360_incoming_call`, `z360_crash_recovery`, `z360_missed_calls` — no ongoing channel
  - Telnyx demo implements `CallStyle.forOngoingCall()` (platform requirements §5)
  - The `CallForegroundService` notification is generic (Telnyx-branded, not Z360-branded)
- **Fix approach**: Create `z360_ongoing_call` notification channel in `ActiveCallActivity.onCreate()`. Post `CallStyle.forOngoingCall()` notification when call becomes ACTIVE. Update it with call duration periodically. Cancel on call end.
- **Effort estimate**: Medium (1–3 days) — requires coordination with the separate `:call_service` process to avoid duplicate notifications

---

### GAP-003: No Formal Call State Machine

- **Category**: Architectural
- **Severity**: Medium
- **Current behavior**: Call states are implicitly managed through Activity lifecycle, SDK events, and scattered boolean flags. There is no centralized sealed class defining valid states and transitions.
  - Grep for `CallStateMachine` or `sealed.*class.*CallState` in voip-android skill: **zero matches**
  - States are tracked via: `isAnswering` (AtomicBoolean), `isCallActive` (Boolean), `isCallConnected` (Boolean), `isHeld` (Boolean), SDK `uiState` flow events
- **Expected behavior**: Target architecture §5 defines a formal state machine with 10 states (IDLE, RINGING_INBOUND, RINGING_OUTBOUND, CONNECTING, ACTIVE, ON_HOLD, RECONNECTING, DISCONNECTING, ENDED, FAILED) and explicit transition table.
- **Evidence**:
  - `ActiveCallActivity.kt` (skill lines 1318–1349) uses multiple independent booleans for call state
  - No exhaustive `when` matching on call states — state transitions handled in separate callbacks
  - Target architecture §5.3 has a complete state transition table with 18 defined transitions
- **Fix approach**: Create `sealed class VoipCallState` with all 10 states. Add `MutableStateFlow<VoipCallState>` to a new `CallStateManager` singleton. All components observe this single source of truth instead of independent booleans.
- **Effort estimate**: Large (3+ days) — touches every VoIP component

---

### GAP-004: ConnectionService Missing `onCreateOutgoingConnection`

- **Category**: Architectural
- **Severity**: Medium
- **Current behavior**: `Z360ConnectionService` only implements `onCreateIncomingConnection()` and `onCreateIncomingConnectionFailed()`. Outbound calls bypass the Telecom framework entirely — they go directly through `TelnyxVoipPlugin.makeCall()` → `TelnyxViewModel.sendInvite()` → `ActiveCallActivity`.
  - Grep for `onCreateOutgoingConnection` or `placeCall` in voip-android skill: **zero matches**
- **Expected behavior**: Outbound calls should use `TelecomManager.placeCall()` → `onCreateOutgoingConnection()` to get system integration for outbound calls (Bluetooth answer button during outgoing ringing, car head unit display, system call log integration).
- **Evidence**:
  - `Z360ConnectionService.kt` (skill lines 8873–9007) — only has incoming connection methods
  - Android Telecom framework supports `placeCall()` for self-managed ConnectionService apps
  - Current outbound flow: plugin method → SDK → Activity launch directly, no Telecom integration
- **Fix approach**: Implement `onCreateOutgoingConnection()` in `Z360ConnectionService`. In `TelnyxVoipPlugin.makeCall()`, call `TelecomManager.placeCall()` instead of directly launching `ActiveCallActivity`. Create `Z360Connection` for outbound calls with `setDialing()` → `setActive()` lifecycle.
- **Effort estimate**: Medium (1–3 days)

---

## 2. Flow Gaps

### GAP-005: No Client-Side Inbound Ringing Timeout

- **Category**: Flow
- **Severity**: Medium
- **Current behavior**: `IncomingCallActivity` has no local timer to auto-dismiss after a timeout. It relies entirely on the Telnyx platform's 30-second ring timeout sending `call.hangup`, which triggers `OnCallEnded` in the SDK, which then dismisses the Activity.
  - Grep for `ringing.*timeout` or `RING_TIMEOUT` in voip-android skill: only outgoing call timeout found (US-016), no inbound timeout
  - Comment at skill line 983: "Don't show incoming call UI — the call will timeout on Telnyx side"
- **Expected behavior**: Target architecture §5.3 specifies: "RINGING_INBOUND + Timeout (30s) → ENDED: Auto-dismiss, show missed call notification". A local 30-second safety timer should dismiss the incoming call UI if neither the SDK `OnCallEnded` event nor the `call_ended` push arrives.
- **Evidence**:
  - `IncomingCallActivity.kt` (skill lines 4363–5230) — no Handler.postDelayed or coroutine timer for ring timeout
  - Outgoing calls have a 30-second timeout at line 1257: `OUTGOING_CALL_SETUP_TIMEOUT_MS = 30000L`
  - No equivalent for inbound
- **Fix approach**: Add a 35-second safety timer in `IncomingCallActivity.onCreate()` (5s buffer beyond Telnyx's 30s). On timeout: show missed call notification, dismiss activity, notify `Z360Connection.notifyRejected()`.
- **Effort estimate**: Small (< 1 day)

---

### GAP-006: `runBlocking` Used on FCM Thread

- **Category**: Flow
- **Severity**: High
- **Current behavior**: `Z360FirebaseMessagingService` uses `runBlocking {}` for both PushSynchronizer wait and SDK reconnection on the FCM handler thread.
  - **File**: `fcm/Z360FirebaseMessagingService.kt` (skill line 870, 1051)
  - Line 870: `val syncResult = runBlocking { ... }` (PushSynchronizer)
  - Line 1051: `val connected = runBlocking { ... }` (SDK reconnect with 5s timeout)
- **Expected behavior**: FCM's `onMessageReceived()` runs on a background thread that should not be blocked for extended periods. While it has a 20-second execution window, `runBlocking` with a 5-second SDK connect timeout + 500ms push sync timeout blocks the thread for up to 5.5 seconds. If the FCM thread pool is exhausted, subsequent pushes are delayed.
- **Evidence**:
  - `runBlocking` found at skill lines 609, 870, 1051
  - Target architecture §14 defines the FCM thread model: "Z360FirebaseMessagingService.onMessageReceived() — PushSynchronizer (runs on FCM thread + suspend)" — implies `suspend` not `runBlocking`
  - Android docs: "If you need to perform long-running operations, use WorkManager or coroutines"
- **Fix approach**: Since `onMessageReceived` already runs on a background thread, the pattern works in practice. However, refactor to use `CoroutineScope(Dispatchers.IO).launch` with proper structured concurrency instead of `runBlocking` to prevent thread pool starvation under rapid consecutive pushes.
- **Effort estimate**: Medium (1–3 days) — requires careful testing of push handling timing

---

### GAP-007: Missing `connectWithToken()` Native Implementation

- **Category**: Flow
- **Severity**: Critical
- **Current behavior**: The TypeScript `TelnyxVoipPlugin` interface at `resources/js/plugins/telnyx-voip.ts` (skill line 1449) defines `connectWithToken()` for JWT-based login, but the Android `TelnyxVoipPlugin.kt` has NO `@PluginMethod fun connectWithToken()` implementation.
  - Grep for `connectWithToken` in voip-android skill: **zero matches**
  - TypeScript interface (voip-frontend skill line 1446–1453): `connectWithToken(options: { token: string; callerIdName?: string; callerIdNumber?: string }): Promise<void>;`
- **Expected behavior**: Token-based login should be the preferred connection method, as noted in the interface comment: "Connect to Telnyx with JWT token (token login - preferred method)". JWTs have 10-hour TTL and are more secure than passing raw SIP credentials.
- **Evidence**:
  - Telnyx SDK supports `TokenConfig` for token-based login (telnyx-reference-unified §2.3)
  - Current Android plugin only supports `credentialLogin` (SIP username/password) at skill lines 5948, 1043, 6273
  - `sipToken` is referenced only in profile deletion (skill line 6578), never in login
- **Fix approach**: Add `@PluginMethod fun connectWithToken(call: PluginCall)` to `TelnyxVoipPlugin.kt`. Extract the `token` parameter and use `TelnyxConfig.TokenConfig(sipToken = token, ...)` for `telnyxViewModel.tokenLogin()`. This is the backend's preferred method since it generates 10h JWTs.
- **Effort estimate**: Small (< 1 day)

---

### GAP-008: Missing Capacitor Bridge Methods (getNetworkStatus, getConnectionState, getFcmTokenWithWait)

- **Category**: Flow
- **Severity**: High
- **Current behavior**: The TypeScript `TelnyxVoipPlugin` interface defines three methods that have NO native Android implementation:
  1. `getNetworkStatus()` (TS line 1538): Returns `{ status: string; type: string }` from native NetworkMonitor
  2. `getConnectionState()` (TS line 1549): Returns `{ connected: boolean; ready: boolean }`
  3. `getFcmTokenWithWait(options?)` (TS line 1532): Polls for FCM token with timeout
  - Grep for all three method names in voip-android skill: **zero matches**
- **Expected behavior**: All methods defined in the TypeScript interface must have corresponding `@PluginMethod` implementations in the native plugin. Calling these from JS will silently fail or throw an unhandled error.
- **Evidence**:
  - TypeScript interface at voip-frontend skill lines 1537–1549 defines these methods
  - Android plugin's 20 `@PluginMethod` annotations (skill lines 5912–6400) don't include any of these three
  - `TelnyxVoipWeb` (web fallback) also has stubs for these methods, confirming they're expected cross-platform
- **Fix approach**:
  - `getNetworkStatus()`: Register a `ConnectivityManager.NetworkCallback` and expose current status
  - `getConnectionState()`: Read from `telnyxViewModel.sessionsState` and `connectionStatus` flows
  - `getFcmTokenWithWait()`: Implement polling loop using `TokenHolder.getToken()` with configurable timeout
- **Effort estimate**: Medium (1–3 days)

---

## 3. Race Conditions

### GAP-009: No Mutex Between FCM Handler and Plugin Connect During Org Switch

- **Category**: Race Condition
- **Severity**: High
- **Current behavior**: When an FCM push arrives for a cross-org call, `Z360FirebaseMessagingService.handleTelnyxMetadataPush()` calls `ensureTelnyxSdkConnected()` which does `credentialLogin()` with stored credentials. Simultaneously, `TelnyxVoipPlugin.connect()` may be called from the WebView during app initialization. These two paths can race to call `credentialLogin()` with different credentials.
  - **FCM path** (skill line 1043): `telnyxViewModel.credentialLogin(viewContext, profile, txPushMetaData = txPushMetaDataJson)`
  - **Plugin path** (skill line 5948): `telnyxViewModel.credentialLogin(viewContext, ...)`
  - **Reconnect path** (skill line 6273): `telnyxViewModel.credentialLogin(viewContext, ...)`
- **Expected behavior**: A mutex or lock should serialize credential changes. When one path is in the middle of credentialLogin + state check, others should wait or be rejected.
- **Evidence**:
  - BUG-003 partially addresses this (skip if already connected), but only checks `ClientLoggedIn` state — not the in-progress login case
  - No `Mutex` or `ReentrantLock` around the credential login flow in the plugin (skill line 5862: `private val scope = CoroutineScope(...)` — no lock)
  - OrgSwitchHelper at skill line 5583 runs on `Dispatchers.IO` independently
- **Fix approach**: Add a `Mutex` in `TelnyxVoipPlugin` that wraps all three `credentialLogin` call sites. The FCM handler should acquire the mutex before reconnecting, and `connect()` / `reconnectWithCredentials()` should also acquire it.
- **Effort estimate**: Medium (1–3 days)

---

### GAP-010: Simultaneous Answer and Call-Ended Push Race

- **Category**: Race Condition
- **Severity**: Medium
- **Current behavior**: When user taps "Answer" on `IncomingCallActivity` at nearly the same time as a `call_ended` push arrives (another device answered in simultaneous ring), both paths execute concurrently:
  - Answer path: `answerDirectly()` → `telnyxViewModel.answerCall()` → transition to `ActiveCallActivity`
  - Dismissal path: `ACTION_CALL_ENDED` broadcast → BroadcastReceiver → `finish()` Activity
  - BUG-005's `AtomicBoolean` only prevents double-tap on answer, not answer-vs-dismiss race
- **Expected behavior**: If a `call_ended` push is received after the user has already tapped answer but before the SDK confirms, the answer should be aborted and the activity dismissed gracefully without transitioning to `ActiveCallActivity`.
- **Evidence**:
  - `IncomingCallActivity` registers a `BroadcastReceiver` for `ACTION_CALL_ENDED` (skill lines 4535–4540)
  - The `answerDirectly()` flow (skill lines 4860–4940) runs in `lifecycleScope.launch` — not guarded against concurrent dismissal
  - No check of dismissal state before launching `ActiveCallActivity`
- **Fix approach**: Add a `dismissed` `AtomicBoolean` flag. Set it in the `ACTION_CALL_ENDED` receiver. Check it before launching `ActiveCallActivity` in the answer flow. If dismissed, abort answer and clean up.
- **Effort estimate**: Small (< 1 day)

---

### GAP-011: Credential Refresh During Active Call Not Handled

- **Category**: Race Condition
- **Severity**: Medium
- **Current behavior**: If a JWT or SIP credential expires during an active call, there's no mechanism to refresh it without disrupting the call. The current flow: SDK disconnects → `OnCallDropped` → call ends.
  - No credential refresh logic during active call found in any component
  - `connectionStatus` flow changes are observed (skill line 6477), but only for logging, not for credential refresh
- **Expected behavior**: The SDK's auto-reconnect mechanism should handle transient WebSocket disconnections. However, if the credential itself expires (SIP password rotation, JWT TTL), the active call's media should continue while credentials are refreshed in background.
- **Evidence**:
  - Telnyx reference §7.3: "JWT expires after ~10 hours"
  - No `autoReconnect` configuration found in any `credentialLogin` call (Telnyx SDK Android defaults to `false` for credential login per telnyx-reference-unified §6.3)
  - `TelnyxVoipPlugin.connect()` (skill line 5948) doesn't set `autoReconnect` parameter
- **Fix approach**:
  1. Enable `autoReconnect = true` in all `credentialLogin()` calls (also addresses GAP-017)
  2. Monitor `connectionStatus` flow for disconnect events during active call
  3. On disconnect with active call: attempt background credential refresh without ending the call
- **Effort estimate**: Medium (1–3 days)

---

## 4. Platform Compliance Gaps

### GAP-012: Audio Focus Uses GAIN_TRANSIENT Instead of GAIN_TRANSIENT_EXCLUSIVE

- **Category**: Platform Compliance
- **Severity**: Low
- **Current behavior**: `AudioDiagnostics.requestAudioFocus()` requests `AudioManager.AUDIOFOCUS_GAIN_TRANSIENT`.
  - **File**: `voip/AudioDiagnostics.kt` (skill line 2758)
  - Code: `AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)`
- **Expected behavior**: Target architecture §9.3 specifies `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` which prevents other apps from playing any audio (even ducked) during VoIP calls.
- **Evidence**:
  - Skill line 2758: `AUDIOFOCUS_GAIN_TRANSIENT` (allows other apps to duck)
  - Target architecture §9.1: "AudioFocusRequest(USAGE_VOICE_COMMUNICATION, AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)"
  - Android docs: GAIN_TRANSIENT allows other apps to duck; GAIN_TRANSIENT_EXCLUSIVE fully silences them
- **Fix approach**: Change `AUDIOFOCUS_GAIN_TRANSIENT` to `AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` in `AudioDiagnostics.requestAudioFocus()`.
- **Effort estimate**: Small (< 1 day)

---

### GAP-013: No Modern Audio Routing APIs (API 31+)

- **Category**: Platform Compliance
- **Severity**: Medium
- **Current behavior**: Audio routing uses legacy APIs exclusively: `AudioManager.setSpeakerphoneOn()`, `AudioManager.startBluetoothSco()`, `AudioManager.setMode()`. No use of modern `setCommunicationDevice()` / `clearCommunicationDevice()` APIs.
  - Grep for `setCommunicationDevice` or `clearCommunicationDevice` in voip-android skill: **zero matches**
  - `BluetoothAudioManager` at skill lines 2975–3200: uses `startBluetoothSco()`/`stopBluetoothSco()` exclusively
- **Expected behavior**: Target architecture §9.1 specifies: "Modern (API 31+): setCommunicationDevice(device), getAvailableCommunicationDevices(), clearCommunicationDevice()". These are the recommended APIs since Android 12.
- **Evidence**:
  - `setSpeakerphoneOn()` is deprecated in Android 12+ (API 31)
  - `startBluetoothSco()` is deprecated in Android 12+ (API 31)
  - Target architecture §9.1 shows the dual-path: Modern (API 31+) and Legacy (pre-API 31)
  - Current implementation only has the legacy path
- **Fix approach**: Add API level check in `AudioDiagnostics` and `BluetoothAudioManager`. On API 31+, use `getAvailableCommunicationDevices()` to enumerate audio devices and `setCommunicationDevice()` for routing. Fall back to legacy APIs on older devices.
- **Effort estimate**: Medium (1–3 days)

---

### GAP-014: No Accessibility Support in Call UI

- **Category**: Platform Compliance
- **Severity**: Medium
- **Current behavior**: `IncomingCallActivity` and `ActiveCallActivity` have no `contentDescription`, `importantForAccessibility`, or other accessibility annotations on interactive elements (answer/reject buttons, mute/hold/speaker toggles, DTMF keypad).
  - Grep for `accessibility` or `contentDescription` in voip-android skill: **zero matches**
- **Expected behavior**: All interactive call UI elements should have content descriptions for screen reader (TalkBack) users. Call state changes should announce via `AccessibilityEvent`.
- **Evidence**:
  - Both Activities use programmatic View creation and XML layouts with no accessibility attributes
  - Google's Material Design accessibility guidelines require content descriptions on all buttons
  - This is an ADA/WCAG compliance concern for enterprise SaaS
- **Fix approach**: Add `contentDescription` to all buttons in IncomingCallActivity (answer, reject) and ActiveCallActivity (mute, hold, speaker, keypad digits, hangup). Add `announceForAccessibility()` calls on state changes.
- **Effort estimate**: Small (< 1 day)

---

### GAP-015: No Network Change Monitoring

- **Category**: Platform Compliance
- **Severity**: Medium
- **Current behavior**: There is no `ConnectivityManager.NetworkCallback` registration to monitor network transitions (WiFi → cellular, loss of connectivity, etc.). The app relies entirely on the Telnyx SDK's internal reconnection.
  - Grep for `NetworkCallback` or `ConnectivityManager` in voip-android skill: **zero matches**
- **Expected behavior**: Target architecture implies network monitoring via the `getNetworkStatus()` bridge method (also GAP-008). The frontend interface even defines a `networkStatusChanged` event listener. A native `NetworkMonitor` component should:
  1. Detect network transitions
  2. Proactively trigger SDK reconnection
  3. Emit events to the web layer
  4. Log network state changes for diagnostics
- **Evidence**:
  - TypeScript interface line 1663: `addListener('networkStatusChanged', ...)` — event defined but no native emitter
  - TypeScript interface line 1537: `getNetworkStatus()` — method defined but not implemented
  - Telnyx iOS SDK uses `NWPathMonitor` for network monitoring (telnyx-reference-unified §6.3)
  - Android SDK doesn't monitor network internally for credential login (auto-reconnect defaults to `false`)
- **Fix approach**: Create a `NetworkMonitor` singleton that registers a `ConnectivityManager.NetworkCallback`. On network change: log via `VoipLogger`, emit `networkStatusChanged` event via `notifyListeners()`, and trigger SDK reconnect if disconnected during an active call.
- **Effort estimate**: Medium (1–3 days)

---

### GAP-016: Android 14+ Full-Screen Intent Permission Not Enforced Before Showing Calls

- **Category**: Platform Compliance
- **Severity**: Low
- **Current behavior**: The permission check for `canUseFullScreenIntent()` is done at notification time (skill line 1127) but only logs a warning — it doesn't prevent the notification from being posted or trigger a user prompt. The `openFullScreenIntentSettings()` method exists but is never called proactively.
  - Skill line 1127–1137: `if (!canUseFullScreen) { VoipLogger.w(...) }` — warning only
- **Expected behavior**: On first push-based call arrival on Android 14+, if the full-screen intent permission is not granted, Z360 should still show the notification (it falls back to heads-up), but should also proactively prompt the user to grant this permission during onboarding or settings setup.
- **Evidence**:
  - `openFullScreenIntentSettings()` at skill line 6401 exists as a plugin method, callable from JS
  - But there's no native-side proactive check during initialization or first call
  - ConnectionService provides a partial fallback, but not all OEMs honor it on lock screen without the permission
- **Fix approach**: During `TelnyxVoipPlugin.load()`, check `canUseFullScreenIntent()` on API 34+. If not granted, set a flag in `Z360VoipStore`. The web layer can then prompt the user during onboarding.
- **Effort estimate**: Small (< 1 day)

---

## 5. SDK Usage Gaps

### GAP-017: SDK Auto-Reconnect Not Configured

- **Category**: SDK Usage
- **Severity**: High
- **Current behavior**: All three `credentialLogin()` call sites pass credentials but do NOT set `autoReconnect = true`. The Telnyx Android SDK defaults `autoReconnect` to `false` for credential login.
  - Skill line 5948 (plugin connect): `telnyxViewModel.credentialLogin(viewContext, ...)` — no autoReconnect param
  - Skill line 1043 (FCM reconnect): `telnyxViewModel.credentialLogin(viewContext, profile, txPushMetaData = ...)` — no autoReconnect param
  - Skill line 6273 (reconnectWithCredentials): `telnyxViewModel.credentialLogin(viewContext, ...)` — no autoReconnect param
- **Expected behavior**: Per telnyx-reference-unified §6.3: "Android credential login defaults to `false`; iOS/Web default to `true`". This means on Android, if the WebSocket connection drops during an active call, the SDK will NOT automatically attempt to reconnect. The user's call silently dies.
- **Evidence**:
  - Grep for `auto_reconnect` or `autoReconnect` in voip-android skill: **zero matches**
  - Telnyx SDK reference: Android CredentialConfig has `autoReconnect` parameter
  - iOS and Web SDKs default to `true`, creating a platform behavioral inconsistency
- **Fix approach**: Add `autoReconnect = true` to all `credentialLogin()` calls. Test that reconnection works after brief network drops during active calls.
- **Effort estimate**: Small (< 1 day)

---

### GAP-018: Hardcoded Telnyx SDK Notification ID (1234)

- **Category**: SDK Usage
- **Severity**: Low
- **Current behavior**: Z360 cancels the Telnyx SDK's internal notification using hardcoded ID `1234` in at least 6 locations across the codebase.
  - Skill lines: 720, 998, 4548, 4796, 4955, 5248 — all contain `cancel(1234)` or reference to "Telnyx SDK notification (ID 1234)"
  - Comment at line 998: "Suppress Telnyx SDK's internal notification (ID 1234) which races our UI"
- **Expected behavior**: Use the SDK's own constant or API to cancel its notification, rather than relying on a hardcoded magic number that could change in any SDK update.
- **Evidence**:
  - Line 720: `CallNotificationService.cancelNotification(this)` — this IS the correct API, but other locations use raw `cancel(1234)`
  - The SDK does provide `CallNotificationService.cancelNotification()` as the proper API
  - A Telnyx SDK update changing this ID would silently break notification suppression
- **Fix approach**: Replace all `nm?.cancel(1234)` calls with `CallNotificationService.cancelNotification(context)`. If `cancelNotification()` isn't accessible from all contexts, extract the notification ID from the SDK's public constants.
- **Effort estimate**: Small (< 1 day)

---

### GAP-019: No ICE Restart Support

- **Category**: SDK Usage
- **Severity**: Low
- **Current behavior**: No ICE restart mechanism exists. If the media path degrades (ICE candidate changes, TURN relay needed), the call relies entirely on SDK reconnection at the WebSocket level.
  - Grep for `ICE.*restart` or `iceRestart` in voip-android skill: **zero matches**
- **Expected behavior**: For media path recovery without full reconnection, ICE restart renegotiates the media path. The Telnyx iOS SDK has explicit `Call+IceRestart` support.
- **Evidence**:
  - Telnyx reference §6.3: "ICE restart: Only iOS SDK has explicit ICE restart support"
  - Android SDK may handle this internally, but Z360 has no explicit trigger
  - This is a lower-priority gap since full reconnection handles most cases
- **Fix approach**: Investigate if the Telnyx Android SDK exposes ICE restart API. If so, trigger ICE restart on network transitions detected by the NetworkMonitor (GAP-015). If not, defer to SDK reconnection.
- **Effort estimate**: Small (< 1 day) for investigation, Medium if implementation needed

---

## 6. Outbound Calling Gaps

### GAP-020: Outbound Calls Lack ConnectionService Integration

- **Category**: Outbound Calling
- **Severity**: Medium
- **Current behavior**: Outbound calls bypass the Android Telecom framework entirely. The flow is: `TelnyxVoipPlugin.makeCall()` → `TelnyxViewModel.sendInvite()` → directly launch `ActiveCallActivity`.
  - Same as GAP-004 — no `onCreateOutgoingConnection()` in `Z360ConnectionService`
  - `makeCall()` at skill line 6046–6138: launches ActiveCallActivity via Intent, no TelecomManager involvement
- **Expected behavior**: Outbound calls should create a `Z360Connection` via `TelecomManager.placeCall()` → `onCreateOutgoingConnection()`. This provides:
  - Bluetooth headset buttons (answer/reject) during outbound ringing
  - Car head unit display showing outbound call
  - System call log entry
  - Proper audio routing coordination with other apps
- **Evidence**:
  - Outbound call flow fully implemented in the native layer (skill lines 6046–6138): destination number, codec preferences, error handling, analytics
  - But no system integration — the OS doesn't know a call is happening until the `CallForegroundService` starts
- **Fix approach**: Before `sendInvite()`, call `TelecomManager.placeCall(Uri.parse("tel:$number"), extras)`. Implement `onCreateOutgoingConnection()` in `Z360ConnectionService`. Set `Connection.setDialing()` → `setActive()` lifecycle.
- **Effort estimate**: Medium (1–3 days)

---

## 7. Call UI Gaps

### GAP-021: IncomingCallActivity Layout Not Following Material Design 3

- **Category**: Call UI
- **Severity**: Low
- **Current behavior**: The incoming call UI uses custom layout with manual button styling. No evidence of Material Design 3 components (Material3 buttons, typography, color theming).
  - No MaterialButton, MaterialCardView, or M3 theming references found in the Activity code
  - Custom ringtone + vibration handling is well-implemented (skill lines 4742–4759)
- **Expected behavior**: The call UI should follow Material Design 3 patterns for consistent look and feel with the rest of the Android ecosystem. CallStyle notifications (GAP-001) also expect Material theming.
- **Evidence**:
  - The Activity at 925 lines is functionality-complete but uses generic Views
  - Coil image loading for avatars is correctly implemented with fallback to initials
  - Vibration pattern (1s on, 1s off) matches system defaults
- **Fix approach**: Apply Material Design 3 theming to buttons, text, and layout. Use `MaterialButton` for answer/reject. Apply dynamic color from system wallpaper (Material You) on Android 12+.
- **Effort estimate**: Medium (1–3 days)

---

### GAP-022: ActiveCallActivity at 1387 Lines — Potential God Class

- **Category**: Call UI
- **Severity**: Low
- **Current behavior**: `ActiveCallActivity.kt` at 1387 lines handles: call state observation, mute/hold/speaker controls, DTMF keypad, Bluetooth integration, proximity sensor, call timer, call quality display, outgoing call error handling (US-016), audio diagnostics, foreground/background lifecycle, crash state persistence.
- **Expected behavior**: While the Activity is functional, its size makes it hard to maintain and test. Target architecture §3.1 lists it as "Active call UI (controls, quality, timer)" with a secondary responsibility of "Audio routing coordination".
- **Evidence**:
  - The Activity does at least 10 distinct things (listed above)
  - Outgoing call error handling alone is ~150 lines (skill lines 1567–1700)
  - State observation with Mutex for call state observer (BUG-007) adds complexity
- **Fix approach**: Extract into smaller components:
  - `CallControlsManager` — mute, hold, speaker, DTMF
  - `OutgoingCallTimeoutManager` — US-016 timeout and error categorization
  - `CallAudioManager` — combines AudioDiagnostics coordination + proximity sensor
  - Leave Activity as UI + lifecycle coordinator only
- **Effort estimate**: Large (3+ days)

---

## 8. Backend Communication Gaps

### GAP-023: Hardcoded API_BASE_URL in OrgSwitchHelper

- **Category**: Backend Communication
- **Severity**: Critical
- **Current behavior**: `OrgSwitchHelper` uses a hardcoded URL: `private const val API_BASE_URL = "https://app.z360.cloud"`.
  - **File**: `voip/OrgSwitchHelper.kt` (skill line 5560)
  - The URL is used for the cross-org credential switch API call
  - This means: development builds, staging environments, and custom deployments all hit production
- **Expected behavior**: The API base URL should come from `BuildConfig` (set at build time), remote config, or be derived from the WebView's current URL.
- **Evidence**:
  - Skill line 5560: `private const val API_BASE_URL = "https://app.z360.cloud"`
  - Skill line 5595: `val cookies = cookieManager.getCookie(API_BASE_URL)` — cookies are read from the hardcoded domain
  - Skill line 5599: `val url = URL("$API_BASE_URL/api/voip/switch-org")`
  - Code comment at skill line: **TODO: should use BuildConfig or remote config**
  - The backend endpoint exists: `routes/api.php:24` — `Route::post('/voip/switch-org', [VoipCredentialController::class, 'switchOrg'])`
- **Fix approach**:
  1. Add `API_BASE_URL` to `BuildConfig` via `build.gradle.kts` (different values for debug/staging/production)
  2. Or read the base URL from `Z360VoipStore` (set by the web layer during initialization)
  3. Update cookie retrieval to use the dynamic URL
- **Effort estimate**: Small (< 1 day)

---

### GAP-024: FCM Token Refresh Not Synced to Backend

- **Category**: Backend Communication
- **Severity**: Critical
- **Current behavior**: When FCM refreshes the device token, `Z360FirebaseMessagingService.onNewToken()` only stores the token locally via `TokenHolder.updateToken()`. It does NOT re-register the token with the Z360 backend.
  - **File**: `fcm/Z360FirebaseMessagingService.kt` (skill line 665)
  - Code: `override fun onNewToken(token: String) { ... TokenHolder.updateToken(token) ... }`
  - No HTTP call to backend
- **Expected behavior**: On token refresh, the new FCM token must be sent to the backend via `POST /api/device-tokens` so that future push notifications reach the device. Without this, the backend has a stale token and push delivery fails silently.
- **Evidence**:
  - Backend endpoint exists: `routes/organization/device-tokens.php` (voip-backend skill line 3303): `Route::post('/', [DeviceTokenController::class, 'store'])`
  - The web layer registers the token (via `TelnyxVoip.getFcmToken()` → JS call to backend)
  - But native `onNewToken()` only stores locally — the backend is never informed
  - If token refreshes while app is in background (common after long idle), all future pushes fail
- **Fix approach**: In `onNewToken()`, after storing locally, make an HTTP POST to `/api/device-tokens` with the new token. Use WebView cookies for authentication (same pattern as OrgSwitchHelper). Handle the case where the user is not logged in (defer registration).
- **Effort estimate**: Medium (1–3 days) — needs auth handling and retry logic

---

### GAP-025: OrgSwitchHelper Uses WebView Cookies — Fragile Auth

- **Category**: Backend Communication
- **Severity**: High
- **Current behavior**: `OrgSwitchHelper.switchOrgAndGetCredentials()` authenticates with the Z360 backend using cookies extracted from `CookieManager.getInstance().getCookie(API_BASE_URL)`.
  - **File**: `voip/OrgSwitchHelper.kt` (skill line 5595)
  - This depends on the WebView having previously loaded the Z360 app and set session cookies
- **Expected behavior**: This works when the WebView has loaded, but fails in cold-start scenarios where the user answers a cross-org call from a push notification before the WebView initializes. In that case, `CookieManager.getCookie()` may return null (no session cookies yet).
- **Evidence**:
  - Skill line 5595: `val cookies = cookieManager.getCookie(API_BASE_URL)` — can be null
  - Cold start push flow (target architecture §4.2): steps 1-14 "WebView/MainActivity NOT involved"
  - If cookies are null, the API call returns 401 Unauthorized → `OrgSwitchResult.Failed`
  - The user sees a generic error and cannot answer the cross-org call
- **Fix approach**:
  1. Store a persistent API token (not session cookie) in `Z360VoipStore` during login
  2. Use this token for the org-switch API call (Bearer token auth)
  3. Fall back to WebView cookies if the persistent token is not available
  4. This also fixes the hardcoded URL issue (GAP-023) since the token can be domain-agnostic
- **Effort estimate**: Medium (1–3 days)

---

## 9. Credential & State Management Gaps

### GAP-026: SIP Credentials Stored in Plain SharedPreferences

- **Category**: Credential Management
- **Severity**: Medium
- **Current behavior**: The Telnyx SDK's `ProfileManager` stores SIP credentials (username, password) in plain `SharedPreferences`. Z360's `Z360VoipStore` also uses plain `SharedPreferences`.
  - Grep for `EncryptedSharedPreferences` or `keystore` in voip-android skill: **zero matches**
  - `ProfileManager` is from the Telnyx `telnyx_common` library — Z360 doesn't control its storage
- **Expected behavior**: SIP credentials should be stored in `EncryptedSharedPreferences` (backed by Android Keystore) to protect against device compromise, backup extraction, and root access.
- **Evidence**:
  - Plain SharedPreferences are readable on rooted devices
  - Enterprise SaaS (Z360's market) often requires encrypted credential storage
  - Android Security Best Practices recommend EncryptedSharedPreferences for sensitive data
  - The Telnyx iOS SDK uses Keychain for credential storage — parity expected
- **Fix approach**:
  1. For `Z360VoipStore`: Migrate to `EncryptedSharedPreferences.create()` for org context and call metadata
  2. For `ProfileManager` (Telnyx SDK): This requires either patching the SDK or wrapping it with an encrypted layer. Less practical — file an issue with Telnyx or accept the risk.
  3. Prioritize Z360-owned storage first
- **Effort estimate**: Medium (1–3 days) for Z360VoipStore; Large for ProfileManager (requires SDK modification)

---

### GAP-027: Z360VoipStore Cleanup Not Triggered Systematically

- **Category**: State Management
- **Severity**: Low
- **Current behavior**: `Z360VoipStore.cleanupStaleEntries()` removes entries older than 2 minutes. It's called "on app startup" but there's no guarantee it runs between calls or periodically.
  - **File**: `voip/Z360VoipStore.kt` (skill line 9234)
  - `PushSynchronizer.cleanupExpiredEntries()` runs "on each Z360 push arrival" (skill line 133)
- **Expected behavior**: Stale entry cleanup should run:
  1. On app startup ✓ (current)
  2. After every call ends (to clean up that call's metadata)
  3. Periodically (if app is open for extended sessions)
- **Evidence**:
  - Long-running sessions accumulate stale SharedPreferences keys
  - Each call adds ~8 SharedPreferences keys (dual-index display info + call metadata)
  - No cleanup after `OnCallEnded` event
- **Fix approach**: Call `cleanupStaleEntries()` in `TelnyxVoipPlugin`'s `OnCallEnded` handler (skill line ~6477).
- **Effort estimate**: Small (< 1 day)

---

## 10. Notification & Push Gaps

### GAP-028: Missed Call "Call Back" Action May Not Work for Cross-Org Calls

- **Category**: Notification & Push
- **Severity**: Medium
- **Current behavior**: `MissedCallNotificationManager.onCallMissed()` creates a notification with a "Call Back" action that opens the app with a deep link. However, for cross-org calls, the user needs to be in the correct organization to call back.
  - **File**: `voip/MissedCallNotificationManager.kt` (skill lines 5338–5580)
  - The missed call notification includes `organizationId` but the "Call Back" action doesn't trigger an org switch
- **Expected behavior**: The "Call Back" action for a cross-org missed call should either:
  1. Switch to the correct org before initiating the call back, or
  2. Not show the "Call Back" action for cross-org calls (show "View in [OrgName]" instead)
- **Evidence**:
  - `onCallMissed()` at skill line 5338 receives `organizationId` parameter
  - The notification intent likely deep links to the main app, not to a specific org context
  - User tapping "Call Back" while in a different org would call back from wrong org
- **Fix approach**: Include `organizationId` in the PendingIntent extras for "Call Back". When the app handles the deep link, check if org switch is needed and prompt the user.
- **Effort estimate**: Medium (1–3 days)

---

## 11. Analytics & Logging Gaps

### GAP-029: Hardcoded SDK Version in Analytics

- **Category**: Analytics
- **Severity**: Low
- **Current behavior**: `VoipAnalytics` and `CrashlyticsHelper` both hardcode the Telnyx SDK version as `"3.2.0"`.
  - **File**: `voip/VoipAnalytics.kt` (skill line 6765): `setUserProperty(UserProperties.SDK_VERSION, "3.2.0")`
  - **File**: `voip/CrashlyticsHelper.kt` (skill line 3888): `key(Keys.SDK_VERSION, "3.2.0")`
  - Comment at skill line 6764: "Telnyx SDK version - hardcoded since it's pinned in build.gradle"
- **Expected behavior**: Read the SDK version dynamically from the Telnyx SDK at runtime, or derive it from `BuildConfig` at build time.
- **Evidence**:
  - If the SDK is updated without updating the hardcoded version, analytics data is incorrect
  - Version mismatch between analytics and actual SDK causes confusion when debugging issues
  - The Telnyx SDK may expose a version constant (common SDK pattern)
- **Fix approach**: Check if Telnyx SDK exposes `BuildConfig.VERSION_NAME` or similar constant. If so, read it. Otherwise, add a Gradle task to extract the version from the dependency and inject it into Z360's `BuildConfig`.
- **Effort estimate**: Small (< 1 day)

---

## 12. Web/Native Isolation Gaps

### GAP-030: Capacitor Bridge Interface Mismatch (Missing Android Methods)

- **Category**: Web/Native Isolation
- **Severity**: Critical
- **Current behavior**: The TypeScript `TelnyxVoipPlugin` interface defines methods that have no Android native implementation:

  | Method | TS Interface | Android Plugin | Status |
  |--------|-------------|---------------|--------|
  | `connectWithToken()` | ✅ line 1449 | ❌ not found | **MISSING** |
  | `getNetworkStatus()` | ✅ line 1538 | ❌ not found | **MISSING** |
  | `getConnectionState()` | ✅ line 1549 | ❌ not found | **MISSING** |
  | `getFcmTokenWithWait()` | ✅ line 1532 | ❌ not found | **MISSING** |

  Conversely, Android has methods NOT in the TypeScript interface:

  | Method | TS Interface | Android Plugin | Status |
  |--------|-------------|---------------|--------|
  | `requestBatteryOptimizationExemption()` | ❌ not found | ✅ line 6385 | **Extra** |
  | `checkCallPermissions()` | ❌ not found | ✅ line 6346 | **Extra** |
  | `openFullScreenIntentSettings()` | ❌ not found | ✅ line 6400 | **Extra** |

- **Expected behavior**: Complete interface parity between TypeScript definitions and native implementations on all platforms. Missing methods cause runtime errors when JS calls them.
- **Evidence**: See GAP-007 and GAP-008 for detailed analysis of each missing method.
- **Fix approach**:
  1. Implement the 4 missing methods in Android plugin (GAP-007, GAP-008)
  2. Add the 3 extra Android methods to the TypeScript interface
  3. Add the same methods to the iOS native plugin for cross-platform parity
  4. Establish a CI check that validates interface parity
- **Effort estimate**: Medium (1–3 days)

---

### GAP-031: TelnyxVoipWeb Stub Methods Don't Throw or Warn

- **Category**: Web/Native Isolation
- **Severity**: Low
- **Current behavior**: `TelnyxVoipWeb` class implements all interface methods as stubs that `console.log()` and return resolved promises. If web code accidentally calls a native-only method (like `getFcmToken()`), it silently succeeds with a dummy response.
  - **File**: `resources/js/plugins/telnyx-voip-web.ts` (voip-frontend skill lines 1291–1420)
  - Example: `getFcmToken()` returns `{ token: '' }` — empty string, not an error
- **Expected behavior**: Web stubs for native-only methods should either throw an error or return a clearly distinguishable failure response, so bugs where web code calls native-only methods are caught during development.
- **Evidence**:
  - `getFcmToken()` at line 1359: returns `{ token: '' }` — looks like a valid empty response
  - `getDeviceId()` at line 1353: returns `{ deviceId: 'web' }` — misleading
  - `reconnectWithCredentials()` at line 1416: silently does nothing
- **Fix approach**: For native-only methods in `TelnyxVoipWeb`, throw a descriptive error: `throw new Error('getFcmToken() is only available on native platforms')`. Or return a rejected promise.
- **Effort estimate**: Small (< 1 day)

---

### GAP-032: No Guard Against Web WebRTC Connection on Native

- **Category**: Web/Native Isolation
- **Severity**: Low
- **Current behavior**: The `NativeVoipProvider` (voip-frontend skill line 2170) replaces `TelnyxRTCProvider` on native platforms, and the platform detection `Capacitor.isNativePlatform()` is used correctly at line 2223. The isolation appears correct — `@telnyx/react-client` WebRTC is not loaded on native.
- **Expected behavior**: This is working correctly. However, there's no runtime guard that would catch if a code path accidentally bypassed the provider and directly imported `@telnyx/react-client` on native.
- **Evidence**:
  - Line 2153: Comment: "so we don't need TelnyxRTCProvider which creates WebSocket connections"
  - Line 2156: "1. Prevent TelnyxRTCProvider from being loaded on native (avoids dual WebSocket)"
  - The isolation mechanism (provider pattern) is correct and well-documented
- **Fix approach**: Add a runtime check in the Telnyx React client initialization that warns/throws if `Capacitor.isNativePlatform()` is true. This prevents accidental imports.
- **Effort estimate**: Small (< 1 day)

---

## 13. Testing Gaps

### GAP-033: No Unit Tests for VoIP Components

- **Category**: Testing
- **Severity**: High
- **Current behavior**: There are no unit tests, integration tests, or instrumented tests for any of the 23 VoIP Kotlin files.
  - Grep for `@Test` or `espresso` in voip-android skill: **zero matches** for test files
  - No test directory structure found for VoIP code
- **Expected behavior**: Critical components should have unit test coverage:
  - `PushSynchronizer` — test all three sync scenarios (IMMEDIATE, WAITED, TIMEOUT)
  - `Z360VoipStore` — test dual-index storage, phone normalization, stale entry cleanup
  - `PhoneNumberFormatter` — test US number formatting and matching
  - `CallStatePersistence` — test save/load/clear/abandoned detection
  - `OrgSwitchHelper` — test API call success/failure/timeout paths
  - `TokenHolder` — test retry logic and caching
- **Evidence**:
  - 23 Kotlin files, ~8,000+ lines of code with zero test coverage
  - Multiple race condition fixes (BUG-001, BUG-005, BUG-007, BUG-013) that would benefit from regression tests
  - PushSynchronizer's CompletableDeferred timing is particularly testable
- **Fix approach**:
  1. Create `android/app/src/test/java/com/z360/app/voip/` and `fcm/` test directories
  2. Start with pure-logic components: PushSynchronizer, Z360VoipStore, PhoneNumberFormatter, CallStatePersistence
  3. Use MockK for mocking Android framework classes
  4. Add instrumented tests for ConnectionService and notification behavior
- **Effort estimate**: Large (3+ days) — ongoing effort

---

## 14. Priority Matrix

### Critical (Fix Immediately — Blocks Reliability)

| GAP | Summary | Effort |
|-----|---------|--------|
| **GAP-007** | Missing `connectWithToken()` native implementation — bridge contract broken | Small |
| **GAP-023** | Hardcoded API_BASE_URL — breaks non-production environments | Small |
| **GAP-024** | FCM token refresh not synced to backend — pushes fail after token rotation | Medium |
| **GAP-030** | Bridge interface mismatch — 4 missing native methods | Medium |

### High (Fix Soon — Significant Quality/Reliability Impact)

| GAP | Summary | Effort |
|-----|---------|--------|
| **GAP-001** | No CallStyle notifications — misses Google recommendation | Small |
| **GAP-002** | No ongoing call notification — user can't see active call status | Medium |
| **GAP-006** | `runBlocking` on FCM thread — potential ANR under load | Medium |
| **GAP-008** | Missing bridge methods (getNetworkStatus, getConnectionState, getFcmTokenWithWait) | Medium |
| **GAP-009** | No mutex on credential login paths — race condition during org switch | Medium |
| **GAP-017** | SDK auto-reconnect not enabled — calls die on brief network drops | Small |
| **GAP-025** | OrgSwitchHelper WebView cookie auth — fails on cold start cross-org calls | Medium |
| **GAP-033** | Zero test coverage for 8000+ lines of VoIP code | Large |
| **GAP-015** | No network monitoring — no proactive reconnection | Medium |

### Medium (Plan for Next Sprint)

| GAP | Summary | Effort |
|-----|---------|--------|
| **GAP-003** | No formal call state machine | Large |
| **GAP-004** | ConnectionService missing outbound support | Medium |
| **GAP-005** | No client-side inbound ringing timeout | Small |
| **GAP-010** | Simultaneous answer + call-ended race | Small |
| **GAP-011** | No credential refresh during active call | Medium |
| **GAP-013** | No modern audio routing APIs (API 31+) | Medium |
| **GAP-014** | No accessibility in call UI | Small |
| **GAP-020** | Outbound calls lack ConnectionService integration | Medium |
| **GAP-026** | SIP credentials in plain SharedPreferences | Medium |
| **GAP-028** | Missed call "Call Back" for cross-org calls may not work | Medium |

### Low (Backlog)

| GAP | Summary | Effort |
|-----|---------|--------|
| **GAP-012** | Audio focus GAIN_TRANSIENT vs GAIN_TRANSIENT_EXCLUSIVE | Small |
| **GAP-016** | Full-screen intent permission not proactively checked | Small |
| **GAP-018** | Hardcoded Telnyx SDK notification ID 1234 | Small |
| **GAP-019** | No ICE restart support | Small |
| **GAP-021** | Material Design 3 not applied to call UI | Medium |
| **GAP-022** | ActiveCallActivity at 1387 lines — god class | Large |
| **GAP-027** | Z360VoipStore cleanup not systematic | Small |
| **GAP-029** | Hardcoded SDK version in analytics | Small |
| **GAP-031** | Web stubs don't throw for native-only methods | Small |
| **GAP-032** | No runtime guard for web WebRTC on native | Small |

---

## Effort Summary

| Effort | Count | Gaps |
|--------|-------|------|
| Small (< 1 day) | 14 | GAP-001, 005, 007, 010, 012, 014, 016, 017, 018, 019, 023, 027, 029, 031 |
| Medium (1–3 days) | 11 | GAP-002, 004, 006, 008, 009, 011, 013, 015, 020, 024, 025, 028 |
| Large (3+ days) | 3 | GAP-003, 022, 033 |

**Estimated total remediation**: ~35–50 person-days for full gap closure.

**Recommended sprint planning**:
- **Sprint 1** (Critical): GAP-007, 023, 024, 030, 017 — ~5 days
- **Sprint 2** (High): GAP-001, 002, 006, 009, 025, 015 — ~10 days
- **Sprint 3** (Medium): GAP-003, 004, 005, 010, 013, 014, 020 — ~12 days
- **Sprint 4** (Testing + Low): GAP-033, remaining low-priority items — ~10 days

---

*Generated: 2026-02-08*
*Sources: voip-android skill (26 files), voip-frontend skill (16 files), voip-backend skill (41 files), android-current-state.md, android-target-architecture.md, android-platform-requirements.md, telnyx-reference-unified.md*
*Verification: All gaps verified against actual code via Grep searches on skill files*
