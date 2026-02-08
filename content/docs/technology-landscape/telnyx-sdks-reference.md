---
title: Telnyx SDKs Reference
---

# Telnyx WebRTC SDK Reference

Cross-platform reference covering the Android, iOS, and Web Telnyx WebRTC SDKs. Each section documents: connection model, authentication, call lifecycle, push notifications, reconnection, and state management.

---

## 1. Android SDK

**Package**: `com.telnyx.webrtc.sdk`
**Source**: `.scratchpad/packs/telnyx-android-sdk.xml` (88 files)

### 1.1 Connection Model

The Android SDK connects via WebSocket to the Telnyx Verto signaling server using OkHttp.

| Property | Value |
|---|---|
| Transport | WebSocket (OkHttpClient) |
| Production host | `rtc.telnyx.com` |
| Development host | `rtcdev.telnyx.com` |
| Port | `443` (TLS) |
| Protocol | Verto (JSON-RPC over WebSocket) |
| TURN server | `turn:turn.telnyx.com:3478?transport=tcp` |
| STUN server | `stun:stun.telnyx.com:3478` |

**Key files**:
- `TxSocket.kt` — WebSocket lifecycle, message send/receive, ping/pong
- `Config.kt` — Host addresses, ports, TURN/STUN defaults
- `TelnyxClient.kt` — Top-level client that owns the socket connection

**Connection flow**:
1. `TelnyxClient.connect(txConfig)` initializes the socket
2. `TxSocket` opens a WebSocket to `wss://rtc.telnyx.com:443`
3. On socket open, client sends a Verto `login` message with credentials or token
4. Server responds with gateway state transitions: `UNREGED` → `TRYING` → `REGISTER` → `REGED`
5. On `REGED`, the client is ready to make/receive calls

### 1.2 Authentication

Three authentication methods via sealed class `TelnyxConfig`:

**Credential login** (`CredentialConfig`):
```kotlin
CredentialConfig(
    sipUser: String,
    sipPassword: String,
    sipCallerIDName: String?,
    sipCallerIDNumber: String?,
    fcmToken: String?,        // FCM push token
    ringtone: Int?,
    ringBackTone: Int?,
    logLevel: LogLevel?,
    autoReconnect: Boolean?,  // default: false
    debug: Boolean?
)
```

**Token login** (`TokenConfig`):
```kotlin
TokenConfig(
    sipToken: String,         // JWT from Telnyx API
    sipCallerIDName: String?,
    sipCallerIDNumber: String?,
    fcmToken: String?,
    ringtone: Int?,
    ringBackTone: Int?,
    logLevel: LogLevel?,
    autoReconnect: Boolean?,  // default: true
    debug: Boolean?
)
```

**Anonymous login** (for AI assistant use):
- Uses `AuthenticateAnonymously` Verto message
- No SIP credentials required
- Limited to outbound calls only

**Key files**: `TelnyxConfig.kt`, `AuthenticateBySIPCredentials.kt`, `AuthenticateByToken.kt`, `AuthenticateAnonymously.kt`

### 1.3 Call Lifecycle

**Outbound call**:
1. `TelnyxClient.newInvite(callerName, callerNumber, destinationNumber, clientState, customHeaders)` → creates `Call` object
2. SDK sends Verto `INVITE` message with SDP offer
3. Call transitions: `NEW` → `CONNECTING` → `RINGING` → `ACTIVE`
4. Remote party answers → media flows via WebRTC peer connection

**Inbound call**:
1. Verto `INVITE` received via WebSocket (or via push notification)
2. `onIncomingCall` callback fires with `Call` object
3. User calls `call.acceptCall(callerName, callerNumber, clientState, customHeaders)` → sends Verto `ANSWER`
4. Or `call.rejectCall(callId)` → sends Verto `BYE`

**Mid-call actions**:
- `call.onHoldUnholdPressed()` — toggles hold via Verto `MODIFY` with `hold`/`unhold` action
- `call.muteAudio()` / `call.unmuteAudio()` — local track enable/disable
- `call.loudSpeakerOn()` / `call.loudSpeakerOff()` — audio routing
- `call.dtmf(digit)` — sends Verto `INFO` with DTMF payload
- `call.hangup(callId, cause)` — sends Verto `BYE` with optional SIP cause code

**Key files**: `SendInvite.kt`, `AcceptCall.kt`, `RejectCall.kt`, `HoldUnholdCall.kt`, `OnByeReceived.kt`, `Call.kt`

