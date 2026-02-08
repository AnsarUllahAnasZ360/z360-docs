---
title: Control Flows
---

# Z360 VoIP Control Flows

![How Calling Works](/diagrams/how-calling-works.jpeg)

This document traces the exact sequence of control through the Z360 VoIP system for six critical flows. For each step: **trigger**, **owner**, **data exchanged**, **what can go wrong**, and **file references**.

---

## 1. App Launch Sequence

**Summary**: App opens → platform detected → provider selected → device registered with backend → SIP credentials created on Telnyx → native SDK connects.

### 1.1 Web Browser Launch

```
[Browser]         [React App]           [Backend]              [Telnyx Platform]
    │                  │                     │                        │
    │  page load       │                     │                        │
    ├─────────────────►│                     │                        │
    │                  │                     │                        │
    │           Capacitor.isNativePlatform() │                        │
    │           → false → select web path    │                        │
    │                  │                     │                        │
    │           useWebVoipCredentials()      │                        │
    │           generates browser device ID  │                        │
    │           (localStorage: z360_browser_ │                        │
    │            device_id)                  │                        │
    │                  │                     │                        │
    │                  │  POST /api/device-  │                        │
    │                  │  tokens             │                        │
    │                  │  {device_id:        │                        │
    │                  │   "web_{uuid}",     │                        │
    │                  │   platform: "web"}  │                        │
    │                  ├────────────────────►│                        │
    │                  │                     │                        │
    │                  │                     │  handleCredentials()   │
    │                  │                     │  ensures user has      │
    │                  │                     │  Telnyx credential     │
    │                  │                     ├───────────────────────►│
    │                  │                     │  ◄── credential + JWT ─┤
    │                  │                     │                        │
    │                  │  ◄── { jwt_token }  │                        │
    │                  │                     │                        │
    │           TelnyxRTCProvider wraps app  │                        │
    │           with login_token (JWT)       │                        │
    │                  │                     │                        │
    │           WebRTC WebSocket connects    │                        │
    │           to Telnyx via JWT auth       │                        │
    └──────────────────┘                     │                        │
```

**Step-by-step**:

| # | Step | Owner | Trigger | Data | Failure Mode |
|---|------|-------|---------|------|-------------|
| 1 | Page loads, React app boots | Browser | URL navigation | Inertia page props | Page crash → error boundary |
| 2 | `Capacitor.isNativePlatform()` → false | Frontend JS | App mount | Boolean | Always deterministic |
| 3 | `useWebVoipCredentials()` hook runs | Frontend JS | Component mount | Generates `web_{uuid}` device ID | localStorage unavailable → no persistent ID |
| 4 | `POST /api/device-tokens` with web platform | Frontend JS → Backend | Hook effect | `{device_id, fcm_token, platform, device_name}` | Network error → falls back to legacy per-user JWT |
| 5 | `DeviceTokenController.store()` creates/updates `UserDeviceToken` | Backend | HTTP request | Validates + stores device | DB error → 500 |
| 6 | `CPaaSService::handleCredentials($user)` gets/creates Telnyx credential | Backend | Device registration | User → JWT token (10h TTL) | Telnyx API failure → no credentials |
| 7 | JWT returned to frontend | Backend → Frontend | HTTP response | `{sip_credentials: {jwt_token}}` | — |
| 8 | `TelnyxRTCProvider` wraps app with `credential={{ login_token }}` | Frontend JS | Provider mount | JWT token | Invalid JWT → WebSocket auth failure |
| 9 | WebRTC WebSocket connection established | Telnyx SDK (JS) | Provider init | WebSocket to Telnyx | Network issues → no real-time calls |

**File references**:
- `resources/js/layouts/app-layout.tsx:136-144` — Provider selection (TelnyxRTCProvider vs NativeVoipProvider)
- `resources/js/utils/platform.ts:13-36` — Platform detection
- `resources/js/hooks/useWebVoipCredentials.ts:74-134` — Web device registration hook
- `app/Http/Controllers/Api/DeviceTokenController.php:42-177` — Device token endpoint
- `app/Services/CPaaSService.php` — `handleCredentials()`, `createDeviceCredential()`, `getDeviceJwt()`

---

### 1.2 iOS Native Launch (Two-Phase Startup)

```
[iOS System]    [AppDelegate]    [SceneDelegate]    [Capacitor WebView]    [JS Layer]         [Backend]
    │                │                 │                    │                   │                   │
    │ app launch     │                 │                    │                   │                   │
    ├───────────────►│                 │                    │                   │                   │
    │                │                 │                    │                   │                   │
    │         PHASE 1 (≤50ms):        │                    │                   │                   │
    │         PushKitManager           │                    │                   │                   │
    │           .initialize()          │                    │                   │                   │
    │         Z360VoIPService          │                    │                   │                   │
    │           .setupMinimal()        │                    │                   │                   │
    │         (delegates only,         │                    │                   │                   │
    │          NO AVAudioSession)      │                    │                   │                   │
    │                │                 │                    │                   │                   │
    │                │  scene active   │                    │                   │                   │
    │                │◄────────────────┤                    │                   │                   │
    │                │                 │                    │                   │                   │
    │         PHASE 2 (deferred):      │                    │                   │                   │
    │         configureAudioSession()  │                    │                   │                   │
    │         startNetworkMonitoring() │                    │                   │                   │
    │         configureFirebase()      │                    │                   │                   │
    │         cleanupOrphanCallState() │                    │                   │                   │
    │                │                 │                    │                   │                   │
    │                │                 │    WebView loads   │                   │                   │
    │                │                 ├───────────────────►│                   │                   │
    │                │                 │                    │  React app boots  │                   │
    │                │                 │                    ├──────────────────►│                   │
    │                │                 │                    │                   │                   │
    │                │                 │                    │  useNativeVoip()  │                   │
    │                │                 │                    │  registers event  │                   │
    │                │                 │                    │  listeners        │                   │
    │                │                 │                    │                   │                   │
    │                │                 │                    │  registerAndConnect()                 │
    │                │                 │                    │  ┌────────────────┤                   │
    │                │                 │                    │  │ requestVoipPermissions()           │
    │                │                 │                    │  │ getDeviceId()                      │
    │                │                 │                    │  │ getFcmTokenWithWait(5s)            │
    │                │                 │                    │  │  → polls PushKit token             │
    │                │                 │                    │  │                                    │
    │                │                 │                    │  │ POST /api/device-tokens            │
    │                │                 │                    │  │ {device_id, fcm_token(pushkit),    │
    │                │                 │                    │  │  platform: "ios"}                  │
    │                │                 │                    │  ├───────────────────────────────────►│
    │                │                 │                    │  │                                    │
    │                │                 │                    │  │ ◄── {sip_username, sip_password}   │
    │                │                 │                    │  │                                    │
    │                │                 │                    │  │ TelnyxVoip.connect(sipUser, sipPwd)│
    │                │                 │                    │  │  → voipService.connect()           │
    │                │                 │                    │  │  → TxClient credential login       │
    │                │                 │                    │  │  → waits for ClientLoggedIn        │
    │                │                 │                    │  │                                    │
    │                │                 │                    │  │ emit 'connected' event             │
    │                │                 │                    │  └────────────────┘                   │
```

