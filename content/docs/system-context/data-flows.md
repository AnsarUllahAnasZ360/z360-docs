---
title: Data Flows
---

# Z360 VoIP Data Flows

This document traces 5 critical data flows through the Z360 VoIP system, documenting the exact data shape at each transformation point with verified file references.

---

## 1. Authentication State Propagation

**Summary**: User authenticates via Laravel → Inertia shares auth props to React SPA → Capacitor WebView receives same props → native layer gets credentials via Capacitor plugin bridge.

### Step 1: Laravel Session Authentication

**Origin**: Standard Laravel session-based auth (Fortify/Breeze). User logs in via web form, Laravel creates session stored in Redis.

**Data shape** (server-side):
```
Auth::user() → User model {
    id: int,
    name: string,
    email: string,
    organizations: Collection<Organization>,  // eager-loaded
    last_organization_id: ?int
}
```

### Step 2: Inertia Shared Props

**File**: `app/Http/Middleware/HandleInertiaRequests.php:50-106`

The `share()` method runs on every Inertia request, providing auth context to all pages:

```php
// Line 59: User + organizations
'auth.user' => fn () => $request->user()?->load('organizations'),

// Line 60: Super admin flag
'auth.isAccessingAsAdmin' => fn () => $request->user()?->isAccessingAsSuperAdmin() ?? false,

// Line 63: Current org (super admin only — regular users get org via user.organizations)
'auth.currentOrganization' => fn () => $request->user()?->isAccessingAsSuperAdmin()
    ? CurrentTenant::get() : null,

// Lines 64-69: Permission gates
'auth.gates' => $request->user() ? [
    'manage_billing' => Gate::allows('manage_billing'),
    'manage_account_settings' => Gate::allows('manage_account_settings'),
    'manage_product_settings' => Gate::allows('manage_product_settings'),
    'manage_agent' => Gate::allows('manage_agent'),
] : [],

// Line 70: Telnyx JWT for WebRTC (lazy-loaded, only fetched when page accesses it)
'cpaas.telnyx.jwt' => Inertia::optional(fn () => CPaaSService::handleCredentials($request->user())),
```

**Data shape** (Inertia JSON payload to frontend):
```json
{
  "auth": {
    "user": {
      "id": 123,
      "name": "John Doe",
      "email": "john@example.com",
      "organizations": [
        { "id": 1, "name": "Acme Corp", "slug": "acme" },
        { "id": 2, "name": "Beta Inc", "slug": "beta" }
      ]
    },
    "isAccessingAsAdmin": false,
    "currentOrganization": null,
    "gates": {
      "manage_billing": true,
      "manage_account_settings": true,
      "manage_product_settings": false,
      "manage_agent": true
    }
  },
  "cpaas": {
    "telnyx": {
      "jwt": "eyJhbGciOiJIUzI1NiIs..."
    }
  }
}
```

### Step 3: Frontend TypeScript Types

**File**: `resources/js/types/index.d.ts:9-14` (Auth interface), `37-66` (SharedData interface)

```typescript
interface Auth {
    user: User;
    isAccessingAsAdmin?: boolean;
    currentOrganization?: Organization | null;
    gates?: Record<Gate, boolean>;
}

interface SharedData {
    auth: Auth;
    cpaas: { telnyx: { jwt: string } };
    // ... other shared props
}
```

### Step 4: React App Initialization

**File**: `resources/js/app.tsx:99-127`

Inertia creates the React app and passes `props` containing all shared data:

```tsx
createInertiaApp({
    setup({ el, App, props }) {
        const sharedData = props.initialPage.props as unknown as SharedData;
        // Auth data available in sharedData.auth
        // Telnyx JWT available in sharedData.cpaas.telnyx.jwt
    }
});
```

### Step 5: Platform Detection → Provider Selection

**File**: `resources/js/app.tsx:45-61`

```tsx
// Line 50: Detects Capacitor native platform
if (Capacitor.isNativePlatform()) { return 'mobile'; }
```

Provider hierarchy branches:
- **Web**: `TelnyxRTCProvider` uses JWT from Inertia props for WebRTC
- **Native**: `NativeVoipProvider` bypasses WebRTC, delegates to native SDK

### Step 6: Capacitor Bridge → Native Layer

**File (Android)**: `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:119-179`
**File (iOS)**: `ios/App/App/VoIP/TelnyxVoipPlugin.swift:125-179`

JavaScript calls `TelnyxVoip.connect()` with credentials extracted from Inertia props:

```kotlin
// Android: TelnyxVoipPlugin.kt:132-152
@PluginMethod
fun connect(call: PluginCall) {
    val sipUsername = call.getString("sipUsername") ?: return
    val sipPassword = call.getString("sipPassword") ?: return
    val callerIdName = call.getString("callerIdName") ?: ""
    val callerIdNumber = call.getString("callerIdNumber") ?: ""

    val profile = Profile(
        sipUsername = sipUsername,
        sipPass = sipPassword,
        callerIdName = callerIdName,
        callerIdNumber = callerIdNumber,
        fcmToken = TokenHolder.fcmToken,
        isUserLoggedIn = true
    )
    telnyxViewModel.credentialLogin(viewContext = context, profile = profile, ...)
}
```

