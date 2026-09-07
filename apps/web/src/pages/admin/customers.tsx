import {
  BRAND_LABELS,
  CAPTURE_MODE_LABELS,
  CAPTURE_MODES,
  PO_POLICIES,
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  ONBOARDING_STATE_LABELS,
  ONBOARDING_STATES,
  PO_POLICY_LABELS,
  RATE_CARD_LABELS,
  RATE_CARDS,
  type AccountListItem,
} from '@plastago/shared';
import { Badge, Card, Pagination, buttonVariants } from '@plastago/ui';
import { Building2Icon, PlusIcon } from 'lucide-react';
import { Link } from 'react-router';
import { DataTable } from '@/components/data-table/data-table';
import { AccountTypeBadge } from '@/components/domain-badges';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { useCustomerList } from '@/features/customers/queries';
import { formatRelative } from '@/lib/format';

/**
 * Accounts (M2.8 · W8).
 *
 * ── "Customers" in the nav, `Account` in the code ──────────────────────────
 * The office says customer; the domain says account, because the account is the
 * party that gets **invoiced** and it is not the builder whose site is being
 * serviced (M1.2). iPlasta is the account; GJ Gardner is the builder. Keeping
 * the label familiar and the type precise is the compromise — the columns say
 * which is which, and the detail page separates them properly.
 *
 * The filters are the ones that change how a job is priced or billed — rate
 * card, PO policy, capture mode — because those are the questions the office
 * actually asks of this list.
 */
const FILTER_KEYS = [
  'status',
  'accountType',
  'onboarding',
  'rateCard',
  'poPolicy',
  'captureMode',
] as const;

const FILTERS: readonly FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    allLabel: 'All statuses',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
  },
  {
    // The first thing the office wants to slice by: the two types barely share a
    // workflow, so "show me the contractors" is a real question (Matt, 21:55).
    key: 'accountType',
    label: 'Type',
    allLabel: 'Builders and contractors',
    options: ACCOUNT_TYPES.map((type) => ({ value: type, label: ACCOUNT_TYPE_LABELS[type] })),
  },
  {
    /*
     * Who has not signed yet.
     *
     * An account in `awaiting-terms` has no director's guarantee on file — the
     * exposure Matt's paper form exists to close (7:49) — so being able to ask
     * "who is outstanding?" is the point of recording the state at all.
     */
    key: 'onboarding',
    label: 'Terms',
    allLabel: 'Signed and not',
    options: ONBOARDING_STATES.map((state) => ({
      value: state,
      label: ONBOARDING_STATE_LABELS[state],
    })),
  },
  {
    key: 'rateCard',
    label: 'Rate card',
    allLabel: 'All rate cards',
    options: RATE_CARDS.map((card) => ({ value: card, label: RATE_CARD_LABELS[card] })),
  },
  {
    key: 'poPolicy',
    label: 'PO policy',
    allLabel: 'Any PO policy',
    options: PO_POLICIES.map((policy) => ({ value: policy, label: PO_POLICY_LABELS[policy] })),
  },
  {
    key: 'captureMode',
    label: 'Capture',
    allLabel: 'Any capture',
    options: CAPTURE_MODES.map((mode) => ({ value: mode, label: CAPTURE_MODE_LABELS[mode] })),
  },
];

const COLUMNS: readonly DataTableColumn<AccountListItem>[] = [
  {
    id: 'name',
    header: 'Account',
    sortKey: 'name',
    priority: 'primary',
    cell: (row) => (
      <span className="block">
        <span className="font-medium">{row.name}</span>
        <span className="block font-mono text-xs text-muted-foreground">{row.code}</span>
      </span>
    ),
  },
  {
    id: 'brand',
    header: 'Brand',
    priority: 'secondary',
    cell: (row) => <Badge variant="secondary">{BRAND_LABELS[row.brandId]}</Badge>,
  },
  {
    id: 'status',
    header: 'Status',
    priority: 'secondary',
    cell: (row) => (
      <Badge variant={row.status === 'active' ? 'success' : 'outline'}>
        {row.status === 'active' ? 'Active' : 'Inactive'}
      </Badge>
    ),
  },
  {
    id: 'accountType',
    header: 'Type',
    priority: 'primary',
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <AccountTypeBadge type={row.accountType} />
        {/* Only worth showing when it is outstanding — "signed" is the norm. */}
        {row.onboardingState === 'awaiting-terms' && (
          <Badge variant="warning">Terms unsigned</Badge>
        )}
      </span>
    ),
  },
  {
    id: 'rateCard',
    header: 'Rate card',
    priority: 'detail',
    cell: (row) => (
      <span className="text-muted-foreground">{RATE_CARD_LABELS[row.rateCardId]}</span>
    ),
  },
  {
    id: 'poPolicy',
    header: 'PO',
    priority: 'detail',
    cell: (row) =>
      row.poPolicy === 'required-before-invoice' ? (
        <Badge variant="warning">Required</Badge>
      ) : (
        <span className="text-muted-foreground">Not required</span>
      ),
  },
  {
    id: 'captureMode',
    header: 'Capture',
    priority: 'detail',
    cell: (row) => (
      <span className="text-muted-foreground">{CAPTURE_MODE_LABELS[row.captureMode]}</span>
    ),
  },
  {
    id: 'openJobCount',
    header: 'Open jobs',
    sortKey: 'openJobCount',
    numeric: true,
    priority: 'detail',
    className: 'w-24',
    cell: (row) =>
      row.openJobCount > 0 ? (
        <span className="font-medium">{row.openJobCount}</span>
      ) : (
        <span className="text-muted-foreground">0</span>
      ),
  },
  {
    id: 'lastJobAt',
    header: 'Last job',
    sortKey: 'lastJobAt',
    priority: 'detail',
    cell: (row) => <span className="text-muted-foreground">{formatRelative(row.lastJobAt)}</span>,
  },
];

export function AdminCustomersPage() {
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultSort: 'name' });
  const { data, error, isPending, isFetching, refetch } = useCustomerList(controller.query);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="The party being invoiced — distinct from the builder whose site is serviced."
        actions={
          // Matt, 6:10 — an account can be opened without a lead behind it.
          <Link to="/admin/customers/new" className={buttonVariants()}>
            <PlusIcon aria-hidden />
            New customer
          </Link>
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search account name or code…"
          filters={FILTERS}
        />

        <DataTable
          caption="Customer accounts"
          columns={COLUMNS}
          rows={data?.data ?? []}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          rowHref={(row) => `/admin/customers/${row.id}`}
          empty={{
            icon: Building2Icon,
            title: 'No accounts yet',
            description: 'Accounts are created when a lead is converted.',
          }}
        />

        {data && (
          <Pagination
            page={data.meta.page}
            pageSize={data.meta.pageSize}
            total={data.meta.total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            disabled={isFetching}
          />
        )}
      </Card>
    </div>
  );
}