**Critical constraint**: Phase 1 MUST NOT call `AVAudioSession.setCategory()`. Doing so starves WebKit IPC, causing 37-43 second WebView launch delays.

| # | Step | Owner | Trigger | Failure Mode |
|---|------|-------|---------|-------------|
| 1 | `didFinishLaunchingWithOptions()` Phase 1 | iOS native | System launch | — |
| 2 | PushKit registration | iOS native (PushKitManager) | Phase 1 | No VoIP pushes → missed calls |
| 3 | `sceneDidBecomeActive()` triggers Phase 2 | iOS native (SceneDelegate) | Scene active | Delayed if backgrounded |
| 4 | AVAudioSession + Firebase + network monitoring | iOS native (AppDelegate) | Phase 2 | Audio not configured → call audio fails |
| 5 | WebView loads → React boots | Capacitor | Phase 2 | WebView crash → blank screen |
| 6 | `useNativeVoip()` registers event listeners | Frontend JS | Component mount | Missing listeners → events lost |
| 7 | `registerAndConnect()` → permissions + device ID + PushKit token | Frontend JS → Native | Auth state change | Permission denied → no mic/push |
| 8 | `POST /api/device-tokens` | Frontend JS → Backend | Step 7 | Network error → no SIP credentials |
| 9 | `TelnyxVoip.connect(sip_username, sip_password)` | Native (Z360VoIPService) | Credentials received | Telnyx auth failure → not connected |
| 10 | TxClient `ClientLoggedIn` state | Telnyx iOS SDK | Step 9 | Timeout → retry needed |

**File references**:
- `ios/App/App/AppDelegate.swift:28-50` — Phase 1 (minimal init)
- `ios/App/App/AppDelegate.swift:54-89` — Phase 2 (deferred init)
- `ios/App/App/SceneDelegate.swift:37-55` — `sceneDidBecomeActive()` trigger
- `ios/App/App/VoIP/TelnyxVoipPlugin.swift:97-120` — Plugin load (sets delegates, no setup)
- `ios/App/App/VoIP/Services/Z360VoIPService.swift:108-214` — connect() method
- `ios/App/App/VoIP/Managers/PushKitManager.swift` — PushKit registration

---

### 1.3 Android Native Launch

```
[Android System]  [MainActivity]     [TelnyxVoipPlugin]     [JS Layer]         [Backend]
    │                  │                    │                    │                   │
    │  onCreate()      │                    │                    │                   │
    ├─────────────────►│                    │                    │                   │
    │                  │                    │                    │                   │
    │           installSplashScreen()       │                    │                   │
    │           registerPlugin(             │                    │                   │
    │             TelnyxVoipPlugin)         │                    │                   │
    │                  │                    │                    │                   │
    │                  │  plugin.load()     │                    │                   │
    │                  ├───────────────────►│                    │                   │
    │                  │                    │                    │                   │
    │                  │             VoipLogger.init()           │                   │
    │                  │             TokenHolder.initialize()    │                   │
    │                  │             ConnectionService           │                   │
    │                  │               .registerPhoneAccount()   │                   │
    │                  │             startObservingTelnyx()      │                   │
    │                  │                    │                    │                   │
    │           super.onCreate()            │                    │                   │
    │           (loads WebView)             │                    │                   │
    │           handleNotificationIntent()  │                    │                   │
    │           checkForCrashRecovery()     │                    │                   │
    │                  │                    │                    │                   │
    │                  │                    │  React boots       │                   │
    │                  │                    │◄───────────────────┤                   │
    │                  │                    │                    │                   │
    │                  │                    │  registerAndConnect()                  │
    │                  │                    │  (same as iOS: permissions →           │
    │                  │                    │   device ID → FCM token →             │
    │                  │                    │   POST /api/device-tokens →           │
    │                  │                    │   connect with SIP credentials)       │
    │                  │                    │                    ├──────────────────►│
    │                  │                    │                    │ ◄── SIP creds    │
    │                  │                    │                    │                   │
    │                  │                    │  TelnyxVoip.connect()                 │
    │                  │                    │  → credentialLogin(profile, autoLogin)│
    │                  │                    │  → 8s timeout for ClientLoggedIn      │
    │                  │                    │  → emit 'connected'                   │
```

**Key difference from iOS**: Single-phase startup. No deferred initialization needed because Android doesn't have WebKit IPC starvation issue.

**BUG-003 protection**: `TelnyxVoipPlugin.connect()` checks if already connected and skips reconnection to prevent killing an existing WebSocket.

