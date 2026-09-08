import { ROLE_LABELS, ROLES, type Role } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Drawer,
  Field,
  Input,
  Pagination,
  Select,
  Skeleton,
  SkeletonText,
  Spinner,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  Textarea,
  useToast,
} from '@plastago/ui';
import { UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { PageHeader } from '@/components/page-header';
import { formatDateTime, formatMobile, formatMoney, TIMEZONE_LABEL } from '@/lib/format';
import { ServiceError } from '@/services/service-error';
import { SEEDED_IDENTITIES } from '@/config/seeded-identities';

/**
 * The design system, exercised.
 *
 * ⚠️ NOT a business screen. It is the console's own reference page: every shared
 * component rendered in its real context, and every table state reachable with
 * one click.
 *
 * It earns its place for a reason specific to this project. The states nobody
 * can see are the ones that ship broken — an empty grid, a failed load, a
 * filtered-to-nothing list, a form mid-submit. On a UI-only build with no
 * backend there is no natural way to trigger them, so they go unreviewed until
 * the real API is slow or down. Here they are switches.
 *
 * Delete this route and its nav entry whenever it stops paying for itself; no
 * business screen imports it.
 */
export function AdminFoundationPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="UI foundation"
        description="Every shared component in its real context, and every list state on a switch. A development reference, not a feature."
        badge={<Badge variant="outline">Internal</Badge>}
      />

      <Tabs defaultValue="table">
        <TabsList label="Foundation sections">
          <TabsTrigger value="table">Data table</TabsTrigger>
          <TabsTrigger value="overlays">Overlays</TabsTrigger>
          <TabsTrigger value="forms">Forms</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="formatting">Formatting</TabsTrigger>
        </TabsList>

        <TabsPanel value="table">
          <TableSection />
        </TabsPanel>
        <TabsPanel value="overlays">
          <OverlaySection />
        </TabsPanel>
        <TabsPanel value="forms">
          <FormSection />
        </TabsPanel>
        <TabsPanel value="feedback">
          <FeedbackSection />
        </TabsPanel>
        <TabsPanel value="formatting">
          <FormattingSection />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/* ── Data table ─────────────────────────────────────────────────────────── */

type ForcedState = 'loaded' | 'pending' | 'empty' | 'error';

const ROLE_FILTER: FilterDefinition = {
  key: 'role',
  label: 'Role',
  allLabel: 'All roles',
  options: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
};

const FILTER_KEYS = ['role'] as const;


/**
 * Sample rows for the DataTable demonstration.
 *
 * ⚠️ Showcase data, and it lives here on purpose. This page exists to exercise
 * the design system — sorting, filtering, paging, the empty and error states —
 * so it needs rows with a last-sign-in and a brand count to sort BY. Those are
 * not facts the seeded account list carries, and inventing them there would put
 * fake data one import away from a real screen.
 *
 * The names come from the seed list so the page still reads as PlastaGo.
 */
interface ShowcaseRow {
  id: string;
  name: string;
  email: string | null;
  mobile: string | null;
  role: Role;
  lastSignedInAt: string;
  brandIds: readonly string[];
}

const SHOWCASE_ROWS: readonly ShowcaseRow[] = SEEDED_IDENTITIES.map((identity, index) => ({
  id: identity.role,
  name: identity.name,
  email: identity.email,
  mobile: identity.mobile,
  role: identity.role,
  // Spread across the last week so the column has something to sort.
  lastSignedInAt: new Date(Date.now() - index * 19 * 3_600_000).toISOString(),
  brandIds: index % 3 === 0 ? ['plastago', 'easylift', 'brickgo'] : ['plastago'],
}));

const COLUMNS: readonly DataTableColumn<ShowcaseRow>[] = [
  {
    id: 'name',
    header: 'Name',
    sortKey: 'name',
    priority: 'primary',
    cell: (row) => row.name,
  },
  {
    id: 'role',
    header: 'Role',
    sortKey: 'role',
    priority: 'secondary',
    cell: (row) => <Badge variant="secondary">{ROLE_LABELS[row.role]}</Badge>,
  },
  {
    id: 'contact',
    header: 'Contact',
    priority: 'detail',
    cell: (row) => (
      <span className="text-muted-foreground">{row.email ?? formatMobile(row.mobile)}</span>
    ),
  },
  {
    id: 'lastSignedInAt',
    header: 'Last sign-in',
    sortKey: 'lastSignedInAt',
    priority: 'detail',
    cell: (row) => (
      <span className="text-muted-foreground">{formatDateTime(row.lastSignedInAt)}</span>
    ),
  },
  {
    id: 'brands',
    header: 'Brands',
    numeric: true,
    priority: 'detail',
    className: 'w-24',
    cell: (row) => row.brandIds.length,
  },
];

function TableSection() {
  const [forced, setForced] = useState<ForcedState>('loaded');
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultSort: 'name' });

  // Filtering and sorting happen HERE only because there is no backend. Real
  // screens pass `controller.query` to a service and render what comes back —
  // the server owns paging, sorting and filtering (see `services/types.ts`).
  const search = (controller.query.q ?? '').toLowerCase();
  const roleFilter = controller.filters.role;

  let rows: ShowcaseRow[] = SHOWCASE_ROWS.filter((identity) => {
    const matchesSearch =
      !search ||
      identity.name.toLowerCase().includes(search) ||
      (identity.email ?? '').toLowerCase().includes(search) ||
      (identity.mobile ?? '').includes(search);
    const matchesRole = !roleFilter || identity.role === (roleFilter as Role);
    return matchesSearch && matchesRole;
  });

  const sort = controller.sort;
  if (sort) {
    const descending = sort.startsWith('-');
    const key = descending ? sort.slice(1) : sort;
    rows = [...rows].sort((a, b) => {
      const left = String(a[key as keyof ShowcaseRow] ?? '');
      const right = String(b[key as keyof ShowcaseRow] ?? '');
      return descending ? right.localeCompare(left) : left.localeCompare(right);
    });
  }

  const total = forced === 'empty' ? 0 : rows.length;
  const start = (controller.query.page - 1) * controller.query.pageSize;
  const paged = forced === 'empty' ? [] : rows.slice(start, start + controller.query.pageSize);

  return (
    <div className="space-y-4">
      <Alert variant="neutral" title="States are switchable">
        <div className="mt-2 flex flex-wrap gap-2">
          {(['loaded', 'pending', 'empty', 'error'] as const).map((state) => (
            <Button
              key={state}
              size="sm"
              variant={forced === state ? 'default' : 'outline'}
              onClick={() => {
                setForced(state);
              }}
            >
              {state}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs">
          Search or pick a role, then switch to <code>empty</code> — the message changes from “no
          records yet” to “no matches”, with a way to clear the filters.
        </p>
      </Alert>

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search name, email or mobile…"
          filters={[ROLE_FILTER]}
          actions={
            <Button size="sm" variant="outline">
              Invite user
            </Button>
          }
        />

        <DataTable
          caption="Sample rows"
          columns={COLUMNS}
          rows={paged}
          getRowId={(row) => row.id}
          isPending={forced === 'pending'}
          error={
            forced === 'error'
              ? new ServiceError('UNEXPECTED', 'Forced failure from the foundation page')
              : undefined
          }
          onRetry={() => {
            setForced('loaded');
          }}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          empty={{
            icon: UsersIcon,
            title: 'No users yet',
            description: 'Invite your first user to get started.',
          }}
        />

        {forced !== 'pending' && forced !== 'error' && (
          <Pagination
            page={controller.query.page}
            pageSize={controller.query.pageSize}
            total={total}
            onPageChange={controller.setPage}
            onPageSizeChange={controller.setPageSize}
            pageSizeOptions={[5, 10, 15, 20]}
          />
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Search, filter, sort and page all live in the URL — copy the address bar and the view comes
        back. Resize below 768px and the grid becomes cards without losing a column.
      </p>
    </div>
  );
}

/* ── Overlays ───────────────────────────────────────────────────────────── */

function OverlaySection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const toast = useToast();

  const runConfirm = () => {
    setPending(true);
    setTimeout(() => {
      setPending(false);
      setConfirmOpen(false);
      toast.success('Access revoked', 'Dave Nguyen can no longer book for Oran Park.');
    }, 900);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Dialog, drawer, confirmation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setDialogOpen(true);
              }}
            >
              Open dialog
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDrawerOpen(true);
              }}
            >
              Open drawer
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              Destructive action
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            All three are the native <code>&lt;dialog&gt;</code> element, so focus is trapped,
            Escape closes, the background is inert, and nothing can be clipped by an ancestor’s
            overflow. Try Tab and Escape in each.
          </p>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
        }}
        title="Invite a user"
        description="They’ll get a one-time code — there are no passwords in this product."
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setDialogOpen(false);
                toast.success('Invitation sent', 'They’ll receive a link within a minute.');
              }}
            >
              Send invitation
            </Button>
          </>
        }
      >
        <div className="space-y-4 py-2">
          <Field id="demo-invite-email" label="Email or mobile" required>
            {(control) => <Input {...control} placeholder="you@company.com.au" />}
          </Field>
          <Field id="demo-invite-role" label="Role" hint="Decides which surface they land on.">
            {(control) => (
              <Select {...control}>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>

      <Drawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        title="Filters"
        description="A drawer reads as “alongside”; a dialog reads as “instead of”."
      >
        <div className="space-y-4">
          <Field id="demo-drawer-zone" label="Zone">
            {(control) => (
              <Select {...control}>
                <option>All zones</option>
                <option>Sydney</option>
                <option>Wollongong</option>
                <option>Newcastle</option>
              </Select>
            )}
          </Field>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox defaultChecked />
            Include completed jobs
          </label>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => {
          setConfirmOpen(false);
        }}
        onConfirm={runConfirm}
        title="Revoke site access?"
        description="Dave Nguyen will no longer be able to book pickups for Oran Park. Jobs already booked are unaffected."
        confirmLabel="Revoke access"
        tone="destructive"
        pending={pending}
      />
    </div>
  );
}

