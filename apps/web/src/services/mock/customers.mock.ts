import type { Account, AccountListItem } from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { CustomerService } from '../types';
import { applyListQuery, byDate, byNumber, byText } from './list-query';
import { ACCOUNTS } from './fixtures/reference';
import { latency } from './mock-transport';
import { invoiceList, jobList, store } from './store';

/**
 * Accounts (M2.8 · W8).
 *
 * The derived counters — sites, open jobs, last job — are computed from the live
 * store rather than baked into the fixture, so booking a job updates the account
 * row. A demo where the count next to a name is stale is a demo where every
 * number becomes suspect.
 */
function toListItem(account: (typeof ACCOUNTS)[number]): AccountListItem {
  const sites = store.sites.filter((site) => site.accountId === account.id);
  const jobs = jobList().filter((job) => job.accountId === account.id);
  const open = jobs.filter((job) =>
    ['booked', 'assigned', 'acknowledged', 'in-transit', 'arrived'].includes(job.status),
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
    poPolicy: account.poPolicy,
    captureMode: account.captureMode,
    status: account.status,
    siteCount: sites.length,
    openJobCount: open.length,
    lastJobAt: lastJob ?? null,
  };
}

export function createMockCustomerService(): CustomerService {
  return {
    async list(query) {
      await latency();

      return applyListQuery(ACCOUNTS.map(toListItem), query, {
        search: (account) => [account.name, account.code],
        filters: {
          status: (account, value) => account.status === value,
          brand: (account, value) => account.brandId === value,
          rateCard: (account, value) => account.rateCardId === value,
          poPolicy: (account, value) => account.poPolicy === value,
          captureMode: (account, value) => account.captureMode === value,
        },
        sorters: {
          name: byText((account) => account.name),
          code: byText((account) => account.code),
          siteCount: byNumber((account) => account.siteCount),
          openJobCount: byNumber((account) => account.openJobCount),
          lastJobAt: byDate((account) => account.lastJobAt),
        },
        defaultSort: byText((account) => account.name),
      });
    },

    async get(id) {
      await latency();
      const fixture = ACCOUNTS.find((account) => account.id === id);
      if (!fixture) throw new ServiceError('NOT_FOUND', `No account ${id}`);

      const account: Account = {
        ...toListItem(fixture),
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

    async sites(accountId, query) {
      await latency();

      return applyListQuery(
        store.sites.filter((site) => site.accountId === accountId),
        query,
        {
          search: (site) => [site.name, site.suburb, site.builderName, site.lotNumber],
          filters: {
            zone: (site, value) => site.zone === value,
            status: (site, value) => site.status === value,
            builder: (site, value) => site.builderName === value,
          },
          sorters: {
            name: byText((site) => site.name),
            suburb: byText((site) => site.suburb),
            builderName: byText((site) => site.builderName),
            jobCount: byNumber((site) => site.jobCount),
          },
          defaultSort: byText((site) => site.suburb),
        },
      );
    },

    async jobs(accountId, query) {
      await latency();

      return applyListQuery(
        jobList().filter((job) => job.accountId === accountId),
        query,
        {
          search: (job) => [job.jobNumber, job.siteName, job.suburb, job.customerReference],
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

    async setSiteRiskAssessmentOverride(siteId, override) {
      await latency();
      const site = store.sites.find((candidate) => candidate.id === siteId);
      if (!site) throw new ServiceError('NOT_FOUND', `No site ${siteId}`);

      site.riskAssessmentOverride = override;
      return { ...site };
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
