import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let processingService: VideoProcessingService;
  let storageService: StorageService;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let workDir: string;
  let fixture: Buffer;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'processing-spec-'));
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

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
      providers: [
        VideoProcessingService,
        FfmpegService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();

    await moduleRef.init();

    processingService = moduleRef.get(VideoProcessingService);
    storageService = moduleRef.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        storageService.deleteObject(key).catch(() => undefined),
      ),
    );
    await rm(workDir, { recursive: true, force: true });
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `proc_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Proc',
      nickname: `proc_${Date.now()}`,
      user_id: user.id,
    });
  });

  async function seedVideo(status: VideoStatus, body: Buffer): Promise<Video> {
    const id = randomUUID();
    const sourceKey = `videos/${id}/source.mp4`;
    await storageService.putObject(sourceKey, body, 'video/mp4');
    createdKeys.push(sourceKey, `thumbnails/${id}.jpg`);

    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: randomUUID().slice(0, 11),
        title: 'clip',
        channel_id: channel.id,
        status,
        source_key: sourceKey,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: String(body.length),
      }),
    );
  }

  it('fills the metadata, stores the thumbnail and flips the video to ready', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING, fixture);

    await processingService.process(video.id);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(Number(processed.duration_seconds)).toBeCloseTo(2, 0);
    expect(processed.width).toBe(320);
    expect(processed.height).toBe(240);
    expect(processed.video_codec).toBe('h264');
    expect(processed.container_format).toContain('mp4');
    expect(processed.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);
    expect(processed.processing_error).toBeNull();

    const thumbnail = await storageService.headObject(processed.thumbnail_key!);
    expect(thumbnail.contentLength).toBeGreaterThan(0);
    expect(thumbnail.contentType).toBe('image/jpeg');
  }, 120_000);

  it('is a no-op for a video that is not in processing', async () => {
    const video = await seedVideo(VideoStatus.READY, fixture);

    await processingService.process(video.id);

    const untouched = await videoRepository.findOneByOrFail({ id: video.id });
    expect(untouched.thumbnail_key).toBeNull();
    expect(untouched.duration_seconds).toBeNull();
  });

  it('returns quietly when the video no longer exists', async () => {
    await expect(
      processingService.process(randomUUID()),
    ).resolves.toBeUndefined();
  });

  it('rethrows and leaves the row in processing when the source is not a video', async () => {
    const video = await seedVideo(
      VideoStatus.PROCESSING,
      Buffer.from('not a video at all'),
    );

    await expect(processingService.process(video.id)).rejects.toBeDefined();

    const untouched = await videoRepository.findOneByOrFail({ id: video.id });
    // Still processing: BullMQ owns the retry cycle, the DB owns the outcome.
    expect(untouched.status).toBe(VideoStatus.PROCESSING);
    expect(untouched.processing_error).toBeNull();
  }, 60_000);

  it('markFailed records the terminal failure reason', async () => {
    const video = await seedVideo(VideoStatus.PROCESSING, fixture);

    await processingService.markFailed(video.id, 'ffprobe exploded');

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_error).toBe('ffprobe exploded');
  });
});
