import { isValidAbn, DEFAULT_RATE_CARD_ID, PROTECTED_SERVICE_CODES } from '@plastago/shared';
import type {
  AdditionalServiceCreate,
  AdditionalServiceSetting,
  AdditionalServiceUpdate,
  RateCardCreate,
  RateCardSummary,
  RateCardUpdate,
  RateScheduleCreate,
  Role,
  Settings,
  ZoneCreate,
  ZoneRateInput,
  ZoneOrder,
  ZoneSummary,
  ZoneUpdate,
  InvoiceTemplate,
  InvoiceTemplateWrite,
  InvoicingSettings,
  Invoice,
  LogoUploadRequest,
  PresignedUpload,
  TemplatePreview,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { settingsRepository } from './settings.repository.js';
import { buildKey, getStorage, SETTINGS_OWNER } from '../../integrations/storage.js';
import { renderInvoicePdf } from '../../integrations/invoice-pdf.js';
import { invoiceRenderService } from '../invoices/invoice-render.service.js';
import { todayInSydney } from '../../lib/business-day.js';

const log = logger.child({ module: 'settings' });

/**
 * Settings (M2.4, M6).
 *
 * ── Why the rules live here and not in the form ───────────────────────────
 * The settings screen is the one place where a single wrong field changes how
 * every job afterwards behaves — a bank BSB with no account number prints an
 * invoice that gets paid into nothing, and a back-dated rate schedule reprices
 * work that has already been billed. The form validates for the person typing;
 * this validates for everyone downstream, and it is the only one of the two
 * that a script or a stale tab cannot skip.
 */

export interface Caller {
  roles: readonly Role[];
  accountId: string | null;
}

/**
 * Only two roles may write settings.
 *
 * Office staff read them constantly — the SLA and the rate card are on screen
 * while they book — so reading is open to signed-in staff. Writing is not:
 * these are platform-wide, and the blast radius of a mistake is every job.
 *
 * ⚠️ Invoicing is the only writable section left. Notification rules,
 * integration checks and the credential-type register were all removed: each
 * was a write nothing downstream ever read. See the note in `@plastago/shared`'s
 * settings schema for what replaced them, and what deliberately did not.
 */
const WRITERS = new Set<Role>(['super-admin', 'operations']);

/** Customers never see platform settings at all — their rates reach them via a quote. */
const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

export const settingsService = {
  async get(caller: Caller): Promise<Settings> {
    assertStaff(caller);
    return settingsRepository.get();
  },

  /**
   * M7 — invoicing.
   *
   * The bank fields are validated as a pair: an invoice that prints a BSB with
   * no account number gets paid into nothing, and the customer finds out weeks
   * later.
   */
  async saveInvoicing(input: InvoicingSettings, caller: Caller): Promise<Settings['invoicing']> {
    assertWriter(caller);

    const bsb = input.bankBsb.trim();
    const account = input.bankAccount.trim();

    if ((bsb === '') !== (account === '')) {
      throw AppError.validation('Bank details must be given together, or left blank together', [
        {
          path: bsb === '' ? 'bankBsb' : 'bankAccount',
          message: 'Both a BSB and an account number are needed to print payment details',
        },
      ]);
    }

    if (bsb !== '' && !/^\d{3}-?\d{3}$/.test(bsb)) {
      throw AppError.validation('That BSB does not look right', [
        { path: 'bankBsb', message: 'A BSB is six digits, e.g. 062-000' },
      ]);
    }

    /*
     * Bank details without an account NAME.
     *
     * Allowed but refused-by-default would be the wrong trade either way, so
     * this is a hard refusal: the payer's own banking software asks for the
     * account name, and an invoice that omits it generates a phone call on
     * every first payment from every new customer.
     */
    if (bsb !== '' && input.bankAccountName.trim() === '') {
      throw AppError.validation('Payment details need the account name too', [
        {
          path: 'bankAccountName',
          message: 'The name the account is held in — their bank will ask for it',
        },
      ]);
    }

    /*
     * ⚠️ An ABN is what makes this a TAX invoice.
     *
     * Under GST law a tax invoice over $82.50 must carry the supplier's ABN,
     * and a customer is entitled to withhold payment without one. Refused as
     * a pair with the company name for the same reason the bank fields are:
     * half a letterhead is worse than none, because it looks finished.
     */
    const abn = input.companyAbn.replace(/\s/g, '');
    if (abn !== '' && !/^\d{11}$/.test(abn)) {
      throw AppError.validation('That ABN does not look right', [
        { path: 'companyAbn', message: 'An ABN is eleven digits, e.g. 51 824 753 556' },
      ]);
    }

    /*
     * Eleven digits is a shape, not a check.
     *
     * ⚠️ This is the one ABN that appears on every tax invoice PlastaGo issues,
     * so a transposed digit here is wrong on all of them at once — and the
     * customer's accountant is who finds out. `11111111111` passed the length
     * test happily. Empty still saves: an ABN nobody has typed yet is a
     * half-configured letterhead, which the pairing rule below already covers.
     */
    if (abn !== '' && !isValidAbn(abn)) {
      throw AppError.validation('That is not a valid ABN', [
        { path: 'companyAbn', message: 'Check it on ABN Lookup — the digits do not add up' },
      ]);
    }

    if (input.companyName.trim() === '' && abn !== '') {
      throw AppError.validation('An ABN needs the name it belongs to', [
        { path: 'companyName', message: 'Which entity issues these invoices?' },
      ]);
    }

    await settingsRepository.saveInvoicing(input);
    const saved = await settingsRepository.get();
    return saved.invoicing;
  },

  /* ── The invoice logo (M7.5) ───────────────────────────────────────────── */

  /**
   * Somewhere to PUT the logo bytes.
   *
   * ── Why the key is not stored yet ─────────────────────────────────────────
   * ⚠️ Handing back a ticket is not the same as having a logo. If `logoKey`
   * were written here, an upload the browser then abandoned — a closed tab, a
   * dropped connection — would leave every invoice pointing at an object that
   * does not exist. The renderer degrades to text on a missing logo, so the
   * failure would be silent and permanent.
   *
   * So the client uploads first and confirms second, and until it confirms the
   * invoices keep the logo they had.
   */
  async presignLogo(input: LogoUploadRequest, caller: Caller): Promise<PresignedUpload> {
    assertWriter(caller);

    const key = buildKey({
      scope: 'settings',
      ownerId: SETTINGS_OWNER,
      kind: 'logo',
      contentType: input.contentType,
    });

    return getStorage().presignUpload({
      key,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });
  },

  /**
   * Confirm the bytes landed, and point the invoices at them.
   *
   * ⚠️ The object is READ back before it is accepted. A key that 404s means the
   * PUT never completed, and storing it would replace a working logo with a
   * blank space on every invoice from then on — so a failed upload leaves the
   * previous one exactly where it was.
   */
  async confirmLogo(key: string, caller: Caller): Promise<string | null> {
    assertWriter(caller);

    /*
     * The key came back from a client, so the path it names is checked.
     *
     * ⚠️ Matched on the LOGO segment specifically, not merely on `settings`.
     * The looser test admitted `settings/singleton/template-preview/…`, which
     * is a PDF — and a PDF stored as the logo fails to embed, so the renderer
     * would fall back to text and every invoice would quietly lose its mark
     * with nothing reporting an error. Found in QA by reading the two key
     * shapes side by side.
     *
     * Anchored with the separator on both sides so a crafted key cannot smuggle
     * the segment in as part of a longer name.
     */
    if (!LOGO_KEY_SEGMENT.test(key)) {
      throw AppError.validation('That is not an invoice logo', [
        { path: 'key', message: 'Upload the logo again' },
      ]);
    }

    try {
      await getStorage().get(key);
    } catch {
      throw AppError.validation('The logo did not finish uploading', [
        { path: 'key', message: 'Try the upload again' },
      ]);
    }

    const previous = await settingsRepository.logoKey();
    await settingsRepository.setLogoKey(key);

    /*
     * The old object is removed only AFTER the new one is stored. The other
     * order leaves a window where the invoices have no logo at all, and a
     * failure inside it makes that permanent.
     */
    if (previous !== '' && previous !== key) await removeQuietly(previous);

    log.info({ key }, 'invoice logo updated');
    return (await settingsRepository.get()).invoicing.logoUrl;
  },

  /** Take the logo off the invoices. They fall back to the company name in text. */
  async removeLogo(caller: Caller): Promise<void> {
    assertWriter(caller);

    const previous = await settingsRepository.logoKey();
    if (previous === '') return;

    await settingsRepository.setLogoKey('');
    await removeQuietly(previous);

    log.info('invoice logo removed');
  },

  /* ── Invoice templates (M7.5) ──────────────────────────────────────────── */

  async createInvoiceTemplate(
    input: InvoiceTemplateWrite,
    caller: Caller,
  ): Promise<InvoiceTemplate> {
    assertWriter(caller);

    const id = slugify(input.name);
    if (id === '') {
      throw AppError.validation('That name cannot be turned into an id', [
        { path: 'name', message: 'Use at least one letter or digit' },
      ]);
    }

    if (await settingsRepository.findInvoiceTemplate(id)) {
      throw AppError.conflict(`A template with the id "${id}" already exists`);
    }

    await settingsRepository.createInvoiceTemplate(id, input);
    log.info({ templateId: id, layout: input.layout }, 'invoice template created');

    return findTemplateOrThrow(id);
  },

  async updateInvoiceTemplate(
    id: string,
    input: InvoiceTemplateWrite,
    caller: Caller,
  ): Promise<InvoiceTemplate> {
    assertWriter(caller);

    if (!(await settingsRepository.findInvoiceTemplate(id))) {
      throw AppError.notFound(`No invoice template is configured for "${id}"`);
    }

    /*
     * ⚠️ Editing a template does NOT change any invoice already sent.
     *
     * `invoices.templateName` is frozen at render time, and the PDF itself is
     * stored. So renaming or recolouring here affects the NEXT invoice only —
     * which is what makes this safe to expose at all.
     */
    await settingsRepository.updateInvoiceTemplate(id, input);
    log.info({ templateId: id }, 'invoice template updated');

    return findTemplateOrThrow(id);
  },

  /**
   * Retire a template.
   *
   * Refused while any account names it: the account would fall back to its
   * brand default silently, and "why does this builder's invoice suddenly
   * look different?" is a question nobody would connect to a settings change
   * made weeks earlier.
   */
  async deleteInvoiceTemplate(id: string, caller: Caller): Promise<void> {
    assertWriter(caller);

    const existing = await settingsRepository.findInvoiceTemplate(id);
    if (!existing) throw AppError.notFound(`No invoice template is configured for "${id}"`);

    const assigned = await settingsRepository.countAccountsOnTemplate(id);
    if (assigned > 0) {
      throw AppError.conflict(
        `${String(assigned)} account${assigned === 1 ? '' : 's'} still invoice on this template. Move them to another one first.`,
      );
    }

    await settingsRepository.deleteInvoiceTemplate(id);
    log.info({ templateId: id }, 'invoice template deleted');
  },

  /**
   * M7.5 — draw one template with invented figures, so it can be looked at.
   *
   * ── Why this exists ───────────────────────────────────────────────────────
   * ⚠️ Until now a template was chosen blind: an administrator picked a layout
   * and typed a hex colour, and the first rendering anybody ever saw was on a
   * real invoice already on its way to a builder. Getting it wrong was not
   * recoverable — a sent invoice cannot be unsent.
   *
   * ── Why the figures are invented ──────────────────────────────────────────
   * Previewing the most recent real invoice would put one customer's site,
   * job and amounts on screen for whoever happened to be editing a template,
   * which is a disclosure nobody asked for. The sample below is fiction, and
   * the branding around it — company, ABN, bank, logo — is real, because that
   * is the half a person is checking.
   */
  async previewTemplate(id: string, caller: Caller): Promise<TemplatePreview> {
    assertWriter(caller);

    const template = (await settingsRepository.get()).invoicing.templates.find(
      (candidate) => candidate.id === id,
    );
    if (!template) throw AppError.notFound(`No invoice template is configured for "${id}"`);

    const context = await invoiceRenderService.context();

    const pdf = await renderInvoicePdf({
      invoice: sampleInvoice(template.name),
      template,
      branding: context.branding,
      invoiceNumberPrefix: context.invoiceNumberPrefix,
      logo: context.logo,
      jobContext: SAMPLE_JOB_CONTEXT,
    });

    const key = buildKey({
      scope: 'settings',
      ownerId: SETTINGS_OWNER,
      kind: 'template-preview',
      contentType: 'application/pdf',
    });

    await getStorage().put(key, pdf, 'application/pdf');

    log.info({ templateId: id }, 'template preview rendered');

    return {
      url: await getStorage().presignDownload(key),
      fileName: `Preview — ${template.name}.pdf`,
    };
  },

  /* ── Rate cards (M6.1) ─────────────────────────────────────────────────── */

  /* ── Zones (M6.3) ──────────────────────────────────────────────────────── */

  /**
   * A new service area, priced by copying one that already exists.
   *
   * ── Why the caller nominates a zone to copy ───────────────────────────────
   * A zone with no rates prices nothing on any card, so every job booked into it
   * falls back to `default` — which has no rates for it either — and the booking
   * is refused with a 503 the office cannot act on. Copying per card also keeps
   * each customer's negotiated discount: Clarendon's new-zone row comes from
   * Clarendon's source row, not from one flat number applied to everybody.
   *
   * The slug is derived from the label, so an administrator opening "Central
   * Coast" does not also have to invent `central-coast`.
   */
  async createZone(input: ZoneCreate, caller: Caller): Promise<ZoneSummary> {
    assertZoneAdmin(caller);

    const slug = slugify(input.label);
    if (slug === '') {
      throw AppError.validation('That name cannot be turned into an id', [
        { path: 'label', message: 'Use at least one letter or digit' },
      ]);
    }

    /*
     * 409 rather than 422: the request is well-formed, it just lost a race with
     * a zone that already exists.
     *
     * ⚠️ `findZoneBySlug` sees ARCHIVED zones, and must. A retired zone still
     * owns its rate rows in `zonerates`, so reissuing its slug would hand a
     * brand-new zone a price list nobody set.
     */
    const clash = await settingsRepository.findZoneBySlug(slug);
    if (clash) {
      throw AppError.conflict(
        clash.archived
          ? `"${clash.label}" was retired rather than deleted, and still holds its old prices. Restore it instead of creating it again.`
          : `A zone called "${clash.label}" already exists`,
      );
    }

    const source = await settingsRepository.findZone(input.copyRatesFromZoneId);
    if (!source) {
      throw AppError.validation('Pick a zone to copy prices from', [
        { path: 'copyRatesFromZoneId', message: 'Choose one of the zones from the list' },
      ]);
    }

    const { id, rowsCopied } = await settingsRepository.createZoneCopyingRates({
      slug,
      label: input.label.trim(),
      displayOrder: await settingsRepository.nextZoneDisplayOrder(),
      copyRatesFromZoneId: source.id,
    });

    /*
     * Zero copied rows is a real state on an install where no card has a
     * schedule yet — allowed rather than refused, for the same reason
     * `settingsRepository.get()` no longer throws on an empty database: this is
     * the screen where that gets fixed. Logged at `warn` because the zone prices
     * nothing until a schedule is issued, and nobody would otherwise be told.
     */
    if (rowsCopied === 0) {
      log.warn(
        { zoneId: id, slug, copiedFrom: source.slug },
        'zone created with NO rates — no card had a schedule to copy',
      );
    } else {
      log.info({ zoneId: id, slug, copiedFrom: source.slug, rowsCopied }, 'zone created');
    }

    return findZoneOrThrow(id);
  },

  /**
   * Renaming a zone.
   *
   * ⚠️ The slug and the id are NOT reachable from here, by design. They are the
   * key stored on every job, place, account, lead and rate row — changing one is
   * a five-collection migration, not an edit. The label is what anybody actually
   * wants to change, and it is safe: a charge-line description froze the zone's
   * name at quote time, so this never moves a word on an invoice already raised.
   */
  async renameZone(id: string, input: ZoneUpdate, caller: Caller): Promise<ZoneSummary> {
    assertZoneAdmin(caller);
    await findZoneOrThrow(id);

    await settingsRepository.renameZone(id, input.label.trim());
    log.info({ zoneId: id }, 'zone renamed');

    return findZoneOrThrow(id);
  },

  /**
   * The whole list, in the order it should read.
   *
   * ── Why the whole list, and not one zone's position ───────────────────────
   * Two `PATCH`es moving different zones can leave both claiming the same
   * position, and the sort is then whatever Mongo returns — which is the exact
   * bug the old `ZONES.indexOf` prevented by accident. Sending the whole order
   * makes that unrepresentable, and validating it against the register means a
   * stale tab cannot half-reorder anything.
   */
  async reorderZones(input: ZoneOrder, caller: Caller): Promise<ZoneSummary[]> {
    assertZoneAdmin(caller);

    const zones = await settingsRepository.allZones();
    const known = new Set(zones.map((zone) => zone.id));
    const sent = new Set(input.zoneIds);

    if (sent.size !== input.zoneIds.length) {
      throw AppError.validation('That order lists a zone twice', [
        { path: 'zoneIds', message: 'Send each zone exactly once' },
      ]);
    }

    const unknown = input.zoneIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw AppError.validation('That order names something that is not a zone', [
        { path: 'zoneIds', message: 'Reload the page and try again' },
      ]);
    }

    const missing = zones.filter((zone) => !sent.has(zone.id));
    if (missing.length > 0) {
      throw AppError.validation('That order is missing a zone', [
        {
          path: 'zoneIds',
          message: `${missing.map((zone) => zone.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the list — reload the page and try again`,
        },
      ]);
    }

    await settingsRepository.reorderZones(input.zoneIds);
    log.info({ count: input.zoneIds.length }, 'zones reordered');

    return settingsRepository.allZones();
  },

  /**
   * Retire a zone. It is never deleted.
   *
   * ── Why archive and not delete ────────────────────────────────────────────
   * Three reasons, any one of them sufficient. Jobs are never deleted, so a
   * job-count guard would refuse a delete permanently after one pickup — a
   * "delete" that is always refused is not a feature. A deleted document leaves
   * a dangling `zoneId` on five collections and a financial report unable to
   * name its own rows. And freeing the slug would let a new zone silently adopt
   * the old one's rate rows.
   *
   * ⚠️ Jobs and leads are deliberately NOT guards. Both are history: a job
   * carries its own frozen `appliedRate` and never reads the zone table again.
   * Guarding on them would mean a zone with any past work could never be
   * retired — which is every zone anybody would ever want to retire. Their
   * counts ride on `ZoneSummary` so the screen can warn instead.
   */
  async archiveZone(id: string, caller: Caller): Promise<ZoneSummary> {
    assertZoneAdmin(caller);

    const zone = await findZoneOrThrow(id);
    // Retiring a retired zone is not an error; it is the state being asked for.
    if (zone.archived) return zone;

    /*
     * 1. The last one standing. A platform with no zones cannot price or book
     *    anything, and the failure would surface on a booking form rather than
     *    here.
     */
    if ((await settingsRepository.countActiveZones()) <= 1) {
      throw AppError.conflict(
        'This is the only zone left. A booking has to be priced in a zone, so add another one before retiring this.',
      );
    }

    /*
     * 2. Suburbs still in it — the guard that matters.
     *
     * ⚠️ A suburb in a retired zone is still in the picker, so the office books
     * a job into a zone no future schedule will price, and the booking is
     * refused at quote time with a 503 naming the zone — weeks after the
     * decision that caused it.
     */
    if (zone.placeCount > 0) {
      throw AppError.conflict(
        `${String(zone.placeCount)} suburb${zone.placeCount === 1 ? ' is' : 's are'} still in this zone. Move ${zone.placeCount === 1 ? 'it' : 'them'} to another zone first.`,
      );
    }

    /*
     * 3. Customers whose primary zone this is. Cosmetic on its own —
     *    `primaryZoneId` prices nothing, the job's own zone does — but it shows
     *    on the customer record and the accounts grid, and an account naming a
     *    zone the business no longer services is a support call.
     */
    if (zone.accountCount > 0) {
      throw AppError.conflict(
        `${String(zone.accountCount)} customer${zone.accountCount === 1 ? ' has' : 's have'} this as their primary zone. Move ${zone.accountCount === 1 ? 'them' : 'them'} to another zone first.`,
      );
    }

    await settingsRepository.setZoneArchived(id, true);
    log.info({ zoneId: id, jobs: zone.jobCount }, 'zone retired — historical records keep it');

    return findZoneOrThrow(id);
  },

  /** Put a retired zone back into service, with the prices it always had. */
  async restoreZone(id: string, caller: Caller): Promise<ZoneSummary> {
    assertZoneAdmin(caller);
    await findZoneOrThrow(id);

    await settingsRepository.setZoneArchived(id, false);
    log.info({ zoneId: id }, 'zone restored');

    return findZoneOrThrow(id);
  },

  /**
   * A new rate card, with its opening schedule.
   *
   * The id is derived from the label when the caller does not supply one, which
   * is what the form does — an administrator naming "Metricon Homes" should not
   * also have to invent `metricon-homes`.
   */
  async createRateCard(input: RateCardCreate, caller: Caller): Promise<RateCardSummary> {
    assertWriter(caller);
    await assertPricesEveryZone(input.zones);

    const id = input.id ?? slugify(input.label);
    if (id === '') {
      throw AppError.validation('That name cannot be turned into an id', [
        { path: 'label', message: 'Use at least one letter or digit' },
      ]);
    }

    if (await settingsRepository.findRateCard(id)) {
      // 409 rather than 422: the request is well-formed, it just lost a race
      // with a card that already exists.
      throw AppError.conflict(`A rate card with the id "${id}" already exists`);
    }

    await settingsRepository.createRateCard({
      id,
      label: input.label,
      effectiveFrom: input.effectiveFrom,
      zones: input.zones,
    });

    log.info({ rateCardId: id, effectiveFrom: input.effectiveFrom }, 'rate card created');
    return findCardOrThrow(id);
  },

  async renameRateCard(
    id: string,
    input: RateCardUpdate,
    caller: Caller,
  ): Promise<RateCardSummary> {
    assertWriter(caller);
    await assertCardExists(id);

    await settingsRepository.renameRateCard(id, input.label);
    return findCardOrThrow(id);
  },

  /**
   * ⚠️ Issue a new schedule (M6.2) — the only way a rate ever changes.
   *
   * ── The three refusals, and why each one is a refusal ─────────────────────
   * All of them protect the same invariant: a figure on an invoice the customer
   * has seen must never move.
   *
   *  1. **A duplicate start date.** Two schedules opening on the same day is
   *     ambiguous, and `card_zone_from_unique` would reject it with a
   *     duplicate-key error the caller cannot read. Refusing here says which
   *     date is the problem.
   *
   *  2. **Back-dating behind an invoiced job.** This is the important one. A
   *     schedule starting before a job that has already been invoiced means the
   *     rate tables now disagree with a document in a builder's accounts payable
   *     system. The job's own snapshot keeps the INVOICE honest, but the
   *     disagreement itself is a reconciliation nobody can win, so it is
   *     refused outright rather than warned about.
   *
   *  3. **Back-dating at all is allowed otherwise**, because correcting a rate
   *     that was keyed wrong last week — before anything was billed — is a
   *     legitimate and fairly common fix. Forbidding every back-date would push
   *     that correction into a database console.
   */
  async issueSchedule(
    id: string,
    input: RateScheduleCreate,
    caller: Caller,
  ): Promise<RateCardSummary> {
    assertWriter(caller);
    await assertCardExists(id);
    await assertPricesEveryZone(input.zones);

    const starts = await settingsRepository.scheduleStarts(id);
    if (starts.includes(input.effectiveFrom)) {
      throw AppError.validation('That card already has a schedule starting on that date', [
        {
          path: 'effectiveFrom',
          message: 'Pick a different start date, or delete the card and start again',
        },
      ]);
    }

    const earliestInvoiced = await settingsRepository.earliestInvoicedDateOnCard(id);
    if (earliestInvoiced !== null && input.effectiveFrom <= earliestInvoiced) {
      throw AppError.conflict(
        `This card has already invoiced work from ${earliestInvoiced}. A schedule starting on or before that date would disagree with an invoice the customer already has — start it after ${earliestInvoiced} instead.`,
      );
    }

    await settingsRepository.issueSchedule(id, input.effectiveFrom, input.zones);

    log.info(
      { rateCardId: id, effectiveFrom: input.effectiveFrom },
      'rate schedule issued — previous schedule closed',
    );
    return findCardOrThrow(id);
  },

  /**
   * Retire a rate card.
   *
   * Refused while any account names it — an account with a dangling card would
   * fail to price its next booking, and the failure would surface on a booking
   * form rather than here. `default` is refused unconditionally because
   * `resolveRate` falls back to it.
   *
   * Jobs already priced on the card are unaffected: each carries its own frozen
   * snapshot, which is what makes retiring a card safe at all.
   */
  async deleteRateCard(id: string, caller: Caller): Promise<void> {
    assertWriter(caller);
    await assertCardExists(id);

    if (id === DEFAULT_RATE_CARD_ID) {
      throw AppError.conflict(
        'The default card cannot be deleted — every other card falls back to it when a zone has no rate',
      );
    }

    const accountCount = await settingsRepository.countAccountsOnRateCard(id);
    if (accountCount > 0) {
      throw AppError.conflict(
        `${String(accountCount)} account${accountCount === 1 ? '' : 's'} still price against this card. Move them to another card first.`,
      );
    }

    await settingsRepository.deleteRateCard(id);
    log.info({ rateCardId: id }, 'rate card deleted');
  },

  /**
   * M6.2 — remove a schedule that was issued by mistake.
   *
   * ── The two refusals, and why they are the only two ───────────────────────
   * Issuing a schedule is safe because it never changes a price that has been
   * used. Removing one is the opposite: it can, so it is allowed in exactly the
   * case where it cannot.
   *
   *  1. **It must not be in force, or past.** Only a schedule that starts in the
   *     FUTURE can go. One that covers today is pricing bookings being taken
   *     right now, and one that has passed priced jobs that were invoiced on it.
   *     "I typed 2026 instead of 2027" is the mistake this exists for, and that
   *     mistake is always in the future.
   *
   *  2. **It must not be the card's only schedule.** Deleting the last one
   *     leaves a card that prices nothing, and every quote against it silently
   *     falls back to the default card — a mispricing nobody would see. Deleting
   *     the CARD is the operation for that, and it already refuses while
   *     accounts point at it.
   *
   * The repository reopens the previous schedule as part of the same removal,
   * so the card is left exactly as it was before the mistake.
   */
  async deleteSchedule(id: string, effectiveFrom: string, caller: Caller): Promise<RateCardSummary> {
    assertWriter(caller);
    await assertCardExists(id);

    const starts = await settingsRepository.scheduleStarts(id);
    if (!starts.includes(effectiveFrom)) {
      throw AppError.notFound(`That card has no schedule starting on ${effectiveFrom}`);
    }

    if (starts.length === 1) {
      throw AppError.conflict(
        'This is the card’s only schedule. A card with no rates prices nothing — delete the card itself, or issue a replacement schedule first.',
      );
    }

    if (effectiveFrom <= todayInSydney()) {
      throw AppError.conflict(
        effectiveFrom === todayInSydney()
          ? 'That schedule is in force today — issue a new one instead of removing this.'
          : `That schedule started on ${effectiveFrom} and may have priced work already. Only a schedule that has not started yet can be removed.`,
      );
    }

    await settingsRepository.deleteSchedule(id, effectiveFrom);

    log.info({ rateCardId: id, effectiveFrom }, 'future rate schedule removed');
    return findCardOrThrow(id);
  },

  /* ── Additional services (M6.5) ────────────────────────────────────────── */

  async createAdditionalService(
    input: AdditionalServiceCreate,
    caller: Caller,
  ): Promise<AdditionalServiceSetting> {
    assertWriter(caller);

    if (await settingsRepository.findAdditionalService(input.code)) {
      throw AppError.conflict(`A charge with the code "${input.code}" already exists`);
    }

    assertPercentageInRange(input.kind, input.value);

    await settingsRepository.createAdditionalService(input);
    log.info({ code: input.code, kind: input.kind }, 'additional service created');

    return findServiceOrThrow(input.code);
  },

  /**
   * Reprice or relabel a charge.
   *
   * ⚠️ Reachable for the protected codes too, and deliberately so: repricing
   * the futile fee from $120 to $135 is the single most likely thing anybody
   * will ever do on this screen. What is refused is DELETING those codes, not
   * editing them.
   *
   * `kind` is not in the payload — see the note on the update schema.
   */
  async updateAdditionalService(
    code: string,
    input: AdditionalServiceUpdate,
    caller: Caller,
  ): Promise<AdditionalServiceSetting> {
    assertWriter(caller);

    const existing = await settingsRepository.findAdditionalService(code);
    if (!existing) throw AppError.notFound(`No charge is configured for "${code}"`);

    assertPercentageInRange(existing.kind, input.value);

    /*
     * ⚠️ The "a system charge cannot be driver-raisable" refusal used to sit
     * here. It is gone because the thing it refused is now unrepresentable:
     * `driverRaisable` left the write contract along with the checkbox that
     * set it, so no request can ask for it. A rule enforced by a shape that
     * cannot express the mistake is stronger than one enforced by a check.
     */

    await settingsRepository.updateAdditionalService(code, input);
    log.info({ code, value: input.value }, 'additional service updated');

    return findServiceOrThrow(code);
  },

  /**
   * Remove a charge.
   *
   * The five protected codes are refused: the application looks each one up by
   * literal name, so deleting one turns a driver tapping "Report
   * contamination" into a 500 rather than shortening a list on this screen.
   */
  async deleteAdditionalService(code: string, caller: Caller): Promise<void> {
    assertWriter(caller);

    const existing = await settingsRepository.findAdditionalService(code);
    if (!existing) throw AppError.notFound(`No charge is configured for "${code}"`);

    if ((PROTECTED_SERVICE_CODES as readonly string[]).includes(code)) {
      throw AppError.conflict(
        `"${existing.label}" is raised by the system itself and cannot be removed. Set its amount to $0.00 if you no longer charge for it.`,
      );
    }

    const usedOnJobs = await settingsRepository.countChargesWithCode(code);
    if (usedOnJobs > 0) {
      throw AppError.conflict(
        `"${existing.label}" has been raised on ${String(usedOnJobs)} job${usedOnJobs === 1 ? '' : 's'} and is part of their invoices. Set its amount to $0.00 instead of deleting it.`,
      );
    }

    await settingsRepository.deleteAdditionalService(code);
    log.info({ code }, 'additional service deleted');
  },
};