### 1.4 Push Notifications

Uses Firebase Cloud Messaging (FCM) for incoming call push delivery.

**Push metadata** (`PushMetaData` data class):
| Field | Description |
|---|---|
| `callerName` | Display name of the caller |
| `callerNumber` | Phone number of the caller |
| `callId` | Unique call identifier |
| `voiceSdkId` | Voice SDK identifier for call recovery |
| `rtcIP` | Signaling server IP for direct connection |
| `rtcPort` | Signaling server port |

**Push-to-call flow**:
1. FCM delivers push notification with `PushMetaData` payload
2. App creates `TelnyxClient` and calls `handlePushNotification(txPushMetaData, txConfig)`
3. SDK connects WebSocket (optionally to specific `rtcIP:rtcPort` from push metadata)
4. SDK logs in and waits for the matching Verto `INVITE` from server
5. User answers via `acceptCall()` → `AnswerIncomingPushCall` Verto message sent

**Key files**: `PushMetaData.kt`, `AnswerIncomingPushCall.kt`, `MyFirebaseMessagingService.kt`

### 1.5 Reconnection

**Configuration**:
| Constant | Value |
|---|---|
| `autoReconnect` | `false` (credential), `true` (token) |
| `RECONNECT_TIMEOUT` | 60,000 ms |
| `MAX_RECONNECTION_RETRIES` | 3 |
| `RECONNECTION_RETRY_BASE_DELAY` | 1,000 ms |

**Strategy**:
- Exponential backoff: delay doubles each retry (1s → 2s → 4s)
- On WebSocket close/error, if `autoReconnect` is enabled, `reconnectToSocket()` is called
- Preserves `sessid` (Verto session ID) across reconnection attempts for call recovery
- After `MAX_RECONNECTION_RETRIES` failures, reconnection stops and client transitions to `DISCONNECTED`
- Active calls transition to `RECONNECTING` state during reconnection, then `DROPPED` if reconnection fails within the timeout window

**Key files**: `TelnyxClient.kt` (reconnect logic), `TxSocket.kt` (socket reconnect), `Config.kt` (constants)

### 1.6 State Management

Four state enums track different system layers:

**`CallState`** (sealed class — per-call state):
| State | Description |
|---|---|
| `NEW` | Call object created |
| `CONNECTING` | SDP exchange in progress |
| `RINGING` | Remote party ringing |
| `ACTIVE` | Media flowing |
| `RENEGOTIATING` | SDP renegotiation in progress |
| `HELD` | Call placed on hold |
| `DONE(reason)` | Call ended normally |
| `ERROR` | Call error |
| `DROPPED(reason)` | Call dropped (network issue) |
| `RECONNECTING(reason)` | Attempting to recover call |

**`GatewayState`** (enum — SIP registration state):
`UNREGED`, `TRYING`, `REGISTER`, `REGED`, `UNREGISTER`, `FAILED`, `FAIL_WAIT`, `EXPIRED`, `NOREG`, `DOWN`

**`ConnectionStatus`** (enum — high-level client state):
`DISCONNECTED`, `CONNECTED`, `RECONNECTING`, `REGISTERED`

**`SocketStatus`** (enum — WebSocket transport state):
`ESTABLISHED`, `MESSAGERECEIVED`, `ERROR`, `LOADING`, `DISCONNECT`

**Key files**: `CallState.kt`, `GatewayState.kt`, `ConnectionStatus.kt`, `SocketStatus.kt`

---

## 2. iOS SDK

**Package**: `TelnyxRTC`
**Source**: `.scratchpad/packs/telnyx-ios-sdk.xml` (74 files)

### 2.1 Connection Model

The iOS SDK connects via WebSocket using the Starscream library.

| Property | Value |
|---|---|
| Transport | WebSocket (Starscream) |
| Production host | `wss://rtc.telnyx.com` |
| Development host | `wss://rtcdev.telnyx.com` |
| Protocol | Verto (JSON-RPC over WebSocket) |
| TURN server | `turn:turn.telnyx.com:3478?transport=tcp` |
| STUN server | `stun:stun.telnyx.com:3478` |

**Key files**:
- `Socket.swift` — WebSocket lifecycle using Starscream
- `SocketDelegate.swift` — Protocol for socket events
- `InternalConfig.swift` — Host URLs, TURN/STUN defaults
- `TxClient.swift` — Top-level client managing socket and calls

