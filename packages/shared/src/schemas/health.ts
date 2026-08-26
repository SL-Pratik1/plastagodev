import * as z from 'zod';

/**
 * Health contract.
 *
 * `/healthz`  — liveness. Cheap, no dependencies. Render restarts on failure.
 * `/readyz`   — readiness. Checks Mongo and Redis. Returns 503 when not ready.
 *
 * `disabled` is a first-class state so a scaffold with no Redis is honestly
 * reported as "not configured" rather than "broken".
 */
export const DependencyStateSchema = z.enum(['up', 'down', 'disabled']).meta({
  id: 'DependencyState',
});

export const DependencyCheckSchema = z
  .object({
    state: DependencyStateSchema,
    latencyMs: z.number().nonnegative().optional(),
    detail: z.string().optional(),
  })
  .meta({ id: 'DependencyCheck' });

export const LivenessSchema = z
  .object({
    status: z.literal('ok'),
    service: z.string(),
    version: z.string(),
    uptimeSeconds: z.number().nonnegative(),
  })
  .meta({ id: 'Liveness' });

export const ReadinessSchema = z
  .object({
    status: z.enum(['ready', 'degraded']),
    service: z.string(),
    version: z.string(),
    checkedAt: z.iso.datetime({ offset: true }),
    dependencies: z.object({
      mongo: DependencyCheckSchema,
      redis: DependencyCheckSchema,
    }),
  })
  .meta({ id: 'Readiness' });

export type DependencyState = z.infer<typeof DependencyStateSchema>;
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;
export type Liveness = z.infer<typeof LivenessSchema>;
export type Readiness = z.infer<typeof ReadinessSchema>;
