---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-31T20:04:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-31T20:01:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-31T20:03:00-03:00"
issues: []
advisories:
  - ADV-1
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_Not applicable — backend-only phase, no screen inventory in scope._

## Advisories

**ADV-1 — A worker that dies mid-job leaves the row stranded in `processing`.**
Accepted knowingly in TD-08: BullMQ owns the retry cycle and the database owns the outcome, so a hard worker crash between "job picked up" and "status written" leaves no actor responsible for the transition. Not a blocker for this phase — the row is inert, not corrupt, and no delivery endpoint serves a non-`ready` video. A reaper that re-enqueues rows stuck in `processing` beyond a threshold belongs to a later phase. Recorded so the gap is a known trade-off rather than an oversight.

## Resolved Issues

**MD-1 — All nine TDs were `pending`.** _Resolved._
Decisions taken with the user and written into `docs/decisions/technical-decisions-phase-03-videos.md`; frontmatter flipped to `status: decided`. The four decisions with genuinely competing options (TD-01 queue, TD-02 upload, TD-06 unique id, TD-07 delivery) were put to the user explicitly; the remaining five follow their documented recommendation. `context.md` → `## Decisions Index` patched to `decided`.

**IC-1 — Testing guide prescribed local-filesystem storage against TD-03's MinIO.** _Resolved._
`.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § "Object Storage" rewritten from the local-filesystem adapter to real MinIO in Docker, with the rationale (a filesystem adapter cannot exercise presigning, multipart or range reads) and the `forcePathStyle: true` requirement recorded. The section now cites TD-03 and TD-09 as its source.

**IC-2 — Queue technology recorded as TBD in two places.** _Resolved._
The same reference file § "Message Queue" now names BullMQ + Redis, carries the `bullmq@^5` peer constraint, and replaces the illustrative test snippet with the `obliterate` isolation pattern. `CLAUDE.md` § Architecture and `docs/diagrams/software-arch.mermaid` both changed from `Message Queue (TBD)` to `Redis + BullMQ`.

**DG-1 — No library versions pinned.** _Resolved._
`library-refs.md` created with four pinned packages and three infrastructure images, each traced to its TD, plus the confirmed API surface for every one of them from the official documentation via context7. Three non-obvious constraints are recorded: the `bullmq@^5` peer bound on `@nestjs/bullmq@11`, `ioredis` resolving transitively through bullmq, and `nanoid@6` being ESM-only against this project's CommonJS output.

**DG-2 — No read path from the authenticated user to their owning channel.** _Resolved in plan._
`ChannelsService` gains `findByUserId(userId)` and `ChannelsModule` exports it, so the video module resolves the owning channel across the module boundary instead of reaching into the channels repository. Assigned to **SI-03.4** with its own unit and integration coverage.

**AM-1 — "sem impacto na performance" had no measurable criterion.** _Resolved._
TD-02 gained a note fixing two structural, machine-independent criteria: no upload endpoint accepts a request body carrying video bytes (API inputs are metadata and part ETags only), and `PART_SIZE` is fixed at 100MB so a 10GB upload stays within the S3 10,000-part limit at 100 parts. Both are asserted in the e2e suite, so the deliverable is falsifiable.
