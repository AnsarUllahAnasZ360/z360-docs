---
title: Credential Lifecycle
---

# Credential Lifecycle: Complete Trace Across All Platforms

## Executive Summary

Z360's VoIP credential system uses a **two-tier architecture**: org-level credentials (for web JWT generation) and per-device credentials (for simultaneous ring across all devices). Credentials are Telnyx Telephony Credentials bound to a single Credential Connection, created via the Telnyx API, stored in PostgreSQL (`user_telnyx_telephony_credentials` and `user_device_tokens` tables), and consumed by three client platforms (Web, iOS, Android) using different authentication patterns.

---

## 1. Infrastructure Foundation

### 1.1 Telnyx Resource Hierarchy

Z360 provisions infrastructure resources via `php artisan telnyx:setup`:

```
Telnyx Account
 |
 +-- Outbound Voice Profile (OVP)
 |    - Config: cpaas.telnyx.ovp_id
 |
 +-- Credential Connection
 |    - Config: cpaas.telnyx.credential_connection_id
 |    - Webhook: /webhooks/cpaas/telnyx/credential
 |    - All Telephony Credentials are children of this connection
 |    |
 |    +-- Telephony Credential (org-level, per user+org)
 |    +-- Telephony Credential (device-level, per device)
 |    +-- ... (many)
 |
 +-- Call Control Application
 |    - Config: cpaas.telnyx.call_control_id
 |    - Webhook: /webhooks/cpaas/telnyx/inbound
 |
 +-- Notification Profile + Channel
      - Config: cpaas.telnyx.notifications_profile_id
```

**Source**: `app/Console/Commands/TelnyxSetup.php`, `config/cpaas.php`

### 1.2 Credential Connection Setup

The Credential Connection is created with:
- `call_parking_enabled: true`
- `sip_uri_calling_preference: internal`
- Webhook URLs for call events
- References the OVP for outbound routing

**Source**: `app/Console/Commands/TelnyxSetup.php:147-189`

### 1.3 Environment Configuration

```php
// config/cpaas.php
return [
    'telnyx' => [
        'api_key'                  => env('TELNYX_API_KEY'),
        'call_control_id'          => env('TELNYX_CALL_CONTROL_APP_ID'),
        'ovp_id'                   => env('TELNYX_OUTBOUND_VOICE_PROFILE_ID'),
        'credential_connection_id' => env('TELNYX_CREDENTIAL_CONNECTION_ID'),
        'notifications_profile_id' => env('TELNYX_NOTIFICATIONS_PROFILE_ID'),
    ],
];
```

**Source**: `config/cpaas.php:1-11`

---

## 2. Credential Types

### 2.1 Org-Level Credential (`UserTelnyxTelephonyCredential`)

**Purpose**: Per-user, per-org credential. Primarily used for web JWT token generation. NOT dialed for incoming calls (to avoid phantom SIP legs).

**Table**: `user_telnyx_telephony_credentials`

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint | Primary key |
| `user_id` | FK → users | Owning user |
| `organization_id` | FK → organizations | Tenant scope |
| `credential_id` | string (unique) | Telnyx credential ID |
| `connection_id` | string (nullable) | Credential Connection ID |
| `sip_username` | string (nullable) | SIP username |
| `sip_password` | string (nullable) | SIP password |
| `created_at` / `updated_at` | timestamps | |

**Schema evolution**:
1. `2025_09_12_000500` — Created with `credential_id` (unique), `sip_username` (unique), `sip_password`
2. `2025_09_12_001000` — Added `organization_id`, dropped `sip_username` and `sip_password` (multi-tenant refactor)
3. `2025_09_17_000200` — Re-added `sip_username` (nullable) and `sip_password` (nullable)
4. `2026_01_23_053936` — Added `connection_id` (nullable)

**Source**: Migrations in `database/migrations/`, Model at `app/Models/UserTelnyxTelephonyCredential.php`

### 2.2 Device-Level Credential (stored on `UserDeviceToken`)

**Purpose**: Per-device SIP credential enabling simultaneous ring. Each device (phone, tablet, browser) gets its own SIP identity so Telnyx can fork incoming SIP INVITEs to all devices.

**Table**: `user_device_tokens` (SIP fields added later)

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint | Primary key |
| `user_id` | FK → users | Owning user |
| `organization_id` | FK → organizations | Tenant scope |
| `device_id` | string | Unique device identifier |
| `fcm_token` | string | FCM/APNs push token |
| `platform` | enum(android,ios,web) | Device platform |
| `device_name` | string (nullable) | Human-readable device name |
| `app_version` | string (nullable) | App version |
| `last_active_at` | datetime | Last registration/heartbeat |
| `telnyx_credential_id` | string (nullable) | Telnyx credential ID for this device |
| `sip_username` | string (nullable, indexed) | Per-device SIP username |
| `sip_password` | string (nullable) | Per-device SIP password |
| `connection_id` | string (nullable) | Credential Connection ID (cached) |
| `credential_expires_at` | datetime (nullable) | Expiration (set to now()+30 days on creation) |
| `created_at` / `updated_at` | timestamps | |

**Source**: `app/Models/UserDeviceToken.php:10-24`, migration `2026_01_23_170000`, migration `2026_02_01_000000`

### 2.3 Relationship Between the Two

