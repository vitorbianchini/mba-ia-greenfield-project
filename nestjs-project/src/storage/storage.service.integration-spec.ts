import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService, type UploadedPart } from './storage.service';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

// Presigned URLs are signed for the host-reachable endpoint, but this suite runs
// inside the Compose network where that host is the container itself. Host and
// port are outside the S3 signature, so swapping the origin back to the internal
// endpoint exercises the same signed request.
function fetchSigned(url: string, init?: RequestInit): Promise<Response> {
  const { endpoint, publicEndpoint } = storageConfig();
  const target = new URL(url);
  const internal = new URL(endpoint);
  if (target.host === new URL(publicEndpoint).host) {
    target.protocol = internal.protocol;
    target.host = internal.host;
  }
  return fetch(target.toString(), init);
}

describe('StorageService (integration)', () => {
  let storageService: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    await moduleRef.init();
    storageService = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        storageService.deleteObject(key).catch(() => undefined),
      ),
    );
  });

  const trackedKey = (suffix: string): string => {
    const key = `test/${randomUUID()}${suffix}`;
    createdKeys.push(key);
    return key;
  };

  describe('bucket bootstrap', () => {
    it('is idempotent — a second ensureBucket does not throw', async () => {
      await expect(storageService.ensureBucket()).resolves.toBeUndefined();
      await expect(storageService.ensureBucket()).resolves.toBeUndefined();
    });
  });

  describe('key building', () => {
    it('builds source and thumbnail keys under their prefixes', () => {
      expect(storageService.buildSourceKey('abc', 'mp4')).toBe(
        'videos/abc/source.mp4',
      );
      expect(storageService.buildSourceKey('abc', '.mp4')).toBe(
        'videos/abc/source.mp4',
      );
      expect(storageService.buildSourceKey('abc', '')).toBe('videos/abc/source');
      expect(storageService.buildThumbnailKey('abc')).toBe(
        'thumbnails/abc.jpg',
      );
    });
  });

  describe('multipart lifecycle', () => {
    it('assembles an object from presigned parts and reads it back byte-identical', async () => {
      const key = trackedKey('.bin');
      // Non-final parts must be at least 5MB, so the first part is sized above
      // that floor to exercise a genuine two-part upload.
      const first = Buffer.alloc(5 * 1024 * 1024, 'a');
      const second = Buffer.from('tail');
      const uploadId = await storageService.createMultipartUpload(
        key,
        'application/octet-stream',
      );

      const parts: UploadedPart[] = [];
      for (const [index, chunk] of [first, second].entries()) {
        const partNumber = index + 1;
        const url = await storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
        );
        const response = await fetchSigned(url, { method: 'PUT', body: chunk });
        expect(response.status).toBe(200);
        parts.push({ partNumber, etag: response.headers.get('etag')! });
      }

      // Deliberately out of order — the service must sort before completing.
      await storageService.completeMultipartUpload(key, uploadId, [
        parts[1],
        parts[0],
      ]);

      const head = await storageService.headObject(key);
      expect(head.contentLength).toBe(first.length + second.length);

      const { body } = await storageService.getObjectRange(key);
      const downloaded = await streamToBuffer(body);
      expect(downloaded.equals(Buffer.concat([first, second]))).toBe(true);
    }, 60_000);

    it('abort leaves no object at the target key', async () => {
      const key = `test/${randomUUID()}.bin`;
      const uploadId = await storageService.createMultipartUpload(
        key,
        'application/octet-stream',
      );

      await storageService.abortMultipartUpload(key, uploadId);

      await expect(storageService.headObject(key)).rejects.toBeDefined();
    });
  });

  describe('range reads', () => {
    it('returns the exact slice with a correct Content-Range', async () => {
      const key = trackedKey('.txt');
      await storageService.putObject(key, Buffer.from('test content'), 'text/plain');

      const { body, contentLength, contentRange } =
        await storageService.getObjectRange(key, 0, 3);

      expect(contentRange).toBe('bytes 0-3/12');
      expect(contentLength).toBe(4);
      expect((await streamToBuffer(body)).toString()).toBe('test');
    });

    it('supports an open-ended range', async () => {
      const key = trackedKey('.txt');
      await storageService.putObject(key, Buffer.from('test content'), 'text/plain');

      const { body, contentRange } = await storageService.getObjectRange(key, 5);

      expect(contentRange).toBe('bytes 5-11/12');
      expect((await streamToBuffer(body)).toString()).toBe('content');
    });

    it('returns the whole object when no range is given', async () => {
      const key = trackedKey('.txt');
      await storageService.putObject(key, Buffer.from('test content'), 'text/plain');

      const { body, contentLength, contentRange } =
        await storageService.getObjectRange(key);

      expect(contentRange).toBeUndefined();
      expect(contentLength).toBe(12);
      expect((await streamToBuffer(body)).toString()).toBe('test content');
    });
  });

  describe('presigned download', () => {
    it('produces a URL that serves the object as an attachment', async () => {
      const key = trackedKey('.txt');
      await storageService.putObject(key, Buffer.from('downloadable'), 'text/plain');

      const url = await storageService.presignGetObject(key, {
        downloadFilename: 'my video.mp4',
      });
      const response = await fetchSigned(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(response.headers.get('content-disposition')).toContain(
        'my video.mp4',
      );
      expect(await response.text()).toBe('downloadable');
    });

    it('signs against the public endpoint so the URL is reachable off-network', async () => {
      const key = trackedKey('.txt');
      await storageService.putObject(key, Buffer.from('x'), 'text/plain');

      const url = await storageService.presignGetObject(key);

      expect(new URL(url).host).toBe(new URL(storageConfig().publicEndpoint).host);
    });
  });

  describe('deleteObject', () => {
    it('removes the object', async () => {
      const key = `test/${randomUUID()}.txt`;
      await storageService.putObject(key, Buffer.from('bye'), 'text/plain');

      await storageService.deleteObject(key);

      await expect(storageService.headObject(key)).rejects.toBeDefined();
    });
  });
});
