---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-31
scope_description: "Video upload and processing foundation: object storage, background job queue, 10GB direct-to-storage upload, video worker with FFmpeg, metadata/thumbnail extraction, unique public URL, streaming and download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the video module, the object-storage integration, the queue producer, the video worker (FFmpeg), and the streaming/download endpoints. Every TD in this document targets it.
- `next-frontend/` — out of scope for this phase. The video UI (upload widget, player page, channel dashboard) belongs to Fases 04 and 05. The Cross-layer TDs below (TD-02, TD-06, TD-07) fix the contract the future frontend will consume, but no frontend work is planned or decided here.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the C4 diagram leave the message queue explicitly as `TBD` — this is the single largest stack decision of the phase. Video processing (ffprobe metadata extraction plus thumbnail encoding) is CPU-bound and can take minutes on a large file, so it must run outside the request cycle, in a worker that can be scaled and restarted independently. The queue choice determines which infrastructure container is added to `compose.yaml`, how retries and failures are expressed, and how the worker is wired into NestJS.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue purpose-built for Node. The API injects a `Queue` and calls `add()`; the worker registers a `@Processor` class extending `WorkerHost`. Retries, exponential backoff, concurrency, delayed jobs, and job state inspection are first-class options on `add()`.
- **Pros:** Official NestJS integration package (`@nestjs/bullmq@11`, peer-compatible with NestJS 11). Retry/backoff policy is declarative, no hand-rolled state machine. Worker concurrency and graceful shutdown are built in. Adds exactly one small container (Redis). Bundles `ioredis` as a direct dependency, so no extra install. Dominant choice in the Node ecosystem, so failure modes are well documented.
- **Cons:** Introduces Redis as a second datastore, which must be run in Compose and operated in production. Job payloads live outside PostgreSQL, so a queue flush loses in-flight jobs unless the DB status column is treated as the source of truth. `@nestjs/bullmq@11` peer-requires `bullmq@^3 || ^4 || ^5`, so `bullmq@6` cannot be used until the wrapper catches up.

### Option B: pg-boss (PostgreSQL-backed queue)
- Uses the PostgreSQL instance already in the stack as the job store, via `SKIP LOCKED` polling. Jobs, retries and archives live in a dedicated schema in the same database.
- **Pros:** Zero new infrastructure — no Redis container, no second set of credentials. Jobs are transactional with domain data, so "create video row and enqueue job" can be one atomic commit. One backup covers both business data and the queue.
- **Cons:** No official NestJS wrapper, so module wiring, worker lifecycle and graceful shutdown are hand-written. Polling adds continuous load to the same database serving user requests. Throughput ceiling is far lower than Redis, and video processing competes with the API for DB connections. Smaller community, so fewer documented recipes for the Nest lifecycle.

### Option C: RabbitMQ via `@nestjs/microservices`
- AMQP broker consumed through the NestJS microservices transport. The worker becomes a microservice app listening on a message pattern.
- **Pros:** True broker semantics (exchanges, routing keys, dead-letter queues). Integrated into NestJS via a first-party transport. Scales to multi-service topologies well beyond this project.
- **Cons:** Heaviest option by far — an Erlang broker container for a single queue with one consumer. `@nestjs/microservices` models request/response and events, not job retries with backoff; retry policy and DLQ routing must be configured at the broker level. Significantly more concepts to introduce for a phase that needs one job type.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option that gives declarative retry/backoff and worker concurrency without hand-written lifecycle code, and its NestJS wrapper is maintained by the Nest core team against NestJS 11, which the project already runs. The cost is one small Redis container in Compose. pg-boss's "no new infrastructure" advantage is real but is paid for with a hand-rolled worker lifecycle and by putting a polling loop on the same PostgreSQL that serves API traffic — a poor trade for a workload whose whole point is to stay off the request path. The `bullmq@^5` peer constraint is a version pin, not a functional limitation.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.3` (traz `ioredis@5.11.1` como dependência direta)

---

