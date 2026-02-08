---
title: Credentials Unified
---

# Credential Management & Authentication: Unified Reference

> **Session 08 Synthesis** — Merges credential lifecycle tracing (Part A) and authentication/security analysis (Part B) into a single definitive reference for Z360's VoIP credential system.

---

## Executive Summary

Z360's VoIP credential system uses a **two-tier architecture** with **three authentication patterns** across platforms:

| Layer | Purpose | Used By | Auth Method |
|-------|---------|---------|-------------|
| Org-level credential (`UserTelnyxTelephonyCredential`) | JWT generation, org-scoped identity | Web (primary), cross-org call answer | JWT token (10h TTL) |
| Device-level credential (on `UserDeviceToken`) | Per-device SIP identity for simultaneous ring | iOS, Android, Web (per-device) | SIP credentials (permanent) |

All credentials are children of a single **Credential Connection** per deployment, created via `php artisan telnyx:setup`. The system has **13 identified issues** (4 critical, 4 moderate, 5 design observations) related to ghost credentials, missing cleanup, plaintext storage, and absent webhook verification.

---

## 1. Current State: Per-Platform Summary

### 1.1 Backend (Laravel)

**Credential Creation**:
- `CPaaSService::handleCredentials()` — creates org-level credential per (user, org). Called on every Inertia page load (as `Inertia::optional()`) and on every device registration.
- `CPaaSService::createDeviceCredential()` — creates per-device credential per (user, org, device). Called only when `sip_username` is null on the device token row.
- Both call `\Telnyx\TelephonyCredential::create()` with `{name, connection_id}`.

**Storage**:
- `user_telnyx_telephony_credentials` table — org-level: `(user_id, organization_id, credential_id, connection_id, sip_username, sip_password)`
- `user_device_tokens` table — device-level: adds `(telnyx_credential_id, sip_username, sip_password, connection_id, credential_expires_at)` to push token fields
- **SIP passwords stored in plaintext** in both tables (no `encrypted` cast)

**Credential Cleanup**:
- Device removal (`DeviceTokenController::destroy()`) — deletes Telnyx credential before DB row
- Web logout (`AuthenticatedSessionController`) — iterates web devices, deletes Telnyx credentials
- Stale cleanup on registration — deletes same-platform devices inactive 7+ days
- `CleanStaleDeviceTokens` scheduled command — **BUG: bulk-deletes DB rows WITHOUT deleting Telnyx credentials**
- Org-level credentials — **NEVER deleted** (no lifecycle management)

**API Surface**:
- `POST /api/device-tokens` — register device, get SIP credentials + JWT
- `DELETE /api/device-tokens/{deviceId}` — unregister device
- `GET /api/voip/credentials` — get org-level SIP credentials + JWT
- `POST /api/voip/switch-org` — switch org, get new credentials
- All protected by `['web', 'auth', 'set-current-tenant']` middleware
- CSRF disabled for `/api/*` routes (mitigated by SameSite=lax)
- **No rate limiting** on VoIP API endpoints

**Source files**: `app/Services/CPaaSService.php:161-265`, `app/Http/Controllers/Api/DeviceTokenController.php`, `app/Http/Controllers/Api/VoipCredentialController.php`, `config/cpaas.php`

### 1.2 Web Platform

**Authentication**: JWT-based via `@telnyx/react-client` `TelnyxRTCProvider`

**Flow**:
1. Page load → `HandleInertiaRequests` middleware generates fallback JWT via `handleCredentials()` (cached 30min by `useSessionCache`)
2. `useWebVoipCredentials` hook generates browser device ID (`web_{randomUUID}`, stored in `localStorage`)
3. `POST /api/device-tokens` with `{device_id, fcm_token: "web_{id}", platform: "web"}`
4. Backend creates org-level + per-device credentials, returns per-device JWT
5. Token priority: per-device JWT → server-side fallback JWT → string `'undefined'`

**Credential Storage**: None — JWT is ephemeral, received fresh on each registration

**Org Switch**: `useWebVoipCredentials` detects `organizationId` change, re-registers with new org, gets new JWT

**Cleanup**: On logout, sends `DELETE /api/device-tokens/{deviceId}` as best-effort

**Source files**: `resources/js/hooks/useWebVoipCredentials.ts`, `resources/js/layouts/app-layout.tsx:137`

### 1.3 iOS Platform

**Authentication**: SIP credential-based via `TxClient` (JWT broken on Android SDK, so SIP used everywhere for consistency)

