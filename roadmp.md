# Roadmap

Execution roadmap for turning this project into a meaningful, monetizable coding assistant for:

- local private use
- team self-hosted deployments
- managed cloud deployments

This roadmap is derived from `README.md`, `competitive-analysis.md`, and `todo.md`.

## Goal

Position the product as:

`A governed, local-first AI workspace for engineering teams using private repositories and self-hosted or OpenAI-compatible models.`

## Priority Definitions

- `P0`: must exist before the product is credible or sellable
- `P1`: high-value differentiators that unlock adoption or revenue
- `P2`: strategic expansion and scale features

## Effort Definitions

- `S`: small, low coordination, can be completed quickly
- `M`: medium, multi-file or cross-cutting but contained
- `L`: large, architectural or multi-sprint
- `XL`: platform-level or multi-phase initiative

## Release Track

### Release 1: Local Pro

Target outcome:

- trusted single-user local coding workspace
- good enough to use daily
- credible paid “Pro” offering for private users

### Release 2: Team Self-Hosted

Target outcome:

- multi-user team workspace
- governed write flows
- deployable inside private environments

### Release 3: Managed Cloud

Target outcome:

- hosted multi-tenant product
- usage metering and commercial controls
- enterprise-ready management layer

## Roadmap Table

| ID | Task | Priority | Effort | Release | Dependencies | Why It Matters |
|---|---|---|---|---|---|---|
| R1 | Add schema validation for runtime, UI state, and API payloads | P0 | M | Release 1 | none | Prevents silent corruption and hardens the API surface |
| R2 | Add structured logging with request/chat/project ids | P0 | S | Release 1 | none | Required for support, debugging, and later audit features |
| R3 | Add unified API/SSE error model | P0 | M | Release 1 | R1 | Makes failures understandable and testable |
| R4 | Add explicit write modes: read-only, ask-before-write, trusted-write | P0 | M | Release 1 | R1 | Core control feature for safe adoption |
| R5 | Add diff preview before file writes and patch application | P0 | M | Release 1 | R4 | Critical for trust and monetizable “safe assistant” positioning |
| R6 | Add immutable write history for all file mutations | P0 | M | Release 1 | R2, R4 | Foundation for audit and approvals |
| R7 | Add tests for write paths, trust boundaries, malformed tool calls | P0 | M | Release 1 | R1, R3, R4 | Needed for confidence before commercial rollout |
| R8 | Add CI automation for smoke and RAG tests | P0 | S | Release 1 | R7 | Keeps the core stable |
| R9 | Refactor dashboard UI into maintainable modules/components | P0 | L | Release 1 | none | Current single-file UI limits velocity |
| R10 | Add local git status/diff/changed-files visibility | P1 | M | Release 1 | R9 | Makes the assistant materially more useful for coding |
| R11 | Add “propose change” mode without automatic writes | P1 | M | Release 1 | R5 | Useful for cautious users and paid local workflows |
| R12 | Add per-project model presets and fallback models | P1 | M | Release 1 | R1 | Improves daily usability and resilience |
| R13 | Add repository indexing/cache for large repos | P1 | L | Release 1 | R9 | Required to compete on real repo usefulness |
| R14 | Add saved repository overview / architecture summary | P1 | M | Release 1 | R13 | Improves BA/CTO-facing value proposition |
| R15 | Add export to Markdown/PDF | P1 | M | Release 1 | R14 | Supports stakeholder reporting and Pro monetization |
| R16 | Introduce users, workspaces, and role model | P0 | XL | Release 2 | R1, R9 | First true team/commercial foundation |
| R17 | Replace shared token auth with real session auth | P0 | L | Release 2 | R16 | Required for team and hosted use |
| R18 | Add per-role permissions for read/write/export/admin | P0 | L | Release 2 | R16, R17 | Core governance layer |
| R19 | Add approval queue for file writes and patches | P0 | L | Release 2 | R6, R16, R18 | Central differentiator for team monetization |
| R20 | Add audit trail UI and retention settings | P1 | M | Release 2 | R6, R16 | Makes governance visible and sellable |
| R21 | Move persistence from JSON to production-grade database | P0 | XL | Release 2 | R1, R16 | Required for multi-user and operational safety |
| R22 | Add migration system for state schema | P0 | M | Release 2 | R21 | Enables safe upgrades |
| R23 | Add Docker image and compose-based deployment | P0 | M | Release 2 | R21 | Required for self-hosted sales |
| R24 | Add install/admin docs for private deployment | P1 | M | Release 2 | R23 | Necessary for onboarding customers |
| R25 | Add GitHub integration for repo connection and PR creation | P0 | L | Release 2 | R16, R21 | High-value monetizable workflow feature |
| R26 | Add branch selection, branch creation, and commit creation | P1 | M | Release 2 | R25 | Makes Git integration practical |
| R27 | Add PR summary and review workflows | P1 | M | Release 2 | R25, R26 | Increases developer and manager value |
| R28 | Add shared projects, shared chats, and activity feed | P1 | L | Release 2 | R16, R21 | Makes the product truly collaborative |
| R29 | Add admin analytics: usage, tokens, costs, failures | P0 | L | Release 2 | R2, R16, R21 | Necessary for monetization and ops |
| R30 | Add plan-based feature flags and quota model | P1 | L | Release 2 | R29 | Supports commercial packaging |
| R31 | Add SSO support | P0 | L | Release 3 | R16, R17, R21 | Enterprise gate |
| R32 | Add RBAC admin screens and org policy management | P0 | L | Release 3 | R18, R31 | Needed for enterprise governance |
| R33 | Add GitLab integration | P1 | L | Release 3 | R25, R21 | Expands enterprise/team market |
| R34 | Add Jira/Confluence export and integration flows | P1 | M | Release 3 | R15, R21 | Strong BA/CTO differentiator |
| R35 | Add background job runner for async tasks | P0 | L | Release 3 | R21 | Needed for hosted automation and scale |
| R36 | Add tenant isolation model for managed cloud | P0 | XL | Release 3 | R16, R21, R35 | Core hosted architecture requirement |
| R37 | Add hosted secret management and secure environment handling | P0 | L | Release 3 | R36 | Required for cloud trust |
| R38 | Add rate limiting, quotas, and billing event model | P0 | L | Release 3 | R29, R30, R36 | Required for SaaS monetization |
| R39 | Add support tooling and customer admin operations | P1 | M | Release 3 | R29, R36 | Required for operating paying accounts |
| R40 | Define plugin SDK and connector interface | P1 | XL | Release 3 | R21, R29 | Important for ecosystem and stickiness |
| R41 | Add plugin management UI and permission model | P2 | L | Release 3 | R40, R32 | Enables extensibility without losing governance |
| R42 | Add domain packs for developer, QA, BA, architect workflows | P2 | M | Release 3 | R40 | Helps packaging and upsell |

