import {
  PORTAL_SUPERVISOR_STATE_LABELS,
  type PortalSupervisor,
  type PortalSupervisorState,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Pagination,
  Spinner,
  useToast,
  type BadgeProps,
} from '@plastago/ui';
import { CheckCircle2Icon, MoreHorizontalIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import {
  usePortalApproveSupervisor,
  usePortalInviteSupervisor,
  usePortalSetSupervisorState,
} from '@/features/portal/queries';
import { usePortalSupervisors } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMobile, formatRelative } from '@/lib/format';

/**
 * Site supervisors (M5.14 · W70) — Customer Administrator only.
 *
 * ── This screen removes PlastaGo from the loop ────────────────────────────
 * Adding a site supervisor is currently a phone call to the office. M5.14 hands
 * it to the customer, which is faster for them and one fewer interruption for
 * PlastaGo — and it is the reason head-office-organised accounts like Clarendon
 * and Domaine will actually adopt the portal.
 *
 * ── Mobile before email, deliberately ─────────────────────────────────────
 * §9 makes SMS the primary channel for a site supervisor, and B.4's own caveat is
 * that *"many site supervisors and subcontractors use personal Gmail addresses or
 * only have a mobile"*. So the invite form takes either, requires at least one,
 * and puts mobile first.
 *
 * ── B.2's safety valve is visible, not buried ─────────────────────────────
 * Someone can join by customer code, and on accounts that require approval those
 * joins land here awaiting one. They sort to the top: a safety valve nobody sees
 * is not a safety valve.
 */
const FILTER_KEYS = ['state', 'approval'] as const;

const STATE_VARIANT: Record<PortalSupervisorState, BadgeProps['variant']> = {
  active: 'success',
  invited: 'warning',
  suspended: 'destructive',
};

const STATIC_FILTERS: readonly FilterDefinition[] = [
  {
    key: 'state',
    label: 'Status',
    allLabel: 'All supervisors',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'invited', label: 'Invited, not signed in' },
      { value: 'suspended', label: 'Suspended' },
    ],
  },
  {
    key: 'approval',
    label: 'Approval',
    allLabel: 'Any',
    options: [
      { value: 'awaiting', label: 'Awaiting your approval' },
      { value: 'settled', label: 'Approved' },
    ],
  },
];

