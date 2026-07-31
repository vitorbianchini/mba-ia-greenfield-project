import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videoConfig from '../../config/video.config';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';
import { FfmpegService } from './ffmpeg.service';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      this.logger.warn(`Video ${videoId} no longer exists — skipping`);
      return;
    }
    // A redelivered job for an already-processed video is a no-op, not a
    // duplicate thumbnail upload.
    if (video.status !== VideoStatus.PROCESSING) {
      this.logger.log(
        `Video ${videoId} is "${video.status}", not "processing" — skipping`,
      );
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const sourcePath = join(
      workDir,
      `source${extname(video.original_filename)}`,
    );
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.downloadSource(video.source_key, sourcePath);

      const metadata = await this.ffmpegService.probe(sourcePath);

      await this.ffmpegService.extractThumbnail(
        sourcePath,
        thumbnailPath,
        this.config.thumbnailTimestampSeconds,
        metadata.durationSeconds,
      );

      const thumbnailKey = this.storageService.buildThumbnailKey(video.id);
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      video.duration_seconds =
        metadata.durationSeconds === null
          ? null
          : String(metadata.durationSeconds);
      video.width = metadata.width;
      video.height = metadata.height;
      video.video_codec = metadata.videoCodec;
      video.container_format = metadata.containerFormat;
      video.thumbnail_key = thumbnailKey;
      video.processing_error = null;
      video.status = VideoStatus.READY;

      await this.videoRepository.save(video);
      this.logger.log(`Video ${videoId} is ready`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      { status: VideoStatus.FAILED, processing_error: reason },
    );
    this.logger.error(`Video ${videoId} failed processing: ${reason}`);
  }

  private async downloadSource(key: string, targetPath: string): Promise<void> {
    const { body } = await this.storageService.getObjectRange(key);
    await pipeline(body, createWriteStream(targetPath));
  }
}