### Step 7: API Authentication for Native Calls

Native code makes API calls using **WebView session cookies** (not separate tokens):

- **Android**: `OrgSwitchHelper.kt` reads cookies via `android.webkit.CookieManager`
- **iOS**: `OrganizationSwitcher.swift` reads cookies via `WKWebsiteDataStore`

This means native API authentication piggybacks on the WebView's Laravel session cookie, with no separate token exchange needed.

### Authentication Flow Diagram

```
Laravel Auth (session in Redis)
    │
    ▼
HandleInertiaRequests.php:share()
    │ auth.user, auth.gates, cpaas.telnyx.jwt
    ▼
Inertia JSON Response
    │
    ▼
React App (app.tsx) — SharedData props
    │
    ├── Web: TelnyxRTCProvider uses JWT directly for WebRTC
    │
    └── Native: NativeVoipProvider
            │ TelnyxVoip.connect({ sipUsername, sipPassword, ... })
            ▼
        Capacitor Bridge (TelnyxVoipPlugin)
            │
            ├── Android: Profile object → Telnyx SDK credentialLogin()
            └── iOS: SIP credentials → TelnyxService.connect()

API calls from native:
    WebView Cookie (LARAVEL_SESSION) → CookieManager/WKWebsiteDataStore → HTTP headers
```

---

## 2. SIP Credential Lifecycle

**Summary**: Two credential paths exist — org-level (web JWT, 10h TTL) and per-device (mobile SIP, 30-day TTL). Per-device credentials prevent SIP registration conflicts and enable simultaneous ring.

### Path A: Org-Level Credentials (Web)

#### Step A1: Credential Creation via Telnyx API

**File**: `app/Services/CPaaSService.php:161-207`

Triggered lazily by `HandleInertiaRequests.php:70` via `Inertia::optional()`:

```php
public static function handleCredentials(?User $user): ?string
{
    $connectionId = config('cpaas.telnyx.credential_connection_id');  // Line 167
    $orgId = CurrentTenant::id();  // Line 172

    // Find existing credential for this user+org
    $existing = UserTelnyxTelephonyCredential::where('organization_id', $orgId)
        ->where('user_id', $user->id)->first();  // Line 178

    if (! $existing) {
        // Create new credential on Telnyx
        $name = 'Org-'.$orgId.'_'.Str::random(8);  // Line 180
        $telephonyCredential = \Telnyx\TelephonyCredential::create([
            'name' => $name,
            'connection_id' => $connectionId,
        ]);  // Lines 181-184

        // Store locally
        $existing = UserTelnyxTelephonyCredential::create([
            'user_id' => $user->id,
            'organization_id' => $orgId,
            'credential_id' => $telephonyCredential->id,
            'connection_id' => $connectionId,
            'sip_username' => $telephonyCredential->sip_username,
            'sip_password' => $telephonyCredential->sip_password,
        ]);  // Lines 191-198
    }

    // Generate JWT token (10h TTL)
    $cred = \Telnyx\TelephonyCredential::retrieve($existing->credential_id);
    $token = $cred->token();  // Lines 202-203
    return $token;
}
```

**Telnyx API response shape**:
```json
{
  "id": "cred_abc123",
  "sip_username": "org-1_xK9mP2qR",
  "sip_password": "auto-generated-password",
  "name": "Org-1_xK9mP2qR",
  "connection_id": "conn_xyz789"
}
```

#### Step A2: Database Storage

**File**: `database/migrations/2025_09_12_000500_create_user_telnyx_telephony_credentials_table.php`

**Table**: `user_telnyx_telephony_credentials`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | bigint PK | Local primary key |
| `user_id` | FK → users | Owner user |
| `organization_id` | FK → organizations | Tenant scope |
| `credential_id` | string, unique | Telnyx credential ID |
| `connection_id` | string | Telnyx connection ID |
| `sip_username` | string, unique | SIP registration username |
| `sip_password` | string | SIP registration password |
| `created_at` / `updated_at` | timestamps | Standard timestamps |

#### Step A3: JWT Delivery to Frontend

**Destination**: Inertia prop `cpaas.telnyx.jwt` — a 10-hour JWT string used by `@telnyx/react-client` for WebRTC auth on web.

### Path B: Per-Device Credentials (Mobile + Web)

#### Step B1: Device Registration API

**File**: `routes/api.php:16` — `POST /api/device-tokens`
**File**: `app/Http/Controllers/Api/DeviceTokenController.php:42-177`

Device sends registration request:

```json
POST /api/device-tokens
{
  "device_id": "unique-device-uuid",
  "fcm_token": "firebase-token-or-apns-voip-token",
  "platform": "android|ios|web",
  "device_name": "Pixel 8 Pro",
  "app_version": "2.1.0"
}
```

#### Step B2: Device Token Storage

**File**: `DeviceTokenController.php:84-97`

```php
$token = UserDeviceToken::updateOrCreate(
    [
        'user_id' => $user->id,
        'organization_id' => $organizationId,  // From CurrentTenant::id()
        'device_id' => $validated['device_id'],
    ],
    [
        'fcm_token' => $validated['fcm_token'],
        'platform' => $validated['platform'],
        'device_name' => $validated['device_name'] ?? null,
        'app_version' => $validated['app_version'] ?? null,
        'last_active_at' => now(),
    ]
);
```

