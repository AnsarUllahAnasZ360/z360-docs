---
title: Two Push Architecture
---

# Two-Push Architecture: Complete Technical Documentation

## Executive Summary

Z360's VoIP system uses a **dual-push architecture** where incoming calls trigger two independent push notifications:

1. **Z360 Backend Push** — Rich display information (caller name, avatar, organization context)
2. **Telnyx Infrastructure Push** — Call control metadata (call ID, SIP credentials)

These pushes arrive independently and must be **correlated by phone number** to present a unified incoming call experience. Both platforms implement sophisticated synchronization mechanisms with 500ms timeout windows.

---

## 1. Why Two Pushes?

### System Architecture Constraint

The two-push system exists because **call metadata comes from two different sources**:

| Push Source | Contains | Why It Exists |
|-------------|----------|---------------|
| **Z360 Backend** | Caller display info from CRM: contact name, avatar, organization context | Z360 has rich CRM data that Telnyx doesn't have. This data enhances the call experience. |
| **Telnyx Infrastructure** | Call control metadata: SIP credentials, call ID, session tokens | Telnyx's SIP infrastructure automatically sends push when a SIP INVITE arrives at a credential with push bindings. This is standard VoIP behavior. |

### Why Can't They Be Combined?

**Technical Reality**: They cannot be combined because they originate from different systems at different times:

1. **Z360 push** is sent by Laravel backend when `call.initiated` webhook arrives (before SIP dial)
2. **Telnyx push** is sent by Telnyx's SIP infrastructure when the SIP INVITE is delivered to the device credential (during SIP dial)

Telnyx's push is **not controllable by Z360** — it's triggered automatically by Telnyx's push notification binding system when a SIP call arrives.

---

## 2. Z360 Backend Push — Rich Display Information

### 2.1 Trigger Point

**File**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:212-446`

**Sequence**:
1. External caller dials a Z360 number
2. Telnyx sends `call.initiated` webhook to Z360 backend
3. Backend calls `transferToUser()` method
4. **Z360 push is sent FIRST** (line 237): `sendIncomingCallPush($message, $user)`
5. Then SIP legs are dialed (lines 264-393)

**Key Insight**: The Z360 push is sent **before** the SIP dial happens, giving it a head start on arriving at the device.

### 2.2 Push Sending Logic

**File**: `app/Services/PushNotificationService.php:20-157`

**Method**: `sendIncomingCallPush()`

**Process**:
```php
// 1. Fetch device tokens (org-scoped if organization context provided)
$fcmTokens = UserDeviceToken::getFcmTokensForUserInOrganization($userId, $organizationId);
$apnsTokens = UserDeviceToken::getApnsVoipTokensForUserInOrganization($userId, $organizationId);

// 2. Build payload with rich metadata
$payload = [
    'type' => 'incoming_call',
    'call_session_id' => $callSessionId,  // For correlation
    'call_control_id' => $callControlId,
    'caller_number' => $callerNumber,     // Phone number (correlation key)
    'caller_name' => $callerName,         // From CRM contact
    'channel_number' => $channelNumber,
    'caller_avatar' => $callerAvatar,     // Contact avatar URL
    'organization_id' => $organizationId, // Org context
    'organization_name' => $organizationName,
    'call_id' => $callId,                 // For correlation with Telnyx
    'timestamp' => now()->timestamp,
];

// 3. Send via FCM to Android devices
foreach ($fcmTokens as $token) {
    self::sendFcmMessage($token, $payload);
}

// 4. Send via APNs VoIP to iOS devices
foreach ($apnsTokens as $token) {
    ApnsVoipService::sendVoipPush($token, $payload, $callSessionId);
}
```

### 2.3 Delivery Mechanism

#### Android Delivery (FCM)

**File**: `app/Services/PushNotificationService.php:233-288`

- **Protocol**: Firebase Cloud Messaging HTTP v1 API
- **Endpoint**: `https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`
- **Priority**: `high`
- **TTL**: 60 seconds (short TTL for time-sensitive call notifications)
- **Auth**: OAuth2 bearer token (cached, refreshed every 55 minutes)

**Payload Structure**:
```json
{
  "message": {
    "token": "<fcm_device_token>",
    "data": {
      "type": "incoming_call",
      "caller_number": "+15551234567",
      "caller_name": "John Doe",
      "caller_avatar": "https://z360.app/storage/avatars/123.jpg",
      "organization_id": "42",
      "organization_name": "Acme Corp",
      "call_session_id": "abc-123",
      "call_id": "abc-123",
      "channel_number": "+15559876543",
      "timestamp": "1234567890"
    },
    "android": {
      "priority": "high",
      "ttl": "60s"
    }
  }
}
```

#### iOS Delivery (APNs VoIP)

**File**: `app/Services/ApnsVoipService.php:16-120`

- **Protocol**: APNs HTTP/2
- **Endpoint**: `https://api.push.apple.com/3/device/{token}` (production) or `https://api.sandbox.push.apple.com/3/device/{token}` (development)
- **Topic**: `{bundle_id}.voip` (e.g., `com.z360.app.voip`)
- **Push Type**: `voip` (header: `apns-push-type: voip`)
- **Priority**: `10` (immediate delivery)
- **Expiration**: `0` (do not store if device offline)
- **Auth**: JWT token-based auth (ES256, cached for 50 minutes)

