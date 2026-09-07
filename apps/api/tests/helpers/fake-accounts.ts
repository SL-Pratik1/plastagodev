import type { Account, AccountListItem, PageMeta, TermsAcceptance } from '@plastago/shared';
import type {
  AccountScope,
  CreateAccountInput,
  ListAccountsQuery,
} from '../../src/domains/accounts/account.repository.js';

/**
 * An in-memory stand-in for the account repository.
 *
 * ── Why a fake and not a mocked Mongo ─────────────────────────────────────
 * The service's job is rules — who may see what, what the office is told when a
 * create fails. None of that needs a database, and a test that spins one up
 * measures Mongo's availability rather than the rule under test.
 *
 * It records what it was ASKED as well as what it returned, because the scoping
 * assertions are about the query the service builds, not the rows that come
 * back. A repository that ignored its scope would still return plausible data.
 */

interface SeedOptions {
  code: string;
  /** Force a specific id, so a test can make the caller own this account. */
  id?: string | null;
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, '0');
}

function listItemOf(id: string, code: string): AccountListItem {
  return {
    id,
    code,
    name: `${code} Pty Ltd`,
    brandId: 'plastago',
    rateCardId: 'tier-1',
    accountType: 'contractor',
    onboardingState: 'awaiting-terms',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    status: 'active',
    openJobCount: 0,
    lastJobAt: null,
  };
}

function accountOf(id: string, code: string, riskAssessmentRequired: boolean): Account {
  return {
    ...listItemOf(id, code),
    riskAssessmentRequired,
    certificateEmail: null,
    abn: '12345678901',
    paymentTermsDays: 7,
    primaryZone: 'sydney',
    contacts: [],
    preferredPickupWindow: null,
    notes: '',
    createdAt: '2026-02-01T00:00:00.000Z',
  };
}

export function createFakeAccountRepository() {
  const accounts = new Map<string, { code: string; riskAssessmentRequired: boolean }>();
  const takenCodes = new Set<string>();

  const state = {
    lastScope: null as AccountScope | null,
    lastCreate: null as CreateAccountInput | null,
    /** Recorded so a facet cannot be silently dropped on its way down. */
    lastQuery: null as ListAccountsQuery | null,

    /** Put an account in the store and return its id. */
    seedAccount(options: SeedOptions): string {
      const id = options.id ?? nextId();
      accounts.set(id, { code: options.code, riskAssessmentRequired: false });
      takenCodes.add(options.code);
      return id;
    },

    /** Mark a code as taken without creating a readable account. */
    seedCode(code: string): void {
      takenCodes.add(code);
    },

    repository: {
      async list(
        query: ListAccountsQuery,
        scope: AccountScope,
      ): Promise<{ data: AccountListItem[]; meta: PageMeta }> {
        state.lastScope = scope;
        state.lastQuery = query;

        // Mirrors the real scoping so a list test sees the same narrowing the
        // repository would apply, without a database to apply it.
        const rows = [...accounts.entries()]
          .filter(([id]) => scope.accountId === null || scope.accountId === id)
          .map(([id, row]) => listItemOf(id, row.code));

        return {
          data: rows,
          meta: {
            page: query.page,
            pageSize: query.pageSize,
            total: rows.length,
            totalPages: 1,
          },
        };
      },

      async findById(id: string, scope: AccountScope): Promise<Account | null> {
        state.lastScope = scope;
        if (scope.accountId !== null && scope.accountId !== id) return null;
        const row = accounts.get(id);
        return row ? accountOf(id, row.code, row.riskAssessmentRequired) : null;
      },

      async codeExists(code: string): Promise<boolean> {
        return takenCodes.has(code.trim().toUpperCase());
      },

      async create(input: CreateAccountInput): Promise<AccountListItem> {
        state.lastCreate = input;
        const id = nextId();
        accounts.set(id, { code: input.code, riskAssessmentRequired: false });
        takenCodes.add(input.code);
        return {
          ...listItemOf(id, input.code),
          onboardingState: input.termsAgreedOffSystem ? 'complete' : 'awaiting-terms',
        };
      },

      async setRiskAssessmentRequired(id: string, required: boolean): Promise<boolean> {
        const row = accounts.get(id);
        if (!row) return false;
        row.riskAssessmentRequired = required;
        return true;
      },

      async findTermsAcceptance(): Promise<TermsAcceptance | null> {
        return null;
      },
    },
  };

  return state;
}