**Table**: `user_device_tokens`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | bigint PK | Local primary key |
| `user_id` | FK → users | Owner user |
| `organization_id` | FK → organizations | Tenant scope |
| `device_id` | string | Unique device identifier |
| `fcm_token` | string | FCM token (Android) or APNs VoIP token (iOS) |
| `platform` | string | `android`, `ios`, or `web` |
| `device_name` | string, nullable | Human-readable device name |
| `app_version` | string, nullable | App version |
| `last_active_at` | timestamp | For stale device cleanup (7-day window) |
| `telnyx_credential_id` | string, nullable, unique | Per-device Telnyx credential ID |
| `sip_username` | string, nullable, indexed | Per-device SIP username |
| `sip_password` | string, nullable | Per-device SIP password |
| `connection_id` | string, nullable | Telnyx connection ID |
| `credential_expires_at` | timestamp, nullable | 30-day credential TTL |

#### Step B3: Per-Device Telnyx Credential Creation

**File**: `app/Services/CPaaSService.php:213-235`

```php
public static function createDeviceCredential(User $user, UserDeviceToken $deviceToken): ?UserDeviceToken
{
    $name = "Device-{$deviceToken->device_id}_".Str::random(8);  // Line 220
    $credential = \Telnyx\TelephonyCredential::create([
        'name' => $name,
        'connection_id' => $connectionId,
    ]);  // Lines 221-224

    $deviceToken->update([
        'telnyx_credential_id' => $credential->id,
        'sip_username' => $credential->sip_username,
        'sip_password' => $credential->sip_password,
        'connection_id' => $connectionId,
        'credential_expires_at' => now()->addDays(30),
    ]);  // Lines 226-232
}
```

#### Step B4: Device JWT Generation

**File**: `app/Services/CPaaSService.php:255-265`

```php
public static function getDeviceJwt(UserDeviceToken $deviceToken): ?string
{
    $cred = \Telnyx\TelephonyCredential::retrieve($deviceToken->telnyx_credential_id);
    $token = $cred->token();
    return is_string($token) ? trim($token) : null;
}
```

#### Step B5: API Response to Device

**File**: `DeviceTokenController.php:167-176`

```json
{
  "success": true,
  "message": "Device token registered successfully",
  "data": {
    "id": 42,
    "device_id": "unique-device-uuid",
    "platform": "android",
    "sip_credentials": {
      "sip_username": "Device-abc123_xK9mP2qR",
      "sip_password": "auto-generated-password",
      "jwt_token": "eyJhbGciOiJIUzI1NiIs..."
    }
  }
}
```

#### Step B6: Native Device Storage

**Android**: Telnyx SDK's `ProfileManager` stores credentials internally via `Profile` object.
- File: `android/.../TelnyxVoipPlugin.kt:145-152`

**iOS**: Credentials stored in iOS Keychain via `KeychainManager`.
- File: `ios/App/App/VoIP/Utils/KeychainManager.swift`
- Service: `com.z360.voip`
- Accessibility: `kSecAttrAccessibleWhenUnlocked`

#### Lifecycle Management

| Operation | Trigger | File |
|-----------|---------|------|
| Create credential | Device registers (`POST /api/device-tokens`) | `DeviceTokenController.php:116` |
| Delete old credential | Device re-registers with new ID | `DeviceTokenController.php:109-114` |
| Stale cleanup | 7+ days inactive, same platform | `DeviceTokenController.php:134-159` |
| Web dedup | Max 1 web device per user+org | `DeviceTokenController.php:57-81` |
| Device removal | `DELETE /api/device-tokens/{id}` | `DeviceTokenController.php:183-212` |
| Org switch | `POST /api/voip/switch-org` | `VoipCredentialController.php:109-218` |

### Credential Flow Diagram

```
                    ┌─────────────────────────────┐
                    │   Telnyx API                 │
                    │   POST telephony_credentials │
                    └──────────┬──────────────────┘
                               │ Returns: id, sip_username, sip_password
                               ▼
              ┌────────────────────────────────────┐
              │        CPaaSService.php              │
              │                                      │
              │  Path A: handleCredentials()          │
              │    → Org-level credential             │
              │    → UserTelnyxTelephonyCredential    │
              │    → JWT token (10h TTL)              │
              │                                      │
              │  Path B: createDeviceCredential()     │
              │    → Per-device credential             │
              │    → UserDeviceToken.sip_*             │
              │    → Device JWT (via getDeviceJwt)     │
              └───────────────┬────────────────────┘
                              │
              ┌───────────────┼───────────────────┐
              ▼               ▼                   ▼
       ┌─────────────┐ ┌──────────────┐  ┌────────────────┐
       │  Inertia     │ │ API Response │  │ API Response   │
       │  Props (Web) │ │ (Android)    │  │ (iOS)          │
       │              │ │              │  │                │
       │ cpaas.telnyx │ │ sip_username │  │ sip_username   │
       │ .jwt         │ │ sip_password │  │ sip_password   │
       │              │ │ jwt_token    │  │ jwt_token      │
       └──────┬───────┘ └──────┬───────┘  └───────┬────────┘
              │                │                   │
              ▼                ▼                   ▼
       TelnyxRTCProvider  Telnyx Android SDK   Telnyx iOS SDK
       (WebRTC in browser) (Native WebSocket)  (Native WebSocket)
```

