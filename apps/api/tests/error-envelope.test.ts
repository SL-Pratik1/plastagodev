import { ApiErrorSchema } from '@plastago/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const app = createServer();

/**
 * The error envelope is part of the contract — every client branches on it.
 * These tests exist so a refactor of the error handler cannot quietly change
 * the shape that the web apps and the Flutter client depend on.
 */
describe('error envelope', () => {
  it('returns the ApiError shape for an unknown route', async () => {
    const response = await request(app).get('/no-such-route').expect(404);

    expect(() => ApiErrorSchema.parse(response.body)).not.toThrow();
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('returns BAD_REQUEST for malformed JSON rather than an HTML stack', async () => {
    const response = await request(app)
      .post('/api/v1/')
      .set('content-type', 'application/json')
      .send('{"broken":')
      .expect(400);

    expect(() => ApiErrorSchema.parse(response.body)).not.toThrow();
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('puts the caller-supplied request id in the error body', async () => {
    const response = await request(app)
      .get('/no-such-route')
      .set('x-request-id', 'trace-me')
      .expect(404);

    expect(response.body.error.requestId).toBe('trace-me');
  });
});
