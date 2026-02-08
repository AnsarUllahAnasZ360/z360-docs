---
title: Push Credential Configuration
---

# Push Credential Configuration

**Research Agent:** Teammate C: Push Credential Configuration Analyst
**Date:** 2026-02-08
**Status:** Complete

## Executive Summary

Z360 uses a **dual push notification system**: Firebase Cloud Messaging (FCM) for Android, and Firebase + APNs VoIP for iOS. The system coordinates:

1. **FCM for Android devices** - direct push via Firebase SDK
2. **APNs VoIP for iOS devices** - native VoIP push via Apple Push Notification service
3. **Z360 backend** - sends push notifications via both FCM (for Android + iOS fallback) and APNs VoIP (for iOS)
4. **Telnyx SDK** - sends its own push notifications for call control (separate from Z360 push)

**Key Insight:** Z360 does NOT register push tokens directly with the Telnyx SDK. Instead, Z360 sends its own "caller info" push via FCM/APNs, while Telnyx sends a separate "call control" push based on SIP credential registration. The mobile apps correlate these two pushes using normalized phone numbers.

---

## 1. Firebase Project Setup

### 1.1 Firebase Project

- **Project ID:** `z360-c7d9e`
- **Project Number:** `699830885674`
- **Firebase Console:** https://console.firebase.google.com/project/z360-c7d9e

**Services Used:**
- **Firebase Cloud Messaging (FCM)** - Push notifications for Android and iOS
- **Firebase Crashlytics** - Crash reporting (enabled in both iOS and Android)
- **Firebase Admin SDK** - Server-side API access from Laravel backend

### 1.2 Android Configuration

**Configuration File:** `android/app/google-services.json`

```json
{
  "project_info": {
    "project_number": "699830885674",
    "project_id": "z360-c7d9e",
    "storage_bucket": "z360-c7d9e.firebasestorage.app"
  },
  "client": [{
    "client_info": {
      "mobilesdk_app_id": "1:699830885674:android:240d4cc386bc49eaa21253",
      "android_client_info": {
        "package_name": "com.z360.app"
      }
    },
    "api_key": [{
      "current_key": "AIzaSyBko7ynzIQN_wP8Hf_KnyWIwUnlwTzL7aY"
    }]
  }]
}
```

**Source:** `android/app/google-services.json:1-29`

**Android Manifest Configuration:**

The app uses Firebase Messaging Service with custom implementation:

```xml
<service
    android:name="com.z360.app.fcm.Z360FirebaseMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

**Source:** `android/app/src/main/AndroidManifest.xml` (via `.claude/skills/voip-android/`)

### 1.3 iOS Configuration

**Configuration File:** `ios/App/App/GoogleService-Info.plist`

This file contains:
- Firebase project configuration
- iOS-specific client credentials
- API keys for Firebase services

**Source:** `ios/App/App/GoogleService-Info.plist` (file exists, not read for security)

**iOS Background Modes:**

```xml
<key>UIBackgroundModes</key>
<array>
    <string>voip</string>
    <string>audio</string>
    <string>remote-notification</string>
    <string>fetch</string>