---

## 3. Caller Information Resolution

**Summary**: Telnyx webhook delivers raw caller number → backend resolves to Contact → enriches with name/avatar → pushes to all devices via FCM/APNs/Reverb.

### Step 1: Telnyx Webhook Arrival

**File**: `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:43-114`

Telnyx sends `call.initiated` webhook:

```json
{
  "data": {
    "event_type": "call.initiated",
    "payload": {
      "call_session_id": "uuid-call-session",
      "call_control_id": "uuid-call-control",
      "from": "+18179398981",
      "to": "+18175551234",
      "direction": "incoming",
      "state": "parked"
    }
  }
}
```

### Step 2: Message & Conversation Creation

**File**: `TelnyxInboundWebhookController.php:43-114`

The controller creates a `Message` record with call metadata, linking it to a `Conversation` which connects to an `Identifier` (phone number) and potentially a `Contact`:

```
Telnyx payload.from → Identifier (phone number lookup) → Conversation → Message
                                    │
                                    └── Identifier.contact → Contact (if linked)
```

**Message metadata stored**:
```php
$message->metadata = [
    'call_session_id' => $data->call_session_id,
    'call_control_id' => $data->call_control_id,
    'parent_call_control_id' => $data->call_control_id,
    'original_from' => $data->from,  // Raw caller number
];
```

### Step 3: Caller Info Enrichment (transferToUser)

**File**: `TelnyxInboundWebhookController.php:212-263`

When routing to a user, the controller resolves caller identity:

```php
$conversation = $message->conversation;
$callerNumber = $message->metadata['original_from'] ?? 'Unknown';  // Line 221
$callerName = $conversation->identifier?->contact?->full_name ?? $callerNumber;  // Line 222
$channelNumber = $conversation->channel?->number ?? '';  // Line 223
```

**Data shape after enrichment**:
```
{
  callerNumber: "+18179398981"           // Raw phone from Telnyx
  callerName: "Alice Smith"              // Contact.full_name or fallback to number
  channelNumber: "+18175551234"          // Z360 channel that received the call
  callSessionId: "uuid-call-session"     // Telnyx call session
}
```

### Step 4: Push Notification Construction

**File**: `TelnyxInboundWebhookController.php:401-446`

The private `sendIncomingCallPush()` method enriches further with avatar and org context:

```php
$contact = $conversation->identifier?->contact;
$callerName = $contact?->full_name ?? $callerNumber;  // Line 411
$callerAvatar = null;
if ($contact && $contact->avatar_path) {
    $callerAvatar = asset('storage/' . $contact->avatar_path);  // Line 418
}
$organization = CurrentTenant::get();  // Line 422
$callId = $message->metadata['call_session_id'] ?? null;  // Line 425 — correlation ID
```

**Calls `PushNotificationService::sendIncomingCallPush()` with** (lines 427-439):
```
userId: $user->id
callSessionId: "uuid-call-session"
callControlId: "uuid-call-control"
callerNumber: "+18179398981"
callerName: "Alice Smith"
channelNumber: "+18175551234"
organizationId: 1
organizationName: "Acme Corp"
organizationSlug: "acme"
callerAvatar: "https://z360.app/storage/avatars/contact-456.jpg"
callId: "uuid-call-session"
```

### Step 5: Push Dispatch (FCM + APNs)

**File**: `app/Services/PushNotificationService.php:20-157`

#### FCM Payload (Android)

**File**: `PushNotificationService.php:59-88` (payload construction), `233-288` (FCM send)

```json
{
  "message": {
    "token": "fcm-device-token-xyz",
    "data": {
      "type": "incoming_call",
      "call_session_id": "uuid-call-session",
      "call_control_id": "uuid-call-control",
      "caller_number": "+18179398981",
      "caller_name": "Alice Smith",
      "channel_number": "+18175551234",
      "timestamp": "1707503400",
      "caller_avatar": "https://z360.app/storage/avatars/contact-456.jpg",
      "call_id": "uuid-call-session",
      "organization_id": "1",
      "organization_name": "Acme Corp",
      "organization_slug": "acme"
    },
    "android": {
      "priority": "high",
      "ttl": "60s"
    }
  }
}
```

All `data` values are strings (FCM requirement — `array_map('strval', $data)` at line 247).

#### APNs VoIP Payload (iOS)

**File**: `PushNotificationService.php:117-133`, `app/Services/ApnsVoipService.php:16-120`

```json
{
  "type": "incoming_call",
  "call_session_id": "uuid-call-session",
  "call_control_id": "uuid-call-control",
  "caller_number": "+18179398981",
  "caller_name": "Alice Smith",
  "channel_number": "+18175551234",
  "timestamp": "1707503400",
  "caller_avatar": "https://z360.app/storage/avatars/contact-456.jpg",
  "call_id": "uuid-call-session",
  "organization_id": "1",
  "organization_name": "Acme Corp",
  "organization_slug": "acme",
  "aps": {
    "content-available": 1
  }
}
```