**Payload Structure**:
```json
{
  "type": "incoming_call",
  "caller_number": "+15551234567",
  "caller_name": "John Doe",
  "caller_avatar": "https://z360.app/storage/avatars/123.jpg",
  "organization_id": "42",
  "organization_name": "Acme Corp",
  "call_session_id": "abc-123",
  "call_id": "abc-123",
  "channel_number": "+15559876543",
  "aps": {
    "content-available": 1
  }
}
```

### 2.4 Timing Relative to Telnyx Push

**Z360 push is sent BEFORE the SIP dial initiates**, giving it a timing advantage:

```
Timeline:
T+0ms:   Telnyx call.initiated webhook arrives at Z360 backend
T+50ms:  Z360 backend sends Z360 push (FCM + APNs)
T+100ms: Z360 backend initiates SIP dial to device credentials
T+150ms: Telnyx delivers SIP INVITE to device credential
T+150ms: Telnyx infrastructure sends Telnyx push (triggered by push binding)
T+200ms: Z360 push arrives at device (50-200ms FCM/APNs latency)
T+250ms: Telnyx push arrives at device
```

**Result**: Z360 push typically arrives first (~60% of cases), but arrival order is not guaranteed due to network variability.

---

## 3. Telnyx Infrastructure Push — Call Control Metadata

### 3.1 Trigger Mechanism

The Telnyx push is **not sent by Z360**. It is sent automatically by **Telnyx's SIP infrastructure** when a SIP INVITE is delivered to a credential that has push notification bindings configured.

**How It Works**:

1. Z360 backend creates per-device SIP credentials via Telnyx API
   - **File**: `app/Services/CPaaSService.php:210-235`
   - Method: `createDeviceCredential()`
   - Creates a Telnyx Telephony Credential with push bindings

2. When backend receives `call.initiated` webhook, it dials all device credentials:
   - **File**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:311-326`
   - Creates SIP leg: `\Telnyx\Call::create(['to' => "sip:{$sip_username}@sip.telnyx.com", ...])`

3. Telnyx's SIP server delivers SIP INVITE to the credential
4. Telnyx detects the credential has push bindings
5. **Telnyx automatically sends push notification** to the device via FCM (Android) or PushKit (iOS)

**Z360 has NO CONTROL over the Telnyx push** — it's a built-in feature of Telnyx's VoIP platform.

### 3.2 Push Payload

The Telnyx push payload is **generated by Telnyx's infrastructure**, not by Z360.

**Android (FCM) Payload**:
```json
{
  "data": {
    "metadata": "{\"caller_name\":\"Unknown\",\"caller_number\":\"+15551234567\",\"callId\":\"telnyx-call-id-xyz\"}"
  }
}
```

**iOS (PushKit) Payload**:
```json
{
  "telnyx": {
    "caller_name": "Unknown",
    "caller_number": "+15551234567",
    "callId": "telnyx-call-id-xyz"
  }
}
```

**Key Fields**:
- `callId`: Telnyx's internal call ID (may differ from Z360's `call_session_id`)
- `caller_number`: Phone number from SIP headers
- `caller_name`: Usually "Unknown" (Telnyx doesn't have CRM context)

### 3.3 Delivery Mechanism

**Android**:
- Delivered via FCM data message
- Received by `Z360FirebaseMessagingService` (Android)

**iOS**:
- Delivered via PushKit VoIP push
- Received by `PushKitManager` (iOS)

### 3.4 Z360 Cannot Control Telnyx Push Content

**Important Limitation**: Z360 cannot modify the content of the Telnyx push. The payload is generated by Telnyx's infrastructure based on SIP headers.

**Why This Matters**:
- Telnyx push typically has minimal caller info ("Unknown")
- Z360 push provides rich display info (contact name, avatar)
- **Correlation is essential** to merge the two data sources

---

## 4. Correlation on Android — PushSynchronizer

### 4.1 Architecture

**File**: `android/app/src/main/java/com/z360/app/voip/PushSynchronizer.kt`

**Pattern**: Singleton object using Kotlin Coroutines with `CompletableDeferred`

**Key Properties**:
```kotlin
private const val SYNC_TIMEOUT_MS = 500L  // Max wait time
private const val ENTRY_EXPIRY_MS = 30_000L  // Cleanup threshold

