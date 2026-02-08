---
title: Web Platform Architecture
---

# Z360 Web Platform Architecture

## 1. System Overview

Z360 is a **multi-tenant SaaS platform** built on **Laravel 12 + React 19 + TypeScript + Inertia.js + PostgreSQL**, running in Docker. The platform is organized into two system layers:

- **Organizational Layer** — Tenant-scoped daily business operations (Dashboard, Contacts, Inbox, Tickets, Inquiries, AI Studio, Chats, Settings)
- **Administrative Layer** — Platform-wide management and oversight (Admin Dashboard, Organizations, Users)

All data is tenant-isolated via session-based organization switching. The frontend is a single-page application (SPA) powered by Inertia.js, with real-time capabilities via Laravel Reverb WebSockets. An external Python-based AI agent gateway connects via HTTP and exposes 45+ MCP tools for AI-driven automation.

---

## 2. Component Inventory

### 2.1 Laravel Backend

#### 2.1.1 Controllers (`app/Http/Controllers/`)

**AI Studio** (`AIStudio/`):
- `AbilityTestingController.php` — AI ability testing interface
- `AiAbilitiesController.php` — AI abilities CRUD
- `AiActionsController.php` — AI actions management (includes Composio integration)
- `AiInsightsController.php` — AI insights management
- `AiKnowledgeController.php` — Knowledge base management
- `AgentController.php` — Agent orchestration
- `JobsController.php` — Background job monitoring

**Agent Integration** (`Agent/`):
- `AbilityTestingWebhookController.php` — Ability testing webhook callbacks
- `AgentActionsController.php` — Agent action handlers
- `AgentIntegrationController.php` — Agent integration endpoints
- `AgentRegisterController.php` — Agent registration
- `AgentRunWebhookController.php` — Agent run webhook callbacks
- `AgentTranscriptionWebhookController.php` — Transcription webhook callbacks
- `SalesAgentIntegrationController.php` — Sales agent integration

**Core Business**:
- `ContactsController.php` — Central contact management (CRUD, favorites, tags, bulk ops)
- `InboxController.php` — Communication hub (compose, send, archive, transfer, recording)
- `TicketsController.php` — Support ticket management (kanban, CRUD, bulk ops)
- `InquiriesController.php` — Inquiry pipeline management (kanban, CRUD, bulk ops)
- `ChatsController.php` — AI chat sessions (streaming, session CRUD)
- `NotesController.php` — Notes management
- `NotificationController.php` — Notification center
- `OrganizationController.php` — Organization switching
- `OnboardingController.php` — Onboarding flow
- `UsersController.php` — User management
- `DeviceTokenController.php` — Device token CRUD
- `ChangelogController.php` — Product changelog
- `FeedbackController.php` — User feedback (bug reports, feature requests)
- `ReadResourceController.php` — Read tracking

**Settings** (`Settings/`):

*Account* (`Settings/Account/`):
- `A2PController.php` — A2P brand/campaign management
- `EmailsController.php` — Authenticated email channels
- `PhoneNumbersController.php` — Phone number management
- `PreferencesController.php` — Account preferences

*Team Security* (`Settings/Account/TeamSecurity/`):
- `AcceptInvitationController.php`, `InvitationsController.php`, `OrganizationDetailsController.php`, `TeamController.php`

*User Personal* (`Settings/User/Personal/`):
- `PasswordController.php`, `ProfileController.php`, `SessionsController.php`, `TwoFactorController.php`

*Product* (`Settings/Product/`):
- `InboxSettingsController.php`
- `Inquiries/PipelinesController.php`
- `Tickets/TicketPriorityController.php`, `TicketStatusController.php`, `TicketTypeController.php`

**Telnyx CPaaS Webhooks** (`Telnyx/`):
- `TelnyxCallController.php` — Abstract base for call control
- `TelnyxInboundWebhookController.php` — Inbound call webhooks (extends TelnyxCallController)
- `TelnyxOutboundWebhookController.php` — Outbound call webhooks (extends TelnyxCallController)
- `TelnyxSMSWebhookController.php` — SMS webhooks
- `TelnyxRCSWebhookController.php` — RCS messaging webhooks
- `TelnyxA2PWebhookController.php` — A2P registration webhooks
- `TelnyxMessagingProfileWebhookController.php` — Messaging profile webhooks
- `TelnyxNotificationsWebhookController.php` — Notification delivery webhooks

**Email Integration** (`Emails/`):
- `EmailViewerController.php` — Email preview/rendering
- `EmailWebhookController.php` — Email service webhooks (Gmail)

**API** (`Api/`):
- `DeviceTokenController.php` — Device token management for VoIP
- `VoipCredentialController.php` — VoIP credential endpoints
- `ApnsVoipTestController.php` — APNs VoIP testing

**Admin** (`Admin/`):
- `AdminAccessController.php` — Admin access control
- `AdminDashboardController.php` — Admin dashboard
- `AdminOrganizationsController.php` — Organization oversight
- `AdminUsersController.php` — User administration

**Auth** (`Auth/`):
- `AuthenticatedSessionController.php` — Login/logout
- `RegisteredUserController.php` — Registration
- `GoogleAuthController.php` — Google OAuth
- `TwoFactorController` (via personal settings) — Two-factor authentication
- Password reset, email verification controllers

**Billing** (`Billing/`):
- `BillingController.php` — Billing management (checkout, portal, subscription)
- `StripeWebhookController.php` — Stripe webhook handler

**Public** (`Public/`):
- `InquiryFormsController.php` — Public inquiry form rendering and submission

**Widget** (`Widget/`):
- `WidgetAuthController.php` — Widget authentication
- `WidgetController.php` — Widget API (conversations, messages)

