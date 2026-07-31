---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-31T19:07:11-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-31T20:01:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-07-31T20:04:00-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-07-31T20:06:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-31T20:03:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion pipeline end to end: object storage and a job queue as new infrastructure, a 10GB upload that never routes bytes through the API, automatic background processing that extracts metadata and cuts a thumbnail, a short unique public URL per video, and playback by byte range plus a direct download.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install the phase's production dependencies, add `storage`, `queue` and `video` config namespaces following the `registerAs` pattern inherited from Fase 01, extend the Joi schema, and stand up the new infrastructure in Compose: MinIO for object storage, Redis for the queue, and a `video-worker` service. Add `ffmpeg` to the dev image so both the worker and the integration suite have the binaries.

**Technical actions:**

- Install in `nestjs-project`: `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.3`, `@aws-sdk/client-s3@^3.1101.0`, `@aws-sdk/s3-request-presigner@^3.1101.0`. Pin `bullmq` to `^5` — `@nestjs/bullmq@11` peer-requires `^3 || ^4 || ^5` and rejects `^6` (see `library-refs.md`). Do not install `ioredis`; `bullmq@5.81.3` already depends on `ioredis@5.11.1`.
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (default `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (default `http://localhost:9000` — the host-reachable URL baked into presigned URLs), `STORAGE_REGION` (default `us-east-1`), `STORAGE_BUCKET` (default `streamtube`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_UPLOAD_URL_TTL_SECONDS` (default `3600`), `STORAGE_DOWNLOAD_URL_TTL_SECONDS` (default `300`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`).
- Create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_SIZE_BYTES` (default `10737418240` = 10GB), `VIDEO_PART_SIZE_BYTES` (default `104857600` = 100MB), `VIDEO_THUMBNAIL_TIMESTAMP_SECONDS` (default `1`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`).
- Update `src/config/env.validation.ts` — add every new variable to the Joi schema with the defaults above; `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` required. Mirror all of them in `.env.example` with Compose-compatible values.
- Update `nestjs-project/compose.yaml`: add `minio` (image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` and `9001:9001`, `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, healthcheck on `/minio/health/live`, named volume); add `redis` (image `redis:8-alpine`, port `6379:6379`, healthcheck `redis-cli ping`); add `video-worker` (same build context and image as `nestjs-api`, no published port, `depends_on` db/redis/minio). Make `nestjs-api` depend on `minio` and `redis` being healthy.
- Update `nestjs-project/Dockerfile.dev` — add `ffmpeg` to the `apt install` line. The same image serves the API, the worker and the test runner, so `ffprobe` and `ffmpeg` are available to integration specs (TD-04, TD-09).
- Register `storageConfig`, `queueConfig` and `videoConfig` in `AppModule`'s `ConfigModule.forRoot({ load: [...] })`.

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings `db`, `mailpit`, `minio`, `redis`, `nestjs-api` and `video-worker` to a running state, with `minio` and `redis` reporting healthy
- MinIO console answers at `http://localhost:9001` and the S3 API at `http://localhost:9000`
- `docker compose exec nestjs-api ffprobe -version` and `ffmpeg -version` both succeed
- The application boots with the new variables present, and fails at bootstrap with a Joi validation error when `STORAGE_ACCESS_KEY` is absent
- The existing suite is unaffected — `npm test` and `npm run test:e2e` stay green

---

### SI-03.2 — Storage Module: S3-compatible Client and StorageService

**Description:** Create a `StorageModule` owning the S3 client and a `StorageService` that exposes every storage operation the phase needs: idempotent bucket bootstrap, the multipart lifecycle, presigning for upload parts and downloads, byte-range reads for streaming, and object deletion. This is the only module that knows the storage API exists.

**Technical actions:**

- Create `src/storage/storage.constants.ts` — export `STORAGE_CLIENT` injection token and `STORAGE_PREFIXES = { VIDEOS: 'videos', THUMBNAILS: 'thumbnails' } as const`.
- Create `src/storage/storage.module.ts` — provides `STORAGE_CLIENT` via a factory that builds `new S3Client({ endpoint, region, forcePathStyle: true, credentials })` from `storageConfig`. `forcePathStyle: true` is mandatory: without it the SDK builds virtual-host-style URLs that do not resolve inside the Compose network. Provides and exports `StorageService`.
- Create `src/storage/storage.service.ts` — `StorageService` implementing `OnModuleInit`. On init call `ensureBucket()`: `HeadBucketCommand`, and on `NotFound` / 404 issue `CreateBucketCommand`; any other error re-throws. Methods:
  - `buildSourceKey(videoId, extension)` → `videos/{videoId}/source{ext}` and `buildThumbnailKey(videoId)` → `thumbnails/{videoId}.jpg`
  - `createMultipartUpload(key, contentType): Promise<string>` returning `UploadId`
  - `presignUploadPart(key, uploadId, partNumber): Promise<string>` via `getSignedUrl` over `UploadPartCommand`, TTL from `storage.uploadUrlTtlSeconds`, host rewritten to `publicEndpoint` so the URL is reachable from outside the Compose network
  - `completeMultipartUpload(key, uploadId, parts)` — `parts` sorted ascending by `PartNumber` before the call
  - `abortMultipartUpload(key, uploadId)`
  - `headObject(key): Promise<{ contentLength, contentType }>`
  - `getObjectRange(key, start?, end?): Promise<{ body, contentLength, contentRange, contentType }>` passing a `Range` header through to `GetObjectCommand`
  - `presignGetObject(key, { downloadFilename? }): Promise<string>` setting `ResponseContentDisposition` when a filename is given
  - `putObject(key, body, contentType)` and `deleteObject(key)`
