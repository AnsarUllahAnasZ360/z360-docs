---
title: System Architecture Unified
---

# Z360 Unified System Architecture

This document synthesizes three research perspectives — web platform, mobile platforms, and external services — into a single coherent view of the Z360 system architecture.

---

## 1. System Overview

Z360 is a **multi-tenant SaaS platform** for business communications and contact management. It combines:

- **Web Platform**: Laravel 12 + React 19 + TypeScript + Inertia.js SPA
- **Mobile Apps**: Capacitor 8 hybrid apps (iOS + Android) with native VoIP layers
- **Real-time Layer**: Laravel Reverb WebSocket broadcasting
- **AI Layer**: External Python agent gateway with 45-tool MCP server
- **CPaaS Integration**: Telnyx for voice, SMS, RCS, and WebRTC
- **Infrastructure**: PostgreSQL, Redis/Valkey, S3/MinIO, Docker

The platform operates in two system layers:
- **Organizational Layer** — Tenant-scoped business operations (Contacts, Inbox, Tickets, Inquiries, AI Studio, Settings)
- **Administrative Layer** — Platform-wide management

All data is tenant-isolated via session-based organization switching with automatic query scoping across 32 models.

---

## 2. Master System Diagram

```
                              EXTERNAL SERVICES
    ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌───────────┐
    │  Telnyx  │  │  Stripe  │  │  Gmail/  │  │   AI     │  │    GMB    │
    │  (CPaaS) │  │(Billing) │  │  Google  │  │ Gateway  │  │ (Scraper) │
    └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘
         │              │             │              │              │
    webhooks +     webhooks      Pub/Sub +       webhooks +      webhooks
    API calls      + Cashier     OAuth/API       HTTP + MCP     (encrypted)
         │              │             │              │              │
    ═════╪══════════════╪═════════════╪══════════════╪══════════════╪═════════
         │              │             │              │              │
         ▼              ▼             ▼              ▼              ▼
    ┌────────────────────────────────────────────────────────────────────┐
    │                     Z360 LARAVEL BACKEND                          │
    │                                                                    │
    │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐   │
    │  │  Webhook     │  │  Web Routes  │  │  API Routes            │   │
    │  │  Controllers │  │  (Inertia)   │  │  (device tokens, VoIP) │   │
    │  │  (18 routes) │  │  (16 files)  │  │  + MCP Server (45      │   │
    │  └──────┬───────┘  └──────┬───────┘  │    tools)              │   │
    │         │                 │           └───────────┬────────────┘   │
    │         ▼                 ▼                       ▼                │
    │  ┌──────────────────────────────────────────────────────────┐     │
    │  │              MIDDLEWARE STACK                             │     │
    │  │  SetCurrentTenant │ EnsureSubscription │ HandleInertia   │     │
    │  └──────────────────────────────┬───────────────────────────┘     │
    │                                 ▼                                  │
    │  ┌──────────────────────────────────────────────────────────┐     │
    │  │              SERVICE LAYER                                │     │
    │  │  CPaaSService │ PushNotificationService │ AgentService    │     │
    │  │  ApnsVoipService │ A2PService │ OnboardingService         │     │
    │  └──────────────────────────────┬───────────────────────────┘     │
    │                                 ▼                                  │
    │  ┌─────────────────┐  ┌────────────────┐  ┌──────────────────┐   │
    │  │  40+ Models     │  │  23 Observers  │  │  Jobs / Events   │   │
    │  │  (32 tenant-    │  │  (lifecycle    │  │  / Listeners     │   │
    │  │   aware)        │  │   hooks)       │  │  (async + real-  │   │
    │  └────────┬────────┘  └────────────────┘  │   time)          │   │
    │           │                                └────────┬─────────┘   │
    │           ▼                                         ▼             │
    │  ┌────────────┐  ┌────────────┐  ┌────────────────────────────┐  │
    │  │ PostgreSQL │  │ Redis /    │  │  Laravel Reverb            │  │
    │  │ (primary   │  │ Valkey     │  │  (WebSocket Server)        │  │
    │  │  database) │  │ (cache,    │  │  ┌─────────────────────┐   │  │
    │  │            │  │  queue,    │  │  │ Broadcast Events:   │   │  │
    │  │            │  │  session)  │  │  │ IncomingCallNotif   │   │  │
    │  │            │  │            │  │  │ CallEndedNotif      │   │  │
    │  └────────────┘  └────────────┘  │  │ OrgSwitched         │   │  │
    │                                   │  │ AgentScheduleUpd    │   │  │
    │  ┌────────────┐                   │  └─────────┬───────────┘   │  │
    │  │  S3/MinIO  │                   └────────────┼───────────────┘  │
    │  │  (files)   │                                │                  │
    │  └────────────┘                                │                  │
    └────────────────────────────────────────────────┼──────────────────┘
                                                     │
         PUSH SERVICES                               │ WebSocket (wss://)
    ┌──────────┐  ┌──────────┐                       │
    │ Firebase │  │  Apple   │                       │
    │   FCM    │  │  APNs    │                       │
    │(Android) │  │  (iOS)   │                       │
    └────┬─────┘  └────┬─────┘                       │
         │              │                             │
    ═════╪══════════════╪═════════════════════════════╪════════════════════
         │              │           CLIENT LAYER      │
         │              │                             │
         ▼              ▼                             ▼
    ┌────────────────────────┐              ┌────────────────────────┐
    │     MOBILE APPS        │              │      WEB BROWSER       │
    │  (Capacitor Hybrid)    │              │                        │
    │                        │              │  React 19 + Inertia.js │
    │  ┌──────────────────┐  │              │  ┌──────────────────┐  │
    │  │  Capacitor       │  │              │  │ Laravel Echo     │  │
    │  │  WebView (SPA)   │◄─┼── Reverb ───┼─►│ (WebSocket)      │  │
    │  └────────┬─────────┘  │              │  └──────────────────┘  │
    │           │ Bridge     │              │                        │
    │  ┌────────▼─────────┐  │              │  ┌──────────────────┐  │
    │  │ TelnyxVoipPlugin │  │              │  │ TelnyxRTCProvider│  │
    │  │ (Capacitor)      │  │              │  │ (@telnyx/react-  │  │
    │  └────────┬─────────┘  │              │  │  client WebRTC)  │  │
    │           │             │              │  └──────────────────┘  │
    │  ┌────────▼─────────┐  │              └────────────────────────┘
    │  │  NATIVE VoIP     │  │
    │  │  (Telnyx SDK)    │  │
    │  │  ┌────────────┐  │  │
    │  │  │ Android:   │  │  │
    │  │  │ ViewModel  │  │  │
    │  │  │ ConnSvc    │  │  │
    │  │  │ FCM Handler│  │  │
    │  │  ├────────────┤  │  │
    │  │  │ iOS:       │  │  │
    │  │  │ Z360VoIP   │  │  │
    │  │  │ CallKit    │  │  │
    │  │  │ PushKit    │  │  │
    │  │  └────────────┘  │  │
    │  └──────────────────┘  │
    └────────────────────────┘
```