/* ── Guards ──────────────────────────────────────────────────────────────── */

/**
 * Who may READ the settings.
 *
 * ⚠️ This was a denylist — it refused customer roles and admitted everything
 * else, which silently included DRIVERS. The comment on the route reasons
 * entirely about office staff needing the rate cards on screen while they book
 * a job; drivers were never the case it had in mind, they simply were not
 * customers.
 *
 * What that handed a driver’s phone: all seven rate cards with the service
 * charge and per-m² rate for every zone, the additional-services price list,
 * `assumedCostPerJob` — the figure every margin in the financial report is
 * computed from — and the bank BSB, account number and account name, which are
 * blank in development and are not in production.
 *
 * The driver app never asks for this endpoint, so naming the office roles
 * explicitly costs nothing. An allowlist also means the next role added to the
 * product does not inherit the price list by default.
 *
 * The allocator IS included: confirmed 2026-09-11 that an allocator seeing what
 * a job is worth is accepted — see the note on `OFFICE_ROLES` in the queues.
 */
const SETTINGS_READERS = new Set<Role>(['super-admin', 'operations', 'office-staff', 'allocator']);

function assertStaff(caller: Caller): void {
  if (caller.roles.some((role) => SETTINGS_READERS.has(role))) return;

  if (caller.roles.some((role) => CUSTOMER_ROLES.has(role))) {
    // Plain 403 here rather than the 404 the accounts domain uses: settings are
    // not a row whose existence is a secret, and pretending the endpoint is
    // missing would just make a support call harder.
    throw AppError.forbidden('Platform settings are not available on a customer account');
  }

  throw AppError.forbidden('Pricing and invoicing settings are for the office');
}