## 30-Day Plan

Focus: establish trust and improve daily usability.

### Must ship

- [ ] R1 Add schema validation for runtime, UI state, and API payloads
- [ ] R2 Add structured logging with request/chat/project ids
- [ ] R3 Add unified API/SSE error model
- [ ] R4 Add explicit write modes
- [ ] R5 Add diff preview before writes
- [ ] R6 Add immutable write history
- [ ] R7 Add tests for writes and trust boundaries
- [ ] R8 Add CI automation

### Should ship if capacity allows

- [ ] R9 Refactor dashboard UI into modules/components
- [ ] R10 Add local git visibility
- [ ] R11 Add propose-change mode

## 90-Day Plan

Focus: make the product commercially credible for local Pro and prepare for team self-hosted.

### Must ship

- [ ] R9 Refactor dashboard UI into modules/components
- [ ] R10 Add local git visibility
- [ ] R11 Add propose-change mode
- [ ] R12 Add model presets and fallback models
- [ ] R13 Add repository indexing/cache
- [ ] R14 Add saved repository/architecture summaries
- [ ] R15 Add export to Markdown/PDF
- [ ] R21 Move persistence to a production-grade database
- [ ] R22 Add migration system
- [ ] R23 Add Docker packaging

### Stretch goals

- [ ] R16 Introduce users, workspaces, and roles
- [ ] R25 Add GitHub integration

## 12-Month Plan

Focus: build the team and enterprise product.

### Team self-hosted target

- [ ] R16 Introduce users, workspaces, and role model
- [ ] R17 Add real session auth
- [ ] R18 Add per-role permissions
- [ ] R19 Add approval queue
- [ ] R20 Add audit trail UI
- [ ] R24 Add deployment/admin docs
- [ ] R25 Add GitHub integration
- [ ] R26 Add branch/commit workflows
- [ ] R27 Add PR summary and review workflows
- [ ] R28 Add shared projects/chats/activity feed
- [ ] R29 Add admin analytics
- [ ] R30 Add plan-based controls

### Managed cloud target

- [ ] R31 Add SSO support
- [ ] R32 Add RBAC admin screens and policy management
- [ ] R33 Add GitLab integration
- [ ] R34 Add Jira/Confluence integrations
- [ ] R35 Add background job runner
- [ ] R36 Add tenant isolation
- [ ] R37 Add secure hosted secret handling
- [ ] R38 Add rate limits, quotas, billing events
- [ ] R39 Add support tooling
- [ ] R40 Define plugin SDK

## Critical Path

The shortest path to a monetizable product is:

1. R1-R8
2. R9-R15
3. R21-R23
4. R16-R20
5. R25-R30

This sequence leads to:

- a credible paid local edition
- then a team self-hosted edition
- then a managed cloud edition

## Biggest Risks

### Product risk

- Trying to compete as a generic coding agent instead of a governed workspace product.

### Technical risk

- Staying on JSON-file persistence too long and delaying the move to a real data model.

### Commercial risk

- Building enterprise features before proving daily usefulness for real repository work.

### UX risk

- Leaving the UI monolithic and slowing feature delivery.

## Recommended Team Focus

If working with limited capacity, prioritize in this order:

1. trust and write controls
2. repository usefulness
3. packaging and deployability
4. team governance
5. analytics and monetization controls
6. ecosystem expansion

## Definition Of Done By Release

### Release 1: Local Pro

Done when:

- users can inspect repositories safely
- users can preview and approve changes
- local state is stable and test-covered
- repo workflows are useful enough for daily work
- exports support stakeholder-facing usage

### Release 2: Team Self-Hosted

Done when:

- multiple users can collaborate safely
- write actions can be governed and approved
- the system deploys cleanly in private environments
- GitHub workflows materially improve delivery work

### Release 3: Managed Cloud

Done when:

- tenants are isolated
- auth, quotas, and billing exist
- enterprise governance is present
- support operations are viable
- the product can scale beyond pilot customers
