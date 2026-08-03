import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { VideoProcessingService } from './video-processing.service';

export interface VideoProcessingJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    await this.videoProcessingService.process(job.data.videoId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobData>, err: Error): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 1;

    // This event fires on every failed attempt. Writing `failed` here without
    // the guard would mark the video failed while BullMQ is still retrying it.
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Video ${job.data.videoId} failed attempt ${job.attemptsMade}/${maxAttempts}: ${err.message}`,
      );
      return;
    }

    await this.videoProcessingService.markFailed(job.data.videoId, err.message);
  }
}