## TD-02: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The platform must accept video files up to 10GB. Routing those bytes through the NestJS process would pin an event-loop worker and its memory/disk for the whole transfer, which is precisely the failure the project plan calls out ("sem travar o sistema"). The decision fixes the upload handshake between client and server, so it constrains both the API and every future client. It depends on TD-03 (storage client) for the presigning mechanism.

**Options:**

### Option A: Presigned S3 multipart upload
- The client asks the API to start an upload; the API creates the video row as a draft, issues `CreateMultipartUpload` against storage, and returns presigned `UploadPart` URLs. The client PUTs each part straight to the storage service and reports back the part ETags; the API then calls `CompleteMultipartUpload` and enqueues processing.
- **Pros:** Not one byte of video passes through the API — it only signs URLs and records metadata. Supports objects far beyond 10GB (S3 caps a multipart object at 5TB). Parts can be retried individually and uploaded in parallel, so a dropped connection costs one part, not the whole file. Native to both MinIO and S3, so dev and production behave identically. Part ETags give an integrity check at completion.
- **Cons:** Three round-trips to the API instead of one (initiate → complete, plus the direct part PUTs). The client must implement chunking and part bookkeeping. Abandoned uploads leave orphaned parts in storage that need a lifecycle rule or a cleanup job.

### Option B: Single presigned PUT
- The API returns one presigned `PutObject` URL; the client uploads the whole file in a single request directly to storage.
- **Pros:** Simplest possible handshake — one URL, one PUT. Still keeps bytes off the API. Trivial client implementation.
- **Cons:** **Disqualifying:** S3 (and MinIO, following it) caps a single PUT at 5GB, so a 10GB file cannot be uploaded this way at all. No resumability — a failure at 9GB restarts from zero. No integrity checkpoint before the object is complete.

### Option C: tus resumable upload protocol
- Run a tus server component; the client speaks the tus protocol (`POST` to create, `PATCH` to append at an offset) and the server persists to storage.
- **Pros:** Purpose-built resumable protocol with mature client libraries and true offset-based resume across sessions. Protocol-level upload metadata.
- **Cons:** Adds a third moving part (a tus server) that must either proxy bytes through Node or bridge to S3 via a community extension. Bytes flow through the tus process, reintroducing the load problem unless it is deployed as a separate service. Redundant with the multipart mechanism that S3/MinIO already provide natively.

**Recommendation:** **Option A (Presigned S3 multipart)** — Option B is eliminated on the hard 5GB single-PUT limit, which the 10GB requirement exceeds by construction. Between A and C, the multipart protocol is already implemented by the storage service the project is committed to, so it delivers resumability and integrity checks without adding a component. The extra API round-trip and the client-side chunking are a fair price; orphaned parts are handled by a bucket lifecycle rule for incomplete multipart uploads.

**Decision:** A (Presigned S3 multipart upload)

**Note (resolves AM-1):** "sem impacto na performance" is made falsifiable by two structural criteria rather than a latency budget, since neither is sensitive to the machine running the test: (1) no upload endpoint accepts a request body carrying video bytes — the API's only inputs are file metadata and part ETags, so request size is bounded by a small JSON payload regardless of file size; (2) `PART_SIZE` is fixed at 100MB, which keeps a 10GB upload within the S3 10,000-part limit (100 parts) while bounding client memory per part. Both are asserted directly in the e2e suite.

**Libraries:** — _(usa o cliente de storage do TD-03)_

---

## TD-03: Object Storage Client and Bucket/Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is not open: `docs/project-plan.md` and the C4 diagram already commit to S3-compatible object storage, run locally as MinIO in Docker and swapped for S3 in production. What is open is *how* the backend talks to it — which client library — and how objects are organised into buckets and keys. The layout is a cross-component contract: the API writes source objects, the worker writes thumbnails and reads sources, and the delivery endpoints read both.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`, single bucket with prefixes
- Official AWS SDK v3, pointed at MinIO via `endpoint` plus `forcePathStyle: true`. One bucket (`streamtube`) with key prefixes: `videos/{videoId}/source` and `thumbnails/{videoId}.jpg`.
- **Pros:** The literal S3 API — migrating to real S3 means changing environment variables, not code. Modular packages, first-class TypeScript types, and the only client with an officially supported presigner for both `PutObject` and `UploadPart`. Multipart commands (`CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload`) are exactly what TD-02 needs. One bucket means one set of credentials, one lifecycle policy document, and a single bootstrap step.
- **Cons:** Verbose command-object API compared to a purpose-built MinIO client. Pulls in a moderately large dependency tree. A single bucket means video and thumbnail objects share one access policy, so a future "public thumbnails, private videos" split has to be expressed per prefix rather than per bucket.

