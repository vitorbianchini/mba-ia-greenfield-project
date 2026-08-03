import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Presigned URLs are consumed outside the Compose network, so the signed
  // host must be the one the client can reach.
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
  accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  uploadUrlTtlSeconds: parseInt(
    process.env.STORAGE_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  downloadUrlTtlSeconds: parseInt(
    process.env.STORAGE_DOWNLOAD_URL_TTL_SECONDS || '300',
    10,
  ),
}));
