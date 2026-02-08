---
title: External Services Map
---

# External Services Map

This document inventories every external service Z360 integrates with, how it connects, what configuration it requires, and the data flow directions.

---

## 1. Telnyx (CPaaS Platform)

Telnyx is the primary Communications Platform as a Service (CPaaS) provider. Z360 uses multiple Telnyx sub-services, each with its own configuration and webhook surface.

### 1.1 Telnyx Core API

- **Base URL**: `https://api.telnyx.com/v2/`
- **Auth**: Bearer token via `TELNYX_API_KEY`
- **Client**: Custom Guzzle wrapper in `CPaaSService::telnyxRequest()` (`app/Services/CPaaSService.php:24-83`)
- **Config file**: `config/cpaas.php`
- **Config values**:
  | Env Var | Config Key | Purpose |
  |---------|-----------|---------|
  | `TELNYX_API_KEY` | `cpaas.telnyx.api_key` | API authentication |
  | `TELNYX_OUTBOUND_VOICE_PROFILE_ID` | `cpaas.telnyx.ovp_id` | Outbound voice profile |
  | `TELNYX_CREDENTIAL_CONNECTION_ID` | `cpaas.telnyx.credential_connection_id` | WebRTC credential connection |
  | `TELNYX_CALL_CONTROL_APP_ID` | `cpaas.telnyx.call_control_id` | Call control application ID |
  | `TELNYX_NOTIFICATIONS_PROFILE_ID` | `cpaas.telnyx.notifications_profile_id` | Notification profile for number order events |

- **Setup command**: `php artisan telnyx:setup {mode}` creates all four resources on Telnyx and prints their IDs (`app/Console/Commands/TelnyxSetup.php`)

### 1.2 Telnyx Call Control (Voice / WebRTC)

Handles inbound and outbound voice calls. Telnyx sends webhook events to Z360; Z360 sends call control commands back.

**Webhook endpoints** (defined in `routes/webhooks.php:37-41`):
| Route | Controller | Purpose |
|-------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/call-control` | `TelnyxInboundWebhookController` | Inbound call webhooks |
| `POST /webhooks/cpaas/telnyx/call-control/failover` | `TelnyxInboundWebhookController@failover` | Failover for inbound |
| `POST /webhooks/cpaas/telnyx/credential` | `TelnyxOutboundWebhookController` | Outbound call (WebRTC-originated) webhooks |
| `POST /webhooks/cpaas/telnyx/credential/failover` | `TelnyxOutboundWebhookController@failover` | Failover for outbound |

**Data flows**:
- **Telnyx -> Z360**: Webhook events (`call.initiated`, `call.answered`, `call.hangup`, `call.recording.saved`, `call.speak.ended`) via `TelnyxCallController` (`app/Http/Controllers/Telnyx/TelnyxCallController.php:34-97`)
- **Z360 -> Telnyx**: Call control commands (`answer`, `transfer`, `speak`, `hangup`, `bridge`, `record_start`) via Telnyx PHP SDK (`\Telnyx\Call::constructFrom(...)`)
- **Z360 -> Telnyx**: Outbound call initiation, simultaneous ring leg creation

**Key controllers**:
- `app/Http/Controllers/Telnyx/TelnyxCallController.php` - Abstract base with common logic
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php` - Inbound call flow (transfer to WebRTC, voicemail, push notifications)
- `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php` - Outbound call flow

### 1.3 Telnyx Telephony Credentials (WebRTC / SIP)

Per-device and per-user SIP credentials for WebRTC connections.

**Data flows**:
- **Z360 -> Telnyx**: Create telephony credentials (`\Telnyx\TelephonyCredential::create()`) (`app/Services/CPaaSService.php:181-198`)
- **Z360 -> Telnyx**: Retrieve JWT tokens for WebRTC auth (`\Telnyx\TelephonyCredential::retrieve()->token()`) (`app/Services/CPaaSService.php:202-205`)
- **Z360 -> Telnyx**: Delete credentials on device cleanup (`CPaaSService::deleteTelnyxCredential()`) (`app/Services/CPaaSService.php:240-250`)
- **Z360 -> Telnyx**: Per-device credentials for mobile (`CPaaSService::createDeviceCredential()`) (`app/Services/CPaaSService.php:213-235`)

