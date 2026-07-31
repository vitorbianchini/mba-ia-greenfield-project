---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 6
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-31T19:52:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-31T19:36:39-03:00"
issues:
  - MD-1
  - IC-1
  - IC-2
  - DG-1
  - DG-2
  - AM-1
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

**IC-1 — Testing guide prescribes local-filesystem storage, phase decides MinIO.**
`.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § "Object Storage — Local Filesystem" states the strategy is "Local filesystem storage in development and tests. S3 in production", with a `STORAGE_CONFIG` / `driver: 'local'` setup pattern. TD-03 decides an S3-compatible client against MinIO running in Compose, and TD-09 decides integration specs drive that MinIO for real. A guide that tells the implementer to build a local-filesystem adapter will produce a storage layer that never exercises presigning, multipart or range reads — the three mechanisms this phase depends on. The two cannot both stand.

**IC-2 — Testing guide records the queue technology as TBD.**
The same reference file § "Message Queue — Real (Docker)" says "The specific technology is TBD per the architecture diagram (likely BullMQ with Redis or RabbitMQ)". `CLAUDE.md` § Architecture likewise lists "**Message Queue** (TBD)". TD-01 closes this decision. Both documents must name the chosen technology once the TD is decided, or the next phase re-opens a settled decision.

### Ambiguities

**AM-1 — "sem impacto na performance" has no measurable acceptance criterion.**
The capability bullet "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" states an intent, not a testable threshold. TD-02 answers the architectural half (bytes bypass the API), but nothing in the phase artifacts states how an implementer proves it. Without a concrete criterion, the deliverable is unfalsifiable and any implementation can claim to satisfy it.

### Missing Decisions

**MD-1 — All nine TDs are still `pending`.**
`docs/decisions/technical-decisions-phase-03-videos.md` carries `status: pending` in its frontmatter and every TD's `**Decision:**` field reads `_[pending]_`. `plan-build` cannot render Technical Specifications from recommendations alone — the Data Model, API Contracts and Events/Messages subsections depend on which option was actually chosen. Blocks the build stage.

### Dependency Gaps

**DG-1 — No library versions pinned for the new stack.**
Every TD's `**Libraries:**` field is empty. The phase introduces at least a queue client, an S3 client and a presigner, none of which exist in `nestjs-project/package.json`. Per the project convention that library APIs are confirmed against the installed version via context7 before implementation, the versions must be fixed and recorded in `library-refs.md` before SIs can cite concrete APIs. Note the non-obvious constraint already surfaced during research: `@nestjs/bullmq@11` peer-requires `bullmq@^3 || ^4 || ^5`, so the current `bullmq@6` is not installable under that wrapper.

**DG-2 — Video entity has no owner path to the authenticated user.**
The phase requires videos to belong to a channel, and Fase 02 established a 1:1 `User → Channel` relation. But `ChannelsModule` currently exports `TypeOrmModule` and `ChannelsService`, and `ChannelsService` exposes only `createChannel(userId, email)`. There is no read path from an authenticated user's JWT (`sub` = user id) to their channel id, which every upload endpoint in this phase needs to resolve an owner. The gap must be closed by an explicit SI, or the video module will reach into the channels repository directly and break the module boundary the project's Working Principles mandate.

### Inherited Constraint Conflicts

_Covered by IC-1 and IC-2 — both originate in artifacts inherited from prior phases._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_Not applicable — backend-only phase, no screen inventory in scope._

## Resolved Issues

_No issues resolved yet._
