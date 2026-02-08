---
title: Inbound Call Android Flow
---

# Android Inbound Call Flow — Complete Trace

> **Session 09 Research** — Android Inbound Call Tracer
> Traces the complete inbound call lifecycle on Android from push notification to call completion.

---

## Table of Contents

1. [Overview](#1-overview)
2. [STEP 1: PUSH ARRIVES — FCM Delivery](#2-step-1-push-arrives--fcm-delivery)
3. [STEP 2: PUSH SYNCHRONIZATION — Two-Push Correlation](#3-step-2-push-synchronization--two-push-correlation)
4. [STEP 3: INCOMING CALL UI — ConnectionService + IncomingCallActivity](#4-step-3-incoming-call-ui--connectionservice--incomingcallactivity)
5. [STEP 4: USER ANSWERS — Answer Flow](#5-step-4-user-answers--answer-flow)
6. [STEP 5: CALL IN PROGRESS — ActiveCallActivity](#6-step-5-call-in-progress--activecallactivity)
7. [STEP 6: CALL ENDS — Hangup Flow](#7-step-6-call-ends--hangup-flow)
8. [STEP 7: OUTBOUND CALL — Reverse Flow](#8-step-7-outbound-call--reverse-flow)
9. [Edge Cases & Error Handling](#9-edge-cases--error-handling)
10. [Key Architectural Patterns](#10-key-architectural-patterns)
11. [File Reference Index](#11-file-reference-index)

---

## 1. Overview

Android inbound calls follow a **native-only flow** — the WebView is not involved. The app can be killed, backgrounded, or in the foreground. FCM high-priority data messages wake the app and trigger the call UI.

### Key Architecture Points

- **Two-push system**: Z360 backend push (caller info) + Telnyx SDK push (call control) arrive independently
- **Push correlation**: `PushSynchronizer` coordinates the two pushes with 500ms timeout using `CompletableDeferred`
- **Self-managed ConnectionService**: Integrates with Android Telecom framework for lock screen, Bluetooth, car mode
- **Custom Activities**: `IncomingCallActivity` (ringing) → `ActiveCallActivity` (in-call)
- **Shared ViewModel**: `TelnyxViewModelProvider.get()` provides singleton `TelnyxViewModel` across Activities and Capacitor plugin
- **Single call support**: Auto-rejects incoming calls when user is already on a call (US-018)

---

## 2. STEP 1: PUSH ARRIVES — FCM Delivery

### 2.1 Entry Point: `Z360FirebaseMessagingService.onMessageReceived()`

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:688-756`

```kotlin
override fun onMessageReceived(message: RemoteMessage) {
    VoipLogger.section("FCM Message Received")
    val data = message.data
    val metadataJson = data["metadata"]

    // US-014: Check if user is logged in
    if (!isUserLoggedIn()) {
        VoipLogger.w(LOG_COMPONENT, "🚫 Push rejected: user is logged out")
        VoipAnalytics.logPushRejectedLoggedOut(...)
        return
    }

    // Handle call_ended push (simultaneous ring dismissal)
    if (data["type"] == "call_ended") {
        val callSessionId = data["call_session_id"] ?: ""
        val callerNumber = data[KEY_CALLER_NUMBER]
        stopLegacyNotificationService()
        CallNotificationService.cancelNotification(this)
        val nm = getSystemService(android.app.NotificationManager::class.java)
        nm?.cancel(9999)  // Z360Connection notification
        Z360VoipStore.markCallEnded(callerNumber)
        sendBroadcast(Intent(ACTION_CALL_ENDED).apply {
            putExtra("call_session_id", callSessionId)
        })
        return
    }

    // Route to handler based on payload type
    if (metadataJson != null) {
        handleTelnyxMetadataPush(metadataJson, data)
    } else {
        handleZ360CallerInfoPush(data)
    }
}
```

### 2.2 Z360 Backend Push Handler

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:767-833`

```kotlin
private fun handleZ360CallerInfoPush(data: Map<String, String>) {
    val arrivalTime = System.currentTimeMillis()
    val callerName = data[KEY_CALLER_NAME]
    val callerNumber = data[KEY_CALLER_NUMBER]
    val callerAvatar = data[KEY_CALLER_AVATAR]
    val organizationId = data[KEY_ORGANIZATION_ID]
    val organizationName = data[KEY_ORGANIZATION_NAME]
    val channelNumber = data[KEY_CHANNEL_NUMBER]
    val callId = data[KEY_CALL_ID]

    VoipLogger.d(LOG_COMPONENT, "📥 Z360 push | ts=$arrivalTime | name=$callerName | number=$callerNumber | callId=$callId")

    if (callerNumber.isNullOrEmpty()) {
        return  // Not a VoIP call info push
    }

    val store = Z360VoipStore.getInstance(applicationContext)

    // Save display info indexed by both callId and normalized phone
    store.saveCallDisplayInfo(
        callId = callId ?: callerNumber,
        callerName = callerName,
        callerNumber = callerNumber,
        avatarUrl = callerAvatar
    )

    // Save org context if available
    if (!callId.isNullOrEmpty()) {
        store.saveIncomingCallMeta(
            callId = callId,
            organizationId = organizationId,
            organizationName = organizationName,
            channelNumber = channelNumber
        )
    }

    // US-007: Notify PushSynchronizer to unblock waiting Telnyx handlers
    serviceScope.launch {
        PushSynchronizer.onZ360PushReceived(
            context = applicationContext,
            callerNumber = callerNumber,
            callId = callId,
            displayInfo = displayInfo
        )
    }

    // Broadcast update for IncomingCallActivity (if already showing)
    val updateIntent = Intent(Z360VoipStore.ACTION_CALL_DISPLAY_INFO_UPDATED).apply {
        putExtra(Z360VoipStore.EXTRA_CALL_ID, callId ?: callerNumber)
    }
    sendBroadcast(updateIntent)
}
```

**Payload Keys**:
- `type` = "incoming_call"
- `caller_name`, `caller_number`, `caller_avatar_url` (avatar)
- `organization_id`, `organization_name`, `channel_number`
- `call_id` (Z360's call session ID, may differ from Telnyx call ID)

### 2.3 Telnyx SDK Push Handler

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:847-1017`

```kotlin
private fun handleTelnyxMetadataPush(metadataJson: String, data: Map<String, String>) {
    val arrivalTime = System.currentTimeMillis()
    val pushMetaData = Gson().fromJson(metadataJson, PushMetaData::class.java)
    val store = Z360VoipStore.getInstance(applicationContext)

    VoipLogger.d(LOG_COMPONENT, "📥 Telnyx push | ts=$arrivalTime | callId=${pushMetaData.callId} | number=${pushMetaData.callerNumber}")

    // Guard against re-INVITE from caller who already hung up
    if (!pushMetaData.callerNumber.isNullOrEmpty() && store.wasRecentlyEnded(pushMetaData.callerNumber!!)) {
        VoipLogger.w(LOG_COMPONENT, "🚫 Ignoring re-INVITE from ${pushMetaData.callerNumber} — call was recently ended")
        return
    }

    // BUG-013 FIX: Use PushSynchronizer with CompletableDeferred (not polling)
    val syncResult = runBlocking {
        PushSynchronizer.onTelnyxPushReceived(
            context = applicationContext,
            callerNumber = pushMetaData.callerNumber,
            callId = pushMetaData.callId
        )
    }

    val displayInfo = syncResult.displayInfo
    VoipLogger.d(LOG_COMPONENT, "Sync result: type=${syncResult.syncType}, wait=${syncResult.waitTimeMs}ms, z360First=${syncResult.z360ArrivedFirst}")

    // Enhance push metadata with Z360 caller info (if available)
    val enhancedCallerName = displayInfo?.callerName ?: pushMetaData.callerName ?: pushMetaData.callerNumber ?: "Unknown"
    val enhancedCallerNumber = displayInfo?.callerNumber ?: pushMetaData.callerNumber ?: "Unknown"
    val enhancedAvatarUrl = displayInfo?.avatarUrl

    // Save/update display info with Telnyx call ID
    store.saveCallDisplayInfo(
        callId = pushMetaData.callId,
        callerName = enhancedCallerName,
        callerNumber = enhancedCallerNumber,
        avatarUrl = enhancedAvatarUrl
    )

    // US-018: Single call support - auto-reject if user is already on a call
    val activeCall = TelnyxCommon.getInstance().currentCall
    if (activeCall != null) {
        val activeState = activeCall.callStateFlow.value
        val isEnded = activeState is CallState.DONE || activeState is CallState.ERROR || activeState is CallState.DROPPED
        if (!isEnded) {
            VoipLogger.i(LOG_COMPONENT, "📞 BUSY: User already on call - marking incoming as missed")
            VoipAnalytics.logCallMissedBusy(...)
            MissedCallNotificationManager.getInstance(applicationContext).onCallMissedBusy(...)
            return  // Don't show incoming call UI
        }
    }

    // BUG-003 FIX: Ensure SDK is connected before showing call UI
    // BUG-004 FIX: Pass txPushMetaData so SDK receives the INVITE after reconnecting
    ensureTelnyxSdkConnected(metadataJson)

    // Suppress Telnyx SDK's internal notification (ID 1234)
    CallNotificationService.cancelNotification(this)

    showIncomingCallNotification(enhancedPushMetaData, enhancedAvatarUrl, data)
}
```

**Payload Keys**:
- `metadata` (JSON string) containing:
  - `callId` (Telnyx's call ID)
  - `callerName`, `callerNumber`
  - SIP INVITE metadata for SDK
- `voice_sdk_id`, `message` (Telnyx SDK keys)

### 2.4 SDK Reconnection (Cold Start / Background)

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:1025-1060`

```kotlin
private fun ensureTelnyxSdkConnected(txPushMetaDataJson: String? = null) {
    val telnyxViewModel = TelnyxViewModelProvider.get(applicationContext)
    val sessionState = telnyxViewModel.sessionsState.value

    if (sessionState is TelnyxSessionState.ClientLoggedIn) {
        VoipLogger.d(LOG_COMPONENT, "✅ Telnyx SDK already connected")
        return
    }

    val profile = ProfileManager.getLoggedProfile(applicationContext)
    if (profile == null || profile.sipUsername.isNullOrEmpty()) {
        VoipLogger.w(LOG_COMPONENT, "⚠️ No stored credentials for SDK reconnection")
        return
    }

    VoipLogger.i(LOG_COMPONENT, "🔄 Telnyx SDK not connected (state=$sessionState), reconnecting with pushMetaData...")

    telnyxViewModel.credentialLogin(
        viewContext = applicationContext,
        profile = profile,
        txPushMetaData = txPushMetaDataJson,
        autoLogin = true
    )

    // Wait up to 5s for connection
    // If not connected by then, proceed anyway (fallback to direct notification)
}
```

**Critical**: Passing `txPushMetaData` ensures the SDK receives the SIP INVITE after reconnecting, preventing answer failures.

---

## 3. STEP 2: PUSH SYNCHRONIZATION — Two-Push Correlation

### 3.1 PushSynchronizer Architecture

**File**: `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt:33-182`

**Purpose**: Coordinates Z360 and Telnyx pushes that arrive independently. Uses normalized phone number (last 10 digits) as correlation key.

```kotlin
object PushSynchronizer {
    private const val SYNC_TIMEOUT_MS = 500L
    private const val ENTRY_EXPIRY_MS = 30_000L

    data class SyncEntry(
        val normalizedPhone: String,
        val z360ArrivalTime: Long?,
        val telnyxArrivalTime: Long?,
        val displayInfoDeferred: CompletableDeferred<Z360VoipStore.CallDisplayInfo?>,
        val createdAt: Long = System.currentTimeMillis()
    )

    private val pendingSync = ConcurrentHashMap<String, SyncEntry>()
    private val mutex = Mutex()
}
```

### 3.2 Z360 Push Handling

```kotlin
suspend fun onZ360PushReceived(
    context: Context,
    callerNumber: String,
    callId: String?,
    displayInfo: Z360VoipStore.CallDisplayInfo
) {
    val normalizedPhone = normalizePhoneNumber(callerNumber)

    mutex.withLock {
        val existing = pendingSync[normalizedPhone]

        if (existing != null && existing.telnyxArrivalTime != null) {
            // Telnyx push is WAITING — complete it immediately
            VoipLogger.d(LOG_COMPONENT, "✅ Z360 arrived AFTER Telnyx, completing deferred immediately")
            existing.displayInfoDeferred.complete(displayInfo)
            val delay = arrivalTime - existing.telnyxArrivalTime
            VoipAnalytics.logPushSyncCompleted(callId, "late_z360", delay, false)
        } else {
            // Z360 arrived FIRST — store and pre-complete
            VoipLogger.d(LOG_COMPONENT, "⏳ Z360 arrived first, storing for Telnyx")
            val newEntry = SyncEntry(
                normalizedPhone = normalizedPhone,
                z360ArrivalTime = arrivalTime,
                telnyxArrivalTime = null,
                displayInfoDeferred = CompletableDeferred()
            )
            newEntry.displayInfoDeferred.complete(displayInfo)
            pendingSync[normalizedPhone] = newEntry
        }
    }
}
```

### 3.3 Telnyx Push Handling (with wait)

**File**: `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt:147-230`

```kotlin
suspend fun onTelnyxPushReceived(
    context: Context,
    callerNumber: String?,
    callId: String
): SyncResult {
    val normalizedPhone = callerNumber?.let { normalizePhoneNumber(it) } ?: ""

    if (normalizedPhone.isEmpty()) {
        return SyncResult(displayInfo = null, syncType = SyncType.NO_PHONE, ...)
    }

    // Check store first (immediate if Z360 already saved data)
    val existingInfo = store.getCallDisplayInfoWithFallback(callId, callerNumber)
    if (existingInfo != null) {
        return SyncResult(displayInfo = existingInfo, syncType = SyncType.IMMEDIATE, z360ArrivedFirst = true, ...)
    }

    // Not in store — wait for Z360 push (up to 500ms)
    mutex.withLock {
        val existing = pendingSync[normalizedPhone]

        if (existing != null && existing.z360ArrivalTime != null) {
            // Z360 already arrived and completed deferred
            val displayInfo = existing.displayInfoDeferred.await()
            return SyncResult(displayInfo, syncType = SyncType.IMMEDIATE, z360ArrivedFirst = true, ...)
        } else {
            // Z360 hasn't arrived yet — create deferred and wait
            val newEntry = SyncEntry(
                normalizedPhone = normalizedPhone,
                z360ArrivalTime = null,
                telnyxArrivalTime = arrivalTime,
                displayInfoDeferred = CompletableDeferred()
            )
            pendingSync[normalizedPhone] = newEntry
        }
    }

    // Wait for Z360 with timeout
    val deferred = pendingSync[normalizedPhone]!!.displayInfoDeferred
    val displayInfo = try {
        withTimeout(SYNC_TIMEOUT_MS) {
            deferred.await()
        }
    } catch (e: TimeoutCancellationException) {
        VoipLogger.w(LOG_COMPONENT, "⏱️ Timeout waiting for Z360 push (${SYNC_TIMEOUT_MS}ms)")
        null
    }

    return SyncResult(
        displayInfo = displayInfo,
        syncType = if (displayInfo != null) SyncType.WAITED else SyncType.TIMEOUT,
        waitTimeMs = System.currentTimeMillis() - arrivalTime,
        z360ArrivedFirst = false
    )
}
```

### 3.4 Phone Number Normalization

```kotlin
private fun normalizePhoneNumber(phone: String): String {
    val digitsOnly = phone.replace(Regex("[^0-9]"), "")
    return when {
        digitsOnly.length > 10 -> digitsOnly.takeLast(10)  // Strip country code
        digitsOnly.isNotEmpty() -> digitsOnly
        else -> ""
    }
}
```

**Example**: "+1 (555) 123-4567" → "5551234567"

---

## 4. STEP 3: INCOMING CALL UI — ConnectionService + IncomingCallActivity

### 4.1 Show Incoming Call Notification

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:1068-1175`

```kotlin
private fun showIncomingCallNotification(pushMetaData: PushMetaData, avatarUrl: String?, extraData: Map<String, String>) {
    // US-013: Detect cold start timing
    val isColdStart = !firstPushProcessed && serviceCreationTime > 0L &&
        (notificationStartTime - serviceCreationTime) < 5000L

    if (isColdStart) {
        val pushToNotificationMs = notificationStartTime - serviceCreationTime
        VoipLogger.d(LOG_COMPONENT, "⏱️ Cold start detected | service→notification: ${pushToNotificationMs}ms")
        VoipAnalytics.logIncomingColdStart(pushMetaData.callId, pushMetaData.callerNumber, pushToNotificationMs)
    }

    // Try ConnectionService first (Android 8.0+) for lock screen support
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val telecomExtras = Bundle().apply {
            putString(Z360ConnectionService.EXTRA_CALLER_NAME, pushMetaData.callerName ?: "Unknown")
            putString(Z360ConnectionService.EXTRA_CALLER_NUMBER, pushMetaData.callerNumber ?: "Unknown")
            putString(Z360ConnectionService.EXTRA_CALLER_AVATAR_URL, avatarUrl)
            putString(Z360ConnectionService.EXTRA_CALL_SESSION_ID, pushMetaData.callId)
            putString(Z360ConnectionService.EXTRA_PUSH_METADATA_JSON, Gson().toJson(pushMetaData))
            putString(Z360ConnectionService.EXTRA_ORGANIZATION_ID, extraData["organization_id"])
            putString(Z360ConnectionService.EXTRA_ORGANIZATION_NAME, extraData["organization_name"])
            putString(Z360ConnectionService.EXTRA_CHANNEL_NUMBER, extraData["channel_number"])
        }

        val telecomSuccess = Z360ConnectionService.addIncomingCall(this, telecomExtras)

        if (telecomSuccess) {
            CallNotificationService.cancelNotification(this)  // Suppress SDK notification
        } else {
            // Fallback to Telnyx SDK notification
            VoipLogger.w(LOG_COMPONENT, "TelecomManager failed, falling back to Telnyx notification")
            callNotificationService?.showIncomingCallNotification(pushMetaData, avatarUrl)
        }
    } else {
        // Pre-Android 8.0: Use legacy foreground service
        val serviceIntent = Intent(this, LegacyCallNotificationService::class.java).apply {
            putExtra("metadata", Gson().toJson(pushMetaData))
        }
        startForegroundService(serviceIntent)
    }
}
```

### 4.2 Z360ConnectionService

**File**: `android/app/src/main/java/com/z360/app/voip/Z360ConnectionService.kt:8873-9007`

```kotlin
class Z360ConnectionService : ConnectionService() {

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        VoipLogger.section("Z360ConnectionService.onCreateIncomingConnection()")

        val extras = request?.extras ?: Bundle()
        val callerName = extras.getString(EXTRA_CALLER_NAME, "Unknown")
        val callerNumber = extras.getString(EXTRA_CALLER_NUMBER, "Unknown")
        val callSessionId = extras.getString(EXTRA_CALL_SESSION_ID, "")

        val connection = Z360Connection(applicationContext, extras).apply {
            setAddress(Uri.fromParts("tel", callerNumber, null), TelecomManager.PRESENTATION_ALLOWED)
            setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
            connectionProperties = Connection.PROPERTY_SELF_MANAGED
            setRinging()  // Triggers onShowIncomingCallUi()
        }

        Z360Connection.setActiveConnection(connection)
        return connection
    }

    override fun onCreateIncomingConnectionFailed(...) {
        // Fallback: launch IncomingCallActivity directly without ConnectionService
        IncomingCallActivity.start(
            context = applicationContext,
            callerName = callerName,
            callerNumber = callerNumber,
            callerAvatarUrl = callerAvatarUrl,
            callSessionId = callSessionId,
            isOutgoing = false,
            pushMetadataJson = pushMetadataJson,
            organizationId = organizationId,
            organizationName = organizationName
        )
    }
}
```

### 4.3 Z360Connection — Incoming Call UI Trigger

**File**: `android/app/src/main/java/com/z360/app/voip/Z360Connection.kt:8655-8769`

```kotlin
class Z360Connection(private val context: Context, private val callExtras: Bundle) : Connection() {

    override fun onShowIncomingCallUi() {
        VoipLogger.section("Z360Connection.onShowIncomingCallUi()")

        val callerName = callExtras.getString(Z360ConnectionService.EXTRA_CALLER_NAME, "Unknown")
        val callerNumber = callExtras.getString(Z360ConnectionService.EXTRA_CALLER_NUMBER, "Unknown")
        val callerAvatarUrl = callExtras.getString(Z360ConnectionService.EXTRA_CALLER_AVATAR_URL)
        val callSessionId = callExtras.getString(Z360ConnectionService.EXTRA_CALL_SESSION_ID, "")
        val organizationId = callExtras.getString(Z360ConnectionService.EXTRA_ORGANIZATION_ID)
        val organizationName = callExtras.getString(Z360ConnectionService.EXTRA_ORGANIZATION_NAME)
        val pushMetadataJson = callExtras.getString(Z360ConnectionService.EXTRA_PUSH_METADATA_JSON)

        // Create fullScreenIntent for notification
        val fullScreenIntent = Intent(context, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP or FLAG_ACTIVITY_SINGLE_TOP
            putExtra("call_session_id", callSessionId)
            putExtra("caller_name", callerName)
            putExtra("caller_number", callerNumber)
            callerAvatarUrl?.let { putExtra("caller_avatar_url", it) }
            organizationId?.let { putExtra("organization_id", it) }
            organizationName?.let { putExtra("organization_name", it) }
            pushMetadataJson?.let { putExtra("push_metadata", it) }
        }

        val fullScreenPendingIntent = PendingIntent.getActivity(
            context, 0, fullScreenIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Post high-priority notification with fullScreenIntent (Android 14+ lock screen support)
        postIncomingCallNotification(callerName, callerNumber, fullScreenPendingIntent)

        // Also launch IncomingCallActivity directly for immediate display
        IncomingCallActivity.start(
            context = context,
            callerName = callerName,
            callerNumber = callerNumber,
            callerAvatarUrl = callerAvatarUrl,
            callSessionId = callSessionId,
            isOutgoing = false,
            pushMetadataJson = pushMetadataJson,
            organizationId = organizationId,
            organizationName = organizationName
        )
    }
}
```

**Notification ID**: 9999 (Z360 incoming call notification)
**Channel ID**: `z360_incoming_call` (HIGH importance)

### 4.4 IncomingCallActivity Lifecycle

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:4378-4574`

```kotlin
class IncomingCallActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        VoipLogger.section("IncomingCallActivity.onCreate()")

        setupLockScreenFlags()  // showWhenLocked, turnScreenOn
        setContentView(R.layout.activity_incoming_call)

        // Extract call data from intent
        callSessionId = intent.getStringExtra("call_session_id") ?: ""
        callerNumber = intent.getStringExtra("caller_number") ?: "Unknown"
        callerName = intent.getStringExtra("caller_name") ?: callerNumber
        callerAvatarUrl = intent.getStringExtra("caller_avatar_url")
        organizationId = intent.getStringExtra("organization_id")
        organizationName = intent.getStringExtra("organization_name")
        pushMetadataJson = intent.getStringExtra("push_metadata")

        // Hydrate from PushMetaData if available
        if (!pushMetadataJson.isNullOrEmpty()) {
            pushMetadata = Gson().fromJson(pushMetadataJson, PushMetaData::class.java)
            // Use push metadata to fill in missing fields
        }

        applyCallDisplayInfo()  // Load display info from Z360VoipStore

        // Check if this is a cross-org call
        if (organizationId == null && callSessionId.isNotEmpty()) {
            store.getIncomingCallMeta(callSessionId)?.let { meta ->
                organizationId = meta.organizationId
                organizationName = meta.organizationName
                val currentOrgId = store.getCurrentOrganizationId()
                switchOrg = meta.organizationId != null && currentOrgId != null && meta.organizationId != currentOrgId
            }
        }

        VoipLogger.callState("RINGING", "from: $callerName ($callerNumber)")
        if (switchOrg) {
            VoipLogger.i(LOG_COMPONENT, "CROSS-ORG CALL: requires switching to org $organizationId ($organizationName)")
        }

        // US-011: Log incoming foreground analytics event
        VoipAnalytics.logIncomingForeground(callId = callSessionId, callerNumber, launchSource, appState)

        setupUI()
        startRinging()  // Start ringtone + vibration
        observeCallState()  // Observe SDK state for remote cancel
    }

    private fun observeCallState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                telnyxViewModel.uiState.collect { state ->
                    when (state) {
                        is TelnyxSocketEvent.OnCallEnded -> {
                            VoipLogger.d(LOG_COMPONENT, "Call ended while ringing, closing")
                            stopRinging()
                            Z360Connection.notifyDisconnected(DisconnectCause.REMOTE)
                            finish()
                        }
                        is TelnyxSocketEvent.OnCallDropped -> {
                            VoipLogger.d(LOG_COMPONENT, "Call dropped while ringing")
                            stopRinging()
                            Toast.makeText(this@IncomingCallActivity, "Call failed", Toast.LENGTH_SHORT).show()
                            finish()
                        }
                        else -> {}
                    }
                }
            }
        }
    }

    private fun startRinging() {
        // Default system ringtone with looping, vibration pattern (1s on, 1s off)
        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        ringtone = RingtoneManager.getRingtone(applicationContext, ringtoneUri)
        ringtone?.isLooping = true  // Pre-Android P only
        ringtone?.play()

        // Post-Android P: Manual looping with Handler
        // ...
    }
}
```

**Manifest Flags** (AndroidManifest.xml):
- `android:launchMode="singleTop"` — Prevent duplicate activities
- `android:excludeFromRecents="true"` — Don't show in recents
- `android:showWhenLocked="true"` — Show on lock screen
- `android:turnScreenOn="true"` — Wake screen
- `android:taskAffinity=""` — Separate task

**BroadcastReceivers**:
- `ACTION_CALL_DISPLAY_INFO_UPDATED` — Updates UI when Z360 push arrives after Telnyx push
- `ACTION_CALL_ENDED` — Dismisses UI for simultaneous ring (another device answered)

---

## 5. STEP 4: USER ANSWERS — Answer Flow

### 5.1 Answer Button Click

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:4840-4864`

```kotlin
// BUG-005 FIX: AtomicBoolean prevents double-tap race condition
private val isAnswering = AtomicBoolean(false)

findViewById<Button>(R.id.btnAnswer).setOnClickListener {
    if (!isAnswering.compareAndSet(false, true)) {
        VoipLogger.d(LOG_COMPONENT, "Answer already in progress, ignoring double-tap")
        return@setOnClickListener
    }

    // Check if this is a cross-org call
    if (switchOrg && !organizationId.isNullOrEmpty()) {
        answerCrossOrgCall()
    } else {
        answerDirectly()
    }
}
```

### 5.2 Direct Answer Flow (Same Org)

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:4864-4979`

```kotlin
private fun answerDirectly() {
    stopRinging()  // Stop ringtone first

    lifecycleScope.launch {
        delay(250)  // Audio settle delay

        // BUG-003 FIX: Check SDK connection
        val isConnected = telnyxViewModel.sessionsState.value is TelnyxSessionState.ClientLoggedIn
        if (!isConnected) {
            VoipLogger.e(LOG_COMPONENT, "Cannot answer: Telnyx SDK is not connected")
            showAnswerError("Call not ready")
            return@launch
        }

        // STRATEGY: Multi-path answer logic with priority order
        val currentCall = telnyxViewModel.currentCall
        val pendingFromPlugin = TelnyxVoipPlugin.getPendingIncomingCall()

        if (currentCall != null) {
            // SDK has active/pending call — answer by UUID
            VoipLogger.d(LOG_COMPONENT, "Answering via currentCall: callId=${currentCall.callId}")
            telnyxViewModel.answerCall(
                viewContext = applicationContext,
                callId = currentCall.callId,
                callerIdNumber = callerNumber,
                debug = false
            )
        } else if (pendingFromPlugin != null) {
            // Plugin tracked a pending call from OnIncomingCall event
            VoipLogger.d(LOG_COMPONENT, "Answering via plugin pending call: callId=${pendingFromPlugin.callId}")
            telnyxViewModel.answerCall(
                viewContext = applicationContext,
                callId = UUID.fromString(pendingFromPlugin.callId),
                callerIdNumber = callerNumber,
                debug = false
            )
        } else if (!pushMetadataJson.isNullOrEmpty()) {
            // No pending call yet — SDK hasn't received INVITE. Wait up to 5s.
            VoipLogger.d(LOG_COMPONENT, "No pending call yet, waiting for SDK INVITE (up to 5s)")
            showConnectingState()

            val sdkCall = waitForSdkCall(5000L)
            if (sdkCall != null) {
                VoipLogger.d(LOG_COMPONENT, "SDK INVITE arrived while waiting, answering: callId=${sdkCall.callId}")
                telnyxViewModel.answerCall(
                    viewContext = applicationContext,
                    callId = sdkCall.callId,
                    callerIdNumber = callerNumber,
                    debug = false
                )
            } else {
                // Timeout — fall back to push answer
                VoipLogger.d(LOG_COMPONENT, "SDK INVITE timeout, falling back to answerIncomingPushCall")
                telnyxViewModel.answerIncomingPushCall(
                    viewContext = applicationContext,
                    txPushMetaData = pushMetadataJson,
                    debug = false
                )
            }
        } else {
            VoipLogger.e(LOG_COMPONENT, "No call to answer: no currentCall, no pending, no push metadata")
            showAnswerError("Call not ready")
            return@launch
        }

        // Notify Telecom framework
        Z360Connection.notifyAnswered()

        // Cancel notifications
        val notificationManager = getSystemService(android.app.NotificationManager::class.java)
        notificationManager?.cancel(9999)  // Z360Connection
        notificationManager?.cancel(1234)  // Telnyx SDK

        // Launch ActiveCallActivity
        VoipLogger.i(LOG_COMPONENT, "Launching ActiveCallActivity (call connecting...)")
        ActiveCallActivity.start(
            context = applicationContext,
            callerName = callerName,
            callerNumber = callerNumber,
            callerAvatarUrl = callerAvatarUrl,
            callSessionId = callSessionId,
            isOutgoing = false,
            callConnected = false  // Activity will update when OnCallAnswered arrives
        )

        store.clearIncomingCallMeta(callSessionId)
        finish()
    }
}
```

### 5.3 Cross-Org Answer Flow

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:5010-5111`

```kotlin
private fun answerCrossOrgCall() {
    val startTime = System.currentTimeMillis()
    val sourceOrgId = store.getCurrentOrganizationId()

    VoipLogger.i(LOG_COMPONENT, "🔄 CROSS-ORG CALL: Starting org switch flow")
    showOrgSwitchLoading(true)

    lifecycleScope.launch {
        try {
            // Step 1: Call backend API to switch org and get new credentials
            val apiStartTime = System.currentTimeMillis()
            val credentials = OrgSwitchHelper.switchOrgAndGetCredentials(
                organizationId = organizationId,
                organizationName = organizationName
            )

            val apiEndTime = System.currentTimeMillis()
            val apiDuration = apiEndTime - apiStartTime

            if (credentials == null) {
                VoipLogger.e(LOG_COMPONENT, "🔄 FAILED | No credentials returned")
                VoipAnalytics.logCrossOrgCall(..., result = FAILED_API, ...)
                showOrgSwitchError("Failed to switch organization")
                return@launch
            }

            // Step 2: Update Telnyx profile to new org credentials
            ProfileManager.saveProfile(
                applicationContext,
                Profile(
                    sipUsername = credentials.sipUsername,
                    sipPass = credentials.sipPassword,
                    callerIdName = credentials.callerIdName,
                    callerIdNumber = credentials.callerIdNumber,
                    isUserLoggedIn = true
                )
            )
            store.setCurrentOrganization(credentials.organizationId, credentials.organizationName)

            val endTime = System.currentTimeMillis()
            val totalDuration = endTime - startTime
            VoipLogger.i(LOG_COMPONENT, "🔄 STEP 5 | totalDuration=${totalDuration}ms | Org switch complete, answering call")
            VoipAnalytics.logCrossOrgCall(..., result = SUCCESS, durationMs = totalDuration)

            runOnUiThread {
                showOrgSwitchLoading(false)
                answerDirectly()  // Now answer with new credentials
            }
        } catch (e: Exception) {
            VoipLogger.e(LOG_COMPONENT, "🔄 FAILED | Exception: ${e.message}", e)
            VoipAnalytics.logCrossOrgCall(..., result = FAILED_API, ...)
            showOrgSwitchError("Failed to answer call: ${e.message}")
        }
    }
}
```

**OrgSwitchHelper API Call** (`android/app/src/main/java/com/z360/app/voip/OrgSwitchHelper.kt`):
- Endpoint: `POST https://app.z360.cloud/api/voip/switch-org` (hardcoded base URL)
- Body: `{"target_organization_id": "..."}`
- Auth: WebView cookies via `CookieManager.getInstance().getCookie()`
- Timeout: 10s connect + 10s read
- Returns: `{sipUsername, sipPassword, callerIdName, callerIdNumber, orgId, orgName}`

---

## 6. STEP 5: CALL IN PROGRESS — ActiveCallActivity

### 6.1 ActiveCallActivity Launch

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:1240-1402`

```kotlin
class ActiveCallActivity : AppCompatActivity() {

    companion object {
        fun start(
            context: Context,
            callerName: String,
            callerNumber: String,
            callerAvatarUrl: String?,
            callSessionId: String,
            isOutgoing: Boolean = false,
            callConnected: Boolean? = null
        ) {
            val intent = Intent(context, ActiveCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or FLAG_ACTIVITY_CLEAR_TOP or FLAG_ACTIVITY_SINGLE_TOP
                putExtra("caller_name", callerName)
                putExtra("caller_number", callerNumber)
                callerAvatarUrl?.let { putExtra("caller_avatar_url", it) }
                putExtra("call_session_id", callSessionId)
                putExtra("is_outgoing", isOutgoing)
                callConnected?.let { putExtra("call_connected", it) }
            }
            context.startActivity(intent)
        }
    }

    private val telnyxViewModel by lazy { TelnyxViewModelProvider.get(applicationContext) }
    private var isMuted = false
    private var isSpeakerOn = false
    private var isOnHold = false

    override fun onCreate(savedInstanceState: Bundle?) {
        VoipLogger.section("ActiveCallActivity.onCreate()")

        setupLockScreenFlags()
        setContentView(R.layout.activity_active_call)

        // Extract call data
        callerName = intent.getStringExtra("caller_name") ?: "Unknown"
        callerNumber = intent.getStringExtra("caller_number") ?: ""
        isOutgoing = intent.getBooleanExtra("is_outgoing", false)
        isCallConnected = intent.getBooleanExtra("call_connected", !isOutgoing)

        setupUI()
        applyCallDisplayInfo()

        // US-009 FIX: Start timer (CallTimerManager singleton survives config changes)
        if (isCallConnected) {
            startCallTimer()
        }

        // Initialize Bluetooth audio
        val bluetoothManager = BluetoothAudioManager.getInstance(applicationContext)
        bluetoothManager.initialize()

        // Initialize proximity sensor
        initializeProximitySensor()  // Turns off screen when near ear

        // BUG-008 FIX: Set audio mode immediately (not just on ACTIVE state)
        ensureAudioModeForCall()  // MODE_IN_COMMUNICATION

        observeCallState()
        observeCurrentCallState()
    }

    private fun ensureAudioModeForCall() {
        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (audioManager.mode != AudioManager.MODE_IN_COMMUNICATION) {
                VoipLogger.d(LOG_COMPONENT, "Setting audio mode to MODE_IN_COMMUNICATION")
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            }
        } catch (e: Exception) {
            VoipLogger.e(LOG_COMPONENT, "Failed to set audio mode", e)
        }
    }
}
```

### 6.2 Call State Observation

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:1412-1540`

```kotlin
private fun observeCallState() {
    lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.STARTED) {
            telnyxViewModel.uiState.collect { state ->
                when (state) {
                    is TelnyxSocketEvent.OnCallAnswered -> {
                        if (!isCallConnected) {
                            onCallAnswered()  // Start timer, update UI
                        }
                        observeCurrentCallState()
                    }
                    is TelnyxSocketEvent.OnMedia -> {
                        observeCurrentCallState()
                    }
                    is TelnyxSocketEvent.OnCallEnded -> {
                        if (!isFinishing) {
                            Z360Connection.notifyDisconnected()
                            stopCallTimer()
                            releaseProximitySensor()
                            AudioDiagnostics.resetAfterCall(applicationContext)
                            BluetoothAudioManager.getInstance(applicationContext).onCallEnded()
                            callStatePersistence.clearActiveCall()
                            finish()
                        }
                    }
                    is TelnyxSocketEvent.OnCallDropped -> {
                        handleCallDropped()  // Show error + end call
                    }
                    is TelnyxSocketEvent.OnCallReconnecting -> {
                        updateConnectionStateUI("RECONNECTING", 0, 0)
                    }
                    is TelnyxSocketEvent.OnRinging -> {
                        if (isOutgoing && !hasReceivedRingback) {
                            hasReceivedRingback = true
                            cancelOutgoingCallSetupTimeout()
                        }
                        observeCurrentCallState()
                    }
                    else -> {}
                }
            }
        }
    }

    // Observe connection status
    lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.STARTED) {
            telnyxViewModel.connectionStatus?.collect { status ->
                updateConnectionStateUI(status.name, 0, 0)
            }
        }
    }

    // Observe call quality metrics
    lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.STARTED) {
            telnyxViewModel.callQualityMetrics.collect { metrics ->
                metrics?.let { updateQualityIndicator(it) }
            }
        }
    }
}
```

### 6.3 In-Call Controls

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:2046-2142`

#### 6.3a Mute

```kotlin
private fun toggleMute() {
    isMuted = !isMuted
    VoipLogger.audioRoute(if (isMuted) "MUTED" else "UNMUTED")

    val btnMute = findViewById<ImageButton>(R.id.btnMute)
    btnMute.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)

    if (isMuted) {
        btnMute.setBackgroundResource(R.drawable.circle_button_active_background)
        btnMute.setImageResource(R.drawable.ic_mic_off)
    } else {
        btnMute.setBackgroundResource(R.drawable.circle_button_background)
        btnMute.setImageResource(R.drawable.ic_mic)
    }

    telnyxViewModel.currentCall?.onMuteUnmutePressed()
}
```

#### 6.3b Speaker

```kotlin
private fun toggleSpeaker() {
    isSpeakerOn = !isSpeakerOn
    VoipLogger.audioRoute(if (isSpeakerOn) "SPEAKER" else "EARPIECE")

    val btnSpeaker = findViewById<ImageButton>(R.id.btnSpeaker)
    btnSpeaker.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)

    if (isSpeakerOn) {
        btnSpeaker.setBackgroundResource(R.drawable.circle_button_active_background)
    } else {
        btnSpeaker.setBackgroundResource(R.drawable.circle_button_background)
    }

    // Route audio via AudioManager + SDK
    val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audioManager.isSpeakerphoneOn = isSpeakerOn
    telnyxViewModel.currentCall?.onLoudSpeakerPressed()
}
```

#### 6.3c Hold

```kotlin
private fun toggleHold() {
    val newHoldState = !isOnHold
    VoipLogger.callState(if (newHoldState) "HOLDING" else "ACTIVE", "Hold toggle requested")

    val btnHold = findViewById<ImageButton>(R.id.btnHold)
    btnHold.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)

    if (telnyxViewModel.currentCall == null) {
        Toast.makeText(this, "Unable to change hold state", Toast.LENGTH_SHORT).show()
        return
    }

    telnyxViewModel.holdUnholdCurrentCall(applicationContext)
    isOnHold = newHoldState

    if (isOnHold) {
        btnHold.setBackgroundResource(R.drawable.circle_button_active_background)
        callStatus.text = "On Hold"
        callStatus.setTextColor(resources.getColor(android.R.color.holo_orange_light, null))
    } else {
        btnHold.setBackgroundResource(R.drawable.circle_button_background)
        callStatus.text = "Connected"
        callStatus.setTextColor(resources.getColor(android.R.color.holo_green_light, null))
    }
}
```

#### 6.3d DTMF

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt` (search for sendDtmfDigit)

```kotlin
private fun sendDtmfDigit(digit: String) {
    VoipLogger.d(LOG_COMPONENT, "Sending DTMF digit: $digit")
    telnyxViewModel.currentCall?.dtmfCall(digit)
    dtmfDigitsEntered.append(digit)
    // Update UI to show digit entered
}
```

### 6.4 Call Duration Timer

**File**: `android/app/src/main/java/com/z360/app/voip/CallTimerManager.kt:12-52`

```kotlin
// US-009 FIX: Singleton timer survives activity recreation (config changes)
object CallTimerManager {
    private val _elapsedSeconds = MutableStateFlow<Long>(0)
    val elapsedSeconds: StateFlow<Long> = _elapsedSeconds.asStateFlow()

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    private var timerJob: Job? = null

    @Synchronized
    fun startTimer(callId: String) {
        if (_isRunning.value) {
            VoipLogger.d(LOG_COMPONENT, "Timer already running - canceling old timer")
            stopTimer()
        }

        VoipLogger.d(LOG_COMPONENT, "⏱️ Starting call timer for call: $callId")
        _isRunning.value = true
        _elapsedSeconds.value = 0

        timerJob = CoroutineScope(Dispatchers.Default).launch {
            while (isActive && _isRunning.value) {
                delay(1000)
                _elapsedSeconds.value += 1
                if (_elapsedSeconds.value % 10 == 0L) {
                    VoipLogger.d(LOG_COMPONENT, "⏱️ Call duration: ${_elapsedSeconds.value}s")
                }
            }
        }
    }

    @Synchronized
    fun stopTimer() {
        VoipLogger.d(LOG_COMPONENT, "⏱️ Stopping call timer")
        timerJob?.cancel()
        _isRunning.value = false
        _elapsedSeconds.value = 0
    }
}
```

**ActiveCallActivity observes timer**:
```kotlin
lifecycleScope.launch {
    CallTimerManager.elapsedSeconds.collect { seconds ->
        val minutes = seconds / 60
        val secs = seconds % 60
        val durationText = String.format("%d:%02d", minutes, secs)
        findViewById<TextView>(R.id.callDuration).text = durationText
    }
}
```

---

## 7. STEP 6: CALL ENDS — Hangup Flow

### 7.1 User Hangup

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:2207-2242`

```kotlin
private fun endCall() {
    VoipLogger.callState("ENDING", "User clicked end call")

    // Disable end call button to prevent double-tap
    val btnEndCall = findViewById<Button>(R.id.btnEndCall)
    btnEndCall.isEnabled = false

    // Update status
    val callStatus = findViewById<TextView>(R.id.callStatus)
    callStatus.text = "Ending..."
    callStatus.setTextColor(resources.getColor(android.R.color.holo_orange_light, null))

    // SDK-aligned: End call via TelnyxViewModel
    // DO NOT call finish() immediately - observeCallState() will call finish() when state changes to ENDED
    telnyxViewModel.endCall(applicationContext)

    // Timeout fallback: If SDK doesn't respond within 5s, force finish
    Handler(Looper.getMainLooper()).postDelayed({
        if (!isFinishing) {
            VoipLogger.w(LOG_COMPONENT, "Hangup timeout after 5s, forcing activity finish")
            stopCallTimer()
            releaseProximitySensor()
            AudioDiagnostics.resetAfterCall(applicationContext)
            BluetoothAudioManager.getInstance(applicationContext).onCallEnded()
            callStatePersistence.clearActiveCall()
            finish()
        }
    }, 5000)
}
```

**Sequence**:
1. Disable end call button
2. `telnyxViewModel.endCall()` → SDK sends SIP BYE
3. Wait for `OnCallEnded` event → `observeCallState()` finishes activity
4. Fallback: 5s timeout forces finish if SDK doesn't respond

### 7.2 Remote Hangup

Detected via `TelnyxSocketEvent.OnCallEnded` in `observeCallState()`:

```kotlin
is TelnyxSocketEvent.OnCallEnded -> {
    VoipLogger.d(LOG_COMPONENT, "Call ended, finishing activity")
    if (!isFinishing) {
        Z360Connection.notifyDisconnected()
        stopCallTimer()
        releaseProximitySensor()
        AudioDiagnostics.resetAfterCall(applicationContext)
        BluetoothAudioManager.getInstance(applicationContext).onCallEnded()
        callStatePersistence.clearActiveCall()
        finish()
    }
}
```

### 7.3 Cleanup

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:2183-2205`

```kotlin
private fun endCallInternal() {
    Z360Connection.notifyDisconnected()  // Notify Telecom framework

    // CHECKPOINT: Upload logs to Firebase
    val callDuration = CallTimerManager.elapsedSeconds.value
    VoipLogger.checkpoint("CALL_ENDED", mapOf(
        "call_id" to callSessionId,
        "direction" to if (isOutgoing) "outgoing" else "incoming",
        "caller_number" to callerNumber,
        "duration_seconds" to callDuration.toString()
    ))

    stopCallTimer()
    releaseProximitySensor()

    // US-008 FIX: Reset audio mode and abandon audio focus
    AudioDiagnostics.resetAfterCall(applicationContext)
    BluetoothAudioManager.getInstance(applicationContext).onCallEnded()

    callStatePersistence.clearActiveCall()
    isAudioRoutingActive = false
    finish()
}
```

---

## 8. STEP 7: OUTBOUND CALL — Reverse Flow

### 8.1 Initiate Outbound Call (from Web)

**File**: `resources/js/plugins/use-telnyx-voip.ts` (web calls `TelnyxVoip.makeCall()`)

**File**: `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:6046-6130`

```kotlin
@PluginMethod
fun makeCall(call: PluginCall) {
    val destinationNumber = call.getString("destinationNumber") ?: run {
        call.reject("Missing destinationNumber")
        return
    }

    val callerIdName = call.getString("callerIdName")
    val callerIdNumber = call.getString("callerIdNumber")
    val preferredCodecs = call.getArray("preferredCodecs")?.toList<String>() ?: listOf("opus", "PCMU", "PCMA")

    val profile = ProfileManager.getLoggedProfile(activity.applicationContext)
    if (profile == null || profile.sipUsername.isNullOrEmpty()) {
        call.reject("Not logged in")
        return
    }

    VoipLogger.d(LOG_COMPONENT, "Making outgoing call: dest=$destinationNumber, callerIdName=$callerIdName")

    telnyxViewModel.makeCall(
        viewContext = activity.applicationContext,
        destinationNumber = destinationNumber,
        callerIdName = callerIdName ?: profile.callerIdName ?: "Unknown",
        callerIdNumber = callerIdNumber ?: profile.callerIdNumber ?: "",
        codecPreferences = preferredCodecs
    )

    // Launch ActiveCallActivity for outgoing call
    ActiveCallActivity.start(
        context = activity.applicationContext,
        callerName = destinationNumber,
        callerNumber = destinationNumber,
        callerAvatarUrl = null,
        callSessionId = destinationNumber,  // Will be updated when SDK provides call ID
        isOutgoing = true,
        callConnected = false
    )

    call.resolve()
}
```

### 8.2 Outbound Call UI

`ActiveCallActivity` is launched with `isOutgoing = true`, `callConnected = false`.

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:1394-1396`

```kotlin
// US-016: Start outgoing call setup timeout (30s)
if (isOutgoing && !isCallConnected) {
    startOutgoingCallSetupTimeout()
}
```

**Timeout Cancellation**: When `OnRinging` event fires (remote party is ringing), the timeout is canceled.

**Outgoing Call States**:
1. `CALLING` — Waiting for remote party to ring
2. `OnRinging` → ringback received, cancel timeout
3. `OnCallAnswered` → call connected, start timer

---

## 9. Edge Cases & Error Handling

### 9.1 App Killed / Background

**Cold Start Detection** (`Z360FirebaseMessagingService:1073-1095`):
- Detects cold start when `!firstPushProcessed` and `(notificationStartTime - serviceCreationTime) < 5000ms`
- Logs `pushToNotificationMs` for performance monitoring

**SDK Reconnection** (`ensureTelnyxSdkConnected`):
- Reads stored credentials from `ProfileManager`
- Reconnects SDK with `txPushMetaData` so SDK receives SIP INVITE
- 5s timeout, proceeds with notification if not connected

### 9.2 User Already on Call (US-018)

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:943-985`

```kotlin
val activeCall = TelnyxCommon.getInstance().currentCall
if (activeCall != null) {
    val activeState = activeCall.callStateFlow.value
    val isEnded = activeState is CallState.DONE || activeState is CallState.ERROR || activeState is CallState.DROPPED
    if (!isEnded) {
        VoipLogger.i(LOG_COMPONENT, "📞 BUSY: User already on call - marking incoming as missed")
        VoipAnalytics.logCallMissedBusy(...)
        MissedCallNotificationManager.getInstance(applicationContext).onCallMissedBusy(...)
        return  // Don't show incoming call UI
    }
}
```

**Result**: Incoming call is auto-rejected, missed call notification shown.

### 9.3 Push Order: Telnyx Arrives First

**Handled by PushSynchronizer**:
- Telnyx push creates `CompletableDeferred` and waits up to 500ms
- If Z360 push doesn't arrive, continues with basic caller info from Telnyx metadata
- UI shows "Unknown" or partial info, updates asynchronously when Z360 push arrives via broadcast

### 9.4 Duplicate Push / Re-INVITE After Hangup

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:858-861`

```kotlin
if (!pushMetaData.callerNumber.isNullOrEmpty() && store.wasRecentlyEnded(pushMetaData.callerNumber!!)) {
    VoipLogger.w(LOG_COMPONENT, "🚫 Ignoring re-INVITE from ${pushMetaData.callerNumber} — call was recently ended")
    return
}
```

**File**: `android/app/src/main/java/com/z360/app/voip/Z360VoipStore.kt` (`wasRecentlyEnded`):
- Marks number as ended on hangup, stores timestamp
- 15-second cooldown (default)
- Prevents ghost calls from re-INVITE after user hangs up

### 9.5 Cross-Org Call Failure

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:5034-5049`

```kotlin
if (credentials == null) {
    VoipLogger.e(LOG_COMPONENT, "🔄 FAILED | No credentials returned")
    VoipAnalytics.logCrossOrgCall(..., result = FAILED_API, ...)
    showOrgSwitchError("Failed to switch organization")
    return@launch
}
```

**Error Handling**:
- API failure → Show error toast, reset `isAnswering` flag, allow retry
- Network error → Categorize as `FAILED_NETWORK` in analytics
- Timeout → 10s connect + 10s read timeout

### 9.6 Missing Permissions (US-014)

**Logged Out User** (`Z360FirebaseMessagingService:701-711`):
- Checks `ProfileManager.getLoggedProfile()` for valid SIP credentials
- If no credentials, rejects push silently
- Logs `VoipAnalytics.logPushRejectedLoggedOut()`

**Notification Permissions** (`showIncomingCallNotification`):
- Checks `NotificationManagerCompat.areNotificationsEnabled()`
- Checks `POST_NOTIFICATIONS` permission (Android 13+)
- Checks `canUseFullScreenIntent()` permission (Android 14+)
- Logs warnings if permissions missing

### 9.7 ConnectionService Failure

**File**: `android/app/src/main/java/com/z360/app/voip/Z360ConnectionService.kt:8979-9006`

```kotlin
override fun onCreateIncomingConnectionFailed(...) {
    VoipLogger.e(LOG_COMPONENT, "onCreateIncomingConnectionFailed - falling back to direct notification")

    // Fallback: launch IncomingCallActivity directly without Telecom framework
    IncomingCallActivity.start(...)
}
```

**Fallback Strategy**: If TelecomManager rejects the call, launches `IncomingCallActivity` directly (no lock screen integration).

### 9.8 Answer Timeout

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:4919-4942`

```kotlin
// Wait up to 5s for SDK INVITE
val sdkCall = waitForSdkCall(5000L)
if (sdkCall != null) {
    telnyxViewModel.answerCall(callId = sdkCall.callId, ...)
} else {
    // Timeout — fall back to push answer
    VoipLogger.d(LOG_COMPONENT, "SDK INVITE timeout, falling back to answerIncomingPushCall")
    telnyxViewModel.answerIncomingPushCall(txPushMetaData = pushMetadataJson, ...)
}
```

**Fallback**: Uses push metadata to answer instead of waiting for SDK INVITE.

---

## 10. Key Architectural Patterns

### 10.1 Shared ViewModel Singleton

**File**: `android/app/src/main/java/com/z360/app/voip/TelnyxViewModelProvider.kt:8-28`

```kotlin
object TelnyxViewModelProvider {
    private val viewModelStore = ViewModelStore()

    fun get(context: Context): TelnyxViewModel {
        val factory = TelnyxViewModelFactory(context.applicationContext as Application)
        return ViewModelProvider(viewModelStore, factory)[TelnyxViewModel::class.java]
    }
}
```

**Shared Across**:
- `TelnyxVoipPlugin` (Capacitor bridge)
- `IncomingCallActivity`
- `ActiveCallActivity`
- `Z360FirebaseMessagingService`

**Why**: Activities have independent lifecycles (config changes, process death). A custom `ViewModelStore` ensures all components share the same SDK state.

### 10.2 StateFlow Observation (SDK-Aligned)

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:1412-1490`

Observes:
- `telnyxViewModel.uiState` (TelnyxSocketEvent flow)
- `telnyxViewModel.connectionStatus` (ConnectionStatus flow)
- `telnyxViewModel.callQualityMetrics` (metrics flow)

**Benefits**:
- Survives activity recreation
- Lifecycle-aware via `repeatOnLifecycle(Lifecycle.State.STARTED)`
- Replaces unreliable BroadcastReceivers

### 10.3 Dual-Index Storage (Z360VoipStore)

**File**: `android/app/src/main/java/com/z360/app/voip/Z360VoipStore.kt`

Stores display info with two indices:
1. **By callId**: `call_display_{callId}_caller_name`
2. **By normalized phone**: `call_display_phone_{last10digits}_call_id` → points to callId

**Why**: Z360 and Telnyx may use different call IDs. Phone number is the only stable identifier.

### 10.4 AtomicBoolean for Double-Tap Prevention (BUG-005)

**File**: `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt:4437`

```kotlin
private val isAnswering = AtomicBoolean(false)

findViewById<Button>(R.id.btnAnswer).setOnClickListener {
    if (!isAnswering.compareAndSet(false, true)) {
        return@setOnClickListener  // Already answering, ignore
    }
    answerDirectly()
}
```

**Why**: Multi-core devices can process rapid double-taps through regular boolean checks. `compareAndSet` is atomic.

### 10.5 Mutex for Call State Observer (BUG-007)

**File**: `android/app/src/main/java/com/z360/app/voip/ActiveCallActivity.kt:1497-1515`

```kotlin
private val callStateObserverMutex = Mutex()

private fun observeCurrentCallState() {
    lifecycleScope.launch {
        callStateObserverMutex.withLock {
            val call = telnyxViewModel.currentCall ?: return@withLock
            val callId = call.callId.toString()
            if (observedCallId == callId) return@withLock  // Already observing

            observedCallId = callId
            callStateJob?.cancel()
            callStateJob = lifecycleScope.launch {
                repeatOnLifecycle(Lifecycle.State.STARTED) {
                    call.callStateFlow.collect { callState ->
                        handleCallState(callState)
                    }
                }
            }
        }
    }
}
```

**Why**: If `observeCurrentCallState()` is called rapidly during state flapping, the mutex prevents duplicate observers.

---

## 11. File Reference Index

### 11.1 FCM Package

| File | Lines | Purpose |
|------|-------|---------|
| `fcm/Z360FirebaseMessagingService.kt` | 625-1192 | Central FCM push handler, routes Z360/Telnyx pushes |
| `fcm/PushSynchronizer.kt` | 33-299 | Two-push correlation with CompletableDeferred, 500ms timeout |
| `fcm/TokenHolder.kt` | 267 lines | FCM token lifecycle, retry logic |

### 11.2 VoIP Package

| File | Lines | Purpose |
|------|-------|---------|
| `voip/TelnyxVoipPlugin.kt` | 789 lines | Capacitor bridge, entry point for JS-initiated VoIP operations |
| `voip/Z360ConnectionService.kt` | 162 lines | Self-managed ConnectionService for Telecom framework |
| `voip/Z360Connection.kt` | 212 lines | Individual connection for Z360ConnectionService |
| `voip/IncomingCallActivity.kt` | 925 lines | Full-screen incoming call UI, answer/reject buttons |
| `voip/ActiveCallActivity.kt` | 1387 lines | In-call UI with controls (mute, hold, speaker, DTMF) |
| `voip/Z360VoipStore.kt` | 324 lines | Persists VoIP metadata, dual-index storage |
| `voip/OrgSwitchHelper.kt` | 137 lines | Cross-org credential acquisition |
| `voip/TelnyxViewModelProvider.kt` | 28 lines | Singleton ViewModel provider |
| `voip/CallTimerManager.kt` | 163 lines | Call duration timer (survives config changes) |
| `voip/BluetoothAudioManager.kt` | 422 lines | Bluetooth SCO audio routing |
| `voip/AudioDiagnostics.kt` | 385 lines | Audio focus management (BUG-008 fix) |
| `voip/CallStatePersistence.kt` | 205 lines | Persists call state for crash recovery |
| `voip/CrashRecoveryManager.kt` | 195 lines | Detects abandoned calls from previous session |
| `voip/MissedCallNotificationManager.kt` | 274 lines | Missed call notifications with "Call Back" action |
| `voip/VoipAnalytics.kt` | 847 lines | Firebase Analytics wrapper (25+ VoIP event types) |
| `voip/VoipLogger.kt` | 640 lines | Unified logging (Logcat + file + Crashlytics) |

### 11.3 Key External Dependencies

- **Telnyx SDK**: `telnyx_common` (SDK ViewModel), `ProfileManager` (credential storage)
- **Android Telecom**: `ConnectionService`, `TelecomManager`, `PhoneAccountHandle`
- **Firebase**: `FirebaseMessagingService`, `RemoteMessage`, Analytics, Crashlytics
- **Coroutines**: `CompletableDeferred`, `Mutex`, `StateFlow`, `lifecycleScope`

---

**End of Android Inbound Call Flow Trace**