**Connection flow**:
1. `TxClient.connect(txConfig:)` initializes the socket with server configuration
2. `Socket` opens a WebSocket to `wss://rtc.telnyx.com`
3. On connect, SDK sends Verto `login` message
4. Gateway state transitions: `UNREGED` → `TRYING` → `REGISTER` → `REGED`
5. `TxClientDelegate.onSocketConnected()` fires, then `onClientReady()` on `REGED`

### 2.2 Authentication

Single configuration struct `TxConfig` supports two auth modes:

**Credential login**:
```swift
TxConfig(
    sipUser: String,
    password: String,
    pushDeviceToken: String?,     // APNS device token
    ringtone: String?,
    ringbackTone: String?,
    logLevel: LogLevel?,
    reconnectClient: Bool = true  // default: true
)
```

**Token login**:
```swift
TxConfig(
    token: String,                // JWT from Telnyx API
    pushDeviceToken: String?,
    ringtone: String?,
    ringbackTone: String?,
    logLevel: LogLevel?,
    reconnectClient: Bool = true
)
```

- No separate anonymous login type exposed; anonymous login is handled at the Verto message level
- `pushDeviceToken` is passed during login for APNS push registration
- `reconnectClient` defaults to `true` for both credential and token modes (unlike Android)

**Key files**: `TxConfig.swift`, `LoginMessage.swift`, `AnonymousLoginMessage.swift`

### 2.3 Call Lifecycle

**Outbound call**:
1. `TxClient.newCall(callerName:callerNumber:destinationNumber:clientState:customHeaders:)` → returns `Call` UUID
2. SDK creates WebRTC peer connection, generates SDP offer
3. Sends Verto `INVITE` with SDP
4. Call transitions: `NEW` → `CONNECTING` → `RINGING` → `ACTIVE`

**Inbound call**:
1. Verto `INVITE` received via WebSocket (or triggered after push login)
2. `TxClientDelegate.onIncomingCall(call:)` fires
3. `call.answer(customHeaders:)` → sends Verto `ANSWER` with SDP answer
4. Or `call.hangup()` to reject

**CallKit integration**:
- `TxClient.answerFromCallkit(callId:customHeaders:)` — answers a call that was already displayed via CallKit UI
- `TxClient.disablePushNotifications()` — unregisters from push on logout

**Mid-call actions**:
- `call.muteAudio()` / `call.unmuteAudio()` — local audio track toggle
- Hold/unhold via Verto `MODIFY` messages (`ModifyMessage` with `hold`/`unhold` action)
- `call.hangup()` → Verto `BYE`
- `call.dtmf(digit:)` → Verto `INFO` with DTMF payload

**Delegate callbacks** (`TxClientDelegate`):
- `onSocketConnected()` — WebSocket open
- `onClientReady()` — gateway registered
- `onClientError(error:)` — connection/auth error
- `onIncomingCall(call:)` — inbound call received
- `onRemoteCallEnded(callId:)` — remote party hung up
- `onCallStateUpdated(callState:callId:)` — call state change
- `onSessionUpdated(sessionId:)` — session ID assigned

**Key files**: `Call.swift`, `TxClient.swift`, `InviteMessage.swift`, `AnswerMessage.swift`, `ByeMessage.swift`, `ModifyMessage.swift`

### 2.4 Push Notifications

Uses PushKit (VoIP push) with APNS for incoming call delivery. CallKit integration is required on iOS 13+.

**Push-to-call flow**:
1. PushKit delivers VoIP push notification with metadata payload
2. App must immediately report to CallKit (`reportNewIncomingCall`) — iOS 13+ requirement
3. App calls `TxClient.processVoIPNotification(txConfig:serverConfiguration:pushMetaData:)`
4. SDK connects WebSocket using `serverConfiguration` (may include specific signaling server from push)
5. SDK performs login, waits for matching Verto `INVITE`
6. User answers via CallKit → `TxClient.answerFromCallkit(callId:customHeaders:)`

**Push metadata fields** (from `TxServerConfiguration`):
| Field | Description |
|---|---|
| `voice_sdk_id` | SDK identifier for call correlation |
| `call_id` | Unique call identifier |
| `caller_name` | Display name of caller |
| `caller_number` | Phone number of caller |
| `signalingServer` | Specific signaling server URL |
| `webRTCIceServers` | ICE server configuration |

**Server configuration** (`TxServerConfiguration`):
- `signalingServer: URL` — specific WebSocket server for this call
- `webRTCIceServers: [RTCIceServer]` — custom ICE servers from push payload
- `pushMetaData: [String: Any]` — raw push notification data

