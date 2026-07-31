import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { ALLOWED_VIDEO_CONTENT_TYPES } from '../videos.constants';

export class InitiateUploadDto {
  @ApiProperty({ example: 'my-video.mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({ example: 52428800, minimum: 1 })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiProperty({ enum: ALLOWED_VIDEO_CONTENT_TYPES, example: 'video/mp4' })
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES as unknown as string[])
  content_type: string;
}