**Other**:
- `Gmb/GmbWebhookController.php` — Google My Business webhooks
- `utils/AttachmentsController.php` — File attachment handling

#### 2.1.2 Services (`app/Services/`)

**Core Business Services**:
- `AgentService.php` — AI agent gateway communication (`gatewayRequest()` for HTTP to Python agent)
- `AgentStreamService.php` — Agent streaming responses
- `CPaaSService.php` — **Primary Telnyx integration** (543 lines): API client, webhook URL generation, credential/notification management, call control
- `OnboardingService.php` — Onboarding workflow logic

**Communication Services**:
- `PushNotificationService.php` — VoIP push notifications (FCM/APNs): `sendIncomingCallPush()`, `sendCallEndedPush()`
- `ApnsVoipService.php` — APNs VoIP-specific push logic

**Telnyx Domain** (`Telnyx/`):
- `A2PService.php` — A2P brand/campaign business logic
- `NotificationChannel.php` — Telnyx notification channels
- `NotificationProfile.php` — Notification profile management
- `Recording.php` — Call recording management

**Inbox** (`Inbox/Adapters/`):
- `EmailStorage.php` — Email storage adapter
- `GmailAdapter.php` — Gmail integration

**AI Studio** (`AIStudio/`):
- `Flow/FlowNormalizer.php` — AI flow normalization

**Inquiries** (`Inquiries/`):
- `InquiryPipelineWorkflowService.php` — Inquiry pipeline workflows

**Workflows** (`Workflows/`):
- `Workflow.php` — Base workflow orchestration
- `Decision.php` — Decision tree logic
- `FollowupWhileAbilityWorkflow.php` — Follow-up workflows
- `ProactiveSalesResponse.php` — Proactive sales automation

**Infrastructure**:
- `CurrentTenant.php` — Tenant context management
- `ObserverFlags.php` — Observer lifecycle flags
- `Utils.php` — Utility functions (includes `withinSchedule()` for agent scheduling)
- `GitHubService.php` — GitHub integration
- `VersionService.php` — Version management

#### 2.1.3 Models (`app/Models/`)

**Tenant-Aware Models** (use `BelongsToTenant` trait — 32 models):

| Model | Purpose |
|-------|---------|
| `Contact` | **Central data model** — all other apps connect to contacts |
| `Conversation` | Communication threads |
| `Message` | Individual messages (SMS, email, chat) |
| `Identifier` | Anonymous communication identifiers (phone/email before contact linking) |
| `Ticket` | Support tickets |
| `Inquiry` | Pipeline-based inquiries |
| `Note` | User notes |
| `Reminder` | Scheduled reminders |
| `AiAbility` | AI abilities/skills |
| `AiAction` | AI actions (API, MCP) |
| `AiActionGroup` | Action groupings |
| `AiInsight` | AI-generated insights |
| `AiKnowledgeItem` | Knowledge base items |
| `AiChatSession` | AI chat sessions |
| `AuthenticatedEmail` | Email channels |
| `AuthenticatedPhoneNumber` | Phone channels |
| `InquiryPipeline` | Pipeline configuration |
| `InquiryPipelineFlow` | Pipeline flow definitions |
| `InquiryPipelineSource` | Pipeline sources |
| `InquiryPipelineStage` | Pipeline stages |
| `InquiryField` | Custom inquiry fields |
| `TicketPriority`, `TicketStatus`, `TicketType` | Ticket configuration |
| `Attachment` | File attachments |
| `Tag` | Tags |
| `Notification` | Notifications |
| `OrganizationSetting` | Organization settings |
| `UserPreference` | User preferences |
| `Invitation` | Team invitations |
| `Ledger` | Usage ledger |
| `Wakeup` | Scheduled wakeups |

**Non-Tenant Models** (global/multi-tenant):
- `Organization` — **Tenant root model**
- `User` — Multi-tenant users
- `Subscription` — Billing subscriptions (Stripe/Cashier)
- `Activity` — Activity logging
- `ReadResource` — Read tracking
- `UserSession` — Session management
- `Integration` — Third-party integrations
- `UserTelnyxTelephonyCredential` — VoIP SIP credentials
- `UserDeviceToken` — FCM/APNs device tokens
- `AiChatMessage` — Chat messages (not tenant-scoped)
- `AbilityTestingMessage` — Testing messages

**Pivot Models** (`Pivots/`):
- `Assignment` — Assignment relationships
- `OrganizationUser` — Organization-user membership

#### 2.1.4 Observers (`app/Observers/`) — 23 observers

Observers handle complex model lifecycle logic, receiving data via temporary properties (`$model->_propertyName`) set by controllers.

- `ContactObserver` — Contact lifecycle (email/tag handling from temp properties)
- `ConversationObserver` — Conversation creation/updates
- `MessageObserver` — Message processing
- `IdentifierObserver` — Identifier management
- `TicketObserver` — Ticket lifecycle
- `InquiryObserver`, `InquiryPipelineObserver` — Inquiry processing
- `NoteObserver`, `ReminderObserver` — Note/reminder handling
- `AiAbilityObserver`, `AiActionObserver`, `AiKnowledgeItemObserver`, `AiChatMessageObserver` — AI Studio lifecycle
- `AuthenticatedEmailObserver`, `AuthenticatedPhoneNumberObserver` — Channel setup
- `OrganizationObserver` — Organization lifecycle (fires events)
- `UserObserver` — User lifecycle
- `SubscriptionObserver` — Subscription changes (fires events)
- `InvitationObserver` — Invitation processing
- `LedgerObserver` — Usage ledger entries
- `AssignmentObserver` — Assignment tracking
- `OrganizationUserObserver` — Team membership
- `TicketSettingDefaultObserver` — Ticket default settings

#### 2.1.5 Middleware (`app/Http/Middleware/`)