**Credential lifecycle** (managed in `app/Http/Controllers/Api/DeviceTokenController.php:42-177`):
1. Device registers via `POST /api/device-tokens`
2. `CPaaSService::handleCredentials()` creates org-level credential if missing
3. `CPaaSService::createDeviceCredential()` creates per-device credential
4. JWT token generated from per-device credential
5. SIP username, password, JWT returned to client
6. Stale devices (>7 days) cleaned up automatically

### 1.4 Telnyx SMS/MMS Messaging

**Webhook endpoints** (`routes/webhooks.php:47-48`):
| Route | Controller | Purpose |
|-------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/sms` | `TelnyxSMSWebhookController` | SMS status & inbound messages |
| `POST /webhooks/cpaas/telnyx/sms/failover` | `TelnyxSMSWebhookController@failover` | Failover |

**Data flows**:
- **Telnyx -> Z360**: Inbound SMS (`message.received`), delivery status updates (`message.sent`, `message.finalized`) via `TelnyxSMSWebhookController` (`app/Http/Controllers/Telnyx/TelnyxSMSWebhookController.php`)
- **Z360 -> Telnyx**: Outbound SMS/MMS via `\Telnyx\Message::create()` in `SendSMSJob` (`app/Jobs/Inbox/SendSMSJob.php:60-68`)

### 1.5 Telnyx RCS Messaging

**Webhook endpoints** (`routes/webhooks.php:51-52`):
| Route | Controller | Purpose |
|-------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/rcs` | `TelnyxRCSWebhookController` | RCS inbound & status events |
| `POST /webhooks/cpaas/telnyx/rcs/failover` | `TelnyxRCSWebhookController@failover` | Failover |

**Data flows**:
- **Telnyx -> Z360**: Inbound RCS messages, delivery receipts via `TelnyxRCSWebhookController` (`app/Http/Controllers/Telnyx/TelnyxRCSWebhookController.php`)
- **Z360 -> Telnyx**: RCS capability check (`CPaaSService::checkRCSCapability()`) (`app/Services/CPaaSService.php:354-375`)
- **Z360 -> Telnyx**: Outbound RCS messages via API (in `SendSMSJob::sendRCS()`) (`app/Jobs/Inbox/SendSMSJob.php:73+`)

### 1.6 Telnyx A2P / 10DLC Compliance

**Webhook endpoints** (`routes/webhooks.php:43-44`):
| Route | Controller | Purpose |
|-------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/a2p` | `TelnyxA2PWebhookController` | A2P brand/campaign status updates |
| `POST /webhooks/cpaas/telnyx/a2p/failover` | `TelnyxA2PWebhookController@failover` | Failover |

**Data flows**:
- **Telnyx -> Z360**: Brand/campaign status webhooks (requested, success, failed, rejected, reappealed) via `TelnyxA2PWebhookController` (`app/Http/Controllers/Telnyx/TelnyxA2PWebhookController.php`)
- **Z360 -> Telnyx**: Brand creation, campaign creation, messaging profile management, phone number assignment via `A2PService` (`app/Services/Telnyx/A2PService.php`)
- **Z360 -> Telnyx**: Phone number health checks and repair (`CPaaSService::checkPhoneNumberHealth()`, `CPaaSService::repairPhoneNumber()`) (`app/Services/CPaaSService.php:273-345`)

### 1.7 Telnyx Notifications (Number Orders)

**Webhook endpoints** (`routes/webhooks.php:35`):
| Route | Controller | Purpose |
|-------|-----------|---------|
| `POST /webhooks/cpaas/telnyx/notifications` | `TelnyxNotificationsWebhookController` | Number order completion events |

**Data flows**:
- **Telnyx -> Z360**: `number_order.complete` events via `TelnyxNotificationsWebhookController` (`app/Http/Controllers/Telnyx/TelnyxNotificationsWebhookController.php`)
- **Z360 -> Telnyx**: Auto-assigns messaging profile and campaign to newly purchased numbers

### 1.8 Telnyx Phone Number Management

- **Z360 -> Telnyx**: Number ordering, messaging profile assignment, 10DLC campaign assignment
- **Z360 -> Telnyx**: Outbound Voice Profile creation (`\Telnyx\OutboundVoiceProfile::create()`)
- **Z360 -> Telnyx**: Call Control Application creation (`\Telnyx\CallControlApplication::create()`)
- Setup via `TelnyxSetup` command (`app/Console/Commands/TelnyxSetup.php`)

---

## 2. Firebase / Google Cloud (Push Notifications)

### 2.1 Firebase Cloud Messaging (FCM) — Android Push

Used for sending high-priority data-only push notifications to Android devices (incoming call alerts, call ended events).

**Config** (`config/services.php:54-57`):
| Env Var | Config Key | Purpose |
|---------|-----------|---------|
| `FIREBASE_CREDENTIALS` | (env only — path resolved in config) | Service account JSON |
| `FIREBASE_PROJECT_ID` | `services.firebase.project_id` | FCM project ID (default: `z360-c7d9e`) |
| `FIREBASE_CREDENTIALS_PATH` | `services.firebase.credentials_path` | Path to service account JSON file |

**Auth method**: OAuth2 service account credentials via `Google\Client` (`app/Services/PushNotificationService.php:293-320`)
- Scoped to `https://www.googleapis.com/auth/firebase.messaging`
- Token cached with 5-minute buffer before expiry

