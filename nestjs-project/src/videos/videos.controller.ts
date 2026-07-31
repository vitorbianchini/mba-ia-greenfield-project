import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService, type InitiateUploadResult } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and returns presigned URLs so the client uploads the file parts directly to object storage. No video bytes pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        video_id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        upload_id: { type: 'string' },
        part_size: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
        expires_in: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, file too large, or unsupported type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post('uploads/:videoId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'videoId', format: 'uuid' })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts in object storage, moves the video to processing and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No upload in progress for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; public_id: string; status: string }> {
    const video = await this.videosService.completeUpload(
      user.sub,
      videoId,
      dto,
    );
    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
    };
  }

  @Delete('uploads/:videoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'videoId', format: 'uuid' })
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Cancels the multipart upload in object storage and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No upload in progress for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user.sub, videoId);
  }

  @Public()
  @Get(':publicId')
  @ApiParam({ name: 'publicId', example: 'Xk3mQp7Rz1a' })
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns the public metadata of a video. Anonymous access is allowed.',
  })
  @ApiResponse({ status: 200, description: 'Video found', type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(@Param('publicId') publicId: string): Promise<VideoResponseDto> {
    const video = await this.videosService.findByPublicId(publicId);
    return VideoResponseDto.fromEntity(video);
  }

  @Public()
  @Get(':publicId/stream')
  @ApiParam({ name: 'publicId', example: 'Xk3mQp7Rz1a' })
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Streams the video honouring the HTTP Range header, so playback starts without downloading the whole file. Anonymous access is allowed.',
  })
  @ApiResponse({ status: 200, description: 'Full video stream' })
  @ApiResponse({ status: 206, description: 'Partial content for the requested range' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Requested range is not satisfiable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { body, contentLength, contentType, contentRange } =
      await this.videosService.streamVideo(publicId, rangeHeader);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', contentLength);
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
      res.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      res.status(HttpStatus.OK);
    }

    body.pipe(res);
  }

  @Public()
  @Get(':publicId/thumbnail')
  @ApiParam({ name: 'publicId', example: 'Xk3mQp7Rz1a' })
  @ApiOperation({
    summary: 'Get the video thumbnail',
    description:
      'Serves the JPEG frame extracted during processing. Anonymous access is allowed.',
  })
  @ApiResponse({ status: 200, description: 'Thumbnail image' })
  @ApiResponse({
    status: 404,
    description: 'Video or thumbnail not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { body, contentLength, contentType } =
      await this.videosService.getThumbnail(publicId);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', contentLength);
    res.status(HttpStatus.OK);

    body.pipe(res);
  }

  @Public()
  @Get(':publicId/download')
  @ApiParam({ name: 'publicId', example: 'Xk3mQp7Rz1a' })
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned storage URL so the full-file transfer is served by object storage, not by the API. Anonymous access is allowed.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.buildDownloadUrl(publicId);

    res.redirect(HttpStatus.FOUND, url);
  }
}
