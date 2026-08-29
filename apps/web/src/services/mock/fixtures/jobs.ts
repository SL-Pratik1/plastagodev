import {
  PRE_START_ITEMS,
  RISK_CONTROLS,
  SITE_HAZARDS,
  requiresRiskAssessment,
  type Job,
  type JobCharge,
  type JobCompliance,
  type JobEvent,
  type JobListItem,
  type JobStatus,
  type Site,
} from '@plastago/shared';
import {
  ACCOUNTS,
  ACTIVE_DRIVERS,
  BAG_RATE_CENTS,
  CONTAMINATION_CENTS,
  EXTRA_LOAD_TIME_CENTS,
  FUTILE_CENTS,
  ZONE_RATES,
  buildSites,
  centsToMoney,
  createRng,
  intBetween,
  objectId,
  pick,
  type AccountFixture,
} from './reference';

/**
 * Job fixtures.
 *
 * ── Shape, not just volume ─────────────────────────────────────────────────
 * The generator reproduces the distribution the scope describes, because a
 * dashboard built on evenly-spread data hides everything that matters:
 *
 *  • **~7 jobs a day**, so daily volume and driver capacity look real.
 *  • **Five accounts carry most of the work** — the concentration is the
 *    business, and the reason the customer portal is a retention weapon.
 *  • **A small futile and contamination tail.** ~2 contamination charges a week
 *    at $90 is ~$9k/year flowing through the approvals queue, and the futile
 *    review queue only earns its ageing badges if something is actually old.
 *  • **Job numbers continue from ~61,300** (M1.4). Starting at 1 would
 *    misrepresent a system whose consignment numbers are quoted in builders' AP
 *    systems and on paid invoices.
 *  • **Some jobs sit unallocated and past target date**, so the board and the
 *    at-risk counter have something to show.
 */

const JOB_NUMBER_START = 61300;
const TOTAL_JOBS = 240;

const SITES = buildSites();

/** Weighted so the top five accounts dominate, as they do in production. */
const ACCOUNT_WEIGHTS: ReadonlyArray<{ account: AccountFixture; weight: number }> = ACCOUNTS.filter(
  (account) => account.status === 'active' && account.code !== 'PRE001',
).map((account) => ({
  account,
  weight: ['IPL001', 'CLA001', 'DOM001', 'FOR001', 'WIS001'].includes(account.code) ? 9 : 2,
}));

const WEIGHT_TOTAL = ACCOUNT_WEIGHTS.reduce((sum, entry) => sum + entry.weight, 0);

