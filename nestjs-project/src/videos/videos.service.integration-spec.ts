import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// The suite runs inside the Compose network, where the presigned host resolves
// to the container itself. Host and port sit outside the S3 signature.
function toInternal(url: string): string {
  const target = new URL(url);
  const internal = new URL(storageConfig().endpoint);
  target.protocol = internal.protocol;
  target.host = internal.host;
  return target.toString();
}

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videosService: VideosService;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        StorageModule,
        BullModule.forRoot({
          connection: {
            host: queueConfig().host,
            port: queueConfig().port,
          },
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [
        VideosService,
        ChannelsService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: dataSource.getRepository(Channel),
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    await moduleRef.init();

    videosService = moduleRef.get(VideosService);
    storageService = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    // See src/test/close-queue.ts: BullMQ crashes the process on a listener-less
    // 'error' event, which a closing connection reliably produces.
    queue.on('error', () => undefined);
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });

    const user = await dataSource.getRepository(User).save({
      email: `uploader_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Uploader',
      nickname: `uploader_${Date.now()}`,
      user_id: user.id,
    });
  });

  const smallUpload = {
    filename: 'clip.mp4',
    size_bytes: 12,
    content_type: 'video/mp4',
  };

  describe('initiateUpload', () => {
    it('persists a draft and opens a real multipart upload', async () => {
      const result = await videosService.initiateUpload(
        channel.user_id,
        smallUpload,
      );

      const stored = await videoRepository.findOneByOrFail({
        id: result.video_id,
      });
      expect(stored.status).toBe(VideoStatus.DRAFT);
      expect(stored.upload_id).toBe(result.upload_id);
      expect(stored.source_key).toBe(`videos/${result.video_id}/source.mp4`);
      expect(stored.channel_id).toBe(channel.id);
      expect(result.parts).toHaveLength(1);

      await storageService.abortMultipartUpload(
        stored.source_key,
        result.upload_id,
      );
    });

    it('issues part URLs that storage actually accepts', async () => {
      const result = await videosService.initiateUpload(
        channel.user_id,
        smallUpload,
      );

      const response = await fetch(toInternal(result.parts[0].url), {
        method: 'PUT',
        body: Buffer.from('test content'),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('etag')).toBeTruthy();

      await storageService.abortMultipartUpload(
        `videos/${result.video_id}/source.mp4`,
        result.upload_id,
      );
    });
  });

  describe('completeUpload', () => {
    it('assembles the object, records the real size and enqueues exactly one job', async () => {
      const initiated = await videosService.initiateUpload(
        channel.user_id,
        smallUpload,
      );
      const put = await fetch(toInternal(initiated.parts[0].url), {
        method: 'PUT',
        body: Buffer.from('test content'),
      });
      const etag = put.headers.get('etag')!;

      const completed = await videosService.completeUpload(
        channel.user_id,
        initiated.video_id,
        { parts: [{ part_number: 1, etag }] },
      );

      expect(completed.status).toBe(VideoStatus.PROCESSING);
      expect(completed.upload_id).toBeNull();
      expect(completed.size_bytes).toBe('12');

      const head = await storageService.headObject(completed.source_key);
      expect(head.contentLength).toBe(12);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ videoId: initiated.video_id });
      expect(jobs[0].opts.attempts).toBe(3);

      await storageService.deleteObject(completed.source_key);
    });

    it('does not enqueue a second job when completion is retried', async () => {
      const initiated = await videosService.initiateUpload(
        channel.user_id,
        smallUpload,
      );
      const put = await fetch(toInternal(initiated.parts[0].url), {
        method: 'PUT',
        body: Buffer.from('test content'),
      });
      const etag = put.headers.get('etag')!;
      await videosService.completeUpload(channel.user_id, initiated.video_id, {
        parts: [{ part_number: 1, etag }],
      });

      await expect(
        videosService.completeUpload(channel.user_id, initiated.video_id, {
          parts: [{ part_number: 1, etag }],
        }),
      ).rejects.toThrow();

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);

      await storageService.deleteObject(
        `videos/${initiated.video_id}/source.mp4`,
      );
    });
  });

  describe('abortUpload', () => {
    it('cancels the multipart upload and deletes the draft row', async () => {
      const initiated = await videosService.initiateUpload(
        channel.user_id,
        smallUpload,
      );

      await videosService.abortUpload(channel.user_id, initiated.video_id);

      await expect(
        videoRepository.findOneByOrFail({ id: initiated.video_id }),
      ).rejects.toThrow();
      await expect(
        storageService.headObject(`videos/${initiated.video_id}/source.mp4`),
      ).rejects.toBeDefined();
    });
  });
});