### Option B: `minio` JavaScript client, separate buckets
- The official MinIO SDK, with distinct `videos` and `thumbnails` buckets.
- **Pros:** Terser, more ergonomic API (`presignedPutObject`, `fPutObject`). Separate buckets give clean per-bucket policies — thumbnails public-read, videos private. Smaller dependency footprint.
- **Cons:** Couples the codebase to MinIO's client rather than the S3 API; moving to real S3 in production is a rewrite of the storage layer, not a config change. This contradicts the project's stated intent to run MinIO locally and S3 in production. Multipart-with-presigned-parts support is less direct than the AWS SDK's command objects.

### Option C: `@aws-sdk/client-s3` with one bucket per channel
- Same client as Option A, but each channel gets its own bucket.
- **Pros:** Natural per-tenant isolation and per-channel usage accounting.
- **Cons:** Bucket creation becomes part of the channel-creation flow, adding a failure mode to Fase 02's registration path. Cloud providers impose per-account bucket limits (S3 defaults to 100), so this does not survive growth. Wildly disproportionate for the current scale.

**Recommendation:** **Option A** — the project has already decided to run MinIO as a stand-in for S3, so the client must be the S3 client; Option B optimises ergonomics at the cost of the exact portability the architecture was designed for. A single bucket with `videos/` and `thumbnails/` prefixes keeps bootstrap to one `CreateBucket` call and matches how every object is reached in this phase (through the API or a presigned URL, never by a public bucket policy). If Fase 04 or 05 wants CDN-fronted public thumbnails, a prefix-scoped policy covers it without a data migration.

**Decision:** A (`@aws-sdk/client-s3` v3 + presigner, bucket único com prefixos)

**Libraries:** `@aws-sdk/client-s3@^3.1101.0`, `@aws-sdk/s3-request-presigner@^3.1101.0`

---

## TD-04: Video Worker Execution Model

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram lists "Video Worker (FFmpeg)" as a container distinct from the API. This decision fixes what that container actually runs, how it shares code with the API, and — critically — how the queue consumer is prevented from also running inside the API process. Depends on TD-01.

**Options:**

### Option A: Separate Compose service, NestJS standalone application context, shared image
- A `video-worker` service in `compose.yaml` built from the same `Dockerfile.dev` as the API (extended with `ffmpeg`), started with a different command. Its entrypoint calls `NestFactory.createApplicationContext(WorkerModule)`. The BullMQ `@Processor` lives in `WorkerModule`, which the API's `AppModule` never imports, so only the worker consumes jobs.
- **Pros:** Real process and container isolation — a wedged ffmpeg run cannot stall the API, and the worker can be restarted or scaled on its own. Full reuse of the existing DI graph (config, TypeORM entities, storage service) with no duplication. `createApplicationContext` boots no HTTP listener, so the worker has no accidental network surface. One image build for both services keeps Compose simple and lets the integration suite, which runs inside the API container, exercise the real ffmpeg binary instead of mocking it.
- **Cons:** The API image carries an ffmpeg install it never uses at runtime, costing image size in dev. Production would want separate images, so the Dockerfile split is deferred work.

### Option B: Worker in the API process
- Register the `@Processor` inside `AppModule` so the API container both serves HTTP and consumes jobs.
- **Pros:** Nothing new in Compose. Single process to run and observe.
- **Cons:** Defeats the architecture: CPU-bound ffmpeg work runs in the same container as request handling, so a burst of uploads degrades API latency — the exact problem the phase exists to avoid. Cannot scale processing independently. Contradicts the C4 diagram's explicit separation.