---

## 3. Component Architecture Summary

### 3.1 Backend (Laravel 12)

| Component | Count | Key Responsibility |
|-----------|-------|-------------------|
| Controllers | 50+ | Thin orchestrators — validate via Form Requests, delegate to Services/Observers |
| Services | 20+ | Business logic: CPaaSService (Telnyx), PushNotificationService, AgentService, ApnsVoipService |
| Models | 40+ | 32 tenant-aware via `BelongsToTenant` trait. `Contact` is the central data model. |
| Observers | 23 | Lifecycle hooks receiving data via temp properties (`$model->_propertyName`) |
| Form Requests | 60+ | Validation logic extracted from controllers |
| Enums | 39 | Domain enums across communication, AI, billing, inquiry, and organization |
| Traits | 13 | `BelongsToTenant`, `HasAvatar`, `Taggable`, `Ownable`, `Assignable`, etc. |
| Middleware | 15+ | Tenant scoping, subscription gates, onboarding, session tracking |
| Jobs | 11+ | Async processing: email, SMS, AI runs, workflows, usage metering |
| Events | 16+ | 4 broadcastable (VoIP + org), 12 organization lifecycle |
| MCP Tools | 45 | AI agent tools across Contacts, Conversations, Tickets, Inquiries, Insights, Abilities |

### 3.2 Frontend (React 19 + Inertia.js)

| Component | Count | Key Responsibility |
|-----------|-------|-------------------|
| Pages | 200+ | Inertia page components across 10+ domains |
| Layouts | 4 | App, Settings, Auth, Onboarding |
| Hooks | 17+ | State management, platform detection, VoIP, real-time |
| UI Components | 40+ | ShadCN-based primitives |
| Providers | 7+ | Error boundary, Toast, Modal, VoIP (platform-conditional), Dialpad, Sidebar |
| Broadcast Listeners | 7 | Real-time updates for notifications, inbox, chat, AI, widget, org switch, VoIP |