**Key files**: `TxClient.swift` (processVoIPNotification), `TxServerConfiguration.swift`, `TxPushConfig.swift`, `AttachCallMessage.swift`

### 2.5 Reconnection

**Configuration**:
| Property | Default |
|---|---|
| `reconnectClient` | `true` |
| `reconnectTimeout` | 60 seconds |

**Strategy**:
- `reconnectClient()` method on `TxClient` re-establishes the WebSocket and re-authenticates
- `startReconnectTimeout()` begins a countdown; if reconnection doesn't succeed within the timeout, the client gives up
- `NetworkMonitor` (NWPathMonitor) detects network changes and triggers reconnection on connectivity restoration
- ICE restart support via `Call+IceRestart.swift` and `Peer+IceRestart.swift` for media path recovery without full WebSocket reconnection
- Active calls transition to `RECONNECTING` state during reconnection attempts
- If reconnection fails within timeout, calls transition to `DROPPED`

**Key files**: `TxClient.swift` (reconnectClient, startReconnectTimeout), `NetworkMonitor.swift`, `Call+IceRestart.swift`, `Peer+IceRestart.swift`

### 2.6 State Management

**`CallState`** (enum — per-call state):
| State | Description |
|---|---|
| `NEW` | Call object created |
| `CONNECTING` | SDP exchange in progress |
| `RINGING` | Remote party ringing |
| `ACTIVE` | Media flowing |
| `HELD` | Call on hold |
| `DONE(reason)` | Call ended normally |
| `RECONNECTING(reason)` | Attempting media recovery |
| `DROPPED(reason)` | Call dropped (network) |

Note: iOS lacks `RENEGOTIATING` and `ERROR` states present in Android.

**`GatewayStates`** (enum — SIP registration state):
`UNREGED`, `TRYING`, `REGISTER`, `REGED`, `UNREGISTER`, `FAILED`, `FAIL_WAIT`, `EXPIRED`, `NOREG`

Note: iOS lacks the `DOWN` state present in Android.

**`TxCallInfo`** — per-call metadata container:
- Tracks `callState`, `callId`, `callerName`, `callerNumber`, `isOnHold`, `isOnMute`
- Updated via `TxClientDelegate.onCallStateUpdated(callState:callId:)` callback

**Key files**: `TxCallInfo.swift`, `TxClient.swift`

---

## 3. Web SDK

**Package**: `@telnyx/webrtc`
**Source**: `.scratchpad/packs/telnyx-web-sdk.xml` (73 files, compressed)

### 3.1 Connection Model

The Web SDK connects via native browser WebSocket.

| Property | Value |
|---|---|
| Transport | Native WebSocket (`new WebSocket()`) |
| Production host | `wss://rtc.telnyx.com` (from `PROD_HOST` constant) |
| Development host | `wss://rtcdev.telnyx.com` (from `DEV_HOST` constant) |
| Protocol | Verto (JSON-RPC over WebSocket) |
| TURN/STUN | Configured via ICE servers from login response |

**Key files**:
- `Connection.ts` — WebSocket creation and management
- `BaseSession.ts` — Abstract session with connect/disconnect/login
- `BrowserSession.ts` — Browser-specific session extending BaseSession
- `TelnyxRTC.ts` — Top-level client class

**Connection flow**:
1. `new TelnyxRTC(options)` creates client instance
2. `client.connect()` opens WebSocket to signaling server
3. On socket open, SDK sends Verto `login` message
4. Gateway state transitions mirror other SDKs: `UNREGED` → `TRYING` → `REGISTER` → `REGED`
5. `telnyx.ready` event fires when registered and ready for calls

### 3.2 Authentication

Configured via `IClientOptions` / `IVertoOptions` interface:

**Credential login**:
```typescript
{
    login: string,           // SIP username
    password: string,        // SIP password
    callerIdName?: string,
    callerIdNumber?: string,
    autoReconnect?: boolean  // default: true
}
```

**Token login** (recommended):
```typescript
{
    login_token: string,     // JWT from Telnyx API
    callerIdName?: string,
    callerIdNumber?: string,
    autoReconnect?: boolean  // default: true
}
```

**Anonymous login** (for AI assistants):
```typescript
{
    anonymous_login: true    // No credentials needed
}
```

**Additional connection options**:
- `keepConnectionAliveOnSocketClose: boolean` — prevents cleanup on socket close, allows reconnection
- `env: string` — select environment (production/development)