Sent via HTTP/2 to `api.push.apple.com/3/device/{token}` with headers:
- `apns-topic: {bundleId}.voip`
- `apns-push-type: voip`
- `apns-priority: 10`
- `apns-expiration: 0`
- `apns-collapse-id: {callSessionId}`

### Step 6: WebSocket Broadcast (Web)

**File**: `app/Events/IncomingCallNotification.php:17-57`
**File**: `TelnyxInboundWebhookController.php:247-256`

```php
event(new IncomingCallNotification(
    user: $user,
    callSessionId: $callSessionId,
    callControlId: $call_control_id,
    callerNumber: $callerNumber,
    callerName: $callerName,
    channelNumber: $channelNumber,
    organizationId: $organization?->id,
    organizationName: $organization?->name,
));
```

**Broadcast channel**: `org.{orgId}.App.Models.User.{userId}` (via `TenantPrivateChannel`)
**Event name**: `incoming_call`

**WebSocket payload** (`broadcastWith()` at lines 45-56):
```json
{
  "call_session_id": "uuid-call-session",
  "call_control_id": "uuid-call-control",
  "caller_number": "+18179398981",
  "caller_name": "Alice Smith",
  "channel_number": "+18175551234",
  "organization_id": 1,
  "organization_name": "Acme Corp"
}
```

**Note**: WebSocket broadcast does NOT include `caller_avatar` or `organization_slug` — these are only in push notifications.

### Step 7: Device Display

#### Android

**File**: `android/.../Z360FirebaseMessagingService.kt` — parses FCM data payload
**File**: `android/.../IncomingCallActivity.kt` — displays caller info

The FCM handler extracts fields and stores them in `Z360VoipStore`:
```kotlin
store.saveCallDisplayInfo(
    callId = callId ?: callerNumber,
    callerName = callerName,
    callerNumber = callerNumber,
    avatarUrl = callerAvatar
)
```

`IncomingCallActivity` renders:
- Caller name (or phone number fallback)
- Formatted phone number
- Avatar image (or initials circle)
- Organization badge (for cross-org calls)

#### iOS

**File**: `ios/.../PushKitManager.swift` — receives VoIP push, reports to CallKit

CallKit system UI displays:
```swift
callKitManager.reportIncomingCall(
    uuid: uuid,
    handle: callInfo.callerNumber,
    callerName: formatCallerNameWithOrgBadge(
        callerName: callInfo.callerName,
        organizationName: callInfo.organizationName,
        isCrossOrg: isCrossOrg
    ),
    hasVideo: false
)
```

Cross-org formatting: `"Alice Smith (Beta Inc)"` — iOS CallKit has limited display, so org context is appended to name.

### Caller Info Flow Diagram

```
PSTN Caller (+18179398981)
    │
    ▼ Telnyx Webhook (call.initiated)
TelnyxInboundWebhookController
    │ payload.from → Identifier lookup
    ▼
Message created with metadata: { original_from, call_session_id, call_control_id }
    │
    ▼ transferToUser()
Contact Resolution:
    conversation.identifier.contact → { full_name: "Alice Smith", avatar_path: "avatars/..." }
    │
    ├──────────────────────────────────────────────────────────┐
    │                                                          │
    ▼                                                          ▼
PushNotificationService                           IncomingCallNotification Event
    │                                                          │
    ├── FCM (Android)                                          ▼
    │   { caller_name, caller_number,               Reverb WebSocket
    │     caller_avatar, organization_* }            { caller_name, caller_number,
    │                                                  organization_id, organization_name }
    │                                                          │
    ├── APNs VoIP (iOS)                                        ▼
    │   { same + aps.content-available }             Web Browser: DialpadContext
    │                                                 → Ringing UI
    ▼
Android: Z360VoipStore → IncomingCallActivity
iOS: PushCorrelator → CallKit System UI
```

---

## 4. Organization Context Propagation

**Summary**: Session-based tenant context flows from middleware through all database queries, API responses, push payloads, and WebSocket channels. Mobile org switching requires credential regeneration and SDK reconnection.

### Step 1: Tenant Resolution (Every Request)

**File**: `app/Http/Middleware/SetCurrentTenant.php`

Priority-based org resolution on every web request:

1. **Query parameter** `?organization_id=X` (highest priority — email links, admin access)
2. **Session** `current_organization_id` (persisted user selection)
3. **User preference** `User.last_organization_id` (last used org)
4. **Auto-select** first available organization for user

**Result**: `CurrentTenant::set($organization)` — sets static property for request duration.

### Step 2: Global Query Scoping

**File**: `app/Traits/BelongsToTenant.php:20-35`
**File**: `app/Scopes/TenantScope.php`

Every query on tenant-aware models (32 models) automatically includes:
```sql
WHERE organization_id = {CurrentTenant::id()}
```

On model creation, `organization_id` is auto-set:
```php
static::creating(function (Model $model) {
    if (empty($model->organization_id)) {
        $model->organization_id = CurrentTenant::id();
    }
});
```

