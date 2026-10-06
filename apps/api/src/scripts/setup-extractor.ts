import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { wireExtractor } from '../domains/extractor/extractor.service.js';
import { extractorClient } from '../integrations/extractor.js';
import { logger } from '../lib/logger.js';
import { FIELD_KEYS } from '../domains/queues/po-ingest.adapter.js';

const log = logger.child({ script: 'setup-extractor' });

/**
 * One-time setup for the purchase-order extractor (I6 · M2.12).
 *
 * ── What this does, and why it is a script rather than a migration ────────
 * It creates two things at the vendor: the document TEMPLATE that says which
 * fields to read off a purchase order, and the WEBHOOK that tells us a document
 * is ready. Both live in the vendor's tenant, not in our database, so neither
 * belongs in a schema migration.
 *
 * Safe to re-run. The template is matched by name and updated in place, and the
 * webhook by URL — so changing a field description is one edit here and one run,
 * not a second template competing with the first.
 *
 *   npm run setup:extractor -w @plastago/api
 *
 * ── Onboarding is deliberately separate ───────────────────────────────────
 * `--onboard` creates the tenant and prints an embed token that the vendor shows
 * ONCE. It is a different act from configuring a template, and running it twice
 * by accident should not be possible just because somebody wanted to add a
 * field. So it is opt-in, and it refuses if a token is already configured.
 */

/**
 * The template.
 *
 * ── Why the descriptions are this specific ────────────────────────────────
 * They are the prompt. A field described as "the total" reads the largest number
 * on the page, and on both sample orders that is the GST-INCLUSIVE total — while
 * the figure the contract wants is the exclusive one printed above it. Every
 * description below is written against a failure seen on a real document.
 */
const TEMPLATE_NAME = 'PlastaGo Purchase Order';