- Never let a NestJS HTTP exception escape this service — storage failures propagate as-is and are mapped by the caller (inherited convention from Fase 02).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: bucket bootstrap is idempotent; multipart create → upload part → complete produces a readable object; abort removes the pending upload; `getObjectRange` returns the exact slice with a correct `Content-Range`; presigned PUT and GET URLs are usable end to end; `deleteObject` removes the object |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with the `STORAGE_CLIENT` factory and `ConfigModule` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- The bucket is created on first boot and a second boot does not fail or recreate it
- A file uploaded through the multipart lifecycle can be read back byte-identical
- `getObjectRange(key, 0, 3)` on a 12-byte object returns 4 bytes and `Content-Range: bytes 0-3/12`
- A presigned upload-part URL accepts a `PUT` from outside the container network and returns an `ETag`
- Aborting a multipart upload leaves no object at the target key

---

### SI-03.3 — Video Entity, Status Enum, Public Id Generation, and Migration

**Description:** Create the `Video` entity owned by a channel, with the status lifecycle from TD-08 and the short public identifier from TD-06, plus the migration that creates the table.

**Technical actions:**

- Create `src/videos/video-status.enum.ts` — `export enum VideoStatus { DRAFT = 'draft', PROCESSING = 'processing', READY = 'ready', FAILED = 'failed' }`.
- Create `src/videos/public-id.util.ts` — `generatePublicId(): string` producing 11 characters drawn uniformly from a 64-symbol URL-safe alphabet (`A-Za-z0-9_-`) using `crypto.randomBytes`. Draw the alphabet index with a bitmask over 6 bits so the distribution stays uniform (a plain modulo over 256 biases the first 192 symbols).
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` per the Data Model below, with `@ManyToOne(() => Channel)` and `@JoinColumn({ name: 'channel_id' })`, `@Index` on `public_id` (unique), `channel_id` and `status`.
- Create `src/videos/videos.module.ts` with `TypeOrmModule.forFeature([Video])` and export `TypeOrmModule` (the entity must be in a `forFeature` or `autoLoadEntities` silently misses it — inherited convention from Fase 02).
- Generate the migration with `npm run migration:generate -- src/database/migrations/CreateVideos` and review the SQL. The generated `up()` will `CREATE TYPE "videos_status_enum"`; extend `MANAGED_ENUM_TYPES` in `src/database/migrations.integration-spec.ts` and `MANAGED_TABLES` with the new table so the migration suite still starts from a clean schema.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Length is 11; alphabet is restricted to `[A-Za-z0-9_-]`; 10,000 draws produce no duplicate; every alphabet symbol is reachable |
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | `public_id` unique constraint rejects a duplicate; `status` defaults to `draft`; the status enum rejects an unknown value; `channel_id` FK is enforced; nullable metadata columns accept `null`; timestamps auto-populate |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` |
| `src/database/migrations.integration-spec.ts` | Integration | The updated suite still applies and reverts every migration cleanly with `videos` included |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with every column, the `videos_status_enum` type, and the three indexes
- Inserting two videos with the same `public_id` fails on the unique constraint
- A newly inserted video has `status = 'draft'` without the caller setting it
- Inserting a video with a `channel_id` that does not exist fails on the foreign key
- `generatePublicId()` returns 11 URL-safe characters and no collision appears across 10,000 draws

---

### SI-03.4 — Channel Lookup by Owner

