import { ApiProperty } from '@nestjs/swagger';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';

export class VideoChannelDto {
  @ApiProperty({ example: 'johndoe' })
  nickname: string;

  @ApiProperty({ example: 'John Doe' })
  name: string;
}

export class VideoResponseDto {
  @ApiProperty({ example: 'Xk3mQp7Rz1a' })
  public_id: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, example: 12.34 })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({
    nullable: true,
    example: '/videos/Xk3mQp7Rz1a/thumbnail.jpg',
    description: 'Null until the worker has generated the thumbnail.',
  })
  thumbnail_url: string | null;

  @ApiProperty()
  created_at: Date;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  // Storage keys and the multipart upload id are internal and never leave the API.
  static fromEntity(video: Video): VideoResponseDto {
    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      width: video.width,
      height: video.height,
      thumbnail_url: video.thumbnail_key
        ? `/videos/${video.public_id}/thumbnail`
        : null,
      created_at: video.created_at,
      channel: {
        nickname: video.channel?.nickname,
        name: video.channel?.name,
      },
    };
  }
}