### Option C: Separate service running a standalone Node script
- A plain Node entrypoint that constructs a raw BullMQ `Worker` without NestJS.
- **Pros:** Minimal boot time and no framework overhead in the worker.
- **Cons:** Loses the DI container, so config loading, TypeORM connection setup and the storage service must all be re-instantiated by hand — duplicated wiring that will drift from the API's. Gives up `@nestjs/bullmq`'s lifecycle integration and graceful shutdown for no real gain.

**Recommendation:** **Option A** — it is the only option that satisfies the diagram's container separation while keeping a single DI graph and a single source of truth for config and entities. Keeping the processor in a `WorkerModule` that `AppModule` does not import is the load-bearing detail: it is what actually guarantees the API never competes for jobs. Sharing one dev image is a deliberate simplification for local development, recorded here so the production image split is a known follow-up rather than an oversight.

**Decision:** A (serviço Compose separado, application context standalone do NestJS)

**Libraries:** — _(reusa o BullMQ do TD-01)_

---

## TD-05: Video Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration, resolution, codec and container from the uploaded file, and cut a single frame into a thumbnail image. Both are FFmpeg operations; the decision is which interface the codebase uses to drive them.

**Options:**

### Option A: Direct `ffprobe` / `ffmpeg` invocation via `node:child_process`
- Call `execFile('ffprobe', ['-v','error','-print_format','json','-show_format','-show_streams', input])` and parse the JSON, then `execFile('ffmpeg', ['-ss', t, '-i', input, '-frames:v','1', out])` for the thumbnail.
- **Pros:** No dependency at all — the binaries are already in the worker image. `ffprobe -print_format json` returns a stable, documented, machine-readable structure. Full access to every flag with no wrapper translation layer. `execFile` takes an argument array, so filenames are never shell-interpreted (no injection surface). Trivially unit-testable by stubbing the exec call, and integration-testable against a real fixture file.
- **Cons:** The probe JSON must be mapped to a typed shape by hand. Timeout and buffer limits are the caller's responsibility. Slightly more verbose than a fluent API.

### Option B: `fluent-ffmpeg`
- A chainable JavaScript wrapper: `ffmpeg(input).screenshots({...})`, `ffmpeg.ffprobe(input, cb)`.
- **Pros:** Readable fluent API. Convenience helpers such as `screenshots()` handle frame selection and naming. Types available via `@types/fluent-ffmpeg`.
- **Cons:** Maintenance has been sporadic for years, which is a poor bet for a dependency sitting on the critical path of the platform's core feature. Callback-based API needs promisifying throughout. Adds a dependency plus a separate `@types` package to wrap two `execFile` calls. The abstraction hides flags exactly when a codec edge case requires reaching for them.

### Option C: `ffmpeg-static` + `@ffprobe-installer/ffprobe`
- Download prebuilt binaries as npm packages instead of installing FFmpeg in the image.
- **Pros:** Pinned binary version travels with the lockfile; no `apt` step in the Dockerfile.
- **Cons:** Large platform-specific binaries in `node_modules`, downloaded at install time — slow, and fragile behind proxies or in offline builds. Still needs an execution layer on top, so it does not replace Option A or B, it only changes where the binary comes from. The Debian-based image can `apt install ffmpeg` in one line.

**Recommendation:** **Option A** — the whole requirement is two well-understood command invocations, and `execFile` with an argument array covers both safely and with zero dependencies. Option B's ergonomic gain does not justify placing an irregularly maintained package on the critical path of video processing, and Option C solves a binary-distribution problem the project does not have, since the worker image controls its own `apt` layer. Mapping the probe JSON by hand is a small, explicit cost that also produces exactly the typed metadata shape the entity needs.

**Decision:** A (invocação direta de `ffprobe` / `ffmpeg` via `node:child_process`)

**Libraries:** — _(binário `ffmpeg` instalado na imagem, sem dependência npm)_

---

## TD-06: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, unique, URL-safe public identifier that never collides — the `watch/{id}` handle. The internal primary key stays a UUID (matching every other entity in the schema), so this is a second, public-facing identifier. It is Cross-layer because it appears in every URL the future frontend builds and in every API path that addresses a video.

**Options:**

