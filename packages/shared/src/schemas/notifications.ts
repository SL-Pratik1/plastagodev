import * as z from 'zod';
import {
  IsoDateTimeSchema,
  MoneySchema,
  NonEmptyStringSchema,
  ObjectIdSchema,
} from './primitives.js';

/**
 * The internal notification centre (M8.7).
 *
 * ── What this is, and what it is deliberately not ──────────────────────────
 * M8.7 is "internal alerting on queues — daily digest and dashboard badges for
 * the futile review, approvals and awaiting-PO queues", and §6A.8 adds
 * sync-failure and failed-background-job visibility because there is no
 * error-tracking vendor. That is the whole documented basis, and it is what this
 * models: **things that need someone to act**.
 *
 * It is NOT a chat system (F20 office↔driver chat is v1.1, and job-scoped
 * comments already cover that need), and it is NOT the customer-facing SMS/email
 * stream from M8.1/M8.2 — those go out to customers, they do not land in an
 * office inbox. Modelling either here would invent a feature.
 *
 * The reason for the existence of this screen at all: one futile pickup has sat
 * unactioned in TransVirtual since 28 August 2025 — a year, at $120. The system
 * has to chase.
 */
export const NOTIFICATION_CATEGORIES = ['queue', 'exception', 'invoice', 'sync', 'system'] as const;
export const NotificationCategorySchema = z
  .enum(NOTIFICATION_CATEGORIES)
  .meta({ id: 'NotificationCategory' });
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  queue: 'Queues',
  exception: 'Exceptions',
  invoice: 'Invoicing',
  sync: 'Driver sync',
  system: 'System',
};

/**
 * Severity, which drives ordering as much as colour.
 *
 * `action` means somebody has to do something; `info` is a record. A centre
 * where everything is urgent trains people to ignore it, so the mock is
 * deliberately sparing with `action`.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'action', 'urgent'] as const;
export const NotificationSeveritySchema = z
  .enum(NOTIFICATION_SEVERITIES)
  .meta({ id: 'NotificationSeverity' });
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export const NotificationSchema = z
  .object({
    id: ObjectIdSchema,
    category: NotificationCategorySchema,
    severity: NotificationSeveritySchema,
    title: NonEmptyStringSchema,
    body: NonEmptyStringSchema,
    at: IsoDateTimeSchema,
    readAt: IsoDateTimeSchema.nullable(),
    /** Where acting on it happens — every notification must be actionable. */
    href: z.string(),
    /** Shown on queue notifications, because the amount is the argument. */
    valueExGst: MoneySchema.nullable(),
    /** For deep links back to the record that raised it. */
    jobId: ObjectIdSchema.nullable(),
    jobNumber: z.number().int().positive().nullable(),
  })
  .meta({ id: 'Notification' });

export const NotificationSummarySchema = z
  .object({
    unread: z.number().int().nonnegative(),
    urgent: z.number().int().nonnegative(),
  })
  .meta({ id: 'NotificationSummary' });

export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationSummary = z.infer<typeof NotificationSummarySchema>;