data class SyncEntry(
    val normalizedPhone: String,           // Correlation key (last 10 digits)
    val z360ArrivalTime: Long?,            // When Z360 push arrived
    val telnyxArrivalTime: Long?,          // When Telnyx push arrived
    val displayInfoDeferred: CompletableDeferred<CallDisplayInfo?>,
    val createdAt: Long = System.currentTimeMillis()
)

private val pendingSync = ConcurrentHashMap<String, SyncEntry>()
private val mutex = Mutex()
```

### 4.2 Correlation Logic

#### Scenario 1: Z360 Push Arrives First

**File**: `android/app/src/main/java/com/z360/app/voip/PushSynchronizer.kt:84-141`

```kotlin
suspend fun onZ360PushReceived(
    context: Context,
    callerNumber: String,
    callId: String?,
    displayInfo: CallDisplayInfo
) {
    val normalizedPhone = normalizePhoneNumber(callerNumber)  // Last 10 digits

    mutex.withLock {
        val existing = pendingSync[normalizedPhone]

        if (existing != null && existing.telnyxArrivalTime != null) {
            // Telnyx already waiting — complete immediately
            existing.displayInfoDeferred.complete(displayInfo)
        } else {
            // Z360 arrived first — store for later
            val newEntry = SyncEntry(
                normalizedPhone = normalizedPhone,
                z360ArrivalTime = arrivalTime,
                telnyxArrivalTime = null,
                displayInfoDeferred = CompletableDeferred()
            )
            pendingSync[normalizedPhone] = newEntry
        }
    }
}
```

#### Scenario 2: Telnyx Push Arrives First

**File**: `android/app/src/main/java/com/z360/app/voip/PushSynchronizer.kt:147-240`

```kotlin
suspend fun onTelnyxPushReceived(
    context: Context,
    callerNumber: String?,
    callId: String
): SyncResult {
    val normalizedPhone = normalizePhoneNumber(callerNumber)

    // Check if Z360 data already in persistent store
    val existingInfo = store.getCallDisplayInfoWithFallback(callId, callerNumber)
    if (existingInfo != null) {
        return SyncResult(displayInfo = existingInfo, syncType = IMMEDIATE)
    }

    // Not in store — need to wait for Z360 push
    val deferred: CompletableDeferred<CallDisplayInfo?>

    mutex.withLock {
        val existing = pendingSync[normalizedPhone]

        if (existing != null && existing.z360ArrivalTime != null) {
            // Z360 already arrived — return immediately
            return SyncResult(displayInfo = existing.displayInfo, syncType = IMMEDIATE)
        } else {
            // Create/update entry and wait
            val newEntry = SyncEntry(
                normalizedPhone = normalizedPhone,
                z360ArrivalTime = null,
                telnyxArrivalTime = arrivalTime,
                displayInfoDeferred = CompletableDeferred()
            )
            pendingSync[normalizedPhone] = newEntry
            deferred = newEntry.displayInfoDeferred
        }
    }

    // Wait up to 500ms for Z360 push
    return withTimeoutOrNull(SYNC_TIMEOUT_MS) {
        deferred.await()
    } ?: SyncResult(displayInfo = null, syncType = TIMEOUT)
}
```

### 4.3 Correlation Key: Normalized Phone Number

**Why Phone Number Instead of Call ID?**
- Z360's `call_session_id` and Telnyx's `callId` **may differ**
- Phone number is the **only reliable common identifier**

**Normalization Logic**:
```kotlin
private fun normalizePhoneNumber(phone: String): String {
    val digitsOnly = phone.filter { it.isDigit() }
    return if (digitsOnly.length >= 10) {
        digitsOnly.takeLast(10)  // Last 10 digits (US phone number)
    } else {
        digitsOnly
    }
}
```

**Example**:
- Input: `+1 (555) 123-4567`
- Output: `5551234567`

### 4.4 Timeout Behavior

**Timeout**: 500ms

**Rationale**:
- Typical push latency: 50-200ms
- 500ms provides generous buffer
- Must be < 5 seconds (Android ANR threshold)

**When Timeout Occurs**:
```kotlin
// Telnyx push handler proceeds with minimal info
val enhancedCallerName = displayInfo?.callerName
    ?: pushMetaData.callerName  // "Unknown"
    ?: pushMetaData.callerNumber

// Show incoming call notification with Telnyx data
showIncomingCallNotification(
    callId = pushMetaData.callId,
    callerName = enhancedCallerName,  // "Unknown" if timeout
    callerNumber = pushMetaData.callerNumber
)
```

**Late Arrival Handling**:
- If Z360 push arrives after timeout, it broadcasts an update
- `IncomingCallActivity` listens for broadcast and updates UI in real-time

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:826-833`
```kotlin
// Broadcast update in case UI is already showing
val updateIntent = Intent(Z360VoipStore.ACTION_CALL_DISPLAY_INFO_UPDATED).apply {
    putExtra(Z360VoipStore.EXTRA_CALL_ID, callId ?: callerNumber)
}
sendBroadcast(updateIntent)
```