function assertWriter(caller: Caller): void {
  assertStaff(caller);
  if (!caller.roles.some((role) => WRITERS.has(role))) {
    throw AppError.forbidden('Only an administrator can change platform settings');
  }
}

/**
 * Zone administration is tighter than the rest of this file.
 *
 * ⚠️ `WRITERS` above admits operations, because repricing a card or renaming a
 * template is day-to-day office work. A zone is not: adding one writes a rate
 * row on every card for every schedule they have ever had, and retiring one
 * decides where the business goes. That is an administrator's call, so the route
 * gate says so and this says it again — the same double-gate the rest of the
 * domain uses, at a tighter setting.
 */
function assertZoneAdmin(caller: Caller): void {
  assertStaff(caller);
  if (!caller.roles.includes('super-admin')) {
    throw AppError.forbidden('Only an administrator can change the service zones');
  }
}

async function findZoneOrThrow(id: string): Promise<ZoneSummary> {
  const zone = await settingsRepository.findZone(id);
  if (!zone) throw AppError.notFound(`No zone is configured for "${id}"`);
  return zone;
}

/**
 * Every zone that exists must be priced, in one go.
 *
 * ── Why this is here and not in the schema ────────────────────────────────
 * It WAS in the schema — `.length(ZONES.length)` plus a refine over the enum.
 * Neither is expressible once zones are a collection, because `@plastago/shared`
 * is a contract package with no I/O.
 *
 * ── Why it reads the zones rather than counting them ──────────────────────
 * The refusal has to NAME what is missing. "Price all 4 zones" sends an
 * administrator back to a form to count rows; "Newcastle has no price on this
 * schedule" sends them to the field. Every issue is at `path: 'zones'` so the
 * form attaches it to the rate table rather than to the page.
 *
 * This is also a STRONGER check than the one it replaced, which counted to three
 * and would have accepted a schedule that priced Sydney three times.
 *
 * ⚠️ Archived zones are deliberately not required. A retired zone must not block
 * every future rate change; its historical rows still resolve for a reissued
 * invoice, which is the only thing that still reads them.
 */
