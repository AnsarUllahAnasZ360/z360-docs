---
title: Architecture Diagrams
description: All Z360 platform architecture diagrams in one place — system overview, platform architectures, call flows, state machines, and integration flows.
---

# Z360 Architecture Diagrams

A visual reference for the entire Z360 VoIP platform. These diagrams were created to complement the technical whitepaper and provide a quick, shareable overview of the system's architecture, call flows, and integration patterns.

---

## System Architecture

### Master System Diagram

The top-level view of Z360 — all major components, external services (Telnyx, FCM, APNs), and how the Laravel backend, web client, and mobile apps connect.

![Master System Diagram](/diagrams/master-system-diagram.jpeg)

### How Calling Works

End-to-end overview of how a call is placed and received across the platform, covering the signaling path from Telnyx through the backend to each client.

![How Calling Works](/diagrams/how-calling-works.jpeg)

### Inbound Call — End-to-End

The complete data flow for an inbound call, from Telnyx webhook arrival through backend orchestration to device ringing and answer.

![Inbound Call End-to-End Flow](/diagrams/inbound-call-end-to-end.jpeg)

---

## Platform Architectures

### Android Architecture Overview

The four-layer Android architecture: Capacitor bridge, Kotlin VoIP layer, ConnectionService integration, and Telnyx SDK.

![Android Architecture Overview](/diagrams/android-architecture-overview.jpeg)

### Android Target Component Diagram

The target-state architecture for Android VoIP, addressing gaps in state management, credential security, and ConnectionService binding.

![Android Target Component Diagram](/diagrams/android-target-component-diagram.jpeg)

### Android Threading Model

How Android manages threads across the Capacitor WebView, native VoIP layer, ConnectionService, and Telnyx SDK callbacks.

![Android Threading Model](/diagrams/android-threading-model.jpeg)

### iOS Architecture

The complete iOS VoIP architecture — CallKit integration, PushKit handling, Telnyx SDK wrapper, and the Capacitor bridge layer.

![iOS Architecture](/diagrams/ios-architecture.jpeg)

### iOS Component Diagram

Component-level breakdown of the iOS VoIP implementation, showing how Swift modules interact with CallKit and the Capacitor plugin.

![iOS Component Diagram](/diagrams/ios-component-diagram.jpeg)

### Laravel Backend Call Orchestration

How the Laravel backend orchestrates calls — webhook ingestion, Telnyx Call Control API interactions, Redis state, and notification dispatch.

![Laravel Backend Call Orchestration](/diagrams/laravel-backend-call-orchestration.jpeg)

### Web Client VoIP Implementation

The browser-based VoIP stack — Telnyx WebRTC SDK integration, React state management, audio handling, and WebSocket signaling.

![Web Client VoIP Implementation](/diagrams/web-client-voip-implementation.jpeg)

---

## Call Flows

### Unified Inbound Call Flow

The canonical inbound call flow across all platforms, showing how a single Telnyx call fans out to web, Android, and iOS simultaneously.

![Unified End-to-End Inbound Call Flow](/diagrams/unified-inbound-call-flow.jpeg)

### Android Inbound Call Flow

Platform-specific trace of an inbound call on Android — from FCM push through ConnectionService to Telnyx SDK answer.

![Android Inbound Call Flow](/diagrams/android-inbound-call-flow.jpeg)

### iOS Inbound Call Flow

Platform-specific trace on iOS — from APNs/PushKit through CallKit to Telnyx SDK answer, including VoIP push handling.

![iOS Inbound Call Flow](/diagrams/ios-call-flow.jpeg)

### Web Inbound Call Flow

Browser-side inbound call handling — SIP invite via WebSocket, Telnyx JS SDK event flow, and UI state transitions.

![Web Inbound Call Flow](/diagrams/web-inbound-call-flow.jpeg)

---

## Simultaneous Ringing

### SimRing Overview

How Z360 rings multiple devices at once — the fork-call model, Redis-backed coordination, and first-answer-wins locking.

![Simultaneous Ringing](/diagrams/sim-ring.jpeg)

### Simultaneous Ringing — End-to-End

The complete SimRing lifecycle from Telnyx webhook through backend fan-out, multi-device ringing, answer race resolution, and loser hangup.

![Simultaneous Ringing End-to-End](/diagrams/simultaneous-ringing-end-to-end.jpeg)

---

## State Management

### Distributed Call State Machine

The canonical state machine governing call lifecycle across all platforms — states, transitions, guards, and platform-specific deviations.

![Z360 Distributed Call State Machine](/diagrams/distributed-call-state-machine.jpeg)

### Call State Synchronization

How call state stays consistent across web, Android, iOS, and the backend — event propagation, conflict resolution, and consistency guarantees.

![Z360 Call State Synchronization](/diagrams/call-state-synchronization.jpeg)

---

## Integration & Credentials

### Push Credential Configuration and Delivery Flows

The complete push notification architecture — how FCM and APNs credentials are configured, how Z360's server-mediated push model works, and the dual-push delivery flow.

![Push Credential Configuration and Delivery Flows](/diagrams/push-credential-configuration-flows.jpeg)