**API endpoint**: `https://fcm.googleapis.com/v1/projects/{project_id}/messages:send` (FCM HTTP v1 API)

**Data flows**:
- **Z360 -> FCM**: Data-only push messages with `android.priority: high` and `ttl: 60s` via `PushNotificationService::sendFcmMessage()` (`app/Services/PushNotificationService.php:233-288`)
- **Payload types**:
  - `incoming_call`: call_session_id, caller info, org context, avatar
  - `call_ended`: call_session_id for dismissing call UI
- **Token management**: Invalid/unregistered tokens auto-removed (`UNREGISTERED`, `INVALID_ARGUMENT` errors trigger `UserDeviceToken::removeToken()`)

**Which Z360 component talks to it**: `PushNotificationService` (`app/Services/PushNotificationService.php`)

---

## 3. Apple Push Notification service (APNs) — iOS VoIP Push

Direct APNs integration for iOS VoIP push notifications (PushKit). Separate from FCM; required because iOS VoIP pushes must use APNs directly.

**Config** (`config/services.php:59-71`):
| Env Var | Config Key | Purpose |
|---------|-----------|---------|
| `APNS_VOIP_ENABLED` | `services.apns_voip.enabled` | Enable/disable APNs VoIP (default: false) |
| `APNS_VOIP_ENV` | `services.apns_voip.environment` | `development` or `production` |
| `APNS_VOIP_BUNDLE_ID` | `services.apns_voip.bundle_id` | iOS app bundle ID |
| `APNS_VOIP_KEY_ID` | `services.apns_voip.key_id` | Apple key ID (token auth) |
| `APNS_VOIP_TEAM_ID` | `services.apns_voip.team_id` | Apple team ID (token auth) |
| `APNS_VOIP_KEY_PATH` | `services.apns_voip.key_path` | Path to .p8 key file (token auth) |
| `APNS_VOIP_CERT_PATH` | `services.apns_voip.cert_path` | Path to .pem cert (cert auth fallback) |
| `APNS_VOIP_CERT_PASSPHRASE` | `services.apns_voip.cert_passphrase` | Cert passphrase (cert auth fallback) |
| `APNS_VOIP_CERT_KEY_PATH` | `services.apns_voip.cert_key_path` | Cert key path (cert auth fallback) |

**Auth methods** (dual support in `app/Services/ApnsVoipService.php:122-125`):
1. **Token-based (preferred)**: ES256 JWT signed with Apple .p8 key, cached for 50 minutes (`ApnsVoipService::getJwt()`, line 127-176)
2. **Certificate-based (fallback)**: TLS client certificate auth via Guzzle `cert` option

**API endpoints**:
- Production: `https://api.push.apple.com/3/device/{token}`
- Sandbox: `https://api.sandbox.push.apple.com/3/device/{token}`

**Protocol**: HTTP/2 (forced via `CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_2_0`)

**Push headers** (line 40-49):
- `apns-topic`: `{bundle_id}.voip`
- `apns-push-type`: `voip`
- `apns-priority`: `10` (immediate)
- `apns-expiration`: `0` (no store-and-forward)
- `apns-collapse-id`: call_session_id (for dedup)

**Data flows**:
- **Z360 -> APNs**: VoIP push payloads for incoming calls and call-ended events via `ApnsVoipService::sendVoipPush()` (`app/Services/ApnsVoipService.php:16-120`)
- **Payload**: Same as FCM payload plus `aps.content-available: 1`

