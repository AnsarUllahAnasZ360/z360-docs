---
title: Inbound Call Web Flow
---

# Web Inbound Call Flow — Complete Trace

![Web Inbound Call Flow](/diagrams/web-inbound-call-flow.jpeg)

**Document**: Inbound Call Web Flow
**Author**: Teammate D (web-tracer)
**Date**: 2026-02-08
**Task**: Session 09, Task #4

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Web Ringing Flow](#2-web-ringing-flow)
3. [Web Answer Flow](#3-web-answer-flow)
4. [Web Hangup Flow](#4-web-hangup-flow)
5. [Mobile WebView Isolation](#5-mobile-webview-isolation)
6. [Outbound Web Call Flow](#6-outbound-web-call-flow)
7. [Architecture Summary](#7-architecture-summary)
8. [Critical Findings](#8-critical-findings)

---

## 1. Executive Summary

The Z360 web client implements VoIP via the **`@telnyx/react-client`** WebRTC SDK, which establishes a persistent WebSocket to Telnyx for SIP signaling. Unlike native mobile (which requires push notifications to wake the app), the web client receives incoming calls **directly via SIP INVITE over the WebSocket** — no Reverb broadcast listener is required for the incoming call itself.

**Key architectural insight**: The backend broadcasts an `IncomingCallNotification` event via Reverb (`.incoming_call`), but **the web client does NOT listen for it**. The web client relies entirely on the TelnyxRTC WebSocket for incoming call detection. The Reverb broadcast is intended for future use or for native mobile metadata synchronization.

**Simultaneous ring dismissal**: The web client DOES listen for `call_ended` broadcasts on Reverb to dismiss ringing calls when another device answers.

---

## 2. Web Ringing Flow

### 2.1 Architecture Overview

When an inbound call arrives for a user with web sessions active:

```
PSTN Caller
  │
  ▼
Telnyx Platform (receives call on org's phone number)
  │
  ├──→ Sends SIP INVITE to all registered endpoints (simultaneous ring)
  │    │
  │    ├──→ Web browser (TelnyxRTC WebSocket)  ← THIS PATH
  │    ├──→ Android native (Telnyx Android SDK)
  │    └──→ iOS native (Telnyx iOS SDK)
  │
  └──→ Webhook to Laravel backend (call.initiated)
       └──→ Broadcasts IncomingCallNotification to Reverb (NOT USED BY WEB)
```

### 2.2 Step-by-Step Web Ringing

#### Step 1: TelnyxRTC WebSocket Receives SIP INVITE

**File**: `resources/js/layouts/app-layout.tsx:136-139`

The `TelnyxRTCProvider` is initialized with a JWT credential:

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

- `webLoginToken` comes from per-device SIP credentials (see [Credential Management](#credential-management) below)
- `TelnyxRTCProvider` creates a WebSocket to Telnyx SIP gateway
- Registers the browser as a SIP endpoint
- When an inbound call arrives, Telnyx sends SIP INVITE via this WebSocket

#### Step 2: React Hook Receives Notification

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:205-206`

```typescript
const notification = useSafeNotification();
const activeCall = notification && notification.call && notification.call.state !== 'destroy'
    ? notification.call
    : null;
```

- `useSafeNotification()` wraps `useNotification()` from `@telnyx/react-client`
- `useNotification()` returns a notification object when SIP INVITE arrives
- `notification.call` contains the incoming call object
- `activeCall.state` will be `'ringing'` for incoming calls

#### Step 3: Call State Derivation

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:244-263`

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
    return activeCall
        ? {
              identifier: callIdentifier,
              status: activeCall?.state ?? 'unknown',
              isMuted,
              elapsedTime,
          }
        : null;
}, [useNativeVoip, nativeCallState, activeCall, callIdentifier, isMuted, elapsedTime, formatDuration]);
```

- On web (`!useNativeVoip`), `call.status` = `activeCall.state` = `'ringing'`
- `callIdentifier` is lazy-loaded (see Step 4)

#### Step 4: Lazy Identifier Lookup

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:265-276`

```typescript
useEffect(() => {
    if (useNativeVoip) return; // Native handles this differently
    const remoteNumber: string | undefined = activeCall?.options?.remoteCallerNumber;
    if (!remoteNumber) return;
    router.reload({
        only: ['lazy.call.identifier'],
        data: { number: '+' + remoteNumber },
        preserveUrl: true,
        showProgress: false,
    });
}, [activeCall?.options?.remoteCallerNumber, useNativeVoip]);
```

- When `activeCall` has a `remoteCallerNumber`, triggers Inertia partial reload
- Sends `{ number: '+1234567890' }` to backend
- Backend resolves phone number to contact/identifier info
- Returns as `lazy.call.identifier` prop
- `callIdentifier` state updates via `useInertiaLazyCache('lazy.call.identifier')`

**Backend resolution** (inferred from data flow):
- Laravel controller receives `number` parameter
- Queries `identifiers` table / `contacts` table via normalized phone matching
- Returns: `{ value, formatted_value, contact: { full_name, avatar_path } }`

#### Step 5: UI Renders Incoming Call

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:16-39`

```typescript
export default function Dialer() {
    const { call, isSocketError } = useDialpad();

    if (isSocketError) {
        return <ConnectionFailedUI />;
    }

    const statusSpecificComponent = { ringing: <IncomingCall /> } as const;

    return (
        <div className="...">
            {call ? statusSpecificComponent[call.status as keyof typeof statusSpecificComponent] || <OnCall /> : <DialPad />}
        </div>
    );
}
```

- When `call.status === 'ringing'`, renders `<IncomingCall />`

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:228-274`

```typescript
export function IncomingCall({ compact = false }: CallDisplayProps) {
    const { call, hangUp, answer } = useDialpad();
    if (!call) return null;

    const identifier = call.identifier;

    return (
        <div className="...">
            <Avatar>
                <AvatarImage src={storage(identifier?.contact?.avatar_path)} />
                <AvatarFallback>
                    {getInitials(identifier?.contact?.full_name ?? '') || <User />}
                </AvatarFallback>
            </Avatar>
            <AvatarName>
                {identifier?.contact?.full_name ?? identifier?.formatted_value ?? '...'}
            </AvatarName>
            {Boolean(identifier?.contact) && (
                <div>{identifier?.formatted_value}</div>
            )}
            <div>Incoming</div>
            <Button onClick={hangUp}>
                <X /> {/* Red X button */}
            </Button>
            <Button onClick={answer}>
                <Phone /> {/* Green phone button */}
            </Button>
        </div>
    );
}
```

**Displayed data**:
- **Avatar**: `identifier.contact.avatar_path` or initials fallback
- **Name**: `identifier.contact.full_name` or `identifier.formatted_value` (phone number) or "..." (while loading)
- **Phone**: `identifier.formatted_value` (formatted phone like "+1 (555) 123-4567")
- **Status**: Static text "Incoming"
- **Actions**: Red reject (X) button calls `hangUp()`, green answer (phone) button calls `answer()`

### 2.3 Reverb Broadcast (NOT USED for Ringing on Web)

**File**: `app/Events/IncomingCallNotification.php:1-57`

The backend broadcasts this event:

```php
class IncomingCallNotification implements ShouldBroadcast
{
    public function __construct(
        public User $user,
        public string $callSessionId,
        public string $callControlId,
        public string $callerNumber,
        public string $callerName,
        public string $channelNumber,
        public ?int $organizationId = null,
        public ?string $organizationName = null,
    ) {}

    public function broadcastOn(): array {
        return [
            new TenantPrivateChannel("App.Models.User.{$this->user->id}", $this->organizationId),
        ];
    }

    public function broadcastAs(): string {
        return 'incoming_call';
    }

    public function broadcastWith(): array {
        return [
            'call_session_id' => $this->callSessionId,
            'call_control_id' => $this->callControlId,
            'caller_number' => $this->callerNumber,
            'caller_name' => $this->callerName,
            'channel_number' => $this->channelNumber,
            'organization_id' => $this->organizationId,
            'organization_name' => $this->organizationName,
        ];
    }
}
```

**Channel**: `org.{orgId}.App.Models.User.{userId}`
**Event**: `.incoming_call`
**Payload**:
```json
{
  "call_session_id": "...",
  "call_control_id": "...",
  "caller_number": "+15551234567",
  "caller_name": "John Doe",
  "channel_number": "+15559876543",
  "organization_id": 123,
  "organization_name": "Acme Corp"
}
```

**Web client DOES NOT listen for this event.** No `useEcho()` listener found in frontend code for `.incoming_call`.

**Why this exists**: Likely for:
1. Future desktop notifications or browser tab title updates
2. Native mobile metadata synchronization (though native uses push, not Reverb)
3. Cross-device coordination beyond SIP (not currently implemented)

---

## 3. Web Answer Flow

### 3.1 User Clicks Answer Button

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:268-270`

```typescript
<Button onClick={answer} disabled={!call}>
    <Phone className={iconSize} />
</Button>
```

### 3.2 Answer Callback Executes

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:530-547`

```typescript
const answer = useCallback(() => {
    // Route through native plugin on mobile, WebRTC client on web
    if (useNativeVoip) {
        TelnyxVoip.answerCall()
            .then(() => {
                console.debug('[DialpadContext] Native answerCall successful');
            })
            .catch((e) => {
                console.debug('[DialpadContext] Native answerCall failed:', e);
            });
    } else {
        try {
            if (activeCall) activeCall.answer();
        } catch (e) {
            console.debug('answer failed', e);
        }
    }
}, [activeCall, useNativeVoip]);
```

**Web path**: `activeCall.answer()`
- `activeCall` is the Telnyx SDK call object from `useNotification()`
- `answer()` sends SIP 200 OK via WebSocket
- Telnyx bridges the call

### 3.3 Audio Stream Established

**File**: `resources/js/layouts/app-layout.tsx:156`

```typescript
<Audio id={REMOTE_AUDIO_ELEMENT_ID} stream={activeCall && activeCall.remoteStream} />
```

- `REMOTE_AUDIO_ELEMENT_ID` = `'dialpad-remote-audio'`
- `<Audio>` component from `@telnyx/react-client` renders an HTML `<audio>` element
- `activeCall.remoteStream` is a WebRTC `MediaStream` object
- Audio plays through the `<audio>` element
- Output device can be changed via `audioElement.setSinkId()` (see [Audio Device Management](#audio-device-management))

### 3.4 Call State Transitions to Active

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:255-262`

- `activeCall.state` changes from `'ringing'` to `'active'`
- `call.status` updates to `'active'`
- `elapsedTime` timer starts via `useCountdown(Boolean(activeCall?.state === 'active'))`

**File**: `resources/js/hooks/useCountdown.ts:1-47`

```typescript
export default function useCountdown(isRunning: boolean) {
    const [elapsedTime, setElapsedTime] = useState<string>('00:00');

    useEffect(() => {
        if (!isRunning) {
            setElapsedTime('00:00');
            return;
        }

        let seconds = 0;
        const interval = setInterval(() => {
            seconds++;
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            setElapsedTime(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
        }, 1000);

        return () => clearInterval(interval);
    }, [isRunning]);

    return elapsedTime;
}
```

### 3.5 UI Switches to OnCall

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:36-38`

```typescript
{call ? statusSpecificComponent[call.status as keyof typeof statusSpecificComponent] || <OnCall /> : <DialPad />}
```

- `call.status === 'active'` doesn't match `{ ringing: <IncomingCall /> }`, so renders default `<OnCall />`

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:96-226`

```typescript
export function OnCall({ compact = false }: CallDisplayProps) {
    const {
        call,
        hangUp,
        toggleMute,
        sendDTMF,
        audioInputDevices,
        audioOutputDevices,
        selectedAudioInputDeviceId,
        selectedAudioOutputDeviceId,
        setAudioInputDevice,
        setAudioOutputDevice,
    } = useDialpad();

    const [showDialpad, setShowDialpad] = useState(false);

    return (
        <div>
            {/* Avatar + Name + Elapsed Time */}
            <Avatar>
                <AvatarImage src={storage(call?.identifier?.contact?.avatar_path)} />
                <AvatarFallback>...</AvatarFallback>
            </Avatar>
            <AvatarName>{call?.identifier?.contact?.full_name ?? '...'}</AvatarName>
            <div>{call?.elapsedTime ?? 'In Progress...'}</div>

            {/* Controls */}
            <Button onClick={toggleMute} title={call?.isMuted ? 'Unmute' : 'Mute'}>
                {call?.isMuted ? <MicOff /> : <Mic />}
            </Button>

            <DropdownMenu>
                <DropdownMenuTrigger>
                    <Settings /> {/* Microphone picker */}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    <DropdownMenuRadioGroup value={selectedAudioInputDeviceId} onValueChange={setAudioInputDevice}>
                        {audioInputDevices.map(device => (
                            <DropdownMenuRadioItem key={device.deviceId} value={device.deviceId}>
                                {device.label || 'Unknown microphone'}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
                <DropdownMenuTrigger>
                    <Volume2 /> {/* Speaker picker */}
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                    <DropdownMenuRadioGroup value={selectedAudioOutputDeviceId} onValueChange={setAudioOutputDevice}>
                        {audioOutputDevices.map(device => (
                            <DropdownMenuRadioItem key={device.deviceId} value={device.deviceId}>
                                {device.label || 'Unknown speaker'}
                            </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                </DropdownMenuContent>
            </DropdownMenu>

            <Button onClick={() => setShowDialpad(!showDialpad)} title="Dialpad">
                <Grid3x3 /> {/* In-call DTMF dialpad toggle */}
            </Button>

            <Button onClick={hangUp} title="Hang up">
                <X />
            </Button>

            {showDialpad && <CompactDialPad />}
        </div>
    );
}
```

**In-call controls**:
- **Mute/Unmute**: Toggles `activeCall.muteAudio()` / `activeCall.unmuteAudio()`
- **Microphone dropdown**: Selects input device via `client.setAudioSettings({ micId })` and `activeCall.setAudioInDevice()`
- **Speaker dropdown**: Selects output device via `client.speaker`, `activeCall.setAudioOutDevice()`, and `audioElement.setSinkId()`
- **DTMF dialpad**: Toggle button shows/hides in-call dialpad for sending DTMF tones via `activeCall.dtmf(digit)`
- **Hang up**: Calls `hangUp()` which calls `activeCall.hangup()`

---

## 4. Web Hangup Flow

### 4.1 User Clicks Hangup Button

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:214-216`

```typescript
<Button onClick={hangUp} title="Hang up">
    <X className={iconSize} />
</Button>
```

### 4.2 Hangup Callback Executes

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:511-528`

```typescript
const hangUp = useCallback(() => {
    // Route through native plugin on mobile, WebRTC client on web
    if (useNativeVoip) {
        TelnyxVoip.hangUp()
            .then(() => {
                console.debug('[DialpadContext] Native hangUp successful');
            })
            .catch((e) => {
                console.debug('[DialpadContext] Native hangUp failed:', e);
            });
    } else {
        try {
            if (activeCall) activeCall.hangup();
        } catch (e) {
            console.debug('hangUp failed', e);
        }
    }
}, [activeCall, useNativeVoip]);
```

**Web path**: `activeCall.hangup()`
- Sends SIP BYE via WebSocket
- Telnyx terminates the call
- `activeCall.state` changes to `'destroy'`
- `activeCall` becomes `null` (filtered by `activeCall.state !== 'destroy'` check)
- `call` state becomes `null`
- UI reverts to `<DialPad />`

### 4.3 Backend Webhook and Broadcast

**Backend flow** (inferred from architecture docs):

1. Telnyx sends `call.hangup` webhook to Laravel
2. Laravel controller processes hangup
3. Broadcasts `CallEndedNotification` to Reverb

**File**: `app/Events/CallEndedNotification.php` (inferred from pattern)

- **Channel**: `org.{orgId}.App.Models.User.{userId}`
- **Event**: `.call_ended`
- **Payload**: `{ call_session_id, reason }`

### 4.4 Web Client Receives call_ended Broadcast (Dismissal)

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:208-227`

```typescript
// Listen for call_ended broadcast from server (simultaneous ring: answered elsewhere)
// This is a fallback for web — the TelnyxRTC SDK handles SIP CANCEL natively,
// but this covers edge cases where the CANCEL doesn't arrive.
const callEndedChannel = useTenantChannel(`App.Models.User.${auth.user.id}`);
useEcho<{ call_session_id: string; reason: string }>(callEndedChannel, '.call_ended', (payload) => {
    if (!payload?.call_session_id) return;
    console.debug('[DialpadContext] Received call_ended broadcast:', payload);
    // If we have an active ringing call, hang it up so UI dismisses
    if (activeCall && (activeCall.state === 'ringing' || activeCall.state === 'requesting')) {
        try {
            activeCall.hangup();
        } catch (e) {
            console.debug('[DialpadContext] Failed to hangup from call_ended broadcast', e);
        }
    }
    // Also clear native state if applicable
    if (useNativeVoip) {
        setNativeCallState(null);
    }
});
```

**Purpose**: Dismisses ringing calls when another device answers (simultaneous ring coordination)

**Mechanism**:
- Listens on `org.{orgId}.App.Models.User.{userId}` private channel
- Event: `.call_ended`
- Payload: `{ call_session_id: string, reason: string }`
- If `activeCall.state === 'ringing'` or `'requesting'`, calls `activeCall.hangup()` to dismiss
- This is a **fallback** — the TelnyxRTC SDK handles SIP CANCEL natively, but Reverb ensures dismissal even if SIP CANCEL doesn't arrive

**Payload structure**:
```typescript
{
  call_session_id: "abc123",  // Backend call session ID
  reason: "answered_elsewhere" // or "hangup", "timeout", etc.
}
```

---

## 5. Mobile WebView Isolation

### 5.1 Problem Statement

When Z360 runs as a Capacitor app on iOS/Android:
- **Native layer** (Kotlin/Swift) handles VoIP via platform-native Telnyx SDKs
- **WebView layer** (React) must NOT also connect to Telnyx WebRTC
- If both layers connected with the same SIP credentials, would cause:
  - Duplicate SIP registrations
  - Registration conflicts (Telnyx may deregister previous connection)
  - Media stream routing confusion

### 5.2 Isolation Mechanism: NativeVoipProvider

**File**: `resources/js/providers/native-voip-provider.tsx:1-39`

```typescript
/**
 * Native VoIP Provider Context
 *
 * This is a lightweight provider for native mobile platforms (Android/iOS).
 * On native, VoIP is handled entirely by the native layer (Kotlin/Swift),
 * so we don't need TelnyxRTCProvider which creates WebSocket connections.
 *
 * This provider exists to:
 * 1. Prevent TelnyxRTCProvider from being loaded on native (avoids dual WebSocket)
 * 2. Provide a context placeholder for components that might conditionally check
 */

interface NativeVoipContextValue {
    isNativeProvider: true;
}

const NativeVoipContext = createContext<NativeVoipContextValue | null>(null);

export function NativeVoipProvider({ children }: PropsWithChildren) {
    return (
        <NativeVoipContext.Provider value={{ isNativeProvider: true }}>
            {children}
        </NativeVoipContext.Provider>
    );
}

export function useIsNativeVoipProvider(): boolean {
    const context = useContext(NativeVoipContext);
    return context?.isNativeProvider ?? false;
}
```

### 5.3 Platform Detection and Provider Switching

**File**: `resources/js/layouts/app-layout.tsx:134-146`

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

**Platform detection** (`resources/js/utils/platform.ts`):

```typescript
export function isWeb(): boolean {
    return !Capacitor.isNativePlatform();
}

export function isNativeMobile(): boolean {
    return isNativeAndroid() || isNativeIOS();
}
```

**Isolation guarantee**:
- On web: `TelnyxRTCProvider` creates WebSocket to Telnyx
- On native: `NativeVoipProvider` is a no-op context, NO WebSocket created
- Exactly one VoIP transport layer is active per platform

### 5.4 DialpadContext Platform Branching

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:78-82`

```typescript
export function DialpadProvider({ children }: { children: React.ReactNode }) {
    // Determine if we should use native VoIP plugin (Android/iOS) vs web WebRTC
    const useNativeVoip = isNativeMobile();

    // All subsequent logic branches on useNativeVoip
}
```

**Native-specific event listeners** (lines 104-200):
- `TelnyxVoip.addListener('callStarted', ...)` → sets `nativeCallState`
- `TelnyxVoip.addListener('callRinging', ...)`
- `TelnyxVoip.addListener('callAnswered', ...)`
- `TelnyxVoip.addListener('callEnded', ...)`
- `TelnyxVoip.addListener('callDurationUpdated', ...)`

**Web-specific hooks** (lines 204-227):
- `useSafeNotification()` returns `useNotification()` on web, `null` on native
- `useSafeCallbacks()` passes callbacks on web, empty object on native

**Call action branching**:

**placeCall** (lines 412-508):
```typescript
if (useNativeVoip) {
    TelnyxVoip.makeCall({ destinationNumber, callerIdNumber, displayName, avatarUrl });
} else {
    client.newCall({ destinationNumber, callerNumber, clientState, micId, speakerId, remoteElement });
}
```

**answer** (lines 530-547):
```typescript
if (useNativeVoip) {
    TelnyxVoip.answerCall();
} else {
    activeCall.answer();
}
```

**hangUp** (lines 511-528):
```typescript
if (useNativeVoip) {
    TelnyxVoip.hangUp();
} else {
    activeCall.hangup();
}
```

**toggleMute** (lines 549-575):
```typescript
if (useNativeVoip) {
    TelnyxVoip.setMute({ muted: newMuteState });
} else {
    activeCall.muteAudio() / activeCall.unmuteAudio();
}
```

### 5.5 Edge Cases and Failure Modes

#### Edge Case 1: Platform Detection Failure

If `Capacitor.isNativePlatform()` returns incorrect value:
- **False negative** (native detected as web): Would load `TelnyxRTCProvider` on native, causing dual WebSocket
- **False positive** (web detected as native): Would load `NativeVoipProvider` on web, no VoIP would work

**Mitigation**: Capacitor's platform detection is robust and used throughout the app. This is a low-probability failure.

#### Edge Case 2: WebView Accessing Native Credentials

**Current behavior**: WebView on native uses `NativeVoipProvider` (no-op), so it never requests web credentials. Per-device credential registration is gated by `isWeb()`.

**File**: `resources/js/hooks/useWebVoipCredentials.ts:161`

```typescript
const loginToken = (isWeb() ? credentials.jwtToken : null) || fallbackJwt || 'undefined';
```

On native, `loginToken` would be `fallbackJwt` (per-user JWT) or `'undefined'`. But since `TelnyxRTCProvider` is never rendered, this token is never used.

#### Edge Case 3: Multi-Tab Native WebView

**Not applicable**: Native apps don't support multiple WebView instances. Each app instance has exactly one WebView.

#### Edge Case 4: Capacitor Bridge Communication Failure

If the Capacitor bridge between WebView and native fails:
- `TelnyxVoip.makeCall()` would reject with error
- `placeCall()` callback has `.catch()` handler that shows toast: "Failed to start call"
- Native layer continues to function independently (can still receive calls via push)

---

## 6. Outbound Web Call Flow

### 6.1 User Initiates Call

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:46-78`

```typescript
function DialPad() {
    const { to, setTo, placeCall, callAsOptions, callAsId, mode } = useDialpad();
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const append = (ch: string) => setTo(to + ch);
    const canCall = mode === 'number' && Boolean(to) && Boolean(callAsOptions.find((o) => o.id === callAsId));

    return (
        <div className="grid grid-cols-3">
            {digits.map((d) => (
                <Button key={d} onClick={() => append(d)}>{d}</Button>
            ))}
            <Button onClick={() => placeCall()} disabled={!canCall}>
                <Phone />
            </Button>
            <Button onClick={() => append('0')}>0</Button>
            <Button onClick={backspace}>
                <X />
            </Button>
        </div>
    );
}
```

**User flow**:
1. User selects caller ID in `CallAsSelect` dropdown (sets `callAsId`)
2. User enters phone number in `ToInput` (sets `to`)
3. User clicks green phone button in `DialPad`
4. Calls `placeCall()` with no arguments (uses `to` and `callAsId` from state)

**Alternative**: User can click a green phone button on a contact suggestion:

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/suggestions.tsx:55-62`

```typescript
<Button
    onClick={() => placeCall(identifier.value, null, displayName, avatarUrl)}
>
    <Phone />
</Button>
```

Calls `placeCall(destinationNumber, null, displayName, avatarUrl)` with pre-filled contact info.

### 6.2 placeCall Executes (Web Path)

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:412-508`

```typescript
const placeCall = useCallback(
    (destination?: string | null, caller?: string | null, displayName?: string | null, avatarUrl?: string | null) => {
        const dest = destination ?? to;
        const sanitizedDest = dest?.startsWith('+') ? dest.slice(1) : dest;

        let effectiveCallerNumber: string | null = null;

        if (caller) {
            const fromOptions = callAsPhoneNumbers?.find((o) => o.number === caller) ?? null;
            if (!fromOptions) {
                toast({ title: 'The "from" number isn\'t accessible', type: 'warning' });
                return;
            }
            effectiveCallerNumber = fromOptions.number;
        } else {
            const fromState = callAsPhoneNumbers?.find((o) => o.id === callAsId) ?? null;
            effectiveCallerNumber = fromState?.number ?? null;
        }

        if (!effectiveCallerNumber) {
            toast({ title: 'The "from" number isn\'t accessible', type: 'warning' });
            return;
        }

        if (!sanitizedDest) return;

        // Route through native plugin on mobile, WebRTC client on web
        if (useNativeVoip) {
            // [Native path - omitted]
        } else {
            if (!client) return;
            try {
                client.newCall({
                    destinationNumber: sanitizedDest,        // without leading '+'
                    callerNumber: effectiveCallerNumber,      // org phone number
                    clientState: btoa(JSON.stringify({ user_id: auth.user.id })),
                    micId: selectedAudioInputDeviceId ?? undefined,
                    speakerId: selectedAudioOutputDeviceId ?? undefined,
                    remoteElement: REMOTE_AUDIO_ELEMENT_ID,
                });
            } catch (e) {
                console.error('Failed to start call', e);
            }
        }
    },
    [callAsPhoneNumbers, callAsId, to, client, auth.user.id, selectedAudioInputDeviceId, selectedAudioOutputDeviceId, useNativeVoip],
);
```

**Parameters**:
- `destinationNumber`: Phone to call (without leading '+')
- `callerNumber`: Org's phone number (caller ID)
- `clientState`: Base64-encoded JSON with `{ user_id }` (passed to backend in webhook)
- `micId`, `speakerId`: Selected audio devices
- `remoteElement`: HTML element ID for audio output

### 6.3 TelnyxRTC Sends SIP INVITE

**SDK behavior** (inferred from `@telnyx/react-client`):
1. `client.newCall()` sends SIP INVITE via WebSocket to Telnyx
2. Telnyx routes the call to PSTN
3. SDK emits state updates as call progresses

### 6.4 Call State Updates via useNotification

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:205-206`

```typescript
const notification = useSafeNotification();
const activeCall = notification && notification.call && notification.call.state !== 'destroy'
    ? notification.call
    : null;
```

**State progression**:
1. `activeCall.state === 'requesting'` — outbound call setup
2. `activeCall.state === 'ringing'` — remote party ringing (after they receive INVITE)
3. `activeCall.state === 'active'` — call answered

### 6.5 UI State Transitions

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:36-38`

```typescript
{call ? statusSpecificComponent[call.status as keyof typeof statusSpecificComponent] || <OnCall /> : <DialPad />}
```

**Progression**:
1. `call.status === 'requesting'` → renders `<OnCall />` (no specific component for requesting)
2. `call.status === 'ringing'` → renders `<IncomingCall />` (but displays as outbound via status text)
3. `call.status === 'active'` → renders `<OnCall />`

**Note**: The `<IncomingCall />` component is reused for outbound ringing:

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:262`

```typescript
<div>{call.status !== 'active' ? 'Incoming' : call.elapsedTime}</div>
```

This says "Incoming" for status !== 'active', which is misleading for outbound calls. **Potential bug**: Outbound ringing calls display "Incoming" text.

### 6.6 Backend Notification (Webhook)

**Does the backend get notified of outbound web calls?**

**Answer**: YES, via Telnyx webhook.

**Flow**:
1. Web client sends SIP INVITE via TelnyxRTC WebSocket to Telnyx
2. Telnyx routes call and sends `call.initiated` webhook to Laravel
3. Laravel `TelnyxOutboundWebhookController` processes webhook
4. `clientState` parameter contains `{ user_id }` to identify the caller

**File**: `app/Http/Controllers/Telnyx/TelnyxOutboundWebhookController.php` (inferred)

- Decodes `client_state` JWT/base64
- Extracts `user_id`
- Logs call in database
- May update ledger/usage tracking

**Key difference from inbound**:
- Inbound: Backend orchestrates simultaneous ring via `transferToUser()`
- Outbound: Backend receives webhook for logging only, does not control routing

---

## 7. Architecture Summary

### 7.1 Component Hierarchy

```
GlobalAppProviders (app-layout.tsx)
  │
  ├─ [Platform detection: isWeb() vs isNativeMobile()]
  │
  ├─ Web path:
  │   └─ TelnyxRTCProvider (from @telnyx/react-client)
  │        ├─ WebSocket to Telnyx SIP gateway
  │        ├─ useNotification() → activeCall
  │        └─ useCallbacks() → onReady, onSocketError
  │
  └─ Native path:
      └─ NativeVoipProvider (no-op context)
           └─ Native layer handles VoIP (Kotlin/Swift)

  ├─ DialpadProvider (context.tsx)
  │   ├─ useNativeVoip = isNativeMobile()
  │   ├─ Web: activeCall from useNotification()
  │   ├─ Native: nativeCallState from TelnyxVoip.addListener()
  │   └─ Unified call state + actions (placeCall, answer, hangUp, toggleMute, sendDTMF)
  │
  └─ Dialpad UI Components
      ├─ CallAsSelect (caller ID picker)
      ├─ ToInput (phone number input)
      ├─ Suggestions (contact list with call buttons)
      └─ Dialer
          ├─ DialPad (numpad grid)
          ├─ IncomingCall (ringing UI)
          └─ OnCall (active call UI)
```

### 7.2 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          WEB CLIENT                             │
│                                                                 │
│  TelnyxRTCProvider (WebSocket to Telnyx)                        │
│    │                                                            │
│    ├─ INBOUND CALL:                                            │
│    │   1. SIP INVITE arrives via WebSocket                     │
│    │   2. useNotification() → activeCall.state = 'ringing'     │
│    │   3. DialpadProvider derives call state                   │
│    │   4. Lazy-loads caller identifier via Inertia             │
│    │   5. <IncomingCall /> renders with accept/reject buttons  │
│    │   6. User clicks answer → activeCall.answer()             │
│    │   7. SIP 200 OK sent via WebSocket                        │
│    │   8. Media flows via WebRTC                               │
│    │                                                            │
│    └─ OUTBOUND CALL:                                           │
│        1. User clicks call → placeCall()                       │
│        2. client.newCall() sends SIP INVITE via WebSocket      │
│        3. activeCall.state = 'requesting' → 'ringing' → 'active'│
│        4. <OnCall /> renders with elapsed time + controls      │
│                                                                 │
│  Laravel Echo (Reverb WebSocket)                               │
│    │                                                            │
│    └─ call_ended broadcast:                                    │
│        1. Listens on org.{orgId}.App.Models.User.{userId}     │
│        2. Event: .call_ended                                   │
│        3. Payload: { call_session_id, reason }                 │
│        4. If activeCall.state === 'ringing', hangup()          │
│        5. Dismisses UI (simultaneous ring coordination)        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ (no direct dependency)
                              │
┌─────────────────────────────────────────────────────────────────┐
│                       LARAVEL BACKEND                            │
│                                                                 │
│  Telnyx Webhook: POST /webhooks/cpaas/telnyx/call-control      │
│    │                                                            │
│    ├─ call.initiated → TelnyxInboundWebhookController          │
│    │   ├─ Broadcasts IncomingCallNotification via Reverb      │
│    │   │   (NOT USED BY WEB — web gets call via SIP directly)  │
│    │   └─ Sets up simultaneous ring (native mobile)            │
│    │                                                            │
│    ├─ call.answered → Acquires lock, bridges, dismisses others │
│    │   └─ Broadcasts call_ended to dismiss ringing devices     │
│    │                                                            │
│    └─ call.hangup → Cleanup, broadcasts call_ended             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 Credential Management

#### Per-Device Browser Credentials

**File**: `resources/js/hooks/useWebVoipCredentials.ts:1-170`

**Flow**:
1. Generate or retrieve persistent browser device ID:
   - Key: `localStorage['z360_browser_device_id']`
   - Value: `web_${crypto.randomUUID()}`
   - Persists across sessions, tied to browser instance

2. Register device with backend:
   - `POST /api/device-tokens`
   - Body: `{ device_id, fcm_token: 'web_${deviceId}', platform: 'web', device_name }`
   - Backend creates `UserDeviceToken` record
   - Backend generates SIP credentials via `CPaaSService->createTelephonyCredentialForUser()`
   - Returns JWT token

3. JWT token passed to `TelnyxRTCProvider`:
   ```typescript
   <TelnyxRTCProvider credential={{ login_token: webLoginToken }}>
   ```

4. TelnyxRTC uses JWT to authenticate SIP REGISTER

**Credential lifecycle**:
- Registration triggers: `userId` or `organizationId` change
- Deregistration: On logout (DELETE /api/device-tokens/{deviceId})
- Deduplication: Per React instance (ref-based check)

**Fallback JWT** (legacy mode):

**File**: `resources/js/layouts/app-layout.tsx:55-66`

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

- Cached in `sessionStorage` with 30-minute TTL
- Auto-refreshes via Inertia partial reload when expired
- Used if per-device registration fails

**Token priority**:
```typescript
const loginToken = (isWeb() ? credentials.jwtToken : null) || fallbackJwt || 'undefined';
```

### 7.4 Audio Device Management

**Device Enumeration**:

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:325-358`

```typescript
const refreshAudioDevices = useCallback(async () => {
    if (useNativeVoip) return; // Native manages devices via OS
    if (!client?.getAudioInDevices || !client?.getAudioOutDevices) return;

    try {
        const [inputs, outputs] = await Promise.all([
            client.getAudioInDevices(),
            client.getAudioOutDevices()
        ]);
        setAudioInputDevices(inputs);
        setAudioOutputDevices(outputs);

        // Auto-select first device if current selection no longer exists
        setSelectedAudioInputDeviceId(prev => {
            if (prev && inputs.some(d => d.deviceId === prev)) return prev;
            return inputs[0]?.deviceId ?? null;
        });

        setSelectedAudioOutputDeviceId(prev => {
            if (prev && outputs.some(d => d.deviceId === prev)) return prev;
            return outputs[0]?.deviceId ?? null;
        });
    } catch (e) {
        console.debug('refreshAudioDevices failed', e);
    }
}, [client, useNativeVoip]);

// Listen for device changes
useEffect(() => {
    if (useNativeVoip) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;

    const handler = () => refreshAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
}, [refreshAudioDevices, useNativeVoip]);
```

**Device Selection**:

**Input device** (lines 374-388):
```typescript
useEffect(() => {
    if (useNativeVoip) return;
    if (!selectedAudioInputDeviceId) return;

    const apply = async () => {
        try {
            await client?.setAudioSettings?.({ micId: selectedAudioInputDeviceId });
            if (activeCall) {
                await activeCall.setAudioInDevice?.(selectedAudioInputDeviceId);
            }
        } catch (e) {
            console.debug('Failed to set audio input device', e);
        }
    };
    apply();
}, [selectedAudioInputDeviceId, client, activeCall, useNativeVoip]);
```

**Output device** (lines 390-410):
```typescript
useEffect(() => {
    if (useNativeVoip) return;
    if (!selectedAudioOutputDeviceId) return;

    const apply = async () => {
        try {
            if (client) {
                client.remoteElement = REMOTE_AUDIO_ELEMENT_ID;
                client.speaker = selectedAudioOutputDeviceId;
            }
            if (activeCall) {
                activeCall.options.remoteElement = REMOTE_AUDIO_ELEMENT_ID;
                activeCall.options.speakerId = selectedAudioOutputDeviceId;
                await activeCall.setAudioOutDevice?.(selectedAudioOutputDeviceId);
            }
            await attachOutputDevice(selectedAudioOutputDeviceId);
        } catch (e) {
            console.debug('Failed to set audio output device', e);
        }
    };
    apply();
}, [selectedAudioOutputDeviceId, client, activeCall, attachOutputDevice, useNativeVoip]);
```

**Output device sink** (lines 360-372):
```typescript
const attachOutputDevice = useCallback(async (deviceId: string | null) => {
    if (!deviceId || typeof document === 'undefined') return;

    const audioElement = document.getElementById(REMOTE_AUDIO_ELEMENT_ID) as
        | (HTMLMediaElement & { setSinkId?: (deviceId: string) => Promise<void> })
        | null;

    if (audioElement?.setSinkId) {
        try {
            await audioElement.setSinkId(deviceId);
        } catch (e) {
            console.debug('attachOutputDevice failed', e);
        }
    }
}, []);
```

**Browser compatibility note**: `HTMLMediaElement.setSinkId()` is not universally supported (Firefox requires flag). Gracefully degrades if unavailable.

---

## 8. Critical Findings

### 8.1 Reverb Broadcast NOT Used for Incoming Calls on Web

**Finding**: The backend broadcasts `IncomingCallNotification` (event: `.incoming_call`) to the user's private Reverb channel, but **the web client does NOT listen for this event**.

**Evidence**:
- Backend: `app/Events/IncomingCallNotification.php` broadcasts to `org.{orgId}.App.Models.User.{userId}` with event name `.incoming_call`
- Frontend: No `useEcho()` listener found for `.incoming_call` in any web component
- Web client relies solely on TelnyxRTC WebSocket SIP INVITE for incoming call detection

**Why this works**: Web browser maintains persistent WebSocket to Telnyx, receives SIP INVITE directly. Reverb broadcast is redundant for web.

**Implications**:
- If WebSocket fails (network throttling, firewall), web client will NOT receive incoming calls
- No fallback via Reverb
- Native mobile DOES use push notifications as primary path (not Reverb)

**Recommendation**: Consider adding Reverb listener as fallback path for web, or document that web requires persistent WebSocket.

### 8.2 Simultaneous Ring Dismissal via call_ended Broadcast

**Finding**: Web client listens for `call_ended` broadcast to dismiss ringing calls when another device answers.

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:208-227`

**Mechanism**:
- Backend sends `call_ended` when any device answers
- Web checks if `activeCall.state === 'ringing'` or `'requesting'`
- If so, calls `activeCall.hangup()` to dismiss

**Timing consideration**: This is a **fallback**. TelnyxRTC SDK natively handles SIP CANCEL from Telnyx. Reverb ensures dismissal even if SIP CANCEL doesn't arrive due to:
- Network latency
- WebSocket disconnection
- Telnyx platform issues

**Payload**:
```typescript
{
  call_session_id: string,  // Backend call session ID
  reason: string            // "answered_elsewhere" | "hangup" | etc.
}
```

**Channel**: `org.{orgId}.App.Models.User.{userId}`
**Event**: `.call_ended`

### 8.3 Multi-Tab Behavior

**Finding**: All browser tabs register with the same `browserDeviceId` (stored in `localStorage`), causing all tabs to ring on incoming calls.

**Evidence**:
- `z360_browser_device_id` stored in `localStorage` (shared across tabs)
- Each tab creates its own `TelnyxRTCProvider` instance
- Each tab creates its own WebSocket to Telnyx with same SIP credentials
- Telnyx sends SIP INVITE to all WebSockets with same credentials

**Dismissal**: When one tab answers, backend broadcasts `call_ended`, other tabs hang up. But there's a brief window where multiple tabs show ringing UI.

**Multi-tab registration**: Each tab independently calls `POST /api/device-tokens` with same `device_id`. Backend likely handles this gracefully (updates existing record rather than creating duplicate).

**Recommendation**: Consider single-tab coordinator (via `localStorage` + `storage` event) to designate one tab as "master" for incoming calls, or implement browser-level coordination.

### 8.4 No Web Push Notifications for Incoming Calls

**Finding**: Web client has no Service Worker or Web Push API integration for incoming calls.

**Implication**: If browser tab is in background and browser throttles WebSocket, incoming calls may be missed.

**Native comparison**: Native mobile uses PushKit (iOS) and FCM high-priority (Android) to wake app from killed/background state. Web has no equivalent.

**Mitigation options**:
1. Implement Web Push API via Service Worker (requires user permission)
2. Document requirement for tab to remain open
3. Implement "missed call" notification on next tab focus

### 8.5 Outbound Call UI Displays "Incoming" Text

**Finding**: Outbound calls in ringing state render `<IncomingCall />` component, which displays "Incoming" text.

**File**: `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx:262`

```typescript
<div>{call.status !== 'active' ? 'Incoming' : call.elapsedTime}</div>
```

**Issue**: For outbound calls, `call.status === 'ringing'` (remote party ringing), so UI says "Incoming" which is misleading.

**Fix**: Distinguish between `'ringing'` (inbound) and `'requesting'` (outbound) in status text.

### 8.6 Audio Element ID Hardcoded

**Finding**: `REMOTE_AUDIO_ELEMENT_ID = 'dialpad-remote-audio'` is a global DOM element ID.

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:22`

**Implication**: If two instances of `DialpadProvider` existed (they shouldn't, but...), they'd conflict on this ID. The `<Audio>` component renders with this ID, and multiple `<Audio>` elements with same ID would cause undefined behavior.

**Mitigation**: `DialpadProvider` is rendered once per app in `GlobalAppProviders`, so this is currently safe. But it's a fragile pattern.

### 8.7 Credential Token Priority and Fallback

**Finding**: Web login token priority is: per-device JWT > per-user fallback JWT > string `'undefined'`.

**File**: `resources/js/hooks/useWebVoipCredentials.ts:161`

```typescript
const loginToken = (isWeb() ? credentials.jwtToken : null) || fallbackJwt || 'undefined';
```

**Issue**: If both device registration and fallback JWT fail, `loginToken` becomes the string `'undefined'`, which is passed to `TelnyxRTCProvider`. This causes authentication failure, resulting in `isSocketError = true` rather than a clear user-facing message.

**Recommendation**: Validate token before passing to provider, show clear error UI if credentials unavailable.

### 8.8 Session Cache TTL Mismatch

**Finding**: Fallback JWT is cached for 30 minutes with auto-refresh, but per-device JWT has no explicit TTL/refresh mechanism.

**Files**:
- Fallback: `resources/js/layouts/app-layout.tsx:55-66` (30-minute TTL, auto-refresh)
- Per-device: `resources/js/hooks/useWebVoipCredentials.ts` (no TTL, no refresh)

**Implication**: If per-device JWT expires, there's no auto-refresh. User would need to reload page or re-login.

**Backend JWT TTL** (inferred): JWT likely has long TTL (24+ hours) to avoid frequent re-registration, but this is not documented in frontend code.

### 8.9 Native VoIP Event Listeners Setup

**Finding**: Native call event listeners are set up once on mount and never cleaned up.

**File**: `resources/js/components/identifier-details-sidebar/dialpad/context.tsx:104-200`

**Mechanism**:
```typescript
useEffect(() => {
    if (!useNativeVoip) return;

    const listeners: Array<{ remove: () => void }> = [];

    const setup = async () => {
        listeners.push(await TelnyxVoip.addListener('callStarted', ...));
        listeners.push(await TelnyxVoip.addListener('callRinging', ...));
        // ... more listeners
    };

    setup();

    return () => {
        listeners.forEach(listener => listener.remove());
    };
}, [useNativeVoip]);
```

**Issue**: If `useNativeVoip` changes during runtime (shouldn't happen, but...), listeners would be removed and re-added. The dependency array includes `useNativeVoip`, which is derived from `isNativeMobile()` — a constant per platform.

**Verdict**: This is safe in practice but could be optimized by making `useNativeVoip` a constant outside the component.

---

## Appendix A: File Reference Index

| File | Lines | Purpose |
|------|-------|---------|
| `resources/js/layouts/app-layout.tsx` | 308 | Global layout, provider switching, credential management |
| `resources/js/utils/platform.ts` | 37 | Platform detection utilities |
| `resources/js/providers/native-voip-provider.tsx` | 39 | No-op context for native mobile |
| `resources/js/hooks/useWebVoipCredentials.ts` | 170 | Per-device browser registration and JWT credentials |
| `resources/js/hooks/useSessionCache.ts` | 74 | Session-scoped cache with TTL and auto-refresh |
| `resources/js/components/identifier-details-sidebar/dialpad/context.tsx` | 646 | Core VoIP logic: call state, actions, device management |
| `resources/js/components/identifier-details-sidebar/dialpad/dialpad.tsx` | 33 | Desktop dialpad page component |
| `resources/js/components/identifier-details-sidebar/dialpad/components/dialer.tsx` | 274 | Dialpad UI: DialPad, IncomingCall, OnCall |
| `resources/js/components/identifier-details-sidebar/dialpad/components/call-as-select.tsx` | 26 | Caller ID dropdown |
| `resources/js/components/identifier-details-sidebar/dialpad/components/to-input.tsx` | 63 | Phone number / search input |
| `resources/js/components/identifier-details-sidebar/dialpad/components/suggestions.tsx` | 65 | Contact suggestions list |
| `resources/js/components/identifier-details-sidebar/dialpad/components/call-display.tsx` | 15 | Sidebar call display widget |
| `resources/js/hooks/useCountdown.ts` | 47 | Elapsed time counter for active calls |
| `app/Events/IncomingCallNotification.php` | 57 | Backend event (NOT USED BY WEB) |
| `app/Events/CallEndedNotification.php` | ~50 | Backend event for dismissal (inferred) |

---

**End of Document**
