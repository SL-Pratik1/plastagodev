import {
  NotificationCategorySchema,
  NotificationSeveritySchema,
  ObjectIdSchema,
} from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * ⚠️ Notice what is NOT here: a user id. A caller reads and marks their OWN
 * inbox — resolved from the session — so there is nothing in a URL to change.
 */

export const ListNotificationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    category: NotificationCategorySchema.optional(),
    severity: NotificationSeveritySchema.optional(),
    /** The default view is everything; the badge is what is unread. */
    unreadOnly: z.coerce.boolean().optional(),
  })
  .meta({ id: 'ListNotificationsQuery' });

export const NotificationIdsSchema = z
  .object({
    ids: z
      .array(ObjectIdSchema)
      .min(1, 'Select at least one notification')
      .max(200, 'Select fewer — up to 200 at a time'),
  })
  .meta({ id: 'NotificationIds' });
