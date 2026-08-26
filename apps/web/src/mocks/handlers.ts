import { API_VERSION, type Readiness } from '@plastago/shared';
import { http, HttpResponse } from 'msw';

/**
 * MSW handlers — the mock backend for days 1–3 (§13.2).
 *
 * The whole point of the design-lock sequencing is that the API contract falls
 * out of real UI needs rather than being guessed (§13.1). So the discipline
 * here is: build the screen, discover the shape it actually needs, add the Zod
 * schema to `@plastago/shared`, mock it here, and only then implement the
 * endpoint. Mocks that drift from the shared schemas defeat the exercise —
 * always type the response as the shared type, as below.
 */
export const handlers = [
  http.get('/readyz', () => {
    const body: Readiness = {
      status: 'ready',
      service: 'plastago-api (mock)',
      version: API_VERSION,
      checkedAt: new Date().toISOString(),
      dependencies: {
        mongo: { state: 'up', latencyMs: 3 },
        redis: { state: 'disabled', detail: 'ENABLE_QUEUES=false' },
      },
    };
    return HttpResponse.json(body);
  }),
];
