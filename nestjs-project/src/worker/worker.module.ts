import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { ProcessingModule } from '../videos/processing/processing.module';

// Composition root of the video-worker container. It boots no HTTP listener —
// see worker/main.ts, which uses createApplicationContext.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig, videoConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Explicit rather than autoLoadEntities: the worker only registers
        // Video via forFeature, and TypeORM still needs the metadata of every
        // entity Video's relations reach (Video -> Channel -> User) or it fails
        // at startup with "Entity metadata for Video#channel was not found".
        entities: [User, Channel, Video],
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    ProcessingModule,
  ],
})
export class WorkerModule {}