**Provider hierarchy** (outermost to innermost):
```
AppErrorBoundary → GlobalToastProvider → ModalStackProvider →
  [Web: TelnyxRTCProvider | Native: NativeVoipProvider] →
    DialpadProvider → SidebarProvider → Page Content
```

### 3.3 Mobile (Capacitor 8 Hybrid)

**The critical architectural insight**: VoIP on mobile does NOT go through the Capacitor WebView. Native code speaks directly to Telnyx SDKs. Capacitor handles WebView, navigation, and standard notifications. The `TelnyxVoipPlugin` bridge carries only JS-initiated commands and native-to-JS event notifications.

| Platform | Native Files | Key Components |
|----------|-------------|----------------|
| Android | 26 | `TelnyxVoipPlugin`, `Z360ConnectionService`, `IncomingCallActivity`, `ActiveCallActivity`, `Z360FirebaseMessagingService`, `PushSynchronizer` |
| iOS | 25 | `TelnyxVoipPlugin`, `Z360VoIPService`, `CallKitManager`, `PushKitManager`, `TelnyxService`, `PushCorrelator` |

**Capacitor plugins** (shared): Browser, Keyboard, LocalNotifications, PushNotifications, StatusBar

### 3.4 External Services (14+)

| Service | Protocol | Direction | Purpose |
|---------|----------|-----------|---------|
| Telnyx (8 sub-services) | HTTPS + webhooks | Bidirectional | Voice, SMS, RCS, WebRTC, A2P, credentials |
| Firebase FCM | HTTPS (OAuth2) | Z360 → FCM | Android push notifications |
| Apple APNs | HTTP/2 (JWT/cert) | Z360 → APNs | iOS VoIP push notifications |
| Stripe | HTTPS + webhooks | Bidirectional | Billing, subscriptions, PAYG metering |
| Google/Gmail | HTTPS + Pub/Sub | Bidirectional | OAuth, Gmail email integration |
| AI Agent Gateway | HTTPS + webhooks | Bidirectional | AI reasoning, MCP tools, transcription |
| LiveKit | SIP | Z360 → LiveKit | AI voice calls |
| S3/MinIO | HTTPS | Bidirectional | File storage |
| Laravel Reverb | WebSocket | Backend → clients | Real-time event broadcasting |
| Redis/Valkey | TCP | Internal | Cache, queue, session store |
| PostgreSQL | TCP | Internal | Primary database |
| ngrok | TCP tunnel | Dev only | Webhook tunneling |
| Nightwatch | HTTPS | Z360 → Nightwatch | Application monitoring |
| Composio | HTTPS | Z360 → Composio | Third-party integration orchestration (40+ services) |

---

## 4. Key Architectural Patterns

### 4.1 Multitenancy (7-Layer Isolation)

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| HTTP Middleware | `SetCurrentTenant` reads org from session | All web requests |
| Model Scoping | `BelongsToTenant` adds global scope `WHERE org_id = ?` | 32 models |
| Migration Macro | `$table->organization()` adds tenant FK | Schema |
| Job Middleware | `SetCurrentTenant` restores tenant in queue | Async jobs |
| Job Trait | `InteractsWithTenant` serializes tenant context | Job payloads |
| Broadcasting | `TenantPrivateChannel` prefixes `org.{id}` | WebSocket channels |
| Admin Bypass | `withoutGlobalScope(TenantScope::class)` | Admin queries |

### 4.2 VoIP Dual-Mode Architecture

The VoIP layer operates differently based on platform:

| Platform | VoIP Provider | Connection | Call UI |
|----------|--------------|------------|---------|
| Web browser | `TelnyxRTCProvider` | WebRTC via `@telnyx/react-client` | React components in browser |
| Android native | `NativeVoipProvider` → Telnyx Android SDK | Native WebSocket/WebRTC | `IncomingCallActivity` / `ActiveCallActivity` |
| iOS native | `NativeVoipProvider` → Telnyx iOS SDK (`TxClient`) | Native WebSocket/WebRTC | iOS CallKit system UI |

On native, `NativeVoipProvider` replaces `TelnyxRTCProvider` to prevent dual WebSocket connections.

### 4.3 Two-Push Architecture (Mobile Incoming Calls)

Both mobile platforms receive TWO push notifications per incoming call:

1. **Z360 Backend Push** — caller display info (name, avatar, org ID, channel)
2. **Telnyx SDK Push** — call control metadata (SIP headers, call ID)

Either push can arrive first. Both platforms implement synchronization:
- **Android**: `PushSynchronizer` (Kotlin `CompletableDeferred`, 500ms timeout)
- **iOS**: `PushCorrelator` (Swift Actor, thread-safe coordination)

