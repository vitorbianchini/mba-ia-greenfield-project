import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    // Producer side only. The consumer lives in WorkerModule, which AppModule
    // never imports, so the API container never picks up processing jobs.
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
