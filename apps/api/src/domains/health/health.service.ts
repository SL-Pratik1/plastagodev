import { API_VERSION, type Liveness, type Readiness } from '@plastago/shared';
import { healthRepository } from './health.repository.js';

const SERVICE_NAME = 'plastago-api';

/**
 * Service layer — business rules, no Express and no Mongoose.
 *
 * This is the layer that is unit-testable without a server or a database, and
 * it is where domain logic belongs. Controllers translate HTTP; repositories
 * translate storage; everything in between lives here.
 */
export const healthService = {
  getLiveness(): Liveness {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: API_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  },

  async getReadiness(): Promise<Readiness> {
    const [mongo, redis] = await Promise.all([
      healthRepository.checkMongo(),
      healthRepository.checkRedis(),
    ]);

    // `disabled` is not a failure — a dependency that was deliberately switched
    // off must not make the service look broken.
    const isDown = mongo.state === 'down' || redis.state === 'down';

    return {
      status: isDown ? 'degraded' : 'ready',
      service: SERVICE_NAME,
      version: API_VERSION,
      checkedAt: new Date().toISOString(),
      dependencies: { mongo, redis },
    };
  },
};
