import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  recordingProviders,
} from './helpers/fake-outbound.js';
import type { JobDraft, Role } from '@plastago/shared';
import type { BookablePurchaseOrder } from '../src/domains/queues/purchase-order.repository.js';
import { createFakeJobRepository } from './helpers/fake-jobs.js';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * M2.12 — booking a job against a confirmed purchase order.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Before it, a confirmed purchase order was a write-only record: the extractor
 * read "823.41 m²" off a Domaine order, a human confirmed it, and the job was
 * then booked with no area at all — priced at the call-out fee and excluded
 * from the m²-weighted tip-off split.
 *
 * The rules under test are the ones that make the order authoritative:
 *
 *  1. The order's figures WIN over anything the form sends, because the area
 *     prices the job and a caller that could send its own area could name its
 *     own price.
 *  2. A fixed-price order's missing area stays NULL, not zero.
 *  3. One order, one job — *"ONE PURCHASE ORDER NUMBER ONLY PER TAX INVOICE"*.
 *  4. An order on another account cannot be attached by pasting its id.
 */

let repo: ReturnType<typeof createFakeJobRepository>;
let settings: ReturnType<typeof createFakeSettingsRepository>;

const account = {
  id: 'acc0000000000000000000a1',
  name: 'Domaine Homes',
  brandId: 'plastago' as const,
  rateCardId: 'clarendon-domaine' as const,
  status: 'active' as 'active' | 'inactive',
  riskAssessmentRequired: false,
};

/**
 * The Domaine order, with the real figures off the client's PDF.
 *
 * Typed explicitly rather than inferred: `typeof DOMAINE_ORDER` would fix
 * `expectedAreaM2` as `number`, and the Wisdom order below is the whole point —
 * a fixed-price order states no area at all.
 */
const DOMAINE_ORDER: BookablePurchaseOrder = {
  id: 'po00000000000000000000d1',
  poNumber: '79904106/082',
  accountId: account.id,
  accountName: 'Domaine Homes',
  receivedAt: '2026-07-28T06:20:00.000Z',
  lotNumber: '914',
  addressLine: '(#10) Broadmeadow way',
  suburb: 'Edgeworth',
  postcode: '2285',
  expectedAreaM2: 823.41,
  bagAllowance: 2,
  siteSupervisorName: 'Mathew French',
  siteSupervisorMobile: '0427 821 430',
  // The login provisioned for him when the order was confirmed (M5.14).
  siteSupervisorUserId: 'usr00000000000000000mf1',
  amountExGst: '474.68',
};

/** The Wisdom order — fixed price, so genuinely no area on the page. */
const WISDOM_ORDER: BookablePurchaseOrder = {
  ...DOMAINE_ORDER,
  id: 'po00000000000000000000w1',
  poNumber: '208918.321.01',
  accountName: 'Wisdom Homes',
  lotNumber: '959',
  addressLine: 'Somervaille Dr',
  suburb: 'Catherine Field',
  postcode: '2557',
  expectedAreaM2: null,
  bagAllowance: null,
  siteSupervisorName: 'David Luc',
  siteSupervisorMobile: '0411 601 227',
  amountExGst: '302.00',
};

/** Orders the fake repository will answer with, by id. */
let orders: Record<string, BookablePurchaseOrder> = {};
let lastOrderLookup: { id: string; accountId: string } | null = null;

/** Purchase orders already held by a job: id → job number. */
let taken = new Map<string, number>();

/** What `pricingService.quote` was asked for. The assertion that matters most. */
let quotedFor: Array<{ expectedAreaM2: number | null; bagCount: number }> = [];

vi.mock('../src/domains/jobs/job.repository.js', () => ({
  get jobRepository() {
    return repo.repository;
  },
  writeQuotedCharges: () => Promise.resolve(),
  jobsForPurchaseOrders: (ids: readonly string[]) =>
    Promise.resolve(new Map([...taken].filter(([id]) => ids.includes(id)))),
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return settings.repository;
  },
}));

vi.mock('../src/domains/accounts/account.repository.js', () => ({
  accountRepository: {
    findById: (id: string) => Promise.resolve({ ...account, id }),
  },
}));

vi.mock('../src/domains/queues/purchase-order.repository.js', () => ({
  purchaseOrderRepository: {
    findForAccount: (id: string, accountId: string) => {
      lastOrderLookup = { id, accountId };
      const order = orders[id];
      // Mirrors the real repository: the account is part of the FILTER, so an
      // order on another account simply is not found.
      return Promise.resolve(order && order.accountId === accountId ? order : null);
    },
    listForAccount: () => Promise.resolve(Object.values(orders)),
  },
}));