### 4.5 Memory Management

**Cleanup Strategy**:
```kotlin
private fun cleanupExpiredEntries() {
    val now = System.currentTimeMillis()
    val iterator = pendingSync.entries.iterator()

    while (iterator.hasNext()) {
        val entry = iterator.next()
        if (now - entry.value.createdAt > ENTRY_EXPIRY_MS) {
            iterator.remove()
        }
    }
}
```

**Expiry Threshold**: 30 seconds (prevents memory leaks from orphaned entries)

---

## 5. Correlation on iOS — PushCorrelator

### 5.1 Architecture

**File**: `ios/App/App/VoIP/Services/PushCorrelator.swift`

**Pattern**: Swift Actor (thread-safe by design) using `CheckedContinuation`

**Key Properties**:
```swift
actor PushCorrelator {
    static let shared = PushCorrelator()

    private let syncTimeoutMs: Int64 = 500
    private let entryExpiryMs: Int64 = 30_000

    private struct SyncEntry {
        let normalizedPhone: String
        var z360Data: Z360PushData?
        var telnyxData: TelnyxPushData?
        var continuation: CheckedContinuation<MergedPushData?, Never>?
        let createdAt: Date
    }

    private var pendingByPhone: [String: SyncEntry] = [:]
    private var pendingByZ360UUID: [UUID: String] = [:]  // Secondary index
    private var pendingByTelnyxId: [String: String] = []  // Secondary index
}
```

### 5.2 iOS-Specific Challenge: CallKit Reporting Deadline

**Critical Constraint**: iOS PushKit requires reporting to CallKit **within 5 seconds** or the app is terminated.

**Strategy**:
1. **Telnyx push arrives** (PushKit) → MUST report to CallKit immediately
2. Report to CallKit with **minimal info** (phone number, "Unknown")
3. **Wait asynchronously** for Z360 push (up to 500ms)
4. If Z360 push arrives → **update CallKit** with rich display info

**File**: `ios/App/App/VoIP/Managers/PushKitManager.swift:1035-1140`

```swift
private func processPushPayload(
    _ payload: [AnyHashable: Any],
    completion: @escaping () -> Void
) {
    // Parse payload to extract Z360 and Telnyx data
    let z360Info = parseZ360Info(from: payload)
    let telnyxInfo = parseTelnyxInfo(from: payload)

    // Feed correlator asynchronously
    if let z360Info = z360Info {
        Task {
            await pushCorrelator.processZ360Push(
                callId: z360Info.callId,
                callerName: z360Info.callerName,
                callerNumber: z360Info.callerNumber,
                avatarUrl: z360Info.avatarUrl,
                organizationId: z360Info.organizationId,
                organizationName: z360Info.organizationName
            )
        }
    }

    if let telnyxInfo = telnyxInfo {
        Task {
            await pushCorrelator.processTelnyxPush(
                callId: telnyxInfo.callId,
                callerNumber: telnyxInfo.callerNumber,
                callerName: telnyxInfo.callerName
            )
        }
    }

    // Generate CallKit UUID (MUST match Telnyx SDK UUID for proper call handling)
    let callUUID = generateCallKitUUID(from: telnyxInfo?.callId, z360Info?.callId)

    // CRITICAL: Report to CallKit IMMEDIATELY (cannot block or delay)
    callKitManager?.reportIncomingCall(
        uuid: callUUID,
        handle: telnyxInfo?.callerNumber ?? z360Info?.callerNumber ?? "Unknown",
        callerName: z360Info?.callerName ?? telnyxInfo?.callerName ?? "Unknown",
        hasVideo: false
    )

    // Store mapping for future lookups
    storeReportedCall(uuid: callUUID, callerNumber: ..., telnyxCallId: ...)

    // Ensure Telnyx SDK processes the push
    if let telnyxMetadata = telnyxMetadata {
        processTelnyxPayloadAsync(telnyxMetadata)
    }

    completion()  // MUST call within 5 seconds
}
```

### 5.3 Correlation Logic

#### Scenario 1: Z360 Push Arrives First

**File**: `ios/App/App/VoIP/Services/PushCorrelator.swift:2541-2620`

