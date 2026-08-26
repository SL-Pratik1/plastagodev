import * as z from 'zod';
import { IsoDateTimeSchema, NonEmptyStringSchema, ObjectIdSchema } from './primitives.js';
import { RoleSchema } from './identity.js';

/**
 * The audit log (M1.6).
 *
 * ── Why it exists ────────────────────────────────────────────────────────
 * "Who changed what, when, from what value to what value — **immutable**." Today
 * a shared mailbox and a shared page password mean there is **zero
 * accountability**, so *"who changed job 61402's ready date from 12 Aug to 19
 * Aug?"* is currently unanswerable. This makes it one click.
 *
 * Fed by Change Streams into an append-only collection (§6A.3 #7), which is why
 * there is no update or delete anywhere in this contract — and why the UI has no
 * edit affordance. An audit log you can edit is not an audit log.
 *
 * §9 also commits to an **audit of all logins**, so authentication events are
 * first-class entries here rather than a separate feed.
 */
export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'status-changed',
  'deleted',
  'signed-in',
  'sign-in-failed',
  'signed-out',
  'invited',
  'suspended',
  'reactivated',
  'approved',
  'rejected',
  'sent',
  'exported',
] as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS).meta({ id: 'AuditAction' });
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  created: 'Created',
  updated: 'Updated',
  'status-changed': 'Status changed',
  deleted: 'Deleted',
  'signed-in': 'Signed in',
  'sign-in-failed': 'Sign-in failed',
  'signed-out': 'Signed out',
  invited: 'Invited',
  suspended: 'Suspended',
  reactivated: 'Reactivated',
  approved: 'Approved',
  rejected: 'Rejected',
  sent: 'Sent',
  exported: 'Exported',
};

/** The entity kinds that exist in this build. Grows with the domains. */
export const AUDIT_ENTITIES = [
  'job',
  'account',
  'site',
  'user',
  'invoice',
  'charge',
  'driver',
  'vehicle',
  'session',
  'settings',
] as const;
export const AuditEntitySchema = z.enum(AUDIT_ENTITIES).meta({ id: 'AuditEntity' });
export type AuditEntity = z.infer<typeof AuditEntitySchema>;

export const AUDIT_ENTITY_LABELS: Record<AuditEntity, string> = {
  job: 'Job',
  account: 'Account',
  site: 'Site',
  user: 'User',
  invoice: 'Invoice',
  charge: 'Charge',
  driver: 'Driver',
  vehicle: 'Vehicle',
  session: 'Session',
  settings: 'Settings',
};

/** One field's before/after. `null` on either side means absent, not empty. */
export const AuditChangeSchema = z
  .object({
    field: NonEmptyStringSchema,
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .meta({ id: 'AuditChange' });

export const AuditEntrySchema = z
  .object({
    id: ObjectIdSchema,
    at: IsoDateTimeSchema,
    /** Who. `null` only for a system-generated change (M6.6 `system` charges). */
    actorId: ObjectIdSchema.nullable(),
    actorName: NonEmptyStringSchema,
    actorRole: RoleSchema.nullable(),
    action: AuditActionSchema,
    entity: AuditEntitySchema,
    entityId: ObjectIdSchema.nullable(),
    /** Human-readable handle — "Job #61402", "iPlasta Pty Ltd". */
    entityLabel: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    changes: z.array(AuditChangeSchema),
    /** Where the record lives now, for a deep link. Empty when it is gone. */
    href: z.string(),
    /** §9 — logins record the device, which is the only clue on a bad sign-in. */
    device: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });

export type AuditChange = z.infer<typeof AuditChangeSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