async function assertPricesEveryZone(rates: readonly ZoneRateInput[]): Promise<void> {
  const zones = await settingsRepository.activeZones();
  const priced = new Set(rates.map((rate) => rate.zoneId));

  const missing = zones.filter((zone) => !priced.has(zone.id));
  if (missing.length > 0) {
    throw AppError.validation(
      'Every zone needs a rate',
      missing.map((zone) => ({
        path: 'zones',
        message: `${zone.label} has no price on this schedule`,
      })),
    );
  }

  /*
   * A rate naming something that is not a zone.
   *
   * ⚠️ Newly reachable: `zonerates.zoneId` has no Mongoose `enum` any more, so
   * without this the row would insert cleanly and price nothing, and the only
   * symptom would be a rate table with a row nobody recognises.
   */
  const known = new Set(zones.map((zone) => zone.id));
  const unknown = rates.filter((rate) => !known.has(rate.zoneId));
  if (unknown.length > 0) {
    throw AppError.validation(
      'That is not a zone',
      unknown.map((rate) => ({
        path: 'zones',
        message: `"${rate.zoneId}" is not one of the zones — reload the page and try again`,
      })),
    );
  }
}

async function assertCardExists(id: string): Promise<void> {
  if (!(await settingsRepository.findRateCard(id))) {
    throw AppError.notFound(`No rate card is configured for "${id}"`);
  }
}