| # | Step | Owner | Trigger | Failure Mode |
|---|------|-------|---------|-------------|
| 1 | `onCreate()` — splash + plugin registration | Android native | System launch | — |
| 2 | `TelnyxVoipPlugin.load()` — logger, FCM token, phone account | Android native | Plugin system | Phone account registration failure → no Telecom integration |
| 3 | `Z360ConnectionService.registerPhoneAccount()` | Android native | Plugin load | TelecomManager rejection → degraded call experience |
| 4 | WebView loads → React boots | Capacitor | `super.onCreate()` | — |
| 5 | `registerAndConnect()` — same flow as iOS | Frontend JS → Native → Backend | Auth state | — |
| 6 | `credentialLogin(profile, autoLogin: true)` | Telnyx Android SDK | Credentials received | 8s timeout → connection failure |

**File references**:
- `android/app/src/main/java/com/z360/app/MainActivity.kt:35-48` — `onCreate()`
- `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:97-105` — `load()`
- `android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:119-179` — `connect()` with BUG-003 guard
- `resources/js/plugins/use-telnyx-voip.ts:315-395` — `registerAndConnect()`
- `resources/js/plugins/telnyx-voip.ts` — Capacitor plugin interface definition

---

## 2. Inbound Call Initiation

**Summary**: PSTN caller dials → Telnyx webhook → backend checks availability → sends push notifications + Reverb broadcast → creates SIP legs to devices → devices ring.

```
[PSTN Caller]    [Telnyx Platform]    [Z360 Backend]           [FCM/APNs]    [Devices]    [Reverb]    [Web]
    │                  │                    │                       │             │            │          │
    │  dials number    │                    │                       │             │            │          │
    ├─────────────────►│                    │                       │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │  POST /webhooks/   │                       │             │            │          │
    │                  │  call.initiated    │                       │             │            │          │
    │                  ├───────────────────►│                       │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │             1. Check blocked               │             │            │          │
    │                  │             2. Check schedule              │             │            │          │
    │                  │             3. Find receivingUser          │             │            │          │
    │                  │             4. Create Message record       │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │             transferToUser():              │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │             ┌──────┴──────┐                │             │            │          │
    │                  │             │ STEP A:     │                │             │            │          │
    │                  │             │ Send pushes │                │             │            │          │
    │                  │             │ to mobile   │                │             │            │          │
    │                  │             └──────┬──────┘                │             │            │          │
    │                  │                    │  sendIncomingCallPush()│             │            │          │
    │                  │                    ├──────────────────────►│             │            │          │
    │                  │                    │  (FCM for Android,    │  push       │            │          │
    │                  │                    │   APNs for iOS)       ├────────────►│            │          │
    │                  │                    │                       │             │            │          │
    │                  │             ┌──────┴──────┐                │             │            │          │
    │                  │             │ STEP B:     │                │             │            │          │
    │                  │             │ Broadcast   │                │             │            │          │
    │                  │             │ to web      │                │             │            │          │
    │                  │             └──────┬──────┘                │             │            │          │
    │                  │                    │  IncomingCallNotif    │             │            │          │
    │                  │                    ├─────────────────────────────────────────────────►│          │
    │                  │                    │  (via Reverb)         │             │            │          │
    │                  │                    │                       │             │            │   Echo   │
    │                  │                    │                       │             │            ├─────────►│
    │                  │                    │                       │             │            │          │
    │                  │             ┌──────┴──────┐                │             │            │          │
    │                  │             │ STEP C:     │                │             │            │          │
    │                  │             │ Create SIP  │                │             │            │          │
    │                  │             │ legs        │                │             │            │          │
    │                  │             └──────┬──────┘                │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │  [single device]:  │                       │             │            │          │
    │                  │  call.transfer()   │                       │             │            │          │
    │                  │◄──────────────────┤                       │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │  [multi device]:   │                       │             │            │          │
    │                  │  call.create() × N │                       │             │            │          │
    │                  │  (simultaneous     │                       │             │            │          │
    │                  │   ring legs)       │                       │             │            │          │
    │                  │◄──────────────────┤                       │             │            │          │
    │                  │                    │                       │             │            │          │
    │                  │  Parent call stays │                       │             │            │          │
    │  ◄── ringback ──┤  PARKED (not       │                       │             │            │          │
    │                  │  answered yet)     │                       │             │            │          │
```

### Step-by-Step Detail

| # | Step | Owner | Trigger | Data | Failure Mode |
|---|------|-------|---------|------|-------------|
| 1 | PSTN caller dials Z360 number | External | Human action | Phone number | — |
| 2 | Telnyx sends `call.initiated` webhook | Telnyx Platform | PSTN call | POST with `call_control_id`, `call_session_id`, `from`, `to` | Webhook delivery failure → call rings until timeout |
| 3 | `TelnyxInboundWebhookController::handleCall()` | Backend | Webhook | Parses `TelnyxCallInitiatedData` | — |
| 4 | Check if caller is blocked | Backend | Step 3 | `$callerIdentifier->is_blocked` | — |
| 5 | Check availability schedule | Backend | Step 3 | `OrganizationSetting::get(['cpaas_schedule'])` | Outside schedule → voicemail |
| 6 | Find `receivingUser` from channel config | Backend | Step 3 | `$data->channel()?->receivingUser` | No user → voicemail |
| 7 | Create `Message` record | Backend | Step 3 | `call_session_id`, `original_from`, `received_by` in metadata | DB failure → 500 |
| 8 | `sendIncomingCallPush()` to mobile devices | Backend (PushNotificationService) | `transferToUser()` | Caller name/number/avatar, call IDs, org ID | Push failure → device doesn't ring (but SIP leg still rings SDK) |
| 9 | FCM push → Android devices | FCM | Step 8 | Z360 display payload | FCM delivery delay → late ring |
| 10 | APNs VoIP push → iOS devices | APNs (ApnsVoipService) | Step 8 | VoIP push with `telnyx_push_metadata` | APNs failure → device doesn't wake |
| 11 | `IncomingCallNotification` broadcast via Reverb | Backend | `transferToUser()` | `callSessionId`, `callerName`, `callerNumber`, `channelNumber`, `organizationId` | Reverb unavailable → web doesn't ring |
| 12 | Look up per-device SIP credentials | Backend | `transferToUser()` | `UserDeviceToken` where `sip_username` NOT NULL and active within 1 day | No credentials → voicemail |
| 13a | Single device: `Telnyx\Call::transfer()` to SIP endpoint | Backend → Telnyx | Step 12 (1 device) | `sip:{username}@sip.telnyx.com`, 30s timeout | Transfer failure → voicemail |
| 13b | Multi-device: `Telnyx\Call::create()` × N (simultaneous ring) | Backend → Telnyx | Step 12 (N devices) | One SIP leg per device, `client_state` with `simultaneous_ring_leg` type | All legs fail → retry once after 2s → voicemail |
| 14 | Store ring session in cache | Backend | Step 13b | `Cache::put("simring:{$parentId}", ...)` with leg IDs, user ID, message ID | Cache failure → answer coordination breaks |
| 15 | Parent call stays **parked** — NOT answered | Backend decision | Step 13b | Caller hears ringback from carrier | — |