### Option A: Random short id generated with `node:crypto`
- An 11-character string drawn from a 64-symbol URL-safe alphabet using `crypto.randomBytes`, stored in a unique column, regenerated on the rare collision.
- **Pros:** ~66 bits of entropy — collisions are negligible at any realistic scale, and the unique constraint plus a bounded retry makes the remaining probability a non-issue. Leaks nothing: no ordering, no row count, no creation time. Short and clean in URLs, like the handles users already expect from video platforms. Uses only the standard library, so no dependency and no ESM/CJS friction.
- **Cons:** A handful of lines to write and unit-test rather than a library call. Needs a unique index and explicit collision handling.

### Option B: `nanoid`
- The de-facto short-id library, `nanoid()` returning a 21-character URL-safe id.
- **Pros:** Battle-tested, audited implementation. One-line usage.
- **Cons:** **Blocking on the current version:** `nanoid@6` is ESM-only (`"type": "module"`), while this project compiles to CommonJS, so it cannot be `require`d from the built output. Using it means pinning the legacy `nanoid@3` line purely for module-format reasons — carrying a deliberately outdated dependency to avoid writing ten lines of `crypto` code.

### Option C: Sqids (formerly Hashids) over a sequential integer
- Add a sequential column and encode it reversibly into a short string.
- **Pros:** Guaranteed collision-free by construction — no unique index or retry needed. Compact ids.
- **Cons:** Reversible by design, so the id leaks the underlying sequence: anyone can decode it to a row number, learn the platform's total video count, and enumerate neighbouring videos. That directly undermines the "unlisted, only reachable by link" visibility mode planned for Fase 04. Also requires a sequence column alongside the existing UUID key.

**Recommendation:** **Option A** — Option C is disqualified on the enumeration leak, which conflicts with the unlisted-video requirement already on the roadmap. Between A and B the functional result is identical, and B's only advantage (not writing the generator) is cancelled by having to pin a legacy major version to work around ESM-only packaging. A unique index plus a bounded regeneration loop makes correctness a database guarantee rather than a probability argument.

**Decision:** A (short id aleatório gerado com `node:crypto`)

**Libraries:** — _(apenas biblioteca padrão)_

---

## TD-07: Video Delivery — Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Two delivery paths are required: playback that starts immediately without fetching the whole file, and an explicit download. Both read the same stored object but have different constraints — playback needs byte-range seeking and will later need access control and view counting, while download is a single full transfer where API bandwidth is pure overhead. This decision fixes the URLs and status codes the future player and download button depend on.

**Options:**

### Option A: API proxies both, with HTTP Range support
- `GET /videos/{publicId}/stream` forwards the client's `Range` header to storage and streams the partial object back with `206 Partial Content`, `Content-Range` and `Accept-Ranges: bytes`. `GET /videos/{publicId}/download` streams the full object with `Content-Disposition: attachment`.
- **Pros:** One origin for the client, so no CORS configuration and no credential exposure. The API stays in the request path, which is where visibility rules (public/unlisted, Fase 04) and view counting (Fase 05) will need to live. Directly assertable in e2e tests: send `Range: bytes=0-1023`, assert `206` and the exact `Content-Range`. Storage credentials never leave the server.
- **Cons:** Every streamed byte crosses the API process. For downloads of multi-gigabyte files this is exactly the load pattern TD-02 went out of its way to avoid on the upload side.

### Option B: Redirect both to presigned GET URLs
- Both endpoints answer `302` with a short-lived presigned URL; the client then talks to storage directly, which handles Range natively.
- **Pros:** Zero bytes through the API for either path. Storage (or a CDN in front of it) does what it is built for. Trivially scalable.
- **Cons:** The API sees only the redirect, so it cannot count a view or meter playback. Presigned URLs are bearer tokens — once handed out they are shareable until expiry, which weakens the unlisted-video guarantee. Requires CORS configuration on the bucket for browser playback, and browsers do not follow redirects consistently for media element range requests.