**Flow**:
1. `registerAndConnect()` in `use-telnyx-voip.ts:315-395`
2. Requests microphone + CallKit permissions
3. Gets native device ID + PushKit VoIP token (5s wait for race condition)
4. `POST /api/device-tokens` with `{device_id, voip_token, platform: "ios"}`
5. Receives SIP credentials, calls `TelnyxVoip.connect({sipUsername, sipPassword})`
6. `TelnyxService.swift` creates `TxConfig` with `forceRelayCandidate: true` (avoids Local Network dialog)

**Credential Storage**: Apple Keychain via `KeychainManager`
- Keys: `z360_sip_username`, `z360_sip_password`, `z360_caller_id_name`, `z360_caller_id_number`
- Access: `kSecAttrAccessibleWhenUnlocked` (encrypted at rest, available only when unlocked)
- Non-sensitive data in UserDefaults: org context, VoIP token, call state

**Push Reconnection**: PushKit wakes app → reads credentials from Keychain → `processVoIPNotification()` connects SDK

**Session Expiry**: 30-day check based on VoIP token date. Clears VoIP data but keeps web session.

**Org Switch**: `OrganizationSwitcher.swift` — `POST /api/voip/switch-org` → stores new creds in Keychain → reconnects SDK (must complete within 5s CallKit deadline, with rollback on failure)

**Cleanup**: `disconnect(clearCredentials: true)` → `VoipStore.clearAll()` clears all Keychain keys + UserDefaults

**Source files**: `ios/App/App/VoIP/Services/TelnyxService.swift:75-108`, `ios/App/App/VoIP/Services/VoipStore.swift:170-213`, `ios/App/App/VoIP/Utils/KeychainManager.swift`, `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift`

### 1.4 Android Platform

**Authentication**: SIP credential-based (same as iOS)

**Flow**: Same JavaScript flow as iOS via `use-telnyx-voip.ts:315-395`, different native handler.

**Credential Storage**: Telnyx SDK `ProfileManager` → **plain SharedPreferences** (`TelnyxCommonSharedPreferences.xml`)
- Contains: `sipUsername`, `sipPass` (plaintext), `callerIdName`, `callerIdNumber`, `isUserLoggedIn`
- Z360's own `Z360VoipStore` correctly separates non-credential data

**Push Reconnection**: FCM data message → `Z360FCMService` checks `isUserLoggedIn()` → reads credentials from `ProfileManager` → `credentialLogin()`

**Session Expiry**: **None** — no equivalent of iOS 30-day check. Credentials persist indefinitely until explicit logout.

**Bug Fixes in Plugin**:
- BUG-003: Skips re-connect if SDK already connected from push flow
- BUG-006: Waits for `ClientLoggedIn` state before resolving connect promise

**Cleanup**: `disconnect(clearCredentials: true)` → `clearTelnyxProfiles()` + `store.clearAll()`

**Source files**: `android/.../TelnyxVoipPlugin.kt:119-179`, `android/.../Z360FCMService.kt:673-711`, `android/.../OrgSwitchHelper.kt`

---

## 2. Complete Gap List

### 2.1 Critical Issues

| # | Issue | Evidence | Impact |
|---|-------|----------|--------|
| **C1** | `CleanStaleDeviceTokens` bulk-deletes DB rows without deleting Telnyx credentials | `app/Console/Commands/CleanStaleDeviceTokens.php:24-30` — uses `->delete()` with no prior Telnyx API calls | Orphaned credentials accumulate on Telnyx indefinitely |
| **C2** | Org-level credentials never deleted | `CPaaSService::handleCredentials()` creates; nothing deletes. No DELETE call, no scheduled cleanup | Unbounded credential growth on Telnyx |
| **C3** | SIP passwords stored in plaintext in database | `UserTelnyxTelephonyCredential` and `UserDeviceToken` models have no `encrypted` cast on `sip_password` | DB compromise exposes all SIP credentials |
| **C4** | No Telnyx webhook signature verification | Grep for `verify|signature|hmac|signing_key` in `app/Http/Controllers/Telnyx/` returns zero matches | Attackers can forge call events, inject messages, terminate calls |

### 2.2 High Issues