- **Org-level credential**: Created by `CPaaSService::handleCredentials()`. One per user per org. Used only for generating JWT tokens for web WebRTC authentication. NOT dialed during incoming call routing.
- **Device-level credential**: Created by `CPaaSService::createDeviceCredential()`. One per device registration. These are the SIP identities that Telnyx dials during incoming call routing.

The User model provides a tenant-scoped relationship:

```php
// app/Models/User.php:117-121
public function telnyxCredential(): HasOne
{
    return $this->hasOne(UserTelnyxTelephonyCredential::class)
        ->where('organization_id', CurrentTenant::id());
}
```

**Source**: `app/Models/User.php:117-121`

---

## 3. Device Registration Flow (All Platforms)

### 3.1 Sequence Diagram

```
Client (Web/iOS/Android)         Laravel Backend               Telnyx API
        |                              |                          |
        |  POST /api/device-tokens     |                          |
        |  {device_id, fcm_token,      |                          |
        |   platform, device_name}     |                          |
        |----------------------------->|                          |
        |                              |                          |
        |                   [1. Validate via StoreDeviceTokenRequest]
        |                              |                          |
        |                   [2. Web dedup: delete other web devices]
        |                              |                          |
        |                   [3. updateOrCreate UserDeviceToken    |
        |                       keyed by user+org+device_id]     |
        |                              |                          |
        |                   [4. handleCredentials(user)]          |
        |                              |   POST telephony_credentials
        |                              |   {name, connection_id}  |
        |                              |------------------------->|
        |                              |   {credential_id,        |
        |                              |    sip_username,          |
        |                              |    sip_password}          |
        |                              |<-------------------------|
        |                              |                          |
        |                   [5. Create org-level credential       |
        |                       in user_telnyx_telephony_credentials]
        |                              |                          |
        |                   [6. If no per-device SIP creds yet:]  |
        |                              |                          |
        |                              |   createDeviceCredential()|
        |                              |   POST telephony_credentials
        |                              |   {name, connection_id}  |
        |                              |------------------------->|
        |                              |   {credential_id,        |
        |                              |    sip_username,          |
        |                              |    sip_password}          |
        |                              |<-------------------------|
        |                              |                          |
        |                   [7. Update user_device_tokens row     |
        |                       with SIP creds + 30-day expiry]   |
        |                              |                          |
        |                   [8. Generate JWT from device credential]
        |                              |   GET telephony_credentials/{id}
        |                              |   .token()               |
        |                              |------------------------->|
        |                              |   JWT (10h TTL)          |
        |                              |<-------------------------|
        |                              |                          |
        |                   [9. Clean stale same-platform devices |
        |                       inactive 7+ days, delete Telnyx creds]
        |                              |                          |
        |  {success, sip_credentials:  |                          |
        |   {sip_username, sip_password,|                         |
        |    jwt_token}}               |                          |
        |<-----------------------------|                          |
```

### 3.2 Backend: `DeviceTokenController::store()`

The central endpoint for all platforms: `POST /api/device-tokens`

**Route**: `routes/api.php:16` — requires middleware: `web`, `auth`, `set-current-tenant`

**Validation** (`StoreDeviceTokenRequest`):
```php
// app/Http/Requests/Api/StoreDeviceTokenRequest.php:30-38
'device_id'    => 'required|string|max:255',
'fcm_token'    => 'required|string|max:500',
'platform'     => 'required|in:android,ios,web',
'device_name'  => 'nullable|string|max:255',
'app_version'  => 'nullable|string|max:50',
```

Notable: `prepareForValidation()` aliases `voip_token` and `apns_voip_token` → `fcm_token` (lines 9-17).

**Key steps in `store()`** (`app/Http/Controllers/Api/DeviceTokenController.php:42-177`):

1. **Web platform dedup** (lines 57-81): If platform is `web`, deletes other web devices for this user+org. Deletes their Telnyx credentials from Telnyx API first.

2. **Upsert device token** (lines 84-97): `updateOrCreate` keyed by `{user_id, organization_id, device_id}`. Updates `fcm_token`, `platform`, `device_name`, `app_version`, `last_active_at`.

3. **Org-level credential** (line 103): Calls `CPaaSService::handleCredentials($user)` which finds-or-creates the `UserTelnyxTelephonyCredential` for this user+org and returns a JWT.

4. **Per-device credential** (lines 107-118): If the device token row has no `sip_username`, deletes old Telnyx credential (if any), then calls `CPaaSService::createDeviceCredential()`.

5. **JWT generation** (lines 119-129): If device has `telnyx_credential_id`, generates a per-device JWT via `CPaaSService::getDeviceJwt()`. Falls back to org-level JWT.

6. **Stale cleanup** (lines 134-159): Removes same-platform devices for this user+org that haven't been active in 7+ days. Deletes their Telnyx credentials.

7. **Response** (lines 167-176):
```json
{
    "success": true,
    "data": {
        "id": 42,
        "device_id": "web_abc123...",
        "platform": "web",
        "sip_credentials": {
            "sip_username": "Device-web_abc123_xR4m...",
            "sip_password": "...",
            "jwt_token": "eyJ..."
        }
    }
}
```

### 3.3 Backend: `CPaaSService::handleCredentials()`

