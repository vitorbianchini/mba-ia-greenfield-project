import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { AppModule } from '../../app.module';
import { closeQueues } from '../../test/close-queue';
import { Video } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { ProcessingModule } from './processing.module';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

describe('ProcessingModule', () => {
  it('compiles with the queue, storage and repository wiring', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        BullModule.forRoot({
          connection: { host: queueConfig().host, port: queueConfig().port },
        }),
        ProcessingModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .compile();

    expect(moduleRef.get(FfmpegService)).toBeDefined();
    expect(moduleRef.get(VideoProcessingService)).toBeDefined();
    expect(moduleRef.get(VideoProcessingProcessor)).toBeDefined();

    await closeQueues(moduleRef, VIDEO_PROCESSING_QUEUE);
    await moduleRef.close();
  }, 30_000);

  it('is not reachable from AppModule — the API must never consume jobs', () => {
    const imported = (Reflect.getMetadata('imports', AppModule) ??
      []) as unknown[];

    expect(imported).not.toContain(ProcessingModule);
  });
});