const TEMPLATE_FIELDS = [
  {
    id: '1',
    key: FIELD_KEYS.poNumber,
    type: 'String',
    description:
      'The purchase order number, exactly as printed including any dots, slashes or suffix. Examples: "208918.321.01", "79904106/082". It is usually labelled "Purchase Order No.", "Order Number" or "PO Number". Do NOT return the builder\'s internal job number, client number or estimate number.',
  },
  {
    id: '2',
    key: FIELD_KEYS.builderName,
    type: 'String',
    description:
      'The building company that ISSUED this order, as named in its LOGO or letterhead at the top of page one. Examples: "Wisdom Homes", "Domaine Homes (NSW) Pty Ltd". Use the trading name shown in the logo, NOT a legal entity named only in the terms and conditions — on a Wisdom order return "Wisdom Homes", never "Wisdom Properties Group Pty Ltd", and never the job group heading such as "Spec Homes". CRITICAL: this is NOT the vendor. Never return "PlastaGo", "Plasta-Go", "PLASTA GO", "Plasta Go Pty Ltd" or "EasyLift" — those are the supplier being ordered from. Also never return the homebuyer or client name.',
  },
  {
    id: '3',
    key: FIELD_KEYS.orderDate,
    type: 'Date',
    description:
      'The order date. Australian documents use DAY/MONTH/YEAR: "22/07/2026" is 22 July 2026, not 7 February. Return ISO format YYYY-MM-DD.',
  },
  {
    id: '4',
    key: FIELD_KEYS.lotNumber,
    type: 'String',
    description:
      'The lot number of the building site, digits only. Labelled "Lot:" or appearing as "Lot 914". Examples: "959", "914". In a new estate the lot is how the site is identified on the ground, so it matters more than the street number.',
  },
  {
    id: '5',
    key: FIELD_KEYS.siteAddress,
    type: 'String',
    description:
      'The street address of the building site — the street number and name only, without the suburb, state or postcode. Examples: "Somervaille Dr", "(#10) Broadmeadow way". Take the SITE or JOB address, never the vendor\'s postal address and never the builder\'s head office.',
  },
  {
    id: '6',
    key: FIELD_KEYS.suburb,
    type: 'String',
    description:
      'The suburb of the building SITE, on its own with no state or postcode. Examples: "CATHERINE FIELD", "EDGEWORTH". Take it from the site or job address block, not from the letterhead and not from the vendor address.',
  },
  {
    id: '7',
    key: FIELD_KEYS.postcode,
    type: 'String',
    description:
      'The four-digit postcode of the building SITE. Examples: "2557", "2285". Not the builder\'s postcode and not the vendor\'s.',
  },
  {
    id: '8',
    key: FIELD_KEYS.areaM2,
    type: 'Number',
    description:
      'The plasterboard area in square metres, from the line item priced per m². On a line reading "Plasterboard waste pickup & recycle - Weight Charge  823.41  m2  0.20" the answer is 823.41. Return the QUANTITY, never the rate or the amount. Return null if no line is priced per m² — many builders are on a fixed price and genuinely do not state an area. A missing value is correct in that case; do not guess one from the total.',
  },
  {
    id: '9',
    key: FIELD_KEYS.bagAllowance,
    type: 'Number',
    description:
      'How many bulka bags the order allows, from the quantity on the bag line item. On "Bulka Bag (500m2 plasterboard per bag)  2.00  Each  30.00" the answer is 2. Return the quantity of bags, not the 500 in the description and not the unit price. Return null if there is no bag line.',
  },
  {
    id: '10',
    key: FIELD_KEYS.supervisorName,
    type: 'String',
    description:
      'The name of the person supervising the site. Labelled "Supervisor:", "Site Manager:" or "Site Supervisor:" — the label varies by builder. Examples: "David Luc", "Mathew French". Return the name only, without the phone number. Do NOT return the Estimator, the Order Issued By name, or the client contact.',
  },
  {
    id: '11',
    key: FIELD_KEYS.supervisorMobile,
    type: 'String',
    description:
      'The supervisor\'s mobile number, usually printed immediately after their name. Australian mobiles start with 04. Examples: "0411 601 227", "0427 821 430". Return digits and spaces only. Do not return the builder\'s head office or 1300 number.',
  },
  {
    id: '12',
    key: FIELD_KEYS.amountExGst,
    type: 'String',
    description:
      'The order total EXCLUDING GST, as a plain number with no currency symbol. This is the subtotal BEFORE GST is added — labelled "Net Order Value", or the subtotal above a "Plus GST" line. Examples: on an order showing "Net Order Value $474.68 / GST $47.47 / ORDER TOTAL (Incl GST) $522.15" the answer is "474.68". On one showing "$302.00 / Plus GST of $30.20 / $332.20" the answer is "302.00". CRITICAL: never return the GST-inclusive total, even where it is the largest and boldest figure on the page.',
  },
  {
    id: '13',
    key: FIELD_KEYS.documentText,
    type: 'String',
    description:
      'The plain text of the first page only, as printed. The office reads this beside the extracted fields to check them. Do not include the terms and conditions pages.',
  },
  {
    id: '14',
    key: 'line_items',
    type: 'List<Object>',
    description:
      'The priced line items from the order table. Only rows with a description and an amount — skip heading rows priced at 0.00 and skip the notes underneath a line.',
    children: [
      { id: '14a', key: 'description', type: 'String', description: 'The line item description as printed.' },
      { id: '14b', key: 'quantity', type: 'String', description: 'The quantity column.' },
      { id: '14c', key: 'unit', type: 'String', description: 'The unit column — "m2", "Each", "Item", "JB".' },
      { id: '14d', key: 'amount', type: 'String', description: 'The line amount, plain number, no currency symbol.' },
    ],
  },
  {
    id: '15',
    key: FIELD_KEYS.builderAbn,
    type: 'String',
    description:
      'The ABN of the building company that issued this order, from ITS letterhead — 11 digits. Examples: "82 089 425 829" (Wisdom Homes), "19 080 788 969" (Domaine Homes). CRITICAL: never return the ABN printed in the vendor / "TO" box — that is PlastaGo\'s own ABN (22 669 797 915). Return null if the builder prints no ABN.',
  },
] as const;

/**
 * The call-up template (M2.12b) — the builder's "when", a week out.
 *
 * Written against the client's real Domaine "Construction Notification": one
 * page, no prices, a supervisor block, "Job Details 79903057" and the site,
 * then "Date Required 17/09/2026". Keys match `call-up-ingest.adapter.ts`.
 *
 * ⚠️ The description says what it is NOT as loudly as what it is. The
 * extractor sorts every PDF in the mailbox into a template by itself, and a
 * call-up read as a purchase order lands in PO review as an order with no
 * area, no bags and no value.
 */
const CALL_UP_TEMPLATE_NAME = 'PlastaGo Call-up';

