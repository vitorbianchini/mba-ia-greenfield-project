import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from '../videos/processing/video-processing.processor';
import { VideoProcessingService } from '../videos/processing/video-processing.service';
import { closeQueues } from '../test/close-queue';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('compiles as a standalone context with the queue consumer registered', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessingService)).toBeDefined();
    expect(moduleRef.get(VideoProcessingProcessor)).toBeDefined();

    await closeQueues(moduleRef, VIDEO_PROCESSING_QUEUE);
    await moduleRef.close();
  }, 30_000);
});