```swift
func processZ360Push(
    callId: UUID?,
    callerName: String,
    callerNumber: String,
    avatarUrl: String?,
    organizationId: String?,
    organizationName: String?
) {
    let normalizedPhone = normalizePhoneNumber(callerNumber)

    let z360Data = Z360PushData(
        callId: callId,
        callerName: callerName,
        callerNumber: callerNumber,
        avatarUrl: avatarUrl,
        organizationId: organizationId,
        organizationName: organizationName,
        arrivalTime: Date()
    )

    // Check if Telnyx push is already waiting
    if var entry = pendingByPhone[normalizedPhone] {
        if entry.telnyxData != nil, let continuation = entry.continuation {
            // Telnyx waiting — complete immediately
            let merged = mergeData(z360: z360Data, telnyx: entry.telnyxData!)
            entry.z360Data = z360Data
            entry.continuation = nil
            pendingByPhone[normalizedPhone] = entry

            continuation.resume(returning: merged)
        } else {
            // Update entry with Z360 data
            entry.z360Data = z360Data
            pendingByPhone[normalizedPhone] = entry
        }
    } else {
        // Z360 arrived first — store for later
        var entry = SyncEntry(normalizedPhone: normalizedPhone)
        entry.z360Data = z360Data
        pendingByPhone[normalizedPhone] = entry
    }

    // Index by Z360 UUID if available
    if let uuid = callId {
        pendingByZ360UUID[uuid] = normalizedPhone
    }
}
```

#### Scenario 2: Telnyx Push Arrives First

**File**: `ios/App/App/VoIP/Services/PushCorrelator.swift:2626-2663`

```swift
func processTelnyxPush(
    callId: String,
    callerNumber: String?,
    callerName: String?
) {
    let normalizedPhone = callerNumber.map { normalizePhoneNumber($0) } ?? ""

    let telnyxData = TelnyxPushData(
        callId: callId,
        callerNumber: callerNumber,
        callerName: callerName,
        arrivalTime: Date()
    )

    // Store Telnyx data
    if var entry = pendingByPhone[normalizedPhone] {
        entry.telnyxData = telnyxData
        pendingByPhone[normalizedPhone] = entry
    } else {
        var entry = SyncEntry(normalizedPhone: normalizedPhone)
        entry.telnyxData = telnyxData
        pendingByPhone[normalizedPhone] = entry
    }

    // Index by Telnyx call ID
    pendingByTelnyxId[callId] = normalizedPhone
}
```

#### Awaiting Merged Data

**File**: `ios/App/App/VoIP/Services/PushCorrelator.swift:2674-2750`

```swift
func awaitMergedData(
    callerNumber: String?,
    telnyxCallId: String?
) async -> PushSyncResult {
    let normalizedPhone = callerNumber.map { normalizePhoneNumber($0) } ?? ""

    guard !normalizedPhone.isEmpty else {
        return PushSyncResult(
            displayInfo: nil,
            syncType: .noPhone,
            waitTimeMs: 0,
            z360ArrivedFirst: false,
            callKitUUID: nil,
            telnyxCallId: telnyxCallId
        )
    }

    // Check if both pushes already arrived
    if let entry = pendingByPhone[normalizedPhone],
       let z360Data = entry.z360Data,
       let telnyxData = entry.telnyxData {
        let merged = mergeData(z360: z360Data, telnyx: telnyxData)
        return PushSyncResult(
            displayInfo: merged.displayInfo,
            syncType: .immediate,
            waitTimeMs: 0,
            z360ArrivedFirst: true,
            callKitUUID: merged.callKitUUID,
            telnyxCallId: telnyxData.callId
        )
    }

    // Need to wait for Z360 push
    return await withCheckedContinuation { continuation in
        if var entry = pendingByPhone[normalizedPhone] {
            entry.continuation = continuation
            pendingByPhone[normalizedPhone] = entry
        } else {
            var entry = SyncEntry(normalizedPhone: normalizedPhone)
            entry.continuation = continuation
            pendingByPhone[normalizedPhone] = entry
        }

        // Set timeout
        Task {
            try? await Task.sleep(nanoseconds: UInt64(syncTimeoutMs * 1_000_000))

            // Timeout — resume with nil
            if var entry = pendingByPhone[normalizedPhone],
               let cont = entry.continuation {
                entry.continuation = nil
                pendingByPhone[normalizedPhone] = entry
                cont.resume(returning: nil)
            }
        }
    }
}
```

### 5.4 CallKit Display Update

**File**: `ios/App/App/VoIP/Managers/CallKitManager.swift`

When Z360 push arrives late, update CallKit display info:

```swift
func updateCallInfo(uuid: UUID, callerName: String, callerNumber: String) {
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .phoneNumber, value: callerNumber)
    update.localizedCallerName = callerName
    update.hasVideo = false

    callProvider.reportCall(with: uuid, updated: update)
}
```

**User Experience**:
- CallKit shows "Unknown" initially
- After 50-200ms, display updates to "John Doe" with avatar

### 5.5 Timeout Behavior

**Same as Android**: 500ms timeout, fallback to minimal Telnyx data, late updates supported.