**Description:** Give `ChannelsService` a read path from a user id to that user's channel, and export it. Closes `DG-1`'s sibling gap `DG-2` from `validation.md`: every upload endpoint must resolve the owning channel from the JWT `sub`, and doing that by injecting the channels repository into the video module would break the module boundary the project's Working Principles mandate.

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts`, injecting `@InjectRepository(Channel) private readonly channelRepository: Repository<Channel>` (the service currently injects only `DataSource`).
- Ensure `ChannelsModule` exports `ChannelsService` — it already does; confirm the export survives.
- Add `ChannelNotFoundException` to `src/common/exceptions/domain.exception.ts` with code `CHANNEL_NOT_FOUND` and HTTP 404, for the case where an authenticated user somehow has no channel.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` | Unit | `findByUserId` delegates to the repository with the right `where` clause and returns `null` when absent |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` returns the channel created for a registered user, and `null` for an unknown user id |

**Dependencies:** None

**Acceptance criteria:**

- `findByUserId` returns the channel created by Fase 02's registration flow for that user
- `findByUserId` returns `null` for a user id with no channel
- `ChannelsModule` exports `ChannelsService`, so the video module resolves the owner without touching the channels repository directly

---

### SI-03.5 — Upload Initiation with Draft Pre-registration

**Description:** Implement `POST /videos/uploads`. The endpoint pre-registers the video as a draft, opens a multipart upload against storage, and returns one presigned URL per part. No video bytes reach the API — the request body carries only file metadata.

**Technical actions:**

- Create `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto` with `@IsString() @IsNotEmpty() @MaxLength(255)` `filename`, `@IsInt() @Min(1) @Max(VIDEO_MAX_SIZE_BYTES)` `size_bytes`, and `@IsIn(ALLOWED_VIDEO_CONTENT_TYPES)` `content_type`.
- Create `src/videos/videos.constants.ts` — `ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'] as const` and `VIDEO_PROCESSING_QUEUE = 'video-processing' as const`, `PROCESS_VIDEO_JOB = 'process-video' as const`.
- Add `VideoFileTooLargeException` (`VIDEO_FILE_TOO_LARGE`, 400) and `UnsupportedVideoTypeException` (`UNSUPPORTED_VIDEO_TYPE`, 400) to the domain exceptions.
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `ChannelsService`, `StorageService` and `videoConfig`. Implement `initiateUpload(userId, dto)`:
  1. resolve the channel via `channelsService.findByUserId(userId)`, throwing `ChannelNotFoundException` when absent
  2. validate `size_bytes` against `video.maxSizeBytes` and `content_type` against the allowlist (defence in depth — the DTO already rejects both)
  3. generate a unique `public_id`, retrying up to 5 times on the unique-constraint violation
  4. persist the `Video` row with `status = draft`, the derived `source_key`, `original_filename`, `content_type` and `size_bytes`
  5. `storageService.createMultipartUpload(sourceKey, contentType)` and persist the returned `upload_id`
  6. compute `partCount = ceil(size_bytes / video.partSizeBytes)` and presign one `UploadPart` URL per part
  7. return `{ video_id, public_id, upload_id, part_size, parts, expires_in }`
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos')`, `@Post('uploads')` returning 201, authenticated (no `@Public()`), `@ApiBearerAuth('access-token')`, owner taken from `@CurrentUser()`. Full OpenAPI annotations per `.claude/rules/nestjs-controllers.md`, errors referencing `getSchemaPath(ApiErrorEnvelope)`.
- Register `VideosModule` in `AppModule`; `VideosModule` imports `ChannelsModule`, `StorageModule` and `TypeOrmModule.forFeature([Video])`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Initiate: resolves channel, rejects when the user has no channel, rejects oversize and unsupported type, computes the correct part count at exact and non-exact multiples of the part size, retries on public-id collision |
| `src/videos/videos.service.integration-spec.ts` | Integration | Initiate persists a `draft` row with `upload_id` and `source_key` set, and opens a real multipart upload in MinIO |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` returns 201 with the presigned part list; 401 without a token; 400 on an oversize `size_bytes`, an unsupported `content_type`, and a missing field |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos/uploads` with valid metadata returns 201 and a video row exists with `status = 'draft'`, a unique `public_id`, and a non-null `upload_id`
- The response carries `ceil(size_bytes / part_size)` presigned URLs, numbered from 1
- The request body accepts only metadata — no endpoint in this phase accepts video bytes in a request body
- `size_bytes` above 10GB returns 400 `VIDEO_FILE_TOO_LARGE` (or a validation error from the DTO bound)
- An unsupported `content_type` returns 400
- The endpoint returns 401 without a valid access token

---

### SI-03.6 — Upload Completion, Abort, and Job Enqueue