### Step 3: Telnyx Credential Scoping

**File**: `app/Services/CPaaSService.php:172-178`

Credential lookup is scoped by org:
```php
$orgId = CurrentTenant::id();
$existing = UserTelnyxTelephonyCredential::where('organization_id', $orgId)
    ->where('user_id', $user->id)->first();
```

**Configuration note**: Telnyx API key and connection IDs are **global** (not per-org) in `config/cpaas.php`. Org isolation is achieved via:
- Per-org credential records in `user_telnyx_telephony_credentials`
- Per-org device tokens in `user_device_tokens`
- `TenantScope` filtering all queries

### Step 4: Push Notification Org Scoping

**File**: `app/Services/PushNotificationService.php:34-40`

Device tokens are fetched per-org:
```php
if ($organizationId) {
    $fcmTokens = UserDeviceToken::getFcmTokensForUserInOrganization($userId, $organizationId);
    $apnsTokens = UserDeviceToken::getApnsVoipTokensForUserInOrganization($userId, $organizationId);
}
```

Push payload includes org context (lines 80-88):
```php
$payload['organization_id'] = (string) $organizationId;
$payload['organization_name'] = $organizationName;
$payload['organization_slug'] = $organizationSlug;
```

### Step 5: WebSocket Channel Namespacing

**File**: `app/Broadcasting/TenantPrivateChannel.php`

Channels are namespaced by org:
```
Channel: org.{orgId}.App.Models.User.{userId}
```

`OrganizationSwitched` event broadcasts to ALL user's org channels so all sessions hear it:

**File**: `app/Events/OrganizationSwitched.php`
```php
public function broadcastWith(): array {
    return [
        'org_id' => $this->organization->id,
        'org_name' => $this->organization->name,
    ];
}
```

### Step 6: Inbound Call Org Context

**File**: `TelnyxInboundWebhookController.php:217, 289-293, 319-325`

Org context is embedded in Telnyx `client_state` for subsequent call control events:

```php
// Single device transfer (line 289-293)
'client_state' => base64_encode(json_encode([
    'type' => 'user_call',
    'user_id' => $user->id,
    'organization_id' => $organization?->id,
]))

// Simultaneous ring legs (lines 319-325)
'client_state' => base64_encode(json_encode([
    'type' => 'simultaneous_ring_leg',
    'parent_call_control_id' => $call_control_id,
    'user_id' => $user->id,
    'message_id' => $message->id,
    'organization_id' => $organization?->id,
]))
```

This ensures subsequent webhooks (`call.answered`, `call.hangup`) can restore org context.

### Step 7: Mobile Org Switch (API)

**File**: `app/Http/Controllers/Api/VoipCredentialController.php:109-218`

**Endpoint**: `POST /api/voip/switch-org`

**Request**:
```json
{ "target_organization_id": 456 }
```

**Server-side flow** (lines 152-166):
```php
$organization->switchTo();  // Sets session + broadcasts OrganizationSwitched
$user->update(['last_organization_id' => $organization->id]);
$user->refresh();  // Clears relationship cache
$telnyxCredential = $user->telnyxCredential;  // TenantScope now returns new org's credential
```

**Response** (lines 206-217):
```json
{
  "success": true,
  "data": {
    "sip_username": "org-456_abc123",
    "sip_password": "password456",
    "jwt_token": "eyJhbGci...",
    "caller_id_name": "John Doe",
    "caller_id_number": "+14155552671",
    "organization_id": 456,
    "organization_name": "Beta Corp"
  }
}
```

### Step 8: Android Org Switch

**File**: `android/.../OrgSwitchHelper.kt`

```kotlin
// Makes API call using WebView cookies for auth
POST $API_BASE_URL/api/voip/switch-org
Headers: Cookie: {cookies from CookieManager}
Body: { "target_organization_id": 456 }
```

On success, the Telnyx SDK reconnects with new SIP credentials.

### Step 9: iOS Org Switch

**File**: `ios/.../OrganizationSwitcher.swift`

More complex due to CallKit timing constraints:

1. Capture original org context (for failure restoration)
2. Register background task (5s CallKit deadline)
3. Call API with 4-second timeout (safety margin)
4. Store new credentials in Keychain
5. Update VoipStore with new org_id and org_name
6. Reconnect TelnyxService with new credentials
7. On failure: restore original org context, credentials, and org name

### Org Context Flow Diagram

```
HTTP Request
    │
    ▼
SetCurrentTenant Middleware
    │ Query param → Session → User.last_organization_id → First org
    ▼
CurrentTenant::set(Organization { id: 1, name: "Acme" })
    │
    ├── TenantScope: All queries WHERE organization_id = 1
    │
    ├── CPaaSService: Credential for org 1
    │
    ├── PushNotificationService: Device tokens for org 1
    │     └── Payload: { organization_id: "1", organization_name: "Acme" }
    │
    ├── WebSocket: Channel org.1.App.Models.User.123
    │
    └── client_state: { organization_id: 1 } (base64 in Telnyx calls)

Org Switch (mobile):
    POST /api/voip/switch-org { target_organization_id: 2 }
        │
        ├── org.switchTo() → Session updated
        ├── TenantScope now scopes to org 2
        ├── New credential fetched/created
        └── Response: { sip_username, sip_password, jwt_token, organization_id: 2 }
            │
            ├── Android: OrgSwitchHelper → Telnyx SDK reconnect
            └── iOS: OrganizationSwitcher → Keychain + TelnyxService reconnect
```

