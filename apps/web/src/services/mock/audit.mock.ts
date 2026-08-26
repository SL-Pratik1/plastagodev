import { ROLE_LABELS, type AuditEntry } from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { AuditService } from '../types';
import { applyListQuery, byDate, byText } from './list-query';
import { createRng, objectId, pick } from './fixtures/reference';
import { latency } from './mock-transport';
import { store } from './store';
import { USERS } from './fixtures/users';

/**
 * The audit log (M1.6).
 *
 * ── Built from the events that actually happened ───────────────────────────
 * Every job status change already carries an actor and a timestamp in
 * `job.events`, so the audit trail is projected from those rather than invented
 * alongside them. That is also how it will work in production: Change Streams
 * feed an append-only collection (§6A.3 #7), so the log is a consequence of the
 * data changing, not a second thing the application has to remember to write.
 *
 * Login events are included because §9 commits to an audit of all logins, and
 * keeping them in the same log is what makes "what happened around 4pm?"
 * answerable in one place.
 *
 * Read-only throughout. An audit log with a write path is not an audit log.
 */
let cache: AuditEntry[] | null = null;

function build(): AuditEntry[] {
  const rng = createRng(20260826);
  const entries: AuditEntry[] = [];
  let index = 0;

  const staff = USERS.filter(
    (user) => !user.role.startsWith('customer-') && user.role !== 'driver',
  );

  const add = (entry: Omit<AuditEntry, 'id'>) => {
    index += 1;
    entries.push({ ...entry, id: objectId('au', index) });
  };

  // ── Job lifecycle, straight from the timeline ──────────────────────────
  for (const job of store.jobs.slice(0, 60)) {
    for (const event of job.events) {
      const actor = USERS.find((user) => user.name === event.actor);

      add({
        at: event.at,
        actorId: actor?.id ?? null,
        actorName: event.actor,
        actorRole: actor?.role ?? null,
        action:
          event.status === null
            ? 'updated'
            : event.label === 'Job created'
              ? 'created'
              : 'status-changed',
        entity: 'job',
        entityId: job.id,
        entityLabel: `Job #${String(job.jobNumber)}`,
        summary: `${event.label} — ${job.accountName}, ${job.siteName}`,
        // The before/after that makes the log worth having. A status change
        // records the transition; a date change records both dates.
        changes:
          event.status === null
            ? [{ field: 'readyDate', from: null, to: event.detail }]
            : [{ field: 'status', from: null, to: event.status }],
        href: `/admin/jobs/${job.id}?tab=timeline`,
        device: null,
      });
    }
  }

  // ── The example the scope names explicitly ────────────────────────────
  // "Who changed job 61402's ready date from 12 Aug to 19 Aug?" — currently
  // unanswerable. Seeded so the screen can demonstrate the answer.
  const target = store.jobs.find((job) => job.jobNumber === 61402) ?? store.jobs[40];
  if (target) {
    add({
      at: new Date(Date.now() - 3 * 86400_000).toISOString(),
      actorId: staff[2]?.id ?? null,
      actorName: staff[2]?.name ?? 'Priya Raman',
      actorRole: staff[2]?.role ?? 'office-staff',
      action: 'updated',
      entity: 'job',
      entityId: target.id,
      entityLabel: `Job #${String(target.jobNumber)}`,
      summary: `Ready date changed — ${target.accountName}`,
      changes: [
        { field: 'readyDate', from: '2026-08-12', to: '2026-08-19' },
        { field: 'targetDate', from: '2026-08-19', to: '2026-08-26' },
      ],
      href: `/admin/jobs/${target.id}?tab=timeline`,
      device: null,
    });
  }

  // ── Charge approvals (M2.7) ───────────────────────────────────────────
  const approved = store.jobs
    .flatMap((job) =>
      job.charges
        .filter((charge) => charge.source !== 'office' && charge.approvalState === 'approved')
        .map((charge) => ({ job, charge })),
    )
    .slice(0, 14);

  for (const { job, charge } of approved) {
    const actor = pick(rng, staff);
    add({
      at: charge.raisedAt,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? 'Renee Alvarez',
      actorRole: actor?.role ?? 'operations',
      action: 'approved',
      entity: 'charge',
      entityId: charge.id,
      entityLabel: charge.description,
      summary: `${charge.description} approved on job #${String(job.jobNumber)}`,
      changes: [{ field: 'approvalState', from: 'pending', to: 'approved' }],
      href: `/admin/jobs/${job.id}?tab=charges`,
      device: null,
    });
  }

  // ── User administration (M1.5) ────────────────────────────────────────
  for (const user of USERS.slice(7, 20)) {
    add({
      at: user.createdAt,
      actorId: staff[0]?.id ?? null,
      actorName: user.invitedBy ?? 'Matthew Browne',
      actorRole: 'super-admin',
      action: 'invited',
      entity: 'user',
      entityId: user.id,
      entityLabel: user.name,
      summary: `${user.name} invited as ${ROLE_LABELS[user.role]}`,
      changes: [
        { field: 'role', from: null, to: user.role },
        { field: 'status', from: null, to: 'invited' },
      ],
      href: `/admin/users/${user.id}`,
      device: null,
    });
  }

  // ── Logins (§9) ───────────────────────────────────────────────────────
  for (const user of USERS.slice(0, 8)) {
    for (const signIn of user.recentSignIns) {
      add({
        at: signIn.at,
        actorId: user.id,
        actorName: user.name,
        actorRole: user.role,
        action: signIn.outcome === 'success' ? 'signed-in' : 'sign-in-failed',
        entity: 'session',
        entityId: null,
        entityLabel: user.name,
        summary:
          signIn.outcome === 'success'
            ? `Signed in with a ${signIn.channel === 'sms' ? 'SMS' : 'email'} code`
            : `Sign-in failed — ${signIn.outcome === 'failed-code' ? 'wrong code' : 'code expired'}`,
        changes: [],
        href: `/admin/users/${user.id}?tab=sign-ins`,
        // The device is the only clue on a suspicious sign-in.
        device: signIn.device,
      });
    }
  }

  // ── Settings (W3) ─────────────────────────────────────────────────────
  add({
    at: new Date(Date.now() - 9 * 86400_000).toISOString(),
    actorId: staff[0]?.id ?? null,
    actorName: 'Matthew Browne',
    actorRole: 'super-admin',
    action: 'updated',
    entity: 'settings',
    entityId: null,
    entityLabel: 'Notification settings',
    summary: 'Upcoming-job reminder lead time changed',
    changes: [{ field: 'reminderLeadDays', from: '2', to: '1' }],
    href: '/admin/settings?tab=notifications',
    device: null,
  });

  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function current(): AuditEntry[] {
  cache ??= build();
  return cache;
}

export function createMockAuditService(): AuditService {
  return {
    async list(query) {
      await latency();

      return applyListQuery(current(), query, {
        search: (entry) => [entry.actorName, entry.entityLabel, entry.summary],
        filters: {
          actor: (entry, value) => entry.actorId === value,
          action: (entry, value) => entry.action === value,
          entity: (entry, value) => entry.entity === value,
          window: (entry, value) => matchesWindow(entry.at, value),
        },
        sorters: {
          at: byDate((entry) => entry.at),
          actorName: byText((entry) => entry.actorName),
          entity: byText((entry) => entry.entity),
        },
        // Newest first, always. An audit log is read backwards from now.
        defaultSort: (a, b) => b.at.localeCompare(a.at),
      });
    },

    async get(id) {
      await latency(240, 120);
      const entry = current().find((candidate) => candidate.id === id);
      if (!entry) throw new ServiceError('NOT_FOUND', `No audit entry ${id}`);
      return { ...entry };
    },
  };
}

function matchesWindow(iso: string, window: string): boolean {
  const hours = (Date.now() - new Date(iso).getTime()) / 3600_000;
  switch (window) {
    case 'today':
      return iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
    case 'last-24h':
      return hours <= 24;
    case 'last-7d':
      return hours <= 24 * 7;
    case 'last-30d':
      return hours <= 24 * 30;
    default:
      return true;
  }
}