**React integration** (`@telnyx/react-client`):
```tsx
<TelnyxRTCProvider credential={options}>
    <MyComponent />
</TelnyxRTCProvider>

// Inside component:
const { client } = useTelnyxRTC(options);
```

**Key files**: `interfaces.ts`, `TelnyxRTC.ts`, `Login.ts`, `AnonymousLogin.ts`

### 3.3 Call Lifecycle

**Outbound call**:
1. `client.newCall({ destinationNumber, callerName, callerNumber, clientState, customHeaders })` → returns `Call` object
2. SDK creates RTCPeerConnection, generates SDP offer
3. Sends Verto `INVITE`
4. Call transitions: `New` → `Requesting` → `Trying` → `Ringing` → `Active`

**Inbound call**:
1. Verto `INVITE` received via WebSocket
2. `telnyx.notification` event fires with call object and type `callUpdate`
3. `call.answer()` → sends Verto `ANSWER` with SDP answer
4. Or `call.hangup()` to reject

**Mid-call actions**:
- `call.hold()` / `call.unhold()` — Verto `MODIFY` with hold/unhold
- `call.muteAudio()` / `call.unmuteAudio()` — local audio track toggle
- `call.muteVideo()` / `call.unmuteVideo()` — local video track toggle (Web supports video)
- `call.deaf()` / `call.undeaf()` — remote audio suppression
- `call.dtmf(digit)` — Verto `INFO` with DTMF
- `call.hangup(params, execute)` → Verto `BYE`

**Event system** (EventEmitter pattern):
- `client.on('telnyx.ready', handler)` — client registered
- `client.on('telnyx.error', handler)` — connection/auth error
- `client.on('telnyx.notification', handler)` — call events, state changes
- `client.on('telnyx.socket.open', handler)` — WebSocket opened
- `client.on('telnyx.socket.close', handler)` — WebSocket closed
- `client.on('telnyx.socket.error', handler)` — WebSocket error

**Key files**: `BrowserSession.ts` (newCall), `BaseCall.ts` (answer, hangup, hold, mute), `Call.ts`, `VertoHandler.ts`

### 3.4 Push Notifications

**Not applicable for the Web SDK.** Browser-based WebRTC clients maintain a persistent WebSocket connection for signaling. Incoming calls are delivered as Verto `INVITE` messages over the active WebSocket and surfaced via the `telnyx.notification` event.

For background notification support in web apps, developers would need to implement their own service worker / Web Push approach outside the Telnyx SDK.

### 3.5 Reconnection

**Configuration**:
| Option | Default |
|---|---|
| `autoReconnect` | `true` |
| `keepConnectionAliveOnSocketClose` | `false` |

**Strategy**:
- `reconnect.ts` utility manages reconnection tokens: `getReconnectToken()`, `setReconnectToken()`, `clearReconnectToken()`
- On reconnection, the SDK sends a `login` message with `sessid` (previous session ID) and `reconnection: true` flag, allowing the server to restore session state
- `reconnectDelay()` method provides backoff between attempts
- Network listener detects browser online/offline events and triggers reconnect on connectivity restoration
- `keepConnectionAliveOnSocketClose` prevents session cleanup on socket close, preserving state for reconnection
- The `Recovering` call state indicates a call is being restored during reconnection

**Key files**: `reconnect.ts`, `BaseSession.ts` (reconnect logic), `Connection.ts` (socket reconnect)

### 3.6 State Management

**`State`** (enum — per-call state):
| State | Description |
|---|---|
| `New` | Call object created |
| `Requesting` | Outbound call initiated |
| `Trying` | Server processing invite |
| `Recovering` | Call being restored after reconnect |
| `Ringing` | Remote party ringing |
| `Answering` | Answer in progress |
| `Early` | Early media (provisional response) |
| `Active` | Media flowing |
| `Held` | Call on hold |
| `Hangup` | Call ended |

Note: Web has more granular states (`Requesting`, `Trying`, `Recovering`, `Answering`, `Early`) compared to Android/iOS, but lacks explicit `ERROR` and `DROPPED` states.

**`GatewayStateType`** (enum — SIP registration state):
`REGED`, `UNREGED`, `NOREG`, `FAILED`, `FAIL_WAIT`, `REGISTER`, `TRYING`, `EXPIRED`, `UNREGISTER`

