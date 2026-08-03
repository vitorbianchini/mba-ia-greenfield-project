import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FfmpegService } from './ffmpeg.service';

const execFileAsync = promisify(execFile);

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService (integration)', () => {
  let ffmpegService: FfmpegService;
  let workDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    ffmpegService = new FfmpegService();
    workDir = await mkdtemp(join(tmpdir(), 'ffmpeg-spec-'));
    fixturePath = join(workDir, 'fixture.mp4');

    // A 2s 320x240 H.264 clip, generated so the repository carries no binary.
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
  }, 120_000);

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('returns duration, dimensions and codec with numeric types', async () => {
      const metadata = await ffmpegService.probe(fixturePath);

      // ffprobe emits format.duration as a string; the mapping must coerce it.
      expect(typeof metadata.durationSeconds).toBe('number');
      expect(metadata.durationSeconds).toBeCloseTo(2, 0);
      expect(metadata.width).toBe(320);
      expect(metadata.height).toBe(240);
      expect(metadata.videoCodec).toBe('h264');
      expect(metadata.containerFormat).toContain('mp4');
    });

    it('rejects a file that carries no video stream', async () => {
      const notAVideo = join(workDir, 'not-a-video.txt');
      await writeFile(notAVideo, 'definitely not a video');

      await expect(ffmpegService.probe(notAVideo)).rejects.toBeDefined();
    });

    it('rejects a path that does not exist', async () => {
      await expect(
        ffmpegService.probe(join(workDir, 'missing.mp4')),
      ).rejects.toBeDefined();
    });
  });

  describe('extractThumbnail', () => {
    it('writes a non-empty JPEG', async () => {
      const output = join(workDir, 'thumb.jpg');

      await ffmpegService.extractThumbnail(fixturePath, output, 1);

      const bytes = await readFile(output);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    }, 60_000);

    it('falls back to the first frame when the timestamp is past the end', async () => {
      const output = join(workDir, 'thumb-late.jpg');

      await ffmpegService.extractThumbnail(fixturePath, output, 999, 2);

      const bytes = await readFile(output);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
    }, 60_000);
  });
});
