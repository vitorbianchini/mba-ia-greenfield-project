export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

export const PUBLIC_ID_MAX_ATTEMPTS = 5;
