---
title: Configuration Complete
---

# Z360 VoIP: Complete Configuration and Deployment Guide

> **Scope**: Comprehensive reference covering every configuration value, build process, and deployment requirement for the Z360 VoIP system across all platforms (Laravel backend, React web client, Android native, iOS native).
>
> **Synthesized from**:
> - `configuration-reference.md` — All configuration values with per-item documentation
> - `build-and-deployment.md` — Build processes, deployment infrastructure, CI/CD
>
> **Audience**: Engineers setting up, building, deploying, or troubleshooting the Z360 VoIP system.

---

## Table of Contents

1. [Prerequisites and Architecture Overview](#1-prerequisites-and-architecture-overview)
2. [Development Environment Setup](#2-development-environment-setup)
3. [Telnyx Configuration](#3-telnyx-configuration)
4. [Firebase Configuration](#4-firebase-configuration)
5. [APNs Configuration (iOS VoIP Push)](#5-apns-configuration-ios-voip-push)
6. [Capacitor Configuration (Mobile)](#6-capacitor-configuration-mobile)
7. [Laravel Backend Configuration](#7-laravel-backend-configuration)
8. [Android Build and Configuration](#8-android-build-and-configuration)
9. [iOS Build and Configuration](#9-ios-build-and-configuration)
10. [Web Client Build](#10-web-client-build)
11. [Backend Deployment (Production)](#11-backend-deployment-production)
12. [Environment Differences: Dev vs Production](#12-environment-differences-dev-vs-production)
13. [CI/CD Pipeline](#13-cicd-pipeline)
14. [Known Issues and Warnings](#14-known-issues-and-warnings)
15. [Quick Reference Tables](#15-quick-reference-tables)

---

## 1. Prerequisites and Architecture Overview

### 1.1 What You Need

Before configuring the VoIP system, you need accounts and credentials from:

| Service | What to Create | Required For |
|---------|---------------|-------------|
| **Telnyx** | Account + API key, Call Control App, Credential Connection, OVP, Notification Profile | All voice calling (inbound, outbound, WebRTC) |
| **Firebase** | Project + service account JSON + `google-services.json` + `GoogleService-Info.plist` | Push notifications (Android FCM), crash reporting, analytics |
| **Apple Developer** | Team account + APNs auth key (.p8) + provisioning profiles with VoIP capability | iOS VoIP push via PushKit, App Store distribution |
| **AWS** | Account with ECS Fargate, S3, ElastiCache, Aurora PostgreSQL | Production deployment |
| **Docker** | Docker Desktop installed locally | Development environment |

### 1.2 VoIP Architecture Context

The VoIP system spans four layers, each with distinct configuration needs:

```
┌────────────────────────────────────────────────────────────────────┐
│  LARAVEL BACKEND                                                    │
│  Config: .env.base, config/cpaas.php, config/services.php          │
│  Purpose: Telnyx webhooks, push notifications, SIP credentials,    │
│           Redis-based simring locking, Reverb WebSocket             │
├────────────────────────────────────────────────────────────────────┤
│  WEB CLIENT (React + Inertia.js)                                    │
│  Config: vite.config.ts, VITE_REVERB_* env vars                   │
│  Purpose: @telnyx/react-client WebRTC, Reverb real-time events     │
├────────────────────────────────────────────────────────────────────┤
│  ANDROID NATIVE (Kotlin)                                            │
│  Config: build.gradle, AndroidManifest.xml, google-services.json   │
│  Purpose: Telnyx SDK, ConnectionService, FCM, foreground services  │
├────────────────────────────────────────────────────────────────────┤
│  iOS NATIVE (Swift)                                                 │
│  Config: Info.plist, App.entitlements, GoogleService-Info.plist     │
│  Purpose: Telnyx SDK, CallKit, PushKit, audio session management   │
└────────────────────────────────────────────────────────────────────┘
```

### 1.3 The Two-Push System

A critical configuration concept: incoming mobile calls use a **dual-push architecture**:
1. **Z360 push** (server-sent via FCM/APNs) — carries caller info (name, avatar, org context)
2. **Telnyx push** (sent by Telnyx SDK infrastructure) — carries SIP call control data

Both pushes are correlated by normalized phone number (last 10 digits) with a 500ms sync timeout. This means **both push systems must be configured correctly** for incoming calls to work on mobile.

---

## 2. Development Environment Setup

### 2.1 Docker Services

Z360 runs entirely in Docker. No local PHP/Node.js required.

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| `app` | `z360:dev` (multi-stage Dockerfile) | `7360:80`, `5173:5173`, `5174:5174` | Laravel app + dual Vite dev servers |
| `queue` | `z360:dev` | none | Queue worker (`php artisan queue:listen`) |
| `reverb` | `z360:dev` | `7361:8080` | WebSocket server (`php artisan reverb:start`) |
| `pgsql` | `postgres:17` | `5432:5432` | PostgreSQL database |
| `valkey` | `valkey/valkey:alpine` | `6379:6379` | Redis-compatible cache/queue/session |
| `minio` | `minio/minio:latest` | `9000:9000`, `8900:8900` | S3-compatible storage |
| `pgadmin` | `dpage/pgadmin4` (profile) | `7362:80` | Database GUI (optional) |
| `ngrok` | `ngrok/ngrok` (profile) | none | Tunnel for webhooks (optional) |

**References**: `docker-compose.yml`, `docker/Dockerfile`

### 2.2 First-Time Setup

```bash
make setup    # Build Docker images, install deps, generate .env, migrate, seed
```

This runs: `make install` → `make seed-files` → `make migrate` → `make seed`

**Reference**: `Makefile:295-365`

### 2.3 Environment Configuration (3-Layer System)

| Layer | File | Tracked | Purpose |
|-------|------|---------|---------|
| Base | `.env.base` | Yes (git) | Default values for all variables |
| Override | `.env.base.override` | No (gitignored) | Developer-specific overrides (real Telnyx keys, Firebase creds) |
| Generated | `.env` | No (gitignored) | Combined output from `php artisan make:env` |

**After changing `.env.base` or `.env.base.override`**: Run `make env` to regenerate `.env`.

### 2.4 Webhook Testing (Cloudflare Tunnel)

Telnyx webhooks must reach your local server. Z360 uses **Cloudflare Tunnel** as the primary method:

```bash
# Place tunnel-credentials.json in .cloudflared/
make tunnel-bg       # Start in background
make tunnel-stop     # Stop tunnel
make tunnel-status   # Check status + connectivity
```

**Tunnel routes** (`.cloudflared/config.yml`):
- `dev.z360.cloud` → `http://localhost:7360` (main app)
- `dev-storage.z360.cloud` → `http://localhost:9000` (MinIO)

**Alternative**: Docker-based ngrok via `make profile-up profile=ngrok` (requires `NGROK_AUTHTOKEN` and `NGROK_HOSTNAME` in `.env`).

**Reference**: `.cloudflared/config.yml`, `Makefile:649-714`, `docker-compose.yml:166-181`

### 2.5 Daily Development Workflow

```bash
make up       # Start all Docker services
make down     # Stop all services
make shell    # Access app container bash
make logs     # View logs (default: app; usage: make logs service=queue)
```

The `app` container auto-starts 4 processes: Laravel HTTP server, Pail log viewer, Vite dev server (port 5173), Widget dev server (port 5174).

**Reference**: `Makefile:166-195`, `composer.json:62-65`

---

## 3. Telnyx Configuration

All Telnyx values live in `config/cpaas.php`, sourced from environment variables in `.env.base` (lines 174-179).

### 3.1 Resource Hierarchy

```
Telnyx Account
 ├── Outbound Voice Profile (OVP)           → TELNYX_OUTBOUND_VOICE_PROFILE_ID
 ├── Credential Connection                  → TELNYX_CREDENTIAL_CONNECTION_ID
 │    └── N Telephony Credentials (per-user, per-device)
 ├── Call Control Application               → TELNYX_CALL_CONTROL_APP_ID
 └── Notification Profile + Channel         → TELNYX_NOTIFICATIONS_PROFILE_ID
```

### 3.2 Environment Variables

#### `TELNYX_API_KEY`

| | |
|---|---|
| **What** | V2 API key authenticating all server-side Telnyx REST calls (SIP credential CRUD, call control, number provisioning, messaging). |
| **Where** | `.env.base` line 175 → `config/cpaas.php` line 5. Also used by `telnyx/telnyx-php` SDK. |
| **Obtain** | Telnyx Portal → API Keys → Create API Key (produces `KEY...` string). |
| **If missing** | **All server-side Telnyx operations fail** — no outbound calls, no SIP credential creation, no messaging. The `telnyx:setup` command aborts immediately. |
| **Dev vs Prod** | Same key works if using single Telnyx account; most teams use separate accounts per environment. |

#### `TELNYX_CALL_CONTROL_APP_ID`

| | |
|---|---|
| **What** | Call Control Application ID. Receives webhook events for inbound/outbound PSTN calls (call.initiated, call.answered, call.hangup). Webhook URL: `{APP_URL}/webhooks/cpaas/telnyx/call-control`. |
| **Where** | `.env.base` line 178 → `config/cpaas.php` line 6 as `call_control_id`. |
| **Obtain** | Telnyx Portal → Call Control → Applications, or auto via `php artisan telnyx:setup call_control_id`. |
| **If missing** | Inbound calls not routed to Z360. Outbound call control commands fail. Entire call flow webhook pipeline breaks. |
| **Dev vs Prod** | **Different per environment** — each needs its own app pointing to its own webhook URL. |

#### `TELNYX_OUTBOUND_VOICE_PROFILE_ID` (OVP)

| | |
|---|---|
| **What** | Controls outbound calling policies (CNAM, allowed destinations). Both Call Control App and Credential Connection reference this OVP. |
| **Where** | `.env.base` line 176 → `config/cpaas.php` line 7 as `ovp_id`. |
| **Obtain** | Telnyx Portal → Outbound Voice Profiles, or `php artisan telnyx:setup ovp_id`. |
| **If missing** | Outbound calls fail — neither call control nor WebRTC outbound calls can be placed. |
| **Dev vs Prod** | Typically same within same Telnyx account. |

#### `TELNYX_CREDENTIAL_CONNECTION_ID`

| | |
|---|---|
| **What** | Parent "connection" under which per-user/per-device SIP credentials are created. Enables WebRTC calling from browsers and native apps. Webhook URL: `{APP_URL}/webhooks/cpaas/telnyx/credential`. |
| **Where** | `.env.base` line 177 → `config/cpaas.php` line 8 as `credential_connection_id`. |
| **Obtain** | Telnyx Portal → SIP Trunking → Credential Connections, or `php artisan telnyx:setup credential_connection_id` (requires OVP first). |
| **If missing** | SIP credential creation fails → no WebRTC registration → no browser or native app calling. |
| **Dev vs Prod** | **Different per environment** — webhook URLs differ. |

#### `TELNYX_NOTIFICATIONS_PROFILE_ID`

| | |
|---|---|
| **What** | Notification Profile for Telnyx push notifications to mobile devices via FCM/APNs when inbound call arrives on a SIP credential (the "Telnyx push" in the two-push system). Webhook URL: `{APP_URL}/webhooks/cpaas/telnyx/notifications`. |
| **Where** | `.env.base` line 179 → `config/cpaas.php` line 9 as `notifications_profile_id`. |
| **Obtain** | Telnyx Portal → Notification Profiles, or `php artisan telnyx:setup notifications`. |
| **If missing** | Telnyx-side push for incoming calls doesn't fire. Mobile apps won't receive Telnyx push. Two-push correlation is one-sided (only Z360 push works). |
| **Dev vs Prod** | **Different per environment** — webhook URLs differ. |

### 3.3 Automated Setup Command

```bash
php artisan telnyx:setup              # Creates all resources (OVP, Credential Connection, Call Control App, Notification Profile)
php artisan telnyx:setup {mode}       # Modes: call_control_id, ovp_id, credential_connection_id, notifications, all
php artisan telnyx:setup --force      # Recreate even if IDs already exist
```

**Prerequisite**: `TELNYX_API_KEY` must be set. For `credential_connection_id` and `call_control_id`, `ovp_id` must exist first.

The command uses `CPaaSService::tunnelSafeUrl()` to automatically use the tunnel hostname for webhook URLs in development.

### 3.4 Webhook Endpoints (Must Be Publicly Accessible)

| Endpoint | Controller | Purpose |
|----------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/notifications` | `TelnyxNotificationsWebhookController` | Push notification events |
| `POST /webhooks/cpaas/telnyx/call-control` | `TelnyxInboundWebhookController` | Inbound call control events |
| `POST /webhooks/cpaas/telnyx/call-control/failover` | `TelnyxInboundWebhookController@failover` | Call control failover |
| `POST /webhooks/cpaas/telnyx/credential` | `TelnyxOutboundWebhookController` | Credential-based (outbound) events |
| `POST /webhooks/cpaas/telnyx/credential/failover` | `TelnyxOutboundWebhookController@failover` | Credential failover |
| `POST /webhooks/cpaas/telnyx/sms` | `TelnyxSMSWebhookController` | SMS delivery events |
| `POST /webhooks/cpaas/telnyx/a2p` | `TelnyxA2PWebhookController` | A2P campaign events |
| `POST /webhooks/cpaas/telnyx/rcs` | `TelnyxRCSWebhookController` | RCS message events |

**Reference**: `routes/webhooks.php`

---

## 4. Firebase Configuration

Firebase serves three purposes: (a) FCM push to Android, (b) Firebase services on iOS (Analytics, Crashlytics), (c) Laravel backend FCM HTTP v1 API.

### 4.1 Backend Configuration

#### `FIREBASE_CREDENTIALS`

| | |
|---|---|
| **What** | JSON-encoded Firebase service account credentials. Used by `kreait/firebase-php` SDK and `PushNotificationService` for FCM HTTP v1 API access token generation. |
| **Where** | `.env.base` line 184. Consumed by: (1) `config/firebase.php` line 53 via `json_decode()`, (2) `config/services.php` line 56 for path-based credentials. |
| **Obtain** | Firebase Console → Project Settings → Service Accounts → Generate New Private Key. Paste entire JSON string as env value. |
| **If missing** | **All FCM push notifications fail** — Android devices won't receive incoming call pushes. `PushNotificationService::getAccessToken()` throws `RuntimeException: Firebase credentials file not found`. |

#### `FIREBASE_PROJECT_ID`

| | |
|---|---|
| **What** | Firebase project ID (e.g., `z360-c7d9e`). Used to construct FCM API URL: `https://fcm.googleapis.com/v1/projects/{PROJECT_ID}/messages:send`. |
| **Where** | `config/services.php` line 55. Default: `z360-c7d9e`. |
| **If wrong** | FCM API calls return 404 or 403. |

#### `FIREBASE_CREDENTIALS_PATH`

| | |
|---|---|
| **What** | Filesystem path to Firebase service account JSON file. |
| **Where** | `config/services.php` line 56. Default: `storage_path('z360-c7d9e-firebase-adminsdk-fbsvc-dca3e28ad0.json')`. |
| **Gitignored** | Yes — `.gitignore` line 82: `storage/*-firebase-adminsdk-*.json`. |
| **If missing** | `PushNotificationService` throws `RuntimeException`. |

### 4.2 Android: `google-services.json`

| | |
|---|---|
| **What** | Firebase Android config (API key, project ID, GCM sender ID). Required for FCM, Crashlytics, Analytics, Performance, Remote Config. |
| **Where** | `android/app/google-services.json`. **Gitignored** (`.gitignore` line 83). |
| **Obtain** | Firebase Console → Project Settings → Your apps → Android app → Download. `applicationId` must match `com.z360.app`. |
| **If missing** | Build succeeds (gradle conditionally skips plugin at lines 142-148), but FCM, Crashlytics, Analytics disabled. Logger outputs: `"google-services.json not found, google-services plugin not applied. Push Notifications won't work"`. |

### 4.3 iOS: `GoogleService-Info.plist`

| | |
|---|---|
| **What** | Firebase iOS config (API_KEY, GCM_SENDER_ID, PROJECT_ID, BUNDLE_ID, GOOGLE_APP_ID). |
| **Where** | `ios/App/App/GoogleService-Info.plist`. **Currently tracked in git** (not gitignored). |
| **Key values** | `PROJECT_ID: z360-c7d9e`, `BUNDLE_ID: com.z360biz.app`, `GCM_SENDER_ID: 699830885674`. |
| **If invalid** | `AppDelegate.swift` skips `FirebaseApp.configure()`. Warning: `"Firebase NOT configured - GoogleService-Info.plist contains placeholder values"`. |
| **Security note** | This file contains real Firebase API keys and is tracked in git. Consider gitignoring it like the Android equivalent. |

---

## 5. APNs Configuration (iOS VoIP Push)

APNs VoIP push wakes iOS devices for incoming calls via PushKit. Configuration lives in `config/services.php` lines 59-71.

### 5.1 Core Settings

#### `APNS_VOIP_ENABLED`

| | |
|---|---|
| **What** | Master toggle for APNs VoIP push. When `false`, `ApnsVoipService::sendVoipPush()` skips sending. |
| **Where** | `config/services.php` line 60. Default: `false`. |
| **If false** | iOS devices won't receive Z360-side VoIP push. Telnyx-side push may still work independently. Two-push correlation degraded. |
| **Dev vs Prod** | `true` in production. `true` in dev only if APNs credentials are configured and iOS push testing needed. |

#### `APNS_VOIP_ENV`

| | |
|---|---|
| **What** | APNs environment: `development` or `production`. Determines gateway URL. |
| **Where** | `config/services.php` line 61. Default: `development`. |
| **Gateways** | `development` → `api.sandbox.push.apple.com`, `production` → `api.push.apple.com`. |
| **If wrong** | Push tokens from the wrong environment are rejected. Sandbox tokens don't work on production gateway and vice versa. |
| **Dev vs Prod** | **Must differ**: `development` for debug/TestFlight, `production` for App Store. |

#### `APNS_VOIP_BUNDLE_ID`

| | |
|---|---|
| **What** | App bundle identifier. Used to construct APNs topic: `{bundle_id}.voip`. PushKit requires the `.voip` suffix. |
| **Where** | `config/services.php` line 62. |
| **Expected** | `com.z360biz.app` (matching iOS Xcode project's `PRODUCT_BUNDLE_IDENTIFIER`). |
| **If missing** | `ApnsVoipService::sendVoipPush()` returns `false` with warning. |

### 5.2 Token-Based Authentication (Preferred)

| Variable | Where | Details |
|----------|-------|---------|
| `APNS_VOIP_KEY_ID` | `config/services.php` line 64 | 10-character Key ID from Apple Developer Portal |
| `APNS_VOIP_TEAM_ID` | `config/services.php` line 65 | 10-character Apple Developer Team ID |
| `APNS_VOIP_KEY_PATH` | `config/services.php` line 66 | Path to `.p8` APNs Auth Key file (gitignored: `*.p8`) |

**How it works**: `ApnsVoipService::getJwt()` creates an ES256 JWT signed with the `.p8` key. JWT contains `iss` (team_id) and `iat`. Cached for 50 minutes.

### 5.3 Certificate-Based Authentication (Fallback)

| Variable | Where | Details |
|----------|-------|---------|
| `APNS_VOIP_CERT_PATH` | `config/services.php` line 68 | Path to VoIP push certificate `.pem` |
| `APNS_VOIP_CERT_PASSPHRASE` | `config/services.php` line 69 | Certificate passphrase |
| `APNS_VOIP_CERT_KEY_PATH` | `config/services.php` line 70 | Certificate private key path |

Falls back to certificate auth if token auth fields are empty. Uses HTTP/2 via Guzzle.

### 5.4 APNs Technical Details

- **VoIP push topic**: `{bundle_id}.voip` (e.g., `com.z360biz.app.voip`) — automatic in `ApnsVoipService`
- **Push priority**: `10` (immediate) — time-sensitive call notifications
- **Expiration**: `0` (deliver now, don't store) — stale call notifications are useless
- **Collapse ID**: Set to `callSessionId` — prevents duplicate notifications for same call

---

## 6. Capacitor Configuration (Mobile)

### 6.1 Core Settings (`capacitor.config.ts`)

| Setting | Value | Notes |
|---------|-------|-------|
| `appId` | `com.z360.app` | Must match Android `applicationId`. **Warning**: iOS uses `com.z360biz.app` — see Known Issues. |
| `appName` | `Z360` | Display name |
| `webDir` | `public` | Built web assets directory |
| `appendUserAgent` | `Z360Capacitor` | Identifies Capacitor WebView to server |

### 6.2 Server Configuration

#### `CAPACITOR_SERVER_URL`

| | |
|---|---|
| **What** | URL the mobile WebView loads. In dev: points to dev server for hot-reload. In prod: unset (loads bundled assets). |
| **Where** | `.env.base` line 17. Default: `https://dev.z360.cloud`. Consumed by `capacitor.config.ts` lines 22-47. |
| **Dev** | Set to `https://dev.z360.cloud` or `http://192.168.1.x:7360`. Config generates `server` block with `url`, `cleartext`, `androidScheme`. |
| **Prod** | **Unset/remove** — app uses bundled assets from `webDir`. |

### 6.3 Platform Overrides

**iOS** (`capacitor.config.ts` lines 48-53):
- `contentInset: 'never'` — prevents double safe-area insets
- `backgroundColor: '#FFFFFF'` — prevents white flash on launch

**Android** (`capacitor.config.ts` lines 54-59):
- Keystore settings are `undefined` — configured in `build.gradle` instead

### 6.4 Plugin Configuration

| Plugin | Settings | Notes |
|--------|----------|-------|
| StatusBar | `overlaysWebView: true, style: 'DEFAULT'` | Status bar overlays content |
| Keyboard | `resize: None, resizeOnFullScreen: true` | No viewport resize (CSS handles it) |
| PushNotifications | `presentationOptions: ['badge', 'sound']` | No `alert` — foreground display via `LocalNotifications` for tap-to-navigate |

### 6.5 Capacitor Plugin Dependencies (SPM)

From `ios/App/CapApp-SPM/Package.swift`:
- `capacitor-swift-pm` 8.0.0
- `@capacitor/browser` 8.0.0
- `@capacitor/keyboard` 8.0.0
- `@capacitor/local-notifications` 8.0.0
- `@capacitor/push-notifications` 8.0.0
- `@capacitor/status-bar` 8.0.0

Note: Telnyx and Firebase iOS SDKs are **direct Xcode SPM dependencies**, not Capacitor plugins.

---

## 7. Laravel Backend Configuration

### 7.1 Database (PostgreSQL)

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_CONNECTION` | `pgsql` | Must be `pgsql` |
| `DB_HOST` | `pgsql` | Docker service name; Aurora endpoint in production |
| `DB_PORT` | `5432` | Standard PostgreSQL port |
| `DB_USERNAME` | `appuser` | |
| `DB_PASSWORD` | `appsecret` | |
| `DB_DATABASE` | `z360` | |
| `DB_SECRET` | `"{}"` | JSON for Aurora auto-rotation (overrides individual DB_* vars when valid) |

**VoIP tables**: `user_device_tokens` (FCM tokens, APNs tokens, SIP credentials, device metadata), `user_telnyx_telephony_credentials` (per-user/per-device SIP credentials), `messages` (call records).

**Reference**: `.env.base` lines 50-56, `config/database.php`

### 7.2 Redis / Valkey (CRITICAL for VoIP)

| Variable | Default | Notes |
|----------|---------|-------|
| `REDIS_CLIENT` | `phpredis` | PHP extension-based client |
| `REDIS_HOST` | `valkey` | Docker service name; ElastiCache in production |
| `REDIS_PORT` | `6379` | |
| `REDIS_PASSWORD` | `null` | |

**Why Redis is CRITICAL for VoIP**:
- **Simultaneous ring distributed locking**: `Cache::lock("simring:{$parentId}:lock", 10)` ensures only one device answers an incoming call across all ring targets
- **Queue processing**: All VoIP-related jobs go through Redis queue
- **Session storage**: User auth sessions

**If not Redis**: `Cache::lock()` with file/array drivers is NOT distributed — simring coordination across multiple workers fails, potentially allowing multiple devices to answer the same call.

**Reference**: `.env.base` lines 120-124

### 7.3 Cache

| Variable | Default | Notes |
|----------|---------|-------|
| `CACHE_STORE` | `redis` | **Must be `redis`** for simring locking (atomic distributed locks) |

### 7.4 Queue

| Variable | Default | Notes |
|----------|---------|-------|
| `QUEUE_CONNECTION` | `redis` | Docker: separate container runs `php artisan queue:listen` |

### 7.5 Broadcasting / Reverb WebSocket (3-Layer Config)

#### Server Layer (where Reverb runs)

| Variable | Default | Purpose |
|----------|---------|---------|
| `REVERB_SERVER_HOST` | `0.0.0.0` | Bind address inside Docker |
| `REVERB_SERVER_PORT` | `8080` | Internal port |
| `REVERB_SERVER_PATH` | (empty) | Base path; production uses `/reverb` |

#### App-to-Server Layer (Laravel → Reverb)

| Variable | Default | Purpose |
|----------|---------|---------|
| `REVERB_HOST` | `reverb` | Docker service name |
| `REVERB_PORT` | `8080` | Internal port |
| `REVERB_SCHEME` | `http` | `https` in production |
| `REVERB_APP_ID` | `z360-app` | Application identifier |
| `REVERB_APP_KEY` | `z360-reverb-key` | Auth key |
| `REVERB_APP_SECRET` | `z360-reverb-secret` | Auth secret |

#### Frontend-to-Server Layer (Browser/App → Reverb)

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_REVERB_APP_KEY` | `${REVERB_APP_KEY}` | Exposed to frontend via Vite |
| `VITE_REVERB_HOST` | `127.0.0.1` | Dev: localhost; Prod: `{env}.z360.biz` |
| `VITE_REVERB_PORT` | `7361` | Dev: mapped Docker port; Prod: `443` |
| `VITE_REVERB_SCHEME` | `${REVERB_SCHEME}` | `http` dev, `https` prod |
| `VITE_REVERB_PATH` | `${REVERB_PATH}` | Empty dev; `/reverb` prod |

**VoIP relevance**: Reverb is one of three channels for call dismissal in simultaneous ringing (SIP BYE + Reverb WebSocket + push notification). Real-time call state updates are broadcast via Reverb.

**Reference**: `.env.base` lines 83-106

---

## 8. Android Build and Configuration

### 8.1 SDK Version Requirements

| Setting | Value | Source |
|---------|-------|--------|
| `minSdkVersion` | 24 (Android 7.0) | `android/variables.gradle` |
| `compileSdkVersion` | 36 | `android/variables.gradle` |
| `targetSdkVersion` | 36 | `android/variables.gradle` |
| `kotlinVersion` | `1.9.24` | Pinned — Telnyx SDK 3.2.0 requires 1.9.x |
| Java compatibility | 17 | Forced in root `build.gradle` for all modules |

### 8.2 Project Structure

The Android app is a Capacitor project with additional native VoIP modules:

```
android/
 ├── app/                           # Main Capacitor app + native VoIP code
 │    ├── src/main/java/com/z360/app/
 │    │    ├── voip/                 # Native VoIP: TelnyxVoipPlugin, ConnectionService, Activities
 │    │    └── fcm/                  # Firebase messaging: Z360FirebaseMessagingService
 │    ├── google-services.json       # Firebase config (gitignored)
 │    └── build.gradle               # App-level build config
 ├── telnyx_common/                  # Official Telnyx drop-in module
 ├── capacitor-android/              # Capacitor core
 ├── build.gradle                    # Root build config (plugins, forced Java/Kotlin versions)
 ├── variables.gradle                # SDK version variables
 └── settings.gradle                 # Module declarations
```

### 8.3 Dependencies (VoIP-Critical)

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `com.github.team-telnyx:telnyx-webrtc-android` | `3.2.0` | Telnyx WebRTC SDK. **v3.3.0 has credential auth bug** |
| `project(':telnyx_common')` | local | Official Telnyx common module (TelnyxViewModel, CallForegroundService) |
| `com.google.firebase:firebase-bom` | `33.7.0` | Firebase BOM |
| `firebase-messaging-ktx` | BOM | FCM push notifications |
| `firebase-analytics-ktx` | BOM | Event tracking |
| `firebase-crashlytics-ktx` | BOM | Crash reporting |
| `firebase-perf-ktx` | BOM | Performance monitoring |
| `firebase-config-ktx` | BOM | Remote config |
| `kotlinx-coroutines-core` | `1.7.3` | **Force-pinned** to avoid Telnyx conflicts |
| `kotlinx-coroutines-android` | `1.7.3` | Same |
| `androidx.lifecycle:lifecycle-runtime-ktx` | `2.6.2` | StateFlow observation |
| `io.coil-kt:coil` | `2.6.0` | Contact avatar loading |
| `com.google.code.gson:gson` | `2.10.1` | Parsing Telnyx push metadata |

**Gradle plugins** (`android/build.gradle`):
- `com.android.tools.build:gradle:8.13.2`
- `com.google.gms:google-services:4.4.4`
- `com.google.firebase:firebase-crashlytics-gradle:3.0.3`
- `com.google.firebase:perf-plugin:1.4.2`
- `org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.24`

**Repositories required**: `google()`, `mavenCentral()`, `maven { url 'https://jitpack.io' }` (for Telnyx SDK)

**Reference**: `android/app/build.gradle`, `android/build.gradle`

### 8.4 Kotlin/Coroutines Version Pinning

Due to conflicts between AGP 9.0 (pulls Kotlin 2.0+) and Telnyx SDK (needs 1.9.x), a forced resolution strategy pins `kotlin-stdlib*` to 1.9.24 and `kotlinx-coroutines-*` to 1.7.3.

**Reference**: `android/app/build.gradle:58-72`

### 8.5 AndroidManifest.xml

#### Permissions (14 total)

| Category | Permission | Purpose |
|----------|-----------|---------|
| **Network** | `INTERNET`, `ACCESS_NETWORK_STATE` | WebRTC connectivity |
| **VoIP** | `RECORD_AUDIO` (runtime), `MODIFY_AUDIO_SETTINGS`, `READ_PHONE_STATE`, `CALL_PHONE` | Microphone, audio routing, phone state |
| **Notifications** | `POST_NOTIFICATIONS` (runtime), `VIBRATE`, `USE_FULL_SCREEN_INTENT` | Incoming call alerts |
| **Services** | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL`, `FOREGROUND_SERVICE_MICROPHONE`, `WAKE_LOCK` | Background call handling |
| **Telecom** | `MANAGE_OWN_CALLS` | Self-managed ConnectionService |
| **Bluetooth** | `BLUETOOTH` (max SDK 30), `BLUETOOTH_CONNECT` | Audio routing to Bluetooth devices |

#### Services and Components (8 VoIP-related)

| Component | Purpose |
|-----------|---------|
| `Z360FirebaseMessagingService` | Handles Z360 FCM + Telnyx push. Priority 10000. |
| `LegacyCallNotificationService` | Telnyx common call notification foreground service |
| `CallForegroundService` | Active call foreground service (`:call_service` process) |
| `CallNotificationReceiver` | Notification actions (answer/decline) |
| `BackgroundCallDeclineService` | Call decline from background state |
| `Z360ConnectionService` | Self-managed Telecom ConnectionService |
| `IncomingCallActivity` | Full-screen incoming call UI (`showWhenLocked=true`, `turnScreenOn=true`) |
| `ActiveCallActivity` | Active call UI (`showWhenLocked=true`) |

### 8.6 Build Process

#### Debug Build
```bash
make android-build    # Full workflow: sync + build + install + launch
```

Steps: (1) Remove `public/hot`, (2) `npx cap sync android`, (3) `./gradlew assembleDebug` (auto-retry on failure), (4) `adb install`, (5) `adb shell am start`

**Reference**: `Makefile:791-831`

#### Release Build
```bash
cd android && ./gradlew assembleRelease
```

Requires `android/keystore.properties`:
```properties
storeFile=path/to/keystore.jks
storePassword=...
keyAlias=...
keyPassword=...
```

Release signing only activates if `keystore.properties` exists with valid `storeFile`.

**ProGuard/R8**: Minification is **DISABLED** for both debug and release (`minifyEnabled false`).

### 8.7 Emulator Commands

```bash
make emulator-start    # Start with VoIP settings (audio, GPU host)
make emulator-stop     # Stop
make emulator-wipe     # Wipe for fresh start
```

Default AVD: `Z360_VoIP`. Starts with: no-snapshot, host audio, host GPU, 2048MB RAM, 4 cores.

**Reference**: `Makefile:720-785`

---

## 9. iOS Build and Configuration

### 9.1 Xcode Project Settings

| Setting | Value | Source |
|---------|-------|--------|
| **Bundle ID** | `com.z360biz.app` | `project.pbxproj` line 635 |
| **Development Team** | `K3H6JK29AN` | `project.pbxproj` line 533 |
| **Deployment Target** | iOS 15.0 | `project.pbxproj` line 551, `Package.swift` line 7 |
| **Swift Tools** | 5.9 | `CapApp-SPM/Package.swift` line 1 |

### 9.2 Info.plist Configuration (`ios/App/App/Info.plist`)

#### UIBackgroundModes (lines 27-33) — ALL REQUIRED FOR VOIP

| Mode | Purpose |
|------|---------|
| `voip` | **Critical**: Enables PushKit VoIP push. Without this, no VoIP pushes received. |
| `audio` | Background audio during calls |
| `remote-notification` | Silent remote notifications (FCM data messages) |
| `fetch` | Background fetch capability |

#### Usage Descriptions

| Key | Value | Impact if Missing |
|-----|-------|-------------------|
| `NSMicrophoneUsageDescription` | "Z360 needs access to your microphone to make and receive phone calls." | App crashes on mic permission request |
| `NSCameraUsageDescription` | "Z360 needs access to your camera for video calls." | App crashes on camera request |

#### App Transport Security (lines 80-86)

| Key | Value | Notes |
|-----|-------|-------|
| `NSAllowsArbitraryLoads` | `true` | Allows HTTP (needed for dev). Should restrict in production. |
| `NSAllowsArbitraryLoadsInWebContent` | `true` | Same for WebView content. |

#### Scene Configuration

Uses `UIApplicationSceneManifest` with `SceneDelegate` — critical for VoIP **two-phase startup** where `sceneDidBecomeActive` defers heavy init (Phase 2) after PushKit/CallKit processing (Phase 1).

### 9.3 Entitlements (`ios/App/App/App.entitlements`)

| Entitlement | Current Value | Notes |
|------------|---------------|-------|
| `aps-environment` | `development` | **Must be `production` for App Store builds.** Typically overridden by provisioning profile. |

### 9.4 SPM Dependencies (Xcode Project)

| Package | Min Version | Source |
|---------|-------------|--------|
| `telnyx-webrtc-ios` | 2.4.0 | `https://github.com/team-telnyx/telnyx-webrtc-ios` |
| `firebase-ios-sdk` | 12.8.0 | `https://github.com/firebase/firebase-ios-sdk` |
| `capacitor-swift-pm` | 8.0.0 | `https://github.com/ionic-team/capacitor-swift-pm.git` |
| `Starscream` | 4.0.8 | WebSocket library (Telnyx dependency) |
| `WebRTC` | 139.0.0 | WebRTC framework (Telnyx dependency) |

Firebase frameworks linked: `FirebaseMessaging`, `FirebaseCrashlytics`, `FirebaseAnalytics`

### 9.5 Provisioning Profile Requirements

VoIP apps require specific provisioning:
1. **Apple Developer account** with VoIP push notification capability enabled
2. **App ID** configured with: Push Notifications, VoIP Services (for PushKit), Background Modes
3. **Provisioning profile** including the VoIP entitlement
4. **APNs certificates or keys** (`.p8` files gitignored)

### 9.6 Build Process

#### Simulator Build
```bash
make ios-build    # Full workflow: sync + build + install + launch
```

Steps: (1) Remove `public/hot`, (2) `npx cap sync ios` + remove symlinks, (3) `xcodebuild -scheme App -destination 'iOS Simulator,name=iPhone 17 Pro Max'`, (4) `xcrun simctl install`, (5) `xcrun simctl launch`

**Symlink fix**: After sync, `ios/App/App/public/storage` symlink must be removed (handled by `make ios-sync`).

#### Physical Device Build
```bash
make ios-device    # Explicit physical device
make ios-build     # Auto-detects: prefers physical over simulator
```

Auto-detection via `xcrun xctrace list devices`. Physical builds use `-allowProvisioningUpdates`.

**Reference**: `Makefile:497-592`

### 9.7 Simulator vs Physical Device

| Feature | Simulator | Physical Device |
|---------|-----------|-----------------|
| UI testing | Yes | Yes |
| PushKit/VoIP push | **No** | Yes |
| CallKit UI | Partial | Yes |
| Audio testing | Limited | Full |
| Microphone | Host Mac mic | Device mic |
| Apple account | Not required | Required |

### 9.8 App Store Submission Considerations

- **VoIP background mode** must be justified — only apps with real-time calling qualify
- **PushKit usage** must exclusively trigger CallKit calls (Apple rejects PushKit for general notifications)
- **NSMicrophoneUsageDescription** and **NSCameraUsageDescription** already set

---

## 10. Web Client Build

### 10.1 Dual Vite Configuration

**Main App** (`vite.config.ts`):
- Entry: `resources/css/app.css`, `resources/js/app.tsx`
- Plugins: `laravel-vite-plugin`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `vite-plugin-svgr`
- Dev server: port 5173, HMR via `wss://dev.z360.cloud:5173`
- Output: `public/build/`

**Widget** (`vite.widget.config.ts`):
- Entry: `resources/js/widget/index.html`, `resources/js/widget/loader.ts`
- Output: `public/widget/`
- Dev server: port 5174
- Loader output is un-hashed (`loader.js`) for stable tenant URLs

**Build commands**:
```bash
pnpm run build           # Main app only
pnpm run build:widget    # Widget only
pnpm run build:all       # Both (production Dockerfile)
```

### 10.2 Web VoIP Client

Uses `@telnyx/react-client` (^1.0.2) and `@telnyx/webrtc` (^2.22.17) — bundled directly into Vite output, no separate build step.

### 10.3 No SSR

No server-side rendering. Z360 runs as a pure client-side SPA via Inertia.js.

**Reference**: `vite.config.ts`, `vite.widget.config.ts`, `package.json:5-14`

---

## 11. Backend Deployment (Production)

### 11.1 Infrastructure: AWS Copilot on ECS Fargate

| Service | Type | CPU | Memory | Command |
|---------|------|-----|--------|---------|
| `web` | Load Balanced Web | 1024-2048 | 2048-4096 | Supervisord (nginx + php-fpm) |
| `queue` | Backend Service | 512 | 1024 | `php artisan queue:work` |
| `reverb` | Load Balanced Web | 512 | 1024 | `php artisan reverb:start` |
| `scheduler` | Scheduled Job (1 min) | 256 | 512 | `php artisan schedule:run` |

**Reference**: `copilot/web/manifest.yml`, `copilot/queue/manifest.yml`, `copilot/reverb/manifest.yml`, `copilot/scheduler/manifest.yml`

### 11.2 VoIP-Critical Queued Jobs

| Job | VoIP Relevance |
|-----|---------------|
| `SendSMSJob` | SMS via Telnyx CPaaS |
| `HandleA2PCampaignSuccess` | A2P campaign registration |
| `ReportMeterEvent` | Usage metering (calls, SMS) |

**Note**: VoIP call signaling is real-time (NOT queued). Push notifications sent synchronously from webhook handlers. Queue handles async follow-up tasks.

### 11.3 Cache: Redis/Valkey (REQUIRED)

Redis is provisioned as AWS ElastiCache-compatible cluster:
```yaml
REDIS_URL:
  from_cfn: ${COPILOT_APPLICATION_NAME}-${COPILOT_ENVIRONMENT_NAME}-valkeyUrl
```

Required for: sessions, queue, cache, simring distributed locking, Reverb pub/sub.

### 11.4 WebSocket (Reverb) Deployment

- Path: `/reverb*` on `${env}.z360.biz`
- Port: 8080 internally
- Health check: `/reverb/up`
- In production, shares port 443 via ALB path routing (not separate port)

### 11.5 VoIP Database Migrations (8 migrations)

1. `create_user_telnyx_telephony_credentials_table`
2. `update_user_telnyx_telephony_credentials_table`
3. `add_sip_fields_to_user_telnyx_telephony_credentials_table`
4. `create_user_device_tokens_table`
5. `add_connection_id_to_user_telnyx_telephony_credentials_table`
6. `add_sip_credentials_to_user_device_tokens_table`
7. `add_credential_expires_at_to_user_device_tokens_table`
8. `create_user_device_tokens_table` (recreated)

Post-deployment: `php artisan migrate --force`

### 11.6 Scheduler Tasks (VoIP-Relevant)

| Task | Schedule | Purpose |
|------|----------|---------|
| `ProcessWakeups` | Every minute | Keeps connections alive |
| `device-tokens:clean-stale` | Weekly | Cleanup stale device tokens |
| `CheckChannelHealth` | Every 30 minutes | Monitors communication channel health |

### 11.7 SSL/TLS

- HTTPS enforced via ALB + `FORCE_HTTPS=true`
- WebSocket: WSS via ALB on port 443 at `/reverb`
- Webhooks must be HTTPS for Telnyx delivery
- WebRTC requires HTTPS origin for browser APIs
- Capacitor: HTTPS in production; cleartext allowed in dev

### 11.8 Production Web Container

**Nginx** (`docker/nginx.conf`): Port 80 behind ALB (TLS terminated), health check at `/api/health`, client max body 20MB.

**Supervisord** (`docker/supervisord.conf`): Manages `php-fpm8.4 -F` (priority 10) and `nginx -g "daemon off;"` (priority 20).

---

## 12. Environment Differences: Dev vs Production

### 12.1 Summary Table

| Setting | Development | Production |
|---------|------------|------------|
| **APNs environment** | `development` (sandbox) | `production` |
| **APNs gateway** | `api.sandbox.push.apple.com` | `api.push.apple.com` |
| **iOS entitlement** | `aps-environment: development` | `aps-environment: production` |
| **Telnyx credentials** | `.env.base.override` | AWS SSM Parameter Store |
| **Telnyx webhooks** | `https://dev.z360.cloud/webhooks/...` | `https://{env}.z360.biz/webhooks/...` |
| **Firebase credentials** | JSON file in `storage/` | AWS SSM (JSON string) |
| **Firebase config (Android)** | Local `google-services.json` | Bundled in APK |
| **Firebase config (iOS)** | In repo | In repo (same file) |
| **Capacitor server URL** | `https://dev.z360.cloud` | Unset (bundled assets) |
| **WebSocket host** | `127.0.0.1:7361` (or `ws.dev.z360.cloud`) | `{env}.z360.biz:443` |
| **WebSocket path** | (empty) | `/reverb` |
| **Queue command** | `queue:listen` (auto-reloads) | `queue:work` (cached) |
| **Cache/Queue backend** | Valkey (Docker) | ElastiCache (AWS) |
| **Storage** | MinIO (localhost:9000) | AWS S3 + CloudFront CDN |
| **APP_DEBUG** | `true` | `false` (beta) |
| **LOG_LEVEL** | `debug` | `warning` (beta) |
| **Reverb keys** | `z360-reverb-key` / `z360-reverb-secret` | Secure random values |

### 12.2 Critical Dev-to-Prod Switches

When moving from development to production, these **must** change:

1. **APNs environment**: `development` → `production` (wrong value = all iOS pushes fail)
2. **Telnyx webhook URLs**: Must point to production domain
3. **CAPACITOR_SERVER_URL**: Must be unset for production builds
4. **Reverb credentials**: Must use secure random values
5. **APP_DEBUG**: Must be `false`
6. **FORCE_HTTPS**: Must be `true`

---

## 13. CI/CD Pipeline

### 13.1 Pipeline Architecture (GitHub Actions)

```
PR Created  →  Quality Checks (quality-checks.yml)
                  │
Merge to main  →  Main Branch Checks (main-checks.yml)
                  │
                [All pass]
                  │
                Deploy to Staging (deploy-staging.yml)
                  (10-minute wait → deploy web + queue + scheduler)
```

### 13.2 Quality Checks (3 Parallel Jobs)

| Job | Timeout | What It Does |
|-----|---------|-------------|
| Backend Lint | 3 min | PHP 8.4, `composer run lint` (Laravel Pint) |
| Backend Test | 35 min | PHP 8.4 + Node 22, Docker services, `php artisan test` (Pest) |
| Frontend Checks | 8 min | Node 22 + PNPM, `types` + `format:check` + `lint` |

Local equivalent: `make check`

### 13.3 Staging Deployment

After main checks pass: 10-minute cooldown → `copilot svc deploy` for web, queue, scheduler → post-deploy: migrate, cache config/routes/views, optimize, restart queue.

### 13.4 What's NOT Automated

| Gap | Impact |
|-----|--------|
| Android APK/AAB builds | No CI/CD for Android releases |
| iOS IPA builds | No Xcode Cloud/Fastlane pipeline |
| Mobile app distribution | No TestFlight/Firebase App Distribution/Play Store automation |
| Version bumping | `versionCode 1`, `versionName "1.0"` are static |
| Release tagging | No release workflow or tagging strategy |
| Beta/production deployment | Only staging is automated |

**Reference**: `.github/workflows/`

---

## 14. Known Issues and Warnings

### 14.1 Bundle ID Mismatch

**Issue**: Capacitor config uses `com.z360.app` as `appId`, but iOS Xcode project uses `com.z360biz.app` as the bundle identifier.

**Impact**: Could cause issues with push notification token registration, deep links, and app identity. The Android `applicationId` in `build.gradle` uses `com.z360.app`, matching Capacitor but not iOS.

**Locations**: `capacitor.config.ts:8`, `ios/App/App.xcodeproj/project.pbxproj:635`, `android/app/build.gradle:24`

### 14.2 GoogleService-Info.plist in Git

**Issue**: `ios/App/App/GoogleService-Info.plist` is tracked in git with real Firebase API keys (`z360-c7d9e`, sender ID `699830885674`). The Android equivalent (`google-services.json`) is properly gitignored.

**Recommendation**: Consider gitignoring the iOS file and distributing it separately, consistent with the Android approach.

### 14.3 Telnyx SDK Version Pin

**Issue**: Android Telnyx SDK pinned to 3.2.0 because v3.3.0 has a credential authentication bug.

**Impact**: Cannot upgrade to latest SDK version. Must monitor for fix release.

**Reference**: `android/app/build.gradle:109` (comment)

### 14.4 iOS Firebase SDK Version Discrepancy

**Finding**: Config-researcher found Firebase iOS SDK at `11.15.0` in `project.pbxproj`, while deploy-researcher found `12.8.0+` minimum. The actual resolved version depends on Xcode's SPM resolution. Verify the current resolved version in `Package.resolved`.

### 14.5 ATS Permissive in iOS

**Issue**: `NSAllowsArbitraryLoads` and `NSAllowsArbitraryLoadsInWebContent` are both `true`, allowing HTTP connections. Should be restricted in production.

### 14.6 ProGuard Disabled

**Issue**: Android minification is disabled for both debug and release builds (`minifyEnabled false`). This means the release APK includes all symbols and is larger than necessary.

### 14.7 Missing Mobile CI/CD

No automated build, test, or distribution pipelines exist for Android or iOS. Version codes are static (`versionCode 1`). This will need to be addressed before production mobile releases.

---

## 15. Quick Reference Tables

### 15.1 All Environment Variables (VoIP-Related)

| Variable | Required | Dev Value | Prod Value |
|----------|----------|-----------|------------|
| `TELNYX_API_KEY` | Yes | Telnyx API key | Same or different account |
| `TELNYX_CALL_CONTROL_APP_ID` | Yes | Auto-generated | Different per env |
| `TELNYX_OUTBOUND_VOICE_PROFILE_ID` | Yes | Auto-generated | Same or different |
| `TELNYX_CREDENTIAL_CONNECTION_ID` | Yes | Auto-generated | Different per env |
| `TELNYX_NOTIFICATIONS_PROFILE_ID` | Yes | Auto-generated | Different per env |
| `FIREBASE_CREDENTIALS` | Yes | Service account JSON | AWS SSM |
| `FIREBASE_PROJECT_ID` | Yes | `z360-c7d9e` | Project ID |
| `APNS_VOIP_ENABLED` | Yes (iOS) | `false` or `true` | `true` |
| `APNS_VOIP_ENV` | Yes (iOS) | `development` | `production` |
| `APNS_VOIP_BUNDLE_ID` | Yes (iOS) | `com.z360biz.app` | `com.z360biz.app` |
| `APNS_VOIP_KEY_ID` | Yes (iOS) | Apple Key ID | Same |
| `APNS_VOIP_TEAM_ID` | Yes (iOS) | `K3H6JK29AN` | Same |
| `APNS_VOIP_KEY_PATH` | Yes (iOS) | Path to `.p8` | Path to `.p8` |
| `CAPACITOR_SERVER_URL` | Dev only | `https://dev.z360.cloud` | **Unset** |
| `CACHE_STORE` | Yes | `redis` | `redis` |
| `QUEUE_CONNECTION` | Yes | `redis` | `redis` |
| `BROADCAST_CONNECTION` | Yes | `reverb` | `reverb` |
| `REVERB_APP_KEY` | Yes | `z360-reverb-key` | Secure random |
| `REVERB_APP_SECRET` | Yes | `z360-reverb-secret` | Secure random |
| `NGROK_AUTHTOKEN` | Dev only | ngrok token | N/A |
| `NGROK_HOSTNAME` | Dev only | ngrok hostname | N/A |

### 15.2 Files That Must Exist (Not in Git)

| File | Platform | Purpose |
|------|----------|---------|
| `storage/*-firebase-adminsdk-*.json` | Backend | Firebase service account |
| `android/app/google-services.json` | Android | Firebase Android config |
| `*.p8` (APNs auth key) | Backend | APNs token-based auth |
| `android/keystore.properties` | Android | Release signing (if releasing) |
| `.cloudflared/tunnel-credentials.json` | Dev | Cloudflare tunnel credentials |
| `.env.base.override` | Dev | Developer-specific overrides |

### 15.3 Essential Make Commands

| Command | Purpose |
|---------|---------|
| `make setup` | Complete first-time setup |
| `make up` / `make down` | Start/stop Docker services |
| `make env` | Regenerate `.env` from base + override |
| `make tunnel-bg` | Start Cloudflare tunnel for webhooks |
| `make android-build` | Full Android: sync + build + install + launch |
| `make ios-build` | Full iOS: sync + build + install + launch |
| `make ios-device` | iOS build targeting physical device |
| `make emulator-start` | Start Android emulator with VoIP settings |
| `make check` | Run lint + types + tests |
| `make artisan cmd="telnyx:setup"` | Auto-create all Telnyx resources |

### 15.4 Telnyx Resource → Webhook Mapping

| Resource | Webhook Endpoint | Purpose |
|----------|-----------------|---------|
| Call Control App | `/webhooks/cpaas/telnyx/call-control` | Inbound PSTN call events |
| Credential Connection | `/webhooks/cpaas/telnyx/credential` | WebRTC/outbound call events |
| Notification Profile | `/webhooks/cpaas/telnyx/notifications` | Push notification events |
| (SMS) | `/webhooks/cpaas/telnyx/sms` | SMS delivery events |

---

> **Source documents**: `configuration-reference.md` (Teammate A), `build-and-deployment.md` (Teammate B)
>
> **Date**: 2026-02-08