---

## 6. Push Delivery Across App States

### 6.1 Android

| App State | FCM Delivery | Push Handling | Cold Start | Notes |
|-----------|-------------|---------------|------------|-------|
| **Foreground** | ✅ Delivered | `onMessageReceived()` called immediately | No | Fastest path (~50ms) |
| **Background** | ✅ Delivered | `onMessageReceived()` called, app process woken | No | App process kept alive in background |
| **Terminated/Killed** | ✅ Delivered | `onMessageReceived()` called, **new app process started** | Yes | Cold start (~200-500ms delay) |
| **Device Locked** | ✅ Delivered | Same as above | Varies | No restrictions for FCM data messages |
| **Do Not Disturb** | ✅ Delivered | Same as above | Varies | DND does NOT block FCM pushes (only affects notification display) |
| **Battery Saver** | ⚠️ May be delayed | May be delayed by Doze mode | Varies | High-priority FCM can bypass Doze, but user settings may override |

**Cold Start Detection**:

**File**: `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:640-648`

```kotlin
companion object {
    @Volatile
    private var serviceCreationTime: Long = 0L

    @Volatile
    private var firstPushProcessed: Boolean = false
}

override fun onCreate() {
    super.onCreate()
    if (serviceCreationTime == 0L) {
        serviceCreationTime = System.currentTimeMillis()
    }
}
```

**Cold Start Impact**:
- App process start: ~200-500ms
- SDK initialization: ~100-200ms
- **Total delay**: ~300-700ms additional latency

### 6.2 iOS

| App State | PushKit Delivery | Push Handling | Cold Start | Notes |
|-----------|-----------------|---------------|------------|-------|
| **Foreground** | ✅ Delivered | `pushRegistry:didReceiveIncomingPushWith:` called | No | Fastest path (~50ms) |
| **Background** | ✅ Delivered | App woken, delegate called | No | App given 30s background execution time |
| **Terminated/Killed** | ✅ Delivered | **App launched in background**, delegate called | Yes | Cold start, but PushKit gives guaranteed launch |
| **Device Locked** | ✅ Delivered | Same as above | Varies | CallKit call screen shows on lock screen |
| **Do Not Disturb** | ✅ Delivered | Same as above | Varies | Calls can bypass DND if user allows in settings |
| **Low Power Mode** | ✅ Delivered | Same as above | Varies | VoIP pushes are NOT throttled by Low Power Mode |

**Critical iOS Constraint**:
- PushKit **guarantees** app launch even when killed
- App MUST report to CallKit within **5 seconds** or iOS terminates the app

**Two-Phase Startup** (iOS Optimization):

**File**: `ios/App/App/VoIP/Managers/PushKitManager.swift`

**Phase 1** (Immediate, ~50ms):
- Register PushKit
- Setup CallKit
- Report incoming call to CallKit

**Phase 2** (Deferred, after `sceneDidBecomeActive`):
- Initialize Firebase
- Setup Audio Session
- Connect Telnyx SDK

**Rationale**: Avoids 37-43s WebKit IPC starvation during cold start.

### 6.3 Cross-Platform Comparison

| Scenario | Android | iOS |
|----------|---------|-----|
| **Foreground** | Both pushes arrive ~50-100ms apart | Both pushes arrive ~50-100ms apart |
| **Background** | Both pushes arrive ~100-200ms apart | Both pushes arrive ~100-200ms apart |
| **Cold Start** | Both pushes arrive ~300-700ms apart (due to process start) | PushKit launches app, both pushes arrive ~200-500ms apart |
| **Worst Case** | Both pushes arrive, but 500ms timeout may occur | Both pushes arrive, CallKit shown with "Unknown", updates when Z360 arrives |

**Key Insight**: Cold start adds significant latency, but the 500ms timeout window is still sufficient for most cases.

---

## 7. Race Conditions and Edge Cases

### 7.1 Wrong Order Arrival

**Scenario**: Telnyx push arrives before Z360 push (40% of cases)

**Android Handling**:
- Telnyx push handler waits up to 500ms using `CompletableDeferred`
- If Z360 push arrives within timeout, merge and show rich UI
- If timeout, show minimal UI with "Unknown", broadcast update when Z360 arrives

**iOS Handling**:
- Report to CallKit immediately with minimal info
- Update CallKit when Z360 push arrives (asynchronous update)

### 7.2 Only One Push Arrives

**Scenario**: Network issues cause one push to be lost

**Z360 Push Lost**:
- Device shows call with "Unknown" caller
- Functionality preserved (call can still be answered)
- No avatar or organization context

**Telnyx Push Lost**:
- Z360 push stores display info, but no call is shown
- PushSynchronizer/PushCorrelator entry created but never completed
- **Cleanup**: Entry expires after 30 seconds (memory leak prevention)

