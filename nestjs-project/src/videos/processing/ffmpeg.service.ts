import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import type {
  FfprobeOutput,
  FfprobeStream,
  VideoMetadata,
} from './video-metadata.types';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 120_000;
// ffprobe JSON for a long file with many streams can exceed the 1MB default.
const PROBE_MAX_BUFFER = 16 * 1024 * 1024;

@Injectable()
export class FfmpegService {
  async probe(inputPath: string): Promise<VideoMetadata> {
    // execFile takes an argument array, so the path never reaches a shell.
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath,
      ],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER },
    );

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find(
      (stream: FfprobeStream) => stream.codec_type === 'video',
    );

    if (!videoStream) {
      throw new Error('Input file contains no video stream');
    }

    return {
      durationSeconds: toNumberOrNull(parsed.format?.duration),
      width: toNumberOrNull(videoStream.width),
      height: toNumberOrNull(videoStream.height),
      videoCodec: videoStream.codec_name ?? null,
      containerFormat: parsed.format?.format_name ?? null,
    };
  }

  async extractThumbnail(
    inputPath: string,
    outputPath: string,
    atSeconds: number,
    durationSeconds?: number | null,
  ): Promise<void> {
    const seek =
      durationSeconds !== null &&
      durationSeconds !== undefined &&
      atSeconds >= durationSeconds
        ? 0
        : atSeconds;

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        // -ss before -i makes this an input seek: ffmpeg jumps to the keyframe
        // instead of decoding from the start, which on a multi-gigabyte file is
        // the difference between sub-second and minutes.
        '-ss',
        String(seek),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2',
        '-q:v',
        '3',
        outputPath,
      ],
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );
  }
}

function toNumberOrNull(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
