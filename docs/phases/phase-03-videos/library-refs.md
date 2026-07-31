---
kind: phase
name: phase-03-videos
generated_by: plan-resolve
date: 2026-07-31
---

# phase-03-videos — Library References

Versions pinned for the new stack introduced by this phase, confirmed against the npm registry and the official documentation via the **context7** MCP server. Resolves `DG-1` from `validation.md`.

## Pinned versions

| Package | Version | TD | Role |
|---------|---------|----|------|
| `@nestjs/bullmq` | `^11.0.4` | TD-01 | NestJS wrapper: `BullModule.forRootAsync`, `registerQueue`, `@Processor`, `WorkerHost` |
| `bullmq` | `^5.81.3` | TD-01 | Queue engine. Brings `ioredis@5.11.1` as a direct dependency |
| `@aws-sdk/client-s3` | `^3.1101.0` | TD-03 | S3 command objects, used against MinIO |
| `@aws-sdk/s3-request-presigner` | `^3.1101.0` | TD-02, TD-03, TD-07 | `getSignedUrl` for `UploadPart` and `GetObject` |

Infrastructure images (no npm install):

| Image | Tag | TD | Role |
|-------|-----|----|------|
| `redis` | `8-alpine` | TD-01 | Queue broker |
| `minio/minio` | `latest` | TD-03 | S3-compatible object storage |
| `ffmpeg` (Debian package) | distro | TD-05 | `ffprobe` and `ffmpeg` binaries in the dev/worker image |

## Version constraints that are not obvious

**`bullmq` must be `^5`, not `^6`.** `@nestjs/bullmq@11.0.4` declares `peerDependencies: { bullmq: "^3.0.0 || ^4.0.0 || ^5.0.0" }`. The current `bullmq` latest is `6.0.3`, which is outside that range. Installing `bullmq@6` alongside the wrapper produces a peer-dependency conflict. Pin `^5.81.3`.

**`ioredis` is not installed directly.** `bullmq@5.81.3` lists `ioredis: 5.11.1` in its own `dependencies`, so it resolves transitively. Adding it to `package.json` would risk two copies of the client.

**`nanoid` is deliberately absent.** `nanoid@6` publishes `"type": "module"` with no CommonJS entry point. This project compiles to CommonJS (`nest build`, no `"type": "module"` in `package.json`), so it cannot be `require`d from `dist/`. TD-06 therefore generates the public id from `node:crypto` instead of pinning the legacy `nanoid@3`.

## Confirmed API surface

### `@nestjs/bullmq` — module registration and processor

Source: BullMQ official docs, `docs/gitbook/guide/nestjs/README.md` (via context7).

```typescript
// Root registration (connection shared by every queue)
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});

// Per-queue registration (producer side)
BullModule.registerQueue({ name: 'video-processing' });

// Consumer side
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* ... */ }
}
```

The producer injects the queue with `@InjectQueue('video-processing') private readonly queue: Queue`.

### `bullmq` — retry policy

Source: BullMQ official docs, `docs/gitbook/guide/retrying-failing-jobs.md` (via context7).

```typescript
await queue.add(
  'process-video',
  { videoId },
  { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
);
```

`attempts` counts the total number of tries, not the number of retries after the first failure. `@OnWorkerEvent('failed')` fires on every failed attempt, so the terminal-failure branch must check `job.attemptsMade >= job.opts.attempts` before writing the `failed` status (TD-08).

### `@aws-sdk/client-s3` — multipart lifecycle

Source: `aws-sdk-js-v3`, `clients/client-s3/test/e2e/S3.e2e.spec.ts` and `lib/lib-transfer-manager` (via context7).

```typescript
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));
// each part is uploaded by the client via a presigned URL; the client returns ETags
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"..."' }] },
}));
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

`Parts` must be ordered by `PartNumber` ascending, and every `ETag` must be sent back exactly as the storage service returned it, quotes included.

### `@aws-sdk/s3-request-presigner` — presigning

Source: `packages/s3-request-presigner/README.md` (via context7).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), {
  expiresIn: 3600, // seconds; defaults to 900
});
```

The same helper presigns `GetObjectCommand`, which TD-07 uses for the download redirect. `ResponseContentDisposition` on `GetObjectCommand` sets the browser's save-as behaviour and is included in the signature.

### `@aws-sdk/client-s3` — MinIO endpoint

Source: `supplemental-docs/CLIENTS.md` (via context7).

```typescript
new S3Client({
  endpoint: 'http://minio:9000',
  forcePathStyle: true,      // required: MinIO does not serve virtual-host-style buckets
  region: 'us-east-1',       // arbitrary but required by the signer
  credentials: { accessKeyId, secretAccessKey },
});
```

Without `forcePathStyle: true` the SDK builds `http://streamtube.minio:9000/...`, which does not resolve inside the Compose network.

### `ffprobe` / `ffmpeg` — invocation contract

No library. Both are driven through `execFile` from `node:child_process`, which takes an argument array and therefore never passes the filename through a shell.

```bash
# metadata
ffprobe -v error -print_format json -show_format -show_streams <input>

# thumbnail from a single frame
ffmpeg -y -ss <seconds> -i <input> -frames:v 1 -vf scale=1280:-2 -q:v 3 <output.jpg>
```

`-show_format` yields `format.duration` and `format.size` as **strings**, and `-show_streams` yields `width` / `height` as numbers on the video stream. The mapping layer must coerce explicitly; assuming a number where ffprobe returns a string is the classic failure here.

Placing `-ss` **before** `-i` makes the seek an input seek, which jumps directly to the keyframe instead of decoding from the start. On a multi-gigabyte file that is the difference between a sub-second thumbnail and minutes of decoding.