**Description:** Implement `POST /videos/uploads/:videoId/complete` and `DELETE /videos/uploads/:videoId`. Completion closes the multipart upload, flips the row to `processing`, and enqueues the processing job. Abort cancels the multipart upload and deletes the draft row. Both enforce ownership.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with a `@ValidateNested({ each: true }) @Type(() => UploadedPartDto) @ArrayMinSize(1)` `parts` array, where `UploadedPartDto` has `@IsInt() @Min(1)` `part_number` and `@IsString() @IsNotEmpty()` `etag`.
- Add `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotOwnedException` (`VIDEO_NOT_OWNED`, 403) and `UploadNotInProgressException` (`VIDEO_UPLOAD_NOT_IN_PROGRESS`, 409) to the domain exceptions.
- Register the queue in `VideosModule` with `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, and `BullModule.forRootAsync` in `AppModule` reading `queueConfig`.
- Implement `completeUpload(userId, videoId, dto)` in `VideosService`: load the video with its channel; throw `VideoNotFoundException` when absent; throw `VideoNotOwnedException` when the video's channel does not belong to `userId`; throw `UploadNotInProgressException` when `status !== draft` or `upload_id` is null. Call `storageService.completeMultipartUpload`, then `headObject` to record the authoritative `size_bytes`, set `status = processing`, clear `upload_id`, save, and enqueue `PROCESS_VIDEO_JOB` with `{ videoId }` and `{ attempts: video.processingAttempts, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: false }`.
- Implement `abortUpload(userId, videoId)`: same ownership and state guards, then `storageService.abortMultipartUpload` and delete the row.
- Add both routes to `VideosController` with full OpenAPI annotations. Complete returns 200 with `{ id, public_id, status }`; abort returns 204.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Complete: rejects unknown video, foreign owner, and a video not in `draft`; sorts parts by number before calling storage; enqueues exactly one job with the video id and the configured retry options. Abort: same guards, calls abort and deletes |
| `src/videos/videos.service.integration-spec.ts` | Integration | Complete against real MinIO and Redis: the object exists at `source_key`, the row is `processing` with `upload_id` cleared and `size_bytes` from `headObject`, and exactly one job is waiting on the queue. Abort removes the pending upload and the row |
| `test/videos.e2e-spec.ts` | E2E | Full handshake: initiate → PUT each part to the presigned URL → complete returns 200 with `status: processing`; 403 when another user completes; 409 on double completion; 204 on abort |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- Completing an upload assembles the object in storage and moves the row to `processing`
- `size_bytes` after completion equals the real object size reported by storage, not the client-declared value
- Exactly one `process-video` job is enqueued per completed upload, carrying the video id
- Completing another user's upload returns 403 `VIDEO_NOT_OWNED`
- Completing an already-completed upload returns 409 `VIDEO_UPLOAD_NOT_IN_PROGRESS`
- Aborting removes both the multipart upload and the draft row, and returns 204

---

### SI-03.7 — FFmpeg Metadata Extraction and Thumbnail Generation

**Description:** Create the service that drives `ffprobe` and `ffmpeg`. It reads duration, dimensions, codec and container from a local file, and cuts a single frame into a JPEG. No npm wrapper (TD-05): both are invoked through `execFile` with an argument array, so filenames never reach a shell.

**Technical actions:**

- Create `src/videos/processing/video-metadata.types.ts` — `VideoMetadata` with `durationSeconds: number | null`, `width: number | null`, `height: number | null`, `videoCodec: string | null`, `containerFormat: string | null`.
- Create `src/videos/processing/ffmpeg.service.ts` — `FfmpegService` with:
  - `probe(inputPath): Promise<VideoMetadata>` running `ffprobe -v error -print_format json -show_format -show_streams <input>`, parsing the JSON, picking the first stream with `codec_type === 'video'`, and coercing explicitly: `format.duration` arrives as a **string** and `width`/`height` as numbers. Every field degrades to `null` rather than throwing when absent.
  - `extractThumbnail(inputPath, outputPath, atSeconds): Promise<void>` running `ffmpeg -y -ss <atSeconds> -i <input> -frames:v 1 -vf scale=1280:-2 -q:v 3 <output>`. `-ss` goes **before** `-i` so the seek is an input seek that jumps to the keyframe instead of decoding from the start; on a multi-gigabyte file that is the difference between sub-second and minutes.
  - Both wrap `execFile` in `promisify` with `maxBuffer` raised for the probe JSON, and a timeout so a wedged process cannot hold the worker forever.
  - If the requested thumbnail timestamp exceeds the video duration, fall back to `0`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/ffmpeg.service.integration-spec.ts` | Integration | Against a real fixture generated by ffmpeg at suite setup: `probe` returns the expected duration, dimensions and codec with the right primitive types (duration is a `number`, not the string ffprobe emits); `extractThumbnail` writes a non-empty JPEG whose magic bytes are `FF D8 FF`; probing a non-video file rejects; a timestamp beyond the duration still produces a thumbnail |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `probe` on a 2-second 320x240 fixture returns `durationSeconds ≈ 2` as a `number`, `width = 320`, `height = 240`, and a non-null codec
- `extractThumbnail` produces a readable JPEG file larger than zero bytes
- Probing a file that is not a video rejects instead of returning a half-filled metadata object
- Neither method interpolates a path into a shell string

---