**Tenant & Access Control**:
- `SetCurrentTenant` — **Core multitenancy**: sets organization context from session
- `RequiresAdminAccess` — Admin-only route gate
- `EnsureUserIsActive` — Active user check

**Subscription & Billing**:
- `EnsureSubscription` — Subscription gate (blocks access without active subscription)

**Onboarding**:
- `EnsureEssentialOnboarding` — Essential onboarding completion check
- `RedirectToNextOnboardingStep` — Onboarding flow control

**Session & Tracking**:
- `TrackUserSession` — Session tracking
- `CheckSessionVersion` — Version-based session invalidation
- `AdjustMobileSessionLifetime` — Mobile session lifetime extension

**Inertia**:
- `HandleInertiaRequests` — Core Inertia middleware: shares auth, permissions, flash messages, VoIP JWT, onboarding, channel health
- `ShareLazyData` — Lazy-loaded shared data

**Other**:
- `GateRedirect` — Authorization-based redirects
- `ValidateWidgetToken` — Widget authentication
- `EnsureKnowledgebaseParentExists`, `RedirectKnowledgebaseSync` — Knowledge base guards
- `Settings/Product/Inquiries/InquiryPipelineStepAccessMiddleware` — Pipeline step access

#### 2.1.6 Events (`app/Events/`)

**Broadcastable (real-time via Reverb)**:
- `IncomingCallNotification` — Broadcasts incoming VoIP call to user's web sessions
- `CallEndedNotification` — Broadcasts call ended to dismiss UI across devices
- `OrganizationSwitched` — Broadcasts org switch to all user tabs
- `AgentScheduleUpdated` — Agent schedule change notifications

**Organization Lifecycle** (`Events/Organizations/`): 12 events
- `OrganizationCreated`, `OrganizationDeleted`, `OrganizationRestored`, `OrganizationSuspended`
- `OrganizationTrialStarted`, `OrganizationTrialEnded`
- `OrganizationPaymentSucceeded`, `OrganizationPaymentFailed`
- `OrganizationSubscriptionActivated`, `OrganizationSubscriptionCancelled`, `OrganizationSubscriptionScheduledForCancellation`, `OrganizationSubscriptionUpgraded`

**Other**:
- `Contacts/ContactDeleting` — Contact deletion lifecycle

#### 2.1.7 Jobs (`app/Jobs/`)

**AI Studio** (`AIStudio/`):
- `BatchInsightEvaluationJob` — Batch AI insight evaluation
- `CreateAbilityTestingRunJob` — Ability testing execution
- `ProcessGmbProfileWebhookJob`, `ProcessGmbScrapeWebhookJob` — GMB processing
- `SyncKnowledgebaseJob` — Knowledge base sync

**Inbox** (`Inbox/`):
- `CreateAgentRunJob` — Create AI agent run
- `ProcessEmailWebhookJob` — Email webhook processing
- `SendEmailJob` — Email sending
- `SendSMSJob` — SMS sending

**Workflows** (`Workflows/`):
- `HandleWorkflowComputeBulk` — Bulk workflow computation

**Other**:
- `HandleA2PCampaignSuccess` — A2P campaign activation
- `ReportMeterEvent` — Usage metering to Stripe

**Job Infrastructure**:
- `Concerns/InteractsWithTenant` — Tenant awareness trait for jobs
- `Contracts/TenantAware` — Tenant awareness contract
- `Middleware/SetCurrentTenant` — Job-level tenant middleware
- Queue driver: `database` (PostgreSQL)

#### 2.1.8 Listeners (`app/Listeners/`)

**Organization Listeners** (`Organizations/`): 26+ listeners
- Logging: `LogOrganizationCreated`, `LogOrganizationDeleted`, etc. (12 logging listeners)
- Notifications: `SendOrganizationCreatedNotification`, etc. (13 notification listeners)

**Customer Billing** (`Customers/`):
- `SendCancellationEmailToCustomer`, `SendInvoiceReceiptToCustomer`
- `SendScheduledCancellationEmailToCustomer`, `SendTrialReceiptToCustomer`

**Contacts** (`Contacts/`):
- `CleanContactMemories` — Cleanup on contact deletion

**Global**:
- `RecomputeAgentWorkflows` — Recompute workflows on agent/schedule changes
- `SetSessionVersion` — Version tracking

#### 2.1.9 Traits (`app/Traits/`) — 13 traits

**Model Traits**:
- `BelongsToTenant` — **Core multitenancy**: auto-scopes all queries to current organization
- `HasAvatar` — Avatar file upload/processing
- `HasSlug` — URL slug generation
- `Taggable` — Polymorphic tag relationships
- `Ownable` — Ownership tracking
- `Assignable` — Assignment relationships
- `Mentionable` — User @mentions
- `MarkableAsRead` — Read/unread tracking
- `LogsActivity` — Activity audit logging
- `IsComposition` — Composition pattern support

**Controller/Utility Traits**:
- `NormalizeRequests` — Request data normalization
- `InstanceCache`, `StaticCache` — Caching strategies

#### 2.1.10 Enums (`app/Enums/`) — 39 enum classes

**Communication**: `ConversationType`, `IdentifierType`, `MessageDirection`, `MessageStatus`, `MessageType`, `AttachmentType`, `NotificationType`
**AI Studio**: `ActionType`, `ActionParameterType`, `ActionParameterFormat`, `HttpMethod`, `MCPTransport`, `CanvasNodeKind`, `IntegrationType`, `KnowledgeItemType`, `InsightAgentType`, `InsightStatus`, `InsightType`, `SyncStatus`
**Phone/A2P**: `A2PBrandStatus`, `A2PCampaignStatus`, `A2PFormStatus`, `AuthenticatedPhoneNumberStatus`
**Email**: `AuthenticatedEmailStatus`, `AuthenticatedEmailAPIType`
**Organization**: `OrganizationActivityStatus`, `OrganizationStatusReason`, `OrganizationSubscriptionStatus`, `Role`, `UserStatus`
**Inquiry**: `InquiryStatus`, `PipelineStep`, `DropLeadAction`, `FormSubmitAction`
**Onboarding**: `OnboardingEssentialStep`, `OnboardingSkippableStep`
**Other**: `LedgerUnit`, `WakeupStatus`

