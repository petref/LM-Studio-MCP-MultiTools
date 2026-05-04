# TODO

Concrete execution backlog to turn this project into a meaningful coding assistant that can be monetized for:

- local private deployments
- team self-hosted deployments
- managed cloud deployments

This backlog is intentionally biased toward achievable product steps, not generic wishlist items.

## Product Goal

Build a governed, local-first AI workspace for engineering teams that need:

- code-aware assistance on private repositories
- self-hosted or OpenAI-compatible model support
- controlled file operations
- team governance
- monetizable admin and deployment capabilities

## Priority Rules

Build in this order:

1. Trust and safety foundations
2. Team and governance features
3. Git and delivery workflow integration
4. Packaging and deployment
5. Monetization controls and admin analytics
6. Ecosystem and extensibility

## Phase 1: Make It Trustworthy For Real Use

Goal: turn the current prototype into a reliable single-user product that can be used daily.

### Core reliability

- [ ] Replace ad hoc runtime persistence with a formal config/state service abstraction.
- [ ] Add schema validation for all runtime, UI state, and API payloads.
- [ ] Add structured server logs with request ids, project ids, and chat ids.
- [ ] Add global error normalization for API and SSE responses.
- [ ] Add restart-safe recovery for interrupted chats and tool runs.

### File safety and change control

- [ ] Add explicit write modes: `read-only`, `ask-before-write`, `allow-within-trusted-roots`.
- [ ] Add dry-run preview for `create_file`, `rewrite_file`, and `apply_patch`.
- [ ] Add file diff preview in UI before applying write actions.
- [ ] Add per-project tool allowlist configuration.
- [ ] Add immutable write history entries for every file mutation.

### Testing

- [ ] Add tests for every write path: create, rewrite, patch, directory create.
- [ ] Add tests for trust-boundary bypass attempts.
- [ ] Add tests for malformed tool calls and large payload rejection.
- [ ] Add regression tests for multi-project state persistence.
- [ ] Add CI workflow to run smoke and RAG tests on every push.

### UX cleanup

- [ ] Split the single-file dashboard UI into maintainable modules/components.
- [ ] Improve chat transcript readability for long tool-heavy sessions.
- [ ] Add project onboarding flow for first-time users.
- [ ] Add explicit read-only banner when writes are disabled.

## Phase 2: Make It A Real Coding Assistant

Goal: improve daily developer usefulness so the product is not just a controlled chat wrapper.

### Better repository understanding

- [ ] Add repository indexing/cache for faster large-repo navigation.
- [ ] Add symbol-aware search and file summaries.
- [ ] Add saved repository overview per project.
- [ ] Add “architecture summary” generation and caching.
- [ ] Add prompt shortcuts for review, refactor, explain, and implementation planning.

### Better coding workflows

- [ ] Add branch-aware project settings.
- [ ] Add local git status, diff, and changed-files visibility in the UI.
- [ ] Add “propose change” mode that produces diffs without auto-writing.
- [ ] Add “apply approved diff” workflow.
- [ ] Add message-to-task conversion for follow-up work.

### Better model operations

- [ ] Add per-project model profiles with named presets.
- [ ] Add fallback model support when the primary endpoint fails.
- [ ] Add model routing by task type: chat, retrieval, refactor, analysis.
- [ ] Add prompt template library per project/team.
- [ ] Add reusable task/workflow templates.

## Phase 3: Add Team Features

Goal: move from useful local tool to something teams can adopt and pay for.

### Identity and workspace model

- [ ] Introduce users, organizations, and team workspaces.
- [ ] Move from shared token auth to session-based authentication.
- [ ] Add project ownership and workspace membership.
- [ ] Add role model: `viewer`, `operator`, `maintainer`, `admin`.
- [ ] Add per-role permissions for read, write, patch, export, and admin actions.

### Shared collaboration

- [ ] Add shared projects and shared chats.
- [ ] Add comments and annotations on chats or tool results.
- [ ] Add saved analyses and shareable project views.
- [ ] Add import/export for team project templates.
- [ ] Add activity feed for project changes.

### Governance

- [ ] Add approval queues for file writes and patches.
- [ ] Add per-project trusted-root policies managed by admins.
- [ ] Add policy-controlled tool enablement by role.
- [ ] Add retention settings for chats and logs.
- [ ] Add audit trail views in the UI.

## Phase 4: Add Git And Delivery Integrations

Goal: connect the assistant to the real software delivery loop.

### Git provider integration

- [ ] Add GitHub integration for repo connection and PR creation.
- [ ] Add GitLab integration for repo connection and MR creation.
- [ ] Add branch selection and branch creation from the UI.
- [ ] Add commit creation from approved diffs.
- [ ] Add issue linking between chats and Git tasks.

### Delivery workflows

- [ ] Add PR summary generation.
- [ ] Add review mode for changed files.
- [ ] Add issue-to-implementation planning flow.
- [ ] Add CI status display for active branches/PRs.
- [ ] Add “fix failing build” workflow using CI feedback.

### Business value export

- [ ] Add export to Markdown for architecture reviews and summaries.
- [ ] Add export to PDF for stakeholder reporting.
- [ ] Add export stubs/integrations for Jira and Confluence.

