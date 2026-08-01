import { QueryFailedError } from 'typeorm';
import {
  ChannelNotFoundException,
  InvalidRangeException,
  UnsupportedVideoTypeException,
  UploadNotInProgressException,
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService, parseRangeHeader } from './videos.service';

const CONFIG = {
  maxSizeBytes: 10 * 1024 * 1024 * 1024,
  partSizeBytes: 100 * 1024 * 1024,
  thumbnailTimestampSeconds: 1,
  processingAttempts: 3,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    public_id: 'PublicId123',
    title: 'My video',
    channel_id: 'channel-id',
    status: VideoStatus.DRAFT,
    source_key: 'videos/video-id/source.mp4',
    thumbnail_key: null,
    upload_id: 'upload-id',
    original_filename: 'my-video.mp4',
    content_type: 'video/mp4',
    size_bytes: '1024',
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    container_format: null,
    processing_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: { user_id: 'user-id' } as Video['channel'],
    ...overrides,
  } as Video;
}

function build(
  overrides: {
    repository?: any;
    channels?: any;
    storage?: any;
    queue?: any;
  } = {},
) {
  const repository = overrides.repository ?? {
    create: jest.fn((v: Partial<Video>) => v as Video),
    save: jest.fn((v: Video) => Promise.resolve(v)),
    findOne: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const channels = overrides.channels ?? {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-id' }),
  };
  const storage = overrides.storage ?? {
    buildSourceKey: jest.fn(
      (id: string, ext: string) => `videos/${id}/source.${ext}`,
    ),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    presignUploadPart: jest.fn(
      (_key: string, _uploadId: string, part: number) =>
        Promise.resolve(`https://storage/part/${part}`),
    ),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn().mockResolvedValue({ contentLength: 2048 }),
    getObjectRange: jest.fn().mockResolvedValue({ body: {}, contentLength: 1 }),
    presignGetObject: jest.fn().mockResolvedValue('https://storage/signed'),
    uploadUrlTtlSeconds: 3600,
  };
  const queue = overrides.queue ?? {
    add: jest.fn().mockResolvedValue(undefined),
  };

  const service = new VideosService(
    repository,
    channels,
    storage,
    queue,
    CONFIG as any,
  );
  return { service, repository, channels, storage, queue };
}

const uploadDto = {
  filename: 'my-video.mp4',
  size_bytes: 250 * 1024 * 1024,
  content_type: 'video/mp4',
};

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('throws when the authenticated user has no channel', async () => {
      const { service } = build({
        channels: { findByUserId: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.initiateUpload('user-id', uploadDto),
      ).rejects.toThrow(ChannelNotFoundException);
    });

    it('rejects a file above the configured maximum', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload('user-id', {
          ...uploadDto,
          size_bytes: CONFIG.maxSizeBytes + 1,
        }),
      ).rejects.toThrow(VideoFileTooLargeException);
    });

    it('rejects a content type outside the allowlist', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload('user-id', {
          ...uploadDto,
          content_type: 'application/zip',
        }),
      ).rejects.toThrow(UnsupportedVideoTypeException);
    });

    it('presigns one URL per part, numbered from 1', async () => {
      const { service, storage } = build();

      const result = await service.initiateUpload('user-id', uploadDto);

      // 250MB in 100MB parts -> 3 parts
      expect(result.parts).toHaveLength(3);
      expect(result.parts.map((p) => p.part_number)).toEqual([1, 2, 3]);
      expect(storage.presignUploadPart).toHaveBeenCalledTimes(3);
      expect(result.part_size).toBe(CONFIG.partSizeBytes);
      expect(result.expires_in).toBe(3600);
    });

    it('computes an exact part count when the size is a multiple of the part size', async () => {
      const { service } = build();

      const result = await service.initiateUpload('user-id', {
        ...uploadDto,
        size_bytes: CONFIG.partSizeBytes * 2,
      });

      expect(result.parts).toHaveLength(2);
    });

    it('keeps a 10GB upload well under the S3 10000-part limit', async () => {
      const { service } = build();

      const result = await service.initiateUpload('user-id', {
        ...uploadDto,
        size_bytes: CONFIG.maxSizeBytes,
      });

      expect(result.parts.length).toBeLessThan(10_000);
      expect(result.parts).toHaveLength(103);
    });

    it('persists the draft before opening the multipart upload', async () => {
      const { service, repository, storage } = build();

      await service.initiateUpload('user-id', uploadDto);

      const draft = repository.create.mock.calls[0][0];
      expect(draft.status).toBe(VideoStatus.DRAFT);
      expect(draft.title).toBe('my-video');
      expect(draft.public_id).toHaveLength(11);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        draft.source_key,
        'video/mp4',
      );
    });

    it('retries with a new public id on a unique-constraint collision', async () => {
      const collision = Object.assign(
        new QueryFailedError('INSERT', [], new Error()),
        { code: '23505', detail: 'Key (public_id)=(abc) already exists.' },
      );
      const repository = {
        create: jest.fn((v: Partial<Video>) => v as Video),
        save: jest
          .fn()
          .mockRejectedValueOnce(collision)
          .mockImplementation((v: Video) => Promise.resolve(v)),
        findOne: jest.fn(),
        remove: jest.fn(),
      };
      const { service } = build({ repository });

      await expect(
        service.initiateUpload('user-id', uploadDto),
      ).resolves.toBeDefined();

      const firstId = repository.create.mock.calls[0][0].public_id;
      const secondId = repository.create.mock.calls[1][0].public_id;
      expect(firstId).not.toBe(secondId);
    });

    it('re-throws a non-collision persistence error', async () => {
      const repository = {
        create: jest.fn((v: Partial<Video>) => v as Video),
        save: jest.fn().mockRejectedValue(new Error('Connection lost')),
        findOne: jest.fn(),
        remove: jest.fn(),
      };
      const { service } = build({ repository });

      await expect(
        service.initiateUpload('user-id', uploadDto),
      ).rejects.toThrow('Connection lost');
    });
  });

  describe('completeUpload', () => {
    const parts = { parts: [{ part_number: 1, etag: '"abc"' }] };

    it('throws when the video does not exist', async () => {
      const { service, repository } = build();
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws when the video belongs to another user', async () => {
      const { service, repository } = build();
      repository.findOne.mockResolvedValue(
        makeVideo({ channel: { user_id: 'someone-else' } as Video['channel'] }),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it.each([
      ['already processing', { status: VideoStatus.PROCESSING }],
      ['has no open upload', { upload_id: null }],
    ])('throws when the video %s', async (_label, overrides) => {
      const { service, repository } = build();
      repository.findOne.mockResolvedValue(makeVideo(overrides));

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow(UploadNotInProgressException);
    });

    it('completes the upload, records the authoritative size and enqueues one job', async () => {
      const { service, repository, storage, queue } = build();
      repository.findOne.mockResolvedValue(makeVideo());

      const result = await service.completeUpload('user-id', 'video-id', {
        parts: [
          { part_number: 2, etag: '"two"' },
          { part_number: 1, etag: '"one"' },
        ],
      });

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-id',
        [
          { partNumber: 2, etag: '"two"' },
          { partNumber: 1, etag: '"one"' },
        ],
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(result.upload_id).toBeNull();
      // headObject reports 2048; the client had declared 1024.
      expect(result.size_bytes).toBe('2048');

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-id' },
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }),
      );
    });
  });

  describe('abortUpload', () => {
    it('aborts in storage and removes the draft row', async () => {
      const { service, repository, storage } = build();
      const video = makeVideo();
      repository.findOne.mockResolvedValue(video);

      await service.abortUpload('user-id', 'video-id');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        'upload-id',
      );
      expect(repository.remove).toHaveBeenCalledWith(video);
    });

    it("refuses to abort another user's upload", async () => {
      const { service, repository, storage } = build();
      repository.findOne.mockResolvedValue(
        makeVideo({ channel: { user_id: 'someone-else' } as Video['channel'] }),
      );

      await expect(service.abortUpload('user-id', 'video-id')).rejects.toThrow(
        VideoNotOwnedException,
      );
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('streamVideo', () => {
    it('refuses a video that is not ready', async () => {
      const { service, repository } = build();
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(service.streamVideo('PublicId123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('forwards the parsed range to storage', async () => {
      const { service, repository, storage } = build();
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY, size_bytes: '1000' }),
      );

      await service.streamVideo('PublicId123', 'bytes=0-99');

      expect(storage.getObjectRange).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        0,
        99,
      );
    });
  });

  describe('buildDownloadUrl', () => {
    it('presigns with the original filename', async () => {
      const { service, repository, storage } = build();
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      const url = await service.buildDownloadUrl('PublicId123');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-id/source.mp4',
        { downloadFilename: 'my-video.mp4' },
      );
      expect(url).toBe('https://storage/signed');
    });

    it('refuses a video that is not ready', async () => {
      const { service, repository } = build();
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.FAILED }),
      );

      await expect(service.buildDownloadUrl('PublicId123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });
  });
});

describe('parseRangeHeader', () => {
  it('returns undefined when no header is present', () => {
    expect(parseRangeHeader(undefined, 1000)).toBeUndefined();
  });

  it('parses a closed range', () => {
    expect(parseRangeHeader('bytes=0-1023', 4096)).toEqual({
      start: 0,
      end: 1023,
    });
  });

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=1024-', 4096)).toEqual({ start: 1024 });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRangeHeader('bytes=-500', 4096)).toEqual({
      start: 3596,
      end: 4095,
    });
  });

  it('clamps an end beyond the object size', () => {
    expect(parseRangeHeader('bytes=0-99999', 4096)).toEqual({
      start: 0,
      end: 4095,
    });
  });

  it.each([
    ['malformed unit', 'items=0-10'],
    ['no bounds at all', 'bytes=-'],
    ['inverted bounds', 'bytes=500-100'],
    ['start beyond the object', 'bytes=5000-'],
    ['garbage', 'not-a-range'],
  ])('rejects %s', (_label, header) => {
    expect(() => parseRangeHeader(header, 4096)).toThrow(InvalidRangeException);
  });
});
