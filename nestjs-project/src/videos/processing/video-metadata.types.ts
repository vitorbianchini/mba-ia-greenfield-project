export interface VideoMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  containerFormat: string | null;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    // ffprobe emits these as strings even though they are numeric.
    duration?: string;
    size?: string;
    format_name?: string;
  };
}
