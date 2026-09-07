import type { Account, AccountListItem } from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { CustomerService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { ACCOUNTS, objectId, type AccountFixture } from './fixtures/reference';
import { latency } from './mock-transport';
import { allAccounts, invoiceList, jobList, store, TERMS_VERSION } from './store';

/**
 * Accounts (M2.8 · W8).
 *
 * The derived counters — sites, open jobs, last job — are computed from the live
 * store rather than baked into the fixture, so booking a job updates the account
 * row. A demo where the count next to a name is stale is a demo where every
 * number becomes suspect.
 */
function toListItem(account: AccountFixture): AccountListItem {
  const jobs = jobList().filter((job) => job.accountId === account.id);
  const open = jobs.filter((job) =>
    ['booked', 'assigned', 'in-transit', 'arrived'].includes(job.status),
  );
  const lastJob = jobs
    .map((job) => job.createdAt)
    .sort()
    .at(-1);

  return {
    id: account.id,
    code: account.code,
    name: account.name,
    brandId: account.brandId,
    rateCardId: account.rateCardId,
    accountType: account.accountType,
    poPolicy: account.poPolicy,
    captureMode: account.captureMode,
    /*
     * Derived, never stored twice.
     *
     * An account is onboarded exactly when its terms acceptance exists — there
     * is no second flag that could disagree with the record it describes.
     */
    onboardingState: store.termsAcceptance.has(account.id) ? 'complete' : 'awaiting-terms',
    status: account.status,
    openJobCount: open.length,
    lastJobAt: lastJob ?? null,
  };
}

export function createMockCustomerService(): CustomerService {
  return {
    /**
     * Create an account directly — no lead (Matt, 6:10).
     *
     * Validated the same way the lead conversion is, because the two paths must
     * not be able to produce different-shaped accounts. The customer code is the
     * one thing checked against everything that already exists: it is what the
     * office says on the phone and what appears on every invoice, and two
     * accounts sharing one is a mess nobody untangles later.
     */
    async create(draft) {
      await latency(520, 240);

      const code = draft.customerCode.trim().toUpperCase();
      if (allAccounts().some((account) => account.code === code)) {
        throw new ServiceError('CONFLICT', `${code} is already in use`, {
          fieldErrors: { customerCode: 'That customer code already belongs to another account' },
        });
      }

      const created: AccountFixture = {
        id: objectId('nac', store.createdAccounts.length + 1),
        code,
        name: draft.legalName.trim(),
        accountType: draft.accountType,
        brandId: draft.brandId,
        rateCardId: draft.rateCardId,
        poPolicy: draft.poPolicy,
        captureMode: draft.captureMode,
        status: 'active',
        abn: draft.abn.trim(),
        paymentTermsDays: draft.paymentTermsDays,
        primaryZone: draft.primaryZone,
        preferredPickupWindow: null,
        notes: draft.notes.trim(),
        // No sites yet, so no builders yet — the list is derived from work done.
        builders: [],
        /*
         * Off by default.
         *
         * The account-level rule is a builder's contractual demand, not a
         * PlastaGo policy (M4.8b). Defaulting it on would make every driver on a
         * brand-new account fill in a form nobody asked for.
         */
        riskAssessmentRequired: false,
        contacts:
          draft.accountsContactName.trim() === ''
            ? []
            : [
                {
                  id: objectId('nct', store.createdAccounts.length + 1),
                  name: draft.accountsContactName.trim(),
                  role: 'accounts',
                  email: draft.accountsContactEmail.trim() || null,
                  mobile: null,
                  notifyBySms: false,
                  notifyByEmail: draft.accountsContactEmail.trim() !== '',
                },
              ],
      };

      store.createdAccounts = [...store.createdAccounts, created];

      /*
       * Terms are only outstanding if we are actually going to ask for them.
       *
       * Matt's large builders never see the self-serve flow — *"we'll just create
       * the account for them"* (6:36) — and their terms live in a contract signed
       * long before this screen existed. Leaving those accounts flagged
       * "awaiting terms" forever would make the flag meaningless for the accounts
       * where it does matter.
       */
      if (!draft.sendInvitation) {
        store.termsAcceptance.set(created.id, {
          acceptedAt: new Date().toISOString(),
          acceptedByName: 'Agreed off-system',
          acceptedByRole: 'Existing contract',
          termsVersion: TERMS_VERSION,
        });
      }

      return toListItem(created);
    },

    async list(query) {
      await latency();

      return applyListQuery(allAccounts().map(toListItem), query, {
        search: (account) => [account.name, account.code],
        filters: {
          status: (account, value) => account.status === value,
          brand: (account, value) => account.brandId === value,
          rateCard: (account, value) => account.rateCardId === value,
          accountType: (account, value) => account.accountType === value,
          onboarding: (account, value) => account.onboardingState === value,
          poPolicy: (account, value) => account.poPolicy === value,
          captureMode: (account, value) => account.captureMode === value,
        },
        sorters: {
          name: byText((account) => account.name),
          code: byText((account) => account.code),
          openJobCount: byNumber((account) => account.openJobCount),
          lastJobAt: byDate((account) => account.lastJobAt),
        },
        defaultSort: byText((account) => account.name),
      });
    },

    async get(id) {
      await latency();
      const fixture = allAccounts().find((account) => account.id === id);
      if (!fixture) throw new ServiceError('NOT_FOUND', `No account ${id}`);

      const account: Account = {
        ...toListItem(fixture),
        /*
         * Falls back to the sustainability contact where the account has one.
         *
         * A certificate reaching the wrong internal team is recoverable; one
         * that goes nowhere is not — so the fallback is deliberate rather than
         * leaving it null and silently sending nothing.
         */
        certificateEmail:
          store.accountCertificateEmail.get(id) ??
          fixture.contacts.find((contact) => contact.role === 'sustainability')?.email ??
          null,
        // Read from the mutable store, not the frozen fixture — the office can
        // now toggle this, and `get` has to answer with what they set.
        riskAssessmentRequired:
          store.accountRiskAssessment.get(id) ?? fixture.riskAssessmentRequired,
        abn: fixture.abn,
        paymentTermsDays: fixture.paymentTermsDays,
        primaryZone: fixture.primaryZone,
        contacts: fixture.contacts,
        preferredPickupWindow: fixture.preferredPickupWindow,
        notes: fixture.notes,
        createdAt: new Date(Date.now() - 400 * 86400_000).toISOString(),
      };

      return account;
    },

    async jobs(accountId, query) {
      await latency();

      return applyListQuery(
        jobList().filter((job) => job.accountId === accountId),
        query,
        {
          search: (job) => [job.jobNumber, job.siteName, job.suburb, job.poNumber],
          filters: { status: (job, value) => job.status === value },
          sorters: {
            jobNumber: byNumber((job) => job.jobNumber),
            readyDate: byDate((job) => job.readyDate),
            status: byText((job) => job.status),
          },
          defaultSort: (a, b) => b.jobNumber - a.jobNumber,
        },
      );
    },

    async setRiskAssessmentRequired(accountId, required) {
      await latency();
      const fixture = ACCOUNTS.find((account) => account.id === accountId);
      if (!fixture) throw new ServiceError('NOT_FOUND', `No account ${accountId}`);

      store.accountRiskAssessment.set(accountId, required);
      return this.get(accountId);
    },

    async invoices(accountId, query) {
      await latency();

      return applyListQuery(
        invoiceList().filter((invoice) => invoice.accountId === accountId),
        query,
        {
          search: (invoice) => [invoice.invoiceNumber, invoice.poNumber, invoice.jobNumber],
          filters: {
            status: (invoice, value) => invoice.status === value,
            kind: (invoice, value) => invoice.kind === value,
          },
          sorters: {
            invoiceNumber: byNumber((invoice) => invoice.invoiceNumber),
            issuedOn: byDate((invoice) => invoice.issuedOn),
            status: byText((invoice) => invoice.status),
          },
          defaultSort: (a, b) => b.invoiceNumber - a.invoiceNumber,
        },
      );
    },
  };
}