#### 2.1.11 Form Requests (`app/Http/Requests/`) — 60+ classes

Validation logic extracted from controllers into dedicated Form Request classes, organized by domain: AIStudio (Abilities, Actions, KnowledgeBase, Insights), Agent, Contacts, Inbox, Tickets, Inquiries, Settings (Account, Phone, Email, Team, Product), Onboarding, Public, Widget, Feedback, Auth, API.

#### 2.1.12 MCP Server (`app/Mcp/`)

**Server**: `Servers/McpServer.php` — "Z360 Server" with 45 registered tools

**Tool Categories** (`Tools/`):
- **Abilities** (15 tools): ListActions, GetActionDetails, ListAbilities, GetAbilityFlow, GetAbilityLayout, CreateAbility, UpdateAbility, DeleteAbility, AutoFixLayout, CreateNodes, UpdateNodes, ConnectNodes, DisconnectNodes, DeleteNodes, ValidateFlow
- **Contacts** (4 tools): SearchContacts, CreateContact, UpdateContact, DeleteContact
- **Conversations** (7 tools): CreateConversation, UpdateConversation, DeleteConversation, SearchConversation, CreateReminder, WriteNote, ListChannels
- **Tickets** (5 tools): ListTicketOptions, CreateTicket, UpdateTicket, DeleteTicket, SearchTickets
- **Inquiries** (5 tools): ListInquiryOptions, SearchInquiries, CreateInquiry, UpdateInquiry, DeleteInquiry
- **Insights** (5 tools): CreateCustomerInsights, UpdateCustomerInsights, SearchCustomerInsights, ListCustomerInsights, DeleteCustomerInsights
- **Users** (1 tool): ListAssignees

**Shared Concerns** (`Tools/Concerns/`): HandlesAssignments, HandlesDateRanges, UsesFuzzySearch, SupportsBatchQueries, SupportsPagination, ValidatesOrganizationContext

**Endpoint**: `routes/mcp.php` → `POST /mcp/{organization}`

---

### 2.2 React/Inertia Frontend

#### 2.2.1 App Entry Point

**File**: `resources/js/app.tsx`

- `createInertiaApp` resolves pages from `./pages/**/*.tsx` and `./mobile/pages/**/*.tsx`
- **UI variant detection**: Native platform → "mobile"; Web → responsive breakpoint at 767px with mobile-first fallback
- **Global layout**: `GlobalAppLayout` applied to all pages except `auth/`, `inquiries/public/`, `onboarding/`
- **Laravel Echo**: Configured for Reverb WebSocket connection
- **Initialization**: bootStorage, modal init, toast setup, theme init, keyboard init

#### 2.2.2 Pages (`resources/js/pages/`) — 200+ page components

| Domain | Key Pages | Description |
|--------|-----------|-------------|
| `admin/` | dashboard, organizations (index/show), users (index/show) | Platform administration |
| `ai-studio/` | agent, abilities (list/detail/flow canvas), actions (list/API/MCP), knowledge-base (browser/document/sync/upload), playground, jobs, insights | AI Studio workspace |
| `auth/` | login, register, forgot-password, reset-password, verify-email, 2FA challenge, Google OAuth | Authentication |
| `billing/` | get-started, status | Subscription management |
| `chats/` | index (AI assistant), history dialog | AI chat interface |
| `contacts/` | index (table/card), contact detail, create-inquiry | Contact management |
| `inbox/` | index, new-conversation, transfer dialog | Communication hub |
| `inquiries/` | index (kanban/table), inquiry dialog, add dialog, public form | Inquiry pipeline |
| `tickets/` | index (kanban/table), ticket detail | Support tickets |
| `settings/` | user (profile, password, sessions, 2FA, notifications), account (billing, emails, phone-numbers, team, org details), product (inbox, inquiries pipelines, ticket config) | Settings hub |
| `dashboard.tsx` | Main dashboard | Dashboard |
| `onboarding/` | getting-started, form steps 1-3, help pages | Onboarding flow |
| `changelog/` | index | Changelog viewer |
| `notifications/` | index | Notification center |
| `mobile/pages/` | Mobile-optimized inbox, tickets, inquiries, contacts, dialpad | Mobile experience |

#### 2.2.3 Layouts (`resources/js/layouts/`)

- `app-layout.tsx` — Main app layout (wraps content with GlobalAppLayout provider hierarchy)
- `settings-layout.tsx` — Settings page layout
- `auth-layout.tsx` — Authentication page layout
- `onboarding-layout.tsx` — Onboarding flow layout

#### 2.2.4 Provider Hierarchy

Nesting order (outermost → innermost), defined in `app-layout.tsx` and `app.tsx`:

```
AppErrorBoundary
  └─ GlobalToastProvider (Sonner)
      └─ ModalStackProvider (InertiaUI)
          └─ [Platform-conditional VoIP Provider]
              ├─ Web: TelnyxRTCProvider (WebRTC)
              └─ Native: NativeVoipProvider (no WebSocket)
                  └─ DialpadProvider (call state management)
                      └─ SidebarProvider (sidebar state)
                          └─ NativeStatusBarSync
                              └─ Page Content
```