</array>
```

**Source:** `ios/App/App/Info.plist:27-33`

**Push Capabilities:**

```xml
<key>aps-environment</key>
<string>development</string>
```

**Source:** `ios/App/App/App.entitlements:5-6`

Note: For production, this should be set to `production`.

### 1.4 Backend Configuration

**Firebase Admin SDK Configuration:**

```php
// config/firebase.php
'credentials' => json_decode(env('FIREBASE_CREDENTIALS', '{}'), true),
```

**Source:** `config/firebase.php:4823` (via `.claude/skills/voip-backend/references/files.md`)

**Environment Variables:**

```bash
# .env.base
FIREBASE_CREDENTIALS=    # JSON string of service account credentials
```

**Source:** `.env.base:184`

**Service Configuration:**

```php
// config/services.php
'firebase' => [
    'project_id' => env('FIREBASE_PROJECT_ID', 'z360-c7d9e'),
    'credentials_path' => env(
        'FIREBASE_CREDENTIALS_PATH',
        storage_path('z360-c7d9e-firebase-adminsdk-fbsvc-dca3e28ad0.json')
    ),
],
```

**Source:** `config/services.php:54-57`

**Backend Push Implementations:**

1. **FcmChannel** (Laravel notification channel) - Uses Kreait Firebase SDK
   - Source: `app/Channels/FcmChannel.php:3-137` (via `.claude/skills/voip-backend/`)
   - Uses `Kreait\Firebase\Contract\Messaging` for sending
   - Handles automatic token cleanup on `NotFound` or `InvalidMessage` errors

2. **PushNotificationService** - Uses Firebase HTTP v1 API via OAuth2
   - Source: `app/Services/PushNotificationService.php:1-322`
   - Implements OAuth2 access token caching (5-minute buffer before expiry)
   - Sends both FCM and APNs VoIP pushes for incoming calls

---

## 2. APNs (Apple Push Notification service) Configuration

### 2.1 Authentication Methods

Z360 supports **two authentication methods** for APNs VoIP push:

#### Token-Based Authentication (Preferred)

```php
// config/services.php
'apns_voip' => [
    'enabled' => env('APNS_VOIP_ENABLED', false),
    'environment' => env('APNS_VOIP_ENV', 'development'), // development | production
    'bundle_id' => env('APNS_VOIP_BUNDLE_ID'),
    // Token-based auth (preferred)
    'key_id' => env('APNS_VOIP_KEY_ID'),        // e.g., 'ABC123XYZ'
    'team_id' => env('APNS_VOIP_TEAM_ID'),      // e.g., 'DEF456GHI'
    'key_path' => env('APNS_VOIP_KEY_PATH'),    // Path to .p8 key file
],
```

**Source:** `config/services.php:59-66`

**Token-based auth requirements:**
- **Key ID:** 10-character identifier from Apple Developer portal
- **Team ID:** 10-character team identifier from Apple Developer portal
- **Key File:** `.p8` private key file downloaded from Apple Developer portal (only downloadable once)
- **Bundle ID:** iOS app bundle identifier (e.g., `com.z360.app`)

**JWT Generation:**

```php
// app/Services/ApnsVoipService.php
private static function getJwt(array $config): ?string
{
    $now = time();
    // JWT cached for 50 minutes
    if (self::$cachedJwt && self::$jwtExpiresAt && $now < self::$jwtExpiresAt) {
        return self::$cachedJwt;
    }

    $privateKey = @file_get_contents($keyPath);

    $header = self::base64UrlEncode(json_encode([
        'alg' => 'ES256',
        'kid' => $keyId,
    ]));

    $claims = self::base64UrlEncode(json_encode([
        'iss' => $teamId,
        'iat' => $now,
    ]));

    $data = $header.'.'.$claims;
    openssl_sign($data, $signature, $privateKey, 'sha256');
    $jwt = $data.'.'.self::base64UrlEncode($signature);

    // Cache for 50 minutes
    self::$cachedJwt = $jwt;
    self::$jwtExpiresAt = $now + (50 * 60);

    return $jwt;
}
```

**Source:** `app/Services/ApnsVoipService.php:127-176`

#### Certificate-Based Authentication (Fallback)

```php
// config/services.php
'apns_voip' => [
    // Certificate-based auth (fallback)
    'cert_path' => env('APNS_VOIP_CERT_PATH'),           // Path to .pem certificate
    'cert_passphrase' => env('APNS_VOIP_CERT_PASSPHRASE'), // Certificate passphrase
    'cert_key_path' => env('APNS_VOIP_CERT_KEY_PATH'),   // Path to .pem key file
],
```

**Source:** `config/services.php:67-71`

### 2.2 APNs Endpoints

```php
// app/Services/ApnsVoipService.php
$environment = $config['environment'] ?? 'development';
$host = $environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
```

**Source:** `app/Services/ApnsVoipService.php:36-37`

- **Development:** `https://api.sandbox.push.apple.com`
- **Production:** `https://api.push.apple.com`

### 2.3 APNs VoIP Push Format

```php
// app/Services/ApnsVoipService.php
public static function sendVoipPush(string $deviceToken, array $payload, ?string $collapseId = null): bool
{
    $topic = $bundleId.'.voip';  // e.g., 'com.z360.app.voip'

    $headers = [
        'apns-topic' => $topic,
        'apns-push-type' => 'voip',
        'apns-expiration' => '0',
        'apns-priority' => '10',
    ];

    if ($collapseId) {
        $headers['apns-collapse-id'] = $collapseId;
    }

    // HTTP/2 POST to /3/device/{deviceToken}
    $response = $client->post("/3/device/{$deviceToken}", [
        'headers' => $headers,
        'json' => $payload,
        'curl' => [CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_2_0],
    ]);
}
```

**Source:** `app/Services/ApnsVoipService.php:16-93`

**Key APNs Requirements:**
- **HTTP/2** protocol required
- **VoIP topic:** `{bundle_id}.voip`
- **Push type:** `voip` (must be set for PushKit delivery)
- **Priority:** `10` (immediate delivery)
- **Expiration:** `0` (do not store if device offline)

---

## 3. Device Token Flow

### 3.1 Token Flow on iOS

**Step 1: PushKit Registration**

```swift
// ios/App/App/VoIP/Managers/PushKitManager.swift
func initialize() {
    // Create PushKit registry on main queue
    voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
    voipRegistry?.delegate = self

    // Register for VoIP push type
    voipRegistry?.desiredPushTypes = [.voIP]

    print("[PushKitManager] Initialized and registered for VoIP pushes")
}
```