| # | Issue | Evidence | Impact |
|---|-------|----------|--------|
| **H1** | Android SIP credentials in plain SharedPreferences | Telnyx SDK `TelnyxCommon.getSharedPreferences()` uses `Context.MODE_PRIVATE` without encryption | Rooted device/ADB backup exposes credentials |
| **H2** | SIP passwords exposed in API responses | `VoipCredentialController.php:76-87` and `DeviceTokenController.php:125-129` return `sip_password` in JSON | Visible in network logs, proxy servers, devtools |
| **H3** | `credential_expires_at` is set but never enforced | `CPaaSService.php:231` sets 30-day expiry; zero code reads this field | Credentials never actually rotate |
| **H4** | Cross-org call uses org-level creds, not per-device | `VoipCredentialController::switchOrg()` returns org-level SIP creds; device hasn't re-registered with new org | Different SIP identity than what Telnyx expects to dial |

### 2.3 Medium Issues

| # | Issue | Evidence | Impact |
|---|-------|----------|--------|
| **M1** | Two DeviceTokenControllers with different keying | `Api\DeviceTokenController` keys by `(user_id, org_id, device_id)`; `DeviceTokenController` keys by `fcm_token` | Potential duplicate/orphaned rows |
| **M2** | No rate limiting on VoIP API endpoints | `routes/api.php:15-25` — no `throttle` middleware | Credential endpoint abuse possible |
| **M3** | CSRF disabled for `/api/*` routes | `bootstrap/app.php:66-72` | Mitigated by SameSite=lax but not eliminated |
| **M4** | Android has no VoIP session expiry | No equivalent of iOS's 30-day check in Android code | Lost/stolen device continues receiving calls indefinitely |
| **M5** | SIP username logged without redaction on Android | `IncomingCallActivity.kt:5053` | Username visible in logcat during org switch |
| **M6** | `deleteTelnyxCredential()` silently fails | `CPaaSService.php:240-250` catches exceptions, logs warning | Failed deletions = orphaned credentials |
| **M7** | No uniqueness constraint on `(user_id, org_id, device_id)` | `user_device_tokens` migrations — no unique index | `updateOrCreate` relies on app-level logic only |
| **M8** | No FCM token validation | `StoreDeviceTokenRequest` validates string only, not token format | Fake tokens could be registered |

### 2.4 Design Observations

| # | Observation | Impact |
|---|-------------|--------|
| **D1** | Web `fcm_token` is a placeholder (`"web_{id}"`) | Column name misleading; web doesn't use FCM |
| **D2** | iOS uses PushKit VoIP token in `fcm_token` column | Column name misleading for iOS |
| **D3** | JWT auth broken on Android SDK 3.3.0 | All native platforms use SIP credential auth instead of JWT |
| **D4** | `handleCredentials()` called on every page load | Could create credentials eagerly for users who never use VoIP |
| **D5** | iOS Keychain not device-only | `kSecAttrAccessibleWhenUnlocked` vs `...ThisDeviceOnly` — credentials could appear in iCloud backup |
| **D6** | Session data not encrypted at rest | `config/session.php` — `encrypt = false` |

---

## 3. Official Telnyx Guidance Summary

### 3.1 Credential Management

- **Telephony Credentials** are created via `POST /v2/telephony_credentials` with `{name, connection_id}`
- **SIP credentials never expire** on Telnyx side — they persist until explicitly deleted via `DELETE /v2/telephony_credentials/{id}`
- **JWT tokens** generated via `GET /v2/telephony_credentials/{id}/token` have **10-hour TTL** (controlled by Telnyx)
- **One Credential Connection** can have many Telephony Credentials as children
- Credential names should be unique and descriptive for operational visibility

### 3.2 Authentication Methods

| Method | Recommended For | Security | Lifetime |
|--------|----------------|----------|----------|
| **JWT token auth** | Web/browser clients | Higher (short-lived, revocable by credential deletion) | 10 hours |
| **SIP credential auth** | Native mobile, persistent connections | Lower (long-lived, must be stored securely) | Permanent until deleted |

Telnyx recommends JWT for web and SIP credentials for mobile, which aligns with Z360's approach (though Z360 uses SIP for all native due to Android SDK bug).

### 3.3 Push Notification Integration

- **Android**: FCM data messages. Telnyx Notification Profile + Channel configured with FCM Server Key.
- **iOS**: APNs VoIP pushes via PushKit. Telnyx Notification Profile configured with APNs certificate/key.
- Push tokens must be associated with the SIP credential via the `push_device_token` parameter in `TxConfig`/`TelnyxConfig`.

### 3.4 Webhook Security

Telnyx provides **ED25519 signature verification** for all webhooks:
- Headers: `telnyx-signature-ed25519`, `telnyx-timestamp`
- PHP SDK provides `\Telnyx\Webhook::constructEvent()` for verification
- Recommended: reject payloads with timestamps older than 5 minutes (replay protection)
- **Z360 does not implement any webhook verification** — this is a critical gap

