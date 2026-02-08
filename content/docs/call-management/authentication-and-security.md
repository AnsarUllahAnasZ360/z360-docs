---
title: Authentication And Security
---

# Authentication State Management & Security Analysis

> **Scope**: Cross-platform authentication, credential storage, push token security, API security, and webhook verification across Z360's VoIP system (Web, iOS, Android, Laravel backend).

---

## Table of Contents

1. [Session Management](#1-session-management)
2. [Credential Security](#2-credential-security)
3. [Push Token Security](#3-push-token-security)
4. [API Security](#4-api-security)
5. [Webhook Security](#5-webhook-security)
6. [Official SDK Security Recommendations vs Implementation](#6-official-sdk-security-recommendations-vs-implementation)
7. [Risk Assessment Summary](#7-risk-assessment-summary)
8. [Remediation Priorities](#8-remediation-priorities)

---

## 1. Session Management

### 1.1 Laravel Session Configuration

Z360 uses Laravel's database-backed session driver with cookie-based session identifiers.

**Source**: `config/session.php`

| Setting | Value | Notes |
|---------|-------|-------|
| Driver | `database` | Sessions stored in `sessions` table |
| Lifetime (Web) | 120 minutes | `SESSION_LIFETIME` env, default 120 |
| Lifetime (Mobile) | 43,200 minutes (~30 days) | `SESSION_LIFETIME_MOBILE` env |
| Encryption | `false` | Session data NOT encrypted at rest |
| Cookie HttpOnly | `true` | JavaScript cannot access session cookie |
| Cookie SameSite | `lax` | Prevents CSRF on cross-origin POST |
| Cookie Secure | env-dependent | Should be `true` in production (HTTPS) |
| Expire on close | `false` | Sessions persist across browser close |

```php
// config/session.php:35-37
'lifetime' => (int) env('SESSION_LIFETIME', 120),
'lifetime_mobile' => (int) env('SESSION_LIFETIME_MOBILE', 43200),
```

### 1.2 WebView ↔ Native Session Sharing

The Capacitor WebView shares its session cookie with native code through the `credentials: 'include'` directive in fetch calls. This is the critical bridge between the web session and native layer.

**Source**: `resources/js/hooks/use-native-voip.ts:2029-2042`

```typescript
// Native layer calls API endpoints using the WebView's session cookie
const response = await fetch('/api/device-tokens', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    },
    credentials: 'include',  // <-- Sends session cookie from WebView
    body: JSON.stringify({
        device_id: deviceId,
        fcm_token: token,
        platform: Capacitor.getPlatform(),
        device_name: `${Capacitor.getPlatform()} Device`,
    }),
});
```

**Implication**: The native layer has no independent authentication. If the WebView session expires, all API calls from native code will fail with 401. The native VoIP layer continues operating with cached SIP credentials even after session expiry, meaning calls can still be received via push notifications until credentials themselves expire.

### 1.3 iOS 30-Day Session Expiry Check

iOS implements a VoIP-specific session validity check based on the VoIP token registration date, separate from the Laravel session.

**Source**: `ios/App/App/AppDelegate.swift:10284-10396`

```swift
// ios/App/App/AppDelegate.swift:10284
private static let sessionExpiryDays: Int = 30

// ios/App/App/AppDelegate.swift:10360-10396
private func checkSessionExpiry() -> Bool {
    // Uses VoIP token date as proxy for session age
    Task {
        guard let tokenDate = await VoipStore.shared.getVoIPTokenDate() else {
            return  // No token date = expired
        }
        let daysSinceToken = calendar.dateComponents([.day], from: tokenDate, to: Date()).day ?? Int.max
        if daysSinceToken > Self.sessionExpiryDays {
            // Clear VoIP data but keep user logged in to web app
            await VoipStore.shared.clearAll()  // Clears Keychain credentials + UserDefaults
        }
    }
    // ... synchronous check for immediate return
}
```

**Key behavior**: After 30 days without re-registration, iOS clears all VoIP data (SIP credentials from Keychain, org context, VoIP token) but does NOT log the user out of the web app. This creates a graceful degradation where VoIP stops but the app remains functional.

### 1.4 Android Login Validation

Android validates VoIP login state on every incoming push notification using the Telnyx SDK's `ProfileManager`.

**Source**: `android/app/src/main/java/com/z360/app/voip/Z360FCMService.kt:673-711`

```kotlin
// android/...Z360FCMService.kt:681-686
private fun isUserLoggedIn(): Boolean {
    val profile = ProfileManager.getLoggedProfile(applicationContext)
    val hasCredentials = profile != null && !profile.sipUsername.isNullOrEmpty()
    VoipLogger.d(LOG_COMPONENT, "🔐 isUserLoggedIn: profile=${profile != null}, hasCredentials=$hasCredentials")
    return hasCredentials
}

// android/...Z360FCMService.kt:698-711
// Push rejected if user not logged in
if (!isUserLoggedIn()) {
    VoipLogger.w(LOG_COMPONENT, "🚫 Push rejected: user is logged out")
    return
}
```

**Risk: Medium** — Android has no equivalent of iOS's 30-day expiry check. Once SIP credentials are saved to `ProfileManager`, they persist indefinitely in SharedPreferences until explicitly cleared on logout. A stolen/lost device with credentials cached will continue receiving calls.

### 1.5 Session Fixation/Hijacking Protections

| Protection | Status | Details |
|------------|--------|---------|
| Session regeneration on login | **Yes** (Laravel default) | `Auth::login()` regenerates session ID |
| HttpOnly cookie | **Yes** | `session.http_only = true` |
| SameSite cookie | **Yes** (`lax`) | Prevents CSRF on cross-origin POST requests |
| Secure cookie | **Env-dependent** | Must be `true` in production |
| Session encryption | **No** | `session.encrypt = false` |
| Database-backed sessions | **Yes** | Prevents session file tampering |

---

## 2. Credential Security

### 2.1 Backend — Database Storage

**CRITICAL FINDING**: SIP passwords are stored in **plaintext** in two database tables.

#### `UserTelnyxTelephonyCredential` Model (org-level credentials)

**Source**: `app/Models/UserTelnyxTelephonyCredential.php` (via `.claude/skills/voip-backend/references/files.md:3018-3032`)

```php
class UserTelnyxTelephonyCredential extends Model
{
    protected $fillable = [
        'user_id',
        'organization_id',
        'credential_id',
        'connection_id',
        'sip_username',      // Plaintext
        'sip_password',      // ⚠️ PLAINTEXT — no encryption
    ];
    // No $casts for encrypted attributes
}
```

#### `UserDeviceToken` Model (per-device credentials)

**Source**: `app/Models/UserDeviceToken.php` (via `.claude/skills/voip-backend/references/files.md:2848-2864`)

```php
class UserDeviceToken extends Model
{
    protected $fillable = [
        'user_id', 'organization_id', 'device_id',
        'fcm_token', 'platform', 'app_version', 'device_name',
        'last_active_at',
        'telnyx_credential_id',
        'sip_username',         // Plaintext
        'sip_password',         // ⚠️ PLAINTEXT — no encryption
        'connection_id',
        'credential_expires_at',
    ];
}
```

**Risk: Critical** — Database compromise or SQL injection would expose all SIP credentials. Laravel provides `encrypted` cast (`protected $casts = ['sip_password' => 'encrypted']`) which would encrypt at rest using the app key.

#### Credentials Returned in API Responses

Both `/api/voip/credentials` and `/api/device-tokens` return SIP passwords in JSON responses.

**Source**: `app/Http/Controllers/Api/VoipCredentialController.php:76-87`

```php
return response()->json([
    'success' => true,
    'data' => [
        'sip_username' => $telnyxCredential->sip_username,
        'sip_password' => $telnyxCredential->sip_password,  // ⚠️ Password in response
        'jwt_token' => $jwtToken,
        'caller_id_name' => $user->name,
        'caller_id_number' => $callerIdNumber,
        'organization_id' => $organization->id,
        'organization_name' => $organization->name,
    ],
]);
```

**Source**: `app/Http/Controllers/Api/DeviceTokenController.php:125-129`

```php
$sipCredentials = [
    'sip_username' => $token->sip_username,
    'sip_password' => $token->sip_password,  // ⚠️ Password in response
    'jwt_token' => $deviceJwt ?? $jwtToken,
];
```

**Risk: High** — SIP passwords transit over HTTPS but could be captured by proxy servers, CDN logs, or browser developer tools. The passwords are necessary for SIP credential login flow (JWT is broken in Android SDK 3.3.0 per code comment), but ideally would only be transmitted once and not stored long-term.

### 2.2 iOS — Keychain Storage (Secure)

iOS uses Apple's Keychain Services via a custom `KeychainManager` wrapper.

**Source**: `ios/App/App/VoIP/Utils/KeychainManager.swift:7027-7139`

```swift
// ios/.../KeychainManager.swift:7050-7071
final class KeychainManager {
    private let service = "com.z360.voip"

    func save(_ value: String, forKey key: String) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlocked  // ✅ Protected when locked
        ]
        SecItemDelete(deleteQuery as CFDictionary)  // Delete-before-add pattern
        let status = SecItemAdd(query as CFDictionary, nil)
    }
}
```

**Credentials stored in Keychain** (via `VoipStore`):

| Key | Content | Source |
|-----|---------|--------|
| `z360_sip_username` | SIP username | `ios/.../VoipStore.swift:3848` |
| `z360_sip_password` | SIP password | `ios/.../VoipStore.swift:3849` |
| `z360_caller_id_name` | Caller ID name | `ios/.../VoipStore.swift:3852` |
| `z360_caller_id_number` | Caller ID number | `ios/.../VoipStore.swift:3858` |

**Non-sensitive data in UserDefaults** (via `VoipStore`):

| Key | Content | Risk |
|-----|---------|------|
| `z360_current_org_id` | Organization ID | Low |
| `z360_current_org_name` | Organization name | Low |
| `z360_voip_token` | VoIP push token | Low |
| `z360_voip_token_date` | Token registration date | Low |
| `z360_active_call_state` | Crash recovery state | Low |

**Security assessment**:
- ✅ `kSecAttrAccessibleWhenUnlocked` — credentials not available when device locked
- ✅ Keychain data is encrypted by iOS hardware security
- ✅ `clearCredentials()` properly deletes all 4 Keychain keys
- ✅ `clearAll()` calls `clearCredentials()` + clears UserDefaults
- ✅ Thread-safe via Swift `actor` isolation on `VoipStore`
- ⚠️ No `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — credentials could be in iCloud Keychain backup

**PushKit synchronous credential loading** (critical path):

**Source**: `ios/.../PushKitManager.swift:1691-1734`

```swift
// Must be synchronous — PushKit has ~5 second deadline
guard let credentials = self.loadCredentialsSync() else {
    print("[PushKitManager] ⚠️ No stored credentials for Telnyx push processing")
    return
}
// Uses KeychainManager directly (SecItemCopyMatching is synchronous)
```

### 2.3 Android — SharedPreferences Storage (Insecure)

**CRITICAL FINDING**: Android stores SIP credentials in **plain SharedPreferences**, not `EncryptedSharedPreferences`.

#### Telnyx SDK `ProfileManager` (stores SIP credentials)

**Source**: `telnyx_common/src/main/java/com/telnyx/webrtc/common/ProfileManager.kt` (via `.scratchpad/packs/telnyx-android-sdk.xml:2558-2680`)

```kotlin
// ProfileManager.kt (Telnyx SDK)
object ProfileManager {
    private const val LIST_OF_PROFILES = "list_of_profiles"

    fun saveProfile(context: Context, profile: Profile) {
        // Uses TelnyxCommon's SharedPreferences (NOT encrypted)
        val sharedPreferences = TelnyxCommon.getInstance().getSharedPreferences(context)
        // ... serializes Profile (including sipUsername, sipPass) as JSON
        sharedPreferences.edit().putString(LIST_OF_PROFILES, json).apply()
    }
}
```

**Source**: `telnyx_common/src/main/java/com/telnyx/webrtc/common/TelnyxCommon.kt` (via `.scratchpad/packs/telnyx-android-sdk.xml:2904-2911`)

```kotlin
// TelnyxCommon.kt
internal fun getSharedPreferences(context: Context): SharedPreferences {
    return sharedPreferences ?: synchronized(this) {
        sharedPreferences ?: context.getSharedPreferences(
            "TelnyxCommonSharedPreferences",   // ⚠️ Plain SharedPreferences
            Context.MODE_PRIVATE               // ⚠️ Not encrypted
        ).also { sharedPreferences = it }
    }
}
```

**What's stored**: A JSON array of `Profile` objects containing:
- `sipUsername` — SIP username in plaintext
- `sipPass` — SIP password in plaintext
- `sipToken` — JWT token (if token auth used)
- `callerIdName`, `callerIdNumber`
- `isUserLoggedIn` flag

**Risk: High** — On rooted devices or via ADB backup, SharedPreferences files can be read directly from `/data/data/com.z360.app/shared_prefs/TelnyxCommonSharedPreferences.xml`. This is a Telnyx SDK limitation, not a Z360 implementation choice.

#### Z360VoipStore (call metadata only — acceptable)

**Source**: `android/app/src/main/java/com/z360/app/voip/Z360VoipStore.kt:9010-9335`

```kotlin
class Z360VoipStore private constructor(private val context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("z360_voip_store", Context.MODE_PRIVATE)
    // Stores: org context, call display info, call metadata
    // Does NOT store SIP credentials (✅ good separation)
}
```

#### Other Android SharedPreferences Files

| File | Content | Risk |
|------|---------|------|
| `TelnyxCommonSharedPreferences` | SIP username + password (Telnyx SDK) | **High** |
| `z360_voip_store` | Org context, call display info | Low |
| `fcm_token_prefs` | FCM token cache | Low |
| `call_state_prefs` | Active call state for crash recovery | Low |
| `missed_calls_prefs` | Missed call tracking | Low |

### 2.4 Web — No Local Credential Storage

The web platform does not store SIP credentials locally. The flow is:
1. Backend generates JWT token via `CPaaSService::handleCredentials()` — 10-hour TTL
2. JWT is passed to `TelnyxRTCProvider` for WebSocket/WebRTC connection
3. No credentials persist in localStorage/sessionStorage

**Source**: `resources/js/hooks/use-native-voip.ts:2055` (code comment)

```typescript
// CRITICAL: Always use SIP credentials (JWT token auth is broken in Android SDK 3.3.0)
```

**Implication**: Web uses JWT-based auth (more secure, short-lived), while native mobile uses SIP credential auth (long-lived, stored locally) due to an Android SDK bug.

### 2.5 Credential Cleanup on Logout

| Platform | Action | Credentials Cleared? | Source |
|----------|--------|---------------------|--------|
| iOS | `disconnect(clearCredentials: true)` | ✅ Yes — `VoipStore.clearAll()` clears Keychain | `ios/.../VoipStore.swift:3967-3983` |
| Android | `ProfileManager.deleteProfileBySipUsername()` | ✅ Yes — removes from SharedPreferences | `android/.../TelnyxVoipPlugin.kt:6573-6579` |
| Web | N/A | ✅ N/A — no local storage | — |
| Backend | `DeviceTokenController::destroy()` | ✅ Deletes Telnyx credential via API | `app/Http/Controllers/Api/DeviceTokenController.php:183-212` |

### 2.6 Credential Exposure in Logs

Android implements a `VoipLogger.redact()` function that masks sensitive data:

**Source**: `android/app/src/main/java/com/z360/app/voip/VoipLogger.kt:7650-7669`

```kotlin
fun redact(sensitive: String?): String { /* ... masks content ... */ }
fun redactToken(token: String?, visibleChars: Int = 10): String { /* ... partial mask ... */ }
```

Usage examples:
```kotlin
// android/.../TelnyxVoipPlugin.kt:5931
VoipLogger.d(LOG_COMPONENT, "connect: sipUsername=${VoipLogger.redact(sipUsername)}")

// android/.../TelnyxVoipPlugin.kt:6256
VoipLogger.d(LOG_COMPONENT, "reconnectWithCredentials: sipUsername=${VoipLogger.redact(sipUsername)}")
```

**However**, there is one instance where `sipUsername` is logged without redaction:

**Source**: `android/.../IncomingCallActivity.kt:5053`
```kotlin
VoipLogger.d(LOG_COMPONENT, "🔄   sipUsername: ${credentials.sipUsername}, callerIdNumber: ${credentials.callerIdNumber}")
```

**Risk: Medium** — SIP username (not password) logged in debug mode during org switch. This would appear in logcat output on the device.

---

## 3. Push Token Security

### 3.1 FCM Token Registration Flow

**Endpoint**: `POST /api/device-tokens`
**Middleware**: `['web', 'auth', 'set-current-tenant']`

**Source**: `app/Http/Controllers/Api/DeviceTokenController.php:42-177`

```php
public function store(StoreDeviceTokenRequest $request): JsonResponse
{
    $validated = $request->validated();
    $user = Auth::user();
    $organizationId = CurrentTenant::id();

    // Upsert keyed by user_id + organization_id + device_id
    $token = UserDeviceToken::updateOrCreate(
        ['user_id' => $user->id, 'organization_id' => $organizationId, 'device_id' => $validated['device_id']],
        ['fcm_token' => $validated['fcm_token'], 'platform' => $validated['platform'], ...]
    );
}
```

**Validation** (via `StoreDeviceTokenRequest`):
- `fcm_token`: required, string, max 500
- `platform`: required, in:android,ios,web
- `device_id`: required, string
- `device_name`: optional string
- `app_version`: optional string

### 3.2 Can a Malicious Actor Register a Fake Device Token?

**Attack vector**: An authenticated user could register a fake FCM token to receive push notifications intended for another device, or register tokens for devices they don't own.

**Protections in place**:
- ✅ Requires valid session authentication (`auth` middleware)
- ✅ Token is scoped to `user_id + organization_id + device_id`
- ✅ Stale devices cleaned up after 7 days of inactivity
- ⚠️ No validation that the FCM token is actually a valid Firebase token
- ⚠️ No device attestation (SafetyNet/Play Integrity/Device Check)

**Risk: Medium** — A compromised user session could register arbitrary FCM tokens. However, this requires the attacker to already have session access, limiting the additional risk.

### 3.3 APNs VoIP Token Management (iOS)

iOS VoIP push tokens follow a PushKit-specific flow:

**Source**: `ios/.../PushKitManager.swift:1762-1784`

```swift
// Called when PushKit delivers a VoIP token
func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    let token = pushCredentials.token.map { String(format: "%02.2hhx", $0) }.joined()
    // Store in VoipStore (UserDefaults, not Keychain — acceptable for push tokens)
    Task { await VoipStore.shared.saveVoIPToken(token) }
}
```

**Token lifecycle**:
1. PushKit delivers VoIP token on app startup
2. Token stored in `VoipStore` (UserDefaults)
3. Token sent to backend via `/api/device-tokens` (with `getFcmTokenWithWait` for race condition handling)
4. On logout: token cleared from VoipStore, device unregistered from backend

### 3.4 Rate Limiting on Token Endpoints

| Endpoint | Rate Limit | Source |
|----------|-----------|--------|
| `POST /device-tokens` (org routes) | `throttle:10,1` (10 per minute) | `routes/organization/device-tokens.php:3303` |
| `POST /api/device-tokens` (API routes) | **None** | `routes/api.php:16` |
| `GET /api/voip/credentials` | **None** | `routes/api.php:23` |
| `POST /api/voip/switch-org` | **None** | `routes/api.php:24` |

**Risk: Medium** — The API-level device-tokens endpoint lacks rate limiting. An attacker with a valid session could rapidly create/update device registrations or spam credential requests.

---

## 4. API Security

### 4.1 Route Protection

All VoIP API endpoints use the same middleware stack:

**Source**: `routes/api.php:15-25`

```php
// Device Token REST API (requires auth)
Route::middleware(['web', 'auth', 'set-current-tenant'])->group(function () {
    Route::post('/device-tokens', [DeviceTokenController::class, 'store']);
    Route::delete('/device-tokens/{deviceId}', [DeviceTokenController::class, 'destroy']);
    Route::get('/device-tokens', [DeviceTokenController::class, 'index']);
});

// VoIP Credentials API (requires auth)
Route::middleware(['web', 'auth', 'set-current-tenant'])->group(function () {
    Route::get('/voip/credentials', [VoipCredentialController::class, 'show']);
    Route::post('/voip/switch-org', [VoipCredentialController::class, 'switchOrg']);
});
```

**Middleware breakdown**:
- `web` — Session handling, cookie encryption, CSRF verification (but see §4.2)
- `auth` — Requires authenticated user (redirects to login if not)
- `set-current-tenant` — Sets organization scope from session

### 4.2 CSRF Protection Status

**CRITICAL FINDING**: CSRF verification is **disabled** for all API routes.

**Source**: `bootstrap/app.php:66-72`

```php
$middleware->validateCsrfTokens(except: [
    'webhooks/*',
    'api/*',        // ⚠️ All /api/* routes exempt from CSRF
    'widget/*',
    'mcp/*',
    'forms/*',
]);
```

**Mitigations**:
- SameSite=lax cookie prevents cross-origin POST requests from triggering automatic cookie inclusion in most browsers
- API routes still require valid session cookie
- Cross-origin requests from different origins won't include cookies automatically

**Risk: Medium** — While SameSite=lax mitigates the most common CSRF attack vectors, older browsers or specific scenarios (GET-based state changes, subdomain attacks) could potentially bypass this. The VoIP credential endpoints accept POST requests which are well-protected by SameSite=lax.

### 4.3 Organization Access Control

The `switchOrg` endpoint properly verifies membership:

**Source**: `app/Http/Controllers/Api/VoipCredentialController.php:137-149`

```php
// Verify user has access to this organization
$user->load('organizations');
if (! $user->organizations->contains($organization)) {
    Log::warning('User attempted to switch to unauthorized organization', [
        'user_id' => $user->id,
        'organization_id' => $organizationId,
    ]);
    return response()->json(['success' => false, 'message' => 'Access denied'], 403);
}
```

✅ Good: Explicit membership check before granting credentials for a different organization.

### 4.4 Device Token Authorization

The `destroy` endpoint properly scopes deletion to the authenticated user:

**Source**: `app/Http/Controllers/Api/DeviceTokenController.php:188-191`

```php
$token = UserDeviceToken::where('device_id', $deviceId)
    ->where('user_id', $user->id)
    ->where('organization_id', $organizationId)
    ->first();
```

✅ Good: Triple-scoped (device + user + organization) prevents unauthorized device removal.

---

## 5. Webhook Security

### 5.1 Webhook Route Configuration

**CRITICAL FINDING**: All Telnyx webhook endpoints are **publicly accessible** with **no authentication or signature verification**.

**Source**: `routes/webhooks.php:17-62`

```php
/*
| Public endpoints for third-party webhooks. These routes are intentionally
| left outside of authentication and tenant middleware.
*/
Route::prefix('webhooks')->group(function () {
    // Telnyx webhook endpoints — NO middleware, NO auth, NO signature verification
    Route::post('cpaas/telnyx/notifications', TelnyxNotificationsWebhookController::class);
    Route::post('cpaas/telnyx/call-control', TelnyxInboundWebhookController::class);
    Route::post('cpaas/telnyx/call-control/failover', ...);
    Route::post('cpaas/telnyx/credential', TelnyxOutboundWebhookController::class);
    Route::post('cpaas/telnyx/credential/failover', ...);
    Route::post('cpaas/telnyx/a2p', TelnyxA2PWebhookController::class);
    Route::post('cpaas/telnyx/sms', TelnyxSMSWebhookController::class);
    Route::post('cpaas/telnyx/rcs', TelnyxRCSWebhookController::class);
    // ... and their failover counterparts
});
```

### 5.2 Missing Webhook Signature Verification

A comprehensive search of all Telnyx webhook controllers found **zero instances** of:
- HMAC signature verification
- `telnyx-signature-ed25519` header checking
- Telnyx public key verification
- IP address whitelisting

**Search performed**:
```
Grep: verify|signature|hmac|signing_key|webhook_secret|public_key
Path: app/Http/Controllers/Telnyx/
Result: No matches found
```

The controllers parse webhook payloads directly:

**Source**: `.claude/skills/voip-backend/references/files.md:3352-3358`

```php
// TelnyxCallController.php
public function __invoke(Request $request): JsonResponse
{
    $callSessionId = $request->input('data.payload.call_session_id');
    $webhook = TelnyxWebhook::from($request);  // Parses payload without verification
    $eventType = $webhook->data->event_type;
    // ... processes event
}
```

### 5.3 Impact of Missing Verification

An attacker who discovers the webhook URLs could:
1. **Forge call events**: Send fake `call.initiated` events to create phantom call records
2. **Trigger call routing**: Send fake `call.initiated` with attacker-controlled `call_control_id` to hijack call flow
3. **Forge hangup events**: Send fake `call.hangup` to terminate active calls
4. **Forge SMS events**: Send fake SMS delivery events or inject messages
5. **Cause resource exhaustion**: Flood webhook endpoints with fake events

**Risk: Critical** — Webhook URLs are predictable (`/webhooks/cpaas/telnyx/*`) and accept any properly-formatted JSON payload without verification.

### 5.4 Telnyx API Authentication (Outbound)

Outbound API calls to Telnyx use Bearer token authentication:

**Source**: `.claude/skills/voip-backend/references/files.md:4180-4197` (`CPaaSService::telnyxRequest()`)

```php
$client = new \GuzzleHttp\Client([
    'base_uri' => 'https://api.telnyx.com/v2/',
    'timeout' => 45,
    'headers' => [
        'Authorization' => 'Bearer ' . $apiKey,  // config('cpaas.telnyx.api_key')
        'Accept' => 'application/json',
        'Content-Type' => 'application/json',
    ],
]);
```

✅ Good: API key stored in config (not hardcoded), transmitted over HTTPS.

---

## 6. Official SDK Security Recommendations vs Implementation

### 6.1 Comparison Table

| Security Area | Telnyx Recommendation | Z360 Implementation | Gap? |
|--------------|----------------------|---------------------|------|
| **Webhook Verification** | Verify ED25519 signatures using `telnyx-signature-ed25519` and `telnyx-timestamp` headers with Telnyx public key | No verification implemented | **Critical Gap** |
| **Credential Storage (iOS)** | Use Keychain for sensitive credentials | ✅ Keychain with `kSecAttrAccessibleWhenUnlocked` | No gap |
| **Credential Storage (Android)** | Use EncryptedSharedPreferences or Android Keystore | ⚠️ Plain SharedPreferences (Telnyx SDK limitation) | **SDK Limitation** |
| **JWT vs SIP Credentials** | Prefer JWT tokens (short-lived, revocable) | Web: JWT ✅ / Mobile: SIP credentials (SDK bug workaround) | **Workaround** |
| **JWT Token TTL** | Short-lived tokens with refresh | 10-hour TTL via `TelephonyCredential::token()` | Acceptable |
| **API Key Security** | Store API key server-side only | ✅ Stored in server config, never exposed to client | No gap |
| **Credential Rotation** | Rotate credentials periodically | Per-device credentials with 30-day expiry (`credential_expires_at`) | ✅ Implemented |
| **Push Token Management** | Register/deregister tokens on auth events | ✅ Register on login, deregister on logout | No gap |

### 6.2 Telnyx Webhook Verification (What Should Be Implemented)

Telnyx sends two headers with every webhook:
- `telnyx-signature-ed25519` — ED25519 signature of the payload
- `telnyx-timestamp` — Unix timestamp to prevent replay attacks

The Telnyx PHP SDK provides `\Telnyx\Webhook::constructEvent()` for verification, but it is not used anywhere in the Z360 codebase.

### 6.3 Android SDK Credential Storage Limitation

The Telnyx Android SDK (`com.telnyx.webrtc.common.TelnyxCommon`) uses plain `SharedPreferences` internally. Z360 cannot change this without:
1. Forking the Telnyx Android SDK
2. Submitting a PR to Telnyx to use `EncryptedSharedPreferences`
3. Implementing a wrapper that encrypts before passing to the SDK

This is documented as a known SDK limitation. The Z360 team's own `Z360VoipStore` correctly separates non-credential data into its own SharedPreferences file, which is good practice.

---

## 7. Risk Assessment Summary

### Critical (Immediate attention required)

| # | Finding | Impact | Location |
|---|---------|--------|----------|
| C1 | **SIP passwords stored in plaintext in database** | Database breach exposes all SIP credentials | `UserTelnyxTelephonyCredential`, `UserDeviceToken` models |
| C2 | **No Telnyx webhook signature verification** | Attackers can forge webhook events (call manipulation, message injection) | `routes/webhooks.php`, all Telnyx controllers |

### High (Should be addressed soon)

| # | Finding | Impact | Location |
|---|---------|--------|----------|
| H1 | **Android SIP credentials in plain SharedPreferences** | Rooted device or ADB backup exposes credentials | Telnyx SDK `ProfileManager` via `TelnyxCommon` |
| H2 | **SIP passwords in API responses** | Passwords visible in network logs, proxy logs, browser devtools | `VoipCredentialController`, `DeviceTokenController` |
| H3 | **Session data not encrypted** | Database access reveals session contents | `config/session.php` (`encrypt = false`) |

### Medium (Should be planned)

| # | Finding | Impact | Location |
|---|---------|--------|----------|
| M1 | **CSRF disabled for API routes** | Potential CSRF attacks (mitigated by SameSite=lax) | `bootstrap/app.php:66-72` |
| M2 | **No FCM token validation** | Fake tokens could be registered | `DeviceTokenController::store()` |
| M3 | **No rate limiting on VoIP credential endpoints** | Credential endpoint abuse | `routes/api.php:22-25` |
| M4 | **Android has no session expiry for VoIP** | Credentials persist indefinitely | `Z360FCMService.isUserLoggedIn()` |
| M5 | **SIP username logged without redaction** | Username visible in logcat during org switch | `IncomingCallActivity.kt:5053` |

### Low (Acceptable risk / minor improvements)

| # | Finding | Impact | Location |
|---|---------|--------|----------|
| L1 | **30-day mobile session lifetime** | Extended window for session hijacking | `config/session.php:37` |
| L2 | **iOS Keychain not device-only** | Credentials could appear in iCloud backup | `KeychainManager.swift` (uses `kSecAttrAccessibleWhenUnlocked` not `...ThisDeviceOnly`) |
| L3 | **VoIP token date as session proxy** | Imprecise session validity check on iOS | `AppDelegate.swift:10360` |

---

## 8. Remediation Priorities

### Priority 1 — Critical (Sprint 1)

1. **Encrypt SIP passwords at rest in database**
   - Add `'sip_password' => 'encrypted'` to `$casts` in both `UserTelnyxTelephonyCredential` and `UserDeviceToken`
   - Run data migration to encrypt existing plaintext passwords
   - Estimated effort: Low

2. **Implement Telnyx webhook signature verification**
   - Create middleware using `\Telnyx\Webhook::constructEvent()` or manual ED25519 verification
   - Verify `telnyx-signature-ed25519` and `telnyx-timestamp` headers
   - Apply to all `webhooks/cpaas/telnyx/*` routes
   - Add replay protection (reject timestamps older than 5 minutes)
   - Estimated effort: Medium

### Priority 2 — High (Sprint 2)

3. **Add rate limiting to VoIP API endpoints**
   - Apply `throttle:10,1` to `/api/voip/*` and `/api/device-tokens` routes
   - Estimated effort: Low

4. **Investigate Android EncryptedSharedPreferences**
   - Evaluate wrapping Telnyx SDK credential storage
   - Consider filing Telnyx SDK issue for native encrypted storage support
   - Estimated effort: High (SDK limitation)

5. **Minimize credential exposure in API responses**
   - Consider returning SIP credentials only on initial device registration (not on every request)
   - Evaluate if JWT-only auth is viable once Android SDK bug is fixed
   - Estimated effort: Medium

### Priority 3 — Medium (Backlog)

6. **Enable session encryption** (`SESSION_ENCRYPT=true`)
7. **Add Android session expiry check** (mirror iOS 30-day pattern)
8. **Add FCM token validation** (verify token format/structure)
9. **Redact SIP username in org switch log** (`IncomingCallActivity.kt:5053`)
10. **Consider `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`** for iOS Keychain

---

*Document generated: 2026-02-08*
*Research scope: Z360 VoIP authentication and security analysis across Web, iOS, Android, and Laravel backend*
