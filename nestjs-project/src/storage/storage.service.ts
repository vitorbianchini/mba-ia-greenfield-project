import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENT, STORAGE_PREFIXES } from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface ObjectRange {
  body: Readable;
  contentLength: number;
  contentType: string;
  contentRange?: string;
}

export interface ObjectHead {
  contentLength: number;
  contentType: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    await this.client.send(
      new CreateBucketCommand({ Bucket: this.config.bucket }),
    );
    this.logger.log(`Created storage bucket "${this.config.bucket}"`);
  }

  buildSourceKey(videoId: string, extension: string): string {
    const suffix = extension ? `.${extension.replace(/^\./, '')}` : '';
    return `${STORAGE_PREFIXES.VIDEOS}/${videoId}/source${suffix}`;
  }

  buildThumbnailKey(videoId: string): string {
    return `${STORAGE_PREFIXES.THUMBNAILS}/${videoId}.jpg`;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!UploadId) {
      throw new Error(`Storage did not return an UploadId for key "${key}"`);
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.uploadUrlTtlSeconds },
    );
    return this.toPublicUrl(url);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    // S3 rejects a parts list that is not ascending by PartNumber.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<ObjectHead> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  }

  async getObjectRange(
    key: string,
    start?: number,
    end?: number,
  ): Promise<ObjectRange> {
    const range =
      start === undefined ? undefined : `bytes=${start}-${end ?? ''}`;

    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Range: range,
      }),
    );

    return {
      body: result.Body as Readable,
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType ?? 'application/octet-stream',
      contentRange: result.ContentRange,
    };
  }

  async presignGetObject(
    key: string,
    options: { downloadFilename?: string } = {},
  ): Promise<string> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadFilename
          ? `attachment; filename="${sanitizeFilename(options.downloadFilename)}"`
          : undefined,
      }),
      { expiresIn: this.config.downloadUrlTtlSeconds },
    );
    return this.toPublicUrl(url);
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  // The client signs against the in-network endpoint, but the URL is consumed
  // from outside Compose. Host and port are not part of the S3 signature, so
  // swapping the origin keeps the signature valid.
  private toPublicUrl(signedUrl: string): string {
    const { endpoint, publicEndpoint } = this.config;
    if (endpoint === publicEndpoint) return signedUrl;

    const url = new URL(signedUrl);
    const target = new URL(publicEndpoint);
    url.protocol = target.protocol;
    url.host = target.host;
    return url.toString();
  }
}

function isNotFound(err: unknown): boolean {
  const candidate = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchBucket' ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_');
}
