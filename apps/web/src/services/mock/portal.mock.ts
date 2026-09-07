import { PENDING_READINESS_STATUSES } from '@plastago/shared';
import type {
  Certificate,
  Job,
  MonthlyVolumeReport,
  PortalAccount,
  PortalDashboard,
  PortalInvoice,
  PortalJob,
  PortalJobListItem,
  PortalScope,
  PortalSupervisor,
  PricePreview,
  Session,
  VolumeRow,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { CustomerPortalService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import {
  ACCOUNTS,
  BAG_RATE_CENTS,
  ZONE_RATES,
  centsToMoney,
  objectId,
  resolvePlace,
} from './fixtures/reference';
import { MOCK_SESSION_KEY, latency, readStored } from './mock-transport';
import { invoiceNumberPrefix } from './settings.mock';
import { invoiceList, store, TERMS_VERSION, todayIso } from './store';

/**
 * The customer portal (M5 Part 1).
 *
 * ── The scoping is the feature ─────────────────────────────────────────────
 * Every read below runs through `scopedJobs()`, which narrows
 * to the signed-in user's account and — for a site supervisor — to their own
 * sites. That narrowing is not a filter the UI asked for; it is the whole
 * security model of this surface (M1.5), and it lives in one place here for the
 * same reason it will live in one place on the server: two implementations of a
 * scoping rule is one implementation and one bug.
 *
 * ── Money is nulled HERE, not hidden in the UI ────────────────────────────
 * A site supervisor's payload genuinely does not contain prices: `toPortalJob`
 * writes `null` into the money fields, and the invoice, report and certificate
 * methods refuse outright. So the network tab shows nothing either.
 *
 * The admin console hides money with render-time conditionals instead, and that
 * difference is deliberate — the office is inside the trust boundary and a
 * builder's phone is not.
 */

/* ── Who is asking ────────────────────────────────────────────────────────── */

interface Viewer {
  accountId: string;
  /** Their own id — a supervisor is scoped to the jobs THEY raised. */
  userId: string;
  name: string;
  isAdministrator: boolean;
}

/**
 * The signed-in portal user, read from the mock session.
 *
 * Deliberately reads the session rather than taking a parameter, because that is
 * what the server will do. A method that accepted an `accountId` would make the
 * mock *easier* to write and the contract wrong.
 */
function viewer(): Viewer {
  const session = readStored<Session>(MOCK_SESSION_KEY);
  const user = session?.user;

  if (!user || user.accountId === null) {
    throw new ServiceError('FORBIDDEN', 'This surface is for customer accounts only');
  }

  const isAdministrator = user.role === 'customer-administrator';

  return {
    accountId: user.accountId,
    userId: user.id,
    name: user.name,
    isAdministrator,
  };
}

function accountFor(accountId: string) {
  const account = ACCOUNTS.find((candidate) => candidate.id === accountId);
  if (!account) throw new ServiceError('NOT_FOUND', 'Account not found');
  return account;
}


/**
 * What this viewer is allowed to see.
 *
 * ── The site-scoping boundary, replaced ───────────────────────────────────
 * M1.5 scoped a site supervisor by the list of sites assigned to them. With the
 * Sites module gone (Matt, 0:29) there is no such list, so the boundary is now
 * the jobs they raised themselves — which is the visibility Matt described
 * anyway: *"I just want to make sure site supervisors can submit their jobs and
 * be able to see the jobs they've submitted"* (18:15, earlier call).
 *
 * ⚠️ An administrator still sees the whole account. A supervisor sees strictly
 * less than before, not more: a job with no `bookedByUserId` — anything keyed in
 * by the office, or booked before this existed — is invisible to them. That is
 * the safe direction to be wrong in, and it is the one open question worth
 * putting back to Matt: he may want a supervisor to see the office-booked jobs
 * for their own sites too, which would need a second discriminator on the job.
 */
function scopedJobs(view: Viewer): Job[] {
  return store.jobs.filter((job) => {
    if (job.accountId !== view.accountId) return false;
    if (view.isAdministrator) return true;
    return job.bookedByUserId === view.userId;
  });
}

/* ── Projections ──────────────────────────────────────────────────────────── */

const ON_RUN_SHEET: readonly string[] = [
  'assigned',
  'in-transit',
  'arrived',
  'completed',
  'admin-complete',
];

/**
 * M5.2 — who certified this pickup ready, and when.
 *
 * A pickup booked through the portal carries the certification as an event, with
 * a named actor and a timestamp. That is the real mechanism.
 *
 * ── Why the fallback is by job number and not by site contact ─────────────
 * Fixture jobs predate the portal, so they have no event. An earlier version
 * inferred certification from the site having a contact name — a proxy I
 * invented, and a bad one: on this demo account every site has a contact, so
 * *every* upcoming pickup read as confirmed, the dashboard prompt never appeared
 * and the "not yet confirmed" filter always came back empty. The single most
 * valuable thing on this surface — the 30-second confirmation that prevents a
 * $120 futile pickup (M8.3 · F17) — was invisible.
 *
 * Every fourth job is left unconfirmed instead. Deterministic by job number, so
 * it is stable across reloads and screenshots, and a quarter is about the right
 * proportion to make the prompt look like real neglect rather than a broken
 * import.
 */
function readiness(job: Job): { at: string | null; by: string | null } {
  const certified = job.events.find((event) => event.label === 'Readiness certified');
  if (certified) return { at: certified.at, by: certified.actor };

  if (job.jobNumber % 4 === 0) return { at: null, by: null };

  // The contact is on the job now, not looked up from a site.
  return { at: job.createdAt, by: job.siteContactName ?? 'Site contact' };
}

function toPortalJob(job: Job, view: Viewer): PortalJobListItem {
  const certified = readiness(job);

  return {
    id: job.id,
    jobNumber: job.jobNumber,
    status: job.status,
    siteName: job.siteName,
    suburb: job.suburb,
    bookedByName: job.bookedByName,
    poNumber: job.poNumber,
    readyDate: job.readyDate,
    targetDate: job.targetDate,
    serviceLevel: job.serviceLevel,
    expectedAreaM2: job.expectedAreaM2,
    recoveredWeightKg: job.recoveredWeightKg,
    bagCount: job.bagCount,
    // ⚠️ The server decides. A supervisor's payload has no price in it at all.
    totalIncGst: view.isAdministrator ? job.totalIncGst : null,
    completedAt: job.completedAt,
    photoCount: job.photos.length,
    // M5.4, verbatim from the client's own site map: editable until it is on a
    // run sheet, a request to the office after that.
    editable: !ON_RUN_SHEET.includes(job.status) && job.status !== 'cancelled',
    readinessCertifiedAt: certified.at,
    readinessCertifiedBy: certified.by,
  };
}

/**
 * The customer-facing progress trail.
 *
 * Not the admin timeline: internal events and office actor names are dropped.
 * "Priya Raman changed the ready date" is an internal fact; "Rescheduled" is
 * what the customer needs. Driver first names stay, because a customer asking
 * "who is coming" is reasonable and it is on the SMS already.
 */
const CUSTOMER_VISIBLE_STATUSES: readonly string[] = [
  'booked',
  'assigned',
  'in-transit',
  'arrived',
  'completed',
];

const CUSTOMER_STEP_LABELS: Record<string, string> = {
  booked: 'Pickup booked',
  assigned: 'Scheduled with a driver',
  'in-transit': 'Driver on the way',
  arrived: 'Driver on site',
  completed: 'Pickup completed',
};



/* ── Service ──────────────────────────────────────────────────────────────── */

export function createMockPortalService(): CustomerPortalService {
  return {
    async scope() {
      await latency(140, 60);
      const view = viewer();
      const account = accountFor(view.accountId);

      const scope: PortalScope = {
        accountId: account.id,
        accountName: account.name,
        customerCode: account.code,
        accountType: account.accountType,
        capturesWeight: account.captureMode === 'area-and-weight',
        poRequired: account.poPolicy === 'required-before-invoice',
        // From office settings — the customer quotes the same number back.
        invoiceNumberPrefix: invoiceNumberPrefix(),
        // M1.5's worked example, implemented: a site supervisor cannot see
        // pricing. This is the one field the whole surface branches on.
        canSeePricing: view.isAdministrator,
        // Replaces the site-list scoping from M1.5 — see `scopedJobs`.
        visibility: view.isAdministrator ? 'account' : 'own-jobs',
      };
      return scope;
    },

    async dashboard() {
      await latency(420, 180);
      const view = viewer();
      const account = accountFor(view.accountId);
      const jobs = scopedJobs(view);
      const today = todayIso();
      const monthStart = `${today.slice(0, 7)}-01`;

      const open = jobs.filter((job) =>
        ['booked', 'assigned', 'in-transit', 'arrived'].includes(job.status),
      );

      // The next pickup is the soonest OPEN job, not the soonest job — a
      // completed pickup tomorrow is not what "when are you coming" means.
      const next = [...open].sort((a, b) => a.readyDate.localeCompare(b.readyDate))[0] ?? null;

      const completedThisMonth = jobs.filter(
        (job) =>
          (job.status === 'completed' || job.status === 'admin-complete') &&
          job.readyDate >= monthStart,
      );

      const weights = completedThisMonth
        .map((job) => job.recoveredWeightKg)
        .filter((kilograms): kilograms is number => kilograms !== null);

      const outstanding = view.isAdministrator
        ? invoiceList().filter(
            (invoice) =>
              invoice.accountId === view.accountId &&
              (invoice.status === 'sent' || invoice.status === 'overdue'),
          )
        : [];

      const dashboard: PortalDashboard = {
        generatedAt: new Date().toISOString(),
        openJobs: open.length,
        nextPickup: next
          ? {
              jobId: next.id,
              jobNumber: next.jobNumber,
              siteName: `${next.siteName}, ${next.suburb}`,
              readyDate: next.readyDate,
              status: next.status,
              driverName: next.driverName,
            }
          : null,
        atRiskJobs: open.filter((job) => job.targetDate <= today).length,
        completedThisMonth: completedThisMonth.length,
        areaThisMonthM2: completedThisMonth.reduce((sum, job) => sum + (job.expectedAreaM2 ?? 0), 0),
        // Null on m²-only accounts. A zero would read as "nothing recovered",
        // which is a different and wrong claim (M2.3).
        tonnesThisMonth:
          account.captureMode === 'area-and-weight'
            ? Number((weights.reduce((sum, kilograms) => sum + kilograms, 0) / 1000).toFixed(2))
            : null,
        outstandingInvoiceCount: view.isAdministrator ? outstanding.length : null,
        outstandingInvoiceTotalIncGst: view.isAdministrator
          ? centsToMoney(
              outstanding.reduce(
                (sum, invoice) => sum + Math.round(Number(invoice.totalIncGst) * 100),
                0,
              ),
            )
          : null,
        // M8.3 · F17 + F65 — the direct attack on futile pickups. Same
        // predicate as the list filter and the row badge (`PENDING_READINESS`),
        // so the number here and the rows it links to always agree.
        awaitingReadinessConfirmation: open.filter(
          (job) => PENDING_READINESS_STATUSES.includes(job.status) && readiness(job).at === null,
        ).length,
      };
      return dashboard;
    },

    async jobs(query) {
      await latency();
      const view = viewer();
      const rows = scopedJobs(view).map((job) => toPortalJob(job, view));

      return applyListQuery(rows, query, {
        search: (row) => [row.jobNumber, row.siteName, row.suburb, row.poNumber],
        filters: {
          // "Open" and "Completed" rather than nine raw statuses: the customer
          // asks two questions, not nine.
          state: (row, value) =>
            value === 'open'
              ? ['booked', 'assigned', 'in-transit', 'arrived'].includes(row.status)
              : value === 'completed'
                ? row.status === 'completed' || row.status === 'admin-complete'
                : value === 'futile'
                  ? row.status === 'futile'
                  : row.status === 'cancelled',
          // Filtering by place is filtering by SUBURB now — there is no site
          // record left to key on (Matt, 0:29).
          suburb: (row, value) => row.suburb === value,
          urgent: (row, value) =>
            value === 'urgent' ? row.serviceLevel === 'urgent' : row.serviceLevel === 'standard',
          /*
           * ── Readiness only means something on an UPCOMING pickup ────────
           * A completed job that nobody certified is history: the truck has
           * been and gone, and there is no action left. Matching it here made
           * the filter disagree with the badge — which only renders on
           * booked/assigned rows — so "not yet confirmed" returned
           * rows showing "—", and the count on the dashboard (which correctly
           * looks at open jobs only) disagreed with the list it linked to.
           *
           * Same predicate as `PENDING_READINESS` on the badge. One rule.
           */
          readiness: (row, value) => {
            if (!PENDING_READINESS_STATUSES.includes(row.status)) return false;
            return value === 'unconfirmed'
              ? row.readinessCertifiedAt === null
              : row.readinessCertifiedAt !== null;
          },
        },
        sorters: {
          jobNumber: byNumber((row) => row.jobNumber),
          readyDate: byDate((row) => row.readyDate),
          siteName: byText((row) => row.siteName),
          expectedAreaM2: byNumber((row) => row.expectedAreaM2),
        },
        // Soonest ready date among open jobs, then most recent history — the
        // order a customer reads: what is coming, then what happened.
        defaultSort: (a, b) => {
          const openish = (row: PortalJobListItem) =>
            ['booked', 'assigned', 'in-transit', 'arrived'].includes(row.status)
              ? 0
              : 1;
          const byOpen = openish(a) - openish(b);
          if (byOpen !== 0) return byOpen;
          return openish(a) === 0
            ? a.readyDate.localeCompare(b.readyDate)
            : b.readyDate.localeCompare(a.readyDate);
        },
      });
    },

    async job(id) {
      await latency();
      const view = viewer();
      const job = scopedJobs(view).find((candidate) => candidate.id === id);
      // A supervisor asking for another site's job gets NOT_FOUND, not
      // FORBIDDEN: telling them the job exists is itself a disclosure.
      if (!job) throw new ServiceError('NOT_FOUND', 'Pickup not found');

      const detail: PortalJob = {
        ...toPortalJob(job, view),
        builderName: job.builderName,
        zone: job.zone,
        notes: job.notes,
        driverName: job.driverName,
        arrivedAt: job.arrivedAt,
        photos: job.photos,
        steps: job.events
          .filter(
            (event) => event.status !== null && CUSTOMER_VISIBLE_STATUSES.includes(event.status),
          )
          .map((event) => ({
            id: event.id,
            label: CUSTOMER_STEP_LABELS[event.status ?? ''] ?? event.label,
            at: event.at,
            // Only the driver is named to the customer.
            by: event.status === 'booked' ? null : job.driverName,
          })),
        messages: job.comments
          .filter((comment) => comment.visibility === 'customer')
          .map((comment) => ({
            id: comment.id,
            body: comment.body,
            author: comment.author,
            at: comment.at,
            fromCustomer: false,
          })),
        certificateReference:
          job.status === 'admin-complete' ? `DIV-${String(job.jobNumber)}` : null,
      };
      return detail;
    },

    async quote(draft) {
      await latency(260, 120);
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError(
          'FORBIDDEN',
          'Pricing is not available on a site supervisor account',
        );
      }

      /*
       * The zone comes from the chosen suburb, not from a site.
       *
       * With sites gone (Matt, 0:29) this is the only thing between a typed
       * address and a priced job — which is why the suburb is picked from a
       * list. See `PlaceSchema`.
       */
      const place = resolvePlace(draft.placeId);
      if (!place) throw new ServiceError('VALIDATION_FAILED', 'Choose the suburb from the list');

      const rates = ZONE_RATES[place.zone];
      const account = accountFor(view.accountId);
      const lines = [
        {
          code: 'service-fee' as const,
          description: 'Pickup service fee',
          quantity: 1,
          unitRate: centsToMoney(rates.serviceCents),
          amount: centsToMoney(rates.serviceCents),
        },
        /*
         * No area, no area line.
         *
         * A builder's booking carries none — the PO does (Matt, 25:19) — so the
         * quote shows the call-out fee and says the rest is priced from the
         * order. A zero-quantity line reading "$0.00" would look like a promise.
         */
        ...(draft.expectedAreaM2 === null
          ? []
          : [
              {
                code: 'area-charge' as const,
                description: 'Plasterboard recycling (per m²)',
                quantity: draft.expectedAreaM2,
                unitRate: centsToMoney(rates.perM2Cents),
                amount: centsToMoney(draft.expectedAreaM2 * rates.perM2Cents),
              },
            ]),
        ...(draft.bagCount > 0
          ? [
              {
                code: 'recycling-bags' as const,
                description: 'Recycling bags',
                quantity: draft.bagCount,
                unitRate: centsToMoney(BAG_RATE_CENTS),
                amount: centsToMoney(draft.bagCount * BAG_RATE_CENTS),
              },
            ]
          : []),
      ];

      const subtotal = lines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0);
      const gst = Math.round(subtotal / 10);

      const preview: PricePreview = {
        zone: place.zone,
        rateCardLabel: account.rateCardId,
        lines,
        subtotalExGst: centsToMoney(subtotal),
        gst: centsToMoney(gst),
        totalIncGst: centsToMoney(subtotal + gst),
        caveat:
          'Estimate on your agreed rates. Additional services raised on site — contamination, extra load time — are quoted and approved separately.',
      };
      return preview;
    },

    async book(draft) {
      await latency(720, 300);
      const view = viewer();
      const account = accountFor(view.accountId);

      // The suburb carries the zone that prices the job (M6.3) and the pin the
      // board plots — see `PlaceSchema`. Nothing else about the address can be
      // wrong in a way that costs money.
      const place = resolvePlace(draft.placeId);
      if (!place) {
        throw new ServiceError('VALIDATION_FAILED', 'Choose the suburb from the list', {
          fieldErrors: { placeId: 'Choose the suburb from the list' },
        });
      }

      // The ready date is the customer's promise, so it cannot be in the past.
      if (draft.readyDate < todayIso()) {
        throw new ServiceError('VALIDATION_FAILED', 'The ready date cannot be in the past', {
          fieldErrors: { readyDate: 'Choose today or a later date' },
        });
      }

      // M2.10 — enforce the account's PO policy at the point of booking rather
      // than discovering it at invoicing time, which is where it leaks today.
      if (account.poPolicy === 'required-before-invoice' && !draft.poNumber.trim()) {
        throw new ServiceError('VALIDATION_FAILED', 'This account requires a purchase order', {
          fieldErrors: { poNumber: 'Your account requires a PO number on every booking' },
        });
      }

      const now = new Date().toISOString();
      const jobNumber = Math.max(...store.jobs.map((job) => job.jobNumber)) + 1;
      const rates = ZONE_RATES[place.zone];
      // An unknown area prices at the call-out fee here; the office completes it
      // from the purchase order before the job is invoiced.
      const subtotal =
        rates.serviceCents +
        (draft.expectedAreaM2 ?? 0) * rates.perM2Cents +
        draft.bagCount * BAG_RATE_CENTS;
      const gst = Math.round(subtotal / 10);

      const job: Job = {
        id: objectId('pj', jobNumber),
        jobNumber,
        status: 'booked',
        brandId: account.brandId,
        accountId: account.id,
        accountName: account.name,
        builderName: draft.builderName.trim(),

        /* The address, typed on the job — there is no site behind it. */
        siteName: draft.siteName.trim(),
        lotNumber: draft.lotNumber.trim() || null,
        addressLine: draft.addressLine.trim(),
        suburb: place.suburb,
        postcode: place.postcode,
        zone: place.zone,
        latitude: place.latitude,
        longitude: place.longitude,
        accessNotes: draft.accessNotes.trim(),
        gateHours: draft.gateHours.trim() || null,
        inductionRequired: draft.inductionRequired,
        craneAvailable: draft.craneAvailable,
        siteContactName: draft.siteContactName.trim() || null,
        siteContactMobile: draft.siteContactMobile.trim() || null,
        siteContactEmail: draft.siteContactEmail.trim() || null,

        poNumber: draft.poNumber || null,
        /*
         * The person who actually pressed the button.
         *
         * Matt, 18:15: *"I just want to make sure site supervisors can submit
         * their jobs and be able to see the jobs they've submitted."* Taken from
         * the session rather than a form field, so it cannot be typed wrong or
         * left blank.
         */
        bookedByName: view.name,
        // The supervisor's scope. See `scopedJobs` — this is what they will be
        // able to see afterwards, so it must be set at creation or not at all.
        bookedByUserId: view.userId,
        bookedBySource: 'portal',
        readyDate: draft.readyDate,
        targetDate: addBusinessDays(draft.readyDate, 5),
        serviceLevel: draft.serviceLevel,
        driverId: null,
        driverName: null,
        expectedAreaM2: draft.expectedAreaM2,
        recoveredWeightKg: null,
        // No collection yet, so no weight and no basis to describe.
        recoveredWeightBasis: null,
        bagCount: draft.bagCount,
        totalExGst: centsToMoney(subtotal),
        invoiceStatus: 'not-invoiced',
        hasPendingCharges: false,
        completedAt: null,
        createdAt: now,
        freightItem: draft.bagCount > 0 ? 'plasterboard-bagged' : 'plasterboard-hand-load',
        notes: draft.notes,
        exceptionReason: null,
        exceptionNote: null,
        arrivedAt: null,
        onSiteMinutes: null,
        charges: [],
        events: [
          {
            id: objectId('ev', jobNumber * 3),
            at: now,
            label: 'Pickup booked',
            actor: view.name,
            status: 'booked',
            detail: 'Booked in the customer portal',
            latitude: null,
            longitude: null,
          },
          /*
           * M5.2 — the certification, as its own event with a named actor and a
           * timestamp. This is the record that makes a futile charge defensible:
           * "David Chen, GJ Gardner, certified on 12 Aug at 14:32 that this job
           * would be ready" — rather than an unverified string in a text box.
           */
          {
            id: objectId('ev', jobNumber * 3 + 1),
            at: now,
            label: 'Readiness certified',
            actor: view.name,
            status: null,
            detail: 'Job ready · truck accessible · free of contaminants',
            latitude: null,
            longitude: null,
          },
        ],
        photos: [],
        documents: [],
        comments: [],
        invoiceNumber: null,
        invoicedAt: null,
        gst: centsToMoney(gst),
        totalIncGst: centsToMoney(subtotal + gst),
        // Resolved at creation and frozen — see the note on the office's
        // `create` in `jobs.mock.ts`. A booking made through the portal is
        // still a job a driver will be sent to, so the rule applies identically.
        compliance: {
          // The account's rule, and only the account's — the per-site exception
          // went with the sites. Frozen at creation, as before.
          riskAssessmentRequired:
            store.accountRiskAssessment.get(account.id) ?? account.riskAssessmentRequired,
          riskAssessment: null,
          preStart: null,
        },
      };

      store.jobs = [...store.jobs, job];
      return toPortalJob(job, view);
    },

    async editJob(id, input) {
      await latency(560, 240);
      const view = viewer();
      const index = store.jobs.findIndex(
        (candidate) => candidate.id === id && candidate.accountId === view.accountId,
      );
      const job = store.jobs[index];
      if (index === -1 || !job) throw new ServiceError('NOT_FOUND', 'Pickup not found');

      if (ON_RUN_SHEET.includes(job.status)) {
        throw new ServiceError(
          'CONFLICT',
          'This pickup is already scheduled with a driver — send a change request instead',
        );
      }
      if (input.readyDate < todayIso()) {
        throw new ServiceError('VALIDATION_FAILED', 'The ready date cannot be in the past', {
          fieldErrors: { readyDate: 'Choose today or a later date' },
        });
      }

      const rates = ZONE_RATES[job.zone];
      const subtotal =
        rates.serviceCents +
        input.expectedAreaM2 * rates.perM2Cents +
        input.bagCount * BAG_RATE_CENTS;
      const gst = Math.round(subtotal / 10);

      const updated: Job = {
        ...job,
        readyDate: input.readyDate,
        // M2.4a — the SLA clock restarts from the customer's new ready date.
        targetDate: addBusinessDays(input.readyDate, 5),
        expectedAreaM2: input.expectedAreaM2,
        bagCount: input.bagCount,
        serviceLevel: input.serviceLevel,
        // One reference field now (Matt, 9:08) — whichever the customer gave.
        poNumber: input.poNumber || null,
        notes: input.notes,
        totalExGst: centsToMoney(subtotal),
        gst: centsToMoney(gst),
        totalIncGst: centsToMoney(subtotal + gst),
        events: [
          ...job.events,
          {
            id: objectId('ev', job.jobNumber * 5 + job.events.length),
            at: new Date().toISOString(),
            label: 'Pickup updated',
            actor: view.name,
            status: null,
            detail: `Ready date ${input.readyDate}, ${String(input.expectedAreaM2)} m²`,
            latitude: null,
            longitude: null,
          },
        ],
      };

      store.jobs = store.jobs.map((candidate) => (candidate.id === id ? updated : candidate));
      return toPortalJob(updated, view);
    },

    async requestChange(id, input) {
      await latency(600, 260);
      const view = viewer();
      const job = scopedJobs(view).find((candidate) => candidate.id === id);
      if (!job) throw new ServiceError('NOT_FOUND', 'Pickup not found');

      /*
       * A change request is a customer-visible comment plus an office alert, not
       * a change to the job. That is M5.4's rule: once the pickup is on a run
       * sheet the customer asks and the office decides. Applying it silently
       * would let a supervisor move a truck that has already been dispatched.
       */
      const now = new Date().toISOString();
      store.jobs = store.jobs.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              comments: [
                ...candidate.comments,
                {
                  id: objectId('cm', candidate.jobNumber * 11 + candidate.comments.length),
                  body:
                    input.kind === 'reschedule'
                      ? `Reschedule requested${input.requestedDate ? ` to ${input.requestedDate}` : ''}: ${input.note}`
                      : input.kind === 'cancel'
                        ? `Cancellation requested: ${input.note}`
                        : input.note,
                  author: view.name,
                  at: now,
                  visibility: 'customer' as const,
                  deliveredAt: null,
                  fromDriver: false,
                },
              ],
            }
          : candidate,
      );
    },

    async setUrgency(id, urgent) {
      await latency(480, 200);
      const view = viewer();
      const index = store.jobs.findIndex(
        (candidate) => candidate.id === id && candidate.accountId === view.accountId,
      );
      const job = store.jobs[index];
      if (index === -1 || !job) throw new ServiceError('NOT_FOUND', 'Pickup not found');

      const updated: Job = {
        ...job,
        serviceLevel: urgent ? 'urgent' : 'standard',
        events: [
          ...job.events,
          {
            id: objectId('ev', job.jobNumber * 7 + job.events.length),
            at: new Date().toISOString(),
            label: urgent ? 'Marked urgent by the customer' : 'Urgency removed',
            actor: view.name,
            status: null,
            detail: null,
            latitude: null,
            longitude: null,
          },
        ],
      };
      store.jobs = store.jobs.map((candidate) => (candidate.id === id ? updated : candidate));
      return toPortalJob(updated, view);
    },

    async certifyReadiness(id) {
      await latency(520, 220);
      const view = viewer();
      const index = store.jobs.findIndex(
        (candidate) => candidate.id === id && candidate.accountId === view.accountId,
      );
      const job = store.jobs[index];
      if (index === -1 || !job) throw new ServiceError('NOT_FOUND', 'Pickup not found');

      const updated: Job = {
        ...job,
        events: [
          ...job.events,
          {
            id: objectId('ev', job.jobNumber * 13 + job.events.length),
            at: new Date().toISOString(),
            label: 'Readiness certified',
            actor: view.name,
            status: null,
            detail: 'Job ready · truck accessible · free of contaminants',
            latitude: null,
            longitude: null,
          },
        ],
      };
      store.jobs = store.jobs.map((candidate) => (candidate.id === id ? updated : candidate));
      return toPortalJob(updated, view);
    },

    async invoices(query) {
      await latency();
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError('FORBIDDEN', 'Invoices are visible to account administrators only');
      }

      const rows: PortalInvoice[] = invoiceList()
        .filter((invoice) => invoice.accountId === view.accountId && invoice.status !== 'draft')
        .map((invoice) => {
          const job = invoice.jobId
            ? store.jobs.find((candidate) => candidate.id === invoice.jobId)
            : undefined;
          return {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            kind: invoice.kind,
            status:
              invoice.status === 'unknown' ? 'sent' : (invoice.status as PortalInvoice['status']),
            jobId: invoice.jobId,
            jobNumber: invoice.jobNumber,
            siteName: job ? `${job.siteName}, ${job.suburb}` : null,
            poNumber: invoice.poNumber,
            issuedOn: invoice.issuedOn,
            dueOn: invoice.dueOn,
            subtotalExGst: invoice.subtotalExGst,
            gst: invoice.gst,
            totalIncGst: invoice.totalIncGst,
            paidAt: invoice.paidAt,
          };
        });

      return applyListQuery(rows, query, {
        search: (row) => [
          row.invoiceNumber,
          row.jobNumber,
          row.poNumber,
          row.siteName,
        ],
        filters: {
          status: (row, value) =>
            value === 'outstanding'
              ? row.status === 'sent' || row.status === 'overdue'
              : row.status === value,
          kind: (row, value) => row.kind === value,
        },
        sorters: {
          invoiceNumber: byNumber((row) => row.invoiceNumber),
          issuedOn: byDate((row) => row.issuedOn),
          dueOn: byDate((row) => row.dueOn),
          totalIncGst: byNumber((row) => Number(row.totalIncGst)),
        },
        // Overdue first, then oldest outstanding: the customer's own priority.
        defaultSort: (a, b) => {
          const rank = (row: PortalInvoice) =>
            row.status === 'overdue'
              ? 0
              : row.status === 'awaiting-po'
                ? 1
                : row.status === 'sent'
                  ? 2
                  : 3;
          return rank(a) - rank(b) || b.invoiceNumber - a.invoiceNumber;
        },
      });
    },

    async requestInvoicePdf(ids) {
      await latency(600, 260);
      if (ids.length === 0) throw new ServiceError('VALIDATION_FAILED', 'Select an invoice first');
      // Rendered server-side (§6A.6). Nothing for the mock to do.
    },

    async monthlyReport(filters) {
      await latency(560, 240);
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError('FORBIDDEN', 'Reports are visible to account administrators only');
      }

      const account = accountFor(view.accountId);
      const jobs = scopedJobs(view).filter(
        (job) =>
          (job.status === 'completed' || job.status === 'admin-complete') &&
          job.readyDate >= filters.from &&
          job.readyDate <= filters.to &&
          (!filters.suburb || job.suburb === filters.suburb),
      );

      /*
       * Grouped by SUBURB, always.
       *
       * The admin console groups by account because it serves many. A customer
       * has one account, so the question that matters to them is which AREA
       * their volume came out of — which is also the finest grouping left now
       * that jobs no longer share a site record (Matt, 0:29).
       */
      const buckets = new Map<string, VolumeRow>();
      for (const job of jobs) {
        const existing = buckets.get(job.suburb) ?? {
          key: job.suburb,
          label: job.suburb,
          jobs: 0,
          areaM2: 0,
          weightKg: null,
          bags: 0,
          chargesExGst: '0.00',
        };
        buckets.set(job.suburb, {
          ...existing,
          jobs: existing.jobs + 1,
          areaM2: existing.areaM2 + (job.expectedAreaM2 ?? 0),
          weightKg:
            job.recoveredWeightKg === null
              ? existing.weightKg
              : (existing.weightKg ?? 0) + job.recoveredWeightKg,
          bags: existing.bags + job.bagCount,
          chargesExGst: centsToMoney(
            Math.round(Number(existing.chargesExGst) * 100) +
              Math.round(Number(job.totalExGst) * 100),
          ),
        });
      }

      const rows = [...buckets.values()].sort((a, b) => b.areaM2 - a.areaM2);
      const months = new Map<string, { jobs: number; areaM2: number }>();
      for (const job of jobs) {
        const month = job.readyDate.slice(0, 7);
        const existing = months.get(month) ?? { jobs: 0, areaM2: 0 };
        months.set(month, {
          jobs: existing.jobs + 1,
          areaM2: existing.areaM2 + (job.expectedAreaM2 ?? 0),
        });
      }

      const report: MonthlyVolumeReport = {
        filters: { ...filters, accountId: account.id },
        rows,
        byMonth: [...months.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, value]) => ({ month, ...value })),
        totalJobs: jobs.length,
        totalAreaM2: rows.reduce((sum, row) => sum + row.areaM2, 0),
        totalChargesExGst: centsToMoney(
          rows.reduce((sum, row) => sum + Math.round(Number(row.chargesExGst) * 100), 0),
        ),
      };
      return report;
    },

    async certificates(query) {
      await latency(460, 200);
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError(
          'FORBIDDEN',
          'Certificates are visible to account administrators only',
        );
      }
      const account = accountFor(view.accountId);

      /*
       * Only jobs whose weight was actually measured.
       *
       * Matt, 32:11: *"this is only for weighed jobs. If it's an estimated job,
       * we're unable to provide a certificate because it's an estimated weight
       * and **it doesn't meet compliance regulation**."*
       *
       * So an estimated job produces no certificate here rather than one carrying
       * a caveat. The customer seeing nothing is the correct outcome: the
       * document does not exist, and offering a flagged version would invite it
       * into a Green Star submission it cannot support.
       */
      const rows: Certificate[] = scopedJobs(view)
        .filter(
          (job) =>
            (job.status === 'admin-complete' || job.status === 'completed') &&
            job.recoveredWeightKg !== null &&
            job.recoveredWeightBasis === 'actual',
        )
        .map((job) => {
          // Non-null by the filter above; never derived from the priced m².
          const tonnes = (job.recoveredWeightKg ?? 0) / 1000;

          return {
            id: `${job.id}-cert`,
            reference: `DIV-${String(job.jobNumber)}`,
            scope: 'job' as const,
            state: job.status === 'admin-complete' ? ('issued' as const) : ('draft' as const),
            accountId: account.id,
            accountName: account.name,
            siteName: `${job.siteName}, ${job.suburb}`,
            jobNumber: job.jobNumber,
            periodFrom: job.readyDate,
            periodTo: job.readyDate,
            jobs: 1,
            areaM2: (job.expectedAreaM2 ?? 0),
            tonnesDiverted: Number(tonnes.toFixed(2)),
            issuedAt: job.status === 'admin-complete' ? job.invoicedAt : null,
            issuedTo: job.status === 'admin-complete' ? account.name : null,
          };
        });

      return applyListQuery(rows, query, {
        search: (row) => [row.reference, row.siteName, row.jobNumber],
        filters: { state: (row, value) => row.state === value },
        sorters: {
          reference: byText((row) => row.reference),
          periodFrom: byDate((row) => row.periodFrom),
          tonnesDiverted: byNumber((row) => row.tonnesDiverted),
        },
        defaultSort: (a, b) => b.periodFrom.localeCompare(a.periodFrom),
      });
    },

    async requestCertificatePdf(id) {
      await latency(680, 280);
      if (!id) throw new ServiceError('VALIDATION_FAILED', 'Choose a certificate');
      // Server-rendered (§6A.6), and still awaiting a layout sample from Matt.
    },

    async supervisors(query) {
      await latency();
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError('FORBIDDEN', 'Only account administrators manage supervisors');
      }

      const rows = supervisorsFor(view.accountId);
      return applyListQuery(rows, query, {
        search: (row) => [row.name, row.email, row.mobile],
        filters: {
          state: (row, value) => row.state === value,
          approval: (row, value) =>
            value === 'awaiting' ? row.awaitingApproval : !row.awaitingApproval,
        },
        sorters: {
          name: byText((row) => row.name),
          lastSignedInAt: byDate((row) => row.lastSignedInAt),
          invitedAt: byDate((row) => row.invitedAt),
        },
        // Anyone awaiting approval first — B.2's safety valve only works if
        // somebody sees it.
        defaultSort: (a, b) =>
          Number(b.awaitingApproval) - Number(a.awaitingApproval) || a.name.localeCompare(b.name),
      });
    },

    async inviteSupervisor(input) {
      await latency(760, 300);
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError('FORBIDDEN', 'Only account administrators invite supervisors');
      }

      const email = input.email.trim();
      const mobile = input.mobile.trim();
      if (!email && !mobile) {
        throw new ServiceError('VALIDATION_FAILED', 'Give a mobile or an email', {
          fieldErrors: { mobile: 'A mobile is usually faster on site' },
        });
      }

      const existing = supervisorState.get(view.accountId) ?? [];
      if (
        existing.some((row) => (email && row.email === email) || (mobile && row.mobile === mobile))
      ) {
        throw new ServiceError('CONFLICT', 'Someone with those details is already invited');
      }

      const supervisor: PortalSupervisor = {
        id: objectId('sv', existing.length + 40),
        name: input.name.trim(),
        email: email || null,
        mobile: mobile || null,
        state: 'invited',
        invitedAt: new Date().toISOString(),
        lastSignedInAt: null,
        awaitingApproval: false,
      };

      supervisorState.set(view.accountId, [...existing, supervisor]);
      return supervisor;
    },

    async setSupervisorState(id, state) {
      await latency(520, 220);
      return mutateSupervisor(id, (row) => ({ ...row, state }));
    },

    async approveSupervisor(id) {
      await latency(560, 240);
      return mutateSupervisor(id, (row) => ({
        ...row,
        awaitingApproval: false,
        state: 'active',
      }));
    },

    /* ── Journey A.4 — the customer completes their own account ─────── */

    async onboardingInvite() {
      await latency(180, 90);
      const view = viewer();
      const account = accountFor(view.accountId);

      return {
        accountId: account.id,
        customerCode: account.code,
        suggestedLegalName: account.name,
        accountType: account.accountType,
        state: store.termsAcceptance.has(account.id) ? 'complete' : 'awaiting-terms',
        acceptance: store.termsAcceptance.get(account.id) ?? null,
        termsVersion: TERMS_VERSION,
      };
    },

    async completeOnboarding(input) {
      await latency(620, 280);
      const view = viewer();

      /*
       * Only an administrator can accept.
       *
       * A director's guarantee is a commitment by the business (Matt, 7:49). A
       * site supervisor works on a building site and has no authority to bind
       * their employer, so the check is here rather than only in the routing —
       * a guard that lives only in the UI is not a guard.
       */
      if (!view.isAdministrator) {
        throw new ServiceError(
          'FORBIDDEN',
          'Only an account administrator can accept the terms and conditions',
        );
      }

      const account = accountFor(view.accountId);

      // Accepting twice is not an error, but it must not rewrite the record: the
      // date and the person on it are the evidence.
      if (store.termsAcceptance.has(account.id)) return;

      store.termsAcceptance.set(account.id, {
        acceptedAt: new Date().toISOString(),
        acceptedByName: input.acceptedByName.trim(),
        acceptedByRole: input.acceptedByRole.trim(),
        termsVersion: TERMS_VERSION,
      });

      // Where the certificates go is the customer's answer, not the office's
      // (Matt, 31:04), so it is captured here and not at conversion.
      if (input.certificateEmail.trim() !== '') {
        store.accountCertificateEmail.set(account.id, input.certificateEmail.trim());
      }
    },

    async account() {
      await latency();
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError('FORBIDDEN', 'Only account administrators see account settings');
      }
      const account = accountFor(view.accountId);
      const override = accountOverrides.get(view.accountId);

      const result: PortalAccount = {
        accountId: account.id,
        customerCode: account.code,
        name: account.name,
        abn: account.abn,
        paymentTermsDays: account.paymentTermsDays,
        poPolicy: account.poPolicy,
        captureMode: account.captureMode,
        primaryZone: account.primaryZone,
        contacts: account.contacts.map((contact) => ({
          ...contact,
          ...(override?.contacts.get(contact.id) ?? {}),
        })),
        preferredPickupWindow: override?.preferredPickupWindow ?? account.preferredPickupWindow,
        approveNewSupervisors: override?.approveNewSupervisors ?? true,
      };
      return result;
    },

    async updateAccount(input) {
      await latency(640, 260);
      const view = viewer();
      if (!view.isAdministrator) {
        throw new ServiceError('FORBIDDEN', 'Only account administrators change these settings');
      }

      const contacts = new Map(
        input.contacts.map((contact) => [
          contact.id,
          { notifyBySms: contact.notifyBySms, notifyByEmail: contact.notifyByEmail },
        ]),
      );
      accountOverrides.set(view.accountId, {
        preferredPickupWindow: input.preferredPickupWindow || null,
        approveNewSupervisors: input.approveNewSupervisors,
        contacts,
      });

      return this.account();
    },
  };
}