**Critical design decisions**:
- **Org-level SIP credential is NOT dialed** (line 265-266). Only per-device credentials are dialed. Dialing the org credential creates a phantom SIP leg that answers first and steals the bridge.
- **Parent call stays parked**. The PSTN caller continues to hear carrier ringback. Parent is only answered when a device picks up (in `onCallAnswered()`).
- **Retry logic**: If all simultaneous ring legs fail, wait 2 seconds and retry once. If still failing, route to voicemail.

**File references**:
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:43-100` — `handleCall()` entry point
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:212-396` — `transferToUser()` (push + broadcast + SIP legs)
- `app/Services/PushNotificationService.php:20-115` — `sendIncomingCallPush()`
- `app/Services/ApnsVoipService.php` — APNs VoIP push delivery
- `app/Events/IncomingCallNotification.php` — Reverb broadcast event
- `app/Events/CallEndedNotification.php` — Broadcast for simultaneous ring dismissal

---

### 2.1 Two-Push Synchronization on Devices

Each mobile device receives **two pushes** per incoming call that may arrive in any order:

1. **Z360 Backend Push** — caller display info (name, avatar, org ID, channel)
2. **Telnyx SDK Push** — call control metadata (SIP headers, call ID)

**Android synchronization** (`PushSynchronizer` with Kotlin `CompletableDeferred`, 500ms timeout):

```
Z360 Push arrives first:                    Telnyx Push arrives first:
  → store caller info in VoipStore             → PushSynchronizer.onTelnyxPushReceived()
  → PushSynchronizer.onZ360PushReceived()      → start 500ms wait for Z360 push
  │                                            │
  ▼                                            ▼
  Telnyx Push arrives:                       Z360 Push arrives (within 500ms):
  → PushSynchronizer.onTelnyxPushReceived()    → PushSynchronizer.onZ360PushReceived()
  → Z360 already available → merge             → completes CompletableDeferred
  → check user busy (active call?)             → merge display info
  → ensureTelnyxSdkConnected()                 → proceed to ring
  → ConnectionService.addIncomingCall()
  → show IncomingCallActivity

  Z360 Push never arrives (timeout):
  → use fallback display info (number only)
  → proceed to ring
```

**iOS synchronization** (`PushCorrelator` with Swift actor + `CheckedContinuation`, 500ms timeout):

```
Similar pattern using Swift actors for thread safety.
PushKit push → CallKitManager.reportIncomingCall() MUST complete within 5 seconds.
If Telnyx push metadata not yet available, report with partial info and update later.
```

**File references**:
- `android/app/src/main/java/com/z360/app/fcm/Z360FirebaseMessagingService.kt:110` — `onMessageReceived()`
- `android/app/src/main/java/com/z360/app/fcm/PushSynchronizer.kt` — 500ms `CompletableDeferred` coordination
- `ios/App/App/VoIP/Managers/PushKitManager.swift` — PushKit delegate
- `ios/App/App/VoIP/Services/PushCorrelator.swift` — Actor-based coordination

---

## 3. Call Answer Sequence

**Summary**: User taps answer → native layer accepts Telnyx call → backend receives `call.answered` webhook → backend bridges parent ↔ device → other devices get hangup.

### 3.1 Android Answer