### Option C: Split — proxy for streaming, presigned redirect for download
- `GET /videos/{publicId}/stream` proxies with Range and `206` (Option A behaviour). `GET /videos/{publicId}/download` answers `302` to a presigned URL carrying `response-content-disposition=attachment`.
- **Pros:** Each path gets the right trade-off. Streaming keeps the API in the loop where future access control and view counting need it, and range requests fetch only the bytes actually watched rather than the whole file. Download, which has no per-request business logic and is the one operation that really does move 10GB, is offloaded entirely to storage. Both remain straightforward to test: `206` plus `Content-Range` on the stream endpoint, `302` plus a `Location` pointing at storage on the download endpoint.
- **Cons:** Two mechanisms instead of one, so clients handle two response shapes. The presigned download URL is still shareable until it expires (mitigated by a short TTL).

**Recommendation:** **Option C** — the two paths genuinely have different requirements, and forcing one mechanism onto both means losing something real. Pure Option A puts full-file 10GB transfers through Node for no benefit; pure Option B gives up the request-path hook that the visibility rules of Fase 04 and the view counter of Fase 05 are already known to need. Splitting keeps control exactly where later phases will need it and offloads the transfer that has no business logic attached. Streaming through the API is also far less costly than it first appears: a range request serves only the bytes the viewer actually reaches.

**Decision:** C (proxy com Range no streaming, redirect pré-assinado no download)

**Libraries:** — _(usa o cliente de storage do TD-03)_

---

## TD-08: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video row is created as a draft the moment an upload starts, then moves through processing to a terminal state. The set of states is a cross-component contract — the API writes the initial state, the worker advances it, delivery endpoints gate on it, and Fase 04's publish flow will extend it. This decision also fixes what happens when ffmpeg fails, which determines whether the queue's retry policy or the database is the source of truth.

**Options:**

### Option A: `draft → processing → ready | failed`, with retries inside the job and a persisted error reason
- The API creates the row as `draft` at upload initiation. On upload completion it flips to `processing` and enqueues the job. The worker sets `ready` on success. BullMQ retries the job (3 attempts, exponential backoff); only after the final attempt fails does the worker write `failed` plus a `processing_error` message.
- **Pros:** Exactly the cycle the project plan names ("rascunho → processando → pronto/erro") with nothing invented on top. Transient failures (a storage hiccup, a cold container) are absorbed by the retry policy and never surface as a user-visible `failed`. The persisted error reason makes a failure diagnosable without reading worker logs. Four states are few enough to reason about and to cover exhaustively in tests.
- **Cons:** A row sits in `processing` for the entire retry window, so a user watching the status sees no distinction between "first attempt running" and "second retry pending". A crashed worker leaves the row in `processing` until a janitor or a manual retry intervenes.

### Option B: Add an explicit `uploading` state between `draft` and `processing`
- `draft` on pre-registration, `uploading` while parts transfer, `processing` after completion.
- **Pros:** Distinguishes "created but nothing uploaded" from "bytes in flight", which is finer-grained progress reporting.
- **Cons:** The distinction is not observable server-side under TD-02 — parts go straight to storage, so the API has no signal that transfer has begun and could only flip the state on a client-supplied hint. Adds a state whose transition nothing reliably triggers. `draft` already carries the meaning the plan assigns it.

### Option C: Add explicit `retrying` / `retry_scheduled` states
- Surface each queue retry as its own persisted state.
- **Pros:** Full visibility of the retry cycle from the database alone.
- **Cons:** Duplicates state that BullMQ already owns, and duplicated state drifts — a job can be retried without the DB write landing. Every attempt becomes an extra write on the hot path. The information has no consumer in this phase.

**Recommendation:** **Option A** — it matches the lifecycle the project plan specifies, and keeps retry mechanics owned by the queue (which is what TD-01 was chosen for) while the database owns the outcome. Options B and C both add states whose transitions are either unobservable or already tracked elsewhere. The known gap — a row stranded in `processing` if a worker dies mid-job — is accepted for this phase and left as a candidate for a reaper in a later one, rather than papered over with states that do not fix it.

**Decision:** A (`draft → processing → ready | failed`, com retry na fila e motivo do erro persistido)

**Libraries:** — _(usa o BullMQ do TD-01)_

---