/**
 * Re-read the card from the settings tree so the caller gets what was STORED.
 *
 * Not the input echoed back: `accountCount`, `deletable` and the closed window
 * on the previous schedule are all computed by the read, and a response
 * assembled from the request would show a schedule as open that the write had
 * just closed.
 */
async function findCardOrThrow(id: string): Promise<RateCardSummary> {
  const settings = await settingsRepository.get();
  const card = settings.pricing.rateCards.find((candidate) => candidate.id === id);
  if (!card) throw AppError.notFound(`No rate card is configured for "${id}"`);
  return card;
}

async function findServiceOrThrow(code: string): Promise<AdditionalServiceSetting> {
  const service = await settingsRepository.findAdditionalService(code);
  if (!service) throw AppError.notFound(`No charge is configured for "${code}"`);
  return service;
}

/**
 * A percentage over 100 is almost always a typo for a fixed amount.
 *
 * `MoneySchema` already refuses negatives and nonsense, but it cannot know that
 * `10` means ten percent here and `1000` means a fuel levy ten times the job.
 * Zero is allowed: it is how a levy is switched off without deleting it.
 */
function assertPercentageInRange(kind: 'fixed' | 'percentage', value: string): void {
  if (kind !== 'percentage') return;

  if (Number(value) > 100) {
    throw AppError.validation('That percentage is above 100%', [
      {
        path: 'value',
        message: 'Enter the percentage itself — 10 for ten percent, not 1000',
      },
    ]);
  }
}