```
[User]    [IncomingCallActivity]    [TelnyxViewModel]    [Z360Connection]    [Backend]        [Other Devices]
   │              │                       │                    │                 │                    │
   │  tap Answer  │                       │                    │                 │                    │
   ├─────────────►│                       │                    │                 │                    │
   │              │                       │                    │                 │                    │
   │       onAnswerCall():                │                    │                 │                    │
   │       atomic check-and-set           │                    │                 │                    │
   │       (BUG-005 double-tap)           │                    │                 │                    │
   │              │                       │                    │                 │                    │
   │       check cross-org?               │                    │                 │                    │
   │       ├─ NO: answerDirectly()        │                    │                 │                    │
   │       └─ YES: OrgSwitchHelper →      │                    │                 │                    │
   │              API call first           │                    │                 │                    │
   │              │                       │                    │                 │                    │
   │       stop ringtone                  │                    │                 │                    │
   │       wait 250ms (BUG-003            │                    │                 │                    │
   │         audio settle)                │                    │                 │                    │
   │              │                       │                    │                 │                    │
   │              │  answerCall(callId)    │                    │                 │                    │
   │              ├──────────────────────►│                    │                 │                    │
   │              │                       │                    │                 │                    │
   │              │                 SDK sends SIP 200 OK       │                 │                    │
   │              │                 to Telnyx Platform ────────────────────────►│                    │
   │              │                       │                    │                 │                    │
   │              │  notifyAnswered()      │                    │                 │                    │
   │              ├───────────────────────────────────────────►│                 │                    │
   │              │                       │              setActive()             │                    │
   │              │                       │              (Telecom framework)     │                    │
   │              │                       │                    │                 │                    │
   │              │                       │                    │  call.answered  │                    │
   │              │                       │                    │  webhook        │                    │
   │              │                       │                    │◄────────────────┤                    │
   │              │                       │                    │                 │                    │
   │              │                       │                    │  onCallAnswered()                   │
   │              │                       │                    │  acquire lock   │                    │
   │              │                       │                    │  check first    │                    │
   │              │                       │                    │  → YES: bridge  │                    │
   │              │                       │                    │                 │                    │
   │              │                       │                    │  answer parent  │                    │
   │              │                       │                    │  bridge parent  │                    │
   │              │                       │                    │  ↔ device leg   │                    │
   │              │                       │                    │                 │                    │
   │              │                       │                    │  hang up other  │                    │
   │              │                       │                    │  legs ──────────────────────────────►│
   │              │                       │                    │                 │                    │
   │              │                       │                    │  broadcast      │                    │
   │              │                       │                    │  CallEndedNotif │                    │
   │              │                       │                    │  (answered_     │                    │
   │              │                       │                    │   elsewhere)  ──────────────────────►│
   │              │                       │                    │                 │                    │
   │              │  launch ActiveCallActivity                 │                 │                    │
   │              │  cancel notifications  │                    │                 │                    │
```

**Step-by-step**:

| # | Step | Owner | Trigger | Data | Failure Mode |
|---|------|-------|---------|------|-------------|
| 1 | User taps Answer | User | UI action | — | — |
| 2 | `onAnswerCall()` with atomic `compareAndSet` (BUG-005) | Android native | Tap event | — | Double tap → second call ignored |
| 3 | Check cross-org: if `switchOrg=true`, call `OrgSwitchHelper` first | Android native | Push metadata | `organizationId` from push | Org switch failure → show error toast |
| 4 | Stop ringtone + 250ms wait (BUG-003) | Android native | Step 2 | — | Audio artifacts if skipped |
| 5 | Get pending call (SDK call, plugin call, or wait 5s for SDK INVITE) | Android native | Step 4 | Call UUID | Timeout → fallback to `answerIncomingPushCall()` |
| 6 | `telnyxViewModel.answerCall(callId)` → SIP 200 OK | Telnyx Android SDK | Step 5 | Call ID | SDK error → call not answered |
| 7 | `Z360Connection.notifyAnswered()` → `setActive()` | Android native | Step 6 | Connection state | Telecom framework error → degraded UI |
| 8 | Telnyx receives SIP 200 OK → sends `call.answered` webhook | Telnyx Platform → Backend | SIP signaling | `call_control_id`, `client_state` with `simultaneous_ring_leg` | Webhook delivery delay → brief race window |
| 9 | `onCallAnswered()` acquires distributed lock `simring:{parentId}:lock` | Backend | Webhook | Lock key | Lock contention → second answerer hung up |
| 10 | Check ring session: first to answer? | Backend | Step 9 | `Cache::get("simring:{parentId}")` | Cache miss → answer not processed |
| 11 | **Answer parent call** (was parked) | Backend → Telnyx | First answerer | `Telnyx\Call::answer()` on parent | API failure → caller still parked |
| 12 | **Bridge parent ↔ answered device leg** | Backend → Telnyx | Step 11 | `Telnyx\Call::bridge(['call_control_id' => $answeredLeg])` | Bridge failure → one-way audio |
| 13 | Start recording on parent call | Backend → Telnyx | Step 12 | `record_start()` with format=wav, channels=dual | Recording failure → non-critical |
| 14 | Hang up all other SIP legs | Backend → Telnyx | Step 12 | Loop: `$otherCall->hangup()` for non-answered legs | Some legs may have already ended |
| 15 | Broadcast `CallEndedNotification` (reason: `answered_elsewhere`) | Backend → Reverb | Step 12 | `userId`, `callSessionId`, `reason` | Broadcast failure → web UI stays ringing |
| 16 | `PushNotificationService::sendCallEndedPush()` to mobile devices | Backend → FCM/APNs | Step 12 | `userId`, `callSessionId` | Push delay → mobile UI stays ringing briefly |
| 17 | Launch `ActiveCallActivity`, cancel notifications | Android native | Step 6 | Call info | — |

**File references**:
- `android/app/src/main/java/com/z360/app/voip/IncomingCallActivity.kt` — `onAnswerCall()`, `answerDirectly()`
- `android/app/src/main/java/com/z360/app/voip/Z360Connection.kt` — `notifyAnswered()` → `setActive()`
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:449-596` — `onCallAnswered()` (lock, bridge, hangup others)

---

### 3.2 iOS Answer

```
[User]    [CallKit UI]    [CallKitManager]    [Z360VoIPService]    [TelnyxService]    [Backend]
   │           │                │                    │                    │                │
   │  tap      │                │                    │                    │                │
   │  Answer   │                │                    │                    │                │
   ├──────────►│                │                    │                    │                │
   │           │                │                    │                    │                │
   │           │ CXAnswerCall   │                    │                    │                │
   │           │ Action         │                    │                    │                │
   │           ├───────────────►│                    │                    │                │
   │           │                │                    │                    │                │
   │           │         delegate callback           │                    │                │
   │           │         callKitManager(             │                    │                │
   │           │          didReceiveAnswerAction)     │                    │                │
   │           │                ├───────────────────►│                    │                │
   │           │                │                    │                    │                │
   │           │                │             ActionGuard check          │                │
   │           │                │             (BUG-005 double-tap)       │                │
   │           │                │                    │                    │                │
   │           │                │             check cross-org?           │                │
   │           │                │             ├─ YES: OrganizationSwitcher               │
   │           │                │             │   switchOrganization()    │                │
   │           │                │             │   (API + credential +    │                │
   │           │                │             │    SDK reconnect)        │                │
   │           │                │             │   MUST complete in <5s   │                │
   │           │                │             │                          │                │
   │           │                │             ├─ markCallAsAnswered()    │                │
   │           │                │                    │                    │                │
   │           │                │                    │  answerFromCallKit │                │
   │           │                │                    ├───────────────────►│                │
   │           │                │                    │                    │                │
   │           │                │                    │             SDK sends SIP 200 OK   │
   │           │                │                    │             action.fulfill()        │
   │           │                │                    │                    ├───────────────►│
   │           │                │                    │                    │                │
   │           │                │                    │                    │  (same backend │
   │           │                │                    │                    │   flow as      │
   │           │                │                    │                    │   Android)     │