### SI-03.8 — Video Worker: Processor, Standalone Bootstrap, and Status Transitions

**Description:** Build the worker that consumes the queue. It downloads the source from storage to a temporary file, probes it, cuts a thumbnail, uploads the thumbnail, writes the metadata and flips the row to `ready`. On terminal failure it writes `failed` plus the reason. It runs in its own container as a NestJS standalone application context, and its processor is registered in a module the API never imports (TD-04) — that is what guarantees the API never consumes jobs.

**Technical actions:**

- Create `src/videos/processing/video-processing.service.ts` — `VideoProcessingService.process(videoId)`:
  1. load the video, and return early if it is not in `processing` (an idempotent no-op for a redelivered job)
  2. stream `source_key` from storage into a temp file under `os.tmpdir()`
  3. `ffmpegService.probe(tempPath)`
  4. `ffmpegService.extractThumbnail(...)` at `video.thumbnailTimestampSeconds`, then `storageService.putObject(thumbnailKey, ..., 'image/jpeg')`
  5. persist duration, width, height, codec, container and `thumbnail_key`; set `status = ready` and clear `processing_error`
  6. always remove the temp files in a `finally`
- Create `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` class extending `WorkerHost`, delegating to `VideoProcessingService`. `@OnWorkerEvent('failed')` writes `status = failed` and `processing_error` **only on the terminal attempt** — guard with `job.attemptsMade >= (job.opts.attempts ?? 1)`, otherwise an intermediate retry would mark a video failed while BullMQ is still retrying it.
- Create `src/videos/processing/processing.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `StorageModule` and `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; provides `FfmpegService`, `VideoProcessingService` and `VideoProcessingProcessor`.
- Create `src/worker/worker.module.ts` — the worker's composition root: `ConfigModule.forRoot` with the same namespaces, `TypeOrmModule.forRootAsync` with the same factory, and `ProcessingModule`. Create `src/worker/main.ts` calling `NestFactory.createApplicationContext(WorkerModule)` and `enableShutdownHooks()`. No HTTP listener.
- Add `"start:worker:dev": "nest start --watch --entryFile worker/main"` to `package.json` scripts, and set that as the `video-worker` service command in `compose.yaml`.
- **`AppModule` must not import `ProcessingModule`.** The API registers only the producer queue; the consumer lives exclusively in `WorkerModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.service.integration-spec.ts` | Integration | Full pipeline against real MinIO and a real fixture: after `process(videoId)` the row is `ready` with duration, dimensions and `thumbnail_key` populated, and the thumbnail object exists in storage. A video not in `processing` is a no-op. A source object that is not a valid video leaves the row untouched and rethrows |
| `src/videos/processing/video-processing.processor.spec.ts` | Unit | `process` delegates to the service; `onFailed` writes `failed` + `processing_error` on the terminal attempt and does nothing on an intermediate retry |
| `src/videos/processing/processing.module.spec.ts` | Unit | Module compiles with the queue, storage and repository wiring |
| `src/worker/worker.module.spec.ts` | Unit | Worker composition root compiles standalone |

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- Processing a completed upload moves the row from `processing` to `ready` with `duration_seconds`, `width`, `height`, `video_codec`, `container_format` and `thumbnail_key` all populated
- The generated thumbnail exists in storage under `thumbnails/{videoId}.jpg`
- A failure on an intermediate attempt leaves the row in `processing` so BullMQ can retry; only the terminal attempt writes `failed` with a non-null `processing_error`
- Temporary files are removed whether processing succeeds or fails
- The `video-worker` container consumes jobs and the API container does not — `AppModule` has no reference to `ProcessingModule`

---

### SI-03.9 — Video Retrieval and Streaming with HTTP Range

**Description:** Implement `GET /videos/:publicId` and `GET /videos/:publicId/stream`. Both are public — the project plan grants anonymous users free viewing. The stream endpoint forwards the client's `Range` header to storage and answers `206 Partial Content`, so playback starts without downloading the whole file (TD-07).

**Technical actions:**