**Source**: `app/Services/CPaaSService.php:161-207`

Creates org-level credentials and returns a JWT:

1. Checks `credential_connection_id` config exists
2. Gets current tenant ID via `CurrentTenant::id()`
3. Finds existing `UserTelnyxTelephonyCredential` for `(organization_id, user_id)`
4. If not found, calls Telnyx API:
   ```php
   $telephonyCredential = \Telnyx\TelephonyCredential::create([
       'name' => 'Org-{orgId}_{random}',
       'connection_id' => $connectionId,
   ]);
   ```
5. Stores in DB: `credential_id`, `connection_id`, `sip_username`, `sip_password`
6. Retrieves credential and generates JWT via `$cred->token()` (10h TTL / 36000 seconds)

### 3.4 Backend: `CPaaSService::createDeviceCredential()`

**Source**: `app/Services/CPaaSService.php:213-235`

Creates per-device credentials:

```php
$name = "Device-{$deviceToken->device_id}_" . Str::random(8);
$credential = \Telnyx\TelephonyCredential::create([
    'name' => $name,
    'connection_id' => $connectionId,
]);

$deviceToken->update([
    'telnyx_credential_id' => $credential->id,
    'sip_username'         => $credential->sip_username,
    'sip_password'         => $credential->sip_password,
    'connection_id'        => $connectionId,
    'credential_expires_at' => now()->addDays(30),
]);
```

### 3.5 Backend: `CPaaSService::getDeviceJwt()`

**Source**: `app/Services/CPaaSService.php:255-265`

```php
$cred = \Telnyx\TelephonyCredential::retrieve($deviceToken->telnyx_credential_id);
$token = $cred->token(); // Returns JWT string
```

### 3.6 Backend: `CPaaSService::deleteTelnyxCredential()`

**Source**: `app/Services/CPaaSService.php:240-250`

Deletes via `DELETE /v2/telephony_credentials/{id}`. Logs warning on failure but doesn't throw.

---

## 4. Platform-Specific Credential Flows

### 4.1 Web Platform

#### 4.1a Initial Page Load (Server-Side JWT)

On every Inertia page load, `HandleInertiaRequests` middleware provides an optional JWT:

```php
// app/Http/Middleware/HandleInertiaRequests.php:70
'cpaas.telnyx.jwt' => Inertia::optional(fn () => CPaaSService::handleCredentials($request->user())),
```

This is the **fallback JWT** — used if per-device registration hasn't completed yet.

#### 4.1b Per-Device Registration (`useWebVoipCredentials`)

**Source**: `resources/js/hooks/useWebVoipCredentials.ts`

1. **Device ID**: Generated once per browser, stored in `localStorage` as `z360_browser_device_id` with format `web_{crypto.randomUUID()}` (line 9-19).

2. **Registration**: On mount (when `userId` and `organizationId` change), calls `POST /api/device-tokens`:
   ```json
   {
       "device_id": "web_abc123...",
       "fcm_token": "web_web_abc123...",
       "platform": "web",
       "device_name": "Web Browser (Chrome)"
   }
   ```
   Note: `fcm_token` is a placeholder — web doesn't use FCM for push.

3. **Dedup guard**: Uses `registrationKeyRef` to skip re-registration for same `userId_organizationId` combo (lines 80-85).

4. **Token selection** (line 161):
   ```typescript
   const loginToken = (isWeb() ? credentials.jwtToken : null) || fallbackJwt || 'undefined';
   ```
   Priority: per-device JWT → fallback server-side JWT → string 'undefined'.

5. **Logout cleanup** (lines 141-153): On logout (`userId` becomes null), sends `DELETE /api/device-tokens/{deviceId}` as best-effort.

#### 4.1c TelnyxRTCProvider Initialization

**Source**: `resources/js/layouts/app-layout.tsx:137-139`

```tsx
<TelnyxRTCProvider credential={{ login_token: webLoginToken }}>
    {voipContent}
</TelnyxRTCProvider>
```

Web uses JWT-based auth with `@telnyx/react-client`. The JWT authorizes this specific SIP identity on the Telnyx WebSocket.

### 4.2 iOS Platform

#### 4.2a Device Registration (Login)

**Source**: `resources/js/plugins/use-telnyx-voip.ts:315-395`

The `registerAndConnect()` flow:

1. `TelnyxVoip.requestVoipPermissions()` — requests microphone + CallKit permissions
2. `TelnyxVoip.getDeviceId()` — gets native device ID
3. `TelnyxVoip.getFcmTokenWithWait({ maxWaitMs: 5000 })` — gets PushKit VoIP token (with 5s wait for PushKit delivery race condition on real devices)
4. `POST /api/device-tokens` — same endpoint as web, platform: `ios`
5. `TelnyxVoip.connect({ sipUsername, sipPassword })` — connects native SDK with SIP credentials

**CRITICAL**: iOS uses **SIP credential auth, not JWT**. Comment at line 372: "CRITICAL: Always use SIP credentials (JWT token auth is broken in Android SDK 3.3.0)".

#### 4.2b Native Connection (`TelnyxService.connect()`)

**Source**: `ios/App/App/VoIP/Services/TelnyxService.swift:75-108`

