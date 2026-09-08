import { IsoDateSchema, ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Path parameters — the only request shapes that are genuinely local.
 *
 * `@plastago/shared` describes the driver's ACTIONS, and since the OpenAPI
 * document is built there, the request BODIES had to move there too: a body
 * declared here is invisible to the published spec, and the Flutter app would
 * be guessing at it (§6A.4). The three that used to live in this file are now
 * re-exported below so there is exactly one definition of each.
 *
 * What stays is the plumbing that never reaches a client as a body: the id
 * segments in the URL.
 */

export const DateQuerySchema = z
  .object({ date: IsoDateSchema })
  .meta({ id: 'DriverDateQuery' });

export const JobIdParamsSchema = z
  .object({ jobId: ObjectIdSchema })
  .meta({ id: 'DriverJobIdParams' });

export const PhotoParamsSchema = z
  .object({ jobId: ObjectIdSchema, photoId: ObjectIdSchema })
  .meta({ id: 'DriverPhotoParams' });

export const RunIdParamsSchema = z
  .object({ runId: ObjectIdSchema })
  .meta({ id: 'DriverRunIdParams' });

/*
 * Request bodies — declared in `@plastago/shared` and re-exported here so the
 * router keeps importing from one place. `SendMessageSchema` keeps its old name
 * locally because that is what the router and controller already call it.
 */
export {
  PresignPhotoSchema,
  PreviewTipOffSchema,
  DriverMessageSchema as SendMessageSchema,
} from '@plastago/shared';
