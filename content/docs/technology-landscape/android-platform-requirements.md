---
title: Android Platform Requirements
---

# Android Platform Requirements for VoIP

> **Research output for Z360 VoIP whitepaper**
> Covers Android platform constraints, requirements, and implementation patterns for VoIP applications.
> All file references are relative to the Z360 repository root unless noted otherwise.

---

## Table of Contents

1. [ConnectionService & Telecom Framework](#1-connectionservice--telecom-framework)
2. [Foreground Service Requirements](#2-foreground-service-requirements)
3. [Battery Optimization & Doze Mode](#3-battery-optimization--doze-mode)
4. [FCM Push Handling](#4-fcm-push-handling)
5. [Notification Channels & Call Notifications](#5-notification-channels--call-notifications)
6. [Permissions](#6-permissions)
7. [App Lifecycle & State Management](#7-app-lifecycle--state-management)
8. [Telnyx Demo vs Z360 Comparison](#8-telnyx-demo-vs-z360-comparison)

---

## 1. ConnectionService & Telecom Framework

### Platform Requirements

Android's Telecom framework (`android.telecom`) provides system-level integration for VoIP apps. Two API levels exist:

| API | Min SDK | Key Classes | Status |
|-----|---------|-------------|--------|
| Legacy Telecom | API 23 (Android 6) | `ConnectionService`, `Connection`, `TelecomManager`, `PhoneAccount` | Stable, widely used |
| Core-Telecom Jetpack | API 34 (Android 14) | `CallsManager`, `CallAttributesCompat`, `CallControlScope` | Modern replacement |

**Self-managed vs system-managed**: Apps can register as `CAPABILITY_SELF_MANAGED` (manage own UI) or use the system InCallUI. VoIP apps typically use self-managed to control the full call experience.

**What ConnectionService provides**:
- Lock screen incoming call display (Android 14+ requires this for reliable full-screen notifications)
- Bluetooth/car head unit audio routing integration
- System-level call management (hold, swap, conference awareness)
- Proper audio focus coordination with other apps

### Z360 Implementation

**File**: `android/app/src/main/java/com/z360/app/voip/Z360ConnectionService.kt` (lines 8873-9007 in skill)

Z360 implements a self-managed ConnectionService:

```kotlin
class Z360ConnectionService : ConnectionService() {
    // PhoneAccount registered as CAPABILITY_SELF_MANAGED
    // Supports both SIP and TEL URI schemes
    val phoneAccount = PhoneAccount.builder(handle, "Z360 Calls")
        .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
        .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
        .addSupportedUriScheme(PhoneAccount.SCHEME_TEL)
        .build()
}
```

**Registration**: PhoneAccount is registered during Capacitor plugin load in `TelnyxVoipPlugin.load()`:
```kotlin
// File: android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt (line 5896)
override fun load() {
    Z360ConnectionService.registerPhoneAccount(context)
    startObservingTelnyx()
}
```

**Incoming call flow via TelecomManager**:
1. FCM push arrives → `Z360FirebaseMessagingService.showIncomingCallNotification()` (line 1140-1154)
2. Builds Bundle with caller info extras (name, number, avatar, session ID, org context)
3. Calls `Z360ConnectionService.addIncomingCall(context, telecomExtras)` which calls `telecomManager.addNewIncomingCall(handle, extras)`
4. System calls `onCreateIncomingConnection()` → creates `Z360Connection` with `PROPERTY_SELF_MANAGED` and `setRinging()`
5. System calls `Z360Connection.onShowIncomingCallUi()` → posts fullScreenIntent notification AND launches `IncomingCallActivity` directly

**Z360Connection lifecycle** (`android/app/src/main/java/com/z360/app/voip/Z360Connection.kt`, lines 8655-8842):

```
Created → setRinging() → onShowIncomingCallUi()
  → User answers → onAnswer() → setActive()
  → User rejects → onReject() → setDisconnected(REJECTED) → destroy()
  → Call ends   → onDisconnect() → setDisconnected(LOCAL) → destroy()
```

**Fallback path**: If TelecomManager fails (`addIncomingCall` returns false or `onCreateIncomingConnectionFailed` fires), Z360 falls back to:
- Telnyx SDK's `CallNotificationService.showIncomingCallNotification()` (line 1164-1167)
- Or direct `IncomingCallActivity.start()` launch (lines 8995-9005)

**Bluetooth/car integration**: The self-managed ConnectionService automatically routes audio events through the system, enabling Bluetooth headset answer/reject and car head unit integration. Z360 also has a dedicated `BluetoothAudioManager` (line 2975) that handles:
- BluetoothHeadset profile proxy connection
- SCO audio routing start/stop
- Headset connection/disconnection detection via BroadcastReceiver
- Fallback to speaker/earpiece when Bluetooth disconnects

### Telnyx Demo Approach

**The Telnyx Android demo does NOT use ConnectionService**. It relies entirely on:
- `CallNotificationService` for incoming call notifications with `fullScreenIntent`
- `CallForegroundService` for keeping audio alive during active calls
- Direct activity launches for call UI

This means the Telnyx demo lacks lock screen call integration on Android 14+, system-level Bluetooth routing, and car head unit support.

---

## 2. Foreground Service Requirements

### Platform Requirements

Android 14+ (API 34) requires declared foreground service types in the manifest. For VoIP:

| Service Type | Use Case | Required Permission | Additional Runtime Permission |
|---|---|---|---|
| `phoneCall` | Active VoIP calls | `FOREGROUND_SERVICE_PHONE_CALL` | `MANAGE_OWN_CALLS` |
| `microphone` | Audio capture during calls | `FOREGROUND_SERVICE_MICROPHONE` | `RECORD_AUDIO` |

**Critical timing constraints**:
- Must call `startForeground()` within **10 seconds** of `startForegroundService()` or the system throws `ForegroundServiceDidNotStartInTimeException`
- Android 15: Cannot start `phoneCall` foreground service from `BOOT_COMPLETED` receiver
- Must post a visible notification as part of `startForeground()`

### Z360 Implementation

Z360 declares three foreground services in `AndroidManifest.xml` (lines 9438-9486):

**1. LegacyCallNotificationService** (Telnyx SDK, pre-Android 8):
```xml
<service android:name="com.telnyx.webrtc.common.notification.LegacyCallNotificationService"
    android:foregroundServiceType="phoneCall" />
```

**2. CallForegroundService** (Telnyx SDK, active call audio):
```xml
<service android:name="com.telnyx.webrtc.common.service.CallForegroundService"
    android:foregroundServiceType="phoneCall|microphone"
    android:permission="android.permission.FOREGROUND_SERVICE_PHONE_CALL"
    android:process=":call_service" />
```
- Runs in separate process (`:call_service`) to isolate from WebView
- Uses dual foreground service types with graceful fallback (tries `PHONE_CALL | MICROPHONE`, falls back to `PHONE_CALL` only on SecurityException)
- Managed via static `startService()`/`stopService()` with double-check pattern (volatile flag + ActivityManager query)

**3. Z360ConnectionService** (custom Telecom integration):
```xml
<service android:name=".voip.Z360ConnectionService"
    android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE">
    <intent-filter>
        <action android:name="android.telecom.ConnectionService" />
    </intent-filter>
</service>
```

**BUG-005 lesson learned** (line 1178): Starting a foreground service with a STOP action and returning early without calling `startForeground()` causes `ForegroundServiceDidNotStartInTimeException` crash + ANR. Z360 fixed this by using `stopService()` instead:
```kotlin
// WRONG: startForegroundService(stopIntent) → crash if service returns before startForeground()
// CORRECT:
private fun stopLegacyNotificationService() {
    val serviceIntent = Intent(this, LegacyCallNotificationService::class.java)
    stopService(serviceIntent)
}
```

### Telnyx Demo Approach

The Telnyx demo uses `CallForegroundService` identically (it's from the shared `telnyx_common` module). It uses `START_STICKY` return value to ensure the service restarts if killed. The foreground service startup has a three-tier fallback:

```kotlin
// File: telnyx_common/src/main/java/com/telnyx/webrtc/common/service/CallForegroundService.kt
try {
    startForeground(id, notification, FOREGROUND_SERVICE_TYPE_PHONE_CALL or FOREGROUND_SERVICE_TYPE_MICROPHONE)
} catch (e: SecurityException) {
    startForeground(id, notification, FOREGROUND_SERVICE_TYPE_PHONE_CALL) // fallback 1
} catch (e: SecurityException) {
    startForeground(id, notification) // fallback 2: no types (pre-Q)
}
```

---

## 3. Battery Optimization & Doze Mode

### Platform Requirements

**Doze Mode** (Android 6+): When device is stationary with screen off, the system defers background work. Affects:
- Network access restricted
- Jobs/syncs/alarms deferred
- **FCM high-priority messages still delivered** (with 10s execution window)

**App Standby**: Limits background network for apps not recently used. FCM high-priority exempt.

**Battery Optimization Exemptions**: Apps can request `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` to be exempt from Doze/App Standby. Google Play policy restricts this to specific use cases (VoIP qualifies under "messaging/communication").

### Z360 Implementation

Z360 exposes battery optimization exemption via Capacitor plugin:

**File**: `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt` (lines 6386-6397)

```kotlin
@PluginMethod
fun requestBatteryOptimizationExemption(call: PluginCall) {
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
    }
    context.startActivity(intent)
    call.resolve()
}
```

Z360 relies on **FCM high-priority data messages** for incoming call delivery during Doze mode. There is no explicit Doze handling in the native code — the approach is:
1. Backend sends high-priority FCM data message → bypasses Doze
2. FCM wakes the app process for 10 seconds
3. `Z360FirebaseMessagingService.onMessageReceived()` runs within that window
4. Show notification / launch ConnectionService within the 10s window

**No explicit WakeLock usage** for Doze bypass. Z360 declares `WAKE_LOCK` permission (line 9389) but uses it implicitly through FCM and foreground service mechanisms.

### Telnyx Demo Approach

The Telnyx demo does not explicitly handle battery optimization. It relies on the same FCM high-priority mechanism. No `requestBatteryOptimizationExemption` equivalent exists in the demo.

---

## 4. FCM Push Handling

### Platform Requirements

- **Data messages** (not notification messages) must be used for VoIP to ensure `onMessageReceived()` is always called
- **HIGH priority** messages bypass Doze mode and wake the device
- Must show a notification within **10 seconds** of delivery or future messages may be deprioritized
- `onNewToken()` must handle token refresh and update the server
- App process may be cold-started by FCM delivery

### Z360 Implementation

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt` (lines 577-1192)

Z360 uses a **dual-push system** — two separate FCM messages for each incoming call:

| Push Type | Source | Contents | Typical Arrival |
|---|---|---|---|
| Z360 Backend Push | Z360 Laravel backend | Caller name, avatar, organization ID/name, channel number | Usually arrives first |
| Telnyx SDK Push | Telnyx platform | Call control metadata (call ID, SIP headers), `metadata` JSON field | Usually arrives second |

**Processing flow in `onMessageReceived()`**:

1. **Login check** (US-014): Verifies `ProfileManager.getLoggedProfile()` has valid SIP credentials. Rejects push silently if logged out.
2. **Call ended handling**: If `data["type"] == "call_ended"`, dismisses all notifications and broadcasts to close IncomingCallActivity.
3. **Missed call detection**: If Telnyx push has `data["message"] == MISSED_CALL`, clears notifications.
4. **Telnyx metadata push** (`metadataJson != null`): Routes to `handleTelnyxMetadataPush()`.
5. **Z360 caller info push** (no metadata): Routes to `handleZ360CallerInfoPush()`.

**PushSynchronizer** (`android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt`, lines 1-134):

Coordinates the race condition between the two pushes:
- Uses `CompletableDeferred<CallDisplayInfo?>` for structured waiting
- Normalized phone number (last 10 digits) as correlation key (because call IDs differ between Z360 and Telnyx)
- **500ms timeout** for waiting (generous — typical push latency is 50-200ms)
- Three sync outcomes:
  - `IMMEDIATE`: Z360 data already in store when Telnyx arrives (0ms wait)
  - `LATE_Z360`: Telnyx arrived first, Z360 completed deferred during wait
  - `TIMEOUT/NO_PHONE`: Proceeded with Telnyx data only

**Cold start handling** (US-013):
- Tracks `serviceCreationTime` in companion object
- Detects cold start when first push arrives within 5s of service creation
- Logs `pushToNotificationMs` timing for monitoring (expected: 500-2000ms)

**SDK reconnection** (BUG-003, lines 1020-1066):
```kotlin
private fun ensureTelnyxSdkConnected(txPushMetaDataJson: String?) {
    // Check if already connected
    if (sessionState is TelnyxSessionState.ClientLoggedIn) return
    // Reconnect with stored credentials + push metadata
    telnyxViewModel.credentialLogin(viewContext, profile, txPushMetaData = txPushMetaDataJson)
    // Wait up to 5 seconds for connection
    runBlocking { withTimeoutOrNull(5000L) { ... } }
}
```

**Single-call support** (US-018, lines 932-985): Auto-rejects incoming calls when user is already on a call. Shows missed call notification instead.

### Telnyx Demo Approach

The Telnyx demo uses a simpler single-push system — only the Telnyx SDK push with `metadata` field. No Z360 backend push, no PushSynchronizer, no dual-push coordination. The demo's `MyFirebaseMessagingService` (from `telnyx_common`) handles:
- Parsing `PushMetaData` from the `metadata` field
- Showing notification via `CallNotificationService`
- SDK reconnection via `credentialLogin()` with push metadata

---

## 5. Notification Channels & Call Notifications

### Platform Requirements

Android 8+ (API 26) requires notification channels. For VoIP:

| Channel Purpose | Required Importance | Why |
|---|---|---|
| Incoming calls | `IMPORTANCE_HIGH` | Triggers heads-up display and sound |
| Ongoing calls | `IMPORTANCE_LOW` or `DEFAULT` | Persistent but non-intrusive |
| Missed calls | `IMPORTANCE_HIGH` | User should see these promptly |

**Full-screen intents**: Required for showing call UI on lock screen. Android 14+ requires `USE_FULL_SCREEN_INTENT` permission and runtime check via `canUseFullScreenIntent()`.

**CallStyle notifications** (Android 12+/API 31): `NotificationCompat.CallStyle` provides native call appearance with answer/reject buttons matching the system dialer aesthetic. Three variants:
- `forIncomingCall(person, declinePendingIntent, answerPendingIntent)`
- `forOngoingCall(person, hangUpPendingIntent)`
- `forScreeningCall(person, hangUpPendingIntent, answerPendingIntent)`

### Z360 Implementation

Z360 uses **three notification channels**:

**1. Incoming calls** (`z360_incoming_call`, Z360Connection line 8804):
```kotlin
val channel = NotificationChannel(
    NOTIFICATION_CHANNEL_ID,  // "z360_incoming_call"
    "Incoming Calls",
    NotificationManager.IMPORTANCE_HIGH
).apply {
    description = "Notifications for incoming VoIP calls"
    setSound(null, null) // IncomingCallActivity handles ringtone
}
```

**2. Crash recovery** (`z360_crash_recovery`, CrashRecoveryManager line 4196):
- `IMPORTANCE_HIGH`, shows badge
- Used when app crashes during active call and recovers on restart

**3. Missed calls** (`z360_missed_calls`, MissedCallNotificationManager line 5338):
- `IMPORTANCE_HIGH`
- Tracks missed call count with badge

**Incoming call notification** (Z360Connection.postIncomingCallNotification, lines 8794-8835):
```kotlin
val notification = NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
    .setSmallIcon(R.drawable.ic_call_answer)
    .setContentTitle("Incoming Call")
    .setContentText(displayText)
    .setPriority(NotificationCompat.PRIORITY_MAX)
    .setCategory(NotificationCompat.CATEGORY_CALL)
    .setOngoing(true)
    .setAutoCancel(false)
    .setFullScreenIntent(fullScreenPendingIntent, true)
    .build()
```

**Notable**: Z360 does NOT use `CallStyle` notifications. It uses a basic notification with `fullScreenIntent` targeting `IncomingCallActivity`.

**Full-screen intent permission check** (line 1127-1137):
```kotlin
if (Build.VERSION.SDK_INT >= 34) {
    val canUseFullScreen = notificationManager?.canUseFullScreenIntent() ?: false
    if (!canUseFullScreen) {
        VoipLogger.w(LOG_COMPONENT, "Full-screen intent NOT granted")
    }
}
```

Z360 also provides `openFullScreenIntentSettings()` plugin method (line 6401-6416) to direct users to grant the permission.

### Telnyx Demo Approach

The Telnyx demo uses **CallStyle notifications** on Android 12+:

```kotlin
// File: app/src/main/java/com/telnyx/voice/demo/notification/CallNotificationService.kt
if (useCallStyle && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    val person = Person.Builder().setName(callerName).setImportant(true).build()
    builder.setStyle(
        NotificationCompat.CallStyle.forIncomingCall(person, rejectPendingIntent, answerPendingIntent)
    )
}
```

The demo creates **two channels**:
- `telnyx_call_notification_channel` (IMPORTANCE_HIGH) — incoming calls with ringtone sound via AudioAttributes
- `telnyx_call_ongoing_channel` (IMPORTANCE_LOW) — ongoing calls

The demo also uses `CallStyle.forOngoingCall()` for active call notifications, which Z360 doesn't implement.

---

## 6. Permissions

### Platform Requirements & Z360 Declaration

Z360's `AndroidManifest.xml` (lines 9370-9396) declares the following VoIP-related permissions:

| Permission | Category | Runtime? | When Needed | Z360 Has |
|---|---|---|---|---|
| `INTERNET` | Core | No | WebRTC/SIP connections | Yes |
| `ACCESS_NETWORK_STATE` | Core | No | Network availability checks | Yes |
| `RECORD_AUDIO` | Audio | **Yes** | Microphone for calls | Yes |
| `MODIFY_AUDIO_SETTINGS` | Audio | No | Audio routing (speaker, earpiece) | Yes |
| `READ_PHONE_STATE` | Telecom | **Yes** | Phone state monitoring | Yes |
| `CALL_PHONE` | Telecom | **Yes** | Required by some OEMs for VoIP | Yes |
| `MANAGE_OWN_CALLS` | Telecom | No | Self-managed ConnectionService + phoneCall FGS | Yes |
| `POST_NOTIFICATIONS` | Notification | **Yes (API 33+)** | Show call notifications | Yes |
| `USE_FULL_SCREEN_INTENT` | Notification | **Special (API 34+)** | Full-screen incoming call UI | Yes |
| `VIBRATE` | Notification | No | Vibration on incoming call | Yes |
| `FOREGROUND_SERVICE` | Service | No | Run foreground services | Yes |
| `FOREGROUND_SERVICE_PHONE_CALL` | Service | No | Phone call type FGS | Yes |
| `FOREGROUND_SERVICE_MICROPHONE` | Service | No | Microphone type FGS | Yes |
| `WAKE_LOCK` | Background | No | Keep CPU awake during push handling | Yes |
| `BLUETOOTH` | Audio | No (max SDK 30) | Legacy Bluetooth access | Yes |
| `BLUETOOTH_CONNECT` | Audio | **Yes (API 31+)** | Bluetooth headset connection | Yes |
| `BIND_TELECOM_CONNECTION_SERVICE` | Service | No | ConnectionService binding (system only) | Yes |

### Z360 Runtime Permission Flow

**File**: `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt` (lines 5827-5843)

Capacitor plugin declares three permission groups:
```kotlin
@CapacitorPlugin(
    name = "TelnyxVoip",
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
        Permission(strings = [Manifest.permission.READ_PHONE_STATE], alias = "phoneState")
    ]
)
```

All three are requested together via `requestAllPermissions()` (line 6243). The callback reports status for each alias (line 6420-6426).

**Special permission handling**:
- **Full-screen intent** (API 34+): Checked at runtime via `canUseFullScreenIntent()`, user directed to settings via `openFullScreenIntentSettings()` plugin method
- **Battery optimization**: Requested via `requestBatteryOptimizationExemption()` plugin method using `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent
- **BLUETOOTH_CONNECT**: Checked before any Bluetooth operations in `BluetoothAudioManager` with `hasBluetoothPermission()` guard

### Telnyx Demo Approach

The demo requests only `RECORD_AUDIO` and `POST_NOTIFICATIONS` at runtime:
```kotlin
val permissions = arrayOf(
    Manifest.permission.RECORD_AUDIO,
    Manifest.permission.POST_NOTIFICATIONS
)
```

No `READ_PHONE_STATE`, no battery optimization request, no full-screen intent settings navigation.

---

## 7. App Lifecycle & State Management

### Platform Requirements

Android VoIP apps must handle three lifecycle states:

| State | Push Delivery | Execution Window | UI Launch |
|---|---|---|---|
| **Foreground** (app visible) | Immediate | Unlimited | Direct activity launch |
| **Background** (app in recents) | Immediate (high-priority) | 10s from FCM | Foreground service + notification required |
| **Process killed** (swiped away/OOM) | Immediate (high-priority) | 10s from FCM cold-starts process | Foreground service + notification required |

**Lock screen**: Activities declared with `showWhenLocked="true"` and `turnScreenOn="true"` in manifest can display over the lock screen.

### Z360 Implementation

**IncomingCallActivity lock screen support** (`AndroidManifest.xml` lines 9488-9497):
```xml
<activity android:name=".voip.IncomingCallActivity"
    android:excludeFromRecents="true"
    android:launchMode="singleTop"
    android:showWhenLocked="true"
    android:taskAffinity=""
    android:turnScreenOn="true" />
```

**Programmatic lock screen flags** (`IncomingCallActivity.setupLockScreenFlags()`, line 4576-4582):
```kotlin
private fun setupLockScreenFlags() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        keyguardManager.requestDismissKeyguard(this, null)
    } else {
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        )
    }
}
```

**Cold start path** (process killed → FCM wakes app):
1. `Z360FirebaseMessagingService.onCreate()` — service created, cold start timestamp recorded (US-013)
2. `onMessageReceived()` — push arrives, login check, push synchronization
3. `ensureTelnyxSdkConnected()` — reconnects SDK with stored credentials + push metadata (5s timeout)
4. `showIncomingCallNotification()` — attempts ConnectionService first, then Telnyx notification fallback
5. `IncomingCallActivity` launched via fullScreenIntent or direct start

**Crash recovery** (`android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt`, lines 4134-4300):
- `CallStatePersistence` persists active call state to SharedPreferences
- On app restart, `checkAndRecoverFromCrash()` detects abandoned calls
- Cleans up orphaned resources (stops CallForegroundService, cancels notifications)
- Shows recovery notification informing user the call was disconnected

**App backgrounding during active call** (US-019, ActiveCallActivity lines 2341-2404):
- Detects app going to background via lifecycle observer
- Checks if CallForegroundService is running to keep audio alive
- Logs analytics: `voip_app_backgrounded` / `voip_app_foregrounded` with call duration and FGS status
- BluetoothAudioManager cleanup on call end

**BUG-003: WebView reconnect conflict** (line 5916-5918):
When Capacitor WebView calls `connect()` on page load, it would kill the native SDK socket established during the push flow. Z360 fixed this by checking if already connected before re-connecting:
```kotlin
if (currentState is TelnyxSessionState.ClientLoggedIn) {
    VoipLogger.d(LOG_COMPONENT, "Already connected, skipping reconnect")
    call.resolve(JSObject().put("status", "already_connected"))
    return
}
```

### Telnyx Demo Approach

The demo handles foreground/background via a simpler model:
- Uses `CallForegroundService` for background audio persistence
- No crash recovery mechanism
- No cold start detection or timing analytics
- No dual-push synchronization needed (single push system)

---

## 8. Telnyx Demo vs Z360 Comparison

| Feature | Telnyx Demo | Z360 | Notes |
|---|---|---|---|
| **ConnectionService** | Not used | `Z360ConnectionService` (self-managed) | Z360 added for lock screen + Bluetooth on Android 14+ |
| **PhoneAccount** | None | `CAPABILITY_SELF_MANAGED`, SIP+TEL schemes | Registered during plugin load |
| **Foreground service** | `CallForegroundService` (phoneCall\|microphone) | Same + LegacyCallNotificationService + Z360ConnectionService | Z360 adds ConnectionService as FGS |
| **FGS process isolation** | Same process | `:call_service` separate process | Isolates from WebView crashes |
| **Push system** | Single Telnyx push | Dual push (Z360 backend + Telnyx) | Z360 adds caller display info |
| **Push synchronization** | None needed | `PushSynchronizer` with CompletableDeferred (500ms) | Handles race between two pushes |
| **Incoming notification** | `CallStyle` (Android 12+) with Person | Basic notification with fullScreenIntent | Z360 missing CallStyle |
| **Ongoing call notification** | `CallStyle.forOngoingCall()` | None (relies on FGS notification) | Gap in Z360 |
| **Notification channels** | 2 (incoming HIGH, ongoing LOW) | 3 (incoming HIGH, crash HIGH, missed HIGH) | Z360 adds crash recovery + missed |
| **Runtime permissions** | RECORD_AUDIO, POST_NOTIFICATIONS | RECORD_AUDIO, POST_NOTIFICATIONS, READ_PHONE_STATE | Z360 adds phone state |
| **Battery optimization** | Not handled | `requestBatteryOptimizationExemption()` plugin method | Z360 exposes to web layer |
| **Full-screen intent** | fullScreenIntent on notification | fullScreenIntent + `canUseFullScreenIntent()` check + settings navigation | Z360 handles API 34+ restrictions |
| **Lock screen** | fullScreenIntent only | showWhenLocked + turnScreenOn + requestDismissKeyguard + ConnectionService | Z360 has multiple mechanisms |
| **Cold start detection** | None | Service creation timestamp + push timing analytics (US-013) | Z360 monitors cold start latency |
| **Crash recovery** | None | `CrashRecoveryManager` + `CallStatePersistence` | Z360 detects abandoned calls |
| **SDK reconnection** | Via push metadata in credentialLogin | `ensureTelnyxSdkConnected()` with 5s timeout (BUG-003) | Same mechanism, Z360 adds timeout |
| **Login check** | None | `isUserLoggedIn()` rejects push when logged out (US-014) | Z360 prevents ghost calls |
| **Busy handling** | None | Auto-reject + missed call notification (US-018) | Z360 supports single-call mode |
| **Bluetooth audio** | Via ConnectionService/system | `BluetoothAudioManager` + SCO routing + headset detection | Z360 has explicit Bluetooth management |
| **Audio focus** | Handled by SDK internally | `AudioDiagnostics` with stored `AudioFocusRequest` (US-008) | Z360 adds proper focus abandonment |
| **Audio diagnostics** | None | Comprehensive `AudioDiagnostics` logging | Z360 logs full audio state at checkpoints |

### Key Gaps in Z360 vs Demo

1. **No CallStyle notifications**: Z360 uses basic notifications where Telnyx demo uses modern `CallStyle.forIncomingCall()` and `CallStyle.forOngoingCall()`. CallStyle provides native call appearance and is recommended by Google.

2. **No ongoing call notification**: Z360 relies on the CallForegroundService's notification but doesn't implement a Z360-branded ongoing call notification with CallStyle.

### Key Advantages of Z360 over Demo

1. **ConnectionService integration**: Lock screen calls, Bluetooth/car support, system call management
2. **Dual-push with PushSynchronizer**: Rich caller display info from Z360 backend
3. **Crash recovery**: Detects and recovers from abandoned calls
4. **Comprehensive audio management**: BluetoothAudioManager, AudioDiagnostics, proper focus lifecycle
5. **Cold start analytics**: Monitors push-to-notification latency
6. **Security**: Login check prevents ghost calls on logged-out devices
7. **Battery optimization**: Exposes exemption request to web layer

---

## Appendix: Key File Reference

| File | Purpose |
|---|---|
| `android/app/src/main/AndroidManifest.xml` | Permissions, services, activities declaration |
| `android/app/src/main/java/com/z360/app/voip/Z360ConnectionService.kt` | Self-managed ConnectionService |
| `android/app/src/main/java/com/z360/app/voip/Z360Connection.kt` | Connection lifecycle (ringing → active → disconnected) |
| `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt` | FCM push handling, dual-push routing |
| `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt` | CompletableDeferred-based push timing coordination |
| `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt` | Capacitor plugin: permissions, battery opt, connection |
| `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt` | Lock screen incoming call UI |
| `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt` | Active call UI with lifecycle handling |
| `android/app/src/main/java/com/z360/app/voip/BluetoothAudioManager.kt` | Bluetooth SCO routing, headset detection |
| `android/app/src/main/java/com/z360/app/voip/AudioDiagnostics.kt` | Audio focus management, state logging |
| `android/app/src/main/java/com/z360/app/voip/CrashRecoveryManager.kt` | Abandoned call detection + recovery |
| `android/app/src/main/java/com/z360/app/voip/MissedCallNotificationManager.kt` | Missed call notifications with badge count |
| `android/app/src/main/java/com/z360/app/voip/Z360VoipStore.kt` | Persists org context, caller display info |
| `android/app/src/main/java/com/z360/app/fcm/TokenHolder.kt` | FCM token management with retry |
