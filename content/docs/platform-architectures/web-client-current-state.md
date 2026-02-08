---
title: Web Client Current State
---

# Web Client VoIP Implementation — Current State

![Web Client VoIP Implementation](/diagrams/web-client-voip-implementation.jpeg)

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Platform Detection and Provider Switching](#2-platform-detection-and-provider-switching)
3. [TelnyxRTCProvider — Web VoIP Client](#3-telnyxrtcprovider--web-voip-client)
4. [NativeVoipProvider — Mobile Lightweight Context](#4-nativevoipprovider--mobile-lightweight-context)
5. [Credential Management — Web Device Registration](#5-credential-management--web-device-registration)
6. [Dialpad Components and Call UI](#6-dialpad-components-and-call-ui)
7. [Web Outbound Call Flow](#7-web-outbound-call-flow)
8. [Web Inbound Call Flow](#8-web-inbound-call-flow)
9. [Call State Management](#9-call-state-management)
10. [Push Notification Handling](#10-push-notification-handling)
11. [Multi-Tab Behavior](#11-multi-tab-behavior)
12. [Simultaneous Ring — call_ended Broadcast](#12-simultaneous-ring--call_ended-broadcast)
13. [Audio Device Management](#13-audio-device-management)
14. [VoIP Logger](#14-voip-logger)
15. [Fragile Areas and Inconsistencies](#15-fragile-areas-and-inconsistencies)

---

## 1. Architecture Overview

The Z360 web client VoIP implementation follows a **dual-provider architecture**: one path for web browsers using `@telnyx/react-client` WebRTC, and another for native mobile (iOS/Android) using Capacitor bridge plugins that delegate to platform-native Telnyx SDKs.

### Key Architectural Layers

```
┌─────────────────────────────────────────────────────────┐
│                   GlobalAppProviders                     │
│              (resources/js/layouts/app-layout.tsx)       │
├────────────────────┬────────────────────────────────────┤
│   isWeb() = true   │       isNativeMobile() = true      │
├────────────────────┼────────────────────────────────────┤
│ TelnyxRTCProvider  │       NativeVoipProvider            │
│ (WebRTC/WebSocket) │  (no-op context, native handles)   │
├────────────────────┴────────────────────────────────────┤
│                    DialpadProvider                        │
│   (resources/js/components/.../dialpad/context.tsx)      │
│   Unified call state, routes calls to web SDK or native  │
├─────────────────────────────────────────────────────────┤
│              Dialpad UI Components                       │
│   (Dialer, CallAsSelect, ToInput, Suggestions, etc.)    │
└─────────────────────────────────────────────────────────┘
```

### File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `resources/js/layouts/app-layout.tsx` | 308 | Global layout — provider switching, credential management |
| `resources/js/utils/platform.ts` | 37 | Platform detection utilities |
| `resources/js/providers/native-voip-provider.tsx` | 39 | Lightweight no-op context for native |
| `resources/js/hooks/useWebVoipCredentials.ts` | 170 | Web browser device registration and JWT credentials |
| `resources/js/hooks/useSessionCache.ts` | 74 | Session-scoped cache for JWT token with auto-refresh |
| `resources/js/plugins/telnyx-voip.ts` | 247 | Capacitor plugin interface definition |
| `resources/js/plugins/telnyx-voip-web.ts` | 145 | Web fallback (all no-ops) |
| `resources/js/plugins/use-telnyx-voip.ts` | 458 | Native VoIP hook (event listeners, register/connect) |
| `resources/js/components/.../dialpad/context.tsx` | 645 | Unified DialpadProvider — call state + routing |
| `resources/js/components/.../dialpad/dialpad.tsx` | 33 | Desktop dialpad page component |
| `resources/js/components/.../dialpad/components/dialer.tsx` | 274 | Dialpad grid, on-call UI, incoming call UI |
| `resources/js/components/.../dialpad/components/call-as-select.tsx` | 26 | Caller ID dropdown |
| `resources/js/components/.../dialpad/components/to-input.tsx` | 63 | Phone/search input with mode toggle |
| `resources/js/components/.../dialpad/components/suggestions.tsx` | 65 | Contact suggestions list |
| `resources/js/components/.../dialpad/components/call-display.tsx` | 15 | Universal sidebar call display |
| `resources/js/mobile/pages/inbox/components/mobile-dialpad.tsx` | 65 | Mobile dialpad variant |
| `resources/js/mobile/pages/inbox/components/mobile-dialpad-drawer.tsx` | 25 | Mobile drawer wrapper |
| `resources/js/hooks/use-push-notifications.ts` | 206 | Push notification registration and handling |
| `resources/js/hooks/useCountdown.ts` | 47 | Elapsed time counter for active calls |
| `resources/js/lib/voip-logger.ts` | 57 | Structured browser console logger |
| `capacitor.config.ts` | 77 | Capacitor configuration |

---

## 2. Platform Detection and Provider Switching

### Platform Detection Utilities
**File:** `resources/js/utils/platform.ts:1-37`

Four simple functions wrapping Capacitor's platform detection:

```typescript
isNativeAndroid()  // Capacitor.isNativePlatform() && getPlatform() === 'android'
isNativeIOS()      // Capacitor.isNativePlatform() && getPlatform() === 'ios'
isNativeMobile()   // isNativeAndroid() || isNativeIOS()
isWeb()            // !Capacitor.isNativePlatform()
```

### Provider Switching Logic
**File:** `resources/js/layouts/app-layout.tsx:134-146`

The `GlobalAppProviders` component conditionally wraps children in one of two providers:

```typescript
{isWeb() ? (
    <TelnyxRTCProvider credential={{ login_token: webLoginToken }}>
        {voipContent}
    </TelnyxRTCProvider>
) : (
    <NativeVoipProvider>
        {voipContent}
    </NativeVoipProvider>
)}
```

**Critical design choice:** The split happens at the layout level, ensuring exactly one VoIP transport layer is active. Web uses `TelnyxRTCProvider` (from `@telnyx/react-client`) which establishes a WebSocket to Telnyx for SIP signaling + WebRTC for media. Native uses `NativeVoipProvider` which is a no-op context — VoIP is handled entirely by platform-native Kotlin/Swift code.

### Why Both Exist

On native platforms, the Telnyx Android/iOS SDK runs outside the WebView (in Kotlin/Swift). If `TelnyxRTCProvider` were also rendered, it would attempt to open a second WebSocket connection to Telnyx with the same SIP credentials, causing registration conflicts. `NativeVoipProvider` exists to:

1. Prevent the `@telnyx/react-client` WebSocket from being created on native
2. Provide a context placeholder so components can conditionally check which provider is active

---

## 3. TelnyxRTCProvider — Web VoIP Client

### Initialization
**File:** `resources/js/layouts/app-layout.tsx:137-139`

`TelnyxRTCProvider` is initialized with a `login_token` (JWT):

```typescript
<TelnyxRTCProvider credential={{ login_token: webLoginToken }}>
```

The `webLoginToken` is obtained from `useWebVoipCredentials` (per-device JWT) or falls back to a legacy per-user JWT cached in session storage.

### What TelnyxRTCProvider Does (from @telnyx/react-client)

1. Creates a TelnyxRTC WebSocket client connected to Telnyx's SIP gateway
2. Handles SIP REGISTER to authenticate the browser as a SIP endpoint
3. Exposes hooks: `useNotification()` for incoming call notifications, `useCallbacks()` for connection events
4. Manages WebRTC peer connections for media (audio)

### Audio Element Setup
**File:** `resources/js/layouts/app-layout.tsx:149-161`

`WebAppOverlays` renders a hidden `<Audio>` component from `@telnyx/react-client`:

```typescript
<Audio id={REMOTE_AUDIO_ELEMENT_ID} stream={activeCall && activeCall.remoteStream} />
```

The `REMOTE_AUDIO_ELEMENT_ID` is `'dialpad-remote-audio'` (defined in `context.tsx:490`). This HTML audio element plays the remote party's audio stream. The Telnyx client is also configured to use this element:

```typescript
// context.tsx:782-785
client.remoteElement = REMOTE_AUDIO_ELEMENT_ID;
```

### Connection State Callbacks
**File:** `resources/js/components/.../dialpad/context.tsx:787-790`

```typescript
useSafeCallbacks({
    onReady: () => setIsSocketError(false),
    onSocketError: () => setIsSocketError(true),
});
```

The `useSafeCallbacks` wrapper (`context.tsx:539-543`) passes callbacks only on web; on native it passes empty callbacks to avoid errors since TelnyxRTCContext won't exist.

---

## 4. NativeVoipProvider — Mobile Lightweight Context

**File:** `resources/js/providers/native-voip-provider.tsx:1-39`

A minimal React context with a single value `{ isNativeProvider: true }`:

```typescript
export function NativeVoipProvider({ children }: PropsWithChildren) {
    return (
        <NativeVoipContext.Provider value={{ isNativeProvider: true }}>
            {children}
        </NativeVoipContext.Provider>
    );
}
```

**No WebSocket connections.** No SIP registration. No WebRTC. This provider exists solely as a structural placeholder. The native VoIP layer (Kotlin `TelnyxVoipPlugin`/Swift `Z360VoIPService`) operates outside the WebView entirely.

The `useIsNativeVoipProvider()` hook (`native-voip-provider.tsx:181-183`) returns `true` when inside this provider, but it is not currently used in any consumer components — platform detection happens via `isNativeMobile()` instead.

---

## 5. Credential Management — Web Device Registration

### Per-Device Browser Credentials
**File:** `resources/js/hooks/useWebVoipCredentials.ts:1-170`

Each web browser instance registers as a "device" with the backend, receiving per-device SIP credentials that enable simultaneous ring across multiple devices (web browser + phones).

**Flow:**

1. Generate or retrieve a persistent browser device ID (`web_${crypto.randomUUID()}`) stored in `localStorage` under key `z360_browser_device_id` (line 10-20)
2. POST to `/api/device-tokens` with:
   - `device_id`: browser UUID
   - `fcm_token`: `web_${browserDeviceId}` (placeholder — web doesn't use FCM)
   - `platform`: `'web'`
   - `device_name`: browser name string
3. Backend returns SIP credentials including a JWT token
4. JWT token is passed to `TelnyxRTCProvider` as `login_token`

**Registration triggers** (line 137-158):
- When `userId` or `organizationId` changes (login, org switch)
- Skips if already registered for the same user/org combo (dedup via refs)
- On logout (`userId`/`organizationId` become null): fires `DELETE /api/device-tokens/{deviceId}` as best-effort cleanup

### Fallback JWT (Legacy Mode)
**File:** `resources/js/layouts/app-layout.tsx:55-66`

If per-device registration fails, the system falls back to a per-user JWT from the server:

```typescript
const fallbackJwt = useSessionCache<string>({
    key: 'cpaas.telnyx.jwt.' + (activeOrganization?.id ?? 'undefined'),
    value: cpaas?.telnyx?.jwt,
    ttl: 30 * 60 * 1000,  // 30 minutes
    refresh: () => {
        router.reload({ only: ['cpaas.telnyx.jwt'], showProgress: false });
    },
});
```

The `useSessionCache` hook (file: `resources/js/hooks/useSessionCache.ts:1-74`) stores the JWT in `sessionStorage` with a 30-minute TTL, auto-refreshing via Inertia partial reload when expired.

### Token Priority
**File:** `resources/js/hooks/useWebVoipCredentials.ts:161`

```typescript
const loginToken = (isWeb() ? credentials.jwtToken : null) || fallbackJwt || 'undefined';
```

Priority: per-device JWT > fallback per-user JWT > string `'undefined'` (which will fail auth).

---

## 6. Dialpad Components and Call UI

### Desktop Dialpad
**File:** `resources/js/components/identifier-details-sidebar/index.tsx`

The dialpad is embedded as a tab in the `IdentifierDetailsSidebar` (the right-hand panel on inbox/contacts pages), alongside "Details" and "Ask Z" tabs:

```typescript
<TabsTrigger value="dialpad">Dialpad</TabsTrigger>
...
<TabsContent value="dialpad"><Dialpad /></TabsContent>
```

### Dialpad Composition
**File:** `resources/js/components/.../dialpad/dialpad.tsx:1-33`

```
┌──────────────────────────┐
│     CallAsSelect         │  ← Caller ID number picker
├──────────────────────────┤
│     ToInput              │  ← Phone number / search input
├──────────────────────────┤
│     Suggestions          │  ← Contact suggestions (lazy-loaded)
├──────────────────────────┤
│     Dialer               │  ← Numpad or call-in-progress UI
└──────────────────────────┘
```

If no `callAsOptions` are available (no phone numbers configured), shows a "No phone numbers available" empty state.

### CallAsSelect
**File:** `resources/js/components/.../dialpad/components/call-as-select.tsx:1-26`

Dropdown of organization phone numbers the user can "call as" (caller ID). Uses `callAsPhoneNumbers` from Inertia page props, formatted with alias and number.

### ToInput — Dual Mode
**File:** `resources/js/components/.../dialpad/components/to-input.tsx:1-63`

Two input modes:
- **Number mode** (`mode === 'number'`): `<PhoneInput>` component with `+1` prefix
- **Text mode** (`mode === 'text'`): Standard `<Input>` for contact name search

A toggle button (RefreshCcw icon) switches between modes (line 40-46). In text mode on native, it programmatically shows the native keyboard (`Keyboard.show()`).

**Search behavior:** On text change, fires a debounced Inertia partial reload to fetch `lazy.identifiers` matching the search (line 416-427).

### Suggestions
**File:** `resources/js/components/.../dialpad/components/suggestions.tsx:1-65`

Lazy-loaded list of phone identifiers with contact info. Each suggestion has a green phone button that calls `placeCall(identifier.value, null, displayName, avatarUrl)`.

Uses `WhenVisible` from Inertia for deferred data loading and `useInertiaLazyCache` for caching.

### Dialer — Three States
**File:** `resources/js/components/.../dialpad/components/dialer.tsx:70-94`

The `Dialer` component renders one of three states:

1. **Socket Error** (`isSocketError`): Connection failed message (line 73-85)
2. **Incoming Call** (`call.status === 'ringing'`): `<IncomingCall />` with accept/reject buttons (line 281-327)
3. **Active Call** (`call` exists, non-ringing): `<OnCall />` with mute, settings, dialpad, hangup (line 150-279)
4. **No Call**: `<DialPad />` numpad grid (line 100-133)

### OnCall UI Features
- Avatar + contact name display
- Mute/unmute toggle
- Audio input device picker (microphone dropdown)
- Audio output device picker (speaker dropdown)
- In-call DTMF dialpad toggle
- Hang up button
- Elapsed time display

### UniversalCallDisplay — Persistent Sidebar Widget
**File:** `resources/js/components/.../dialpad/components/call-display.tsx:1-15`

Compact call display shown in the app sidebar footer (when NOT on inbox/contacts pages):

```typescript
const showCallDisplay = !url.startsWith('/inbox') && !url.startsWith('/contacts');
// In SidebarFooter:
{showCallDisplay && <UniversalCallDisplay />}
```

This ensures users see an active/incoming call even when navigating away from the inbox.

### Mobile Dialpad
**File:** `resources/js/mobile/pages/inbox/components/mobile-dialpad.tsx:1-65`

Similar to desktop but with:
- Toggle button to show/hide numpad
- Auto-hides numpad in text search mode
- Wrapped in a `MobileDialpadDrawer` (bottom sheet)

---

## 7. Web Outbound Call Flow

**Sequence (web browser):**

1. User selects caller ID in `CallAsSelect`, enters number in `ToInput`
2. User taps green phone button in `DialPad` grid
3. `placeCall()` is called (`context.tsx:879-976`)
4. Validates destination and caller ID number from `callAsPhoneNumbers` prop
5. **Web path** (`!useNativeVoip`, line 960-973):
   ```typescript
   client.newCall({
       destinationNumber: sanitizedDest,        // without leading '+'
       callerNumber: effectiveCallerNumber,      // org phone number
       clientState: btoa(JSON.stringify({ user_id: auth.user.id })),
       micId: selectedAudioInputDeviceId,
       speakerId: selectedAudioOutputDeviceId,
       remoteElement: REMOTE_AUDIO_ELEMENT_ID,
   });
   ```
6. TelnyxRTC client sends SIP INVITE via WebSocket
7. Telnyx SIP gateway routes the call
8. Call state updates arrive via SDK events → `useNotification()` hook → `activeCall` changes
9. `DialpadProvider` derives `call` state from `activeCall` (line 722-729)
10. UI transitions: DialPad → OnCall (showing "In Progress..." then elapsed time)

**Native path** (line 914-958): Checks `TelnyxVoip.isConnected()`, then calls `TelnyxVoip.makeCall()` via Capacitor bridge. If the call destination has no pre-loaded display info, triggers lazy identifier lookup.

---

## 8. Web Inbound Call Flow

**Sequence (web browser):**

1. Remote party calls the org's Telnyx number
2. Telnyx routes to all registered SIP endpoints (simultaneous ring)
3. `TelnyxRTCProvider`'s WebSocket receives SIP INVITE
4. `useNotification()` hook fires with `notification.call` containing the incoming call
5. `DialpadProvider` reads `activeCall` from notification (`context.tsx:673`):
   ```typescript
   const activeCall = notification && notification.call && notification.call.state !== 'destroy' ? notification.call : null;
   ```
6. Derives `call.status = activeCall.state` (will be `'ringing'`)
7. Lazy-loads caller identifier from backend (`context.tsx:733-743`):
   ```typescript
   router.reload({
       only: ['lazy.call.identifier'],
       data: { number: '+' + remoteCallerNumber },
       preserveUrl: true,
   });
   ```
8. UI shows `<IncomingCall />` with caller info, accept (green) and reject (red) buttons

**Answer:** `answer()` callback → `activeCall.answer()` (line 1008-1013)
**Reject:** `hangUp()` callback → `activeCall.hangup()` (line 989-994)

---

## 9. Call State Management

### Web Call State
**File:** `resources/js/components/.../dialpad/context.tsx:711-730`

The `call` state is a `useMemo` that derives from either native or web source:

```typescript
const call = useMemo(() => {
    // Native mobile: use nativeCallState from event listeners
    if (useNativeVoip && nativeCallState) {
        return {
            identifier: callIdentifier,
            status: nativeCallState.status,
            isMuted: nativeCallState.isMuted,
            elapsedTime: formatDuration(nativeCallState.elapsedSeconds),
        };
    }
    // Web: use Telnyx SDK notification state
    return activeCall ? {
        identifier: callIdentifier,
        status: activeCall?.state ?? 'unknown',
        isMuted,
        elapsedTime,
    } : null;
}, [...]);
```

### Call Status Values

| Source | Status | Meaning |
|--------|--------|---------|
| Web SDK | `'ringing'` | Incoming call ringing |
| Web SDK | `'requesting'` | Outgoing call being set up |
| Web SDK | `'active'` | Call connected |
| Web SDK | `'destroy'` | Call ended (filtered out as `null`) |
| Native | `'new'` / `'connecting'` / `'ringing'` / `'active'` / `'held'` / `'done'` | Native state machine |

### Elapsed Time — Two Implementations

**Web:** Uses `useCountdown` hook (`resources/js/hooks/useCountdown.ts:1-47`) — a `setInterval`-based timer that starts when `activeCall?.state === 'active'` and formats as `MM:SS`.

**Native:** The native layer sends `callDurationUpdated` events with `elapsedSeconds`, formatted by `formatDuration()` (`context.tsx:700-708`).

### Identifier Resolution

For both web and native, when a call's remote number is known, the UI lazy-loads the identifier (contact info) from the backend via Inertia partial reload:

```typescript
router.reload({
    only: ['lazy.call.identifier'],
    data: { number: normalizedNumber },
});
```

This resolves the phone number to a contact name, avatar, and formatted phone number.

---

## 10. Push Notification Handling

**File:** `resources/js/hooks/use-push-notifications.ts:1-206`

This hook handles **non-VoIP** push notifications (messages, reminders, mentions, etc.) on native platforms. **VoIP push notifications (PushKit on iOS, FCM high-priority on Android) are handled entirely by the native layer** — they never reach the WebView.

### Module-Level Listeners (Before React Mounts)
**File:** `resources/js/hooks/use-push-notifications.ts:200-248`

Listeners are registered at module load time to handle cold-start scenarios:

```typescript
if (Capacitor.isNativePlatform()) {
    // iOS: Listen for FCM token from native AppDelegate
    if (Capacitor.getPlatform() === 'ios') {
        window.addEventListener('iosFCMToken', ...);
    }
    // Background/killed: tap on Firebase notification
    PushNotifications.addListener('pushNotificationActionPerformed', ...);
    // Local notification tap
    LocalNotifications.addListener('localNotificationActionPerformed', ...);
}
```

### Token Registration

**Android:** On `PushNotifications.register()` → `registration` event fires with FCM token → `registerTokenWithBackend()` sends to `/device-tokens.store` route (line 2304-2318).

**iOS:** FCM token comes from native `AppDelegate` via `window.dispatchEvent(new CustomEvent('iosFCMToken', ...))` → registered with backend (line 2225-2237).

**Token deduplication:** Stored in `localStorage` (`z360_fcm_token`). Only re-sent if changed or if 24+ hours since last send (line 2231-2235).

### Foreground Notification Display

When a push arrives while the app is in foreground (line 2327-2345):
1. Re-schedules it as a `LocalNotification` (because Capacitor's push plugin creates untappable notifications on Android)
2. Fires `router.reload({ only: ['unreadNotificationsCount'] })` to update badge

### Deep Linking

Notification tap → reads `data.link` → calls `visitDeepLink()` which uses `router.visit(link)`. Handles cold-start via queued `router.on('navigate')` listener.

---

## 11. Multi-Tab Behavior

### Current Behavior

**All browser tabs share the same SIP credentials** because `useWebVoipCredentials` generates one `browserDeviceId` per browser (stored in `localStorage`), and subsequent tabs reuse it. However:

1. **Each tab creates its own TelnyxRTC WebSocket connection** — `TelnyxRTCProvider` instantiates a client per render tree
2. **All tabs register with the same SIP credentials** (same JWT from same device token)
3. **All tabs will ring on incoming calls** — Telnyx delivers SIP INVITE to all WebSocket connections registered with the same credentials
4. **Answering in one tab does NOT dismiss other tabs** — There's no built-in tab-to-tab communication

### call_ended Broadcast as Cross-Tab Dismissal
**File:** `resources/js/components/.../dialpad/context.tsx:675-694`

The `call_ended` Reverb broadcast partially addresses this:

```typescript
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);
useEcho<{ call_session_id: string; reason: string }>(callEndedChannel, '.call_ended', (payload) => {
    if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
        try { activeCall.hangup(); } catch (e) { ... }
    }
});
```

When a call is answered on any device/tab, the backend broadcasts `call_ended` on the user's private Reverb channel. This causes other tabs to hang up the ringing call.

**Limitation:** This relies on the backend emitting the broadcast, which happens asynchronously. There may be a brief window where multiple tabs show the ringing UI.

### Registration Deduplication
**File:** `resources/js/hooks/useWebVoipCredentials.ts:80-85`

```typescript
const registrationKey = `${userId}_${organizationId}`;
if (hasRegisteredRef.current && registrationKeyRef.current === registrationKey) {
    return; // Skip if already registered
}
```

This dedup is per React instance (ref-based), so each tab will independently register. The backend likely handles this gracefully since the device_id is the same.

### Session Cache Per-Tab
**File:** `resources/js/hooks/useSessionCache.ts`

JWT tokens are cached in `sessionStorage`, which is per-tab. Each tab has its own cached JWT that may expire at different times.

---

## 12. Simultaneous Ring — call_ended Broadcast

### Mechanism
**File:** `resources/js/components/.../dialpad/context.tsx:675-694`

The web client subscribes to a tenant-scoped private Reverb channel:

```typescript
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);
// Resolves to: `org.{orgId}.App.Models.User.{userId}`
```

The `.call_ended` event carries `{ call_session_id, reason }`. When received:

1. Checks if there's an active ringing/requesting call
2. If so, calls `activeCall.hangup()` to dismiss the SIP session
3. If on native, clears `nativeCallState` to null

**This is the web-side dismissal mechanism for simultaneous ring.** When another device answers, the backend sends this event so other devices stop ringing.

**Noted in code comment (line 675-678):**
> "This is a fallback for web — the TelnyxRTC SDK handles SIP CANCEL natively, but this covers edge cases where the CANCEL doesn't arrive."

---

## 13. Audio Device Management

### Device Enumeration
**File:** `resources/js/components/.../dialpad/context.tsx:792-825`

On web only (`!useNativeVoip`), the client enumerates audio devices:

```typescript
const [inputs, outputs] = await Promise.all([
    client.getAudioInDevices(),
    client.getAudioOutDevices()
]);
```

Listens for `navigator.mediaDevices.devicechange` events to auto-refresh (line 814-820).

### Device Selection
**Input device** (line 841-855): Sets via `client.setAudioSettings({ micId })` and `activeCall.setAudioInDevice()`.

**Output device** (line 857-877): Sets via `client.speaker`, `activeCall.setAudioOutDevice()`, and `audioElement.setSinkId()` (Web Audio API for routing output to specific speaker).

### Output Device Sink
**File:** `resources/js/components/.../dialpad/context.tsx:827-839`

Uses `HTMLMediaElement.setSinkId()` to route audio to selected output device:

```typescript
const audioElement = document.getElementById(REMOTE_AUDIO_ELEMENT_ID) as (HTMLMediaElement & { setSinkId?: ... });
await audioElement.setSinkId(deviceId);
```

**Note:** `setSinkId` is not universally supported (Firefox only supports it behind a flag). This may silently fail.

---

## 14. VoIP Logger

**File:** `resources/js/lib/voip-logger.ts:1-57`

Structured console logger with format: `[VoIP][{callSessionId}][{Component}] Message`

- Supports log levels: debug, info, warn, error
- Call session ID truncated to 8 chars
- Filterable in browser console by `[VoIP]`

Currently used only by `use-telnyx-voip.ts` (native VoIP hook). The `DialpadProvider` uses raw `console.debug` instead — an inconsistency.

---

## 15. Fragile Areas and Inconsistencies

### Critical Issues

1. **Multi-tab SIP registration conflict**: All tabs register with the same SIP credentials via separate WebSocket connections. Telnyx may handle this (multiple registrations from same credential), but this is undocumented behavior. If Telnyx deregisters previous connections on new registration, the first tab would silently lose its VoIP capability.

2. **No web push for incoming calls**: The web client relies entirely on the persistent WebSocket connection to receive incoming calls. If the browser tab is in the background and the browser throttles WebSocket, calls may be missed. There is no Web Push API (Service Worker) fallback for call notifications.

3. **`'undefined'` string as JWT fallback** (`useWebVoipCredentials.ts:161`): If both device registration and fallback JWT fail, `loginToken` becomes the string `'undefined'`, which will cause TelnyxRTCProvider to attempt authentication with an invalid token, leading to a silent socket error rather than a clear user-facing message.

### Inconsistencies

4. **Dual logging patterns**: `use-telnyx-voip.ts` uses the structured `voipLogger`, while `context.tsx` uses raw `console.debug('[DialpadContext] ...')`. Should be unified.

5. **Duplicate number normalization**: Both `context.tsx` (line 745-757) and `use-telnyx-voip.ts` (line 1736-1748) define identical `normalizeNumber` and `numbersMatch` helper functions. Should be extracted to a shared utility.

6. **Duplicate pending call display logic**: Both `context.tsx` (line 759-776) and `use-telnyx-voip.ts` (line 1888-1907) implement identical `pendingCallDisplay` → `setCallDisplayInfo` patterns for resolving caller info on native. The `use-telnyx-voip.ts` version appears to be the older pattern, while `context.tsx` is the newer integrated version.

7. **`useSafeNotification` always calls `useNotification`** (`context.tsx:528-534`): Despite the comment saying "On native platforms, TelnyxRTCContext won't exist", the hook unconditionally calls `useNotification()` and then returns `null` if native. If `useNotification` throws when no provider exists, this would crash. It works only because `NativeVoipProvider` doesn't interfere with React context lookups (the Telnyx context just returns `undefined`).

8. **`showCallDisplay` heuristic** (`app-sidebar.tsx:40`): The `UniversalCallDisplay` is hidden on `/inbox` and `/contacts` pages because those pages have their own dialpad. This URL-based check is fragile — new pages with their own dialpad would need manual exclusion.

### Architecture Concerns

9. **Web credential flow uses fetch() directly** (`useWebVoipCredentials.ts:93-106`) rather than Inertia's router. This bypasses CSRF protection (relies on `credentials: 'include'` for session cookies) and doesn't benefit from Inertia's error handling.

10. **Session cache TTL mismatch**: The fallback JWT is cached for 30 minutes (`app-layout.tsx:59`), but the per-device JWT from registration has no explicit TTL/refresh mechanism. If the JWT expires, there's no auto-refresh for the device credential path.

11. **No explicit call quality monitoring on web**: The `TelnyxVoipPlugin` interface defines a `callQuality` event (line 1652-1660) with MOS/jitter/RTT metrics, but this is only available on native. The web client has no equivalent quality monitoring or degradation handling.

12. **Audio element hardcoded ID**: `REMOTE_AUDIO_ELEMENT_ID = 'dialpad-remote-audio'` is a global DOM element ID. If two instances of `DialpadProvider` existed (they shouldn't, but...), they'd conflict on this ID.