### 4.4 iOS Two-Phase Startup

iOS uses deferred initialization to prevent WebKit IPC starvation:

- **Phase 1** (`didFinishLaunchingWithOptions`, ~50ms): PushKit registration + CallKit delegate only
- **Phase 2** (`sceneDidBecomeActive`): Firebase, AVAudioSession, network monitoring, session checks

Without this, `AVAudioSession.setCategory()` starves WebKit IPC, causing 37-43 second WebView launch delays.

### 4.5 Controller Orchestration

Controllers are thin orchestrators. The pattern is:
```
Request → Form Request (validation) → Controller (orchestration) →
  Model + Observer (business logic via temp properties) → Database
```

23 observers handle lifecycle side effects, receiving data via temporary properties (`$model->_propertyName`) set by controllers.

### 4.6 Webhook-Driven Integration

18 webhook endpoints handle external service callbacks (no auth middleware — routing determined by payload content):
- **Telnyx**: 13 endpoints (call control, SMS, RCS, A2P, notifications + failovers)
- **Stripe**: 1 endpoint (billing events)
- **Gmail**: 1 endpoint (Pub/Sub notifications)
- **AI Gateway**: 3 endpoints (agent runs, testing, transcription)

---

## 5. Platform Comparison Matrix

| Aspect | Web | Android | iOS |
|--------|-----|---------|-----|
| **Runtime** | Browser (React SPA) | Capacitor WebView + native | Capacitor WebView + native |
| **VoIP SDK** | `@telnyx/react-client` (WebRTC) | Telnyx Android SDK (native) | Telnyx iOS SDK / `TxClient` (native) |
| **Push delivery** | Reverb WebSocket broadcast | FCM (Firebase) | PushKit (Apple VoIP push) |
| **Push handler** | Echo listener → React state | `Z360FirebaseMessagingService` | `PushKitManager` |
| **Call UI** | React DialpadContext | Native Activities | CallKit system UI |
| **System integration** | None | TelecomManager / ConnectionService | CallKit / CXProvider |
| **Credential storage** | Session / Inertia props | SharedPreferences | Keychain |
| **Startup** | Page load | Single-phase (plugin load) | Two-phase (deferred init) |
| **Push timing constraint** | N/A | ANR after 5s | Must report CallKit in 5s or app killed |
| **Background calls** | Not supported | Foreground service + TelecomManager | Background modes: voip, audio |

---

## 6. Data Flow Summary

### 6.1 Inbound Call Flow (End-to-End)

```
PSTN Caller → Telnyx Platform
    │
    ▼ webhook POST
TelnyxInboundWebhookController
    │
    ├── CPaaSService (call control commands back to Telnyx)
    │
    ├── PushNotificationService.sendIncomingCallPush()
    │       ├── FCM → Android Z360FirebaseMessagingService → PushSynchronizer → ConnectionService → IncomingCallActivity
    │       └── APNs → iOS PushKitManager → PushCorrelator → CallKitManager → System Call UI
    │
    └── IncomingCallNotification Event → Reverb → Echo → DialpadContext → Web Ringing UI
```

### 6.2 AI Agent Flow

```
User (Chat/Inbox) → Controller → AgentService.gatewayRequest() → HTTP → Python AI Gateway
    │
    ├── AI Model (LLM processing)
    ├── MCP Tool Calls → POST /mcp/{org} → McpServer → Tool Execution → PostgreSQL
    └── Webhook Callback → POST /webhooks/ai/run → AgentRunWebhookController → Broadcast → Client
```

### 6.3 Real-Time Broadcasting

```
Server Event → Laravel Event (ShouldBroadcast) → Broadcasting System → Reverb
    │
    ▼ WebSocket (wss://)
Laravel Echo (Frontend) → Broadcast Listener Hook → React State Update → UI Re-render
```

---

## 7. Gaps and Observations

### 7.1 Findings Across All Three Perspectives

1. **Webhook security varies by service**: Telnyx uses JWT client_state for routing, Stripe uses signature verification, Gmail uses Pub/Sub envelope, GMB uses encrypted organization tokens. No unified webhook authentication pattern.

2. **VoIP credential lifecycle is complex**: Per-device SIP credentials are created on Telnyx, stored in `UserTelnyxTelephonyCredential`, returned with JWT tokens to devices. 7-day stale device cleanup is automatic. Organization switching requires credential regeneration.

3. **The two-push architecture is the most complex synchronization point**: Both platforms need to correlate Z360 display info with Telnyx call control metadata within 500ms, handling arbitrary arrival order. This is a critical correctness requirement.