```

**Key difference from Android**: iOS answer flows through CallKit's `CXAnswerCallAction`. The SDK internally calls `action.fulfill()` when ready. Even if SDK not ready, action is fulfilled to prevent CallKit from hanging.

**Critical constraint**: Cross-org switch MUST complete within 5 seconds (CallKit deadline). If switch takes too long, call answer fails gracefully.

**File references**:
- `ios/App/App/VoIP/Managers/CallKitManager.swift` — CXAnswerCallAction delegate
- `ios/App/App/VoIP/Services/Z360VoIPService.swift` — `answerCall()` with ActionGuard, cross-org check
- `ios/App/App/VoIP/Services/TelnyxService.swift` — `answerFromCallKit()` → SDK `answerFromCallkit()`

---

### 3.3 Web Answer

```
[User]    [Dialpad UI]    [DialpadContext]    [TelnyxRTC SDK]    [Backend]
   │           │                │                    │                │
   │  click    │                │                    │                │
   │  Answer   │                │                    │                │
   ├──────────►│                │                    │                │
   │           │  answer()      │                    │                │
   │           ├───────────────►│                    │                │
   │           │                │                    │                │
   │           │         activeCall.answer()         │                │
   │           │                ├───────────────────►│                │
   │           │                │                    │                │
   │           │                │             SIP 200 OK via WebSocket│
   │           │                │                    ├───────────────►│
   │           │                │                    │                │
   │           │                │             call.state → 'active'  │
   │           │                │                    │                │
   │           │         UI updates to active call   │                │
```

**File references**:
- `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:530-547` — `answer()` callback
- `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:268` — Answer button

---

## 4. Outbound Call Initiation

**Summary**: User opens dialer → enters number → selects caller ID → taps call → routes through native plugin (mobile) or TelnyxRTC (web).

### 4.1 Shared Entry Point (Frontend)

```
[User]    [Dialer UI]    [DialpadContext]         [Native/Web]
   │           │                │                       │
   │  enter #  │                │                       │
   │  tap Call │                │                       │
   ├──────────►│                │                       │
   │           │  placeCall()   │                       │
   │           ├───────────────►│                       │
   │           │                │                       │
   │           │         validate caller ID             │
   │           │         (must be in callAsPhoneNumbers)│
   │           │                │                       │
   │           │         check: useNativeVoip?          │
   │           │         ├─ NATIVE: TelnyxVoip.makeCall()
   │           │         └─ WEB: client.newCall()       │
```

### 4.2 Web Outbound

| # | Step | Owner | Data |
|---|------|-------|------|
| 1 | `placeCall()` called | DialpadContext | `destinationNumber`, `callerNumber` |
| 2 | `client.newCall({destinationNumber, callerNumber, clientState})` | TelnyxRTC SDK | `clientState`: base64 JSON `{user_id}` |
| 3 | WebRTC SIP INVITE sent to Telnyx | TelnyxRTC SDK → Telnyx | SIP signaling |
| 4 | Telnyx connects to PSTN recipient | Telnyx Platform | — |
| 5 | Call state: `requesting` → `ringing` → `active` | TelnyxRTC SDK | State updates to React |

### 4.3 Native (Android/iOS) Outbound

| # | Step | Owner | Data |
|---|------|-------|------|
| 1 | `placeCall()` called | DialpadContext | `destinationNumber`, `callerIdNumber` |
| 2 | `TelnyxVoip.isConnected()` check | Native plugin | Boolean |
| 3 | `TelnyxVoip.makeCall({destinationNumber, callerIdNumber})` | Capacitor bridge → Native | — |
| 4 | Native SDK creates SIP INVITE | Telnyx SDK (native) | SIP signaling |
| 5 | Telnyx connects to PSTN recipient | Telnyx Platform | — |
| 6 | Native emits call state events → JS listener | Native → Frontend JS | `callStarted`, `callRinging`, `callAnswered` |

### 4.4 Backend Role in Outbound

The backend receives a `call.initiated` webhook for outbound calls via `TelnyxOutboundWebhookController`:

| # | Step | Owner | Trigger |
|---|------|-------|---------|
| 1 | Telnyx sends `call.initiated` webhook (outbound direction) | Telnyx → Backend | SIP INVITE |
| 2 | Check if recipient is blocked or has DND | Backend | Webhook |
| 3 | If blocked: speak message + hangup | Backend → Telnyx | — |
| 4 | Otherwise: `transfer()` to recipient SIP endpoint | Backend → Telnyx | — |

**File references**:
- `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:412-509` — `placeCall()` with native/web routing
- `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:48-63` — Dialer UI with call button
- `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php` — Outbound webhook handling

---

## 5. Call Hangup Sequence

**Summary**: User taps hangup → native/web layer ends call → Telnyx SDK sends BYE → backend receives webhook → backend broadcasts `call_ended` → other devices dismiss UI.

### 5.1 Web Hangup

```
[User]    [Dialpad UI]    [DialpadContext]    [TelnyxRTC SDK]    [Telnyx]    [Backend]
   │           │                │                    │               │            │
   │  click    │  hangUp()      │                    │               │            │
   │  Hangup   ├───────────────►│                    │               │            │
   │           │                │                    │               │            │
   │           │         activeCall.hangup()         │               │            │
   │           │                ├───────────────────►│               │            │
   │           │                │                    │  SIP BYE      │            │
   │           │                │                    ├──────────────►│            │
   │           │                │                    │               │            │
   │           │                │              state → 'destroy'     │            │
   │           │                │                    │               │  webhook   │
   │           │                │                    │               │  hangup    │
   │           │                │                    │               ├───────────►│
   │           │                │                    │               │            │
   │           │         UI clears call state        │               │            │
