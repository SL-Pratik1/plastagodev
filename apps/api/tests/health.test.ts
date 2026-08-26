import { LivenessSchema, ReadinessSchema } from '@plastago/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const app = createServer();

describe('health probes', () => {
  it('reports liveness without touching any dependency', async () => {
    const response = await request(app).get('/healthz').expect(200);

    // Validating against the shared schema is the point: the test proves the
    // response still satisfies the published contract, not just that it is 200.
    expect(() => LivenessSchema.parse(response.body)).not.toThrow();
    expect(response.body.status).toBe('ok');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('reports readiness and returns 503 while a dependency is down', async () => {
    const response = await request(app).get('/readyz');

    expect([200, 503]).toContain(response.status);
    expect(() => ReadinessSchema.parse(response.body)).not.toThrow();

    // No Mongo connection is opened by createServer(), so this run is degraded.
    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.dependencies.mongo.state).toBe('down');
    // Queues are off by default, which must read as "disabled", not "down".
    expect(response.body.dependencies.redis.state).toBe('disabled');
  });

  it('echoes an inbound request id so callers can correlate', async () => {
    const response = await request(app)
      .get('/healthz')
      .set('x-request-id', 'test-correlation-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('test-correlation-id');
  });
});
