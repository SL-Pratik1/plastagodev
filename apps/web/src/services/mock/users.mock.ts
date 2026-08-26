import {
  channelForIdentifier,
  isAustralianMobile,
  normaliseMobile,
  type User,
  type UserDraft,
  type UserListItem,
  type UserStatus,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { UserService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { latency } from './mock-transport';
import { accountName, findUser, store } from './store';
import { objectId } from './fixtures/reference';

/** The grid projection — the detail-only fields are dropped. */
function toListItem(user: User): UserListItem {
  const {
    jobTitle: _jobTitle,
    invitedBy: _invitedBy,
    notes: _notes,
    devices: _devices,
    recentSignIns: _recentSignIns,
    ...listItem
  } = user;
  return listItem;
}

let nextId = 1000;

export function createMockUserService(): UserService {
  return {
    async list(query) {
      await latency();

      return applyListQuery(store.users.map(toListItem), query, {
        search: (user) => [user.name, user.email, user.mobile, user.accountName],
        filters: {
          role: (user, value) => user.role === value,
          status: (user, value) => user.status === value,
          account: (user, value) => user.accountId === value,
          brand: (user, value) => user.brandIds.includes(value as UserListItem['brandIds'][number]),
        },
        sorters: {
          name: byText((user) => user.name),
          role: byText((user) => user.role),
          status: byText((user) => user.status),
          account: byText((user) => user.accountName),
          siteCount: byNumber((user) => user.siteCount),
          lastSignedInAt: byDate((user) => user.lastSignedInAt),
          createdAt: byDate((user) => user.createdAt),
        },
        defaultSort: byText((user) => user.name),
      });
    },

    async get(id) {
      await latency();
      const user = findUser(id);
      if (!user) throw new ServiceError('NOT_FOUND', `No user ${id}`);
      return { ...user };
    },

    async create(draft: UserDraft) {
      await latency(420, 220);
      validate(draft);

      nextId += 1;
      const identifier = draft.email || draft.mobile;
      const created: User = {
        id: objectId('us', nextId),
        name: draft.name,
        email: draft.email || null,
        mobile: draft.mobile ? normaliseMobile(draft.mobile) : null,
        role: draft.role,
        // Invited, not active: they exist but have never signed in. Showing them
        // as active would make the invitation campaign's activation rate — a
        // go-live gate — unmeasurable.
        status: 'invited',
        brandIds: draft.brandIds,
        accountId: draft.accountId,
        accountName: draft.accountId ? accountName(draft.accountId) : null,
        siteCount: 0,
        lastSignedInAt: null,
        createdAt: new Date().toISOString(),
        jobTitle: draft.jobTitle || null,
        invitedBy: 'Matthew Browne',
        notes: draft.notes,
        devices: [],
        recentSignIns: [],
      };

      // Surfaced so the UI can say "we've emailed them" vs "we've texted them".
      void channelForIdentifier(identifier);

      store.users = [created, ...store.users];
      return toListItem(created);
    },

    async update(id, draft) {
      await latency(420, 220);
      validate(draft);

      const index = store.users.findIndex((user) => user.id === id);
      const existing = store.users[index];
      if (index === -1 || !existing) throw new ServiceError('NOT_FOUND', `No user ${id}`);

      const updated: User = {
        ...existing,
        name: draft.name,
        email: draft.email || null,
        mobile: draft.mobile ? normaliseMobile(draft.mobile) : null,
        role: draft.role,
        brandIds: draft.brandIds,
        accountId: draft.accountId,
        accountName: draft.accountId ? accountName(draft.accountId) : null,
        jobTitle: draft.jobTitle || null,
        notes: draft.notes,
      };

      store.users = store.users.map((user) => (user.id === id ? updated : user));
      return toListItem(updated);
    },

    async setStatus(id, status: UserStatus) {
      await latency(360, 180);
      const existing = findUser(id);
      if (!existing) throw new ServiceError('NOT_FOUND', `No user ${id}`);

      const updated: User = { ...existing, status };
      store.users = store.users.map((user) => (user.id === id ? updated : user));
      return toListItem(updated);
    },

    async resendInvite(id) {
      await latency(400, 200);
      const existing = findUser(id);
      if (!existing) throw new ServiceError('NOT_FOUND', `No user ${id}`);
      if (existing.status === 'suspended') {
        throw new ServiceError('CONFLICT', 'Cannot invite a suspended user');
      }
    },
  };
}

/**
 * Server-side validation, mirrored.
 *
 * The form validates the same rules with Zod so the user is told immediately —
 * but the service checks them too. Client validation is a courtesy; it is not a
 * guarantee, and a mock that accepts anything teaches the UI to skip the error
 * path it will meet in production.
 */
function validate(draft: UserDraft): void {
  const fieldErrors: Record<string, string> = {};

  if (!draft.email && !draft.mobile) {
    fieldErrors.email = 'Enter an email address or a mobile number';
  }
  if (draft.mobile && !isAustralianMobile(draft.mobile)) {
    fieldErrors.mobile = 'Enter a valid Australian mobile number, e.g. 0412 345 678';
  }
  if (draft.email && !draft.email.includes('@')) {
    fieldErrors.email = 'Enter a valid email address';
  }

  // A customer role without an account could see everything or nothing — both
  // are wrong, so it is rejected rather than defaulted (M1.5).
  const customerRole = draft.role.startsWith('customer-');
  if (customerRole && !draft.accountId) {
    fieldErrors.accountId = 'Customer users must belong to an account';
  }
  if (!customerRole && draft.accountId) {
    fieldErrors.accountId = 'Only customer roles belong to an account';
  }

  // §9 — site supervisors and drivers sign in by SMS, so a mobile is required.
  if ((draft.role === 'driver' || draft.role === 'customer-site-supervisor') && !draft.mobile) {
    fieldErrors.mobile = 'This role signs in by SMS, so a mobile number is required';
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ServiceError('VALIDATION_FAILED', 'User draft is not valid', { fieldErrors });
  }
}