/* ── Local mutable state ──────────────────────────────────────────────────── */

const accountOverrides = new Map<
  string,
  {
    preferredPickupWindow: string | null;
    approveNewSupervisors: boolean;
    contacts: Map<string, { notifyBySms: boolean; notifyByEmail: boolean }>;
  }
>();

const supervisorState = new Map<string, PortalSupervisor[]>();

/**
 * Supervisors, seeded from the account's site contacts on first read.
 *
 * Derived rather than invented so the names on this screen are the same names
 * that appear as site contacts elsewhere — a supervisor list that disagrees with
 * the site records is the kind of small inconsistency a client notices
 * immediately and cannot un-notice.
 */
function supervisorsFor(accountId: string): PortalSupervisor[] {
  const existing = supervisorState.get(accountId);
  if (existing) return existing;

  const account = ACCOUNTS.find((candidate) => candidate.id === accountId);

  /*
   * Seeded from the people who have actually booked something.
   *
   * Was the site-contact list, which is gone with the sites (Matt, 0:29). The
   * jobs are a better source anyway: a supervisor who has raised a pickup is one
   * who genuinely uses the portal, which is what this screen is for.
   */
  const bookers = new Map<string, { name: string; mobile: string | null }>();
  for (const job of store.jobs) {
    if (job.accountId !== accountId) continue;
    if (job.bookedBySource !== 'portal' || job.bookedByName === null) continue;
    if (!bookers.has(job.bookedByName)) {
      bookers.set(job.bookedByName, { name: job.bookedByName, mobile: job.siteContactMobile });
    }
  }

  const seeded: PortalSupervisor[] = [...bookers.values()]
    .slice(0, 6)
    .map((booker, index) => ({
      id: objectId('sv', index + 1),
      name: booker.name,
      email: null,
      mobile: booker.mobile,
      state: index === 4 ? ('suspended' as const) : ('active' as const),
      invitedAt: new Date(Date.now() - (30 + index * 9) * 86_400_000).toISOString(),
      lastSignedInAt:
        index === 4 ? null : new Date(Date.now() - (index + 1) * 3600_000).toISOString(),
      // B.2 — one join-by-code awaiting approval, so the safety valve is visible.
      awaitingApproval: index === 2,
    }));

  // The account's own site contacts get all-sites access, matching how head
  // office actually works on the organised accounts (Clarendon, Domaine).
  const headOffice = account?.contacts.find((contact) => contact.role === 'site');
  if (headOffice) {
    seeded.unshift({
      id: objectId('sv', 90),
      name: headOffice.name,
      email: headOffice.email,
      mobile: headOffice.mobile,
      state: 'active',
      invitedAt: new Date(Date.now() - 180 * 86_400_000).toISOString(),
      lastSignedInAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      awaitingApproval: false,
    });
  }

  supervisorState.set(accountId, seeded);
  return seeded;
}

function mutateSupervisor(
  id: string,
  change: (row: PortalSupervisor) => PortalSupervisor,
): PortalSupervisor {
  for (const [accountId, rows] of supervisorState) {
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) continue;
    const current = rows[index];
    if (!current) continue;
    const updated = change(current);
    const next = [...rows];
    next[index] = updated;
    supervisorState.set(accountId, next);
    return updated;
  }
  throw new ServiceError('NOT_FOUND', 'Supervisor not found');
}

/** M2.4a — five BUSINESS days from the customer's ready date. */
function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}