export function PortalSupervisorsPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultPageSize: 20 });
  const { data, error, isPending, isFetching, refetch } = usePortalSupervisors(controller.query);

  const approve = usePortalApproveSupervisor();
  const setState = usePortalSetSupervisorState();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [suspending, setSuspending] = useState<PortalSupervisor | null>(null);

  const rows = data?.data ?? [];
  const awaiting = rows.filter((row) => row.awaitingApproval);

  const runApprove = async (supervisor: PortalSupervisor) => {
    try {
      await approve.mutateAsync(supervisor.id);
      toast.success(
        `${supervisor.name} approved`,
        'They can book pickups for their sites straight away.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const runSetState = async (supervisor: PortalSupervisor, state: PortalSupervisorState) => {
    try {
      await setState.mutateAsync({ id: supervisor.id, state });
      toast.success(
        state === 'suspended' ? `${supervisor.name} suspended` : `${supervisor.name} reactivated`,
        state === 'suspended'
          ? 'They can no longer sign in. Pickups they already booked are unaffected.'
          : 'They can sign in again with a code.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setSuspending(null);
    }
  };

  const columns: readonly DataTableColumn<PortalSupervisor>[] = [
    {
      id: 'name',
      header: 'Name',
      sortKey: 'name',
      priority: 'primary',
      cell: (row) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{row.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.mobile !== null ? formatMobile(row.mobile) : (row.email ?? '—')}
          </span>
        </span>
      ),
    },
    {
      id: 'state',
      header: 'Status',
      priority: 'secondary',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATE_VARIANT[row.state]}>
            {PORTAL_SUPERVISOR_STATE_LABELS[row.state]}
          </Badge>
          {row.awaitingApproval && <Badge variant="warning">Needs approval</Badge>}
        </span>
      ),
    },
    {
      id: 'lastSignedInAt',
      header: 'Last signed in',
      sortKey: 'lastSignedInAt',
      priority: 'detail',
      cell: (row) =>
        row.lastSignedInAt === null ? (
          <span className="text-xs text-muted-foreground">Never</span>
        ) : (
          <span className="text-sm" title={formatDateTime(row.lastSignedInAt)}>
            {formatRelative(row.lastSignedInAt)}
          </span>
        ),
    },
    {
      id: 'invitedAt',
      header: 'Added',
      sortKey: 'invitedAt',
      priority: 'detail',
      cell: (row) => <span className="tabular-nums">{formatDateTime(row.invitedAt)}</span>,
    },
    {
      id: 'actions',
      header: 'Manage',
      priority: 'secondary',
      className: 'w-28',
      cell: (row) => (
        <Menu
          align="end"
          triggerLabel={`Manage ${row.name}`}
          triggerClassName="focus-ring grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
        >
          {row.awaitingApproval && (
            <>
              <MenuItem
                icon={CheckCircle2Icon}
                onSelect={() => {
                  void runApprove(row);
                }}
              >
                Approve access
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {row.state === 'suspended' ? (
            <MenuItem
              onSelect={() => {
                void runSetState(row, 'active');
              }}
            >
              Reactivate
            </MenuItem>
          ) : (
            <MenuItem
              tone="destructive"
              onSelect={() => {
                setSuspending(row);
              }}
            >
              Suspend access
            </MenuItem>
          )}
        </Menu>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Site supervisors</h1>
          <p className="text-sm text-muted-foreground">
            Add the people who book pickups, and choose which sites each of them can see.
          </p>
        </div>
        <Button
          onClick={() => {
            setInviteOpen(true);
          }}
        >
          <UserPlusIcon aria-hidden />
          Add a supervisor
        </Button>
      </header>

      {awaiting.length > 0 && (
        <Alert variant="warning" title={`${awaiting.length} person awaiting your approval`}>
          {awaiting.map((row) => row.name).join(', ')} joined using your customer code. Approve them
          and they can book straight away; leave them and they cannot sign in.
        </Alert>
      )}

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search name, mobile, email or site…"
          filters={STATIC_FILTERS}
        />

        <DataTable
          caption="Your site supervisors"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.id}
          isPending={isPending}
          isFetching={isFetching && !isPending}
          error={error}
          onRetry={() => void refetch()}
          sort={controller.sort}
          onToggleSort={controller.toggleSort}
          isFiltered={controller.isFiltered}
          onClearFilters={controller.clearFilters}
          empty={{
            icon: UsersIcon,
            title: 'No supervisors yet',
            description:
              'Add the people on site who need to book pickups. They sign in with a code by text — no app, no password.',
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

      <Alert variant="info" title="Two other ways people get in">
        Every site has a shareable booking link — paste it into a site group and whoever taps it can
        book for <em>that site only</em>. People can also join with your customer code, which lands
        here for your approval if you want the control.
      </Alert>

      <InviteDialog
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
        }}
      />

      <ConfirmDialog
        open={suspending !== null}
        onCancel={() => {
          setSuspending(null);
        }}
        onConfirm={() => {
          if (suspending) void runSetState(suspending, 'suspended');
        }}
        title={suspending ? `Suspend ${suspending.name}?` : 'Suspend access?'}
        description="They will not be able to sign in or book. Pickups they have already booked are unaffected, and you can reactivate them at any time."
        confirmLabel="Suspend access"
        pending={setState.isPending}
      />
    </div>
  );
}

/* ── The invite ───────────────────────────────────────────────────────────── */

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invite = usePortalInviteSupervisor();

  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = () => {
    setName('');
    setMobile('');
    setEmail('');
    setErrors({});
    onClose();
  };

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter their name so the team knows who this is.';

    const trimmedMobile = mobile.replace(/[\s()-]/g, '');
    if (!trimmedMobile && !email.trim()) {
      next.mobile = 'Give a mobile or an email. A mobile is usually faster on site.';
    } else if (trimmedMobile && !/^(?:\+?61|0)4\d{8}$/.test(trimmedMobile)) {
      next.mobile = 'Enter an Australian mobile, e.g. 0412 345 678.';
    }
    if (email.trim() && !email.includes('@')) {
      next.email = 'That does not look like an email address.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      const created = await invite.mutateAsync({
        name: name.trim(),
        email: email.trim(),
        mobile: mobile.trim(),
      });
      toast.success(
        `${created.name} invited`,
        created.mobile !== null
          ? 'We have texted them a link — nothing to install.'
          : 'We have emailed them a link — nothing to install.',
      );
      close();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Add a site supervisor"
      description="They sign in with a one-time code — no password to manage and nothing to install."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={invite.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={invite.isPending}>
            {invite.isPending && <Spinner label="Inviting" />}
            <UserPlusIcon aria-hidden />
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="invite-name" label="Name" required error={errors.name}>
          {(control) => (
            <Input
              {...control}
              value={name}
              autoComplete="name"
              placeholder="Dave Nguyen"
              onChange={(event) => {
                setName(event.target.value);
                setErrors(({ name: _drop, ...rest }) => rest);
              }}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="invite-mobile"
            label="Mobile"
            error={errors.mobile}
            hint="The fastest route in — they get a code by text."
          >
            {(control) => (
              <Input
                {...control}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="0412 345 678"
                value={mobile}
                onChange={(event) => {
                  setMobile(event.target.value);
                  setErrors(({ mobile: _drop, ...rest }) => rest);
                }}
              />
            )}
          </Field>

          <Field
            id="invite-email"
            label="Email"
            error={errors.email}
            hint="Optional if you have given a mobile."
          >
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="email"
                placeholder="dave@example.com.au"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setErrors(({ email: _drop, ...rest }) => rest);
                }}
              />
            )}
          </Field>
        </div>

        <Alert variant="info" title="What they will and will not see">
          Supervisors can book pickups, confirm sites are ready, keep the access notes current and
          track progress. They cannot see pricing, invoices or any other builder&apos;s work.
        </Alert>
      </div>
    </Dialog>
  );
}