function weightedAccount(rng: () => number): AccountFixture {
  let roll = rng() * WEIGHT_TOTAL;
  for (const entry of ACCOUNT_WEIGHTS) {
    roll -= entry.weight;
    if (roll <= 0) return entry.account;
  }
  return ACCOUNT_WEIGHTS[0]?.account ?? ACCOUNTS[0]!;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/** M2.4a — target date is the customer's ready date plus 5 BUSINESS days. */
function addBusinessDays(base: Date, days: number): Date {
  const result = new Date(base);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

function atTime(date: Date, hour: number, minute: number): string {
  const stamp = new Date(date);
  stamp.setHours(hour, minute, 0, 0);
  return stamp.toISOString();
}

/** Status chosen from how far the ready date is from today. */
function statusForOffset(rng: () => number, offset: number): JobStatus {
  if (offset > 1) return rng() > 0.45 ? 'booked' : 'assigned';
  if (offset >= 0) {
    const roll = rng();
    if (roll < 0.2) return 'booked';
    if (roll < 0.45) return 'assigned';
    if (roll < 0.6) return 'acknowledged';
    if (roll < 0.72) return 'in-transit';
    if (roll < 0.84) return 'arrived';
    return 'completed';
  }
  if (offset >= -2) {
    const roll = rng();
    if (roll < 0.08) return 'assigned';
    if (roll < 0.72) return 'completed';
    if (roll < 0.92) return 'admin-complete';
    return 'futile';
  }
  const roll = rng();
  if (roll < 0.62) return 'admin-complete';
  if (roll < 0.9) return 'completed';
  if (roll < 0.965) return 'futile';
  return 'cancelled';
}

const TERMINAL: readonly JobStatus[] = ['completed', 'admin-complete', 'futile', 'cancelled'];

interface Built {
  jobs: Job[];
  sites: Site[];
}

function build(): Built {
  const rng = createRng(19870425);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const jobs: Job[] = [];

  for (let index = 0; index < TOTAL_JOBS; index += 1) {
    const jobNumber = JOB_NUMBER_START + index;
    const id = objectId('jb', index + 1);

    // Spread across ~11 weeks behind and a little over a week ahead.
    const offset = Math.round(-74 + (index / TOTAL_JOBS) * 82 + (rng() - 0.5) * 4);
    const readyDate = addDays(today, offset);
    const targetDate = addBusinessDays(readyDate, 5);

    const account = weightedAccount(rng);
    const accountSites = SITES.filter((site) => site.accountId === account.id);
    const site = accountSites.length > 0 ? pick(rng, accountSites) : SITES[0]!;

    let status = statusForOffset(rng, offset);
    const isTerminal = TERMINAL.includes(status);

    // A handful of deliberate stragglers: still unallocated and already past
    // target date, so the at-risk counter and the board highlight have data.
    if (!isTerminal && offset < -3 && rng() > 0.55) status = 'booked';

    const driver = status === 'booked' || status === 'cancelled' ? null : pick(rng, ACTIVE_DRIVERS);

    const expectedAreaM2 = intBetween(rng, 120, 1850);
    const bagCount = rng() > 0.45 ? intBetween(rng, 1, 4) : 0;
    const zone = site.zone;
    const rates = ZONE_RATES[zone];

    const isFutile = status === 'futile';
    const captureWeight = account.captureMode === 'area-and-weight';
    const completed = status === 'completed' || status === 'admin-complete';

    // ── Charges ───────────────────────────────────────────────────────────
    const charges: JobCharge[] = [];
    let chargeIndex = 0;
    const addCharge = (charge: Omit<JobCharge, 'id'>) => {
      chargeIndex += 1;
      charges.push({ ...charge, id: objectId('ch', index * 20 + chargeIndex) });
    };

    const raisedAt = atTime(readyDate, 8, 5);

    if (isFutile) {
      // M4.6 — either way the $120 futile fee applies.
      addCharge({
        code: 'futile-pickup',
        description: 'Futile pickup',
        quantity: 1,
        unitRate: centsToMoney(FUTILE_CENTS),
        amount: centsToMoney(FUTILE_CENTS),
        source: 'driver',
        approvalState: rng() > 0.3 ? 'approved' : 'pending',
        raisedBy: driver?.name ?? null,
        raisedAt,
        photoCount: intBetween(rng, 2, 4),
        note: 'Photographed on arrival.',
      });
    } else if (status !== 'cancelled') {
      addCharge({
        code: 'service-fee',
        description: `Service fee — ${zone === 'sydney' ? 'Sydney' : zone === 'wollongong' ? 'Wollongong' : 'Newcastle'}`,
        quantity: 1,
        unitRate: centsToMoney(rates.serviceCents),
        amount: centsToMoney(rates.serviceCents),
        source: 'office',
        approvalState: 'not-required',
        raisedBy: null,
        raisedAt,
        photoCount: 0,
        note: null,
      });

      addCharge({
        code: 'area-charge',
        description: 'Weight charge (per m²)',
        quantity: expectedAreaM2,
        unitRate: centsToMoney(rates.perM2Cents),
        amount: centsToMoney(expectedAreaM2 * rates.perM2Cents),
        source: 'office',
        approvalState: 'not-required',
        raisedBy: null,
        raisedAt,
        photoCount: 0,
        note: null,
      });

      if (bagCount > 0) {
        addCharge({
          code: 'recycling-bags',
          description: 'Recycling bags',
          quantity: bagCount,
          unitRate: centsToMoney(BAG_RATE_CENTS),
          amount: centsToMoney(bagCount * BAG_RATE_CENTS),
          source: 'office',
          approvalState: 'not-required',
          raisedBy: null,
          raisedAt,
          photoCount: 0,
          note: null,
        });
      }

      /*
       * ── Why approval state is decided by index, not by the PRNG ──────────
       * These two charge types feed two connected queues: the pending ones sit
       * in approvals (M2.7) and the approved ones on PO-required accounts move
       * on to awaiting-PO (M7.3). A random draw for each meant the second queue
       * could come out empty on a given seed — and an empty screen in a demo
       * reads as an unbuilt screen, not as a clear queue.
       *
       * Deciding by `index` guarantees both populations exist while keeping the
       * split the scope describes: most contamination charges do get approved,
       * and *"several are currently weeks old and unapproved"*.
       */

      // ~2 contamination charges a week across the fleet — ~$9k/year (M2.7).
      if (completed && rng() > 0.9) {
        addCharge({
          code: 'contamination',
          description: 'Contamination charge',
          quantity: 1,
          unitRate: centsToMoney(CONTAMINATION_CENTS),
          amount: centsToMoney(CONTAMINATION_CENTS),
          source: 'driver',
          approvalState: index % 3 === 0 ? 'pending' : 'approved',
          raisedBy: driver?.name ?? null,
          raisedAt: atTime(readyDate, 10, 40),
          photoCount: intBetween(rng, 1, 3),
          note: pick(rng, ['Timber offcuts through the bag', 'Insulation mixed in', 'Wet board']),
        });
      }

      // System-generated: fractional quantity, exactly as it arrives today.
      // M2.7 puts extra load time in the approval queue alongside
      // contamination, so it is approvable rather than permanently pending.
      if (completed && rng() > 0.9) {
        const hours = Number((1 + rng() * 3).toFixed(2));
        addCharge({
          code: 'extra-load-time',
          description: 'Extra load time',
          quantity: hours,
          unitRate: centsToMoney(EXTRA_LOAD_TIME_CENTS),
          amount: centsToMoney(Math.round(hours * EXTRA_LOAD_TIME_CENTS)),
          source: 'system',
          approvalState: index % 4 === 0 ? 'pending' : 'approved',
          raisedBy: null,
          raisedAt: atTime(readyDate, 12, 15),
          photoCount: 0,
          note: 'Auto-generated from on-site duration.',
        });
      }

      if (account.code === 'WIS001') {
        addCharge({
          code: 'fuel-levy-wisdom',
          description: 'Fuel levy — Wisdom',
          quantity: 1,
          unitRate: centsToMoney(2000),
          amount: centsToMoney(2000),
          source: 'office',
          approvalState: 'not-required',
          raisedBy: null,
          raisedAt,
          photoCount: 0,
          note: null,
        });
      }
    }

    const subtotalCents = charges.reduce(
      (sum, charge) => sum + Math.round(Number(charge.amount) * 100),
      0,
    );
    const gstCents = Math.round(subtotalCents / 10);

    // ── Timeline ──────────────────────────────────────────────────────────
    const events: JobEvent[] = [];
    let eventIndex = 0;
    const addEvent = (
      label: string,
      actor: string,
      at: string,
      eventStatus: JobStatus | null,
      detail: string | null = null,
      geo = false,
    ) => {
      eventIndex += 1;
      events.push({
        id: objectId('ev', index * 20 + eventIndex),
        at,
        label,
        actor,
        status: eventStatus,
        detail,
        latitude: geo ? site.latitude : null,
        longitude: geo ? site.longitude : null,
      });
    };

    addEvent('Job created', 'Priya Raman', atTime(addDays(readyDate, -3), 9, 20), 'booked');

    const order: JobStatus[] = [
      'assigned',
      'acknowledged',
      'in-transit',
      'arrived',
      'completed',
      'admin-complete',
    ];
    const reachedIndex = order.indexOf(status);

    if (status !== 'booked' && status !== 'cancelled') {
      const labels: Record<string, string> = {
        assigned: 'Allocated to driver',
        acknowledged: 'Driver acknowledged',
        'in-transit': 'En route',
        arrived: 'Arrived on site',
        completed: 'Job completed',
        'admin-complete': 'Administration complete',
      };
      const hours = [7, 7, 8, 9, 10, 15];

      const stopAt = isFutile ? order.indexOf('arrived') : reachedIndex;
      for (let step = 0; step <= stopAt && step < order.length; step += 1) {
        const stage = order[step];
        if (!stage) continue;
        addEvent(
          labels[stage] ?? stage,
          step === 0 ? 'Dean Kelly' : (driver?.name ?? 'Driver'),
          atTime(readyDate, hours[step] ?? 12, intBetween(rng, 0, 55)),
          stage,
          null,
          step >= 1,
        );
      }
    }

    const exceptionReason = isFutile
      ? pick(rng, [
          'site-not-ready',
          'access-blocked',
          'crane-unavailable',
          'nobody-on-site',
          'site-closed',
        ] as const)
      : null;

    if (isFutile) {
      addEvent(
        'Marked futile',
        driver?.name ?? 'Driver',
        atTime(readyDate, 9, 21),
        'futile',
        'Reason and photos captured on site',
        true,
      );
    }

    if (status === 'cancelled') {
      addEvent(
        'Job cancelled',
        'Priya Raman',
        atTime(addDays(readyDate, -1), 14, 5),
        'cancelled',
        'Customer request',
      );
    }

    // ── Invoice state (M7.2 two-invoice workflow) ─────────────────────────
    //
    // This is the BASE purchase order, the one the job itself was booked
    // against. The additional charges need their own, separate PO — that
    // second one lives on the additional-charges invoice, not here, which is
    // the whole reason cash for the pickup is never held up by it.
    const poNumber =
      account.poPolicy === 'required-before-invoice' && rng() > 0.25
        ? `${String(intBetween(rng, 29910000, 29919999))}/${String(intBetween(rng, 100, 999))}`
        : null;

    const pendingCharges = charges.some((charge) => charge.approvalState === 'pending');

    /*
     * ── Why awaiting-PO keys off APPROVED extras, not pending ones ────────
     * M7.3 is the queue for charges the customer has already agreed to and the
     * office has already approved — the only thing missing is the purchase
     * order to bill them against. A pending charge is not waiting for a PO, it
     * is waiting for a human, and that is M2.7's queue.
     *
     * Keying this off `pendingCharges` (as an earlier revision did) made the two
     * conditions mutually exclusive with the invoice projection in `store.ts`,
     * which only emits an additional-charges invoice for APPROVED extras — so
     * the awaiting-PO queue could never contain anything, while the dashboard
     * tile counted jobs and showed a number. Two views of one fact, disagreeing.
     */
    const awaitingPo =
      completed &&
      account.poPolicy === 'required-before-invoice' &&
      charges.some((charge) => charge.source !== 'office' && charge.approvalState === 'approved');

    let invoiceStatus: JobListItem['invoiceStatus'] = 'not-invoiced';
    if (status === 'admin-complete') invoiceStatus = rng() > 0.35 ? 'paid' : 'invoiced';
    else if (completed) invoiceStatus = 'invoiced';
    if (awaitingPo) invoiceStatus = 'awaiting-po';

    // The base invoice still went out — awaiting-PO describes the SECOND
    // invoice, and cash for the pickup itself is never held up by it (M7.2).
    const invoiced = completed;
    const onSiteMinutes =
      status === 'completed' || status === 'admin-complete' ? intBetween(rng, 22, 190) : null;

    jobs.push({
      id,
      jobNumber,
      status,
      brandId: account.brandId,
      accountId: account.id,
      accountName: account.name,
      builderName: site.builderName,
      siteId: site.id,
      siteName: site.name,
      suburb: site.suburb,
      zone,
      customerReference: rng() > 0.2 ? `REF-${String(intBetween(rng, 10000, 99999))}` : null,
      poNumber,
      readyDate: isoDate(readyDate),
      targetDate: isoDate(targetDate),
      serviceLevel: rng() > 0.88 ? 'urgent' : 'standard',
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      expectedAreaM2,
      recoveredWeightKg:
        captureWeight && completed ? Math.round(expectedAreaM2 * 0.068 * 9.5) : null,
      bagCount,
      totalExGst: centsToMoney(subtotalCents),
      invoiceStatus,
      hasPendingCharges: pendingCharges,
      completedAt: completed ? atTime(readyDate, 10, 30) : null,
      createdAt: atTime(addDays(readyDate, -3), 9, 20),

      freightItem: bagCount > 0 ? 'plasterboard-bagged' : 'plasterboard-hand-load',
      notes: pick(rng, [
        '',
        'Board stacked behind the garage.',
        'Second pickup for this lot.',
        'Supervisor asked for a call 30 minutes out.',
      ]),
      exceptionReason,
      exceptionNote: isFutile ? 'Driver attended; job was not ready.' : null,
      arrivedAt: onSiteMinutes !== null ? atTime(readyDate, 9, 15) : null,
      onSiteMinutes,
      charges,
      events,
      photos: completed
        ? Array.from({ length: intBetween(rng, 8, 14) }, (_, photoIndex) => ({
            id: objectId('ph', index * 30 + photoIndex),
            caption: [
              'Front of site',
              'Pile before',
              'Pile after',
              'Site closed',
              'Cars still on site',
            ][photoIndex % 5]!,
            takenAt: atTime(readyDate, 9, 20 + photoIndex),
            takenBy: driver?.name ?? 'Driver',
            latitude: site.latitude,
            longitude: site.longitude,
          }))
        : isFutile
          ? // M2.6 — a futile pickup arrives in the review queue WITH evidence.
            // The scope's own example: "arrived 09:14, marked futile at 09:21
            // with reason and two photos". Without them the queue is one
            // person's word against another's, which is why the charge sticks
            // today only when someone remembers to look.
            ['Site on arrival', 'Board not bagged'].map((caption, photoIndex) => ({
              id: objectId('ph', index * 30 + photoIndex),
              caption,
              takenAt: atTime(readyDate, 9, 18 + photoIndex),
              takenBy: driver?.name ?? 'Driver',
              latitude: site.latitude,
              longitude: site.longitude,
            }))
          : [],
      documents:
        account.poPolicy === 'required-before-invoice' && rng() > 0.4
          ? [
              {
                id: objectId('dc', index + 1),
                name: 'Purchase order.pdf',
                kind: 'purchase-order' as const,
                uploadedAt: atTime(addDays(readyDate, -2), 16, 47),
                uploadedBy: 'Priya Raman',
                sizeKb: intBetween(rng, 60, 480),
              },
            ]
          : [],
      /*
       * Three threads on one job (M2.11, M8.6).
       *
       * The driver thread is a two-message exchange rather than a single note,
       * because the whole point of M8.6 is that it is a *conversation* between
       * the office and the driver — W102 is "communicate with drivers", not
       * "leave a note for drivers". A one-sided thread would not show whether
       * the shape works.
       */
      comments: [
        ...(rng() > 0.7
          ? [
              {
                id: objectId('cm', index + 1),
                body: pick(rng, [
                  'Supervisor confirmed the board is stacked and accessible.',
                  'Customer asked to move this to next week — awaiting confirmation.',
                  'Second bag added on site, charge raised.',
                ]),
                author: pick(rng, ['Priya Raman', 'Dean Kelly', 'Renee Alvarez']),
                at: atTime(addDays(readyDate, -1), 11, 12),
                visibility: rng() > 0.5 ? ('internal' as const) : ('customer' as const),
                deliveredAt: null,
                fromDriver: false,
              },
            ]
          : []),
        ...(driver && rng() > 0.72
          ? [
              {
                id: objectId('cm', 5000 + index),
                body: pick(rng, [
                  'Gate code is 4417 — the supervisor is on site from 7am.',
                  'Take the second entrance off the roundabout, the main gate is fenced off.',
                  'Customer says the board is behind the garage, not out front.',
                ]),
                author: 'Dean Kelly',
                at: atTime(readyDate, 6, 40),
                visibility: 'driver' as const,
                deliveredAt: atTime(readyDate, 6, 41),
                fromDriver: false,
              },
              {
                id: objectId('cm', 6000 + index),
                body: pick(rng, [
                  'Got it, thanks. Heading there after the Oran Park drop.',
                  'No worries — will call the supervisor when I am 20 out.',
                  'Found it. Bigger load than the booking says, will confirm on site.',
                ]),
                author: driver.name,
                at: atTime(readyDate, 7, 5),
                visibility: 'driver' as const,
                deliveredAt: atTime(readyDate, 7, 5),
                fromDriver: true,
              },
            ]
          : []),
      ],
      invoiceNumber: invoiced ? 104100 + index : null,
      invoicedAt: invoiced ? atTime(addDays(readyDate, 1), 16, 0) : null,
      gst: centsToMoney(gstCents),
      totalIncGst: centsToMoney(subtotalCents + gstCents),
      compliance: buildCompliance({
        rng,
        index,
        readyDate,
        driverName: driver?.name ?? null,
        vehicleRego: driver?.vehicleRego ?? null,
        reachedSite: onSiteMinutes !== null,
        riskAssessmentRequired: requiresRiskAssessment(
          account.riskAssessmentRequired,
          site.riskAssessmentOverride,
        ),
      }),
    });
  }

  return { jobs, sites: SITES };
}

/**
 * M4.8 — the safety record the office reads back on a job.
 *
 * ── Why the shapes here are deliberately uneven ───────────────────────────
 * Both records are nullable, and they are null for DIFFERENT reasons that the
 * compliance screen has to be able to tell apart:
 *
 *  • `preStart` is null on a job whose driver never started a run — nothing was
 *    skipped, the day simply has not happened.
 *  • `riskAssessment` is null on a job that never needed one, AND on one that
 *    needed one and did not get it. Only the second is a gap, which is why
 *    `riskAssessmentRequired` sits beside it rather than being inferred from
 *    the record's presence.
 *
 * ── The distribution is chosen to make the gaps reachable ─────────────────
 * A fixture set where every required assessment was completed would render a
 * screen of green ticks that nobody could tell apart from a screen with no
 * checking behind it. So roughly one in eight required assessments is missing,
 * one in nine is marked unsafe, and a fraction of pre-starts carry a failed
 * item — the states the office actually has to act on.
 */
function buildCompliance(input: {
  rng: () => number;
  index: number;
  readyDate: Date;
  driverName: string | null;
  vehicleRego: string | null;
  reachedSite: boolean;
  riskAssessmentRequired: boolean;
}): JobCompliance {
  const { rng, readyDate, driverName, vehicleRego, reachedSite, riskAssessmentRequired } = input;

  // No driver allocated yet means no run, so neither record can exist.
  if (driverName === null) {
    return { riskAssessmentRequired, riskAssessment: null, preStart: null };
  }

  /*
   * The pre-start belongs to the RUN, not the job — one check covers every stop
   * that driver makes that day. It is copied onto each job because the question
   * "was this truck checked before it came to my site" is asked of the job, and
   * an auditor should not have to reconstruct which run it belonged to.
   */
  const failedItem = rng() > 0.88 ? pick(rng, [...PRE_START_ITEMS]) : null;
  const preStart = {
    completedAt: atTime(readyDate, 5, 40 + Math.floor(rng() * 35)),
    driverName,
    vehicleRego: vehicleRego ?? '',
    odometerKm: intBetween(rng, 180000, 460000),
    failedItems:
      failedItem === null
        ? []
        : [
            {
              key: failedItem.key,
              label: failedItem.label,
              note: pick(rng, [
                'Worn to the bars on the nearside rear.',
                'Beacon flickers when the engine is cold.',
                'Park brake needs a hard pull to hold.',
                'Strap frayed about a third of the way along.',
              ]),
            },
          ],
    itemsChecked: PRE_START_ITEMS.length,
  };

  // The assessment is filled in ON ARRIVAL, so a job the driver never reached
  // cannot have one — and is not a gap either.
  if (!riskAssessmentRequired || !reachedSite) {
    return { riskAssessmentRequired, riskAssessment: null, preStart };
  }

  // The gap the screen exists to surface: required, arrived, never filled in.
  if (rng() > 0.88) {
    return { riskAssessmentRequired, riskAssessment: null, preStart };
  }

  const safeToProceed = rng() > 0.11;
  const hazardPool = SITE_HAZARDS.filter((hazard) => hazard.key !== 'no-hazards');
  const hazards =
    rng() > 0.75
      ? ['No significant hazards identified']
      : [pick(rng, hazardPool).label, pick(rng, hazardPool).label];

  return {
    riskAssessmentRequired,
    preStart,
    riskAssessment: {
      completedAt: atTime(readyDate, 9, 20 + Math.floor(rng() * 25)),
      driverName,
      // De-duplicated: picking twice from the same pool can land on one hazard,
      // and a list that says "Uneven ground, Uneven ground" reads as a bug.
      hazards: [...new Set(hazards)],
      controls: safeToProceed
        ? [...new Set([pick(rng, RISK_CONTROLS).label, pick(rng, RISK_CONTROLS).label])]
        : ['Work stopped — unsafe to proceed'],
      note: safeToProceed
        ? pick(rng, ['', '', 'Kept the truck on the road side, slab still green.'])
        : 'Powerlines directly over the only crane position. Rang the office.',
      safeToProceed,
      swmsVersion: 'SWMS-2026.1',
      // Null where the site has no QR sign on the fence — a real and common case.
      builderPortalCode: rng() > 0.3 ? `SITE-${String(intBetween(rng, 10000, 99999))}` : null,
      /*
       * The upload is the one step that talks to SOMEBODY ELSE'S system, so it
       * is the step that fails. `queued` is the offline case — the driver was at
       * a fence with no signal, which is the normal way this starts.
       */
      uploadState: safeToProceed
        ? pick(rng, ['uploaded', 'uploaded', 'uploaded', 'queued', 'failed'] as const)
        : 'uploaded',
    },
  };
}

const built = build();

export const JOBS: readonly Job[] = built.jobs;
export const SITE_FIXTURES: readonly Site[] = built.sites;

/** The grid projection. A list must never need a join to render. */
export function toListItem(job: Job): JobListItem {
  const {
    freightItem: _freightItem,
    notes: _notes,
    exceptionReason: _exceptionReason,
    exceptionNote: _exceptionNote,
    arrivedAt: _arrivedAt,
    onSiteMinutes: _onSiteMinutes,
    charges: _charges,
    events: _events,
    photos: _photos,
    documents: _documents,
    comments: _comments,
    invoiceNumber: _invoiceNumber,
    invoicedAt: _invoicedAt,
    gst: _gst,
    totalIncGst: _totalIncGst,
    compliance: _compliance,
    ...listItem
  } = job;
  return listItem;
}

export const JOB_LIST: readonly JobListItem[] = JOBS.map(toListItem);
