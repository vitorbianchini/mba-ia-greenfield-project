import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { closeQueues } from '../test/close-queue';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('compiles with the video repository, channels, storage and queue wiring', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        // ChannelsModule injects both a repository and the DataSource, so a real
        // connection is the only way this graph resolves.
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRoot({
          connection: { host: queueConfig().host, port: queueConfig().port },
        }),
        VideosModule,
      ],
    }).compile();

    expect(moduleRef.get(VideosService)).toBeDefined();
    expect(moduleRef.get(VideosController)).toBeDefined();

    await closeQueues(moduleRef, VIDEO_PROCESSING_QUEUE);
    await moduleRef.close();
  }, 30_000);
});
