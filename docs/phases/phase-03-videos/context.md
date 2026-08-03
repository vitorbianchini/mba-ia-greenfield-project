---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-31T19:07:11-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-31T19:36:39-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-31T19:29:56-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-07-31T19:29:56-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-31T19:29:56-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-31T19:29:56-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-31T19:07:11-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade público/unlisted e fluxo de publicação (Fase 04). Página de visualização, player e contagem de views (Fase 05). Interações sociais (Fase 06). Qualquer superfície de UI para vídeo.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — esta fase é backend-only. As telas de upload e player pertencem às Fases 04 e 05.

**Sequencing notes:** Depends on Fase 01 (configuração base) e Fase 02 (autenticação e canais). Todo vídeo pertence a um canal, e o canal já é criado no cadastro pela Fase 02.

**Neighbors (for boundary detection only):**

- **Fase 02:** Cadastro, Login e Gerenciamento de Conta (prior) — fornece `User`, `Channel`, `JwtAuthGuard` global, filtro de exceções de domínio e `ValidationPipe`.
- **Fase 04:** Gerenciamento de Vídeos e Canal (next) — consome a entidade de vídeo criada aqui e adiciona edição, categorias, visibilidade e publicação.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.3` |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | 10GB Upload Strategy | decided | A (Presigned S3 multipart upload) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client and Bucket/Key Layout | decided | A (AWS SDK v3 + presigner, bucket único com prefixos) | `@aws-sdk/client-s3@^3.1101.0`, `@aws-sdk/s3-request-presigner@^3.1101.0` |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Worker Execution Model | decided | A (serviço Compose separado, standalone context) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Metadata Extraction and Thumbnail Generation | decided | A (ffprobe/ffmpeg via child_process) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Unique Video URL Identifier | decided | A (short id via node:crypto) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Video Delivery — Streaming and Download | decided | C (Range proxy no stream, redirect no download) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Processing Failure Handling | decided | A (draft → processing → ready \| failed) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Integration Testing Strategy for Storage and Queue | decided | A (MinIO/Redis/FFmpeg reais em integração) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-09 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

_(current-phase TDs only)_

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis is the only option that gives declarative retry/backoff and worker concurrency without hand-written lifecycle code, and its NestJS wrapper is maintained by the Nest core team against NestJS 11, which the project already runs. The cost is one small Redis container in Compose. pg-boss's "no new infrastructure" advantage is real but is paid for with a hand-rolled worker lifecycle and by putting a polling loop on the same PostgreSQL that serves API traffic. The `bullmq@^5` peer constraint is a version pin, not a functional limitation.

**Libraries:** `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.3`

### phase-03-videos/TD-02

**Recommendation:** Presigned S3 multipart. Single presigned PUT is eliminated on the hard 5GB single-PUT limit, which the 10GB requirement exceeds by construction. Against tus, the multipart protocol is already implemented by the storage service the project is committed to, so it delivers resumability and integrity checks without adding a component. Orphaned parts are handled by a bucket lifecycle rule for incomplete multipart uploads.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3 with a single bucket and prefixes. The project has already decided to run MinIO as a stand-in for S3, so the client must be the S3 client; the MinIO-specific client optimises ergonomics at the cost of the exact portability the architecture was designed for. A single bucket with `videos/` and `thumbnails/` prefixes keeps bootstrap to one `CreateBucket` call and matches how every object is reached in this phase.

**Libraries:** `@aws-sdk/client-s3@^3.1101.0`, `@aws-sdk/s3-request-presigner@^3.1101.0`

### phase-03-videos/TD-04

**Recommendation:** Separate Compose service running a NestJS standalone application context. It is the only option that satisfies the diagram's container separation while keeping a single DI graph and a single source of truth for config and entities. Keeping the processor in a `WorkerModule` that `AppModule` does not import is the load-bearing detail: it is what guarantees the API never competes for jobs.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Direct `ffprobe` / `ffmpeg` invocation via `node:child_process`. The requirement is two well-understood command invocations, and `execFile` with an argument array covers both safely and with zero dependencies. `fluent-ffmpeg`'s ergonomic gain does not justify placing an irregularly maintained package on the critical path of video processing.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Random short id generated with `node:crypto`. Sqids is disqualified on the enumeration leak, which conflicts with the unlisted-video requirement already on the roadmap. Against nanoid the functional result is identical, and nanoid's only advantage is cancelled by having to pin a legacy major version to work around ESM-only packaging.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Split — Range proxy for streaming, presigned redirect for download. The two paths genuinely have different requirements. Proxying both puts full-file 10GB transfers through Node for no benefit; redirecting both gives up the request-path hook that the visibility rules of Fase 04 and the view counter of Fase 05 are already known to need.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** `draft → processing → ready | failed`, with retries owned by the queue and a persisted error reason. It matches the lifecycle the project plan specifies and keeps retry mechanics owned by the queue while the database owns the outcome. An `uploading` state is not observable server-side under TD-02, and explicit retry states duplicate state BullMQ already owns.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Real MinIO, real Redis and real FFmpeg in integration specs; mocks only in unit specs. The project's own convention already points here (Mailpit is driven for real), and the phase's risk is concentrated exactly in the seams that mocks cannot check. Testcontainers solves an isolation problem the project does not have, at the cost of nested Docker.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — the documented NestJS approach; the project already uses decorators extensively.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes in a `{ statusCode, error, message }` envelope. This is the error contract for all subsequent phases.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — native NestJS integration via the guard system; in-memory storage is sufficient for a single instance.

**Libraries:** `@nestjs/throttler@^6.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Every entity must be registered in `TypeOrmModule.forFeature([Entity])` of its owning module, otherwise `autoLoadEntities` silently misses it. _(from phase 02)_
- All endpoints are protected by the global `JwtAuthGuard` (`APP_GUARD` in `AuthModule`); public endpoints opt out with `@Public()`. _(from phase 02)_
- Services throw domain exceptions extending `DomainException`; `DomainExceptionFilter` maps them to `{ statusCode, error, message }`. Services never throw NestJS HTTP exceptions. _(from phase 02)_
- Domain error codes are `SCREAMING_SNAKE_CASE` strings in the `error` field, catalogued per phase. _(from phase 02)_
- Migrations are generated via the TypeORM CLI and never edited after execution; test DataSources import migration classes and entity classes explicitly, never via globs. _(from phase 02)_
- Test DataSources are built with `createTestDataSource(entities, options)` from `src/test/create-test-data-source.ts`; cleanup uses `dataSource.query('DELETE FROM ...')`, never `repository.delete({})`. _(from phase 02)_
- Integration and e2e suites share one database and must run with `--runInBand`. _(from phase 02)_
- E2E specs must reapply `main.ts` global config (pipes, filters) explicitly, and clear `ThrottlerStorage` in `beforeEach`. _(from phase 02)_
- External side-effect systems are exercised for real in integration specs (Mailpit precedent), not mocked. _(from phase 02)_
- Non-TypeScript runtime assets must be declared in `nest-cli.json` under `compilerOptions.assets`, or they are missing from `dist/`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | delivered later | phase-02-auth | Deferred by phase-02-auth (backend), then delivered by the phase-02-auth-frontend slice. No action required in Fase 03. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

All nine capabilities of the phase are in scope and covered by a TD; nothing is deferred.

## Testing Requirements

### nestjs-project

From the `testing-guide-nestjs-project` skill, §3 Feature Implementation Checklist:

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mocked repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real capture service or real adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (complex internal logic) | Unit + E2E |
| Exception Filter | Unit + E2E |

Relevant §2 "worth testing" entries for this phase: service-to-external-system contracts (storage uploads, queue publishing), module DI wiring for `BullModule.registerQueue()`, race conditions on concurrent uploads, and entity constraints.

**Resolved conflict:** `references/external-systems.md` previously prescribed a local-filesystem adapter for object storage and described the queue technology as TBD. Both predated this phase and contradicted TD-01/TD-03/TD-09. `plan-resolve` rewrote both sections to MinIO and BullMQ + Redis (see `validation.md` → Resolved Issues, IC-1 and IC-2).

### next-frontend

_Deferred subproject — no frontend work in this phase._