/**
 * A label into an id — "Metricon Homes" → `metricon-homes`.
 *
 * Returns an empty string when nothing usable survives, which the caller turns
 * into a field error rather than writing a card with a blank id.
 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/*
 * ── Why there is no timezone handling in this file ────────────────────────
 * Every date here is a `YYYY-MM-DD` string, and those compare correctly with
 * `<=` without knowing anything about offsets. A string becomes an instant in
 * exactly one place — `startOfSydneyDay`, in the repository — which is what
 * keeps "effective from 1 October" from starting at 11am on 30 September.
 */

/*
 * There is no sequence guard here any more, because there is no route that
 * could carry a sequence. `nextJobNumber` and `nextInvoiceNumber` are reachable
 * only through `settingsRepository.takeNextNumber()`, which advances them
 * atomically — so the thing the guard existed to refuse is now unrepresentable
 * rather than merely rejected. That is the stronger version of the same rule.
 */

/** Re-read a template from the settings tree, so counts and flags are real. */
async function findTemplateOrThrow(id: string): Promise<InvoiceTemplate> {
  const settings = await settingsRepository.get();
  const template = settings.invoicing.templates.find((candidate) => candidate.id === id);
  if (!template) throw AppError.notFound(`No invoice template is configured for "${id}"`);
  return template;
}