### 3.5 SDK Credential Storage

| Platform | Telnyx SDK Storage | Recommendation |
|----------|-------------------|----------------|
| Android | Plain `SharedPreferences` via `TelnyxCommon` | SDK limitation — consider filing issue for `EncryptedSharedPreferences` |
| iOS | N/A (app manages storage) | Z360 correctly uses Keychain |
| Web | N/A (JWT is ephemeral) | Correct approach |

---

## 4. Proposed Target Architecture

### 4.1 Principles

1. **Single source of truth**: One credential per (user, org, device) — eliminate the org-level/device-level split
2. **Idempotent creation**: Credential creation must be idempotent — same inputs = same credential, no duplicates
3. **Safe rotation**: Credentials rotate on a schedule with overlap period for graceful handoff
4. **Deterministic cleanup**: Every code path that removes a DB record MUST first delete the Telnyx credential
5. **Encryption at rest**: All SIP passwords encrypted in database and on device
6. **Verified webhooks**: All inbound webhooks verified via ED25519 signatures

### 4.2 Unified Credential Model

**Replace the two-tier system** with a single `user_device_credentials` table:

```
user_device_credentials
├── id (bigint, PK)
├── user_id (FK → users)
├── organization_id (FK → organizations)
├── device_id (string) — unique per device
├── platform (enum: android, ios, web)
├── telnyx_credential_id (string) — Telnyx API ID
├── sip_username (string, indexed)
├── sip_password (string, encrypted cast)
├── connection_id (string)
├── push_token (string, nullable) — FCM/APNs/placeholder
├── push_token_type (enum: fcm, apns_voip, web_none)
├── device_name (string, nullable)
├── app_version (string, nullable)
├── last_active_at (datetime)
├── credential_expires_at (datetime)
├── credential_rotated_at (datetime, nullable)
├── created_at / updated_at (timestamps)
├── UNIQUE INDEX (user_id, organization_id, device_id)
```

**Key changes**:
- Merge `user_device_tokens` + `user_telnyx_telephony_credentials` into one table
- Add `encrypted` cast on `sip_password`
- Add database-level unique constraint on `(user_id, organization_id, device_id)`
- Rename `fcm_token` to `push_token` + `push_token_type` for clarity
- Add `credential_rotated_at` for rotation tracking

### 4.3 Idempotent Credential Creation

```php
// CPaaSService::ensureDeviceCredential($user, $deviceId, $platform, $pushToken)
DB::transaction(function () use ($user, $deviceId, $platform, $pushToken) {
    $credential = UserDeviceCredential::lockForUpdate()
        ->where('user_id', $user->id)
        ->where('organization_id', CurrentTenant::id())
        ->where('device_id', $deviceId)
        ->first();

    if ($credential && $credential->telnyx_credential_id && !$credential->isExpired()) {
        // Credential exists and is valid — update push token + last_active_at
        $credential->update([
            'push_token' => $pushToken,
            'last_active_at' => now(),
        ]);
        return $credential;
    }

    // Delete old Telnyx credential if exists
    if ($credential?->telnyx_credential_id) {
        self::deleteTelnyxCredentialOrFail($credential->telnyx_credential_id);
    }

    // Create new Telnyx credential
    $telnyxCred = \Telnyx\TelephonyCredential::create([
        'name' => "Z360_{$user->id}_{$deviceId}_" . Str::random(4),
        'connection_id' => config('cpaas.telnyx.credential_connection_id'),
    ]);

    // Upsert with all fields
    return UserDeviceCredential::updateOrCreate(
        ['user_id' => $user->id, 'organization_id' => CurrentTenant::id(), 'device_id' => $deviceId],
        [
            'platform' => $platform,
            'telnyx_credential_id' => $telnyxCred->id,
            'sip_username' => $telnyxCred->sip_username,
            'sip_password' => $telnyxCred->sip_password,
            'connection_id' => config('cpaas.telnyx.credential_connection_id'),
            'push_token' => $pushToken,
            'last_active_at' => now(),
            'credential_expires_at' => now()->addDays(30),
        ]
    );
});
```

**Key improvements**:
- `lockForUpdate()` prevents race conditions on concurrent registration
- `DB::transaction()` ensures atomicity — either both Telnyx + DB succeed or neither
- Expiry is checked and enforced
- Old credential is deleted before new one is created

### 4.4 Deterministic Cleanup