```swift
let txConfig = TxConfig(
    sipUser: sipUser,
    password: password,
    pushDeviceToken: pushToken,
    logLevel: .warning,
    customLogger: TelnyxSDKLogger(),
    forceRelayCandidate: true,       // Avoids iOS "Local Network Access" dialog
    enableQualityMetrics: true
)
let serverConfig = TxServerConfiguration()
try txClient?.connect(txConfig: txConfig, serverConfiguration: serverConfig)
```

#### 4.2c Credential Persistence (`VoipStore`)

**Source**: `ios/App/App/VoIP/Services/VoipStore.swift:170-213`

iOS stores SIP credentials in **Keychain** via `KeychainManager`:

```swift
func saveCredentials(_ credentials: SIPCredentials) throws {
    try keychain.save(credentials.sipUsername, forKey: Keys.sipUsername)
    try keychain.save(credentials.sipPassword, forKey: Keys.sipPassword)
    // Also stores callerIdName and callerIdNumber
}
```

Keychain keys: `z360_sip_username`, `z360_sip_password`, `z360_caller_id_name`, `z360_caller_id_number`

#### 4.2d Push-Based Reconnection

**Source**: `ios/App/App/VoIP/Services/TelnyxService.swift:349-382`

When a VoIP push arrives (PushKit), iOS reconnects the SDK with stored credentials:

```swift
func processVoIPNotification(
    sipUser: String,
    password: String,
    pushToken: String?,
    metadata: [String: Any]
) throws {
    let txConfig = TxConfig(
        sipUser: sipUser,
        password: password,
        pushDeviceToken: pushToken,
        ...
    )
    let serverConfig = TxServerConfiguration(pushMetaData: metadata)
    try txClient?.processVoIPNotification(
        txConfig: txConfig,
        serverConfiguration: serverConfig,
        pushMetaData: metadata
    )
}
```

The credentials are read from Keychain → passed to `processVoIPNotification()`. This is critical because PushKit wakes the app in background where there's no active SDK connection.

#### 4.2e Logout Cleanup

**Source**: `resources/js/plugins/use-telnyx-voip.ts:401-442`

`unregisterAndDisconnect()`:
1. Gets `deviceId` from native
2. `DELETE /api/device-tokens/{deviceId}` — removes backend record
3. `TelnyxVoip.disconnect({ clearCredentials: true })` — disconnects SDK and clears Keychain

iOS plugin handles `clearCredentials`:
```swift
// ios/App/App/VoIP/TelnyxVoipPlugin.swift:178-186
if clearCredentials {
    Task {
        await voipStore.clearAll()
    }
}
```

### 4.3 Android Platform

#### 4.3a Device Registration (Login)

Same JavaScript flow as iOS (`use-telnyx-voip.ts:315-395`). Calls same `POST /api/device-tokens` endpoint with `platform: android`.

#### 4.3b Native Connection (`TelnyxVoipPlugin.connect()`)

**Source**: `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:119-179`

```kotlin
val profile = Profile(
    sipUsername = sipUsername,
    sipPass = sipPassword,
    callerIdName = callerIdName,
    callerIdNumber = callerIdNumber,
    fcmToken = TokenHolder.fcmToken,
    isUserLoggedIn = true
)
telnyxViewModel.credentialLogin(
    viewContext = context,
    profile = profile,
    txPushMetaData = null,
    autoLogin = true
)
```

**BUG-003 FIX** (line 122-130): If SDK is already connected (from push flow), skips re-connect to prevent killing the native socket that was established by FCM flow.

**BUG-006 FIX** (line 113-117): Waits for `ClientLoggedIn` state before resolving the promise (previously resolved immediately, causing race conditions).

#### 4.3c Credential Persistence

Android uses `ProfileManager` from the Telnyx SDK which stores profiles in SharedPreferences. On `disconnect({ clearCredentials: true })`:

```kotlin
// android/.../TelnyxVoipPlugin.kt:182-194
if (clearCredentials) {
    clearTelnyxProfiles()
    store.clearAll()
}
```

`clearTelnyxProfiles()` iterates all SDK profiles and deletes them by SIP username or token.

#### 4.3d Push-Based Reconnection

Android uses FCM data messages. When a push arrives, the `TelnyxVoipPlugin.reconnectWithCredentials()` method is available:

```kotlin
// android/.../TelnyxVoipPlugin.kt:453-484
val profile = Profile(
    sipUsername = sipUsername,
    sipPass = sipPassword,
    ...
)
telnyxViewModel.credentialLogin(
    viewContext = context,
    profile = profile,
    txPushMetaData = null,
    autoLogin = true
)
```

---

## 5. Credential Usage During Inbound Calls

### 5.1 How Inbound Calls Route to Devices

