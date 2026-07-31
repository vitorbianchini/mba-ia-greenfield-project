import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: 'Owner',
        nickname: `owner_${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  const buildVideo = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      public_id: randomUUID().slice(0, 11),
      title: 'My video',
      channel_id: channel.id,
      source_key: 'videos/x/source.mp4',
      original_filename: 'my-video.mp4',
      content_type: 'video/mp4',
      ...overrides,
    });

  it('defaults status to draft', async () => {
    const video = await videoRepository.save(buildVideo());

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('enforces the unique public_id constraint', async () => {
    await videoRepository.save(buildVideo({ public_id: 'dupPublicId' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'dupPublicId' })),
    ).rejects.toThrow();
  });

  it('rejects a status outside the enum', async () => {
    await expect(
      videoRepository.save(
        buildVideo({ status: 'transcoding' as VideoStatus }),
      ),
    ).rejects.toThrow();
  });

  it('enforces the channel foreign key', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toThrow();
  });

  it('leaves processing metadata null until the worker fills it', async () => {
    const video = await videoRepository.save(buildVideo());

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.video_codec).toBeNull();
    expect(video.container_format).toBeNull();
    expect(video.processing_error).toBeNull();
  });

  it('stores a 10GB size without precision loss', async () => {
    const tenGigabytes = String(10 * 1024 * 1024 * 1024);
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: tenGigabytes }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGigabytes);
  });

  it('auto-populates the timestamps', async () => {
    const video = await videoRepository.save(buildVideo());

    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('loads the owning channel via the ManyToOne relation', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