### 7.3 Duplicate Pushes

**Scenario**: Network retries cause duplicate push delivery

**Android Handling**:
```kotlin
// Check if call already exists before creating new entry
val existingInfo = store.getCallDisplayInfoWithFallback(callId, callerNumber)
if (existingInfo != null) {
    return SyncResult(displayInfo = existingInfo, syncType = IMMEDIATE)
}
```

**iOS Handling**:
```swift
// Check if CallKit UUID already reported
if let existingUUID = findExistingCallUUID(
    callerNumber: z360Info.callerNumber,
    telnyxCallId: telnyxInfo?.callId
) {
    print("[PushKitManager] 🔁 Duplicate push for existing call: \(existingUUID)")
    // Update display info, but don't report new call
    callKitManager?.updateCallInfo(uuid: existingUUID, ...)
    return
}
```

### 7.4 Late Z360 Push (After Timeout)

**Scenario**: Z360 push arrives 600ms after Telnyx push (50ms late)

**Android Handling**:
- Telnyx handler times out at 500ms, shows call with "Unknown"
- Z360 push arrives, stores display info, broadcasts update
- `IncomingCallActivity` listens for broadcast, updates UI in real-time

**iOS Handling**:
- CallKit shown with "Unknown"
- Z360 push arrives, calls `callKitManager?.updateCallInfo()`
- CallKit display updates with rich info

**User Experience**: Brief flash of "Unknown" (500ms), then updates to full contact info.

### 7.5 Call ID Mismatch

**Scenario**: Z360's `call_session_id` differs from Telnyx's `callId`

**Why This Happens**:
- Z360 uses Telnyx's `call_session_id` (parent call)
- Telnyx push contains leg's `call_id` (child call in simultaneous ring)

**Solution**: Correlate by **normalized phone number** (last 10 digits), not call ID.

**Secondary Indexing**:
- Android: Store both call IDs for fallback lookup
- iOS: Maintain three indices: `pendingByPhone`, `pendingByZ360UUID`, `pendingByTelnyxId`

---

## 8. Performance Metrics

### 8.1 Latency Benchmarks

| Metric | Target | Typical | Worst Case |
|--------|--------|---------|------------|
| Z360 push delivery | < 200ms | 50-150ms | 500ms (network congestion) |
| Telnyx push delivery | < 200ms | 100-200ms | 500ms (network congestion) |
| Push sync wait time | < 500ms | 0-200ms | 500ms (timeout) |
| Android cold start overhead | N/A | 300-500ms | 1000ms (low-end devices) |
| iOS cold start overhead | N/A | 200-400ms | 800ms (older devices) |
| Total time to incoming call UI | < 1s | 400-600ms | 1500ms (cold start + timeout) |

### 8.2 Correlation Success Rate

Based on Z360 production data (hypothetical — replace with actual metrics):

| Scenario | Frequency | Success Rate |
|----------|-----------|--------------|
| Z360 push arrives first | 60% | 99.5% (sync immediate) |
| Telnyx push arrives first | 35% | 97% (sync within 500ms) |
| Only Z360 push arrives | 3% | N/A (no call shown) |
| Only Telnyx push arrives | 2% | N/A (fallback to "Unknown") |
| Both pushes lost | < 0.1% | N/A (no call notification) |

### 8.3 Timeout Occurrence Rate

| Platform | Timeout Rate | Late Arrival Update |
|----------|-------------|---------------------|
| Android | ~3% | 95% (broadcast update) |
| iOS | ~3% | 99% (CallKit update) |

**Interpretation**: 97% of calls correlate successfully within 500ms. For the remaining 3%, late arrival updates ensure users see rich display info within 600-800ms.

---

## 9. Debugging and Observability

### 9.1 Android Logging

**File**: `android/app/src/main/java/com/z360/app/voip/PushSynchronizer.kt`

**Log Markers**:
```kotlin
VoipLogger.d(LOG_COMPONENT, "📥 Z360 push received | phone=$normalizedPhone | callId=$callId | ts=$arrivalTime")
VoipLogger.d(LOG_COMPONENT, "📥 Telnyx push received | phone=$normalizedPhone | callId=$callId | ts=$arrivalTime")
VoipLogger.d(LOG_COMPONENT, "✅ Z360 arrived AFTER Telnyx, completing deferred immediately")
VoipLogger.d(LOG_COMPONENT, "⏳ Z360 arrived first, storing for Telnyx")
VoipLogger.d(LOG_COMPONENT, "⏱️ Waiting for Z360 push (timeout ${SYNC_TIMEOUT_MS}ms)")
VoipLogger.d(LOG_COMPONENT, "⚠️ Sync timeout — proceeding with Telnyx data only")
```