**Which Z360 component talks to it**: `ApnsVoipService` (`app/Services/ApnsVoipService.php`), called from `PushNotificationService` (`app/Services/PushNotificationService.php:117-134, 199-218`)

---

## 4. Stripe (Billing & Subscriptions)

Stripe handles all billing, subscriptions, invoicing, and pay-as-you-go (PAYG) metered usage.

**Config** (`config/cashier.php`, `.env.base:150-163`):
| Env Var | Purpose |
|---------|---------|
| `STRIPE_KEY` | Stripe publishable key |
| `STRIPE_SECRET` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `BILLING_PRICE_ID` | Base subscription price ID |
| `BILLING_PAYG_SMS_PRICE_ID` | PAYG SMS metered price |
| `BILLING_PAYG_MMS_PRICE_ID` | PAYG MMS metered price |
| `BILLING_PAYG_CALL_PRICE_ID` | PAYG voice call metered price |
| `BILLING_PAYG_AI_CALL_PRICE_ID` | PAYG AI call metered price |
| `BILLING_PAYG_AGENT_CHAT_TURN_PRICE_ID` | PAYG agent chat turn metered price |
| `BILLING_MONTHLY_NUMBER_PRICE_ID` | Monthly phone number price |

**Webhook endpoint** (`routes/webhooks.php:29`):
- `POST /webhooks/stripe` -> `StripeWebhookController`

**Data flows**:
- **Stripe -> Z360**: Webhook events (`customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.updated`, `invoice.payment_succeeded`) via `StripeWebhookController` (`app/Http/Controllers/Billing/StripeWebhookController.php`)
- **Z360 -> Stripe**: Subscription creation, PAYG usage reporting, invoice management via Laravel Cashier
- **State management**: Organization `activity_status`, `subscription_status`, `status_reason` updated based on Stripe events
- **PAYG ledger**: `Ledger` model tracks metered usage, marked as paid when Stripe threshold invoices are paid (`StripeWebhookController::handleThresholdInvoicePaymentSucceeded()`, line 268-324)

**Which Z360 component talks to it**: `StripeWebhookController` (`app/Http/Controllers/Billing/StripeWebhookController.php`), Laravel Cashier package

---

## 5. Google OAuth / Gmail (Authentication & Email)

### 5.1 Google OAuth (Social Login)

**Config** (`config/services.php:38-45`):
| Env Var | Config Key | Purpose |
|---------|-----------|---------|
| `GOOGLE_CLIENT_ID` | `services.google.client_id` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | `services.google.client_secret` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `services.google.redirect` | OAuth callback URL |

**Data flows**:
- **Z360 -> Google**: OAuth redirect for login (`GoogleAuthController::redirect()`) (`app/Http/Controllers/Auth/GoogleAuthController.php`)
- **Google -> Z360**: OAuth callback with user profile data
- **Z360 -> Google**: Gmail OAuth for email integration (`EmailsController`) (`app/Http/Controllers/Settings/Account/EmailsController.php:45-69`)

**Uses**: Laravel Socialite (`laravel/socialite`)

### 5.2 Gmail Push Notifications (Pub/Sub)

**Config** (`config/services.php:42-44`):
| Config Key | Purpose |
|-----------|---------|
| `services.google.gmail.pubsub_topic` | Google Pub/Sub topic (default: `projects/z360gmail/topics/gmail-notifications`) |

**Webhook endpoint** (`routes/webhooks.php:32`):
- `POST /webhooks/emails/gmail` -> `EmailWebhookController@handleGmailWebhook`

**Data flows**:
- **Gmail -> Google Pub/Sub -> Z360**: Push notifications when new emails arrive, delivered as Pub/Sub envelope with base64-encoded payload containing `emailAddress` and `historyId` (`app/Http/Controllers/Emails/EmailWebhookController.php:26-56`)
- **Z360 -> Gmail API**: Fetch new messages using history ID via `ProcessEmailWebhookJob` (`app/Jobs/Inbox/ProcessEmailWebhookJob.php`)
- Dispatches `ProcessEmailWebhookJob` per account for multi-tenant processing

---

## 6. Agent Gateway (AI Layer)

External AI service layer that handles agent reasoning, tool execution, and transcription summarization.