/* ── Forms ──────────────────────────────────────────────────────────────── */

function FormSection() {
  const [notify, setNotify] = useState(true);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Field states</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-2">
        <Field id="demo-ok" label="Account name" required hint="As it appears on the invoice.">
          {(control) => <Input {...control} defaultValue="iPlasta Pty Ltd" />}
        </Field>

        <Field
          id="demo-error"
          label="Mobile number"
          required
          error="Enter a valid Australian mobile number, e.g. 0412 345 678"
        >
          {(control) => <Input {...control} defaultValue="04123" />}
        </Field>

        <Field id="demo-select" label="Capture configuration" hint="m² only, or m² and kg.">
          {(control) => (
            <Select {...control}>
              <option>m² only</option>
              <option>m² and kg</option>
            </Select>
          )}
        </Field>

        <Field id="demo-disabled" label="Customer code" hint="Assigned on creation.">
          {(control) => <Input {...control} defaultValue="IPL001" disabled />}
        </Field>

        <Field id="demo-textarea" label="Site access notes" className="md:col-span-2">
          {(control) => (
            <Textarea {...control} placeholder="Gate code, crane window, induction requirements…" />
          )}
        </Field>

        <div className="space-y-3 md:col-span-2">
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox defaultChecked /> Require a purchase order before invoicing
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox indeterminate /> Some sites selected
          </label>
          <div className="flex items-center gap-3 text-sm">
            <Switch
              checked={notify}
              onCheckedChange={setNotify}
              id="demo-switch"
              aria-label="Send completion emails"
            />
            <label htmlFor="demo-switch">Send completion emails with photos</label>
          </div>
        </div>

        <p className="text-xs text-muted-foreground md:col-span-2">
          Every control above is wired through <code>Field</code>, which cannot render without
          receiving <code>aria-invalid</code>, <code>aria-describedby</code> and the hint/error id
          pair. Errors are announced, not just coloured.
        </p>
      </CardContent>
    </Card>
  );
}