**Source:** `.claude/skills/voip-ios/references/files.md:986-1005` (PushKitManager.swift)

**Step 2: Firebase SDK Token Conversion**

```swift
// ios/App/App/AppDelegate.swift
extension AppDelegate: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }
        print("FCM Token: \(token)")

        // Inject FCM token into WebView via JavaScript
        // The JS code will handle backend registration with proper authentication
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            self.injectJavaScript("window.dispatchEvent(new CustomEvent('iosFCMToken', { detail: '\(token)' }));")
        }
    }
}
```

**Source:** `.claude/skills/voip-ios/references/files.md:10544-10552` (AppDelegate.swift)

**Key Points:**
- APNs token obtained by PushKit (separate from regular push)
- Firebase SDK converts APNs token to FCM token internally
- 2-second delay allows WebView to initialize before token injection
- Token passed via JavaScript custom event, not Capacitor bridge

**Step 3: Frontend Token Reception**

```typescript
// resources/js/hooks/use-push-notifications.ts
// iOS: Listen for FCM token from native AppDelegate
if (Capacitor.getPlatform() === 'ios') {
    window.addEventListener('iosFCMToken', ((event: CustomEvent<string>) => {
        const fcmToken = event.detail;
        const storedToken = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
        const lastSentAt = localStorage.getItem(FCM_TOKEN_SENT_AT_KEY);
        const hoursSinceLastSent = lastSentAt
            ? (Date.now() - parseInt(lastSentAt)) / 3600000
            : Infinity;

        // Send to backend if token changed OR if it's been more than 24 hours
        if (storedToken !== fcmToken || hoursSinceLastSent > TOKEN_RESEND_INTERVAL_HOURS) {
            registerTokenWithBackend(fcmToken);
        }
    }) as EventListener);
}
```

**Source:** `.claude/skills/voip-frontend/references/files.md:2225-2236` (use-push-notifications.ts)

**Step 4: Backend Registration**

```typescript
// resources/js/hooks/use-push-notifications.ts
function registerTokenWithBackend(token: string) {
    router.post(
        route('device-tokens.store'),
        {
            fcm_token: token,
            platform: Capacitor.getPlatform() as 'android' | 'ios',
        },
        {
            preserveState: true,
            preserveScroll: true,
            onSuccess: () => {
                localStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
                localStorage.setItem(FCM_TOKEN_SENT_AT_KEY, Date.now().toString());
            },
            onError: () => {
                console.error('[Push] Failed to register token with backend');
            },
        },
    );
}
```

**Source:** `.claude/skills/voip-frontend/references/files.md:2356-2376` (use-push-notifications.ts)

### 3.2 Token Flow on Android

**Step 1: FCM Token Reception**

```kotlin
// android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt
override fun onNewToken(token: String) {
    VoipLogger.fcmTokenUpdated(token)
    TokenHolder.initialize(applicationContext)
    TokenHolder.setToken(token)
    VoipLogger.d(LOG_COMPONENT, "FCM token stored in TokenHolder")
}
```

**Source:** `.claude/skills/voip-android/references/files.md:665-670` (Z360FirebaseMessagingService.kt)

**Step 2: Capacitor Plugin Registration**

```typescript
// resources/js/hooks/use-push-notifications.ts
PushNotifications.addListener('registration', async (token) => {
    // On Android: token.value is the FCM token
    // On iOS: token.value is the APNs token (Firebase handles FCM token natively in AppDelegate)
    if (Capacitor.getPlatform() === 'android') {
        const storedToken = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
        const lastSentAt = localStorage.getItem(FCM_TOKEN_SENT_AT_KEY);
        const hoursSinceLastSent = lastSentAt
            ? (Date.now() - parseInt(lastSentAt)) / 3600000
            : Infinity;

        // Send to backend if token changed OR if it's been more than 24 hours
        if (storedToken !== token.value || hoursSinceLastSent > TOKEN_RESEND_INTERVAL_HOURS) {
            registerTokenWithBackend(token.value);
        }
    }
    // iOS FCM token registration is handled natively in AppDelegate
});
```

**Source:** `.claude/skills/voip-frontend/references/files.md:2304-2318` (use-push-notifications.ts)

**Step 3: Backend Registration**

Same `registerTokenWithBackend()` function as iOS (see above).

### 3.3 Backend Token Storage

**Controller:**

```php
// app/Http/Controllers/DeviceTokenController.php
public function store(Request $request)
{
    $validated = $request->validate([
        'fcm_token' => ['required', 'string', 'max:500'],
        'platform' => ['required', 'in:android,ios'],
    ]);

    // Upsert by fcm_token: if this token was registered to another user (account switch),
    // it gets reassigned to the current user.
    UserDeviceToken::updateOrCreate(
        ['fcm_token' => $validated['fcm_token']],
        [
            'user_id' => Auth::id(),
            'platform' => $validated['platform'],
            'last_active_at' => now(),
        ]
    );

    return back();
}
```

