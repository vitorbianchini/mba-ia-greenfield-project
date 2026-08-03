import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });
  it('all video endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const videoPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/videos'),
    );

    expect(videoPaths.length).toBeGreaterThan(0);

    for (const [, methods] of videoPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('documents the whole video pipeline surface', () => {
    const paths = document.paths as Record<string, Record<string, unknown>>;

    expect(paths['/videos/uploads']?.post).toBeDefined();
    expect(paths['/videos/uploads/{videoId}/complete']?.post).toBeDefined();
    expect(paths['/videos/uploads/{videoId}']?.delete).toBeDefined();
    expect(paths['/videos/{publicId}']?.get).toBeDefined();
    expect(paths['/videos/{publicId}/stream']?.get).toBeDefined();
    expect(paths['/videos/{publicId}/thumbnail']?.get).toBeDefined();
    expect(paths['/videos/{publicId}/download']?.get).toBeDefined();
  });

  it('requires a bearer token only on the upload endpoints', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const requiresToken = (path: string, method: string): boolean => {
      const security = paths[path]?.[method]?.security as
        | Array<Record<string, unknown>>
        | undefined;
      return Boolean(security?.some((req) => 'access-token' in req));
    };

    expect(requiresToken('/videos/uploads', 'post')).toBe(true);
    expect(requiresToken('/videos/uploads/{videoId}/complete', 'post')).toBe(
      true,
    );
    expect(requiresToken('/videos/uploads/{videoId}', 'delete')).toBe(true);

    // Anonymous viewing is a project-plan requirement.
    expect(requiresToken('/videos/{publicId}', 'get')).toBe(false);
    expect(requiresToken('/videos/{publicId}/stream', 'get')).toBe(false);
    expect(requiresToken('/videos/{publicId}/download', 'get')).toBe(false);
  });
});