**Source**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` (around line 264-297)

When a PSTN call arrives:

1. Call Control webhook triggers `transferToUser()`
2. Backend collects per-device SIP usernames from `user_device_tokens`:
   ```php
   $sipDestinations = UserDeviceToken::where('user_id', $user->id)
       ->whereNotNull('sip_username')
       ->where('last_active_at', '>=', now()->subDay())
       ->pluck('sip_username')
       ->toArray();
   ```
3. **Critical**: The org-level credential `$sipUsername` is explicitly NOT dialed:
   ```php
   // NOTE: Org-level credential ($sipUsername) is NOT dialed — it exists
   // only for web JWT auth. Dialing it creates a phantom SIP leg that
   // answers first and steals the bridge.
   ```
4. Each device SIP username becomes a SIP INVITE target, enabling simultaneous ring

### 5.2 Push Notification (Parallel Channel)

In parallel with SIP INVITEs, the backend sends push notifications:
- **Android**: FCM data messages via `PushNotificationService::sendIncomingCallPush()`
- **iOS**: APNs VoIP pushes via `ApnsVoipService`
- **Web**: Reverb WebSocket broadcast

**Source**: `app/Services/PushNotificationService.php:32-40`

---

## 6. Web Credential Flow (Detailed)

### 6.1 Dual-Auth Mechanism

Web has a unique dual-auth approach:

1. **Server-side JWT (fallback)**: Generated on every Inertia page load via `HandleInertiaRequests` middleware calling `CPaaSService::handleCredentials()`. Cached client-side with 30-minute TTL by `useSessionCache`.

2. **Per-device JWT (primary)**: Generated during `POST /api/device-tokens` registration. This JWT is bound to the per-device credential, not the org-level credential.

### 6.2 Token Priority

```typescript
// resources/js/hooks/useWebVoipCredentials.ts:161
const loginToken = (isWeb() ? credentials.jwtToken : null) || fallbackJwt || 'undefined';
```

1. Per-device JWT from `POST /api/device-tokens` response → preferred
2. Server-side JWT from `HandleInertiaRequests` → fallback
3. String `'undefined'` → prevents crash, TelnyxRTCProvider won't connect

### 6.3 Org Switch (Web)

When user switches organizations:
- `useWebVoipCredentials` detects `organizationId` change via `useEffect` dependency
- Re-registers with `POST /api/device-tokens` for new org
- Gets new per-device SIP credentials + JWT for new org
- `TelnyxRTCProvider` re-initializes with new `loginToken`

---

## 7. VoIP Credentials API (`VoipCredentialController`)

### 7.1 `GET /api/voip/credentials`

**Source**: `app/Http/Controllers/Api/VoipCredentialController.php:22-88`

Returns org-level SIP credentials + JWT for the current user+org. Used when the app needs fresh credentials (e.g., after org switch on native).

Response:
```json
{
    "success": true,
    "data": {
        "sip_username": "...",
        "sip_password": "...",
        "jwt_token": "eyJ...",
        "caller_id_name": "John Doe",
        "caller_id_number": "+18005551234",
        "organization_id": 1,
        "organization_name": "Acme Corp"
    }
}
```

### 7.2 `POST /api/voip/switch-org`

**Source**: `app/Http/Controllers/Api/VoipCredentialController.php:109-218`

Cross-org credential flow for native platforms:

1. Validates user has access to target organization
2. Calls `$organization->switchTo()` — changes session tenant
3. Updates `$user->last_organization_id`
4. Calls `CPaaSService::handleCredentials()` scoped to new org
5. Returns new org-level SIP credentials + JWT

**Used by**: iOS `OrganizationSwitcher`, Android `OrgSwitchHelper`

---

## 8. Multi-Organization Credentials

### 8.1 Architecture

Each organization has its own set of credentials:

- **Org-level**: One `UserTelnyxTelephonyCredential` per (user_id, organization_id)
- **Device-level**: One set of SIP creds per `UserDeviceToken` per (user_id, organization_id, device_id)

All credentials share the **same `credential_connection_id`** from the global config. There is no per-org Credential Connection.

### 8.2 Organization Switch Flow (Cross-Org Incoming Call)

When a call arrives for Org B but the user's device is connected to Org A:

#### iOS Flow

**Source**: `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift:171-253`

1. Capture original org context (for rollback on failure)
2. `POST /api/voip/switch-org` with WebView cookies for auth
3. Store new SIP credentials in Keychain
4. Update VoipStore org context
5. Disconnect TelnyxService → reconnect with new credentials
6. Wait for `isClientReady()` (3s timeout, 50ms poll)
7. **On failure**: Restore original org context, credentials, and org ID

Constraints: Must complete within **5-second CallKit deadline** (4.5s safety margin).

#### Android Flow

**Source**: `android/app/src/main/java/com/z360/app/voip/OrgSwitchHelper.kt:39-136`

1. Get WebView cookies from `CookieManager`
2. `POST /api/voip/switch-org` (10s timeout)
3. Parse response for SIP credentials
4. Return `OrgSwitchCredentials` to caller
5. Caller reconnects via `TelnyxVoipPlugin.reconnectWithCredentials()`

### 8.3 Credential Isolation

When user switches org, the **device-level credentials change** because they're scoped to `(user_id, organization_id, device_id)`. The next `POST /api/device-tokens` call creates credentials for the new org. However, the org switch during an incoming call uses org-level credentials from `/api/voip/switch-org`, not per-device credentials.

**GAP**: During cross-org call answer, the native SDK reconnects with org-level SIP credentials (from `VoipCredentialController::switchOrg()`), not per-device credentials. This is because the device hasn't re-registered with the new org yet.

---

## 9. Credential Expiry and Rotation

### 9.1 Telnyx Telephony Credentials

**Telnyx SIP credentials do not expire** on the Telnyx side. They remain valid until explicitly deleted.

However, Z360 sets a local `credential_expires_at` of **30 days** on device tokens:

```php
// app/Services/CPaaSService.php:231
'credential_expires_at' => now()->addDays(30),
```

**GAP**: This field is set but **never checked**. No code reads `credential_expires_at` to enforce rotation. The expiry column exists but is inert.

### 9.2 JWT Token Expiry

JWTs have a **10-hour TTL** (36,000 seconds), hardcoded in the Telnyx API response (controlled by Telnyx, not configurable).

**Web handling**: `useSessionCache` caches the JWT for 30 minutes, then the page reload triggers a new JWT via `HandleInertiaRequests` middleware.

**Native handling**: Native platforms use SIP credentials directly (not JWT), so JWT expiry is irrelevant for iOS/Android.

### 9.3 FCM Token Refresh

**Source**: `resources/js/hooks/use-push-notifications.ts`

- Stored in `localStorage` as `z360_fcm_token`
- Re-sent to backend if token changes OR if >24 hours since last send (line 45, 125)
- Backend `DeviceTokenController` (Inertia route) upserts by `fcm_token` field

**Note**: There are **two DeviceTokenControllers**:
1. `App\Http\Controllers\Api\DeviceTokenController` — REST API, keyed by `(user_id, org_id, device_id)`, returns SIP credentials
2. `App\Http\Controllers\DeviceTokenController` — Inertia route, keyed by `fcm_token`, for push notification registration only

### 9.4 Stale Device Cleanup

**Three cleanup mechanisms**:

1. **On registration** (`Api\DeviceTokenController::store()` lines 134-159): Deletes same-platform devices inactive for 7+ days. Deletes their Telnyx credentials.

2. **Scheduled command** (`CleanStaleDeviceTokens`, `app/Console/Commands/CleanStaleDeviceTokens.php`): Removes tokens inactive for 60 days (configurable via `--days`). **GAP**: Does NOT delete Telnyx credentials before deleting DB rows — orphans credentials on Telnyx.

3. **Web dedup** (`Api\DeviceTokenController::store()` lines 57-81): Enforces max 1 web device per user+org. Deletes extra web devices and their Telnyx credentials.

---

## 10. Logout and Credential Teardown

### 10.1 Web Logout

**Source**: `app/Http/Controllers/Auth/AuthenticatedSessionController.php:108-131`

```php
// Clean up web device tokens and their Telnyx credentials before logout
$webDevices = UserDeviceToken::where('user_id', $user->id)
    ->where('platform', 'web')
    ->get();

