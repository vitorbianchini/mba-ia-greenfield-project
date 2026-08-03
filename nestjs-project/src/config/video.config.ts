import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  // 100MB keeps a 10GB upload at ~103 parts, far under the S3 10,000-part cap,
  // while staying above the 5MB minimum for non-final parts.
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '104857600', 10),
  thumbnailTimestampSeconds: parseInt(
    process.env.VIDEO_THUMBNAIL_TIMESTAMP_SECONDS || '1',
    10,
  ),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
}));