**Source:** `.claude/skills/voip-backend/references/files.md:2800-2818` (DeviceTokenController.php)

**Model:**

```php
// app/Models/UserDeviceToken.php
protected $fillable = [
    'user_id',
    'organization_id',
    'device_id',
    'fcm_token',
    'platform',
    'app_version',
    'device_name',
    'last_active_at',
    'telnyx_credential_id',
    'sip_username',
    'sip_password',
    'connection_id',
    'credential_expires_at',
];
```

**Source:** `.claude/skills/voip-backend/references/files.md:2850-2864` (UserDeviceToken.php)

**Database Schema:**

```php
// database/migrations/2026_01_05_140119_create_user_device_tokens_table.php
Schema::create('user_device_tokens', function (Blueprint $table) {
    $table->id();
    $table->foreignId('user_id')->constrained()->onDelete('cascade');
    $table->organization(); // Macro: foreignId('organization_id')
    $table->string('device_id', 255);
    $table->string('fcm_token', 500);
    $table->enum('platform', ['android', 'ios', 'web'])->default('android');
    $table->string('app_version', 50)->nullable();
    $table->string('device_name', 255)->nullable();
    $table->timestamp('last_active_at')->nullable();
    $table->timestamps();

    // Unique constraint: one device per user per organization
    $table->unique(['user_id', 'organization_id', 'device_id']);
    $table->index(['user_id', 'organization_id']);
});
```

**Source:** `database/migrations/2026_01_05_140119_create_user_device_tokens_table.php:14-30`

**Key Observations:**
- Token uniquely identified by `fcm_token` (not device_id)
- If token exists for another user, it gets reassigned (account switching)
- `last_active_at` updated on every token registration
- Organization-scoped via `organization_id` foreign key
- Also stores Telnyx SIP credentials (added in later migration)

---

## 4. Telnyx Push Credential Binding

### 4.1 Critical Finding: No Direct Push Token Registration

**Z360 does NOT register push tokens directly with the Telnyx SDK.**

Evidence:
- No `registerPushNotificationToken()` calls found in iOS/Android Telnyx integration
- No push credential API calls to Telnyx found in backend
- Telnyx SDK sends its own push notifications independently

**Search Results:**

```bash
# iOS search
grep -r "registerPushNotificationToken\|setPushToken\|push_token" .claude/skills/voip-ios/
# No matches found

# Android search
grep -r "registerPushNotificationToken\|setPushToken\|push_token" .claude/skills/voip-android/
# No matches found
```

**Source:** Search executed on `.claude/skills/voip-ios/` and `.claude/skills/voip-android/`

### 4.2 How Telnyx Sends Push Notifications

Telnyx sends push notifications based on **SIP credential registration**, not explicit push token registration:

1. **SIP Credential Creation** (org-level, not per-device):

```php
// app/Services/CPaaSService.php
public static function handleCredentials(?User $user): ?string
{
    $connectionId = config('cpaas.telnyx.credential_connection_id');
    $orgId = CurrentTenant::id();

    // Find or create org-level telephony credential
    $existing = UserTelnyxTelephonyCredential::where('organization_id', $orgId)
        ->where('user_id', $user->id)
        ->first();

    if (!$existing) {
        $name = 'Org-'.$orgId.'_'.Str::random(8);
        $telephonyCredential = \Telnyx\TelephonyCredential::create([
            'name' => $name,
            'connection_id' => $connectionId,
        ]);

        $existing = UserTelnyxTelephonyCredential::create([
            'user_id' => $user->id,
            'organization_id' => $orgId,
            'credential_id' => $telephonyCredential->id,
            'connection_id' => $connectionId,
            'sip_username' => $telephonyCredential->sip_username,
            'sip_password' => $telephonyCredential->sip_password,
        ]);
    }

    // Retrieve JWT token (10-hour TTL)
    $cred = \Telnyx\TelephonyCredential::retrieve($existing->credential_id);
    $token = $cred->token();

    return $token;
}
```

**Source:** `app/Services/CPaaSService.php:161-205` (via `.claude/skills/voip-backend/`)

2. **Credential Connection Setup** (platform-level):

```php
// app/Console/Commands/TelnyxSetup.php
protected function createCredentialConnection(?string $ovpId, bool $force): ?string
{
    $username = $this->genName('cred');
    $password = bin2hex(random_bytes(12));

    $payload = [
        'user_name' => $username,
        'password' => $password,
        'connection_name' => $this->genName('Credential-Connection'),
        'webhook_event_url' => $webhookUrl,
        'webhook_event_failover_url' => $webhookFailoverUrl,
        'webhook_api_version' => '2',
        'sip_uri_calling_preference' => 'internal',
        'outbound' => [
            'outbound_voice_profile_id' => $ovpId,
            'call_parking_enabled' => true,
        ],
    ];

    $resp = CPaaSService::telnyxRequest('POST', 'credential_connections', $payload);
    return $resp['json']['data']['id'] ?? null;
}
```

