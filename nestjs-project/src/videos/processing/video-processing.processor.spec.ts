import { Job } from 'bullmq';
import { VideoProcessingProcessor } from './video-processing.processor';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    data: { videoId: 'video-id' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

describe('VideoProcessingProcessor', () => {
  let service: { process: jest.Mock; markFailed: jest.Mock };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    service = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessingProcessor(service as any);
  });

  describe('process', () => {
    it('delegates the video id to the processing service', async () => {
      await processor.process(makeJob());

      expect(service.process).toHaveBeenCalledWith('video-id');
    });
  });

  describe('onFailed', () => {
    it('does not mark the video failed while retries remain', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 1, opts: { attempts: 3 } as Job['opts'] }),
        new Error('transient'),
      );

      expect(service.markFailed).not.toHaveBeenCalled();
    });

    it('does not mark the video failed on the second of three attempts', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 2, opts: { attempts: 3 } as Job['opts'] }),
        new Error('transient'),
      );

      expect(service.markFailed).not.toHaveBeenCalled();
    });

    it('marks the video failed on the terminal attempt', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 3, opts: { attempts: 3 } as Job['opts'] }),
        new Error('ffprobe exploded'),
      );

      expect(service.markFailed).toHaveBeenCalledWith(
        'video-id',
        'ffprobe exploded',
      );
    });

    it('treats a job with no declared attempts as single-shot', async () => {
      await processor.onFailed(
        makeJob({ attemptsMade: 1, opts: {} as Job['opts'] }),
        new Error('boom'),
      );

      expect(service.markFailed).toHaveBeenCalledWith('video-id', 'boom');
    });
  });
});