/* ── The preview's fiction (M7.5) ────────────────────────────────────────── */

/**
 * The site a preview claims to be about.
 *
 * ⚠️ Obviously invented, on purpose. A preview that used a plausible real
 * address is one somebody eventually mistakes for a real invoice — so the
 * estate is named "Sample Estate" and the number is a round 99999.
 */
const SAMPLE_JOB_CONTEXT = {
  siteName: 'Sample Estate, Lot 42',
  addressLine: '42 Example Road',
  suburb: 'Sydney',
  collectedOn: '2026-09-01',
  recoveredWeightKg: 1_240,
  expectedAreaM2: 823,
} as const;

/**
 * A believable invoice that is not anybody's.
 *
 * Deliberately exercises the parts of a layout that differ: several lines, a
 * per-unit quantity, a PO number and a weight — so the `detailed` and `compact`
 * drawings actually look different from `standard` in the preview, which is the
 * whole reason somebody opens it.
 */
function sampleInvoice(templateName: string): Invoice {
  return {
    id: '000000000000000000000000',
    invoiceNumber: 99_999,
    kind: 'base',
    status: 'draft',
    brandId: 'plastago',
    accountId: '000000000000000000000000',
    accountName: 'Sample Constructions Pty Ltd',
    jobId: null,
    jobNumber: 99_999,
    poNumber: 'PO-SAMPLE-001',
    issuedOn: '2026-09-01',
    dueOn: '2026-09-08',
    subtotalExGst: '351.75',
    gst: '35.18',
    totalIncGst: '386.93',
    paidAt: null,
    lines: [
      {
        id: '1',
        description: 'Service charge — Sydney',
        quantity: 1,
        unitRate: '220.00',
        amount: '220.00',
        raisedBy: null,
      },
      {
        id: '2',
        description: 'Plasterboard recycling — 823 m² @ $0.1600',
        quantity: 823,
        unitRate: '0.1600',
        amount: '131.68',
        raisedBy: null,
      },
    ],
    templateName,
    pdfKey: null,
    sentAt: null,
    xeroState: 'not-synced',
    xeroLastSyncAt: null,
    xeroMessage: null,
    paymentTermsDays: 7,
    notes: 'This is a sample invoice, produced to preview a template. It is not a real invoice.',
  };
}

/**
 * Delete an object without letting the failure reach the caller.
 *
 * An orphaned logo costs a few kilobytes; a settings save that fails because a
 * previous file could not be deleted costs the administrator their change.
 */
async function removeQuietly(key: string): Promise<void> {
  try {
    await getStorage().remove(key);
  } catch (error) {
    log.warn({ err: error, key }, 'old logo could not be removed — left in storage');
  }
}

/**
 * The shape of a key `buildKey` mints for the invoice logo.
 *
 * `<prefix?>/settings/singleton/logo/<uuid>.<ext>` — the prefix is optional
 * because `S3_KEY_PREFIX` is. Anchored at the end so the segment cannot be a
 * substring of a longer directory name.
 */
const LOGO_KEY_SEGMENT = /(?:^|\/)settings\/singleton\/logo\/[^/]+$/;
