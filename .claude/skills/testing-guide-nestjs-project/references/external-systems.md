> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — MinIO (Real, Docker)

**Strategy:** Real S3-compatible storage via the Docker `minio` service. MinIO in development and tests, Amazon S3 in production — the same API, so only environment variables change.

> Decided in `docs/decisions/technical-decisions-phase-03-videos.md` TD-03 and TD-09. A local-filesystem adapter was rejected: it cannot exercise presigned URLs, multipart upload or range reads, which are the three mechanisms the video pipeline depends on.

**Setup:**
- MinIO is in `compose.yaml` with the API on port 9000 and the console on 9001
- Tests reach it through `StorageService`, configured from `storage.config.ts` — no separate test wiring

**Test isolation:**
- Prefix every test object with a unique id so parallel-ish suites cannot collide
- Delete created objects in `afterAll` via `storageService.deleteObject(key)`
- The bucket itself is created idempotently at module bootstrap; tests never create or drop it

**Integration test:**
```typescript
describe('StorageService (integration)', () => {
  const key = `test/${crypto.randomUUID()}.txt`;

  afterAll(async () => {
    await storageService.deleteObject(key);
  });

  it('uploads and reads back a byte range', async () => {
    await storageService.putObject(key, Buffer.from('test content'));

    const { body, contentRange } = await storageService.getObjectRange(key, 0, 3);
    expect(contentRange).toBe('bytes 0-3/12');
    expect((await streamToBuffer(body)).toString()).toBe('test');
  });
});
```

**Key points:**
- Presigning is only meaningful against a real endpoint — a mocked client cannot catch a wrong `forcePathStyle`, a bad endpoint, or an expired-signature bug
- `forcePathStyle: true` is required for MinIO; without it the SDK builds virtual-host-style URLs that do not resolve to the container

---

## Message Queue — BullMQ + Redis (Real, Docker)

**Strategy:** Real Redis broker via the Docker `redis` service, driven through BullMQ.

> Decided in `docs/decisions/technical-decisions-phase-03-videos.md` TD-01. `@nestjs/bullmq@11` peer-requires `bullmq@^3 || ^4 || ^5` — pin `bullmq@^5`, not `^6`.

**Test isolation:**
- Call `await queue.obliterate({ force: true })` in `beforeEach` so a leftover job from a previous suite cannot satisfy an assertion
- For publisher tests: assert the job is enqueued with the correct data
- For consumer tests: invoke the processor's `process(job)` directly with a stub `Job` — this keeps the assertion on the processing outcome instead of on BullMQ's scheduling

**Setup pattern:**
```typescript
// In test module
BullModule.forRoot({
  connection: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

```typescript
describe('VideosService (integration - queue)', () => {
  let queue: Queue;

  beforeEach(async () => {
    queue = module.get<Queue>(getQueueToken('video-processing'));
    await queue.obliterate({ force: true });
  });

  it('enqueues a processing job when the upload completes', async () => {
    await videosService.completeUpload(videoId, ownerChannelId, parts);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual(
      expect.objectContaining({ videoId: expect.any(String) }),
    );
  });
});
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