## TD-09: Integration Testing Strategy for Storage and Queue

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** This phase adds two external systems (object storage and a Redis-backed queue) plus an external binary (FFmpeg). The existing suite has a precedent for both approaches: `mail.service.integration-spec.ts` drives a real Mailpit container, while unit specs mock repositories. Choosing where the line falls for the new systems is a cross-component decision — it drives the Compose services, the Jest configuration and the test helpers.

**Options:**

### Option A: Real MinIO, real Redis and real FFmpeg in integration tests; mocks only in unit specs
- `*.integration-spec.ts` files talk to the MinIO and Redis containers from Compose and run ffprobe/ffmpeg against a small committed fixture video. `*.spec.ts` files keep every collaborator mocked.
- **Pros:** Exercises the parts most likely to break — presigned URL signing, multipart completion, S3 range semantics, actual ffprobe output parsing — none of which a mock can validate. Consistent with how `MailService` is already tested against Mailpit, so the suite stays coherent. Catches configuration errors (endpoint, path-style addressing, credentials) that mocks hide by construction. The infrastructure is already required by Compose, so it costs nothing extra to run.
- **Cons:** Integration tests get slower and need real cleanup (bucket objects, queue keys) between runs. Requires a small binary fixture in the repository. The suite cannot run without the Compose stack up — already true today because of PostgreSQL and Mailpit.

### Option B: Mock the storage and queue clients everywhere
- Stub the S3 client and the BullMQ `Queue` at every layer; no new containers touched by tests.
- **Pros:** Fast and hermetic. No fixture file, no cleanup.
- **Cons:** Verifies only that the code calls the mocks the way the test author imagined. Every real failure mode of this phase — a wrong `forcePathStyle`, a malformed multipart completion, a `Content-Range` off by one, an ffprobe field that is a string where a number was expected — passes a fully mocked suite. For a phase whose entire substance is integration with external systems, this is coverage theatre.

### Option C: Testcontainers — programmatically start MinIO and Redis per test run
- Spin the dependencies up from the test process instead of relying on Compose.
- **Pros:** Tests are self-contained and isolated from the dev environment's state.
- **Cons:** Requires Docker-in-Docker or a mounted socket, since the suite itself runs inside a container. Adds a dependency and significant per-run startup time. Duplicates the Compose stack the project already stands up and documents as the way to run everything.

**Recommendation:** **Option A** — the project's own convention already points here (Mailpit is driven for real), and the phase's risk is concentrated exactly in the seams that mocks cannot check. Option C solves an isolation problem the project does not have, at the cost of nested Docker. The cleanup burden is real and is handled the same way the existing integration specs handle table cleanup: an explicit teardown per suite.

**Decision:** A (MinIO, Redis e FFmpeg reais nos specs de integração)

**Libraries:** — _(infra do Compose; sem dependência npm nova)_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | A (BullMQ + Redis) | A (BullMQ + Redis) |
| TD-02 | Cross-layer | 10GB Upload Strategy | A (Presigned S3 multipart) | A (Presigned S3 multipart upload) |
| TD-03 | Backend | Object Storage Client and Bucket/Key Layout | A (AWS SDK v3, single bucket with prefixes) | A (AWS SDK v3 + presigner, single bucket with prefixes) |
| TD-04 | Backend | Video Worker Execution Model | A (Separate service, Nest standalone context) | A (Separate Compose service, Nest standalone context) |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation | A (Direct ffprobe/ffmpeg via child_process) | A (Direct ffprobe/ffmpeg via child_process) |
| TD-06 | Cross-layer | Unique Video URL Identifier | A (Random short id via node:crypto) | A (Random short id via node:crypto) |
| TD-07 | Cross-layer | Video Delivery — Streaming and Download | C (Range proxy for stream, presigned redirect for download) | C (Range proxy for stream, presigned redirect for download) |
| TD-08 | Backend | Video Status Lifecycle and Failure Handling | A (draft → processing → ready \| failed) | A (draft → processing → ready \| failed) |
| TD-09 | Backend | Integration Testing Strategy for Storage and Queue | A (Real MinIO/Redis/FFmpeg in integration specs) | A (Real MinIO/Redis/FFmpeg in integration specs) |