foreach ($webDevices as $device) {
    if ($device->telnyx_credential_id) {
        CPaaSService::deleteTelnyxCredential($device->telnyx_credential_id);
    }
    $device->delete();
}

// Delete specific FCM token if provided
if ($request->filled('fcm_token') && Auth::check()) {
    Auth::user()->deviceTokens()
        ->where('fcm_token', $request->input('fcm_token'))
        ->delete();
}
```

Also, `useWebVoipCredentials` sends `DELETE /api/device-tokens/{deviceId}` on user ID change to null (lines 141-153).

### 10.2 Native Logout

**Source**: `resources/js/plugins/use-telnyx-voip.ts:401-442`

`unregisterAndDisconnect()`:
1. `TelnyxVoip.getDeviceId()` → gets native device ID
2. `DELETE /api/device-tokens/{deviceId}` → removes backend record + Telnyx credential
3. `TelnyxVoip.disconnect({ clearCredentials: true })` → disconnects SDK

iOS clears: Keychain credentials + all VoipStore data
Android clears: ProfileManager profiles + VoipStore data

### 10.3 Device Removal (`Api\DeviceTokenController::destroy()`)

**Source**: `app/Http/Controllers/Api/DeviceTokenController.php:183-212`

1. Finds device by `(device_id, user_id, organization_id)`
2. Deletes Telnyx credential first (before DB row)
3. Deletes DB row

---

## 11. Ghost Credential Analysis

### 11.1 What Are Ghost Credentials?

Ghost credentials are Telnyx Telephony Credentials that exist on Telnyx's infrastructure but have no corresponding record in Z360's database, or vice versa. They waste Telnyx resources and can cause phantom SIP legs.

### 11.2 Sources of Ghost Credentials

#### 11.2a `CleanStaleDeviceTokens` Command

**Source**: `app/Console/Commands/CleanStaleDeviceTokens.php:14-36`

```php
$deleted = UserDeviceToken::where(function ($query) use ($days) {
    $query->where('last_active_at', '<', now()->subDays($days))
        ->orWhere(function ($q) use ($days) {
            $q->whereNull('last_active_at')
                ->where('created_at', '<', now()->subDays($days));
        });
})->delete();
```

**BUG**: This bulk-deletes device tokens without first deleting their Telnyx credentials. Every deleted row with a `telnyx_credential_id` becomes an orphaned credential on Telnyx.

#### 11.2b Race Condition: Concurrent Device Registration

If a user opens multiple browser tabs simultaneously (or app restarts rapidly), multiple `POST /api/device-tokens` requests can race:

1. Request A: `updateOrCreate` finds no existing record, creates new
2. Request B: `updateOrCreate` finds no existing record (concurrent), creates new
3. Request A: Creates Telnyx credential
4. Request B: Creates another Telnyx credential

The `updateOrCreate` uses `(user_id, organization_id, device_id)` as key, so duplicate DB rows are unlikely, but the credential creation at Telnyx isn't atomic with the DB update.

#### 11.2c Telnyx API Failure After Creation

In `createDeviceCredential()`:
```php
$credential = \Telnyx\TelephonyCredential::create([...]);  // Telnyx creates it
$deviceToken->update([...]);  // If this fails, credential exists on Telnyx but not in DB
```

If the `update()` fails (DB error, timeout), the Telnyx credential exists but the DB row doesn't reference it.

#### 11.2d Re-Registration with Old Credential

In `DeviceTokenController::store()` lines 107-118:
```php
if (! $token->sip_username) {
    if ($oldCredentialId) {
        CPaaSService::deleteTelnyxCredential($oldCredentialId);  // May fail silently
    }
    CPaaSService::createDeviceCredential($user, $token);
}
```

If `deleteTelnyxCredential()` fails (it catches and logs but doesn't throw), the old credential persists on Telnyx while a new one is created.

#### 11.2e Org-Level Credentials Never Deleted

`UserTelnyxTelephonyCredential` records are created by `handleCredentials()` but **never explicitly deleted**. They rely on the `CASCADE ON DELETE` from the users table foreign key. If a user is removed from an organization (but not deleted from the system), their org-level credentials remain on Telnyx indefinitely.

#### 11.2f FCM-Keyed DeviceTokenController

The Inertia-route `DeviceTokenController::store()` at `app/Http/Controllers/DeviceTokenController.php:14-33` uses `fcm_token` as the upsert key (not `device_id`). It does NOT create Telnyx credentials but can create `UserDeviceToken` rows without SIP credentials, which then get Telnyx credentials on the next API DeviceTokenController registration.

### 11.3 Duplicate Credential Count Summary

| Source | Frequency | Impact |
|--------|-----------|--------|
| `CleanStaleDeviceTokens` bulk delete | Every scheduled run | High — every deleted row with SIP creds = orphan |
| Concurrent registration race | Rare (requires exact timing) | Low — same device_id prevents DB duplicates |
| Telnyx API success + DB failure | Rare | Medium — orphaned credential on Telnyx |
| Failed credential deletion | On Telnyx API errors | Medium — old credential persists |
| Org-level never deleted | Continuous | High — grows indefinitely |

---

## 12. End-to-End Credential Diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │                  TELNYX CLOUD                    │
                    │                                                  │
                    │  Credential Connection (1 per deployment)        │
                    │  ├─ Telephony Cred: Org-1_User1 (org-level)     │
                    │  ├─ Telephony Cred: Org-1_User2 (org-level)     │
                    │  ├─ Telephony Cred: Device-web_abc_Xr4m         │
                    │  ├─ Telephony Cred: Device-android_def_Yz2n     │
                    │  ├─ Telephony Cred: Device-ios_ghi_Wq8p         │
                    │  └─ ... (potentially orphaned credentials)       │
                    │                                                  │
                    │  WebRTC Gateway ← SIP INVITE targets device creds│
                    │  PSTN Gateway → Call Control App webhook         │
                    └──────────────────┬──────────────────────────────┘
                                       │ HTTPS API
                                       │
                    ┌──────────────────┴──────────────────────────────┐
                    │              LARAVEL BACKEND                     │
                    │                                                  │
                    │  ┌─ user_telnyx_telephony_credentials ─────┐    │
                    │  │  (user_id, org_id) → credential_id,     │    │
                    │  │   sip_username, sip_password, conn_id   │    │
                    │  │  Purpose: JWT generation for web         │    │
                    │  └─────────────────────────────────────────┘    │
                    │                                                  │
                    │  ┌─ user_device_tokens ────────────────────┐    │
                    │  │  (user_id, org_id, device_id) →         │    │
                    │  │   fcm_token, platform,                  │    │
                    │  │   telnyx_credential_id, sip_username,   │    │
                    │  │   sip_password, connection_id,          │    │
                    │  │   credential_expires_at                 │    │
                    │  │  Purpose: Push tokens + per-device SIP  │    │
                    │  └─────────────────────────────────────────┘    │
                    │                                                  │
                    │  CPaaSService                                    │
                    │  ├─ handleCredentials(): org-level find/create   │
                    │  ├─ createDeviceCredential(): per-device create  │
                    │  ├─ getDeviceJwt(): JWT from device credential   │
                    │  └─ deleteTelnyxCredential(): cleanup            │
                    │                                                  │
                    │  Inbound Webhook Controller                      │
                    │  └─ Collects device sip_usernames for SIP legs   │
                    └──────────────────┬──────────────────────────────┘
                                       │
               ┌───────────────────────┼───────────────────────┐
               │                       │                       │
     ┌─────────┴────────┐   ┌─────────┴────────┐   ┌─────────┴────────┐
     │   WEB BROWSER     │   │   iOS DEVICE      │   │   ANDROID DEVICE  │
     │                   │   │                   │   │                   │
     │ Device ID:        │   │ Device ID:        │   │ Device ID:        │
     │  localStorage     │   │  native           │   │  native           │
     │                   │   │                   │   │                   │
     │ Auth: JWT token   │   │ Auth: SIP creds   │   │ Auth: SIP creds   │
     │  via TelnyxRTC    │   │  via TxClient     │   │  via TelnyxClient │
     │  Provider         │   │                   │   │                   │
     │                   │   │ Storage: Keychain  │   │ Storage: Shared   │
     │ Push: N/A (web    │   │  (z360_sip_*)     │   │  Preferences      │
     │  uses Reverb WS)  │   │                   │   │  (ProfileManager) │
     │                   │   │ Push: PushKit/APNs │   │ Push: FCM data    │
     │ Fallback: server  │   │  VoIP push        │   │  message          │
     │  JWT from Inertia │   │                   │   │                   │
     └──────────────────┘   └──────────────────┘   └──────────────────┘
```