**Additional Context Providers** (page-level):
- `BulkSelectContext` (`components/bulk-select/bulk-select-context.tsx`) — Bulk selection state
- `DialpadContext` (`components/identifier-details-sidebar/dialpad/context.tsx`) — Dialpad call state
- `SidebarDetailContext` (`components/identifier-details-sidebar/context/sidebar-detail-context.tsx`) — Sidebar detail state
- `InboxContext` (`pages/inbox/context.tsx`) — Inbox-specific state
- `AbilityCanvasContext` (`pages/ai-studio/abilities/contexts/ability-canvas-context.tsx`) — Ability flow canvas
- `FormContext` (`pages/ai-studio/abilities/contexts/form-context.tsx`) — Ability form state
- `WidgetContext` (`widget/context.tsx`) — Widget-specific state

#### 2.2.5 Custom Hooks (`resources/js/hooks/`)

**Core State**:
- `useQueryController.ts` — URL parameter management (search, filters, pagination)
- `useFilterDialog.ts` — Filter dialog state management
- `useDeleteDialog.ts` — Delete confirmation flow
- `useSort.ts` — Sorting state management
- `usePermissions.ts` — Permission checking (gates)
- `useLocalStorage.ts` — localStorage persistence
- `useSessionCache.ts` — Session-based caching
- `useInertiaLazyCache.ts` — Inertia lazy data caching
- `useLoadUntilFilled.ts` — Progressive loading until viewport filled

**Platform**:
- `use-appearance.tsx` — Theme/appearance management (dark/light mode)
- `useEnv.ts` — Environment variable access
- `useNetworkStatus.ts` — Network connectivity monitoring
- `useNativeKeyboardResize.ts` — Native keyboard resize handling

**VoIP/Communication**:
- `useWebVoipCredentials.ts` — Web VoIP credential management
- `use-push-notifications.ts` — Push notification registration

**Real-time**:
- `use-notification-broadcast.ts` — Broadcast channel notifications with sound

**Utility**:
- `useCountdown.ts` — Countdown timer

#### 2.2.6 Key Components (`resources/js/components/`)

**UI Primitives** (`ui/`): 40+ ShadCN-based components (accordion, button, dialog, form-builder, kanban, tiptap editor, chart, etc.)

**Feature Components**:
- `identifier-details-sidebar/` — Contact/identifier sidebar with sub-components: activities, AI control, dialpad, reminders, tags, threads, tickets, attachments
- `identifier-details-sidebar/dialpad/` — VoIP dialer: call-as-select, call display, dialer keypad
- `bulk-select/` — Bulk selection UI (checkbox, context, dropdown)
- `organizations/` — Organization management (create dialog, switched dialog)
- `onboarding/` — Onboarding step components
- `universal/` — Shared: help popover, layouts, error boundary, app sidebar, mobile sidebar, channel health banner, super admin banner
- `ui/ai-elements/` — AI chat UI (conversation, prompt input, response, actions, reasoning)
- `ui/form-builder/` — Dynamic form builder with multiple field types
- `ui/kanban.tsx` — Drag-and-drop kanban board
- `ui/minimal-tiptap/` — Rich text editor (TipTap)

#### 2.2.7 TypeScript Types (`resources/js/types/`)

- `index.d.ts` — Main type definitions barrel
- `global.d.ts` — Global declarations (window extensions, `env()` function)
- `models.ts` — Model type definitions (Contact, Conversation, User, Organization, etc.)
- `notifications.ts` — Notification type definitions
- `inertiaui-modal.d.ts` — InertiaUI modal type extensions
- `vite-env.d.ts` — Vite environment types

---

### 2.3 Real-Time Layer

#### 2.3.1 WebSocket Server