/* ── Feedback ───────────────────────────────────────────────────────────── */

function FeedbackSection() {
  const toast = useToast();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Toasts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                toast.success('Invitation sent', 'Dave Nguyen will get a link within a minute.');
              }}
            >
              Success
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                toast.error(
                  'Could not save the account',
                  'No connection. Your changes are still on the page.',
                );
              }}
            >
              Error (sticky)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                toast.warning('Rate card expires in 7 days', 'Clarendon’s schedule ends 1 Sep.');
              }}
            >
              Warning
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                toast.toast({
                  title: 'Export ready',
                  description: '312 rows, 1.2 MB.',
                  variant: 'info',
                  action: {
                    label: 'Download',
                    onClick: () => {
                      toast.success('Download started');
                    },
                  },
                });
              }}
            >
              With action
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            Errors do not auto-dismiss — a failure the user missed is a failure they will hit again,
            and with no error tracking on this project the toast may be the only record. Hovering
            any toast pauses its timer.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert variant="info" title="Contract freezes at day 3">
            Two consumers depend on it, one of them a separate Flutter repo.
          </Alert>
          <Alert variant="success" title="Pricing harness passing">
            300 of 300 invoices matched to the cent.
          </Alert>
          <Alert variant="warning" title="Redis is disabled">
            Queues are off, so reminders will not send.
          </Alert>
          <Alert variant="destructive" title="Driver sync stalled">
            Troy Holm’s device last synced 4 hours ago with 12 queued actions.
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Loading</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Spinner />
            <Button disabled>
              <Spinner className="text-current" />
              Saving…
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <SkeletonText lines={3} />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

function FormattingSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Money and time</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Alert variant="warning" title="Two constraints enforced in code, not by convention">
          Money is a decimal string and never a JavaScript number — JSON numbers are doubles and
          silently lose cents. Timestamps are stored UTC and rendered {TIMEZONE_LABEL}, because the
          migrated data arrives in NZST.
        </Alert>

        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
          {[
            ['formatMoney("220.00")', formatMoney('220.00')],
            ['formatMoney("1234567.5")', formatMoney('1234567.5')],
            ['formatMoney("-99.9")', formatMoney('-99.9')],
            ['formatMoney(null)', formatMoney(null)],
            ['formatDateTime(now)', formatDateTime(new Date().toISOString())],
            ['formatMobile("0412345678")', formatMobile('0412345678')],
          ].map(([label, value]) => (
            <div key={label} className="col-span-full grid grid-cols-subgrid">
              <dt className="font-mono text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