---

## 5. Push Notification Payloads (Z360 vs Telnyx)

**Summary**: Each incoming call triggers TWO push notifications to mobile devices — one from Z360 backend (rich caller info) and one from Telnyx SDK (call control metadata). Either can arrive first. Both platforms implement 500ms synchronization with phone-number-based correlation.

### Z360 Backend Push

**Origin**: `PushNotificationService::sendIncomingCallPush()` called from `TelnyxInboundWebhookController::sendIncomingCallPush()`

#### FCM Payload (Android)

**File**: `app/Services/PushNotificationService.php:59-88, 244-253`

```json
{
  "message": {
    "token": "fcm-device-token",
    "data": {
      "type": "incoming_call",
      "call_session_id": "uuid-call-session",
      "call_control_id": "uuid-call-control",
      "caller_number": "+18179398981",
      "caller_name": "Alice Smith",
      "channel_number": "+18175551234",
      "timestamp": "1707503400",
      "caller_avatar": "https://z360.app/storage/avatars/contact-456.jpg",
      "call_id": "uuid-call-session",
      "organization_id": "1",
      "organization_name": "Acme Corp",
      "organization_slug": "acme"
    },
    "android": {
      "priority": "high",
      "ttl": "60s"
    }
  }
}
```

**Key fields**:
| Field | Source | Purpose |
|-------|--------|---------|
| `type` | Hardcoded `"incoming_call"` | Distinguishes from `"call_ended"` |
| `call_session_id` | Telnyx webhook payload | Links to Telnyx call |
| `call_control_id` | Telnyx webhook payload | Call control operations |
| `caller_number` | `Message.metadata['original_from']` | Display + correlation |
| `caller_name` | `Contact.full_name` or fallback to number | Display |
| `channel_number` | `Conversation.channel.number` | Which Z360 line received |
| `timestamp` | `now()->timestamp` | Push timing |
| `caller_avatar` | `asset('storage/' . Contact.avatar_path)` | Rich display |
| `call_id` | Same as `call_session_id` | Correlation with Telnyx push |
| `organization_id` | `CurrentTenant::get()->id` | Multi-org routing |
| `organization_name` | `CurrentTenant::get()->name` | Display |
| `organization_slug` | `CurrentTenant::get()->slug` | URL construction |

#### APNs VoIP Payload (iOS)

**File**: `app/Services/PushNotificationService.php:117-122`, `app/Services/ApnsVoipService.php:16-120`

Identical to FCM data payload, plus APNs envelope:
```json
{
  "...same fields as FCM data...",
  "aps": {
    "content-available": 1
  }
}
```

**HTTP/2 headers** (ApnsVoipService.php:40-49):
```
apns-topic: {bundleId}.voip
apns-push-type: voip
apns-priority: 10             (immediate delivery)
apns-expiration: 0            (do not store if device offline)
apns-collapse-id: {callSessionId}  (dedup if resent)
```

#### Call Ended Push

**File**: `PushNotificationService.php:162-228`

A separate push type sent when the call hangs up:

```json
{
  "type": "call_ended",
  "call_session_id": "uuid-call-session"
}
```

**Note**: Call ended push is NOT org-scoped — it uses `UserDeviceToken::getFcmTokensForUser()` (all orgs).

### Telnyx SDK Push

Telnyx sends its own push notification for call control metadata. This arrives independently of the Z360 push.

#### Telnyx FCM Payload (Android)

**File**: `android/.../Z360FirebaseMessagingService.kt`

Telnyx SDK injects a push with metadata as a JSON string:

```json
{
  "metadata": "{\"call_id\":\"telnyx-uuid\",\"caller_number\":\"8179398981\",\"caller_name\":\"Unknown\",...}",
  "message": "incoming_call"
}
```

**Detection**: Presence of `data["metadata"]` field distinguishes Telnyx push from Z360 push.

#### Telnyx APNs Payload (iOS)

**File**: `ios/.../PushKitManager.swift:536-581`

```json
{
  "metadata": {
    "call_id": "telnyx-uuid",
    "caller_number": "8179398981",
    "caller_name": "Unknown",
    "from_number": "8179398981"
  }
}
```

**Note**: Telnyx metadata may be a dictionary or a JSON string. iOS code handles both formats:
```swift
if let metadataDict = payload["metadata"] as? [String: Any] { ... }
if let metadataString = payload["metadata"] as? String { ... }  // Parse JSON
```

### Payload Comparison

| Field | Z360 Push | Telnyx Push |
|-------|-----------|-------------|
| `type` | `"incoming_call"` | N/A (implicit) |
| `caller_name` | Contact name or number | Usually `"Unknown"` |
| `caller_number` | Formatted (`+18179398981`) | Raw (`8179398981`) |
| `caller_avatar` | Full URL to avatar | Not present |
| `call_session_id` | Present | Not present |
| `call_id` | `= call_session_id` | Telnyx internal UUID |
| `organization_id` | Present | Not present |
| `organization_name` | Present | Not present |
| `metadata` (raw SIP) | Not present | Present (call control data) |