const CALL_UP_TEMPLATE_FIELDS = [
  {
    id: '1',
    key: 'po_number',
    type: 'String',
    description:
      'The builder\'s purchase order number, or — when the notice gives none — the JOB number it names. On a Domaine "Construction Notification" this is the number beside "Job Details", e.g. "79903057". Return it exactly as printed, including any slash or dots. Never return the Message ID, the supervisor number at the foot of the page, or a phone number.',
  },
  {
    id: '2',
    key: 'ready_date',
    type: 'Date',
    description:
      'The day the site is ready for pickup — labelled "Date Required", "Required Date", "Pick-up Date" or "Ready". Australian documents use DAY/MONTH/YEAR: "17/09/2026" is 17 September 2026. Return ISO format YYYY-MM-DD. Do NOT return the date the notice was sent, which is printed at the top right beside the time.',
  },
  {
    id: '3',
    key: 'notification_type',
    type: 'String',
    description:
      'What the notice asks for, as exactly one word: "new" for a new pickup or construction notification, "reschedule" if it moves a pickup already booked (words like rescheduled, date changed, moved, new date), or "cancel" if it cancels one.',
  },
  {
    id: '4',
    key: 'site_address',
    type: 'String',
    description:
      'The site as printed under the job details: lot, street, suburb, state and postcode. Example: "Lot 158, 49 Pastureland Street STREAM HILL NSW 2526". Never the builder\'s office address or PlastaGo\'s.',
  },
  {
    id: '5',
    key: 'note',
    type: 'String',
    description:
      'The job instructions, if any, as printed — e.g. "Please attend site and pick up excess Plasterboard for recycling." Include the supervisor\'s name and mobile if shown, as "Supervisor: Brett Cerchi 0418 166 800". Leave out the PlastaGo address block and page numbers.',
  },
] as const;

async function onboard(): Promise<void> {
  if (env.EXTRACTOR_EMBED_TOKEN) {
    throw new Error(
      'EXTRACTOR_EMBED_TOKEN is already set. Onboarding again would create a second tenant — ' +
        'remove the variable first if that is genuinely what you want.',
    );
  }

  const result = await extractorClient.onboard({
    organizationName: 'PlastaGo',
    firstName: 'PlastaGo',
    lastName: 'Platform',
    email: env.EXTRACTOR_USER_EMAIL ?? 'platform@plastago.com.au',
  });

  // eslint-disable-next-line no-console
  console.log(`
Onboarded. The embed token is shown ONCE — add it to apps/api/.env now:

  EXTRACTOR_EMBED_TOKEN=${result.embedToken}

Tenant id: ${result.tenantId}

Then re-run this script without --onboard to create the template.
`);
}

