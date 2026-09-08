import { JobStatusSchema, ObjectIdSchema } from '@plastago/shared';
import * as z from 'zod';

/**
 * Request shapes that belong to the transport rather than the domain.
 *
 * ⚠️ Notice what is NOT here: an account id. No portal route takes one — the
 * scope comes from the session, and a parameter is something that can be
 * changed.
 */

export const PortalJobIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'PortalJobIdParams' });

export const PortalJobsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.string().trim().max(40).optional(),
    q: z.string().trim().max(120).optional(),
    status: JobStatusSchema.optional(),
    /** M5.2 — "which of my pickups has nobody confirmed as ready?" */
    readiness: z.enum(['pending', 'certified']).optional(),
    readyWindow: z.enum(['upcoming', 'next-7', 'last-30', 'last-90']).optional(),
  })
  .meta({ id: 'PortalJobsQuery' });

/** M5.5 — flag urgent, or take the flag off. */
export const SetUrgencySchema = z
  .object({ urgent: z.boolean() })
  .meta({ id: 'SetUrgency' });
/* ── M5.10 · invoices ────────────────────────────────────────────────────── */

export const PortalInvoicesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    /**
     * Only the statuses a customer may see anyway. A draft is an invoice the
     * office has not sent, and the repository refuses it regardless — this just
     * stops the request being made in the first place.
     */
    status: z.enum(['awaiting-po', 'sent', 'paid', 'overdue']).optional(),
  })
  .meta({ id: 'PortalInvoicesQuery' });

export const PortalInvoiceIdsSchema = z
  .object({
    ids: z
      .array(ObjectIdSchema)
      .min(1, 'Select at least one invoice')
      .max(50, 'Select fewer invoices — up to 50 at a time'),
  })
  .meta({ id: 'PortalInvoiceIds' });

/* ── M5.14 · supervisors ─────────────────────────────────────────────────── */

export const PortalSupervisorIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'PortalSupervisorIdParams' });

export const PortalSupervisorsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(120).optional(),
  })
  .meta({ id: 'PortalSupervisorsQuery' });

/**
 * Suspend or reactivate.
 *
 * The `invited` state is deliberately absent: it is DERIVED from never having
 * signed in, so offering it here would let a real login be pushed into a state
 * its own history contradicts.
 */
export const SetSupervisorStateSchema = z
  .object({ state: z.enum(['active', 'suspended']) })
  .meta({ id: 'SetSupervisorState' });

/** M5.12 — one of the customer own certificates. */
export const PortalCertificateIdParamsSchema = z
  .object({ id: ObjectIdSchema })
  .meta({ id: 'PortalCertificateIdParams' });