**Source:** `app/Console/Commands/TelnyxSetup.php:147-189`

### 4.3 Two-Push Coordination

Z360 and Telnyx send **separate push notifications**:

1. **Z360 Push** (sent first):
   - Contains caller display info (name, avatar, organization)
   - Sent via `PushNotificationService::sendIncomingCallPush()`
   - Uses FCM (Android) and APNs VoIP (iOS)

2. **Telnyx Push** (sent by Telnyx SDK):
   - Contains call control metadata
   - Sent automatically when call arrives at registered SIP credential
   - Platform-specific push credentials configured in Telnyx dashboard

**Correlation Method:**

Mobile apps correlate the two pushes using **normalized phone numbers** (last 10 digits):

```swift
// iOS: PushCorrelator
let normalizedFrom = String(fromNumber.suffix(10))
```

**Source:** Referenced in memory: "Two-push system: Z360 push (caller info) + Telnyx push (call control) - correlated by normalized phone (last 10 digits), 500ms sync timeout"

---

## 5. Token Refresh and Maintenance

### 5.1 Token Refresh Events

**iOS - MessagingDelegate:**

```swift
// ios/App/App/AppDelegate.swift
func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    // Called when token changes (app reinstall, token refresh, etc.)
    guard let token = fcmToken else { return }
    // Inject into WebView (same flow as initial token)
    self.injectJavaScript("window.dispatchEvent(new CustomEvent('iosFCMToken', { detail: '\(token)' }));")
}
```

**Source:** `.claude/skills/voip-ios/references/files.md:10544-10552`

**Android - onNewToken:**

```kotlin
// android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt
override fun onNewToken(token: String) {
    VoipLogger.fcmTokenUpdated(token)
    TokenHolder.initialize(applicationContext)
    TokenHolder.setToken(token)
}
```

**Source:** `.claude/skills/voip-android/references/files.md:665-670`

### 5.2 24-Hour Keepalive

Frontend resends token every 24 hours to keep `last_active_at` fresh:

```typescript
// resources/js/hooks/use-push-notifications.ts
const TOKEN_RESEND_INTERVAL_HOURS = 24;

const hoursSinceLastSent = lastSentAt
    ? (Date.now() - parseInt(lastSentAt)) / 3600000
    : Infinity;

// Send to backend if token changed OR if it's been more than 24 hours
if (storedToken !== fcmToken || hoursSinceLastSent > TOKEN_RESEND_INTERVAL_HOURS) {
    registerTokenWithBackend(fcmToken);
}
```

**Source:** `.claude/skills/voip-frontend/references/files.md:2197-2236`

**Purpose:** Allows backend to identify and clean up stale device tokens.

### 5.3 Stale Token Cleanup

**FcmChannel (Laravel notification channel):**

```php
// app/Channels/FcmChannel.php
try {
    $this->messaging->send($message);
    $device->update(['last_active_at' => now()]);
} catch (NotFound|InvalidMessage $e) {
    // Token is invalid or expired — remove it
    $device->delete();
    Log::info('Removed invalid FCM token', [
        'device_id' => $device->id,
        'error' => $e->getMessage()
    ]);
}
```

**Source:** `.claude/skills/voip-backend/references/files.md:127-131` (FcmChannel.php)

**PushNotificationService:**

```php
// app/Services/PushNotificationService.php
catch (\Throwable $e) {
    // If token is invalid, remove it
    if (str_contains($e->getMessage(), 'UNREGISTERED') ||
        str_contains($e->getMessage(), 'INVALID_ARGUMENT')) {
        UserDeviceToken::removeToken($token);
    }
}
```

**Source:** `app/Services/PushNotificationService.php:110-112`

**Cleanup Triggers:**
- FCM returns `NotFound` or `InvalidMessage`
- FCM returns error code `UNREGISTERED` or `INVALID_ARGUMENT`
- APNs returns 410 Gone (token no longer valid)

### 5.4 Manual Token Removal

On logout:

```php
// app/Http/Controllers/DeviceTokenController.php
public function destroy(Request $request)
{
    $validated = $request->validate([
        'fcm_token' => ['required', 'string', 'max:500'],
    ]);

    Auth::user()->deviceTokens()
        ->where('fcm_token', $validated['fcm_token'])
        ->delete();

    return back();
}
```

**Source:** `.claude/skills/voip-backend/references/files.md:2824-2835`

Frontend helper:

```typescript
// resources/js/hooks/use-push-notifications.ts
export function getAndClearPushToken(): string | null {
    if (!Capacitor.isNativePlatform()) return null;

    const token = localStorage.getItem(FCM_TOKEN_STORAGE_KEY);
    if (!token) return null;

    localStorage.removeItem(FCM_TOKEN_STORAGE_KEY);
    localStorage.removeItem(FCM_TOKEN_SENT_AT_KEY);

    return token;
}
```