Same set as iOS (without Android's `DOWN` state).

**Key files**: `constants.ts`, `interfaces.ts`

---

## 4. Cross-Platform Comparison

### 4.1 Connection Model

| Aspect | Android | iOS | Web |
|---|---|---|---|
| WebSocket library | OkHttp | Starscream | Native WebSocket |
| Production host | `rtc.telnyx.com:443` | `wss://rtc.telnyx.com` | `wss://rtc.telnyx.com` |
| Protocol | Verto JSON-RPC | Verto JSON-RPC | Verto JSON-RPC |
| TURN server | `turn.telnyx.com:3478` | `turn.telnyx.com:3478` | From login response |

### 4.2 Authentication

| Aspect | Android | iOS | Web |
|---|---|---|---|
| Credential login | `CredentialConfig` | `TxConfig(sipUser:password:)` | `{ login, password }` |
| Token login | `TokenConfig` | `TxConfig(token:)` | `{ login_token }` |
| Anonymous login | `AuthenticateAnonymously` | `AnonymousLoginMessage` | `{ anonymous_login: true }` |
| Config class | Sealed class `TelnyxConfig` | Struct `TxConfig` | Interface `IClientOptions` |
| Push token field | `fcmToken` (FCM) | `pushDeviceToken` (APNS) | N/A |

### 4.3 Call States

| Android | iOS | Web | Description |
|---|---|---|---|
| `NEW` | `NEW` | `New` | Call created |
| `CONNECTING` | `CONNECTING` | `Requesting`/`Trying` | Signaling in progress |
| `RINGING` | `RINGING` | `Ringing` | Remote party ringing |
| — | — | `Answering` | Answer in progress (Web only) |
| — | — | `Early` | Early media (Web only) |
| `ACTIVE` | `ACTIVE` | `Active` | Media flowing |
| `RENEGOTIATING` | — | — | SDP renegotiation (Android only) |
| `HELD` | `HELD` | `Held` | On hold |
| `DONE(reason)` | `DONE(reason)` | `Hangup` | Call ended |
| `ERROR` | — | — | Call error (Android only) |
| `DROPPED(reason)` | `DROPPED(reason)` | — | Network drop (mobile only) |
| `RECONNECTING(reason)` | `RECONNECTING(reason)` | `Recovering` | Call recovery |

### 4.4 Gateway States

| State | Android | iOS | Web |
|---|---|---|---|
| `UNREGED` | Yes | Yes | Yes |
| `TRYING` | Yes | Yes | Yes |
| `REGISTER` | Yes | Yes | Yes |
| `REGED` | Yes | Yes | Yes |
| `UNREGISTER` | Yes | Yes | Yes |
| `FAILED` | Yes | Yes | Yes |
| `FAIL_WAIT` | Yes | Yes | Yes |
| `EXPIRED` | Yes | Yes | Yes |
| `NOREG` | Yes | Yes | Yes |
| `DOWN` | Yes | — | — |

### 4.5 Push Notifications

| Aspect | Android | iOS | Web |
|---|---|---|---|
| Push system | FCM | PushKit (VoIP) + APNS | N/A |
| OS integration | — | CallKit (required iOS 13+) | — |
| Push metadata | `PushMetaData` data class | `TxServerConfiguration` | — |
| Push-to-call method | `handlePushNotification()` | `processVoIPNotification()` | — |
| Answer from push | `AnswerIncomingPushCall` | `answerFromCallkit()` | — |

### 4.6 Reconnection

| Aspect | Android | iOS | Web |
|---|---|---|---|
| Auto-reconnect default | `false` (cred) / `true` (token) | `true` | `true` |
| Timeout | 60s | 60s | — |
| Max retries | 3 | — | — |
| Backoff | Exponential (1s base) | — | `reconnectDelay()` |
| Network monitoring | — | NWPathMonitor | Browser online/offline |
| ICE restart | — | Yes (`Call+IceRestart`) | — |
| Session preservation | `sessid` | `sessid` | `sessid` + reconnection flag |

### 4.7 Event/Callback Pattern

| Aspect | Android | iOS | Web |
|---|---|---|---|
| Pattern | LiveData / callbacks | Delegate protocol | EventEmitter (`on`/`off`) |
| Incoming call | `onIncomingCall` callback | `TxClientDelegate.onIncomingCall()` | `telnyx.notification` event |
| State updates | `onCallStateChanged` | `onCallStateUpdated()` | `telnyx.notification` event |
| Ready signal | `onClientReady` | `onClientReady()` | `telnyx.ready` event |
| Error signal | `onClientError` | `onClientError()` | `telnyx.error` event |
