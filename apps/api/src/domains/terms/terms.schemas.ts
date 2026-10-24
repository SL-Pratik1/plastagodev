import { ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/** Path parameters. The bodies live in `@plastago/shared` — see `schemas/terms.ts`. */

export const TermsVersionParamsSchema = z
  .object({ version: z.coerce.number().int().positive() })
  .meta({ id: 'TermsVersionParams' });

export const TermsAccountParamsSchema = z
  .object({ accountId: ObjectIdSchema })
  .meta({ id: 'TermsAccountParams' });
