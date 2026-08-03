import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and provide a path-style S3 client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      // onModuleInit would reach MinIO; module wiring is what this test covers.
      .overrideProvider(StorageService)
      .useValue({})
      .compile();

    const client = moduleRef.get<S3Client>(STORAGE_CLIENT);

    expect(client).toBeInstanceOf(S3Client);
    expect(client.config.forcePathStyle).toBe(true);

    await moduleRef.close();
  });
});