```php
// Every deletion path MUST call this:
public static function deleteDeviceCredential(UserDeviceCredential $credential): void
{
    // Step 1: Delete from Telnyx (MUST succeed)
    if ($credential->telnyx_credential_id) {
        try {
            \Telnyx\TelephonyCredential::retrieve($credential->telnyx_credential_id)->delete();
        } catch (\Telnyx\Exception\InvalidRequestException $e) {
            // 404 = already deleted, acceptable
            if ($e->getHttpStatus() !== 404) {
                throw $e; // Re-throw non-404 errors
            }
        }
    }

    // Step 2: Delete DB row (only after Telnyx deletion succeeds)
    $credential->delete();
}
```

**Fix `CleanStaleDeviceTokens`**:
```php
// Instead of bulk delete, iterate and clean up properly:
UserDeviceCredential::where('last_active_at', '<', now()->subDays($days))
    ->chunkById(100, function ($credentials) {
        foreach ($credentials as $credential) {
            self::deleteDeviceCredential($credential);
        }
    });
```

### 4.5 Credential Rotation

```php
// Scheduled command: rotate-device-credentials (run daily)
UserDeviceCredential::where('credential_expires_at', '<', now())
    ->where('last_active_at', '>=', now()->subDays(7)) // Only rotate active devices
    ->chunkById(50, function ($credentials) {
        foreach ($credentials as $credential) {
            // Create new Telnyx credential
            $newCred = \Telnyx\TelephonyCredential::create([...]);

            // Update DB (old credential still works until next device registration)
            $credential->update([
                'telnyx_credential_id' => $newCred->id,
                'sip_username' => $newCred->sip_username,
                'sip_password' => $newCred->sip_password,
                'credential_expires_at' => now()->addDays(30),
                'credential_rotated_at' => now(),
            ]);

            // Delete old Telnyx credential AFTER new one is saved
            self::deleteTelnyxCredential($credential->getOriginal('telnyx_credential_id'));
        }
    });
```

**Note**: Rotation changes the SIP username, so the device must re-register on next app open to get the new credentials. The push notification channel remains working (push token is independent of SIP credentials).

### 4.6 Webhook Verification Middleware