```

### 5.2 Android Hangup

```
[User]    [ActiveCallActivity]    [TelnyxViewModel]    [Z360Connection]    [Telnyx]
   │              │                      │                    │               │
   │  tap Hangup  │                      │                    │               │
   ├─────────────►│                      │                    │               │
   │              │  hangupCall()        │                    │               │
   │              ├─────────────────────►│                    │               │
   │              │                      │  SIP BYE           │               │
   │              │                      ├───────────────────────────────────►│
   │              │                      │                    │               │
   │              │  notifyDisconnected()│                    │               │
   │              ├──────────────────────────────────────────►│               │
   │              │                      │             setDisconnected()      │
   │              │                      │             (DisconnectCause)      │
   │              │                      │                    │               │
   │              │  cancel notifications│                    │               │
   │              │  dismiss Activity    │                    │               │
```

### 5.3 iOS Hangup

```
[User]    [CallKit UI]    [CallKitManager]    [Z360VoIPService]    [TelnyxService]
   │           │                │                    │                    │
   │  tap End  │                │                    │                    │
   ├──────────►│                │                    │                    │
   │           │  CXEndCall     │                    │                    │
   │           │  Action        │                    │                    │
   │           ├───────────────►│                    │                    │
   │           │                │  endCall(uuid)     │                    │
   │           │                ├───────────────────►│                    │
   │           │                │                    │                    │
   │           │                │             ActionGuard check          │
   │           │                │             stopTimer() → duration     │
   │           │                │                    │                    │
   │           │                │                    │  endCallFromCallKit│
   │           │                │                    ├───────────────────►│
   │           │                │                    │                    │
   │           │                │                    │             SIP BYE│
   │           │                │                    │             action.fulfill()
   │           │                │                    │                    │
   │           │                │             clear activeCallUUID       │
   │           │                │             clear telnyxToCallKitMap   │
   │           │                │             clear persisted state      │
   │           │                │             notify plugin (callEnded)  │
```

### 5.4 Backend Hangup Processing

When the backend receives `call.hangup` webhook for a simultaneous ring parent:

| # | Step | Owner | Action |
|---|------|-------|--------|
| 1 | `call.hangup` webhook received | Backend | Route by `client_state` type |
| 2 | If `simultaneous_ring_parent`: `onSimultaneousRingParentHangup()` | Backend | Caller hung up |
| 3 | Get ring session from cache | Backend | `Cache::get("simring:{parentId}")` |
| 4 | If call was bridged: hang up the bridged device leg | Backend → Telnyx | `$bridgedCall->hangup()` |
| 5 | Broadcast `CallEndedNotification` to web | Backend → Reverb | `reason: 'completed'` |
| 6 | Send call ended push to mobile | Backend → FCM/APNs | Dismiss ringing UI |
| 7 | Update Message with recording URL, duration | Backend | Database update |
| 8 | Clean up cache: `Cache::forget("simring:{parentId}")` | Backend | — |

### 5.5 Simultaneous Ring Dismissal (Answered Elsewhere)

When call is answered on one device, other devices receive dismissal:

| Channel | Mechanism | Handler |
|---------|-----------|---------|
| Web (Reverb) | `CallEndedNotification` broadcast with `reason: 'answered_elsewhere'` | `useEcho` listener in DialpadContext → `activeCall.hangup()` |
| Android (FCM) | `sendCallEndedPush()` | `Z360FirebaseMessagingService` → dismiss notification |
| iOS (APNs) | `sendCallEndedPush()` | PushKit handler → `CallKitManager.endCall()` |
| SIP (Telnyx) | Other SIP legs hung up by backend | SDK receives BYE → fires `callEnded` event |

**File references**:
- `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:511-528` — `hangUp()` callback
- `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:208-227` — `call_ended` broadcast listener
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:599-643` — `onSimultaneousRingParentHangup()`
- `app/Http/Controllers/Telnyx/TelnyxInboundWebhookController.php:669-780` — `onSimultaneousRingLegHangup()`
- `app/Events/CallEndedNotification.php:1-46` — Broadcast event definition

---

## 6. Organization Switch During VoIP

**Summary**: User switches org mid-session → backend switches tenant context + gets new credentials → native SDKs disconnect and reconnect → push registrations stay (device tokens are per-user, not per-org).

### 6.1 Cross-Org Incoming Call Switch

This flow is triggered when a user receives an incoming call for an organization different from their current one.

```
[Incoming Push]    [Native Layer]        [Backend API]             [Telnyx SDK]
     │                   │                     │                        │
     │  push metadata    │                     │                        │
     │  includes         │                     │                        │
     │  organizationId   │                     │                        │
     │  ≠ current org    │                     │                        │
     ├──────────────────►│                     │                        │
     │                   │                     │                        │
     │            user taps Answer             │                        │
     │                   │                     │                        │
     │            detect cross-org call        │                        │
     │                   │                     │                        │
     │                   │  POST /api/voip/    │                        │
     │                   │  switch-org         │                        │
     │                   │  {target_org_id}    │                        │
     │                   ├────────────────────►│                        │
     │                   │                     │                        │
     │                   │              1. Validate user access         │
     │                   │              2. $organization->switchTo()    │
     │                   │              3. $user->update(last_org_id)   │
     │                   │              4. Get/create Telnyx credential │
     │                   │              5. CPaaSService::handleCreds()  │
     │                   │              6. Get default caller ID        │
     │                   │                     │                        │
     │                   │  ◄── {sip_username,  │                        │
     │                   │       sip_password,  │                        │
     │                   │       jwt_token,     │                        │
     │                   │       caller_id_*,   │                        │
     │                   │       org_id,        │                        │
     │                   │       org_name}      │                        │
     │                   │                     │                        │
     │            [Android]:                   │                        │
     │            ProfileManager.saveProfile() │                        │
     │            store.setCurrentOrganization │                        │
     │            VoipAnalytics.logCrossOrgCall│                        │
     │                   │                     │                        │
     │            [iOS]:                       │                        │
     │            Store creds in Keychain      │                        │
     │            Disconnect SDK               │                        │
     │            Reconnect with new creds  ───────────────────────────►│
     │            Wait for ClientReady (3s)    │                        │
     │                   │                     │                        │
     │            proceed to answerCall()      │                        │
```