### Correlation Mechanism

Both platforms correlate pushes by **normalized phone number** (last 10 digits):

#### Android: PushSynchronizer

**File**: `android/.../PushSynchronizer.kt`

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

**Timeout**: 500ms (`SYNC_TIMEOUT_MS = 500L`)
**Mechanism**: `CompletableDeferred<SyncResult>` — Kotlin coroutine-based async coordination

**Scenarios**:
1. **Z360 arrives first**: Stores display info by normalized phone → when Telnyx arrives, immediately returns merged result
2. **Telnyx arrives first**: Creates pending `CompletableDeferred` → waits up to 500ms → returns merged or Telnyx-only result
3. **Timeout**: Proceeds with Telnyx data only, caller number displayed instead of name

#### iOS: PushCorrelator

**File**: `ios/.../PushCorrelator.swift`

```swift
private func normalizePhoneNumber(_ phone: String) -> String {
    let digits = phone.filter { $0.isNumber }
    return String(digits.suffix(10))
}
```

**Timeout**: 500ms (`syncTimeoutMs = 500`)
**Mechanism**: Swift Actor with `CheckedContinuation` — thread-safe async coordination

**Data structures**:
```swift
struct Z360PushData {
    let callId: UUID?
    let callerName: String
    let callerNumber: String
    let avatarUrl: String?
    let organizationId: String?
    let organizationName: String?
}

struct TelnyxPushData {
    let callId: String
    let callerNumber: String
}

struct MergedPushData {
    let callKitUUID: UUID
    let callerName: String
    let callerNumber: String
    let avatarUrl: String?
    let organizationId: String?
    let organizationName: String?
}
```

**UUID priority** for CallKit:
```swift
let callKitUUID: UUID
if let telnyxUUID = UUID(uuidString: telnyx.callId) {
    callKitUUID = telnyxUUID  // Prefer Telnyx UUID (SDK expects this)
} else if let z360UUID = z360.callId {
    callKitUUID = z360UUID
} else {
    callKitUUID = UUID()  // Generate as last resort
}
```

### Two-Push Timing Diagram

```
Time    Z360 Backend                    Telnyx Platform
────    ────────────                    ───────────────
  0ms   Webhook arrives
  5ms   Contact lookup
 10ms   Push constructed
 15ms   ──── Z360 FCM/APNs sent ────►
 20ms                                   Telnyx routes call
 25ms                                   ──── Telnyx FCM/APNs sent ────►

        ════════════════ DEVICE ═══════════════════

~100ms  Z360 push received
~150ms                                  Telnyx push received

        PushSynchronizer / PushCorrelator:
        ├── Z360 stored by normalized phone "8179398981"
        ├── Telnyx arrives → finds Z360 by phone → MERGED
        └── Result: { callerName: "Alice Smith", avatar: "...", callId: "telnyx-uuid" }

~200ms  CallKit/IncomingCallActivity displays enriched caller info

═══════════════════════════════════════════════════════
ALTERNATE: Telnyx arrives first

~100ms                                  Telnyx push received
        PushSynchronizer: Telnyx stored, waiting for Z360...
~150ms  Z360 push received
        PushSynchronizer: Z360 found → MERGED

═══════════════════════════════════════════════════════
ALTERNATE: Z360 never arrives (timeout)

~100ms                                  Telnyx push received
        PushSynchronizer: Telnyx stored, waiting 500ms...
~600ms  TIMEOUT — proceed with Telnyx data only
        Display: Phone number only, no name/avatar
```

---

## Summary: Data Shape Comparison Across All Flows

| Data Point | Backend Shape | Frontend Shape | Android Native | iOS Native |
|------------|---------------|----------------|----------------|------------|
| **Auth user** | Eloquent `User` + `organizations` | `SharedData.auth.user: User` | WebView cookies | WebView cookies |
| **Telnyx JWT** | String (10h TTL) | `SharedData.cpaas.telnyx.jwt` | Via plugin `connect()` | Via plugin `connect()` |
| **Org-level SIP** | `UserTelnyxTelephonyCredential` model | Inertia prop | Not used directly | Not used directly |
| **Device SIP** | `UserDeviceToken.sip_*` columns | API JSON response | `Profile` object → SDK | Keychain → `TelnyxService` |
| **Caller info** | `Contact.full_name` + `avatar_path` | WebSocket event payload | `Z360VoipStore` → Activity UI | `CallDisplayInfo` → CallKit |
| **Org context** | `CurrentTenant` static + `TenantScope` | Session + Inertia props | SharedPreferences / VoipStore | VoipStore / UserDefaults |
| **Z360 push** | `PushNotificationService` payload array | N/A (mobile only) | FCM `data` map (all strings) | PushKit dictionary |
| **Telnyx push** | N/A (from Telnyx) | N/A (mobile only) | FCM `metadata` JSON string | PushKit `metadata` dict/string |

---

*Generated: 2026-02-08*
*Source: Verified against Z360 codebase via skill-based exploration and direct file reads.*
