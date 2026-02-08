---
title: Android Current State
---

# Android VoIP Current State — Component Documentation

> Generated from Z360 Android source code analysis.
> All file paths relative to `android/app/src/main/java/com/z360/app/`.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Capacitor Bridge — TelnyxVoipPlugin](#2-capacitor-bridge--telnyxvoipplugin)
3. [Push Notification Layer](#3-push-notification-layer)
4. [Push Synchronization — PushSynchronizer](#4-push-synchronization--pushsynchronizer)
5. [Android Telecom Framework](#5-android-telecom-framework)
6. [Call UI — IncomingCallActivity](#6-call-ui--incomingcallactivity)
7. [Call UI — ActiveCallActivity](#7-call-ui--activecallactivity)
8. [Persistent State — Z360VoipStore](#8-persistent-state--z360voipstore)
9. [Cross-Organization Calls — OrgSwitchHelper](#9-cross-organization-calls--orgswitchhelper)
10. [Shared ViewModel — TelnyxViewModelProvider](#10-shared-viewmodel--telnyxviewmodelprovider)
11. [Audio Management](#11-audio-management)
12. [Call Timer — CallTimerManager](#12-call-timer--calltimermanager)
13. [Crash Recovery](#13-crash-recovery)
14. [Missed Call Notifications](#14-missed-call-notifications)
15. [Observability Stack](#15-observability-stack)
16. [Utility Components](#16-utility-components)
17. [Inter-Component Communication Map](#17-inter-component-communication-map)
18. [Telnyx SDK Divergences](#18-telnyx-sdk-divergences)
19. [Known Issues and TODOs](#19-known-issues-and-todos)
20. [Manifest Declarations](#20-manifest-declarations)

---

## 1. Architecture Overview

Z360 Android VoIP uses a **Capacitor 8 hybrid architecture** where the WebView SPA handles business logic and the native layer handles VoIP independently. The VoIP layer does **not** go through WebView — it runs entirely in native Kotlin code.

### Key architectural decisions:
- **Server-mediated push**: Z360 backend sends FCM pushes directly (not Telnyx's native push binding)
- **Two-push correlation**: Z360 push (caller display info) + Telnyx push (call control metadata), correlated by normalized phone number
- **Self-managed ConnectionService**: Z360 manages its own call UI via Android Telecom framework
- **Single shared ViewModel**: `TelnyxViewModel` shared across Activities and Capacitor plugin via custom `ViewModelStore`
- **Single call support**: Auto-rejects incoming calls when user is already on a call (US-018)

### Component count: 23 Kotlin files across two packages
- `voip/` — 19 files (plugin, activities, services, managers, utilities)
- `fcm/` — 4 files (Firebase messaging, push sync, token management)

---

## 2. Capacitor Bridge — TelnyxVoipPlugin

**File**: `voip/TelnyxVoipPlugin.kt` (789 lines)
**Purpose**: Capacitor plugin bridging WebView JavaScript to native VoIP layer. Entry point for all JS-initiated VoIP operations.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `connect` | `@PluginMethod fun connect(call: PluginCall)` | Login to Telnyx SDK with SIP credentials (`sipUsername`, `sipPassword`, `callerIdName`, `callerIdNumber`). BUG-003: Skips if SDK already connected. BUG-006: Waits up to 8s for `ClientLoggedIn` state. |
| `disconnect` | `@PluginMethod fun disconnect(call: PluginCall)` | Logout from Telnyx SDK. |
| `answerCall` | `@PluginMethod fun answerCall(call: PluginCall)` | Answer incoming call by UUID via `telnyxViewModel.answerCall()`. |
| `rejectCall` | `@PluginMethod fun rejectCall(call: PluginCall)` | Reject incoming call by UUID. |
| `hangup` | `@PluginMethod fun hangup(call: PluginCall)` | End active call via `telnyxViewModel.endCall()`. |
| `makeCall` | `@PluginMethod fun makeCall(call: PluginCall)` | Initiate outgoing call with destination number, callerIdName, callerIdNumber, preferredCodecs (opus, PCMU, PCMA). |
| `setMute` | `@PluginMethod fun setMute(call: PluginCall)` | Toggle microphone mute. BUG-012: Auto-mutes during hold. |
| `setSpeaker` | `@PluginMethod fun setSpeaker(call: PluginCall)` | Toggle speakerphone via AudioManager. |
| `setHold` | `@PluginMethod fun setHold(call: PluginCall)` | Toggle call hold. |
| `sendDTMF` | `@PluginMethod fun sendDTMF(call: PluginCall)` | Send DTMF tones (0-9, *, #). |
| `getDeviceId` | `@PluginMethod fun getDeviceId(call: PluginCall)` | Return Android device ID. |
| `getFcmToken` | `@PluginMethod fun getFcmToken(call: PluginCall)` | Get FCM token via `TokenHolder` with retry logic. |
| `isConnected` | `@PluginMethod fun isConnected(call: PluginCall)` | Check Telnyx SDK connection status. |
| `requestVoipPermissions` | `@PluginMethod fun requestVoipPermissions(call: PluginCall)` | Request RECORD_AUDIO, POST_NOTIFICATIONS, READ_PHONE_STATE. |
| `reconnectWithCredentials` | `@PluginMethod fun reconnectWithCredentials(call: PluginCall)` | Reconnect SDK with new SIP credentials (cross-org switch). |
| `setCurrentOrganization` | `@PluginMethod fun setCurrentOrganization(call: PluginCall)` | Persist org context in Z360VoipStore. |
| `setCallDisplayInfo` | `@PluginMethod fun setCallDisplayInfo(call: PluginCall)` | Pre-store caller display info for upcoming call. |
| `checkCallPermissions` | `@PluginMethod fun checkCallPermissions(call: PluginCall)` | Check permission status without requesting. |
| `requestBatteryOptimizationExemption` | `@PluginMethod fun requestBatteryOptimizationExemption(call: PluginCall)` | Request exemption from Doze/battery optimization. |
| `openFullScreenIntentSettings` | `@PluginMethod fun openFullScreenIntentSettings(call: PluginCall)` | Open Android 14+ full-screen intent permission settings. |

### Telnyx SDK Observation

`startObservingTelnyx()` sets up three coroutine collectors:

1. **`uiState` (TelnyxSocketEvent flow)**:
   - `OnClientReady` → notify JS `onConnected`
   - `OnIncomingCall` → store as `PendingIncomingCall` with `AtomicReference`, notify JS `onIncomingCall` (BUG-001)
   - `OnCallAnswered` → notify JS `onCallAnswered`
   - `OnCallEnded` → cleanup, notify JS `onCallEnded`
   - `OnCallDropped` → cleanup, notify JS `onCallDropped`
   - `OnRinging` → log outgoing call timing (US-015)

2. **`callQualityMetrics` flow** → notify JS `onCallQualityMetrics` with MOS/jitter/RTT

3. **`connectionStatus` flow** → notify JS `onConnectionStatusChanged`

### Data Handled
- SIP credentials (username, password, callerIdName, callerIdNumber)
- Call UUIDs, destination numbers, DTMF digits
- FCM tokens, device IDs
- Organization context (id, name)
- Caller display info (name, number, avatarUrl)

### Critical Note
> Line 667: "Do NOT launch IncomingCallActivity here — ConnectionService owns UI launch for incoming calls"

The plugin observes `OnIncomingCall` but does NOT launch the incoming call UI. That responsibility belongs to `Z360ConnectionService.onCreateIncomingConnection()` → `Z360Connection.onShowIncomingCallUi()`.

---

## 3. Push Notification Layer

### Z360FirebaseMessagingService

**File**: `fcm/Z360FirebaseMessagingService.kt` (614 lines)
**Purpose**: Central FCM push handler. Receives and routes two distinct push types. Entry point for background/killed-state call delivery.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `onMessageReceived` | `override fun onMessageReceived(remoteMessage: RemoteMessage)` | Routes to Z360 or Telnyx handler based on payload keys. |
| `onNewToken` | `override fun onNewToken(token: String)` | Stores new FCM token in `TokenHolder`. |
| `handleZ360CallerInfoPush` | `private fun handleZ360CallerInfoPush(data: Map<String, String>)` | Stores display info in `Z360VoipStore`, notifies `PushSynchronizer`, broadcasts update intent. |
| `handleTelnyxMetadataPush` | `private fun handleTelnyxMetadataPush(data: Map<String, String>)` | Synchronizes with Z360 push via `PushSynchronizer` (500ms timeout), enhances metadata, shows incoming call UI. |
| `ensureTelnyxSdkConnected` | `private suspend fun ensureTelnyxSdkConnected(txPushMetaData: String): Boolean` | Reconnects SDK from stored profile with txPushMetaData, 5s connection timeout. (BUG-003, BUG-004) |
| `showIncomingCallNotification` | `private fun showIncomingCallNotification(callerName, callerNumber, avatarUrl, callSessionId, pushMetadataJson, organizationId, organizationName)` | Tries ConnectionService first (Android 14+ lock screen), falls back to Telnyx SDK notification. |

### Push Type Discrimination

```
Z360 push payload keys: "type" == "incoming_call", "caller_name", "caller_number", "avatar_url", "organization_id"
Telnyx push payload keys: "voice_sdk_id", "message", contains "telnyx_" prefix
call_ended push: "type" == "call_ended"
```

### Guards and Protections
- **US-014**: Rejects pushes when user is logged out (no valid SIP credentials in ProfileManager)
- **US-018**: Single call support — auto-rejects incoming when `TelnyxViewModel` reports active call, shows missed call notification via `MissedCallNotificationManager.onCallMissedBusy()`
- **Re-INVITE guard**: Checks `Z360VoipStore.wasRecentlyEnded()` (15s cooldown) to prevent ghost calls after hangup
- **Notification suppression**: Cancels Telnyx SDK's internal notification (hardcoded ID 1234) which races Z360's own UI
- **US-013**: Cold start detection via service creation timestamp comparison

### call_ended Push Handling
When a `call_ended` push arrives (simultaneous ring dismissal):
1. Marks caller number as recently ended in `Z360VoipStore`
2. Sends local broadcast `ACTION_CALL_ENDED` for `IncomingCallActivity` to dismiss
3. Cancels foreground service notification
4. Cancels incoming call notification

### TokenHolder

**File**: `fcm/TokenHolder.kt` (267 lines)
**Purpose**: Singleton managing FCM token lifecycle with retry logic.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `getToken` | `suspend fun getToken(): String?` | Get FCM token with 3 retries, exponential backoff (1s, 2s, 4s). Checks Firebase initialization first. |
| `getCachedToken` | `fun getCachedToken(): String?` | Return last known token from SharedPreferences. |
| `updateToken` | `fun updateToken(token: String)` | Persist new token to SharedPreferences. |

---

## 4. Push Synchronization — PushSynchronizer

**File**: `fcm/PushSynchronizer.kt` (299 lines)
**Purpose**: Singleton object coordinating Z360 and Telnyx push arrival timing. Solves the problem of two independent push channels needing to be correlated for a single incoming call.

### Architecture

```
Z360 Push (caller info) ──┐
                          ├──▶ PushSynchronizer ──▶ Enhanced call data
Telnyx Push (call ctrl) ──┘
```

**Correlation key**: Normalized phone number (last 10 digits, strips country code and formatting).

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `onZ360PushReceived` | `suspend fun onZ360PushReceived(callerNumber: String, callerName: String?, avatarUrl: String?, organizationId: String?, organizationName: String?)` | If Telnyx entry waiting: completes its deferred immediately. Otherwise stores with pre-completed deferred. |
| `onTelnyxPushReceived` | `suspend fun onTelnyxPushReceived(callerNumber: String?, callId: String?): SyncResult` | Checks Z360VoipStore first (immediate). If not found, creates CompletableDeferred and waits up to 500ms. |
| `normalizePhone` | `private fun normalizePhone(phone: String): String` | Strips non-digits, takes last 10. |

### Data Structures

```kotlin
data class SyncEntry(
    val callerName: String?,
    val avatarUrl: String?,
    val organizationId: String?,
    val organizationName: String?,
    val deferred: CompletableDeferred<Unit>,
    val timestamp: Long
)

data class SyncResult(
    val callerName: String?,
    val avatarUrl: String?,
    val organizationId: String?,
    val organizationName: String?,
    val syncType: SyncType  // IMMEDIATE, WAITED, TIMEOUT, NO_PHONE
)
```

- **Storage**: `ConcurrentHashMap<String, SyncEntry>` keyed by normalized phone
- **Entry expiry**: 30 seconds, cleaned on each Z360 push arrival
- **Concurrency**: `Mutex` for coordinating entry creation/update (BUG-013: CompletableDeferred replaces polling-with-backoff)

---

## 5. Android Telecom Framework

### Z360ConnectionService

**File**: `voip/Z360ConnectionService.kt` (162 lines)
**Purpose**: Self-managed ConnectionService for Android Telecom framework integration. Provides lock screen call UI, Bluetooth/car integration, and OS audio routing on Android 8.0+.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerPhoneAccount` | `static fun registerPhoneAccount(context: Context)` | Registers "Z360 Calls" PhoneAccount with `CAPABILITY_SELF_MANAGED`, SIP+TEL URI schemes. |
| `addIncomingCall` | `static fun addIncomingCall(context: Context, extras: Bundle): Boolean` | Adds incoming call via TelecomManager. Returns false on failure (triggers fallback to direct notification). |
| `getPhoneAccountHandle` | `static fun getPhoneAccountHandle(context: Context): PhoneAccountHandle` | Returns PhoneAccountHandle for Z360 (`z360_voip`). |
| `onCreateIncomingConnection` | `override fun onCreateIncomingConnection(...)` | Creates `Z360Connection` with `PROPERTY_SELF_MANAGED`, sets ringing, stores in `Z360Connection.activeConnection`. |
| `onCreateIncomingConnectionFailed` | `override fun onCreateIncomingConnectionFailed(...)` | Fallback: launches `IncomingCallActivity` directly without Telecom framework. |

### Extras Constants
```kotlin
EXTRA_CALLER_NAME, EXTRA_CALLER_NUMBER, EXTRA_CALLER_AVATAR_URL,
EXTRA_CALL_SESSION_ID, EXTRA_PUSH_METADATA_JSON,
EXTRA_ORGANIZATION_ID, EXTRA_ORGANIZATION_NAME,
EXTRA_CHANNEL_NUMBER, EXTRA_AVATAR_URL
```

### Z360Connection

**File**: `voip/Z360Connection.kt` (212 lines)
**Purpose**: Represents a single VoIP call within Android Telecom framework. Self-managed connection that handles its own UI.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `onShowIncomingCallUi` | `override fun onShowIncomingCallUi()` | Posts high-priority notification with `fullScreenIntent` AND directly launches `IncomingCallActivity`. Notification channel: `z360_incoming_call`, ID 9999. |
| `onAnswer` | `override fun onAnswer()` | Called by Telecom framework. Sets connection to ACTIVE. |
| `onReject` | `override fun onReject()` | Sets DISCONNECTED(REJECTED), destroys connection, cancels notification. |
| `onDisconnect` | `override fun onDisconnect()` | Sets DISCONNECTED(LOCAL), destroys connection, cancels notification. |
| `notifyAnswered` | `static fun notifyAnswered()` | Called from IncomingCallActivity when user answers. Sets connection to ACTIVE. |
| `notifyRejected` | `static fun notifyRejected()` | Called from IncomingCallActivity when user rejects. Sets DISCONNECTED(REJECTED), destroys. |
| `notifyDisconnected` | `static fun notifyDisconnected(cause: Int)` | Called when call ends. Sets DISCONNECTED with given cause, destroys. |

**State tracking**: `AtomicReference<Z360Connection?>` singleton — only one active connection at a time.

---

## 6. Call UI — IncomingCallActivity

**File**: `voip/IncomingCallActivity.kt` (925 lines)
**Purpose**: Full-screen incoming call UI with accept/reject buttons. Shows on lock screen via `setShowWhenLocked(true)` and `setTurnScreenOn(true)`.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `start` | `static fun start(context, callerName, callerNumber, callerAvatarUrl, callSessionId, isOutgoing, pushMetadataJson, organizationId, organizationName)` | Static launcher with `FLAG_ACTIVITY_NEW_TASK`. |
| `answerDirectly` | `private fun answerDirectly()` | Stops ringtone, 250ms audio settle, checks SDK connection, answers via currentCall UUID or plugin pending call or waits up to 5s for SDK INVITE, falls back to `answerIncomingPushCall()`. |
| `answerCrossOrgCall` | `private fun answerCrossOrgCall()` | Shows loading, calls `OrgSwitchHelper.switchOrgAndGetCredentials()`, updates `ProfileManager`, then `answerDirectly()`. |
| `onDeclineCall` | `private fun onDeclineCall()` | Notifies Telecom framework via `Z360Connection.notifyRejected()`. Handles cross-org decline via `BackgroundCallDeclineService`. |
| `observeCallState` | `private fun observeCallState()` | Lifecycle-aware `StateFlow` collection for `OnCallEnded`/`OnCallDropped` to auto-dismiss. |
| `startRingtone` | `private fun startRingtone()` | Default system ringtone with looping, vibration pattern (1s on, 1s off). Pre-Android P fallback via `setLooping()`. |

### Answer Flow (detailed)

```
User taps Answer
  └─▶ BUG-005: AtomicBoolean.compareAndSet prevents double-tap
      └─▶ Is cross-org call? (organizationId != currentOrgId)
          ├─ YES: answerCrossOrgCall()
          │   └─▶ OrgSwitchHelper.switchOrgAndGetCredentials()
          │       └─▶ ProfileManager.update() → answerDirectly()
          └─ NO: answerDirectly()
              └─▶ Stop ringtone → 250ms audio settle delay
                  └─▶ Has currentCall UUID?
                      ├─ YES: telnyxViewModel.answerCall(uuid)
                      ├─ NO: Has plugin pending call?
                      │   ├─ YES: telnyxViewModel.answerCall(pending.uuid)
                      │   └─ NO: Wait up to 5s for SDK INVITE
                      │       ├─ RECEIVED: answerCall(uuid)
                      │       └─ TIMEOUT: answerIncomingPushCall()
                      └─▶ Transition to ActiveCallActivity
```

### BroadcastReceivers
- **Display info updates**: Listens for `Z360VoipStore.ACTION_CALL_DISPLAY_INFO_UPDATED` to update UI when Z360 push arrives after Telnyx push
- **Call ended**: Listens for `ACTION_CALL_ENDED` broadcast for simultaneous ring dismissal

### Data Handled
- Caller name, number, avatar URL (loaded via Coil with fallback to initials)
- Call session ID, push metadata JSON
- Organization ID and name (for cross-org detection)

---

## 7. Call UI — ActiveCallActivity

**File**: `voip/ActiveCallActivity.kt` (1387 lines)
**Purpose**: In-call UI with mute/hold/speaker/keypad/end-call controls, call quality indicator, Bluetooth indicator, and DTMF keypad.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `observeCallState` | `private fun observeCallState()` | Collects `uiState`, `connectionStatus`, `callQualityMetrics` flows from TelnyxViewModel. |
| `observeCurrentCallState` | `private fun observeCurrentCallState(call: Call)` | BUG-007: Mutex-protected observer for specific call's state. Handles OnMedia, OnCallReconnecting. |
| `toggleMute` | `private fun toggleMute()` | Toggle via `telnyxViewModel.muteCall()`. |
| `toggleHold` | `private fun toggleHold()` | Toggle via `telnyxViewModel.holdCall()`. BUG-012: Auto-mute during hold. |
| `toggleSpeaker` | `private fun toggleSpeaker()` | Toggle via `AudioManager.setSpeakerphoneOn()`. |
| `sendDtmfDigit` | `private fun sendDtmfDigit(digit: String)` | Send DTMF via `currentCall.dtmfCall(digit)`. |
| `endCall` | `private fun endCall()` | Disables button, `telnyxViewModel.endCall()`, 5s timeout fallback for forced finish. |
| `ensureAudioModeForCall` | `private fun ensureAudioModeForCall()` | BUG-008: Ensures `MODE_IN_COMMUNICATION` persists across state changes. |

### Call State Handling

```kotlin
// TelnyxSocketEvent flow handling:
OnCallAnswered  → set connected, start timer, save CallStatePersistence
OnMedia         → log audio connected
OnCallEnded     → cleanup, finish activity
OnCallDropped   → cleanup, finish activity
OnCallReconnecting → show reconnecting UI
OnRinging       → set ringback state (outgoing calls)
```

### Outgoing Call Handling (US-016)
- 30-second setup timeout
- Error categorization: `network`, `auth`, `busy`, `no_answer`, `invalid_number`, `rejected`, `timeout`, `sdk_error`
- Shows error dialog with categorized message

### Hardware Integration
- **Proximity sensor**: `PROXIMITY_SCREEN_OFF_WAKE_LOCK` to turn off screen when near ear
- **Bluetooth**: `BluetoothAudioManager.onCallStarted()` / `onCallEnded()`
- **Audio diagnostics**: Logged at every state change

### App Lifecycle (US-019)
- Tracks foreground/background transitions during active call via `VoipAnalytics`
- `CallStatePersistence.saveActiveCallState()` when call connects

---

## 8. Persistent State — Z360VoipStore

**File**: `voip/Z360VoipStore.kt` (324 lines)
**Purpose**: Singleton persisting Z360-specific VoIP metadata to SharedPreferences. Intentionally separate from Telnyx SDK's `ProfileManager` to avoid mixing concerns.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `setCurrentOrganization` | `fun setCurrentOrganization(organizationId: String, organizationName: String?)` | Persist current org context. Uses `commit()` for synchronous write. |
| `getCurrentOrganizationId` | `fun getCurrentOrganizationId(): String?` | Get current org ID. |
| `saveIncomingCallMeta` | `fun saveIncomingCallMeta(callId, organizationId, organizationName, channelNumber)` | Save org context for incoming call (timestamped). |
| `getIncomingCallMeta` | `fun getIncomingCallMeta(callId: String): IncomingCallMeta?` | Retrieve org context by call ID. |
| `saveCallDisplayInfo` | `fun saveCallDisplayInfo(callId, callerName, callerNumber, avatarUrl)` | Save display info indexed by BOTH callId and normalized phone number. |
| `getCallDisplayInfoWithFallback` | `fun getCallDisplayInfoWithFallback(callId: String, callerNumber: String?): CallDisplayInfo?` | Try callId first, then phone number index. Handles mismatched IDs between Z360 and Telnyx. |
| `cleanupStaleEntries` | `fun cleanupStaleEntries()` | Remove entries older than 2 minutes. Called on app startup. |
| `markCallEnded` | `fun markCallEnded(callerNumber: String)` | Mark number as recently ended (timestamp). |
| `wasRecentlyEnded` | `fun wasRecentlyEnded(callerNumber: String, cooldownMs: Long = 15000): Boolean` | 15s cooldown guard against ghost re-INVITE. |

### Data Model

```kotlin
data class IncomingCallMeta(
    val callId: String,
    val organizationId: String?,
    val organizationName: String?,
    val channelNumber: String?
)

data class CallDisplayInfo(
    val callId: String,
    val callerName: String?,
    val callerNumber: String?,
    val avatarUrl: String?
)
```

### Dual-Index Storage
Display info is stored with two indices:
1. **By callId**: `call_display_{callId}_caller_name`, etc.
2. **By normalized phone**: `call_display_phone_{last10digits}_call_id` → points to callId

This dual-index handles the case where Telnyx SDK push and Z360 backend push have different call IDs for the same incoming call.

### Phone Number Normalization
```kotlin
fun normalizePhoneNumber(phone: String): String {
    val digitsOnly = phone.replace(Regex("[^0-9]"), "")
    return when {
        digitsOnly.length > 10 -> digitsOnly.takeLast(10)
        digitsOnly.isNotEmpty() -> digitsOnly
        else -> ""
    }
}
```

### Concurrency: All critical writes use `commit()` (synchronous) instead of `apply()` to prevent race conditions between Z360 push and Telnyx push arriving back-to-back.

---

## 9. Cross-Organization Calls — OrgSwitchHelper

**File**: `voip/OrgSwitchHelper.kt` (137 lines)
**Purpose**: Singleton for cross-org credential acquisition. When a call arrives for a different organization than the user's current active org, this helper fetches new SIP credentials.

### Key Methods

| Method | Signature | Purpose |
|--------|-----------|---------|
| `switchOrgAndGetCredentials` | `suspend fun switchOrgAndGetCredentials(context: Context, targetOrgId: String): OrgSwitchResult` | POST to `/api/voip/switch-org` with `{target_organization_id}`, authenticates via WebView cookies, returns credentials. |

### Data Model

```kotlin
data class OrgSwitchCredentials(
    val sipUsername: String,
    val sipPassword: String,
    val callerIdName: String,
    val callerIdNumber: String,
    val orgId: String,
    val orgName: String
)

sealed class OrgSwitchResult {
    data class Success(val credentials: OrgSwitchCredentials) : OrgSwitchResult()
    data class Failed(val error: String) : OrgSwitchResult()
}
```

### Implementation Details
- **Authentication**: Uses `CookieManager.getInstance().getCookie()` for WebView session cookies
- **Timeout**: 10s connect + 10s read
- **Base URL**: Hardcoded `https://app.z360.cloud` (**TODO: should use BuildConfig or remote config**)
- **Error handling**: SocketTimeout, UnknownHost, general exceptions → categorized `OrgSwitchResult.Failed`

---

## 10. Shared ViewModel — TelnyxViewModelProvider

**File**: `voip/TelnyxViewModelProvider.kt` (28 lines)
**Purpose**: Singleton providing shared `TelnyxViewModel` across Activities and Capacitor plugin.

```kotlin
object TelnyxViewModelProvider {
    private val viewModelStore = ViewModelStore()

    fun get(context: Context): TelnyxViewModel {
        val factory = TelnyxViewModelFactory(context.applicationContext as Application)
        return ViewModelProvider(viewModelStore, factory)[TelnyxViewModel::class.java]
    }
}
```

**Key design**: Uses a custom `ViewModelStore` (not activity-scoped) so the ViewModel survives activity recreation and is shared between:
- `TelnyxVoipPlugin` (Capacitor bridge)
- `IncomingCallActivity`
- `ActiveCallActivity`

This is the central SDK state holder — all call operations go through this ViewModel.

---

## 11. Audio Management

### AudioDiagnostics

**File**: `voip/AudioDiagnostics.kt` (385 lines)
**Purpose**: US-008 fix — proper AudioFocusRequest storage and abandonment. Provides diagnostic audio testing.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `requestAudioFocus` | `fun requestAudioFocus(): Boolean` | `AUDIOFOCUS_GAIN_TRANSIENT` with `USAGE_VOICE_COMMUNICATION`. Stores `AudioFocusRequest` for later abandonment. |
| `abandonAudioFocus` | `fun abandonAudioFocus()` | Uses stored `AudioFocusRequest` for proper release (pre-US-008 code lost the reference). |
| `resetAfterCall` | `fun resetAfterCall()` | Abandons focus, resets to `MODE_NORMAL`. |
| `setCallAudioMode` | `fun setCallAudioMode()` | Sets `MODE_IN_COMMUNICATION`. |
| `testMicrophoneCapture` | `fun testMicrophoneCapture(): Boolean` | Diagnostic mic test (200ms sample capture using AudioRecord). |
| `logCurrentState` | `fun logCurrentState(label: String)` | Logs audio mode, focus, speaker state, Bluetooth, volume. |

### BluetoothAudioManager

**File**: `voip/BluetoothAudioManager.kt` (422 lines)
**Purpose**: Singleton managing Bluetooth SCO (Synchronous Connection-Oriented) audio routing.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `initialize` | `fun initialize(context: Context)` | Get `BluetoothHeadset` profile proxy, register BroadcastReceiver for SCO state changes. |
| `onCallStarted` | `fun onCallStarted()` | Sets `MODE_IN_COMMUNICATION`, starts SCO if headset connected. |
| `onCallEnded` | `fun onCallEnded()` | Stops SCO, resets to `MODE_NORMAL`. |
| `isBluetoothAvailable` | `fun isBluetoothAvailable(): Boolean` | Check if Bluetooth headset is connected. |
| `isBluetoothAudioActive` | `fun isBluetoothAudioActive(): Boolean` | Check if SCO audio is active. |

- Broadcasts `ACTION_BLUETOOTH_AUDIO_STATE` for UI updates (ActiveCallActivity Bluetooth indicator)
- Permission handling for Android 12+ (`BLUETOOTH_CONNECT`)

---

## 12. Call Timer — CallTimerManager

**File**: `voip/CallTimerManager.kt` (163 lines)
**Purpose**: US-009 fix — singleton call timer that survives activity recreation (screen rotation was resetting timer).

| Method | Signature | Purpose |
|--------|-----------|---------|
| `startTimer` | `fun startTimer(callId: String)` | Synchronized, idempotent. Cancels existing timer if for a different call. Uses `CoroutineScope(Dispatchers.Default)`. |
| `stopTimer` | `fun stopTimer()` | Cancel timer coroutine, reset elapsed. |
| `elapsedSeconds` | `val elapsedSeconds: StateFlow<Long>` | Observable timer state, ticks every 1 second. |

- Logs elapsed time every 10 seconds via `VoipLogger`
- `StateFlow<Long>` allows activity to collect without worrying about lifecycle

---

## 13. Crash Recovery

### CallStatePersistence

**File**: `voip/CallStatePersistence.kt` (205 lines)
**Purpose**: Persists active call state to SharedPreferences for crash recovery detection.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `saveActiveCallState` | `fun saveActiveCallState(callId, callerNumber, callerName, startTime, callControlId, isOutgoing)` | Save call state on connection. |
| `clearActiveCallState` | `fun clearActiveCallState()` | Clear on normal call end. |
| `getActiveCallState` | `fun getActiveCallState(): PersistedCallState?` | Retrieve persisted state on restart. |
| `checkForAbandonedCall` | `fun checkForAbandonedCall(): PersistedCallState?` | Returns non-null if stale call state exists (crash detected). |

```kotlin
data class PersistedCallState(
    val callId: String,
    val callerNumber: String,
    val callerName: String,
    val startTime: Long,
    val callControlId: String,
    val isOutgoing: Boolean
)
```

### CrashRecoveryManager

**File**: `voip/CrashRecoveryManager.kt` (195 lines)
**Purpose**: Detects abandoned calls from previous session and cleans up.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `checkAndRecover` | `fun checkAndRecover(context: Context)` | Called on app startup. Detects abandoned calls, cleans orphaned resources (foreground service, notifications), shows recovery notification + Toast. |

**Critical**: Does NOT attempt to reconnect abandoned calls — only informs user and cleans up.

---

## 14. Missed Call Notifications

### MissedCallNotificationManager

**File**: `voip/MissedCallNotificationManager.kt` (274 lines)
**Purpose**: Tracks missed calls and shows persistent notifications with "Call Back" action.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `onCallMissed` | `fun onCallMissed(callerName, callerNumber, avatarUrl, organizationId)` | Show missed call notification when user doesn't answer. |
| `onCallMissedBusy` | `fun onCallMissedBusy(callerName, callerNumber, avatarUrl, organizationId)` | US-018: Show notification for auto-rejected calls when user was on another call. |
| `clearAll` | `fun clearAll()` | Clear all missed call notifications. |

- Notification channel: `z360_missed_calls`, importance HIGH
- Badge count via notification number
- "Call Back" action opens app with deep link to initiate call

---

## 15. Observability Stack

### VoipAnalytics

**File**: `voip/VoipAnalytics.kt` (847 lines)
**Purpose**: Firebase Analytics wrapper with 25+ VoIP-specific event types.

**Event Types** (all prefixed `voip_`):
```
call_initiated, call_connected, call_ended, audio_connected, error,
push_received, call_answered, call_rejected, call_missed,
push_z360_received, push_telnyx_received, push_sync_completed,
audio_focus_gained, audio_focus_lost, audio_focus_transient,
timer_started, timer_stopped, metadata_rendered,
incoming_foreground, incoming_background, incoming_cold_start,
push_rejected_logged_out,
outgoing_initiated, outgoing_ringback, outgoing_failed,
cross_org_call, call_missed_busy,
app_backgrounded, app_foregrounded
```

**Constants**:
- `OutgoingErrorType`: network, auth, busy, no_answer, invalid_number, rejected, timeout, sdk_error
- `CallPhase`: initiating, connecting, ringing, active
- `OrgSwitchResult`: success, failed_api, failed_no_credentials, failed_network, skipped_same_org

**User properties**: device_model, sdk_version (hardcoded "3.2.0"), android_version

### VoipLogger

**File**: `voip/VoipLogger.kt` (640 lines)
**Purpose**: Unified logging to Logcat + local file + Firebase Crashlytics breadcrumbs.

- Tag: `Z360_VOIP`
- Local file: `voip.log` in app's external files directory
- Categorized methods: `connection()`, `callState()`, `pushReceived()`, `audioRoute()`, `error()`
- `section()`: Visual separator for major events
- `checkpoint()`: Force-uploads logs to Firebase via non-fatal exception
- `redact()` / `redactToken()`: Sensitive data masking
- Call session correlation via `callSessionId` field

### CrashlyticsHelper

**File**: `voip/CrashlyticsHelper.kt` (353 lines)
**Purpose**: Structured error logging with custom keys and error codes.

**Error code families**:
- `CONN_*`: Connection errors
- `CALL_*`: Call lifecycle errors
- `OUT_*`: Outgoing call errors
- `AUDIO_*`: Audio system errors
- `PUSH_*`: Push notification errors
- `SDK_*`: Telnyx SDK errors
- `PERM_*`: Permission errors
- `FGS_*`: Foreground service errors

Key methods: `setCallContext()`, `updateCallState()`, `clearCallContext()`, `recordOutgoingCallFailure()`.

Custom `VoipException` class for synthetic non-fatal errors.

### VoipPerformance

**File**: `voip/VoipPerformance.kt` (294 lines)
**Purpose**: Firebase Performance custom traces for call metrics.

**Traces**: `outgoing_call`, `incoming_call`, `call_setup`, `audio_connection`, `push_to_ui`

**Metrics**: `time_to_ringback_ms`, `time_to_connect_ms`, `time_to_audio_ms`, `call_duration_seconds`

### VoipRemoteConfig

**File**: `voip/VoipRemoteConfig.kt` (245 lines)
**Purpose**: Firebase Remote Config for runtime VoIP tuning.

**Configurable parameters**:
- Timeouts: `call_setup_timeout_ms`, `push_sync_timeout_ms`, `hangup_timeout_ms`, `audio_settle_delay_ms`
- Feature flags: Various boolean toggles
- Audio settings: Codec preferences, gain levels
- Logging: Verbosity levels
- A/B test parameters

**Cache**: 12 hours in production, 0 in debug mode.

---

## 16. Utility Components

### PhoneNumberFormatter

**File**: `voip/PhoneNumberFormatter.kt` (40 lines)

```kotlin
fun formatPhoneNumber(number: String): String
// US-focused: 10/11 digit → "+1 (XXX) XXX-XXXX"

fun numbersMatch(a: String, b: String): Boolean
// Digits-only comparison for format-agnostic matching
```

---

## 17. Inter-Component Communication Map

```
┌─────────────────────────────────────────────────────────────┐
│                     WebView (JavaScript)                     │
│                  Capacitor plugin bridge                     │
└────────────────────────┬────────────────────────────────────┘
                         │ @PluginMethod calls
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   TelnyxVoipPlugin                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Z360VoipStore│  │TelnyxViewModel│  │  TokenHolder    │    │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘    │
└─────────┼────────────────┼───────────────────┼──────────────┘
          │                │                   │
          │    ┌───────────▼───────────┐       │
          │    │  telnyx_common SDK     │       │
          │    │  (TelnyxCommon,        │       │
          │    │   ProfileManager)      │       │
          │    └───────────┬───────────┘       │
          │                │                   │
┌─────────┼────────────────┼───────────────────┼──────────────┐
│ FCM     │                │                   │              │
│ ┌───────▼──────┐   ┌────▼─────────┐   ┌────▼────────┐     │
│ │PushSynchronizer│  │Z360Firebase  │   │  TokenHolder │     │
│ └───────┬──────┘   │  Messaging   │   └─────────────┘     │
│         │          │  Service     │                         │
│         │          └──────┬──────┘                         │
└─────────┼─────────────────┼────────────────────────────────┘
          │                 │
          │    ┌────────────▼────────────────┐
          │    │  Z360ConnectionService       │
          │    │  └─▶ Z360Connection         │
          │    │      └─▶ onShowIncomingCallUi│
          │    └────────────┬────────────────┘
          │                 │
          │    ┌────────────▼────────────────┐
          │    │  IncomingCallActivity        │
          │    │  ├─ OrgSwitchHelper         │
          │    │  ├─ BluetoothAudioManager   │
          │    │  └─ AudioDiagnostics        │
          │    └────────────┬────────────────┘
          │                 │ (user answers)
          │    ┌────────────▼────────────────┐
          │    │  ActiveCallActivity          │
          │    │  ├─ CallTimerManager         │
          │    │  ├─ CallStatePersistence     │
          │    │  ├─ BluetoothAudioManager   │
          │    │  ├─ AudioDiagnostics        │
          │    │  └─ VoipPerformance         │
          │    └─────────────────────────────┘
          │
          │    ┌─────────────────────────────┐
          └───▶│  MissedCallNotificationMgr  │
               │  CrashRecoveryManager       │
               │  VoipAnalytics              │
               │  VoipLogger                 │
               │  CrashlyticsHelper          │
               │  VoipRemoteConfig           │
               └─────────────────────────────┘
```

### Communication mechanisms:
1. **Direct method calls**: Most common — TelnyxVoipPlugin → TelnyxViewModel, Activities → managers
2. **StateFlow/Flow**: TelnyxViewModel exposes `uiState`, `callQualityMetrics`, `connectionStatus` flows collected by Plugin and Activities
3. **BroadcastReceiver**: `ACTION_CALL_DISPLAY_INFO_UPDATED` (Z360VoipStore → IncomingCallActivity), `ACTION_CALL_ENDED` (FCM → IncomingCallActivity), `ACTION_BLUETOOTH_AUDIO_STATE` (BluetoothAudioManager → ActiveCallActivity)
4. **SharedPreferences**: Z360VoipStore for cross-component state (display info, org context, call-ended timestamps)
5. **Static singletons**: Z360Connection.activeConnection, TelnyxViewModelProvider, PushSynchronizer, CallTimerManager
6. **CompletableDeferred**: PushSynchronizer for two-push correlation
7. **Intents/Extras**: ConnectionService → IncomingCallActivity → ActiveCallActivity (caller info, session IDs, org context)

---

## 18. Telnyx SDK Divergences

Based on comparison with the Telnyx Android SDK source and demo app patterns:

### 1. Push Handling — Server-Mediated vs. Native Binding
**Telnyx SDK pattern**: SDK binds to FCM internally via `TelnyxPushService`, processes `txPushMetaData` key directly.
**Z360 pattern**: Z360 backend sends its own FCM push (caller display info), separate from Telnyx's push. `Z360FirebaseMessagingService` handles BOTH types and coordinates them via `PushSynchronizer`.
**Divergence reason**: Z360 needs org context, caller display info, and avatar URLs that Telnyx doesn't provide. Two-push architecture is a deliberate design choice.

### 2. Connection Management — Custom vs. SDK Default
**Telnyx SDK pattern**: SDK manages WebSocket connection lifecycle internally. Demo app simply calls `connect()`/`disconnect()`.
**Z360 pattern**: Multiple reconnection paths (BUG-003: skip if already connected, BUG-004: reconnect with txPushMetaData, BUG-006: wait for ClientLoggedIn). Cross-org reconnection via OrgSwitchHelper.
**Divergence reason**: Z360's multi-tenant architecture requires credential switching, and background push delivery requires ensuring SDK is connected before answering.

### 3. ViewModel Sharing — Custom ViewModelStore
**Telnyx SDK demo pattern**: Activity-scoped ViewModel.
**Z360 pattern**: Custom `ViewModelStore` singleton via `TelnyxViewModelProvider.get()`.
**Divergence reason**: Z360 needs shared state across Capacitor plugin + IncomingCallActivity + ActiveCallActivity, none of which share an activity lifecycle.

### 4. Call UI — Native Activities vs. SDK Notification
**Telnyx SDK pattern**: SDK provides `CallNotificationService` with system notification for incoming calls.
**Z360 pattern**: Full custom Activities (IncomingCallActivity, ActiveCallActivity) with Android Telecom framework integration (ConnectionService).
**Divergence reason**: Z360 needs branded UI, org context display, cross-org call handling, and Android 14+ lock screen support via SELF_MANAGED ConnectionService.

### 5. Audio Management — Explicit Control
**Telnyx SDK pattern**: SDK handles basic audio routing.
**Z360 pattern**: Explicit `AudioDiagnostics`, `BluetoothAudioManager`, audio mode management at every state change (BUG-008).
**Divergence reason**: Multiple audio-related bugs (US-008) drove Z360 to take full control of audio focus and routing rather than relying on SDK defaults.

### 6. Incoming Call Answer — Multi-Path
**Telnyx SDK demo pattern**: Direct `call.answerCall()` when call arrives.
**Z360 pattern**: Multi-path answer flow: direct answer, cross-org answer (credential switch first), push-based answer (wait for SDK INVITE), with 5s timeout and fallback.
**Divergence reason**: Background push delivery means the SDK call object may not exist yet when user taps answer. Cross-org adds credential switching before answer.

### 7. Codec Preferences
**Telnyx SDK default**: SDK uses its own codec negotiation.
**Z360 pattern**: Explicit preferred codecs: opus (48kHz stereo), PCMU (8kHz), PCMA (8kHz).
**Divergence**: Deliberate — Z360 prefers opus for quality.

---

## 19. Known Issues and TODOs

### From code comments and bug markers:

| ID | Component | Description |
|----|-----------|-------------|
| BUG-001 | TelnyxVoipPlugin | Thread-safe `AtomicReference<PendingIncomingCall?>` — fixed, was race condition |
| BUG-003 | TelnyxVoipPlugin, FCM | Skip re-connect if SDK already connected — prevents killing push-established socket |
| BUG-004 | FCM | Pass txPushMetaData to SDK reconnection — was missing, causing push-based calls to fail |
| BUG-005 | IncomingCallActivity | `AtomicBoolean.compareAndSet` for double-tap prevention — was race condition |
| BUG-006 | TelnyxVoipPlugin | Wait for `ClientLoggedIn` state before resolving connect (8s timeout) — was resolving too early |
| BUG-007 | ActiveCallActivity | Mutex-protected callStateJob — prevents duplicate observers during state flapping |
| BUG-008 | ActiveCallActivity, AudioDiagnostics | Ensure `MODE_IN_COMMUNICATION` persists; proper AudioFocusRequest storage — was losing audio focus |
| BUG-012 | TelnyxVoipPlugin | Auto-mute during hold — prevents emulator audio HAL noise |
| BUG-013 | PushSynchronizer | CompletableDeferred replaces polling-with-backoff — was unreliable timing |
| **TODO** | OrgSwitchHelper | Hardcoded `API_BASE_URL = "https://app.z360.cloud"` — should use BuildConfig or remote config |
| **TODO** | VoipAnalytics | `sdk_version` hardcoded as `"3.2.0"` — should read from Telnyx SDK at runtime |
| **TODO** | Z360VoipStore | Phone normalization takes last 10 digits — may not work correctly for non-US international numbers with >10 digit national numbers |
| **TODO** | PushSynchronizer | Same phone normalization limitation as Z360VoipStore |
| **RISK** | Z360Connection | Only one active connection tracked via `AtomicReference<Z360Connection?>` — cannot support call waiting or conference |
| **RISK** | CrashRecoveryManager | Does not attempt reconnection of abandoned calls — user loses the call on crash |
| **RISK** | FCM | Telnyx SDK notification ID (1234) is hardcoded for suppression — may break if SDK changes this ID |

---

## 20. Manifest Declarations

From `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- FCM Service (line ~64) -->
<service android:name=".fcm.Z360FirebaseMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>

<!-- ConnectionService (line ~114) -->
<service android:name=".voip.Z360ConnectionService"
    android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"
    android:exported="true">
    <intent-filter>
        <action android:name="android.telecom.ConnectionService" />
    </intent-filter>
</service>

<!-- IncomingCallActivity (line ~124) -->
<activity android:name=".voip.IncomingCallActivity"
    android:excludeFromRecents="true"
    android:launchMode="singleTop"
    android:showOnLockScreen="true"
    android:showWhenLocked="true"
    android:turnScreenOn="true"
    android:taskAffinity="" />

<!-- ActiveCallActivity (line ~135) -->
<activity android:name=".voip.ActiveCallActivity"
    android:excludeFromRecents="true"
    android:launchMode="singleTop"
    android:taskAffinity="" />
```

### Permissions (VoIP-related):
- `RECORD_AUDIO` — Microphone for calls
- `READ_PHONE_STATE` — Phone state awareness
- `POST_NOTIFICATIONS` — Android 13+ notification permission
- `FOREGROUND_SERVICE` — Foreground service for active calls
- `FOREGROUND_SERVICE_PHONE_CALL` — Android 14+ phone call foreground service type
- `MANAGE_OWN_CALLS` — Self-managed ConnectionService
- `USE_FULL_SCREEN_INTENT` — Android 14+ full-screen incoming call notification
- `BLUETOOTH_CONNECT` — Android 12+ Bluetooth audio
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — Doze exemption for push reliability