- Create `src/videos/dto/video-response.dto.ts` — the public shape: `public_id`, `title`, `status`, `duration_seconds`, `width`, `height`, `thumbnail_url`, `created_at`, and the owning channel's `nickname`. Storage keys and `upload_id` are never exposed.
- Add `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) and `InvalidRangeException` (`INVALID_RANGE`, 416) to the domain exceptions.
- Implement `findByPublicId(publicId)` in `VideosService`, loading the channel relation and throwing `VideoNotFoundException` when absent.
- Implement `streamVideo(publicId, rangeHeader)` in `VideosService`: load the video, throw `VideoNotReadyException` unless `status === ready`, parse the `Range` header (`bytes=start-end`, with the open-ended and suffix forms), throw `InvalidRangeException` when `start` exceeds the object size or the range is malformed, and delegate to `storageService.getObjectRange`.
- Add `@Public() @Get(':publicId')` and `@Public() @Get(':publicId/stream')` to `VideosController`. The stream handler takes `@Res() res: Response`, sets `Accept-Ranges: bytes`, `Content-Type`, `Content-Length` and — when a range was requested — `Content-Range` with status 206, then pipes the storage body to the response. Without a `Range` header it answers 200 with the whole object. Full OpenAPI annotations.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Range parsing: `bytes=0-1023`, open-ended `bytes=1024-`, suffix `bytes=-500`, malformed input, and a start beyond the object size |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` returns 200 with the public shape and leaks no storage key; 404 for an unknown id. `GET /videos/:publicId/stream` with `Range: bytes=0-99` returns 206, `Content-Range: bytes 0-99/<size>`, `Content-Length: 100` and exactly 100 bytes; without a `Range` header returns 200 and `Accept-Ranges: bytes`; returns 409 for a video that is not `ready`; returns 416 for an out-of-bounds range. Both endpoints work with no `Authorization` header |

**Dependencies:** SI-03.3, SI-03.8

**Acceptance criteria:**

- `GET /videos/:publicId/stream` with `Range: bytes=0-99` answers 206 with exactly 100 bytes and a correct `Content-Range`
- The same endpoint without a `Range` header answers 200 and advertises `Accept-Ranges: bytes`
- A partial request never transfers the whole object — the response body length equals the requested slice
- Both endpoints are reachable anonymously
- The video resource response contains no `source_key`, `thumbnail_key` or `upload_id`
- A video whose status is not `ready` returns 409 `VIDEO_NOT_READY`

---

### SI-03.10 — Video Download via Presigned Redirect

**Description:** Implement `GET /videos/:publicId/download`. It answers `302` with a short-lived presigned URL carrying a `Content-Disposition: attachment` override, so the full-file transfer is served by storage rather than by the API (TD-07).

**Technical actions:**

- Implement `buildDownloadUrl(publicId)` in `VideosService`: load the video, require `status === ready`, and call `storageService.presignGetObject(source_key, { downloadFilename: original_filename })` with the download TTL. The presigner sets `ResponseContentDisposition: attachment; filename="..."`, which is part of the signature.
- Add `@Public() @Get(':publicId/download')` to `VideosController`, returning `@Redirect()` / an explicit 302 with the `Location` header. Annotate 302, 404 and 409 in OpenAPI.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Requires `ready` status; passes the original filename to the presigner |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId/download` returns 302 with a `Location` pointing at the storage endpoint and carrying a signature; following that URL returns the full object with an `attachment` disposition; 404 for an unknown id; 409 for a non-`ready` video; reachable anonymously |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- The endpoint answers 302 and the `Location` header is a presigned storage URL, not an API path
- Following the redirect downloads the complete original file
- The download is served with `Content-Disposition: attachment` and the original filename
- A non-`ready` video returns 409, an unknown id returns 404
- The endpoint is reachable without authentication

---

### SI-03.11 — OpenAPI Contract Refresh and Documentation Update

**Description:** Regenerate the exported OpenAPI contract so it includes the video endpoints, and bring the AI-facing documentation in line with the code that now exists.

**Technical actions:**

- Run `npm run openapi:export` and commit the refreshed `nestjs-project/openapi.json`.
- Extend `src/openapi-export.integration-spec.ts` with an assertion that every `videos` path carries a non-empty `summary`, mirroring the existing check for `auth`.
- Update `nestjs-project/CLAUDE.md`: add the `minio`, `redis` and `video-worker` services to the Development Environment section, document `npm run start:worker:dev`, and record that integration tests exercise real MinIO and Redis.
- Update the root `CLAUDE.md`: add a Video Pipeline section describing the upload handshake, the queue and worker, the status lifecycle, and the delivery endpoints. The Architecture section's queue entry is already corrected to `Redis + BullMQ` by `plan-resolve`.
- Update `README.md`: new services and ports, the worker, and the Fase 03 status and endpoint tables.

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `openapi.json` contains every video path with summaries, request schemas and the shared error envelope on error responses
- `npm test` passes with the extended OpenAPI assertion
- `CLAUDE.md` and `README.md` describe only files, services and commands that actually exist in the repository

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| public_id | varchar(16) | unique, not null | 11-char URL-safe short id (TD-06) |
| title | varchar(255) | not null | Derived from the original filename at initiation; editable in Fase 04 |
| channel_id | uuid | FK → channels.id, not null | Owning channel |
| status | enum | not null, default `'draft'` | `draft` \| `processing` \| `ready` \| `failed` (TD-08) |
| source_key | varchar(512) | not null | `videos/{id}/source{ext}` |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}.jpg`, set by the worker |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; cleared on completion |
| original_filename | varchar(255) | not null | Used for the download filename |
| content_type | varchar(127) | not null | From the allowlist |
| size_bytes | bigint | nullable | Client-declared at initiation, overwritten with the authoritative value from `headObject` at completion |
| duration_seconds | numeric(10,3) | nullable | From ffprobe |
| width | integer | nullable | From ffprobe |
| height | integer | nullable | From ffprobe |
| video_codec | varchar(64) | nullable | From ffprobe |
| container_format | varchar(64) | nullable | From ffprobe |
| processing_error | text | nullable | Terminal failure reason (TD-08) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(public_id)` unique, `(channel_id)`, `(status)`

#### Storage key layout (TD-03)

Single bucket `streamtube`:

| Prefix | Key | Written by |
|--------|-----|-----------|
| `videos/` | `videos/{videoId}/source{ext}` | Client, via presigned multipart parts |
| `thumbnails/` | `thumbnails/{videoId}.jpg` | Worker, via `PutObject` |

---

### API Contracts

#### POST /videos/uploads (SI-03.5)

**Request headers:** `Authorization: Bearer <access_token>`, `Content-Type: application/json`

**Request body:**
- filename: string, required — max 255 chars
- size_bytes: integer, required — 1 to 10737418240 (10GB)
- content_type: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`

