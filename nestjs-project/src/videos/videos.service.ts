import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
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
import videoConfig from '../config/video.config';
import { StorageService, type ObjectRange } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoStatus } from './video-status.enum';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  PROCESS_VIDEO_JOB,
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

export interface InitiateUploadResult {
  video_id: string;
  public_id: string;
  upload_id: string;
  part_size: number;
  parts: { part_number: number; url: string }[];
  expires_in: number;
}

export interface ParsedRange {
  start: number;
  end?: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoFileTooLargeException();
    }
    if (
      !(ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(
        dto.content_type,
      )
    ) {
      throw new UnsupportedVideoTypeException();
    }

    const video = await this.persistDraft(channel.id, dto);

    const uploadId = await this.storageService.createMultipartUpload(
      video.source_key,
      dto.content_type,
    );
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    const partCount = Math.ceil(dto.size_bytes / this.config.partSizeBytes);
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_unused, index) => ({
        part_number: index + 1,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          uploadId,
          index + 1,
        ),
      })),
    );

    return {
      video_id: video.id,
      public_id: video.public_id,
      upload_id: uploadId,
      part_size: this.config.partSizeBytes,
      parts,
      expires_in: this.storageService.uploadUrlTtlSeconds,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const video = await this.loadOwnedUpload(userId, videoId);

    await this.storageService.completeMultipartUpload(
      video.source_key,
      video.upload_id!,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    // The client-declared size is a hint; storage holds the authoritative value.
    const head = await this.storageService.headObject(video.source_key);
    video.size_bytes = String(head.contentLength);
    video.upload_id = null;
    video.status = VideoStatus.PROCESSING;
    const saved = await this.videoRepository.save(video);

    await this.processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: saved.id },
      {
        attempts: this.config.processingAttempts,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return saved;
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.loadOwnedUpload(userId, videoId);

    await this.storageService.abortMultipartUpload(
      video.source_key,
      video.upload_id!,
    );
    await this.videoRepository.remove(video);
  }

  async findByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async streamVideo(
    publicId: string,
    rangeHeader?: string,
  ): Promise<ObjectRange & { totalSize: number }> {
    const video = await this.findReadyByPublicId(publicId);

    const totalSize = Number(video.size_bytes ?? 0);
    const range = parseRangeHeader(rangeHeader, totalSize);

    const result = await this.storageService.getObjectRange(
      video.source_key,
      range?.start,
      range?.end,
    );

    return { ...result, totalSize };
  }

  async getThumbnail(publicId: string): Promise<ObjectRange> {
    const video = await this.findByPublicId(publicId);
    if (!video.thumbnail_key) throw new VideoNotFoundException();

    return this.storageService.getObjectRange(video.thumbnail_key);
  }

  async buildDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReadyByPublicId(publicId);

    return this.storageService.presignGetObject(video.source_key, {
      downloadFilename: video.original_filename,
    });
  }

  private async findReadyByPublicId(publicId: string): Promise<Video> {
    const video = await this.findByPublicId(publicId);
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();
    return video;
  }

  private async loadOwnedUpload(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel?.user_id !== userId) throw new VideoNotOwnedException();
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadNotInProgressException();
    }
    return video;
  }

  private async persistDraft(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<Video> {
    const extension = extname(dto.filename).slice(1).toLowerCase();
    // The id is minted here rather than by the database so the storage key is
    // known before the first write, keeping draft creation a single insert.
    const id = randomUUID();

    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const video = this.videoRepository.create({
        id,
        public_id: generatePublicId(),
        title: stripExtension(dto.filename),
        channel_id: channelId,
        status: VideoStatus.DRAFT,
        source_key: this.storageService.buildSourceKey(id, extension),
        original_filename: dto.filename,
        content_type: dto.content_type,
        size_bytes: String(dto.size_bytes),
      });

      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (!isPublicIdCollision(err)) throw err;
      }
    }

    throw new Error(
      'Could not generate a unique public id after maximum attempts',
    );
  }
}

function stripExtension(filename: string): string {
  const ext = extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return (base || filename).slice(0, 255);
}

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    code === '23505' &&
    typeof detail === 'string' &&
    detail.includes('public_id')
  );
}

export function parseRangeHeader(
  rangeHeader: string | undefined,
  totalSize: number,
): ParsedRange | undefined {
  if (!rangeHeader) return undefined;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) throw new InvalidRangeException();

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') throw new InvalidRangeException();

  // Suffix form `bytes=-N` asks for the last N bytes.
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) throw new InvalidRangeException();
    return { start: Math.max(totalSize - suffixLength, 0), end: totalSize - 1 };
  }

  const start = Number(rawStart);
  if (totalSize > 0 && start >= totalSize) throw new InvalidRangeException();

  if (rawEnd === '') return { start };

  const end = Number(rawEnd);
  if (end < start) throw new InvalidRangeException();
  return { start, end: totalSize > 0 ? Math.min(end, totalSize - 1) : end };
}