## Phase 5: Make It Deployable For Private And Cloud Use

Goal: support both monetizable self-hosted and managed deployment models.

### Self-hosted packaging

- [ ] Add Docker image for the dashboard/server.
- [ ] Add `docker-compose` setup for app + database.
- [ ] Replace JSON persistence with a production-grade database.
- [ ] Add migration system for schema changes.
- [ ] Add install documentation for local private deployment.

### Cloud readiness

- [ ] Add environment separation for dev, staging, production.
- [ ] Add secure secret handling for hosted deployments.
- [ ] Add background job runner for asynchronous tasks.
- [ ] Add object storage strategy for exports and artifacts.
- [ ] Add multi-tenant isolation model for hosted customers.

### Operations

- [ ] Add health, readiness, and metrics endpoints suitable for orchestration.
- [ ] Add usage quotas and rate limits.
- [ ] Add backup/restore strategy for database-backed state.
- [ ] Add admin support tooling for customer troubleshooting.

## Phase 6: Add Admin Analytics And Monetization Controls

Goal: create features that justify paid plans.

### Usage analytics

- [ ] Add per-user and per-workspace usage tracking.
- [ ] Add token and cost tracking by project, user, and model.
- [ ] Add tool usage analytics and failure-rate reporting.
- [ ] Add chat/session activity dashboards.
- [ ] Add exportable admin reports.

### Plan enforcement

- [ ] Add feature flags by plan: `Free`, `Pro`, `Team`, `Enterprise`.
- [ ] Add limits by plan: projects, chats, storage, integrations, users.
- [ ] Add premium gating for admin analytics, approvals, and SSO.
- [ ] Add license key or subscription validation layer.
- [ ] Add billing event model for hosted usage.

### Enterprise controls

- [ ] Add SSO support.
- [ ] Add RBAC admin screens.
- [ ] Add compliance/audit report generation.
- [ ] Add organization-level policy management.
- [ ] Add support for customer-managed model endpoints and secrets.

## Phase 7: Add Ecosystem And Extensibility

Goal: make the product sticky and harder to replace.

### Plugin and connector model

- [ ] Define plugin SDK for adding tools and integrations.
- [ ] Add connector interface for Git, issue trackers, docs, and storage.
- [ ] Add plugin management UI for admins.
- [ ] Add permission model for plugins.
- [ ] Add signed plugin/package strategy for hosted environments.

### Domain packs

- [ ] Add built-in workflow packs for developer, QA, BA, and architect roles.
- [ ] Add reusable prompt packs and report templates.
- [ ] Add review checklists for security, architecture, and release readiness.

## Commercial Packaging

### Free plan

- [ ] Single-user local mode.
- [ ] Basic project/chat management.
- [ ] Basic file tools.
- [ ] Bring-your-own model endpoint.

### Pro plan

- [ ] Advanced repository workflows.
- [ ] Saved templates and exports.
- [ ] Better analytics.
- [ ] More integrations.

### Team plan

- [ ] Shared workspaces.
- [ ] Team roles and approvals.
- [ ] Audit logs.
- [ ] Admin controls.

### Enterprise plan

- [ ] SSO and RBAC.
- [ ] Self-hosted deployment package.
- [ ] Policy engine.
- [ ] Compliance reporting.
- [ ] Support/SLA tooling.

## Minimum Monetizable Releases

### Release 1: Paid Local Pro

Target: meaningful single-user product for private local use.

- [ ] Stable local packaging
- [ ] diff preview + controlled writes
- [ ] repository overview and better search
- [ ] model presets and fallback
- [ ] export to Markdown/PDF

### Release 2: Team Self-Hosted

Target: first team-ready commercial edition.

- [ ] users, workspaces, roles
- [ ] audit log
- [ ] approval workflow
- [ ] database-backed persistence
- [ ] Docker deployment
- [ ] GitHub/GitLab integration

### Release 3: Managed Cloud

Target: hosted SaaS/team product.

- [ ] tenant isolation
- [ ] hosted auth
- [ ] usage metering
- [ ] plan enforcement
- [ ] admin analytics
- [ ] support operations

## Suggested Implementation Order

### Next 30 days

- [ ] Add write modes and diff preview
- [ ] Add immutable write history
- [ ] Add schema validation across APIs and state
- [ ] Add CI test automation
- [ ] Refactor the UI into maintainable modules
- [ ] Add local git visibility in the dashboard

### Next 90 days

- [ ] Add repository indexing and prompt templates
- [ ] Add GitHub integration
- [ ] Add users, workspaces, and roles
- [ ] Add approval workflows
- [ ] Move persistence to a production-grade database
- [ ] Add Docker packaging

### Next 12 months

- [ ] Add SSO and enterprise policy controls
- [ ] Add GitLab and Jira/Confluence integrations
- [ ] Add hosted cloud architecture
- [ ] Add full analytics and plan enforcement
- [ ] Add plugin SDK and domain packs

## Definition Of Success

This backlog succeeds if the product becomes:

- genuinely useful for daily repository analysis and coding work
- trusted enough for private codebases
- structured enough for team governance
- deployable as both self-hosted and managed offering
- differentiated enough to sell as a governed AI workspace rather than a generic coding agent
