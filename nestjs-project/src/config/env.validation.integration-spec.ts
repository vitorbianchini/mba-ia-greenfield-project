import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY: 'access-key',
  STORAGE_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video', () => {
  it.each(['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const withoutKey = { ...requiredEnv };
      delete withoutKey[key as keyof typeof withoutKey];

      const { error } = envValidationSchema.validate(withoutKey, {
        allowUnknown: true,
        abortEarly: false,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the Compose-compatible defaults', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_BUCKET).toBe('streamtube');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
  });

  it('should default the video limits to 10GB with 100MB parts', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.VIDEO_MAX_SIZE_BYTES).toBe(10 * 1024 * 1024 * 1024);
    expect(value.VIDEO_PART_SIZE_BYTES).toBe(100 * 1024 * 1024);
    // 10GB in 100MB parts stays far below the S3 10,000-part ceiling.
    expect(
      Math.ceil(value.VIDEO_MAX_SIZE_BYTES / value.VIDEO_PART_SIZE_BYTES),
    ).toBeLessThan(10_000);
  });

  it('should reject a non-numeric REDIS_PORT', () => {
    const { error } = validate({ REDIS_PORT: 'not-a-port' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