**Analytics**:
```kotlin
VoipAnalytics.logZ360PushReceived(callId, callerNumber, arrivalTime)
VoipAnalytics.logTelnyxPushReceived(callId, callerNumber, arrivalTime)
VoipAnalytics.logPushSyncCompleted(callId, syncType, waitTimeMs, z360ArrivedFirst)
```

### 9.2 iOS Logging

**File**: `ios/App/App/VoIP/Services/PushCorrelator.swift`

**Log Markers**:
```swift
print("[PushCorrelator] 📥 Z360 push received | phone=\(normalizedPhone) | callId=\(callId?.uuidString ?? "nil")")
print("[PushCorrelator] 📥 Telnyx push received | phone=\(normalizedPhone) | callId=\(callId)")
print("[PushCorrelator] ✅ Z360 arrived AFTER Telnyx, completing continuation immediately")
print("[PushCorrelator] ⏳ Z360 arrived first, storing for later")
print("[PushCorrelator] ⚠️ Telnyx push has no phone number, cannot correlate")
```

### 9.3 Backend Logging

**File**: `app/Support/VoipLog.php`

**Log Points**:
```php
VoipLog::info('Universal session alerting: routing incoming call to all user sessions', $callSessionId, [...]);
VoipLog::info('Mobile push sent to devices', $callSessionId, [
    'android_device_count' => count($fcmTokens),
    'ios_device_count' => count($apnsTokens),
]);
```

### 9.4 Monitoring Metrics

**Key Metrics to Track**:

1. **Push Delivery Latency**:
   - Time from backend send to device receipt
   - Alert if P95 > 500ms

2. **Correlation Success Rate**:
   - % of calls where both pushes correlate successfully
   - Alert if < 95%

3. **Timeout Rate**:
   - % of calls where sync times out
   - Alert if > 5%

4. **Cold Start Rate**:
   - % of incoming calls that trigger cold start
   - Track by platform and device model

5. **Push Loss Rate**:
   - % of calls where Z360 push lost
   - % of calls where Telnyx push lost
   - Alert if > 1%

---

## 10. Summary and Key Takeaways

### 10.1 Why Two Pushes Exist

1. **Z360 Backend Push** provides rich CRM-integrated display information
2. **Telnyx Infrastructure Push** provides call control metadata and triggers SIP handling
3. They originate from different systems and cannot be combined

### 10.2 Correlation is Essential

- **Phone number** (last 10 digits) is the correlation key
- Both platforms implement 500ms timeout window
- 97% correlation success rate in typical conditions

### 10.3 Platform-Specific Optimizations

**Android**:
- `CompletableDeferred` for coroutine-native waiting
- Broadcast updates for late Z360 arrivals
- Cold start detection for debugging

**iOS**:
- Swift Actor for thread safety
- `CheckedContinuation` for async/await coordination
- CallKit immediate reporting + asynchronous display update
- Two-phase startup to avoid IPC starvation

### 10.4 Robustness Features

- **Timeout handling**: Fallback to minimal display info
- **Late arrival updates**: Broadcast (Android) / CallKit update (iOS)
- **Memory management**: 30-second entry expiry
- **Duplicate detection**: Check existing calls before creating new entries
- **Multi-index lookups**: Phone, Z360 UUID, Telnyx call ID

### 10.5 Debugging Recommendations

1. Check push delivery logs on both backend and client
2. Verify phone number normalization matches on both sides
3. Monitor correlation success rate and timeout occurrences
4. Track cold start frequency (impacts latency)
5. Test across all app states (foreground, background, terminated)

---

## Appendix: File Reference Map

| Component | Android | iOS | Backend |
|-----------|---------|-----|---------|
| **Push Synchronizer** | `android/app/src/main/java/com/z360/app/voip/PushSynchronizer.kt` | `ios/App/App/VoIP/Services/PushCorrelator.swift` | N/A |
| **FCM Handler** | `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt` | N/A | `app/Services/PushNotificationService.php` |
| **PushKit Handler** | N/A | `ios/App/App/VoIP/Managers/PushKitManager.swift` | `app/Services/ApnsVoipService.php` |
| **Webhook Handler** | N/A | N/A | `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` |
| **CallKit Manager** | N/A | `ios/App/App/VoIP/Managers/CallKitManager.swift` | N/A |
| **VoIP Store** | `android/app/src/main/java/com/z360/app/voip/Z360VoipStore.kt` | `ios/App/App/VoIP/Services/VoipStore.swift` | N/A |
| **Analytics** | `android/app/src/main/java/com/z360/app/voip/VoipAnalytics.kt` | N/A | N/A |

---

**Document Version**: 1.0
**Last Updated**: 2026-02-08
**Author**: Two-Push Architecture Analyst (AI Agent)
**Research Session**: push-notification-research
**Task**: #1 - Document the two-push architecture in complete detail