**Technology**: Laravel Reverb
**Config**: `config/reverb.php`, `config/broadcasting.php`
**Protocol**: WebSocket (wss://)

#### 2.3.2 Custom Channel Classes (`app/Broadcasting/`)

- `TenantPrivateChannel` — Tenant-scoped private channels (format: `org.{org_id}.{name}`)
- `TenantPresenceChannel` — Tenant-scoped presence channels
- `TenantChannel` — Base tenant channel abstraction

#### 2.3.3 Channel Authorization (`routes/channels.php`)

- `org.{org_id}.App.Models.User.{id}` — Per-user private channel (verifies user belongs to org)
- `org.{org_id}.App.Models.Conversation.{id}` — Per-conversation channel
- `org.{org_id}.App.Models.AbilityTesting.{id}` — AI ability testing channel

#### 2.3.4 Frontend Broadcast Listeners

- `hooks/use-notification-broadcast.ts` — Global notification broadcasts with sound alerts
- `pages/inbox/components/conversations/broadcast.ts` — Conversation list updates
- `pages/inbox/components/chat/broadcast.ts` — Chat message updates
- `pages/ai-studio/playground/broadcast.ts` — AI Studio playground updates
- `widget/broadcasts.ts` — Widget real-time updates
- `components/organizations/organization-switched-dialog.tsx` — Org switching detection
- `components/identifier-details-sidebar/dialpad/context.tsx` — VoIP call state updates

#### 2.3.5 Broadcast Events

| Event | Channel | Purpose |
|-------|---------|---------|
| `IncomingCallNotification` | User private | Incoming VoIP call alert (web) |
| `CallEndedNotification` | User private | Call ended dismissal (web) |
| `OrganizationSwitched` | User private | Org switch across tabs |
| `AgentScheduleUpdated` | Org channel | Agent schedule changes |

---

### 2.4 Routing & API Layer

#### 2.4.1 Web Routes

**Main entry**: `routes/web.php` — Requires `auth`, `verified`, `ensure-essential-onboarding`, `ensure-subscription`

**Organization routes** (`routes/organization/`): 16 route files
- `contacts.php`, `inbox.php`, `tickets.php`, `inquiries.php`, `chats.php`
- `ai-studio.php`, `agent.php`, `settings.php`, `billing.php`
- `organizations.php`, `users.php`, `notifications.php`, `notes.php`
- `device-tokens.php`, `feedback.php`, `widget.php`

**Admin routes**: `routes/admin.php` — Admin dashboard, organization/user management (requires `requires-admin-access`)
**Auth routes**: `routes/auth.php` — Login, register, OAuth, 2FA, email verification, password reset
**Onboarding routes**: `routes/onboarding.php` — Getting started flow, form steps
**MCP routes**: `routes/mcp.php` — `POST /mcp/{organization}` (MCP server endpoint)
**Utility routes**: `routes/utils.php` — TipTap upload, email viewer, read tracking, `/me` API
**Public routes**: `routes/public/inquiry-forms.php` — Public inquiry forms (show, embed, submit)

#### 2.4.2 REST API (`routes/api.php`)

**Public**:
- `GET /health` — Health check

**Authenticated** (web + auth + set-current-tenant):
- `POST /device-tokens` — Register device token
- `DELETE /device-tokens/{deviceId}` — Remove device token
- `GET /device-tokens` — List device tokens
- `GET /voip/credentials` — Get VoIP credentials
- `POST /voip/switch-org` — Switch org for VoIP context

**Test** (local/staging/development only):
- `POST /test/mock-incoming-call` — Mock incoming call push notification
- `POST /test/apns-voip` — Test APNs VoIP push

#### 2.4.3 Webhook Endpoints (`routes/webhooks.php`)

All webhook routes are **public** (no auth/tenant middleware — routing determined by payload content):

| Endpoint | Controller | Purpose |
|----------|-----------|---------|
| `POST /webhooks/stripe` | `StripeWebhookController` | Billing events |
| `POST /webhooks/emails/gmail` | `EmailWebhookController` | Gmail push notifications |
| `POST /webhooks/cpaas/telnyx/notifications` | `TelnyxNotificationsWebhookController` | General Telnyx notifications |
| `POST /webhooks/cpaas/telnyx/call-control` (+failover) | `TelnyxInboundWebhookController` | Inbound call control |
| `POST /webhooks/cpaas/telnyx/credential` (+failover) | `TelnyxOutboundWebhookController` | Outbound credential calls |
| `POST /webhooks/cpaas/telnyx/a2p` (+failover) | `TelnyxA2PWebhookController` | A2P campaign events |
| `POST /webhooks/cpaas/telnyx/sms` (+failover) | `TelnyxSMSWebhookController` | SMS delivery/receipt |
| `POST /webhooks/cpaas/telnyx/rcs` (+failover) | `TelnyxRCSWebhookController` | RCS messaging events |
| `POST /webhooks/ai/run` | `AgentRunWebhookController` | Agent execution callbacks |
| `POST /webhooks/ai/run/testing` | `AbilityTestingWebhookController` | Ability testing callbacks |
| `POST /webhooks/ai/transcription/{message}` | `AgentTranscriptionWebhookController` | Transcription results |
| `POST /webhooks/gmb/profile/{token}` | `GmbWebhookController` | GMB profile events |
| `POST /webhooks/gmb/scrape/{token}` | `GmbWebhookController` | GMB scrape events |

---

### 2.5 AI Agent System

#### 2.5.1 Agent Gateway (External Python Service)

**Configuration** (`config/services.php`):
- Base URL: `AGENT_GATEWAY_BASE_URL` (default: `https://gateway.staging.z360-agent-layer.z360.biz/`)
- SIP endpoint: `AGENT_SIP_URL` (LiveKit SIP integration)

**Communication**: `AgentService.php` → HTTP requests to Python gateway via `gatewayRequest()`

**Data Flow**: Laravel → AgentService → HTTP → Python Gateway → AI Model → MCP Tools → Back to Laravel

#### 2.5.2 MCP Server

The MCP server (`app/Mcp/Servers/McpServer.php`) exposes 45 tools that the Python AI agent can call back into Z360 to read/write data. The agent gateway makes MCP tool calls to `POST /mcp/{organization}`.

#### 2.5.3 Agent Webhooks

The Python agent gateway sends execution results back via webhooks:
- `POST /webhooks/ai/run` — Agent run completion/progress
- `POST /webhooks/ai/run/testing` — Ability testing results
- `POST /webhooks/ai/transcription/{message}` — Audio transcription results

---

## 3. Data Flow Diagrams

### 3.1 HTTP Request Lifecycle (Inertia SPA)

```
Browser (React SPA)
  │
  ├─ [Inertia visit] ──→ Laravel Router ──→ Middleware Stack ──→ Controller
  │                        routes/web.php     SetCurrentTenant      │
  │                        routes/org/*.php   EnsureSubscription     │
  │                                           HandleInertiaRequests  │
  │                                                                  │
  │                                           ┌──────────────────────┘
  │                                           │
  │                                           ▼
  │                                     Form Request (validation)
  │                                           │
  │                                           ▼
  │                                     Model + Observer
  │                                     (business logic)
  │                                           │
  │                                           ▼
  │                                     PostgreSQL
  │                                           │
  │                                           ▼
  │  ◄─── [Inertia JSON response] ◄── Inertia::render('page', $props)
  │
  ▼
React Page Component (receives props)
```

### 3.2 Real-Time Flow (WebSocket Broadcasting)

```
Server-side Event
  │
  ▼
Laravel Event (implements ShouldBroadcast)
  │
  ▼
Broadcasting System
  │
  ▼
Laravel Reverb (WebSocket Server)
  │
  ▼ (wss://)
Laravel Echo (Frontend JS Client)
  │   resources/js/app.tsx (Echo config)
  │
  ▼
Broadcast Listener Hook
  │   e.g., use-notification-broadcast.ts
  │   e.g., pages/inbox/components/chat/broadcast.ts
  │
  ▼
React State Update → UI Re-render
```

### 3.3 Webhook Processing Flow

```
External Service (Telnyx / Stripe / Gmail / GMB)
  │
  ▼ (HTTP POST)
Webhook Route (/webhooks/*)
  │   routes/webhooks.php (no auth middleware)
  │
  ▼
Webhook Controller
  │   Validates signature / payload
  │   Parses structured Data objects (spatie/laravel-data)
  │
  ├──→ Dispatch Job (async) ──→ Queue Worker ──→ Business Logic ──→ DB
  │
  └──→ Direct Processing ──→ Model Update ──→ Broadcast Event ──→ Reverb
```

### 3.4 AI Agent Flow

```
User (Chat / Inbox / Ability Test)
  │
  ▼
Laravel Controller (ChatsController / InboxController)
  │
  ▼
AgentService.gatewayRequest()
  │
  ▼ (HTTP)
Python AI Agent Gateway
  │   (External service at gateway.*.z360-agent-layer.z360.biz)
  │
  ├──→ AI Model (LLM processing)
  │
  ├──→ MCP Tool Calls ──→ POST /mcp/{org} ──→ McpServer ──→ Tool Execution
  │                                                             │
  │                                                             ▼
  │                                                        PostgreSQL
  │
  └──→ Webhook Callback ──→ POST /webhooks/ai/run ──→ AgentRunWebhookController
                                                           │
                                                           ▼
                                                    Broadcast Event → Reverb → Client
```

### 3.5 VoIP Inbound Call Flow

```
PSTN Caller
  │
  ▼
Telnyx Platform
  │
  ▼ (HTTP POST)
POST /webhooks/cpaas/telnyx/call-control
  │
  ▼
TelnyxInboundWebhookController
  │   Parses webhook → extracts client_state JWT → resolves user/org
  │
  ├──→ CPaaSService (call control commands back to Telnyx API)
  │
  ├──→ PushNotificationService.sendIncomingCallPush()
  │       │
  │       ├──→ FCM (Android push)
  │       └──→ APNs VoIP (iOS push)
  │
  └──→ IncomingCallNotification Event
          │
          ▼
        Reverb Broadcast → Echo → DialpadContext → Ringing UI (web)
```

### 3.6 Multitenancy Data Flow

```
Request arrives
  │
  ▼
SetCurrentTenant Middleware
  │   Reads org from session (or auth context)
  │   Sets Organization::current()
  │
  ▼
BelongsToTenant Trait (on 32 models)
  │   Adds global scope: WHERE organization_id = current_org_id
  │   Auto-sets organization_id on model creation
  │
  ▼
All queries automatically scoped to tenant
  │
  Exception: Model::withoutGlobalScope(TenantScope::class)  ← Admin bypass
```

---

## 4. External Boundaries

### 4.1 Outbound Connections (Z360 → External)

| Service | Protocol | Purpose | Config File |
|---------|----------|---------|-------------|
| **Telnyx API** | HTTPS | Voice calls, SMS, RCS, A2P, phone numbers, SIP credentials | `config/cpaas.php` |
| **Stripe API** | HTTPS | Billing, subscriptions, metered usage (via Laravel Cashier) | `config/cashier.php` |
| **AI Agent Gateway** | HTTPS | AI agent execution, ability testing, transcription | `config/services.php` → `agent.gateway` |
| **Firebase FCM** | HTTPS | Android push notifications | `config/firebase.php` |
| **APNs** | HTTP/2 | iOS VoIP push notifications | `config/services.php` → `apns_voip` |
| **Google APIs** | HTTPS | Gmail, Calendar, Sheets, Drive, OAuth | `config/services.php` → `google` |
| **Composio** | HTTPS | Third-party integration orchestration (40+ services) | `config/integrations.php` |
| **LiveKit** | SIP | Agent SIP endpoint for voice | `config/services.php` → `agent.sip_endpoint` |
| **MarkItDown** | CLI | Document conversion (Python subprocess) | `config/markitdown.php` |

### 4.2 Inbound Connections (External → Z360)

| Source | Endpoint | Purpose |
|--------|----------|---------|
| **Telnyx** | `/webhooks/cpaas/telnyx/*` (8 endpoints + failovers) | Call control, SMS, RCS, A2P, notifications |
| **Stripe** | `/webhooks/stripe` | Billing events (payment, subscription changes) |
| **Gmail** | `/webhooks/emails/gmail` | Email notifications (Google PubSub) |
| **AI Agent Gateway** | `/webhooks/ai/*` (3 endpoints) | Agent run results, testing, transcription |
| **AI Agent Gateway** | `/mcp/{organization}` | MCP tool calls (45 tools) |
| **Google My Business** | `/webhooks/gmb/*` (2 endpoints) | Profile and scrape data |
| **Public Users** | `/inquiry/forms/*` | Public inquiry form submissions |
| **Widget Users** | `/widget/*` | Widget conversations and messages |
| **Mobile Apps** | `/api/*` | Device tokens, VoIP credentials |

### 4.3 External Boundary Diagram

```
                    ┌──────────────────────────────────────────┐
                    │              Z360 Platform                │
                    │                                          │
 Telnyx ◄──────────┤  CPaaSService         Webhook Controllers │◄──── Telnyx
 (API calls)       │                                          │  (webhooks)
                    │                                          │
 Stripe ◄──────────┤  Laravel Cashier      StripeWebhookCtrl  │◄──── Stripe
 (billing)         │                                          │  (webhooks)
                    │                                          │
 AI Gateway ◄──────┤  AgentService         AgentRunWebhookCtrl│◄──── AI Gateway
 (agent runs)      │                       McpServer           │  (callbacks + MCP)
                    │                                          │
 FCM / APNs ◄──────┤  PushNotificationSvc                     │
 (push notifs)     │  ApnsVoipService                         │
                    │                                          │
 Google APIs ◄─────┤  GmailAdapter         EmailWebhookCtrl   │◄──── Gmail
 (email/OAuth)     │                       GmbWebhookCtrl     │◄──── GMB
                    │                                          │
 Composio ◄────────┤  AiActionsController                     │
 (integrations)    │                                          │
                    │                                          │
 LiveKit ◄─────────┤  Agent SIP endpoint                      │
 (voice SIP)       │                                          │
                    │                                          │
 Browsers ◄────────┤  Reverb (WebSocket)   Inertia (HTTP)     │◄──── Browsers
                    │                                          │
 Mobile Apps ◄─────┤  API endpoints        Push notifications  │◄──── Mobile Apps
                    │                                          │
 Public ◄──────────┤  Inquiry forms        Widget API          │◄──── Public
                    └──────────────────────────────────────────┘
```

---

## 5. Multitenancy Architecture

### 5.1 Tenant Model

- **Tenant root**: `Organization` model (`app/Models/Organization.php`)
- **Tenant context**: Session-based organization switching
- **Current tenant**: `Organization::current()` / `CurrentTenant` service (`app/Services/CurrentTenant.php`)
- **Switch tenant**: `$organization->switchTo()` (stores in session)

### 5.2 Tenant Isolation Layers

| Layer | Mechanism | File Reference |
|-------|-----------|----------------|
| **HTTP Middleware** | `SetCurrentTenant` reads org from session, sets context | `app/Http/Middleware/SetCurrentTenant.php` |
| **Model Scoping** | `BelongsToTenant` trait adds global scope `WHERE org_id = ?` | `app/Traits/BelongsToTenant.php` |
| **Migration Macro** | `$table->organization()` adds tenant foreign key | Database migrations |
| **Job Middleware** | `SetCurrentTenant` job middleware restores tenant in queue workers | `app/Jobs/Middleware/SetCurrentTenant.php` |
| **Job Trait** | `InteractsWithTenant` serializes tenant context for async jobs | `app/Jobs/Concerns/InteractsWithTenant.php` |
| **Broadcasting** | `TenantPrivateChannel` prefixes channels with `org.{id}` | `app/Broadcasting/TenantPrivateChannel.php` |
| **Admin Bypass** | `Model::withoutGlobalScope(TenantScope::class)` for admin queries | Used in Admin controllers |

### 5.3 Authorization

**Gates** (defined in `app/Providers/AuthServiceProvider.php`):
- `manage_billing` — Owner only
- `manage_account_settings` — Owner + Admin
- `manage_product_settings` — Owner + Admin
- `manage_agent` — Owner + Admin

**Roles**: Defined via `app/Enums/Role.php` enum

**Frontend access**: Gates shared via `HandleInertiaRequests` middleware as `auth.gates` prop, consumed by `usePermissions` hook.

---

## 6. Configuration Surface Area

All configuration files in `config/`:

| File | Purpose |
|------|---------|
| `app.php` | Application fundamentals (name, env, debug, URL, timezone) |
| `auth.php` | Authentication guards (`web`, `guest-only`), Eloquent provider |
| `broadcasting.php` | Reverb WebSocket driver configuration |
| `cache.php` | Cache drivers |
| `cashier.php` | Stripe billing (Laravel Cashier) |
| `cpaas.php` | Telnyx CPaaS credentials and IDs |
| `database.php` | PostgreSQL connection |
| `filesystems.php` | Storage disks configuration |
| `firebase.php` | Firebase/FCM credentials |
| `inertia.php` | Inertia.js SPA configuration |
| `integrations.php` | 40+ third-party OAuth integration definitions |
| `logging.php` | Log channels |
| `mail.php` | Email configuration |
| `markitdown.php` | Python document processor path |
| `queue.php` | Job queue (database driver default) |
| `reverb.php` | Reverb WebSocket server settings |
| `rcs.php` | RCS messaging configuration |
| `services.php` | External service credentials (Google, Firebase, APNs, Agent Gateway, Slack) |
| `session.php` | Session configuration |
| `activities.php` | Activity tracking |
| `actions.php` | AI actions configuration |
| `feedback.php` | Feedback system |
| `two-factor.php` | 2FA settings |

---

## 7. Key Architectural Patterns

### 7.1 Controller Orchestration Pattern
Controllers are thin orchestrators. Validation lives in Form Requests. Business logic lives in Observers and Services. Data passes from controllers to observers via temporary properties (`$model->_propertyName`).

**Reference**: `app/Http/Controllers/ContactsController.php` → `app/Http/Requests/Contacts/Store.php` → `app/Observers/ContactObserver.php`

### 7.2 Observer-Heavy Architecture
23 model observers handle creation, update, and deletion side effects. This keeps controllers thin but creates implicit execution paths.

### 7.3 Server-State via Inertia Props
Frontend state management relies on Inertia props from the server (not client-side stores like Redux). Only UI-local state uses `useState`. Forms use Inertia's `useForm` hook.

### 7.4 Platform-Aware Frontend
The frontend detects native vs web platforms and conditionally loads providers (TelnyxRTCProvider for web WebRTC, NativeVoipProvider for Capacitor bridge). Page resolution tries mobile variants first on small screens.

### 7.5 Webhook-Driven Integration
External services communicate via webhooks (13+ endpoints). Webhooks are processed without auth middleware — routing determined by payload content (e.g., JWT client_state for Telnyx).

---

*Document generated: 2026-02-08*
*Source: Z360 codebase exploration via skills and direct file search*