---

## 13. Summary of Issues and Gaps

### 13.1 Critical Issues

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | `CleanStaleDeviceTokens` deletes DB rows without deleting Telnyx credentials | `app/Console/Commands/CleanStaleDeviceTokens.php:24-30` | Orphaned credentials accumulate on Telnyx |
| 2 | `credential_expires_at` is set but never enforced | `CPaaSService.php:231` (only write), no reads | Credentials never rotate; 30-day expiry is inert |
| 3 | Org-level credentials never deleted | `handleCredentials()` creates, nothing deletes | Unbounded growth on Telnyx |
| 4 | Cross-org call uses org-level creds, not per-device | `VoipCredentialController::switchOrg()` | During cross-org answer, device uses different SIP identity than registered |

### 13.2 Moderate Issues

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 5 | Two DeviceTokenControllers with different keying strategies | `Api\DeviceTokenController` (device_id key) vs `DeviceTokenController` (fcm_token key) | Potential for duplicate/orphaned rows |
| 6 | SIP passwords stored in plaintext in DB | `user_device_tokens.sip_password`, `user_telnyx_telephony_credentials.sip_password` | Security concern — should be encrypted at rest |
| 7 | No uniqueness constraint on `(user_id, org_id, device_id)` | `user_device_tokens` table | `updateOrCreate` relies on app-level logic |
| 8 | `deleteTelnyxCredential()` silently fails | `CPaaSService.php:240-250` | Failed deletions = orphaned credentials |