**Config** (`config/services.php:47-52`):
| Env Var | Config Key | Purpose |
|---------|-----------|---------|
| `AGENT_GATEWAY_BASE_URL` | `services.agent.gateway.base_url` | AI gateway base URL (default: `https://gateway.staging.z360-agent-layer.z360.biz/`) |
| `AGENT_SIP_URL` | `services.agent.sip_endpoint` | LiveKit SIP endpoint for AI voice calls (default: `sip:+10000000000@3tdlxrqvb2u.sip.livekit.cloud`) |

**Data flows**:
- **Z360 -> Agent Gateway**: Requests via `AgentService::gatewayRequest()` (`app/Services/AgentService.php:15-52`) — includes agent runs, summarization requests
- **Agent Gateway -> Z360**: Webhook callbacks:
  - `POST /webhooks/ai/run` -> `AgentRunWebhookController` — agent run results with messages (`app/Http/Controllers/Agent/AgentRunWebhookController.php`)
  - `POST /webhooks/ai/run/testing` -> `AbilityTestingWebhookController` — ability testing results (`app/Http/Controllers/Agent/AbilityTestingWebhookController.php`)
  - `POST /webhooks/ai/transcription/{message}` -> `AgentTranscriptionWebhookController` — call transcription results (`app/Http/Controllers/Agent/AgentTranscriptionWebhookController.php`)
- **Z360 -> Agent Gateway**: Transcription summarization via `POST /summarize` (`AgentTranscriptionWebhookController::summarizeTranscription()`, line 62-95)

**Note**: The SIP endpoint (`AGENT_SIP_URL`) implies **LiveKit** integration for AI voice calls, where the agent gateway uses LiveKit's SIP trunking to join calls.

---

## 7. AWS S3 / MinIO (Object Storage)

S3-compatible storage for file uploads (avatars, attachments, MMS media, etc.).

**Config** (`config/filesystems.php:33-44`, `.env.base:139-147`):
| Env Var | Purpose |
|---------|---------|
| `AWS_ACCESS_KEY_ID` | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key |
| `AWS_DEFAULT_REGION` | S3 region (default: `us-east-1`) |
| `AWS_BUCKET` | S3 bucket name (default: `z360`) |
| `AWS_ENDPOINT` | S3 endpoint (MinIO in dev: `http://minio:9000`) |
| `AWS_PUBLIC_URL` | Public URL for served files |
| `AWS_USE_PATH_STYLE_ENDPOINT` | Path-style for MinIO compatibility |
| `FILESYSTEM_DISK` | Default disk (set to `s3`) |

**Data flows**:
- **Z360 -> S3**: File uploads (avatars, attachments, media)
- **S3 -> Z360**: File retrieval via public URLs
- **Development**: MinIO container as local S3-compatible store (Docker service `minio`, ports 9000/8900)

---

## 8. Laravel Reverb / WebSocket (Real-time Broadcasting)

Self-hosted WebSocket server for real-time event broadcasting to web and mobile clients.

**Config** (`config/reverb.php`, `config/broadcasting.php`, `.env.base:81-106`):
| Env Var | Purpose |
|---------|---------|
| `BROADCAST_CONNECTION` | Broadcasting driver (set to `reverb`) |
| `REVERB_APP_ID` | Reverb application ID |
| `REVERB_APP_KEY` | Reverb app key |
| `REVERB_APP_SECRET` | Reverb app secret |
| `REVERB_SERVER_HOST` | Server bind address (`0.0.0.0`) |
| `REVERB_SERVER_PORT` | Server port (`8080`) |
| `REVERB_HOST` | How Laravel connects (`reverb` Docker hostname) |
| `REVERB_PORT` | Laravel connection port (`8080`) |
| `REVERB_SCHEME` | Protocol (`http` dev, `https` prod) |
| `VITE_REVERB_*` | Frontend connection variables |

**Architecture** (three connection layers):
1. **REVERB_SERVER**: The actual WebSocket server (`0.0.0.0:8080` in container) — `config/reverb.php`
2. **REVERB**: How Laravel backend connects to the server (`reverb:8080` Docker DNS) — `config/broadcasting.php`
3. **VITE_REVERB**: How frontend connects (`127.0.0.1:7361` port-forwarded) — `resources/js/app.tsx:26-34`

**Data flows**:
- **Z360 Backend -> Reverb**: Event broadcasting via `ShouldBroadcast` interface
- **Reverb -> Frontend/Mobile**: WebSocket push to connected clients
- **Broadcast events** (from `app/Events/`):
  - `IncomingCallNotification` — real-time incoming call alert to web client
  - `CallEndedNotification` — call ended notification
  - `OrganizationSwitched` — organization context change
  - Various inbox, contact, and ticket events