**Response 201:**
- video_id: string (uuid)
- public_id: string — 11 chars
- upload_id: string — storage multipart id
- part_size: integer — bytes per part (100MB)
- parts: array of `{ part_number: integer, url: string }` — one presigned URL per part
- expires_in: integer — seconds until the presigned URLs expire

**Error responses:**
- 400 VALIDATION_ERROR / VIDEO_FILE_TOO_LARGE / UNSUPPORTED_VIDEO_TYPE
- 401: missing or invalid access token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel

---

#### POST /videos/uploads/{videoId}/complete (SI-03.6)

**Request headers:** `Authorization: Bearer <access_token>`, `Content-Type: application/json`

**Request body:**
- parts: array, required, min 1 — `{ part_number: integer ≥ 1, etag: string }`, the ETags returned by storage for each uploaded part

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string — `processing`

**Error responses:**
- 400 VALIDATION_ERROR
- 401: missing or invalid access token
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: the video is not in `draft` or has no open upload

---

#### DELETE /videos/uploads/{videoId} (SI-03.6)

**Request headers:** `Authorization: Bearer <access_token>`

**Response 204:** No content. The multipart upload is aborted and the draft row deleted.

**Error responses:** 401, 403 VIDEO_NOT_OWNED, 404 VIDEO_NOT_FOUND, 409 VIDEO_UPLOAD_NOT_IN_PROGRESS

---

#### GET /videos/{publicId} (SI-03.9)

**Public — no authentication.**

**Response 200:**
- public_id, title, status, duration_seconds, width, height, thumbnail_url, created_at
- channel: `{ nickname, name }`

**Error responses:** 404 VIDEO_NOT_FOUND

---

#### GET /videos/{publicId}/stream (SI-03.9)

**Public — no authentication.**

**Request headers:** `Range: bytes=<start>-<end>` (optional; open-ended `bytes=<start>-` and suffix `bytes=-<n>` forms accepted)

**Response 206** (when `Range` is present): body is the requested slice.
Headers: `Content-Range: bytes <start>-<end>/<total>`, `Content-Length`, `Content-Type`, `Accept-Ranges: bytes`

**Response 200** (no `Range`): the full object, with `Accept-Ranges: bytes`.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY
- 416 INVALID_RANGE

---

#### GET /videos/{publicId}/download (SI-03.10)

**Public — no authentication.**

**Response 302:** `Location` is a short-lived presigned storage URL with `Content-Disposition: attachment; filename="<original_filename>"`.

**Error responses:** 404 VIDEO_NOT_FOUND, 409 VIDEO_NOT_READY

---

#### Validation Rules — Upload

| Field | Rule | Error |
|-------|------|-------|
| filename | Non-empty string, max 255 | filename should not be empty |
| size_bytes | Integer, 1 to 10737418240 | size_bytes must not be greater than 10737418240 |
| content_type | One of the allowed video MIME types | content_type must be one of the following values: ... |
| parts | Array, min length 1, each with `part_number ≥ 1` and non-empty `etag` | parts must contain at least 1 elements |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner-only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos/uploads | | ✓ | | Owner channel resolved from the JWT `sub` |
| POST /videos/uploads/{videoId}/complete | | ✓ | ✓ | The video's channel must belong to the caller |
| DELETE /videos/uploads/{videoId} | | ✓ | ✓ | Same ownership check |
| GET /videos/{publicId} | ✓ | | | Anonymous viewing per the project plan |
| GET /videos/{publicId}/stream | ✓ | | | Anonymous viewing |
| GET /videos/{publicId}/download | ✓ | | | Anonymous download |