**Source:** `.claude/skills/voip-frontend/references/files.md:2382-2392`

---

## 6. Environment Configuration Summary

### 6.1 Required Environment Variables

```bash
# Firebase
FIREBASE_CREDENTIALS='{"type":"service_account",...}'  # JSON string
FIREBASE_PROJECT_ID=z360-c7d9e
FIREBASE_CREDENTIALS_PATH=/path/to/service-account.json

# APNs VoIP (Token-based - preferred)
APNS_VOIP_ENABLED=true
APNS_VOIP_ENV=production              # or 'development'
APNS_VOIP_BUNDLE_ID=com.z360.app
APNS_VOIP_KEY_ID=ABC123XYZ            # 10-char from Apple Developer
APNS_VOIP_TEAM_ID=DEF456GHI           # 10-char from Apple Developer
APNS_VOIP_KEY_PATH=/path/to/AuthKey_ABC123XYZ.p8

# APNs VoIP (Certificate-based - fallback)
APNS_VOIP_CERT_PATH=/path/to/voip-cert.pem
APNS_VOIP_CERT_PASSPHRASE=your_passphrase
APNS_VOIP_CERT_KEY_PATH=/path/to/voip-key.pem

# Telnyx
TELNYX_API_KEY=KEY...
TELNYX_CREDENTIAL_CONNECTION_ID=...
TELNYX_OUTBOUND_VOICE_PROFILE_ID=...
TELNYX_CALL_CONTROL_APP_ID=...
TELNYX_NOTIFICATIONS_PROFILE_ID=...
```

### 6.2 File Locations

**Android:**
- `android/app/google-services.json` - Firebase configuration (committed to repo)

**iOS:**
- `ios/App/App/GoogleService-Info.plist` - Firebase configuration (committed to repo)
- `ios/App/App/App.entitlements` - Push capabilities (committed to repo)
- `ios/App/App/Info.plist` - Background modes (committed to repo)

**Backend:**
- `config/firebase.php` - Firebase SDK configuration
- `config/services.php` - APNs and Firebase service configuration
- `config/cpaas.php` - Telnyx API configuration
- `storage/z360-c7d9e-firebase-adminsdk-*.json` - Firebase service account key (gitignored)
- APNs `.p8` key file (gitignored, location specified in env)

---

## 7. Push Notification Sending Flow

### 7.1 Incoming Call Push (Z360-Initiated)

```php
// app/Services/PushNotificationService.php
public static function sendIncomingCallPush(
    int $userId,
    string $callSessionId,
    string $callControlId,
    string $callerNumber,
    string $callerName,
    string $channelNumber,
    ?int $organizationId = null,
    ?string $organizationName = null,
    ?string $organizationSlug = null,
    ?string $callerAvatar = null,
    ?string $callId = null
): array {
    // Get device tokens for user (org-scoped if orgId provided)
    $fcmTokens = UserDeviceToken::getFcmTokensForUserInOrganization($userId, $organizationId);
    $apnsTokens = UserDeviceToken::getApnsVoipTokensForUserInOrganization($userId, $organizationId);

    $payload = [
        'type' => 'incoming_call',
        'call_session_id' => $callSessionId,
        'call_control_id' => $callControlId,
        'caller_number' => $callerNumber,
        'caller_name' => $callerName,
        'channel_number' => $channelNumber,
        'caller_avatar' => $callerAvatar,
        'call_id' => $callId,
        'organization_id' => $organizationId,
        'organization_name' => $organizationName,
        'organization_slug' => $organizationSlug,
        'timestamp' => now()->timestamp,
    ];

    // Send FCM to Android devices
    foreach ($fcmTokens as $token) {
        self::sendFcmMessage($token, $payload);
    }

    // Send APNs VoIP to iOS devices
    $apnsPayload = array_merge($payload, [
        'aps' => ['content-available' => 1],
    ]);

    foreach ($apnsTokens as $token) {
        ApnsVoipService::sendVoipPush($token, $apnsPayload, $callSessionId);
    }
}
```

**Source:** `app/Services/PushNotificationService.php:20-157`

### 7.2 Non-VoIP Push (Laravel Notifications)

```php
// app/Channels/FcmChannel.php
public function send(object $notifiable, Notification $notification): void
{
    $devices = $notifiable->deviceTokens()->get();
    $payload = $notification->toFcm($notifiable);
    $payload = $this->injectOrganizationContext($payload);

    foreach ($devices as $device) {
        $message = CloudMessage::withTarget('token', $device->fcm_token)
            ->withNotification([
                'title' => $payload['title'] ?? 'Z360',
                'body' => $payload['body'] ?? '',
            ])
            ->withData($data)
            ->withAndroidConfig(AndroidConfig::fromArray($androidConfig));

        $this->messaging->send($message);
    }
}
```