**Frontend connection**: `@laravel/echo-react` configured in `resources/js/app.tsx:26-34`
**Scaling**: Optional Redis-backed scaling via `REVERB_SCALING_ENABLED` (`config/reverb.php:40-51`)

---

## 9. Redis / Valkey (Cache, Queue, Session)

In-memory data store used for multiple subsystems.

**Config** (`.env.base:117-124`):
| Env Var | Purpose |
|---------|---------|
| `REDIS_CLIENT` | Client library (`phpredis`) |
| `REDIS_HOST` | Redis hostname (`valkey` Docker service) |
| `REDIS_PORT` | Redis port (`6379`) |
| `REDIS_PASSWORD` | Redis password |

**Used for**:
- **Session storage**: `SESSION_DRIVER=redis` (`.env.base:61`)
- **Queue backend**: `QUEUE_CONNECTION=redis` (`.env.base:78`)
- **Cache store**: `CACHE_STORE=redis` (`.env.base:112`)
- **Reverb scaling**: Optional Redis pub/sub for multi-server Reverb (`config/reverb.php:40-51`)

**Docker service**: `valkey/valkey:alpine` (Valkey is a Redis-compatible fork)

---

## 10. PostgreSQL (Primary Database)

**Config** (`.env.base:48-56`):
| Env Var | Purpose |
|---------|---------|
| `DB_CONNECTION` | Database driver (`pgsql`) |
| `DB_HOST` | Database host (`pgsql` Docker service) |
| `DB_PORT` | Database port (`5432`) |
| `DB_USERNAME` | Database user (`appuser`) |
| `DB_DATABASE` | Database name (`z360`) |
| `DB_SECRET` | JSON secret for AWS Aurora compatibility |

**Multi-tenancy**: All tenant-scoped models use `BelongsToTenant` trait with automatic `organization_id` scoping via `TenantScope` global scope.

---

## 11. Google My Business (GMB) — Business Profile

External service for fetching and scraping Google Business Profile data.

**Webhook endpoints** (`routes/webhooks.php:60-61`):
- `POST /webhooks/gmb/profile/{token}` -> `GmbWebhookController@profile` — profile extraction results
- `POST /webhooks/gmb/scrape/{token}` -> `GmbWebhookController@scrape` — website scraping results

**Auth**: Encrypted organization ID in URL token (`decrypt($token)`)

**Data flows**:
- **External scraper -> Z360**: GMB profile data and website scrape results via encrypted-token webhooks (`app/Http/Controllers/Gmb/GmbWebhookController.php`)
- **Z360 -> Processing**: Dispatches `ProcessGmbProfileWebhookJob` and `ProcessGmbScrapeWebhookJob`

---

## 12. ngrok (Development Tunneling)

Provides public URL tunneling for webhook development.

**Config** (`.env.base:187-190`):
| Env Var | Purpose |
|---------|---------|
| `NGROK_AUTHTOKEN` | ngrok authentication token |
| `NGROK_HOSTNAME` | Custom ngrok hostname |

**Docker service**: `ngrok/ngrok:latest` — tunnels traffic to the app container
**Used by**: `CPaaSService::tunnelSafeUrl()` (`app/Services/CPaaSService.php:92-109`) generates webhook URLs that prefer the tunnel host when available

---

## 13. Nightwatch (Application Monitoring)

**Config** (`.env.base:194-201`):
| Env Var | Purpose |
|---------|---------|
| `NIGHTWATCH_TOKEN` | API token |
| `NIGHTWATCH_REQUEST_SAMPLE_RATE` | HTTP request sampling (0.1 = 10%) |
| `NIGHTWATCH_EXCEPTION_SAMPLE_RATE` | Exception tracking (1.0 = 100%) |
| `NIGHTWATCH_COMMAND_SAMPLE_RATE` | Artisan command tracking (1.0 = 100%) |
| `NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD` | Capture request payloads |
| `NIGHTWATCH_IGNORE_QUERIES` | Skip query logging |

---

## 14. Mail Services

**Config** (`.env.base:126-136`):
- Default mailer: `log` (development), configurable for production
- Supports: Postmark (`POSTMARK_TOKEN`), SES (uses AWS credentials), Resend (`RESEND_KEY`)
- Mail config in `config/services.php:17-29`

---

## Service Dependency Summary