async function main(): Promise<void> {
  /*
   * ⚠️ Onboarding is checked BEFORE `enabled`, and the order matters.
   *
   * `EXTRACTOR_PROVIDER=threepm` requires an embed token — and the embed token
   * is what onboarding produces. Gating this path behind `enabled` would make
   * the first step of setup impossible to reach.
   *
   * It needs only the application credentials, which is why the client's
   * `onboard` does not go through the session-authenticated transport.
   */
  if (process.argv.includes('--onboard')) {
    if (!env.EXTRACTOR_APP_ID || !env.EXTRACTOR_APP_SECRET) {
      throw new Error(
        'Onboarding needs EXTRACTOR_APP_ID and EXTRACTOR_APP_SECRET in apps/api/.env ' +
          '(from the extractor Admin Dashboard → Applications).',
      );
    }
    await onboard();
    return;
  }

  /*
   * Everything past this point talks to the vendor as the tenant, and the
   * tenant's embed token lives in Mongo rather than in env. Connect before
   * wiring, and tolerate a failure: a laptop with no Mongo can still run this
   * against `EXTRACTOR_EMBED_TOKEN`, which is the client's own fallback.
   */
  try {
    await connectMongo();
    wireExtractor();
  } catch {
    log.warn('no database connection — falling back to EXTRACTOR_EMBED_TOKEN from env');
  }

  if (!extractorClient.enabled) {
    throw new Error(
      'EXTRACTOR_PROVIDER is not "threepm". Onboard first:\n\n' +
        '  npm run setup:extractor -w @plastago/api -- --onboard\n\n' +
        'then set EXTRACTOR_PROVIDER=threepm with the token it prints.',
    );
  }

  const existing = await extractorClient.listDocuments();

  /* ── The call-up template ─────────────────────────────────────────────── */

  const callUpMatch = existing.find((row) => row.name === CALL_UP_TEMPLATE_NAME);
  const callUpDocumentId = await extractorClient.upsertDocument({
    id: callUpMatch?.id ?? null,
    name: CALL_UP_TEMPLATE_NAME,
    description:
      'A builder\'s call-up — a "Construction Notification" or pickup notice asking PlastaGo to collect plasterboard from a site on a date. One page: a supervisor block, the job number and site address, the task and the date required. It is NOT a purchase order: it has no prices, no quantities, no line items and no order total.',
    fields: CALL_UP_TEMPLATE_FIELDS,
  });

  log.info({ documentId: callUpDocumentId, updated: callUpMatch !== undefined }, 'call-up template saved');

  /*
   * `--call-up-only` stops here: the purchase-order template and the webhook
   * are left exactly as they are, so adding call-ups cannot disturb the order
   * pipeline that is already live.
   */
  if (process.argv.includes('--call-up-only')) {
    // eslint-disable-next-line no-console
    console.log(`
Template "${CALL_UP_TEMPLATE_NAME}" ${callUpMatch ? 'updated' : 'created'} with ${String(CALL_UP_TEMPLATE_FIELDS.length)} fields.

Add this to apps/api/.env so call-up emails are routed to the call-up queue:

  EXTRACTOR_CALL_UP_DOCUMENT_ID=${callUpDocumentId}
`);
    return;
  }

  /* ── The purchase-order template ──────────────────────────────────────── */

  const match = existing.find((row) => row.name === TEMPLATE_NAME);

  const documentId = await extractorClient.upsertDocument({
    id: match?.id ?? null,
    name: TEMPLATE_NAME,
    description:
      'A plasterboard-recycling purchase order from an Australian residential builder. Two to three pages, the order table on page one and terms and conditions after it.',
    fields: TEMPLATE_FIELDS,
  });

  log.info({ documentId, updated: match !== undefined }, 'extractor template saved');

  /* ── The webhook ──────────────────────────────────────────────────────── */

  /*
   * Built from `AUTH_BASE_URL` because that is the origin the vendor has to be
   * able to reach — the same value the storage stub hands out. On a laptop it is
   * localhost, which the vendor cannot call; the script says so rather than
   * registering a callback that silently never fires.
   */
  const callbackUrl = `${env.AUTH_BASE_URL}/api/v1/webhooks/extractor?token=${encodeURIComponent(
    env.EXTRACTOR_WEBHOOK_SECRET ?? '',
  )}`;

  const reachable = !/localhost|127\.0\.0\.1/.test(env.AUTH_BASE_URL);

  if (reachable) {
    await extractorClient.ensureWebhook({
      name: 'PlastaGo purchase-order queue',
      url: callbackUrl,
      documentId,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`
Template "${TEMPLATE_NAME}" ${match ? 'updated' : 'created'} with ${String(TEMPLATE_FIELDS.length)} fields.
Template "${CALL_UP_TEMPLATE_NAME}" ${callUpMatch ? 'updated' : 'created'} with ${String(CALL_UP_TEMPLATE_FIELDS.length)} fields.

Add these to apps/api/.env so each document type reaches its own queue:

  EXTRACTOR_DOCUMENT_ID=${documentId}
  EXTRACTOR_CALL_UP_DOCUMENT_ID=${callUpDocumentId}

${
  reachable
    ? `Webhook registered:\n\n  ${callbackUrl.replace(/token=[^&]*/, 'token=***')}\n`
    : `⚠️  Webhook NOT registered — AUTH_BASE_URL is ${env.AUTH_BASE_URL}, which the
    extractor cannot reach from the internet. Either expose the API (ngrok,
    a deployed environment) and re-run this, or drive the pipeline by hand:

      curl -X POST "http://localhost:${String(env.PORT)}/api/v1/webhooks/extractor?token=$EXTRACTOR_WEBHOOK_SECRET" \\
        -H 'content-type: application/json' \\
        -d '{"extractionId":"<id from the extractor UI>"}'
`
}
Remaining setup, in the extractor's own UI:

  1. Connect the Microsoft 365 mailbox that receives purchase orders
     (Settings → Microsoft integrations). The extractor reads the mailbox —
     PlastaGo's own Graph registration only sends.
  2. Upload both sample purchase orders and check the extracted fields,
     especially amount_ex_gst and builder_name.
`);
}

await main()
  .catch((error: unknown) => {
    log.error({ error }, 'setup-extractor failed');
     
    console.error(`\n${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
