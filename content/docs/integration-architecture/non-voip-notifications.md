---
title: Non VoIP Notifications
---

# Non-VoIP Push Notifications in Z360

**Document Version:** 1.0
**Last Updated:** 2026-02-08
**Author:** Teammate B (Non-VoIP Notifications Analyst)

---

## Table of Contents

1. [Overview](#overview)
2. [Notification Types](#notification-types)
3. [Notification Delivery Architecture](#notification-delivery-architecture)
4. [Deep Linking](#deep-linking)
5. [Foreground Notification Handling](#foreground-notification-handling)
6. [Badge Management](#badge-management)
7. [Notification Permissions](#notification-permissions)
8. [Android Notification Channels](#android-notification-channels)
9. [Known Issues and Considerations](#known-issues-and-considerations)

---

## Overview

Z360 implements a comprehensive push notification system for non-VoIP events using Firebase Cloud Messaging (FCM) on Android and Firebase + APNs on iOS. The system delivers 10 distinct notification types across three user-configurable channels: email, in-app database notifications, and mobile push notifications.

**Key Components:**
- **Backend:** Laravel notification classes with FCM channel (`app/Channels/FcmChannel.php`)
- **Frontend:** React hook `use-push-notifications.ts` with Capacitor Push Notifications plugin
- **Platform:** Capacitor 8 hybrid mobile app with native push notification support

---

## Notification Types

Z360 defines **10 notification types** in `app/Enums/NotificationType.php`:

### 1. MESSAGE_RECEIVED
**Trigger:** Inbound message arrives in a conversation
**Source:** `app/Observers/MessageObserver.php:113-129`
**Notification Class:** `app/Notifications/MessageReceivedNotification.php`

**Display:**
- Title: `"New Message"`
- Body: `"{ContactName}: {MessagePreview}"` (50 char limit)
- Link: `/inbox?id={conversation_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $conversation->organization_id,
    'organization_name' => $conversation->organization->name,
    'title' => 'New Message',
    'body' => "{$contactName}: " . Str::limit($message->content, 50),
    'collapse_key' => "conversation_{$conversation->id}",
    'data' => [
        'type' => 'message_received',
        'link' => "/inbox?id={$conversation->id}",
    ],
    'android' => [
        'channel_id' => 'messages',
        'priority' => 'high',
        'ttl' => '300s',
    ],
]
```

**Special Logic:** Suppresses notifications for messages from system addresses (no-reply@, donotsend@)
**File Reference:** `app/Notifications/MessageReceivedNotification.php:32-41`

---

### 2. CONVERSATION_ASSIGNED
**Trigger:** A conversation is assigned to a user
**Source:** `app/Observers/AssignmentObserver.php:23-26`
**Notification Class:** `app/Notifications/ConversationAssignedNotification.php`

**Display:**
- Title: `"Conversation Assigned"`
- Body: `"{AssignerName} assigned a conversation to you."`
- Link: `/inbox?id={conversation_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $conversation->organization_id,
    'organization_name' => $conversation->organization->name,
    'title' => 'Conversation Assigned',
    'body' => "{$assignedBy->name} assigned a conversation to you.",
    'collapse_key' => "conversation_{$conversation->id}_assigned",
    'data' => [
        'type' => 'conversation_assigned',
        'link' => "/inbox?id={$conversation->id}",
    ],
    'android' => [
        'channel_id' => 'assignments',
        'priority' => 'high',
        'ttl' => '3600s',
    ],
]
```

**Special Logic:** Suppresses notification if assigned to an authenticated email address (prevents notification loops)
**File Reference:** `app/Notifications/ConversationAssignedNotification.php:37-44`

---

### 3. TICKET_ASSIGNED
**Trigger:** A ticket is assigned to a user
**Source:** `app/Observers/AssignmentObserver.php:23-26`
**Notification Class:** `app/Notifications/TicketAssignedNotification.php`

**Display:**
- Title: `"Ticket Assigned"`
- Body: `"{AssignerName} assigned a ticket to you."`
- Link: `/inbox?id={conversation_id}&focused={message_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $ticket->organization_id,
    'organization_name' => $ticket->organization->name,
    'title' => 'Ticket Assigned',
    'body' => "{$assignedBy->name} assigned a ticket to you.",
    'collapse_key' => "ticket_{$ticket->id}_assigned",
    'data' => [
        'type' => 'ticket_assigned',
        'link' => "/inbox?id={$conversation_id}&focused={$message_id}",
    ],
    'android' => [
        'channel_id' => 'assignments',
        'priority' => 'high',
        'ttl' => '3600s',
    ],
]
```

---

### 4. INQUIRY_ASSIGNED
**Trigger:** An inquiry is assigned to a user
**Source:** `app/Observers/AssignmentObserver.php:23-26`
**Notification Class:** `app/Notifications/InquiryAssignedNotification.php`

**Display:**
- Title: `"Inquiry Assigned"`
- Body: `"{AssignerName} assigned an inquiry to you."`
- Link: `/inbox?id={conversation_id}&focused={message_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $inquiry->organization_id,
    'organization_name' => $inquiry->organization->name,
    'title' => 'Inquiry Assigned',
    'body' => "{$assignedBy->name} assigned an inquiry to you.",
    'collapse_key' => "inquiry_{$inquiry->id}_assigned",
    'data' => [
        'type' => 'inquiry_assigned',
        'link' => "/inbox?id={$conversation_id}&focused={$message_id}",
    ],
    'android' => [
        'channel_id' => 'assignments',
        'priority' => 'high',
        'ttl' => '3600s',
    ],
]
```

---

### 5. NOTE_CREATED
**Trigger:** A note is created in a conversation
**Source:** `app/Observers/NoteObserver.php:12-23`
**Notification Class:** `app/Notifications/NoteCreatedNotification.php`

**Display:**
- Title: `"Note Added"`
- Body: `"{CreatorName} added a note: {NotePreview}"` (50 char limit)
- Link: `/inbox?id={conversation_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $note->organization_id,
    'organization_name' => $note->organization->name,
    'title' => 'Note Added',
    'body' => "{$createdBy->name} added a note: " . Str::limit($note->renderMentions($note->body), 50),
    'collapse_key' => "conversation_{$conversation_id}_notes",
    'data' => [
        'type' => 'note_created',
        'link' => "/inbox?id={$conversation_id}",
    ],
    'android' => [
        'channel_id' => 'notes',
        'priority' => 'normal',
        'ttl' => '3600s',
    ],
]
```

**Special Logic:** Does not notify the user who created the note
**File Reference:** `app/Notifications/NoteCreatedNotification.php:34-38`

---

### 6. REMINDER_CREATED
**Trigger:** A reminder is created in a conversation
**Source:** `app/Observers/ReminderObserver.php:12-23`
**Notification Class:** `app/Notifications/ReminderCreatedNotification.php`

**Display:**
- Title: `"Reminder Created"`
- Body: `"{CreatorName} set a reminder: {ReminderDescription}"` (50 char limit)
- Link: `/inbox?id={conversation_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $reminder->organization_id,
    'organization_name' => $reminder->organization->name,
    'title' => 'Reminder Created',
    'body' => "{$createdBy->name} set a reminder: " . Str::limit($reminder->renderMentions($reminder->description), 50),
    'collapse_key' => "reminder_{$reminder->id}",
    'data' => [
        'type' => 'reminder_created',
        'link' => "/inbox?id={$conversation_id}",
    ],
    'android' => [
        'channel_id' => 'reminders',
        'priority' => 'normal',
        'ttl' => '3600s',
    ],
]
```

**Special Logic:** Does not notify the user who created the reminder
**File Reference:** `app/Notifications/ReminderCreatedNotification.php:34-38`

---

### 7. REMINDER_ASSIGNED
**Trigger:** A reminder is assigned to a user
**Source:** `app/Observers/AssignmentObserver.php:23-26`
**Notification Class:** `app/Notifications/ReminderAssignedNotification.php`

**Display:**
- Title: `"Reminder Assigned to You"`
- Body: Email only (no push notification)

**Channels:** Email ONLY (no push/FCM implementation)
**File Reference:** `app/Notifications/ReminderAssignedNotification.php:24-31`

---

### 8. REMINDER_DUE_ALERT
**Trigger:** Scheduled task runs 30 minutes before reminder due time
**Source:** `app/Schedule/SendReminderDueAlerts.php`
**Notification Class:** `app/Notifications/ReminderDueAlertNotification.php`

**Display:**
- Title: `"Reminder Due in 30 Minutes"`
- Body: Email only (no push notification)

**Channels:** Email ONLY (no push/FCM implementation)
**File Reference:** `app/Notifications/ReminderDueAlertNotification.php:24-31`

---

### 9. USER_MENTIONED
**Trigger:** A user is @mentioned in a note, ticket description, or reminder
**Source:** `app/Traits/Mentionable.php` (automatically detected on model save)
**Notification Class:** `app/Notifications/UserMentionedNotification.php`

**Display:**
- Title: `"You were mentioned"`
- Body: `"{MentionerName} mentioned you in a {type}: {ContentPreview}"` (50 char limit)
- Link: `/inbox?id={conversation_id}`

**Payload (toFcm):**
```php
[
    'organization_id' => $resource->organization_id,
    'organization_name' => $resource->organization->name,
    'title' => 'You were mentioned',
    'body' => "{$mentionedBy->name} mentioned you in a {$resourceType}: " . Str::limit($content, 50),
    'collapse_key' => "mention_{$resourceType}_{$resource->id}",
    'data' => [
        'type' => 'user_mentioned',
        'link' => "/inbox?id={$conversation_id}",
    ],
    'android' => [
        'channel_id' => 'mentions',
        'priority' => 'high',
        'ttl' => '3600s',
    ],
]
```

**Supported Resources:** Note, Ticket, Reminder

---

### 10. CHANNEL_HEALTH_ALERT
**Trigger:** Scheduled task detects unhealthy phone numbers or email channels
**Source:** `app/Schedule/CheckChannelHealth.php`
**Notification Class:** `app/Notifications/ChannelHealthAlertNotification.php`

**Display:**
- Title: `"Unhealthy Channels Detected"`
- Body: `"{count} phone numbers/emails may not work correctly."`
- Link: `/settings/account/phone-numbers` or `/settings/account/emails`

**Channels:** Email + Database (in-app) ONLY (no push/FCM implementation)
**Special Logic:** Mandatory notification (ignores user preferences)
**File Reference:** `app/Notifications/ChannelHealthAlertNotification.php:28-31`

---

## Notification Delivery Architecture

### Backend: Laravel Notification System

**Notification Flow:**
1. **Trigger Event** (message received, assignment created, etc.)
2. **Observer** dispatches notification via `Notification::send()`
3. **HasPreferences Trait** determines channels based on user preferences
4. **FcmChannel** sends to registered mobile devices
5. **Firebase** routes to Android (FCM) or iOS (FCM + APNs)

**HasPreferences Trait** (`app/Notifications/Traits/HasPreferences.php:10-34`)

Checks user preferences for each channel:
- `mail`: Email notifications
- `in_app` (database): In-app notifications stored in `notifications` table
- `push` (FcmChannel): Mobile push notifications

Preference keys follow format: `notify_{type}_via_{channel}`
Example: `notify_message_received_via_push`

**FcmChannel** (`app/Channels/FcmChannel.php`)

Responsibilities:
1. Fetch user's registered device tokens from `user_device_tokens` table
2. Inject organization context into payload (prepends org name to title, appends `organization_id` to link)
3. Send FCM message to each device token via Firebase Messaging SDK
4. Update `last_active_at` on successful send
5. Delete invalid/expired tokens (handles `NotFound` and `InvalidMessage` exceptions)
6. Re-throw transient errors for queue retry

**Organization Context Injection** (`app/Channels/FcmChannel.php:65-88`)

For multi-tenant notifications:
- Title becomes: `"[{OrgName}] {OriginalTitle}"`
- Link becomes: `"{link}?organization_id={org_id}"` or `"{link}&organization_id={org_id}"`
- Enables automatic organization switching when notification is tapped

**Device Token Management** (`app/Models/UserDeviceToken.php`)

Table: `user_device_tokens`

Columns:
- `user_id`: User who owns the device
- `organization_id`: Organization context for the token (nullable)
- `device_id`: Unique device identifier (for correlation)
- `fcm_token`: FCM registration token
- `platform`: `android` or `ios`
- `last_active_at`: Last successful notification delivery
- `app_version`: App version string
- `device_name`: Human-readable device name
- `telnyx_credential_id`: VoIP SIP credential ID (for simultaneous ring)
- `sip_username`, `sip_password`, `connection_id`, `credential_expires_at`: VoIP credentials

**Token Registration** (`app/Http/Controllers/DeviceTokenController.php:14-33`)

Route: `POST /device-tokens`
Endpoint: `DeviceTokenController@store`

Upserts token by `fcm_token` (handles account switching):
- If token exists for different user → reassigns to current user
- Updates `last_active_at` timestamp
- Platform-specific token handling

**Token Cleanup:**
- Automatic deletion on invalid token error (FCM `NotFound` or `InvalidMessage`)
- Manual deletion on logout via `DeviceTokenController@destroy`

---

### Frontend: Capacitor Push Notifications

**Hook:** `resources/js/hooks/use-push-notifications.ts`

**Initialization Flow:**
1. Check/request push notification permissions
2. Create Android notification channels (Android only)
3. Register listeners for token registration, errors, and incoming notifications
4. Call `PushNotifications.register()` to get FCM token
5. Send token to backend via `POST /device-tokens`

**Token Storage:**
- Stored in localStorage: `z360_fcm_token`
- Sent timestamp: `z360_fcm_token_sent_at`
- Re-sends every 24 hours to keep `last_active_at` fresh

**Platform-Specific Token Handling:**

**Android** (`resources/js/hooks/use-push-notifications.ts:119-128`):
- `PushNotifications.addListener('registration')` receives FCM token directly
- Sends token to backend immediately

**iOS** (`resources/js/hooks/use-push-notifications.ts:37-48`):
- Native AppDelegate obtains FCM token from Firebase SDK
- Dispatches custom `iosFCMToken` event to WebView
- WebView listener sends token to backend

**Why iOS is different:** Firebase SDK is initialized natively in AppDelegate, not in WebView. The token must be bridged from native to WebView via custom event.

---

## Deep Linking

**Goal:** Tapping a notification navigates to the correct screen in the app with organization context.

### Link Format

All notifications include a `link` field in their `data` payload:
- `/inbox?id={conversation_id}`
- `/inbox?id={conversation_id}&focused={message_id}`
- `/settings/account/phone-numbers?organization_id={org_id}`

The `FcmChannel` automatically appends `organization_id` to all links.

### Navigation Handling

**Module-Level Tap Handlers** (`resources/js/hooks/use-push-notifications.ts:34-61`)

Registered at module level (before React mounts) to handle cold-start taps:

1. **Background/Killed App Tap:**
   - Event: `pushNotificationActionPerformed`
   - Extracts `link` from `action.notification.data.link`
   - Calls `visitDeepLink(link)`

2. **Foreground Local Notification Tap:**
   - Event: `localNotificationActionPerformed`
   - Extracts `link` from `action.notification.extra.link`
   - Calls `visitDeepLink(link)`

**visitDeepLink Function** (`resources/js/hooks/use-push-notifications.ts:22-31`)

- If Inertia router is ready → `router.visit(link)` immediately
- If Inertia not ready (cold start) → wait for first 'navigate' event, then visit

**Router Ready Detection:**
- Listens for Inertia's `navigate` event
- Sets `routerReady = true` on first navigation
- Ensures router is operational before visiting deep link

**Organization Switching:**
- Link includes `?organization_id={org_id}` or `&organization_id={org_id}`
- Laravel middleware detects `organization_id` query param
- Calls `$organization->switchTo()` to switch session context
- User lands on correct organization's data

---

## Foreground Notification Handling

**Problem:** Capacitor's built-in foreground notification display creates notifications without a `PendingIntent`, making them untappable on Android.

**Solution:** Use `LocalNotifications` to display foreground notifications instead.

### Configuration

**Capacitor Config** (`capacitor.config.ts:69-73`)

```typescript
PushNotifications: {
    // 'alert' omitted: Capacitor foreground notification is untappable
    // Foreground display is handled via LocalNotifications instead
    presentationOptions: ['badge', 'sound'],
}
```

**Why no 'alert'?** Including `'alert'` would show Capacitor's default foreground notification, which has no tap action. By omitting it, we suppress the default display and handle it ourselves.

### Implementation

**Foreground Listener** (`resources/js/hooks/use-push-notifications.ts:136-157`)

Event: `pushNotificationReceived`

1. Extract notification data (title, body, data payload)
2. Schedule local notification with tappable `PendingIntent`:
   ```typescript
   await LocalNotifications.schedule({
       notifications: [{
           id: Math.floor(Math.random() * 2147483647),
           title: notification.title ?? 'Z360',
           body: notification.body ?? '',
           extra: notification.data ?? {}, // Includes 'link'
           smallIcon: 'ic_notification',
           channelId: notification.data?.channel_id ?? 'default',
       }],
   });
   ```
3. Reload unread notification count in Inertia:
   ```typescript
   router.reload({
       only: ['unreadNotificationsCount'],
       showProgress: false,
   });
   ```

**Local Notification Tap Handling:**
- Listener: `localNotificationActionPerformed`
- Extracts `link` from `action.notification.extra.link`
- Calls `visitDeepLink(link)` to navigate

---

## Badge Management

### Android

**Implementation:** `android/app/src/main/java/com/z360/app/voip/MissedCallNotificationManager.kt:257-271`

**Badge Source:** Notification channels automatically show badge count based on active notifications (Android O+).

**Missed Call Badge:**
- Tracked in SharedPreferences: `missed_call_count`
- Incremented when call ends without being answered
- Decremented when user taps "Call Back" or dismisses notification
- Badge count automatically reflects notification badge (no manual API call needed on Android O+)

**Non-VoIP Badge:**
- No explicit badge management in code for non-VoIP notifications
- Android notification channels automatically show badge if notifications are present
- Badge count = number of active notifications in the app's notification tray

**Clearing Badge:**
- Dismissing all notifications clears the badge automatically
- No server-side badge tracking for Android

---

### iOS

**Implementation:** `ios/App/App/AppDelegate.swift:295-298`

**Badge Display:**
```swift
func userNotificationCenter(_ center: UNUserNotificationCenter,
                            willPresent notification: UNNotification) async
    -> UNNotificationPresentationOptions {
    return [.banner, .sound, .badge]
}
```

**Permission Request:** `ios/App/App/VoIP/TelnyxVoipPlugin.swift:664`
```swift
let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
```

**Badge Management:**
- iOS automatically increments badge count when notification is delivered
- Badge count = number of unread notifications
- No explicit badge management code found for non-VoIP notifications
- Clearing badge: Dismissing notifications or opening the app typically clears badge (handled by iOS system)

**Server-Side Badge Tracking:**
- No server-side badge count tracking found in Laravel backend
- Badge count is managed entirely by iOS notification system

---

## Notification Permissions

### Android (13+)

**Runtime Permission Required:** `POST_NOTIFICATIONS` (Android 13+)

**Permission Declaration** (`android/app/src/main/AndroidManifest.xml:15`)
```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

**Permission Request Flow** (`resources/js/hooks/use-push-notifications.ts:88-97`)

1. Check current permission status:
   ```typescript
   let permStatus = await PushNotifications.checkPermissions();
   ```
2. If `prompt` or `prompt-with-rationale` → request:
   ```typescript
   permStatus = await PushNotifications.requestPermissions();
   ```
3. If `granted` → proceed with registration
4. If `denied` → stop (no notifications)

**When Permission is Requested:**
- During first app launch after `usePushNotifications()` hook mounts
- Only requests if permission state is `prompt` (not yet asked)
- No manual in-app permission request UI (relies on system dialog)

**Voip Plugin Permission Annotation** (`android/app/src/main/java/com/z360/app/voip/TelnyxVoipPlugin.kt:42`)
```kotlin
@PermissionCallback
@PluginMethod
fun requestNotificationPermissions(call: PluginCall) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        requestPermissionForAlias(
            Manifest.permission.POST_NOTIFICATIONS,
            call,
            "notificationPermissionCallback"
        )
    }
}
```

---

### iOS

**Permissions Required:** `.alert`, `.sound`, `.badge`

**Permission Request** (`ios/App/App/VoIP/Utils/NotificationHelper.swift:85`)
```swift
notificationCenter.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
    if granted {
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }
}
```

**When Permission is Requested:**
- During first app launch after `usePushNotifications()` hook mounts
- System shows standard permission dialog
- No manual in-app permission request UI

**AppDelegate UNUserNotificationCenter Delegate** (`ios/App/App/AppDelegate.swift:44`)
```swift
UNUserNotificationCenter.current().delegate = self
```

**Permission Status Check:**
- `PushNotifications.checkPermissions()` returns `granted`, `denied`, or `prompt`
- Frontend stops registration flow if permission is `denied`

---

## Android Notification Channels

**Purpose:** Required for Android O (API 26+) to categorize notifications and allow user control over notification behavior per channel.

**Channel Creation** (`resources/js/hooks/use-push-notifications.ts:100-113`)

```typescript
if (Capacitor.getPlatform() === 'android') {
    const channels = [
        { id: 'messages', name: 'Messages', description: 'New message notifications' },
        { id: 'reminders', name: 'Reminders', description: 'Reminder notifications' },
        { id: 'notes', name: 'Notes', description: 'Note notifications' },
        { id: 'mentions', name: 'Mentions', description: 'Mention notifications' },
        { id: 'assignments', name: 'Assignments', description: 'Assignment notifications' },
        { id: 'default', name: 'General', description: 'General notifications' },
    ];

    for (const ch of channels) {
        await PushNotifications.createChannel({
            ...ch,
            importance: 4, // IMPORTANCE_HIGH
            vibration: true,
        });
    }
}
```

**Channel Assignment:**
- Each notification specifies `channel_id` in `android` config
- Examples:
  - `message_received` → `messages`
  - `ticket_assigned` → `assignments`
  - `note_created` → `notes`
  - `user_mentioned` → `mentions`
  - `reminder_created` → `reminders`

**Importance Levels:**
- `4` = IMPORTANCE_HIGH (makes sound, shows as heads-up notification)
- Channels with `importance: 4` also enable vibration

**User Control:**
- Users can customize notification behavior per channel in Android system settings
- Users can disable specific channels without disabling all Z360 notifications

---

## Known Issues and Considerations

### 1. Foreground Notification Display

**Issue:** Capacitor's built-in foreground notification (`presentationOptions: ['alert']`) creates untappable notifications on Android.

**Root Cause:** Capacitor's foreground notification implementation does not include a `PendingIntent`, making the notification static (no tap action).

**Solution:** Omit `'alert'` from `presentationOptions` and use `LocalNotifications.schedule()` instead.

**Impact:** All foreground notifications are now tappable and navigate correctly.

---

### 2. Notification Text Accuracy

**Observation:** No known issues with wrong text appearing in notifications reported in codebase comments.

**Display Logic:** All notification text is server-generated from notification classes. Each class has clear `title` and `body` logic.

**Potential Issue:** If caller name or contact name is missing, fallback text is used:
- `MessageReceivedNotification`: Falls back to `"Someone"` if contact name is unavailable
- `InquiryAssignedNotification`: Falls back to `"Inquiry #{id}"` if contact name is missing

---

### 3. Badge Management Gaps

**Android:** No explicit badge clearing logic beyond dismissing notifications. Badge count is automatically managed by notification channels.

**iOS:** No explicit badge management code found. Badge count is managed by iOS notification system.

**Server-Side:** No badge count tracking on server. All badge management is client-side.

**Potential Issue:** If notifications are dismissed without opening the app, badge count may not sync correctly. No mechanism to clear badge count from server.

---

### 4. Multi-Organization Notification Handling

**Solution:** `FcmChannel` automatically injects `organization_id` into all notification links and prepends org name to title.

**Example:**
- Title: `"[Acme Corp] New Message"`
- Link: `/inbox?id=123&organization_id=5`

**Impact:** Users can receive notifications from multiple organizations and tap to switch context automatically.

---

### 5. Email-Only Notifications

**Types with no push/FCM:**
- `REMINDER_ASSIGNED`: Email only
- `REMINDER_DUE_ALERT`: Email only
- `CHANNEL_HEALTH_ALERT`: Email + in-app (database) only

**Rationale:** These notifications are less time-sensitive or may contain sensitive information better suited for email.

---

### 6. Notification Preferences

**User Control:** Users can enable/disable each notification type per channel (mail, in_app, push) via settings.

**Preference Key Format:** `notify_{type}_via_{channel}`

**Examples:**
- `notify_message_received_via_push`
- `notify_ticket_assigned_via_mail`
- `notify_note_created_via_in_app`

**Mandatory Notifications:** `CHANNEL_HEALTH_ALERT` ignores preferences and always sends via email + in-app.

---

### 7. Token Re-Registration

**Frequency:** Every 24 hours (even if token hasn't changed)

**Purpose:** Keeps `last_active_at` timestamp fresh, indicating the device is still active.

**Implementation:** Frontend checks if 24 hours have passed since last token send. If yes, re-sends token to backend.

**File Reference:** `resources/js/hooks/use-push-notifications.ts:42-47` (iOS), `resources/js/hooks/use-push-notifications.ts:122-127` (Android)

---

## Summary

Z360's non-VoIP push notification system delivers **10 notification types** (8 with push support, 2 email-only) across email, in-app, and mobile channels. The system leverages:

- **Laravel Notification System** with custom `FcmChannel` for FCM delivery
- **Firebase Cloud Messaging** for Android and iOS push delivery
- **Capacitor Push Notifications Plugin** with custom foreground handling via `LocalNotifications`
- **Deep linking** with automatic organization context switching
- **User preferences** for per-type, per-channel notification control
- **Android notification channels** for user-customizable notification categories

**Key Strengths:**
- Clean separation of concerns (backend, frontend, platform-specific)
- Automatic organization context injection for multi-tenant notifications
- Tappable foreground notifications with navigation
- User-configurable preferences per notification type

**Areas for Potential Improvement:**
- Server-side badge count tracking for iOS
- Explicit badge clearing logic on app open
- Push notification support for `REMINDER_ASSIGNED` and `REMINDER_DUE_ALERT`
- Unified badge management strategy across platforms

---

**End of Document**