```
                                ┌──────────────┐
                                │   Frontend   │
                                │  (React/TS)  │
                                └──────┬───────┘
                                       │ WebSocket (Echo)
                                       ▼
┌─────────┐  webhooks   ┌──────────────────────────────┐  HTTP API   ┌─────────────┐
│  Telnyx  │ ──────────> │                              │ ──────────> │   Telnyx    │
│  (CPaaS) │ <────────── │        Z360 Backend          │ <────────── │   (CPaaS)   │
└─────────┘  API calls   │      (Laravel 12)            │  SDK calls  └─────────────┘
                         │                              │
┌─────────┐  webhooks   │                              │  OAuth2     ┌─────────────┐
│  Stripe  │ ──────────> │  Services:                   │ ──────────> │  Firebase   │
│(Billing) │ <────────── │  - CPaaSService              │             │   (FCM)     │
└─────────┘  Cashier     │  - PushNotificationService   │             └─────────────┘
                         │  - ApnsVoipService           │
┌─────────┐  Pub/Sub    │  - AgentService              │  HTTP/2     ┌─────────────┐
│  Gmail   │ ──────────> │  - A2PService                │ ──────────> │   APNs      │
│ (Google) │ <────────── │                              │             │  (Apple)    │
└─────────┘  Gmail API   │                              │             └─────────────┘
                         │                              │
┌─────────┐  webhooks   │                              │  HTTP       ┌─────────────┐
│  Agent   │ ──────────> │                              │ ──────────> │   Agent     │
│ Gateway  │ <────────── │                              │             │  Gateway    │
└─────────┘  HTTP API    └──────────┬───────┬───────┬──┘             └─────────────┘
                                    │       │       │
                              ┌─────┘  ┌────┘  ┌────┘
                              ▼        ▼       ▼
                         ┌────────┐ ┌──────┐ ┌──────────┐
                         │PostgreSQL│ │Redis/│ │  S3/     │
                         │(Database)│ │Valkey│ │  MinIO   │
                         └────────┘ └──────┘ └──────────┘
```

---

## Cross-Reference: Webhook Route Registry

All webhook endpoints are defined in `routes/webhooks.php` and are **outside authentication and tenant middleware**:

| Route | Service | Controller |
|-------|---------|-----------|
| `POST /webhooks/stripe` | Stripe | `StripeWebhookController` |
| `POST /webhooks/emails/gmail` | Gmail/Google | `EmailWebhookController` |
| `POST /webhooks/cpaas/telnyx/notifications` | Telnyx | `TelnyxNotificationsWebhookController` |
| `POST /webhooks/cpaas/telnyx/call-control` | Telnyx | `TelnyxInboundWebhookController` |
| `POST /webhooks/cpaas/telnyx/call-control/failover` | Telnyx | `TelnyxInboundWebhookController@failover` |
| `POST /webhooks/cpaas/telnyx/credential` | Telnyx | `TelnyxOutboundWebhookController` |
| `POST /webhooks/cpaas/telnyx/credential/failover` | Telnyx | `TelnyxOutboundWebhookController@failover` |
| `POST /webhooks/cpaas/telnyx/a2p` | Telnyx | `TelnyxA2PWebhookController` |
| `POST /webhooks/cpaas/telnyx/a2p/failover` | Telnyx | `TelnyxA2PWebhookController@failover` |
| `POST /webhooks/cpaas/telnyx/sms` | Telnyx | `TelnyxSMSWebhookController` |
| `POST /webhooks/cpaas/telnyx/sms/failover` | Telnyx | `TelnyxSMSWebhookController@failover` |
| `POST /webhooks/cpaas/telnyx/rcs` | Telnyx | `TelnyxRCSWebhookController` |
| `POST /webhooks/cpaas/telnyx/rcs/failover` | Telnyx | `TelnyxRCSWebhookController@failover` |
| `POST /webhooks/ai/run` | Agent Gateway | `AgentRunWebhookController` |
| `POST /webhooks/ai/run/testing` | Agent Gateway | `AbilityTestingWebhookController` |
| `POST /webhooks/ai/transcription/{message}` | Agent Gateway | `AgentTranscriptionWebhookController` |
| `POST /webhooks/gmb/profile/{token}` | GMB Scraper | `GmbWebhookController@profile` |
| `POST /webhooks/gmb/scrape/{token}` | GMB Scraper | `GmbWebhookController@scrape` |