```php
// app/Http/Middleware/VerifyTelnyxWebhook.php
class VerifyTelnyxWebhook
{
    public function handle(Request $request, Closure $next): Response
    {
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

### 4.7 Cross-Org Call Answer (Revised)

Current issue: Cross-org call answer uses org-level SIP credentials, which are a different identity than what Telnyx is trying to dial.

**Proposed fix**: During cross-org call answer, also re-register the device credential with the new org:

```
1. Push arrives for Org B while device connected to Org A
2. POST /api/voip/switch-org → switches session to Org B
3. POST /api/device-tokens → re-registers device with Org B (creates per-device credential)
4. Answer the call using the per-device SIP identity
5. (Old Org A device credential cleaned up on next registration or by stale cleanup)
```

This ensures the SIP identity answering the call matches what Telnyx expects.

---

## 5. Edge Cases Checklist

### 5.1 Authentication & Session Edge Cases

| # | Scenario | Current Behavior | Risk | Proposed |
|---|----------|-----------------|------|----------|
| E1 | Session expires while on active call | Call continues (SIP connection independent of HTTP session) | Low | Acceptable — call should continue |
| E2 | Session expires, push arrives | iOS: Credentials in Keychain work. Android: Credentials in SharedPrefs work. Backend: 401 on API calls | Medium | Add credential-level auth for push-initiated flows |
| E3 | User deleted while device has cached creds | Device continues receiving calls until credential deleted on Telnyx | High | User deletion must cascade-delete all Telnyx credentials |
| E4 | User removed from org (not deleted) | Org-level credential persists on Telnyx forever | High | Org membership change must trigger credential cleanup |

### 5.2 Device & Registration Edge Cases

| # | Scenario | Current Behavior | Risk | Proposed |
|---|----------|-----------------|------|----------|
| E5 | Multiple browser tabs register simultaneously | Web dedup deletes other web devices; race possible | Medium | Database-level unique constraint + lock |
| E6 | App force-quit during credential creation | Telnyx credential may exist without DB record | Medium | Transaction-based creation with rollback |
| E7 | FCM/APNs token refreshes | `use-push-notifications.ts` re-sends if >24h old | Low | Acceptable |
| E8 | App reinstall (new device_id) | Old device becomes stale (cleaned after 7 days) | Low | Acceptable |
| E9 | Same device_id, different user | `updateOrCreate` keyed by `(user_id, org_id, device_id)` — different users create separate rows | Low | Acceptable |

### 5.3 Multi-Org Edge Cases

| # | Scenario | Current Behavior | Risk | Proposed |
|---|----------|-----------------|------|----------|
| E10 | Org switch during active call | Call on old org continues; new org credentials loaded | Medium | Queue org switch until call ends |
| E11 | Rapid org switching (A→B→A) | Each switch creates new credentials, old ones may not be cleaned | High | Debounce org switch; ensure old credentials deleted |
| E12 | Cross-org call while already in cross-org call | Second org switch may fail (5s CallKit deadline) | High | Reject second cross-org call if already switching |
| E13 | User has 10+ orgs, all with credentials | Each org has separate org-level + device-level credentials | Medium | Lazy credential creation (only on first VoIP use per org) |

### 5.4 Push & Call Routing Edge Cases

| # | Scenario | Current Behavior | Risk | Proposed |
|---|----------|-----------------|------|----------|
| E14 | Push arrives before device registration completes | No SIP credentials yet → call missed | Medium | PushKit requires instant CallKit report; buffer the call |
| E15 | Multiple devices answer simultaneously | Redis distributed lock coordinates; SIP BYE + Reverb + push dismiss others | Low | Already handled |
| E16 | Stale device receives SIP INVITE | Telnyx dials all devices with SIP credentials active in last 24h | Medium | Reduce `last_active_at` threshold; add heartbeat |
| E17 | Telnyx rate limits credential creation | Telnyx returns 429 | Medium | Exponential backoff + circuit breaker in CPaaSService |

### 5.5 Failure & Recovery Edge Cases

| # | Scenario | Current Behavior | Risk | Proposed |
|---|----------|-----------------|------|----------|
| E18 | Telnyx API down during credential creation | Exception thrown, registration fails | Medium | Retry with backoff; return cached credentials if available |
| E19 | Telnyx API down during credential deletion | `deleteTelnyxCredential()` logs warning, continues | High | Queue failed deletions for retry (dead letter queue) |
| E20 | Database down during credential save | Telnyx credential created but not saved → ghost | High | Transaction with Telnyx rollback (delete credential on DB failure) |
| E21 | iOS app crash during org switch | Original context restored from pre-switch backup | Low | Already handled with rollback in `OrganizationSwitcher` |
| E22 | Android process killed during connect | SDK state may be inconsistent | Medium | Check SDK state on every push; reconnect if needed |

---

## 6. Step-by-Step Implementation Plan

### Phase 1: Critical Security Fixes (Sprint 1)

**1.1 Encrypt SIP passwords in database**
- Add `'sip_password' => 'encrypted'` to `$casts` on `UserTelnyxTelephonyCredential` and `UserDeviceToken`
- Create migration to encrypt existing plaintext passwords
- Test: Verify credentials still work after encryption (decrypt on read)
- Effort: Low (1-2 hours)

**1.2 Implement Telnyx webhook signature verification**
- Create `VerifyTelnyxWebhook` middleware
- Add `TELNYX_WEBHOOK_PUBLIC_KEY` to environment config
- Apply middleware to all `webhooks/cpaas/telnyx/*` routes
- Add replay protection (5-minute timestamp window)
- Test: Send verified and unverified webhook payloads
- Effort: Medium (4-6 hours)

**1.3 Fix `CleanStaleDeviceTokens` to delete Telnyx credentials first**
- Replace bulk `->delete()` with chunked iteration + individual Telnyx API delete
- Add logging for failed deletions
- Test: Run cleanup command, verify no orphaned Telnyx credentials
- Effort: Low (1-2 hours)

**1.4 Add rate limiting to VoIP API endpoints**
- Apply `throttle:10,1` to `/api/device-tokens` and `/api/voip/*` routes
- Effort: Low (30 minutes)

### Phase 2: Credential Lifecycle Fixes (Sprint 2)

**2.1 Add database unique constraint**
- Migration: `UNIQUE INDEX (user_id, organization_id, device_id)` on `user_device_tokens`
- Verify `updateOrCreate` behavior with constraint
- Effort: Low (1 hour)

**2.2 Enforce `credential_expires_at`**
- In `DeviceTokenController::store()`, check if credentials are expired before reusing
- If expired, delete old Telnyx credential and create new one
- Create scheduled command to rotate expired credentials for active devices
- Effort: Medium (3-4 hours)

**2.3 Add org-level credential cleanup**
- Create `CleanOrphanedOrgCredentials` command
- When user removed from org, delete their org-level credential
- Add observer on `Organization` member removal to trigger cleanup
- Effort: Medium (3-4 hours)

**2.4 Make credential deletion fail-safe**
- Replace `deleteTelnyxCredential()` silent failure with retry queue
- Log failed deletions to a `failed_credential_deletions` table
- Scheduled job retries failed deletions hourly
- Effort: Medium (4-6 hours)

### Phase 3: Cross-Org & Multi-Device Improvements (Sprint 3)

**3.1 Fix cross-org call answer to use per-device credentials**
- Modify `VoipCredentialController::switchOrg()` to also create per-device credential
- Or: Delay answer until per-device credential is established
- Test with simultaneous ring across orgs
- Effort: High (6-8 hours)

**3.2 Add Android VoIP session expiry**
- Implement 30-day check mirroring iOS `checkSessionExpiry()`
- Check on every push notification and app foreground
- Clear credentials and show re-login prompt when expired
- Effort: Medium (3-4 hours)

**3.3 Investigate Android encrypted credential storage**
- Evaluate wrapping Telnyx SDK with `EncryptedSharedPreferences`
- Consider filing issue with Telnyx for native encrypted storage
- Effort: High (investigation + potential SDK fork)

### Phase 4: Architectural Consolidation (Sprint 4)

**4.1 Unify credential tables**
- Merge `user_telnyx_telephony_credentials` + `user_device_tokens` into `user_device_credentials`
- Migrate data with zero-downtime strategy
- Update all controllers, services, and models
- Effort: Very High (multi-day effort, requires careful coordination)

**4.2 Consolidate DeviceTokenControllers**
- Merge the two `DeviceTokenController` classes into one with consistent keying
- Update routes and all callers
- Effort: Medium (4-6 hours)

---

## 7. Testing Plan

### 7.1 Unit Tests

| Test | Covers | Priority |
|------|--------|----------|
| `CPaaSService::ensureDeviceCredential` idempotency | Same device_id returns same credential | P1 |
| `CPaaSService::ensureDeviceCredential` with expired credential | Creates new credential when expired | P1 |
| `CleanStaleDeviceTokens` deletes Telnyx credentials | No orphaned credentials after cleanup | P1 |
| Webhook signature verification middleware | Rejects invalid/missing signatures | P1 |
| Webhook replay protection | Rejects old timestamps | P1 |
| SIP password encryption/decryption | Passwords encrypted at rest, readable in app | P1 |
| Rate limiting on VoIP endpoints | 429 after threshold | P2 |
| Cross-org credential creation | New credentials created for target org | P2 |

### 7.2 Integration Tests

| Test | Covers | Priority |
|------|--------|----------|
| Full device registration flow (POST /api/device-tokens) | Credential creation, JWT generation, response format | P1 |
| Device re-registration (same device_id) | Reuses existing credential, updates push token | P1 |
| Device unregistration (DELETE /api/device-tokens/{id}) | Deletes Telnyx credential + DB row | P1 |
| Org switch flow (POST /api/voip/switch-org) | New credentials, session switch, access control | P1 |
| Concurrent registration (same device_id, 2 requests) | No duplicate credentials; database lock prevents race | P2 |
| Stale device cleanup | 7-day inactive devices cleaned with Telnyx credentials | P2 |
| Web logout credential cleanup | Web devices + Telnyx credentials deleted | P2 |

### 7.3 Manual Test Scenarios

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| M1 | Fresh login → make call | Login on iOS → register device → make outbound call | Call succeeds with per-device SIP identity |
| M2 | Receive call on multiple devices | Register iOS + Android + Web → call the number | All 3 ring simultaneously; answer on one dismisses others |
| M3 | Org switch during call | Active call on Org A → switch to Org B in web | Call continues; new org credentials ready for next call |
| M4 | Cross-org incoming call | Call arrives for Org B while iOS connected to Org A | iOS switches org, answers call within 5s |
| M5 | Logout + re-login | Logout on iOS → verify Keychain cleared → login again | New credentials created; old credentials deleted from Telnyx |
| M6 | App reinstall | Uninstall → reinstall → login | New device_id, new credentials; old device becomes stale |
| M7 | Session expiry (30 day) | Wait 30+ days (or mock) → receive push | iOS: VoIP cleared, call missed. Android: Call still works (gap) |
| M8 | Network failure during registration | Airplane mode during POST /api/device-tokens | Registration retried on reconnect; no ghost credentials |
| M9 | Telnyx API outage | Mock Telnyx 500 during credential creation | Graceful error; user informed; no ghost credentials |
| M10 | Multiple browser tabs | Open 3 tabs → verify only 1 web device registered | Web dedup ensures single device; no duplicates |

---

## 8. End-to-End Architecture Diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │                  TELNYX CLOUD                    │
                    │                                                  │
                    │  Credential Connection (1 per deployment)        │
                    │  ├─ Telephony Cred: Z360_1_web_abc_Xr4m (web)  │
                    │  ├─ Telephony Cred: Z360_1_ios_def_Yz2n (iOS)  │
                    │  ├─ Telephony Cred: Z360_1_and_ghi_Wq8p (And)  │
                    │  └─ (org-level creds — TO BE ELIMINATED)        │
                    │                                                  │
                    │  WebRTC Gateway ← SIP INVITEs to device creds   │
                    │  PSTN Gateway → Call Control App webhook         │
                    │  Notification Service → FCM/APNs push            │
                    └──────────────────┬──────────────────────────────┘
                                       │ HTTPS API + ED25519 webhooks
                                       │
                    ┌──────────────────┴──────────────────────────────┐
                    │              LARAVEL BACKEND                     │
                    │                                                  │
                    │  ┌─ user_device_credentials (PROPOSED) ─────┐   │
                    │  │  UNIQUE(user_id, org_id, device_id)       │   │
                    │  │  telnyx_credential_id, sip_username,      │   │
                    │  │  sip_password (ENCRYPTED), push_token,    │   │
                    │  │  credential_expires_at (ENFORCED)         │   │
                    │  └──────────────────────────────────────────┘   │
                    │                                                  │
                    │  CPaaSService                                    │
                    │  ├─ ensureDeviceCredential() [IDEMPOTENT]       │
                    │  ├─ deleteDeviceCredential() [FAIL-SAFE]        │
                    │  ├─ rotateExpiredCredentials() [SCHEDULED]       │
                    │  └─ getDeviceJwt() [FOR WEB ONLY]               │
                    │                                                  │
                    │  VerifyTelnyxWebhook middleware [NEW]            │
                    │  Rate limiting on all VoIP endpoints [NEW]       │
                    └──────────────────┬──────────────────────────────┘
                                       │
               ┌───────────────────────┼───────────────────────┐
               │                       │                       │
     ┌─────────┴────────┐   ┌─────────┴────────┐   ┌─────────┴────────┐
     │   WEB BROWSER     │   │   iOS DEVICE      │   │   ANDROID DEVICE  │
     │                   │   │                   │   │                   │
     │ Auth: JWT (10h)   │   │ Auth: SIP creds   │   │ Auth: SIP creds   │
     │                   │   │                   │   │                   │
     │ Storage: none     │   │ Storage: Keychain  │   │ Storage: SharedP  │
     │ (ephemeral JWT)   │   │ (encrypted, HW)   │   │ (SDK limitation)  │
     │                   │   │                   │   │                   │
     │ Push: Reverb WS   │   │ Push: PushKit/APNs │   │ Push: FCM data    │
     │                   │   │                   │   │                   │
     │ Expiry: page load │   │ Expiry: 30-day     │   │ Expiry: NONE [FIX]│
     │ triggers refresh  │   │ token date check   │   │                   │
     └──────────────────┘   └──────────────────┘   └──────────────────┘
```

---

## 9. Key Decisions for Team Review

1. **Should we eliminate org-level credentials entirely?** They only serve JWT generation for web. If we generate JWTs from per-device credentials instead, we can remove an entire credential tier and its associated ghost credential problems.

2. **Table merge vs incremental fix?** Merging the two tables (Phase 4) is the cleanest architecture but highest effort. The incremental fixes in Phases 1-3 address all critical issues without the migration risk.

3. **Cross-org call answer strategy?** Option A: Re-register device with new org during call answer (adds latency). Option B: Keep org-level credential for cross-org only (current approach, but fix the SIP identity mismatch).

4. **Android SDK credential storage?** Fork the Telnyx SDK to use `EncryptedSharedPreferences`? File an upstream issue? Accept the risk with documentation?

5. **Credential rotation cadence?** 30 days (current, unenforced) vs 7 days (more secure, more API calls) vs on-demand only (rotate on re-registration)?

---

*Document generated: 2026-02-08*
*Synthesized from: credential-lifecycle.md (credential-tracer) + authentication-and-security.md (auth-analyst)*
*Research scope: Z360 VoIP credential management across Web, iOS, Android, and Laravel backend*