4. **iOS startup performance fix is a significant engineering constraint**: The two-phase startup exists solely because AVAudioSession initialization conflicts with WebKit IPC. This creates ordering dependencies that must be maintained.

5. **Native call UI diverges significantly**: Android uses custom Activities (full control, custom design) while iOS uses system CallKit UI (mandated by Apple, limited customization). This creates different testing and UX maintenance requirements.

6. **The MCP server (45 tools) creates a bidirectional loop**: Laravel sends requests to the AI Gateway, which calls back into Laravel via MCP tools, then sends results back via webhooks. This creates a circular dependency path.

### 7.2 Open Questions for Subsequent Sessions

1. **Call state synchronization**: How does call state stay consistent across web + mobile when a user has both open? What happens on conflict?

2. **Organization switching during active calls**: The `OrgSwitchHelper` (Android) and `OrganizationSwitcher` (iOS) exist — what exactly do they reset and reinitialize?

3. **Crash recovery completeness**: Both platforms have crash recovery (`CrashRecoveryManager` on Android, `cleanupOrphanCallState` on iOS) — what call states can they recover from?

4. **WebRTC quality monitoring**: `CallQualityMonitor` (iOS) tracks MOS/jitter/RTT. Does Android have equivalent? How is this data used?

5. **Simultaneous ringing across devices**: How does the backend coordinate ringing on web + Android + iOS simultaneously? What happens when one device answers?

6. **Push notification reliability**: What happens when FCM or APNs pushes fail? Is there a fallback mechanism?

7. **Telnyx SDK version parity**: Are the Android and iOS Telnyx SDK versions kept in sync? Do they have feature parity?

---

## 8. File Reference Index

### Backend
- `app/Services/CPaaSService.php` — Primary Telnyx integration (543 lines)
- `app/Services/PushNotificationService.php` — FCM + APNs push dispatch
- `app/Services/ApnsVoipService.php` — APNs VoIP direct integration
- `app/Services/AgentService.php` — AI gateway HTTP client
- `app/Http/Controllers/Telnyx/` — 8 Telnyx webhook controllers
- `app/Http/Controllers/Api/DeviceTokenController.php` — VoIP credential lifecycle
- `app/Http/Controllers/Api/VoipCredentialController.php` — VoIP credential endpoints
- `app/Mcp/Servers/McpServer.php` — 45-tool MCP server
- `app/Events/IncomingCallNotification.php` — Real-time call event
- `app/Traits/BelongsToTenant.php` — Core multitenancy trait
- `routes/webhooks.php` — 18 webhook endpoints
- `routes/api.php` — REST API (device tokens, VoIP credentials)
- `config/cpaas.php` — Telnyx configuration
- `config/services.php` — External service credentials

### Frontend
- `resources/js/app.tsx` — App entry (Inertia, Echo, platform detection)
- `resources/js/plugins/telnyx-voip.ts` — Capacitor VoIP plugin bridge
- `resources/js/providers/native-voip-provider.tsx` — Native VoIP provider
- `resources/js/utils/platform.ts` — Platform detection
- `resources/js/hooks/use-notification-broadcast.ts` — Real-time notifications
- `resources/js/components/identifier-details-sidebar/dialpad/` — VoIP dialer

### Android
- `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt` — Capacitor bridge
- `android/app/src/main/java/com/z360/app/voip/Z360ConnectionService.kt` — Telecom framework
- `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt` — Incoming call UI
- `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt` — FCM handler
- `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt` — Two-push sync
- `android/app/src/main/AndroidManifest.xml` — Component declarations

### iOS
- `ios/App/App/VoIP/TelnyxVoipPlugin.swift` — Capacitor bridge
- `ios/App/App/VoIP/Services/Z360VoIPService.swift` — Central orchestrator
- `ios/App/App/VoIP/Managers/CallKitManager.swift` — CallKit integration
- `ios/App/App/VoIP/Managers/PushKitManager.swift` — PushKit VoIP push
- `ios/App/App/VoIP/Services/PushCorrelator.swift` — Two-push sync
- `ios/App/App/VoIP/Services/TelnyxService.swift` — SDK wrapper
- `ios/App/App/AppDelegate.swift` — Two-phase startup
- `ios/App/App/SceneDelegate.swift` — Deferred initialization trigger

### Configuration
- `capacitor.config.ts` — Capacitor configuration
- `.env.base` — Environment variables
- `config/` — 24 Laravel config files

---

*Synthesized from: web-platform-architecture.md, mobile-platform-architecture.md, external-services-map.md*
*Generated: 2026-02-08*