### 6.2 Backend `switchOrg()` Endpoint Detail

**Route**: `POST /api/voip/switch-org`
**Controller**: `app/Http/Controllers/Api/VoipCredentialController.php:109-218`

| # | Step | Action | Failure |
|---|------|--------|---------|
| 1 | Validate `target_organization_id` exists | `$request->validate()` | 422 if missing/invalid |
| 2 | Verify user has access to target org | `$user->organizations->contains($organization)` | 403 if unauthorized |
| 3 | Switch tenant context | `$organization->switchTo()` | Session update failure |
| 4 | Update user's `last_organization_id` | `$user->update()` | DB failure |
| 5 | Refresh user to clear relationship cache | `$user->refresh()` | — |
| 6 | Get Telnyx credential for new org (scoped by tenant) | `$user->telnyxCredential` | May not exist |
| 7 | If no credential: `CPaaSService::handleCredentials($user)` | Creates credential on Telnyx | Telnyx API failure → 500 |
| 8 | Get default caller ID number | `$this->getDefaultCallerIdNumber($user)` | May be null |
| 9 | Return credentials | JSON response | — |

**Note**: Uses `target_organization_id` instead of `organization_id` to avoid conflict with `SetCurrentTenant` middleware which checks `$request->has('organization_id')`.

### 6.3 Platform-Specific Behavior

**Android** (`OrgSwitchHelper.switchOrgAndGetCredentials()`):
- Uses WebView cookies from `CookieManager` for authentication
- 10-second HTTP timeout
- On success: saves new credentials to Telnyx Profile, updates local org context
- On failure: returns null, shows error toast, logs analytics
- File: `android/app/src/main/java/com/z360/app/voip/OrgSwitchHelper.kt`

**iOS** (`OrganizationSwitcher.switchOrganization()`):
- Registers background task (5s safety net for CallKit deadline)
- Gets cookies from `WKWebsiteDataStore`
- On success: stores credentials in Keychain, disconnects SDK, reconnects with new credentials, waits for ClientReady (3s timeout)
- On failure: restores original org context (US-023 recovery), restores original Keychain credentials
- Maps errors to user-friendly types: `NetworkError`, `ValidationError`, `ApiError`
- File: `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift`

### 6.4 What Resets During Org Switch

| Component | Resets? | Details |
|-----------|---------|---------|
| Backend session | YES | `$organization->switchTo()` changes tenant context |
| SIP credentials | YES | New per-org credentials returned |
| Telnyx SDK connection | iOS: YES (disconnect + reconnect), Android: deferred to next call | — |
| Push token registration | NO | Device tokens are per-user, not per-org; backend looks up tokens by user ID |
| WebView session | NO | Cookies remain valid, Inertia session persists |
| Local org context | YES | `VoipStore` / `UserDefaults` updated |

**File references**:
- `app/Http/Controllers/Api/VoipCredentialController.php:107-218` — `switchOrg()` backend endpoint
- `android/app/src/main/java/com/z360/app/voip/OrgSwitchHelper.kt` — Android org switch helper
- `ios/App/App/VoIP/Utils/OrganizationSwitcher.swift` — iOS org switch with recovery

---

## Summary: Who Controls Each Step

| Flow | Initiator | Controller | Executor |
|------|-----------|------------|----------|
| App launch → credential | Frontend JS (hook) | Backend (DeviceTokenController) | Telnyx API (credential creation) |
| Inbound call → ring | Telnyx Platform (webhook) | Backend (InboundWebhookController) | Push services + Telnyx (SIP legs) |
| Call answer | User (tap) | Native layer (SDK) | Backend (bridge coordination) |
| Outbound call | User (tap) | Frontend (DialpadContext) | Telnyx SDK (SIP INVITE) |
| Call hangup | User (tap) | Native/Web layer (SDK) | Backend (cleanup, broadcast) |
| Org switch | User (answer cross-org) | Backend (VoipCredentialController) | Native layer (SDK reconnect) |

---

## Critical Synchronization Points

1. **Two-push correlation** (500ms timeout): Either Z360 or Telnyx push can arrive first. Android uses `CompletableDeferred`, iOS uses Swift actor with `CheckedContinuation`.

2. **Simultaneous ring answer race** (distributed lock): Backend uses `Cache::lock("simring:{parentId}:lock")` to prevent two devices from both bridging to parent. First to acquire lock wins.

3. **Cross-org switch timing** (5s on iOS): iOS must complete org switch + SDK reconnect within CallKit's 5-second deadline or the answer action fails.

4. **Parent call parking**: Inbound PSTN parent call is NOT answered until a device picks up. Caller hears carrier ringback. Parent is only answered in `onCallAnswered()` after distributed lock acquisition.

5. **Call ended propagation**: Uses three channels simultaneously — SIP (leg hangup), Reverb (web broadcast), Push (mobile notification) — because no single channel is guaranteed to deliver in time.

---

*Generated: 2026-02-08*
*Sources: Z360 source code analysis across app/, resources/js/, android/, ios/*