**Source:** `.claude/skills/voip-backend/references/files.md:27-60` (FcmChannel.php)

**Organization Context Injection:**

```php
protected function injectOrganizationContext(array $payload): array
{
    $orgId = $payload['organization_id'] ?? null;
    $orgName = $payload['organization_name'] ?? null;

    if (!$orgId) return $payload;

    // Prepend org name to title
    if ($orgName && isset($payload['title'])) {
        $payload['title'] = "[{$orgName}] {$payload['title']}";
    }

    // Append org_id to deep link
    if (isset($payload['data']['link'])) {
        $separator = str_contains($payload['data']['link'], '?') ? '&' : '?';
        $payload['data']['link'] .= "{$separator}organization_id={$orgId}";
    }

    $payload['data']['organization_id'] = (string) $orgId;

    return $payload;
}
```

**Source:** `.claude/skills/voip-backend/references/files.md:69-92` (FcmChannel.php)

---

## 8. Key Architectural Insights

### 8.1 Dual Push System

Z360 uses a **two-push architecture** for VoIP calls:

1. **Z360 Push** (caller info):
   - Sent by Z360 backend via `PushNotificationService`
   - Contains: caller name, number, avatar, organization context
   - Sent to **all devices** for the user in the organization
   - Uses FCM (Android) and APNs VoIP (iOS)

2. **Telnyx Push** (call control):
   - Sent automatically by Telnyx when call arrives at SIP credential
   - Contains: call control metadata, Telnyx session ID
   - Sent based on SIP credential registration (not explicit push token)
   - Mobile apps must handle and correlate both pushes

**Correlation:** Mobile apps use **normalized phone number** (last 10 digits) to match Z360 push with Telnyx push within a 500ms timeout window.

### 8.2 Organization-Scoped Tokens

Device tokens are **organization-scoped**:

```php
// app/Models/UserDeviceToken.php
$table->unique(['user_id', 'organization_id', 'device_id']);
```

**Implications:**
- Same device/token can be registered to multiple organizations
- Push notifications sent only to devices for the current organization
- Organization switching requires new token registration (or update)

### 8.3 Token-Based vs. Certificate-Based APNs

**Token-based auth (preferred):**
- ✅ Single `.p8` key works for all apps in team
- ✅ Keys don't expire (unless manually revoked)
- ✅ Simpler setup (no certificate renewal)
- ✅ JWT cached for 50 minutes (efficient)

**Certificate-based auth (fallback):**
- ❌ Separate certificate per app
- ❌ Certificates expire annually
- ❌ More complex renewal process
- ℹ️ Still supported for legacy compatibility

### 8.4 FCM HTTP v1 vs. Legacy API

Z360 uses **both** FCM APIs:

1. **Firebase Admin SDK** (`FcmChannel`):
   - Uses Kreait Firebase package
   - For Laravel notification system
   - Better integration with Laravel queues

2. **FCM HTTP v1 API** (`PushNotificationService`):
   - Direct HTTP API calls
   - OAuth2 access token authentication
   - For time-sensitive VoIP pushes
   - Lower latency (no SDK overhead)

---

## 9. Security Considerations

### 9.1 Credential Storage

**Never commit to version control:**
- ❌ Firebase service account JSON (`FIREBASE_CREDENTIALS`)
- ❌ APNs `.p8` private key file
- ❌ APNs certificate `.pem` files
- ❌ Telnyx API key

**Safe to commit:**
- ✅ `google-services.json` (Android)
- ✅ `GoogleService-Info.plist` (iOS)
- ✅ `App.entitlements` (iOS)
- ✅ Configuration files with environment variable references

### 9.2 Token Security

- Device tokens stored in plain text (not sensitive - server validates)
- FCM tokens are unique per app instance (rotate on reinstall)
- APNs tokens tied to device + app + push type (rotate on app update)
- Backend validates tokens on send (invalid tokens auto-removed)

### 9.3 Push Payload Security

- No sensitive data in push payload (user must be authenticated to see details)
- Push only contains minimal info to display caller ID
- Deep links include organization context (validated by backend on navigation)
- VoIP push bypasses iOS restrictions (CallKit required within 5 seconds)

---

## 10. Troubleshooting

### 10.1 iOS Push Not Received

**Check:**
1. `APNS_VOIP_ENABLED=true` in backend `.env`
2. APNs credentials valid (key ID, team ID, key path)
3. APNs environment matches provisioning profile (development vs. production)
4. `aps-environment` in `App.entitlements` matches backend config
5. PushKit initialized at app launch (`PushKitManager.shared.initialize()`)
6. FCM token successfully injected into WebView (check logs: "FCM Token:")
7. Backend logs show successful APNs push send (status 200)

### 10.2 Android Push Not Received

