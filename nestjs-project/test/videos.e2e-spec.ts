import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import videoConfig from '../src/config/video.config';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { ProcessingModule } from '../src/videos/processing/processing.module';
import { VideoProcessingProcessor } from '../src/videos/processing/video-processing.processor';
import { VideoProcessingService } from '../src/videos/processing/video-processing.service';

const execFileAsync = promisify(execFile);

// The suite runs inside the Compose network; presigned URLs are signed for the
// host-reachable endpoint. Host and port sit outside the S3 signature.
function toInternal(url: string): string {
  const target = new URL(url);
  const internal = new URL(storageConfig().endpoint);
  target.protocol = internal.protocol;
  target.host = internal.host;
  return target.toString();
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let processingService: VideoProcessingService;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let workDir: string;
  let fixture: Buffer;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'videos-e2e-'));
    const fixturePath = join(workDir, 'fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
    fixture = await readFile(fixturePath);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule, ProcessingModule],
    })
      // The API never hosts the queue consumer (TD-04). Stubbing the processor
      // keeps this suite from starting a second BullMQ worker; the pipeline's
      // outcome is asserted by driving VideoProcessingService directly, which
      // is idempotent if the real worker container got there first.
      .overrideProvider(VideoProcessingProcessor)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    processingService = moduleFixture.get(VideoProcessingService);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        storageService?.deleteObject(key).catch(() => undefined),
      ),
    );
    await rm(workDir, { recursive: true, force: true });
    await app?.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(): Promise<string> {
    const email = `uploader_${randomUUID()}@example.com`;
    const password = 'password123';
    const authService = app.get(AuthService);

    const captured = new Promise<string>((resolve) => {
      jest
        .spyOn(authService['mailService'], 'sendConfirmationEmail')
        .mockImplementationOnce((_e: string, _n: string, t: string) => {
          resolve(t);
          return Promise.resolve();
        });
    });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: await captured })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return login.body.access_token as string;
  }

  const uploadPayload = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
  };

  async function initiate(token: string, sizeBytes = fixture.length) {
    const response = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...uploadPayload, size_bytes: sizeBytes })
      .expect(201);

    createdKeys.push(
      `videos/${response.body.video_id}/source.mp4`,
      `thumbnails/${response.body.video_id}.jpg`,
    );
    return response.body;
  }

  async function uploadFixture(initiated: {
    parts: { part_number: number; url: string }[];
  }): Promise<{ part_number: number; etag: string }[]> {
    const put = await fetch(toInternal(initiated.parts[0].url), {
      method: 'PUT',
      body: new Uint8Array(fixture),
    });
    expect(put.status).toBe(200);
    return [{ part_number: 1, etag: put.headers.get('etag')! }];
  }

  async function publishReadyVideo(
    token: string,
  ): Promise<{ videoId: string; publicId: string }> {
    const initiated = await initiate(token);
    const parts = await uploadFixture(initiated);

    await request(app.getHttpServer())
      .post(`/videos/uploads/${initiated.video_id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts })
      .expect(200);

    await processingService.process(initiated.video_id);

    return { videoId: initiated.video_id, publicId: initiated.public_id };
  }

  describe('POST /videos/uploads', () => {
    it('pre-registers the video as a draft and returns presigned parts', async () => {
      const token = await registerAndLogin();

      const body = await initiate(token, 250 * 1024 * 1024);

      expect(body.public_id).toHaveLength(11);
      expect(body.part_size).toBe(videoConfig().partSizeBytes);
      // 250MB over 100MB parts
      expect(body.parts).toHaveLength(3);
      expect(body.parts[0].url).toContain('X-Amz-Signature');

      const stored = await videoRepository.findOneByOrFail({
        id: body.video_id,
      });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.upload_id).toBeTruthy();
    });

    it('keeps a 10GB upload out of the request body and under the part limit', async () => {
      const token = await registerAndLogin();
      const tenGigabytes = 10 * 1024 * 1024 * 1024;

      const body = await initiate(token, tenGigabytes);

      expect(body.parts).toHaveLength(103);
      expect(body.parts.length).toBeLessThan(10_000);
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({ ...uploadPayload, size_bytes: 1024 })
        .expect(401);
    });

    it('returns 400 for a size above the maximum', async () => {
      const token = await registerAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...uploadPayload, size_bytes: 10 * 1024 * 1024 * 1024 + 1 })
        .expect(400);

      expect(response.body.error).toBe('VIDEO_FILE_TOO_LARGE');
    });

    it('returns 400 for an unsupported content type', async () => {
      const token = await registerAndLogin();

      const response = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: 'x.zip', size_bytes: 1024, content_type: 'application/zip' })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when a required field is missing', async () => {
      const token = await registerAndLogin();

      await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${token}`)
        .send({ filename: 'clip.mp4' })
        .expect(400);
    });
  });

  describe('POST /videos/uploads/:videoId/complete', () => {
    it('completes the handshake and moves the video to processing', async () => {
      const token = await registerAndLogin();
      const initiated = await initiate(token);
      const parts = await uploadFixture(initiated);

      const response = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.video_id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      expect(response.body.status).toBe(VideoStatus.PROCESSING);
      expect(response.body.public_id).toBe(initiated.public_id);
    });

    it('returns 403 when another user completes the upload', async () => {
      const owner = await registerAndLogin();
      const intruder = await registerAndLogin();
      const initiated = await initiate(owner);
      const parts = await uploadFixture(initiated);

      const response = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.video_id}/complete`)
        .set('Authorization', `Bearer ${intruder}`)
        .send({ parts })
        .expect(403);

      expect(response.body.error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 409 on a second completion', async () => {
      const token = await registerAndLogin();
      const initiated = await initiate(token);
      const parts = await uploadFixture(initiated);
      await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.video_id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.video_id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);

      expect(response.body.error).toBe('VIDEO_UPLOAD_NOT_IN_PROGRESS');
    });

    it('returns 404 for an unknown video', async () => {
      const token = await registerAndLogin();

      const response = await request(app.getHttpServer())
        .post(`/videos/uploads/${randomUUID()}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"x"' }] })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('DELETE /videos/uploads/:videoId', () => {
    it('aborts the upload and removes the draft', async () => {
      const token = await registerAndLogin();
      const initiated = await initiate(token);

      await request(app.getHttpServer())
        .delete(`/videos/uploads/${initiated.video_id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await expect(
        videoRepository.findOneByOrFail({ id: initiated.video_id }),
      ).rejects.toThrow();
    });
  });

  describe('processing outcome', () => {
    it('fills metadata and thumbnail, and exposes the video as ready', async () => {
      const token = await registerAndLogin();
      const { videoId, publicId } = await publishReadyVideo(token);

      const stored = await videoRepository.findOneByOrFail({ id: videoId });
      expect(stored.status).toBe(VideoStatus.READY);
      expect(Number(stored.duration_seconds)).toBeCloseTo(2, 0);
      expect(stored.width).toBe(320);
      expect(stored.height).toBe(240);
      expect(stored.thumbnail_key).toBe(`thumbnails/${videoId}.jpg`);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      expect(response.body.status).toBe(VideoStatus.READY);
      expect(response.body.duration_seconds).toBeCloseTo(2, 0);
      expect(response.body.thumbnail_url).toBe(`/videos/${publicId}/thumbnail`);
    });
  });

  describe('GET /videos/:publicId', () => {
    it('is reachable anonymously and leaks no storage internals', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}`)
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('source_key');
      expect(serialized).not.toContain('thumbnail_key');
      expect(serialized).not.toContain('upload_id');
      expect(response.body.channel.nickname).toBeTruthy();
    });

    it('returns 404 for an unknown public id', async () => {
      const response = await request(app.getHttpServer())
        .get('/videos/doesNotExis')
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('serves exactly the requested range with 206', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=0-99')
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes 0-99/${fixture.length}`,
      );
      expect(response.headers['content-length']).toBe('100');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.body.length).toBe(100);
      // The whole file is far larger than the slice actually transferred.
      expect(fixture.length).toBeGreaterThan(100);
    });

    it('serves the whole object with 200 when no Range is sent', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(200);

      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.body.length).toBe(fixture.length);
    });

    it('honours an open-ended range', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=100-')
        .expect(206);

      expect(response.body.length).toBe(fixture.length - 100);
    });

    it('returns 409 for a video that is not ready', async () => {
      const token = await registerAndLogin();
      const initiated = await initiate(token);
      const parts = await uploadFixture(initiated);
      await request(app.getHttpServer())
        .post(`/videos/uploads/${initiated.video_id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}/stream`)
        .expect(409);

      expect(response.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 416 for a range beyond the object', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Range', 'bytes=99999999-')
        .expect(416);

      expect(response.body.error).toBe('INVALID_RANGE');
    });
  });

  describe('GET /videos/:publicId/thumbnail', () => {
    it('serves the generated JPEG anonymously', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/thumbnail`)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(response.body.subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('redirects to a presigned storage URL that serves the whole file', async () => {
      const token = await registerAndLogin();
      const { publicId } = await publishReadyVideo(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const location = response.headers.location;
      expect(location).toContain('X-Amz-Signature');
      expect(new URL(location).host).toBe(
        new URL(storageConfig().publicEndpoint).host,
      );

      const downloaded = await fetch(toInternal(location));
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(downloaded.headers.get('content-disposition')).toContain(
        'clip.mp4',
      );
      expect(Buffer.from(await downloaded.arrayBuffer()).length).toBe(
        fixture.length,
      );
    });

    it('returns 409 for a video that is not ready', async () => {
      const token = await registerAndLogin();
      const initiated = await initiate(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${initiated.public_id}/download`)
        .expect(409);

      expect(response.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 404 for an unknown public id', async () => {
      await request(app.getHttpServer())
        .get('/videos/doesNotExis/download')
        .expect(404);
    });
  });
});