Ownership is enforced in `VideosService`, not in a guard: it is a domain rule, and `.claude/rules/nestjs-layer-separation.md` keeps domain rules in services.

---

### Error Catalog

Error response format is inherited from Fase 02 (`phase-02-auth/TD-07`): `{ statusCode: number, error: string, message: string }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found | An authenticated user with no channel initiates an upload |
| VIDEO_NOT_FOUND | 404 | Video not found | Any endpoint addressing a video id or public id that does not exist |
| VIDEO_NOT_OWNED | 403 | Video does not belong to the authenticated user | Complete or abort on a video owned by another channel |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | No upload in progress for this video | Complete or abort when the video is not `draft` or has no `upload_id` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | Stream or download on a video whose status is not `ready` |
| VIDEO_FILE_TOO_LARGE | 400 | Video exceeds the maximum allowed size | `size_bytes` above 10GB |
| UNSUPPORTED_VIDEO_TYPE | 400 | Unsupported video content type | `content_type` outside the allowlist |
| INVALID_RANGE | 416 | Requested range is not satisfiable | Malformed `Range` header or a start beyond the object size |

`processing_error` is **not** an HTTP error. It is the persisted reason a background job failed terminally, exposed only through the video's `failed` status.

---

### Events / Messages

#### Queue: `video-processing` (TD-01)

**Transport:** BullMQ over Redis. Root connection registered in `AppModule` (producer) and `WorkerModule` (consumer) from `queueConfig`.

| Property | Value |
|----------|-------|
| Queue name | `video-processing` |
| Job name | `process-video` |
| Producer | `VideosService.completeUpload` (API container) |
| Consumer | `VideoProcessingProcessor` (video-worker container) |

**Payload:**

```json
{ "videoId": "<uuid>" }
```

The payload carries only the id. Every other field is read from the database by the worker, so a job that sits in the queue across a deploy can never act on stale data.

**Job options:**

| Option | Value | Rationale |
|--------|-------|-----------|
| `attempts` | 3 (`VIDEO_PROCESSING_ATTEMPTS`) | Absorbs transient storage and container failures |
| `backoff` | `{ type: 'exponential', delay: 1000 }` | 1s, 2s, 4s between attempts |
| `removeOnComplete` | `true` | The database holds the outcome; a completed job has no further use |
| `removeOnFail` | `false` | A terminally failed job is kept for inspection |

**State transitions driven by this queue:**

```
draft ──(complete upload)──> processing ──(job succeeds)──> ready
                                  │
                                  └──(job fails on the final attempt)──> failed + processing_error
```

`attempts` counts total tries, not retries after the first failure. `@OnWorkerEvent('failed')` fires on **every** failed attempt, so the handler must check `job.attemptsMade >= (job.opts.attempts ?? 1)` before writing `failed` — without that guard the first transient failure marks the video failed while BullMQ is still retrying.

**Idempotency:** `VideoProcessingService.process` returns early when the video is not in `processing`, so a redelivered job is a no-op rather than a duplicate thumbnail upload.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
└── SI-03.7

SI-03.4 (no deps)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5
    └── SI-03.6
        └── SI-03.8   (also needs SI-03.7)
            └── SI-03.9
                └── SI-03.10
                    └── SI-03.11
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.7 (parallel) → SI-03.5 → SI-03.6 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11

## Deliverables

- [ ] Object storage (MinIO), queue broker (Redis) and video worker running via `docker compose` alongside the backend
- [ ] Upload of files up to 10GB with no video bytes passing through the API — presigned S3 multipart, 100MB parts
- [ ] Video pre-registered as a draft the moment the upload is initiated
- [ ] Automatic background processing after upload completion, driven by a real queue and a real worker container
- [ ] Duration, dimensions, codec and container extracted with ffprobe and persisted
- [ ] Thumbnail generated from a video frame with ffmpeg and stored in object storage
- [ ] Unique short public URL identifier per video, enforced by a unique index
- [ ] Streaming with HTTP Range and `206 Partial Content` — playback starts without a full download
- [ ] Download available as a presigned redirect with the original filename
- [ ] Status lifecycle `draft → processing → ready | failed` reflected in the database, with the failure reason persisted
- [ ] Migration creating the `videos` table, with the entity related to the owning channel
- [ ] Tests at every level: unit, integration against real MinIO/Redis/FFmpeg, and e2e over the full HTTP handshake
- [ ] `openapi.json` regenerated with the video endpoints
- [ ] `CLAUDE.md` and `README.md` consistent with the delivered code
- [ ] Full suite green (`npm test -- --runInBand`, `npm run test:e2e`)
- [ ] `npx tsc --noEmit` exits 0 and `npm run lint` passes