vi.mock('../src/domains/places/place.service.js', () => ({
  placeService: {
    require: (placeId: string) =>
      Promise.resolve({
        id: placeId,
        suburb: 'Catherine Field',
        postcode: '2557',
        state: 'NSW',
        zone: 'sydney' as const,
        latitude: -34.0294,
        longitude: 150.7801,
        label: 'Catherine Field NSW 2557',
      }),
  },
}));

vi.mock('../src/domains/settings/pricing.service.js', () => {
  const preview = {
    zone: 'sydney' as const,
    rateCardLabel: 'Clarendon / Domaine',
    lines: [],
    subtotalExGst: '474.68',
    gst: '47.47',
    totalIncGst: '522.15',
    caveat: '',
  };

  /**
   * M6.2 — the rates as applied, which `create` freezes onto the job.
   *
   * Stubbed rather than omitted: the job repository now requires it, so a fake
   * that returned only the preview would fail every booking here for a reason
   * that has nothing to do with purchase orders.
   */
  const appliedRate = {
    rateCardId: 'clarendon-domaine',
    rateCardLabel: 'Clarendon / Domaine',
    zone: 'sydney' as const,
    scheduleFrom: '2026-04-01',
    serviceCharge: '220.00',
    ratePerM2: '0.16',
  };

  const record = (input: { expectedAreaM2: number | null; bagCount: number }) => {
    quotedFor.push({ expectedAreaM2: input.expectedAreaM2, bagCount: input.bagCount });
  };

  return {
    pricingService: {
      quote: (input: { expectedAreaM2: number | null; bagCount: number }) => {
        record(input);
        return Promise.resolve(preview);
      },

      /* What `create` calls. Both record, so preview-versus-booked still compares. */
      quoteWithAppliedRate: (input: { expectedAreaM2: number | null; bagCount: number }) => {
        record(input);
        return Promise.resolve({ preview, appliedRate });
      },
    },
  };
});

/*
 * M8.1 / M8.2 — booking a job, moving it and completing it now message the site
 * contact, and every send is logged. Faked like every other repository: the
 * real one would buffer a write against a MongoDB that is not there.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

const { jobService } = await import('../src/domains/jobs/job.service.js');
const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const OFFICE = {
  userId: 'usr0000000000000000000f1',
  name: 'Renee Boyle',
  roles: ['operations'] as Role[],
  accountId: null,
};

/** The builder's own supervisor, booking through the portal. */
const SUPERVISOR = {
  userId: 'usr00000000000000000sv1',
  name: 'Dane Whitfield',
  roles: ['customer-site-supervisor'] as Role[],
  accountId: account.id,
};

function draft(overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    accountId: account.id,
    siteName: 'Lot 914 Broadmeadow Way',
    lotNumber: '914',
    addressLine: '10 Broadmeadow Way',
    placeId: 'catherine-field',
    builderName: 'Domaine Homes',
    accessNotes: '',
    gateHours: '',
    inductionRequired: false,
    craneAvailable: false,
    siteContactName: '',
    siteContactMobile: '',
    siteContactEmail: '',
    poNumber: '',
    purchaseOrderId: null,
    readyDate: '2026-09-15',
    serviceLevel: 'standard',
    freightItem: 'plasterboard-hand-load',
    expectedAreaM2: 0,
    bagCount: 0,
    notes: '',
    ...overrides,
  };
}

beforeEach(() => {
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
  repo = createFakeJobRepository();
  settings = createFakeSettingsRepository();
  orders = { [DOMAINE_ORDER.id]: DOMAINE_ORDER, [WISDOM_ORDER.id]: WISDOM_ORDER };
  taken = new Map();
  quotedFor = [];
  lastOrderLookup = null;
});

/* ── The order is the authority ───────────────────────────────────────────── */