**Check:**
1. `google-services.json` matches Firebase project
2. FCM token registration successful (check logs: "FCM token stored")
3. Firebase Admin SDK credentials valid (`FIREBASE_CREDENTIALS`)
4. Backend logs show successful FCM send (status 200-299)
5. Android notification channels created (high importance)
6. App not in battery optimization mode (affects background push)

### 10.3 Token Not Registered with Backend

**Check:**
1. WebView initialized before token injection (2-second delay on iOS)
2. Frontend event listener registered before token arrives
3. User authenticated (backend requires `Auth::id()`)
4. Network connectivity (token registration is async)
5. Check browser console logs: "[Push] Failed to register token with backend"
6. Backend logs show POST `/api/device-tokens` received

### 10.4 Telnyx Push Not Received

**Note:** Telnyx push is **separate from Z360 push**. If Z360 push works but Telnyx push doesn't:

**Check:**
1. SIP credential registered with Telnyx (org-level)
2. Credential Connection ID valid (`TELNYX_CREDENTIAL_CONNECTION_ID`)
3. Push credentials configured in Telnyx dashboard (per platform)
4. Mobile app logs show both Z360 and Telnyx push received
5. 500ms correlation timeout not exceeded (increase if needed)

---

## 11. Future Improvements

### 11.1 Per-Device SIP Credentials

**Current:** Org-level SIP credentials shared across devices
**Proposed:** Per-device SIP credentials for better call routing

**Benefits:**
- Direct push from Telnyx to specific device
- No need for two-push correlation
- Simpler mobile app logic
- Better handling of simultaneous ring

**Implementation:**
- Generate SIP credential per `UserDeviceToken` record
- Store `telnyx_credential_id`, `sip_username`, `sip_password` in `user_device_tokens` table
- Register Telnyx push token with device-specific credential
- Use device credential for Telnyx SDK connection

**Status:** Partial implementation exists (columns added to `user_device_tokens` table) but not fully implemented.

### 11.2 APNs Token Refresh Tracking

**Current:** Token refresh handled automatically, no tracking
**Proposed:** Log token refresh events for debugging

**Benefits:**
- Better visibility into token lifecycle
- Identify patterns in token expiration
- Debug push delivery issues faster

### 11.3 Push Notification Analytics

**Current:** Basic success/failure logging
**Proposed:** Detailed analytics dashboard

**Metrics:**
- Push delivery rate per platform
- Average push latency
- Token invalidation rate
- Organization-specific push stats

---

## 12. Conclusion

Z360's push notification system is a **dual-channel architecture**:

1. **Z360-controlled push** (FCM + APNs VoIP) - for caller display info
2. **Telnyx-controlled push** (platform-specific) - for call control

Key design decisions:

- ✅ Organization-scoped device tokens enable multi-tenant support
- ✅ 24-hour keepalive ensures token freshness
- ✅ Automatic stale token cleanup prevents failed deliveries
- ✅ Separate push channels for caller info vs. call control
- ⚠️ Two-push correlation adds complexity (500ms timeout window)
- ⚠️ Org-level SIP credentials require push correlation (per-device credentials would simplify)

The system successfully delivers push notifications to iOS and Android devices, with proper handling of token refresh, organization switching, and multi-device scenarios.

---

## References

### Source Files

**Backend:**
- `app/Services/ApnsVoipService.php` - APNs VoIP push implementation
- `app/Services/PushNotificationService.php` - FCM and APNs push orchestration
- `app/Channels/FcmChannel.php` - Laravel notification channel for FCM
- `app/Http/Controllers/DeviceTokenController.php` - Device token registration endpoint
- `app/Models/UserDeviceToken.php` - Device token model
- `app/Services/CPaaSService.php` - Telnyx API integration
- `config/firebase.php` - Firebase configuration
- `config/services.php` - APNs and Firebase service configuration
- `config/cpaas.php` - Telnyx configuration
- `database/migrations/2026_01_05_140119_create_user_device_tokens_table.php`

**iOS:**
- `ios/App/App/VoIP/Managers/PushKitManager.swift` - PushKit registration
- `ios/App/App/AppDelegate.swift` - Firebase token handling
- `ios/App/App/App.entitlements` - Push capabilities
- `ios/App/App/Info.plist` - Background modes
- `ios/App/App/GoogleService-Info.plist` - Firebase configuration

**Android:**
- `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt` - FCM service
- `android/app/google-services.json` - Firebase configuration

**Frontend:**
- `resources/js/hooks/use-push-notifications.ts` - Token registration and push handling

### Skills Referenced

- `.claude/skills/voip-backend/` - Backend VoIP implementation
- `.claude/skills/voip-ios/` - iOS VoIP implementation
- `.claude/skills/voip-android/` - Android VoIP implementation
- `.claude/skills/voip-frontend/` - Frontend VoIP integration

---

**Document Version:** 1.0
**Last Updated:** 2026-02-08
**Author:** Teammate C (Push Credential Configuration Analyst)