### 13.3 Design Observations

| # | Observation | Details |
|---|-------------|---------|
| 9 | Web `fcm_token` is a placeholder | `"web_{browserDeviceId}"` — not a real push token |
| 10 | iOS uses PushKit VoIP token in `fcm_token` column | Column name is misleading for iOS |
| 11 | JWT auth broken on Android SDK 3.3.0 | All native platforms use SIP credential auth instead |
| 12 | No credential rotation mechanism | Credentials persist indefinitely; no automated refresh |
| 13 | `handleCredentials()` called on every page load (optional) and device registration | Could create credentials eagerly even if user never uses VoIP |

---

## 14. File Reference Index

| File | Key Content |
|------|-------------|
| `app/Services/CPaaSService.php:161-265` | `handleCredentials()`, `createDeviceCredential()`, `getDeviceJwt()`, `deleteTelnyxCredential()` |
| `app/Http/Controllers/Api/DeviceTokenController.php` | Central device registration endpoint |
| `app/Http/Controllers/Api/VoipCredentialController.php` | VoIP credentials + org switch API |
| `app/Models/UserDeviceToken.php` | Device token model with SIP fields |
| `app/Models/UserTelnyxTelephonyCredential.php` | Org-level credential model |
| `app/Models/User.php:117-121` | `telnyxCredential()` relationship |
| `app/Http/Middleware/HandleInertiaRequests.php:70` | Server-side JWT for web |
| `app/Console/Commands/CleanStaleDeviceTokens.php` | Stale cleanup (missing Telnyx deletion) |
| `app/Console/Commands/TelnyxSetup.php` | Infrastructure provisioning |
| `config/cpaas.php` | Telnyx configuration |
| `resources/js/hooks/useWebVoipCredentials.ts` | Web per-device registration |
| `resources/js/plugins/use-telnyx-voip.ts` | Native VoIP hook (iOS + Android) |
| `resources/js/layouts/app-layout.tsx:137` | TelnyxRTCProvider initialization |
| `resources/js/hooks/use-push-notifications.ts` | FCM token registration |
| `ios/App/App/VoIP/Services/TelnyxService.swift:75-108` | iOS SDK connection |
| `ios/App/App/VoIP/Services/VoipStore.swift:170-213` | iOS Keychain credential storage |
| `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` | iOS cross-org switch |
| `ios/App/App/VoIP/Models/VoIPModels.swift:92-116` | SIPCredentials model |
| `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:119-179` | Android SDK connection |
| `android/app/src/main/java/com/z360/app/voip/OrgSwitchHelper.kt` | Android cross-org switch |
| `app/Http/Controllers/Auth/AuthenticatedSessionController.php:108-131` | Web logout cleanup |
| `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:264-297` | Inbound call routing to SIP devices |
| `routes/api.php` | API route definitions |
| `app/Http/Requests/Api/StoreDeviceTokenRequest.php` | Validation rules |
| Database migrations: `2025_09_12_000500`, `2025_09_12_001000`, `2025_09_17_000200`, `2026_01_23_053936`, `2026_01_23_170000`, `2026_02_01_000000` | Schema evolution |