describe('the purchase order supplies the figures that price the job', () => {
  it('prices from the order’s area, not the form’s', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    expect(quotedFor).toEqual([{ expectedAreaM2: 823.41, bagCount: 2 }]);
  });

  /*
   * ⚠️ The assertion this whole feature exists for.
   *
   * A caller that could send its own area could name its own price. The area is
   * resolved server-side from the stored order for the same reason `placeId`
   * supplies the zone rather than the browser sending one.
   */
  it('ignores an area the caller sent alongside an order', async () => {
    await jobService.create(
      draft({ purchaseOrderId: DOMAINE_ORDER.id, expectedAreaM2: 1, bagCount: 99 }),
      OFFICE,
    );

    expect(quotedFor).toEqual([{ expectedAreaM2: 823.41, bagCount: 2 }]);
  });

  it('stores the area on the job, frozen', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    expect(repo.calls.lastCreate?.expectedAreaM2).toBe(823.41);
    expect(repo.calls.lastCreate?.bagCount).toBe(2);
  });

  it('records which order the job fulfils', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    expect(repo.calls.lastCreate?.purchaseOrderId).toBe(DOMAINE_ORDER.id);
  });

  /*
   * Matt, 9:56: *"if we don't list PO on the invoice, then sometimes I have
   * trouble getting paid."* The order's own number is the string the builder's
   * accounts system matches; a retyped copy can differ by a character.
   */
  it('takes the PO number from the order, overriding a typed one', async () => {
    await jobService.create(
      draft({ purchaseOrderId: DOMAINE_ORDER.id, poNumber: '79904106-082' }),
      OFFICE,
    );

    expect(repo.calls.lastCreate?.poNumber).toBe('79904106/082');
  });

  it('quotes the same figures in the preview as it books', async () => {
    await jobService.preview(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    // The number quoted down the phone must be the number on the invoice.
    expect(quotedFor[0]).toEqual(quotedFor[1]);
  });
});

/* ── Fixed price ──────────────────────────────────────────────────────────── */

describe('a fixed-price order with no stated area', () => {
  /*
   * ⚠️ Matt, 31:04, on the Wisdom order: *"we're on a fixed price with them. So
   * they don't actually give us square metres… they just give us a line item."*
   *
   * Zero would price the job at the call-out fee AND silently drop the stop out
   * of the m²-weighted tip-off split, handing its share of recovered tonnage to
   * everyone else on the run — on a figure that ends up on a diversion
   * certificate.
   */
  it('keeps the area NULL rather than falling back to zero', async () => {
    await jobService.create(draft({ purchaseOrderId: WISDOM_ORDER.id }), OFFICE);

    expect(quotedFor).toEqual([{ expectedAreaM2: null, bagCount: 0 }]);
    expect(repo.calls.lastCreate?.expectedAreaM2).toBeNull();
  });

  it('does not let a form-supplied area sneak in where the order has none', async () => {
    await jobService.create(
      draft({ purchaseOrderId: WISDOM_ORDER.id, expectedAreaM2: 500 }),
      OFFICE,
    );

    expect(repo.calls.lastCreate?.expectedAreaM2).toBeNull();
  });
});

/* ── One order, one job ───────────────────────────────────────────────────── */

describe('one purchase order can only be booked once', () => {
  /*
   * Wisdom's order says it in capitals: *"ONE PURCHASE ORDER NUMBER ONLY PER TAX
   * INVOICE."* An invoice is raised per job, so a second job against one order
   * bills the builder twice under a number their accounts system has closed.
   */
  it('refuses an order a job already holds', async () => {
    taken.set(DOMAINE_ORDER.id, 61_412);

    await expect(
      jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE),
    ).rejects.toThrow(/already on job 61412/);
  });

  it('names the job that took it, rather than failing on a duplicate key', async () => {
    taken.set(DOMAINE_ORDER.id, 61_412);

    // The number is in the message so the office can go and look at it.
    await expect(
      jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE),
    ).rejects.toThrow(/61412/);
  });

  it('writes nothing when the order is refused', async () => {
    taken.set(DOMAINE_ORDER.id, 61_412);

    await jobService
      .create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE)
      .catch(() => undefined);

    expect(repo.calls.lastCreate).toBeNull();
  });
});

/* ── Scoping ──────────────────────────────────────────────────────────────── */

describe('an order belonging to another account', () => {
  it('cannot be attached by pasting its id', async () => {
    orders = {
      [DOMAINE_ORDER.id]: { ...DOMAINE_ORDER, accountId: 'acc0000000000000000000zz' },
    };

    await expect(
      jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE),
    ).rejects.toThrow(/could not be found on this account/);
  });

  it('looks the order up THROUGH the account, not afterwards', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    // The constraint has to be in the query; a check applied afterwards is one
    // somebody can forget (§6A.3 #5).
    expect(lastOrderLookup).toEqual({ id: DOMAINE_ORDER.id, accountId: account.id });
  });

  it('refuses an order that does not exist at all', async () => {
    orders = {};

    await expect(
      jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE),
    ).rejects.toThrow(/could not be found/);
  });
});

