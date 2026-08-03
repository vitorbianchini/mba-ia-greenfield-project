import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

// Consumer side of the video-processing queue. Imported only by WorkerModule —
// AppModule must never import this, or the API container would also pull jobs.
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [FfmpegService, VideoProcessingService, VideoProcessingProcessor],
  exports: [VideoProcessingService],
})
export class ProcessingModule {}
