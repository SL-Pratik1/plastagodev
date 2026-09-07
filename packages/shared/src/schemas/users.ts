import * as z from 'zod';
import { IsoDateTimeSchema, NonEmptyStringSchema, ObjectIdSchema } from './primitives.js';
import { RoleSchema } from './identity.js';
import { BrandIdSchema } from './party.js';

/**
 * User administration (M1.5 · W1, W2, W16).
 *
 * Extends the session's `AuthenticatedUser` with the fields only an
 * administrator needs: status, who invited them, when they last signed in, and
 * the scope their role is confined to.
 */
export const USER_STATUSES = ['active', 'invited', 'suspended'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES).meta({ id: 'UserStatus' });
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  suspended: 'Suspended',
};

export const UserListItemSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    email: z.email().nullable(),
    mobile: z.string().nullable(),
    /**
     * The role this user is listed under — their main one.
     *
     * A user may hold more than one (see `roles`); this is the one the grid
     * groups and filters by, so a driver who also allocates still reads as a
     * driver in the list rather than appearing in two places.
     */
    role: RoleSchema,
    /**
     * Every role this user holds. Usually just `[role]`.
     *
     * Matt, 27:01: an allocator who covers a driver's shift when someone calls
     * in sick holds both, and switches between them.
     */
    roles: z.array(RoleSchema).min(1),
    status: UserStatusSchema,
    brandIds: z.array(BrandIdSchema),
    /** Set for the two customer roles — scopes the portal to one account. */
    accountId: ObjectIdSchema.nullable(),
    accountName: z.string().nullable(),
    lastSignedInAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'UserListItem' });

/** §9 — driver device registration, surfaced so a lost phone can be revoked. */
export const UserDeviceSchema = z
  .object({
    id: ObjectIdSchema,
    label: NonEmptyStringSchema,
    platform: z.enum(['ios', 'android', 'web']),
    lastSeenAt: IsoDateTimeSchema,
    /** §6A.8 — a stuck offline queue must be visible in the product. */
    pendingSyncActions: z.number().int().nonnegative(),
    lastSyncAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'UserDevice' });

/** §9 — audit of all logins. */
export const UserSignInSchema = z
  .object({
    id: ObjectIdSchema,
    at: IsoDateTimeSchema,
    channel: z.enum(['email', 'sms']),
    outcome: z.enum(['success', 'failed-code', 'expired-code', 'locked-out']),
    device: z.string(),
  })
  .meta({ id: 'UserSignIn' });

export const UserSchema = UserListItemSchema.extend({
  jobTitle: z.string().nullable(),
  invitedBy: z.string().nullable(),
  notes: z.string(),
  devices: z.array(UserDeviceSchema),
  recentSignIns: z.array(UserSignInSchema),
}).meta({ id: 'User' });

/**
 * Create/edit payload.
 *
 * One identifier field, matching the sign-in screen: office roles are reached by
 * email, site roles by mobile. Requiring both would block a supervisor who only
 * has a phone — which is most of them.
 */
export const UserDraftSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter their full name').max(80),
    email: z.string().trim(),
    mobile: z.string().trim(),
    /** Their main role — what they are listed under. */
    role: RoleSchema,
    /**
     * Any extra roles beyond `role`. Almost always empty.
     *
     * The one case Matt confirmed is an allocator who also drives (27:01), and
     * he was explicit that no other pairing is needed (27:36) — so this is a
     * deliberate exception, not a general-purpose permission matrix.
     */
    additionalRoles: z.array(RoleSchema),
    jobTitle: z.string().trim().max(80),
    brandIds: z.array(BrandIdSchema).min(1, 'Choose at least one brand'),
    accountId: ObjectIdSchema.nullable(),
    notes: z.string().trim().max(500),
  })
  .meta({ id: 'UserDraft' });

export type UserListItem = z.infer<typeof UserListItemSchema>;
export type UserDevice = z.infer<typeof UserDeviceSchema>;
export type UserSignIn = z.infer<typeof UserSignInSchema>;
export type User = z.infer<typeof UserSchema>;
export type UserDraft = z.infer<typeof UserDraftSchema>;