/* ── Bookings with no order ───────────────────────────────────────────────── */

/*
 * Matt, 33:57: *"that job should get assigned to that site supervisor… they get
 * an email and able to log in in the system and see all these job details."*
 *
 * `bookedByUserId` is an AUTHORISATION field (see the job model): a supervisor
 * sees the jobs it points at. An office booking leaves it null, which is
 * invisible to everybody — so without this the office confirms the order, the
 * job appears, and the one person who needs it cannot see it.
 */
describe('the order’s supervisor can see the job booked against it', () => {
  it('scopes an office booking to the supervisor the order named', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    expect(repo.calls.lastCreate?.bookedByUserId).toBe('usr00000000000000000mf1');
  });

  /*
   * ⚠️ The office user stays the one who booked it. The two fields answer
   * different questions — who keyed it in, and who may see it — and collapsing
   * them would put a supervisor's name on work they never raised.
   */
  it('still records the office user as the one who booked it', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    expect(repo.calls.lastCreate?.bookedByName).toBe(OFFICE.name);
    expect(repo.calls.lastCreate?.bookedBySource).toBe('office');
  });

  /*
   * An order with a blank supervisor is normal — Matt, 34:52: *"sometimes
   * they're blank… then it just sits there with no site supervisor assigned."*
   * Null is invisible to every supervisor, which is the safe direction.
   */
  it('leaves the job unscoped when the order named nobody', async () => {
    orders[DOMAINE_ORDER.id] = {
      ...DOMAINE_ORDER,
      siteSupervisorName: null,
      siteSupervisorMobile: null,
      siteSupervisorUserId: null,
    };

    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), OFFICE);

    expect(repo.calls.lastCreate?.bookedByUserId).toBeNull();
  });

  /* A portal booking still scopes to whoever actually made it. */
  it('does not let an order override a supervisor who booked it themselves', async () => {
    await jobService.create(draft({ purchaseOrderId: DOMAINE_ORDER.id }), SUPERVISOR);

    expect(repo.calls.lastCreate?.bookedByUserId).toBe(SUPERVISOR.userId);
    expect(repo.calls.lastCreate?.bookedBySource).toBe('portal');
  });
});

describe('a booking with no purchase order', () => {
  it('still uses the form’s own figures', async () => {
    await jobService.create(draft({ expectedAreaM2: 640, bagCount: 1 }), OFFICE);

    expect(quotedFor).toEqual([{ expectedAreaM2: 640, bagCount: 1 }]);
    expect(repo.calls.lastCreate?.purchaseOrderId).toBeNull();
  });

  /*
   * Zero from a form means "nobody has told us yet", which is the fixed-price
   * builder's normal case — not an area of nothing.
   */
  it('reads a zero area from the form as null, not as an empty job', async () => {
    await jobService.create(draft({ expectedAreaM2: 0 }), OFFICE);

    expect(quotedFor).toEqual([{ expectedAreaM2: null, bagCount: 0 }]);
  });

  it('keeps a typed PO number when there is no order to override it', async () => {
    await jobService.create(draft({ poNumber: 'VERBAL-4412' }), OFFICE);

    expect(repo.calls.lastCreate?.poNumber).toBe('VERBAL-4412');
  });
});

/* ── The picker ───────────────────────────────────────────────────────────── */

describe('the picker on the booking form', () => {
  it('marks an order that is already on a job rather than hiding it', async () => {
    taken.set(DOMAINE_ORDER.id, 61_412);

    const options = await jobService.purchaseOrders(account.id, undefined, OFFICE);

    const domaine = options.find((option) => option.id === DOMAINE_ORDER.id);
    const wisdom = options.find((option) => option.id === WISDOM_ORDER.id);

    /*
     * Returned, not filtered: "PO-88214 is on job 61,412" is the answer somebody
     * looking for it needs. Omitting it makes them think the extraction failed
     * and key the order in by hand.
     */
    expect(domaine?.usedByJobNumber).toBe(61_412);
    expect(wisdom?.usedByJobNumber).toBeNull();
  });

  it('carries the area through so the form can show what it will price on', async () => {
    const options = await jobService.purchaseOrders(account.id, undefined, OFFICE);

    expect(options.find((option) => option.id === DOMAINE_ORDER.id)?.expectedAreaM2).toBe(823.41);
    // Null, so the form can say "the order states a fixed price" rather than 0.
    expect(options.find((option) => option.id === WISDOM_ORDER.id)?.expectedAreaM2).toBeNull();
  });
});
