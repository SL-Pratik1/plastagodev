import {
  ROLE_LABELS,
  ROLES,
  USER_STATUS_LABELS,
  USER_STATUSES,
  type UserListItem,
} from '@plastago/shared';
import {
  Button,
  Card,
  ConfirmDialog,
  Menu,
  MenuItem,
  MenuSeparator,
  Pagination,
  useToast,
} from '@plastago/ui';
import {
  BanIcon,
  CheckIcon,
  MoreHorizontalIcon,
  SendIcon,
  UserPlusIcon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';
import type { DataTableColumn, FilterDefinition } from '@/components/data-table/types';
import { useListQuery } from '@/components/data-table/use-list-query';
import { UserStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { UserFormDialog } from '@/features/users/components/user-form-dialog';
import { useAccountOptions } from '@/features/lookups/queries';
import { useResendInvite, useSetUserStatus, useUser, useUserList } from '@/features/users/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMobile } from '@/lib/format';

/**
 * Users & access (M1.5 · W1, W2, W16).
 *
 * ── Worth flagging ────────────────────────────────────────────────────────
 * §13.2's ~22-screen admin inventory does not itemise a users screen, yet W2
 * ("Manage user accounts") and W16 ("Configure user permissions") are both IN,
 * and §9 commits to session management, device registration for drivers and an
 * audit of all logins. So this screen is required by the scope even though the
 * screen list omits it — raised rather than silently built or silently skipped.
 *
 * ── No delete ─────────────────────────────────────────────────────────────
 * Suspend, never remove. Every state change is audited (M1.6) and a user who
 * booked jobs last year must still be attributable — deleting the row would
 * orphan that history. "Suspended" is the destructive action, and it is
 * reversible.
 */
const FILTER_KEYS = ['role', 'status', 'account'] as const;

export function AdminUsersPage() {
  const toast = useToast();
  const controller = useListQuery({ filterKeys: FILTER_KEYS, defaultSort: 'name' });
  const { data, error, isPending, isFetching, refetch } = useUserList(controller.query);
  const accounts = useAccountOptions();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<UserListItem | null>(null);

  const editing = useUser(editingId ?? undefined);
  const setStatus = useSetUserStatus();
  const resendInvite = useResendInvite();

  const filters: readonly FilterDefinition[] = [
    {
      key: 'role',
      label: 'Role',
      allLabel: 'All roles',
      options: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
    },
    {
      key: 'status',
      label: 'Status',
      allLabel: 'All statuses',
      options: USER_STATUSES.map((status) => ({
        value: status,
        label: USER_STATUS_LABELS[status],
      })),
    },
    {
      key: 'account',
      label: 'Account',
      allLabel: 'All accounts',
      options: (accounts.data ?? []).map((option) => ({
        value: option.value,
        label: option.label,
      })),
    },
  ];

  const changeStatus = async (user: UserListItem, status: UserListItem['status']) => {
    try {
      await setStatus.mutateAsync({ id: user.id, status });
      toast.success(
        status === 'suspended' ? `${user.name} suspended` : `${user.name} reactivated`,
        status === 'suspended' ? 'They can no longer sign in.' : 'They can sign in again.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    } finally {
      setSuspendTarget(null);
    }
  };

  const invite = async (user: UserListItem) => {
    try {
      await resendInvite.mutateAsync(user.id);
      toast.success('Invitation resent', `Sent to ${user.email ?? formatMobile(user.mobile)}.`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const columns: readonly DataTableColumn<UserListItem>[] = [
    {
      id: 'name',
      header: 'Name',
      sortKey: 'name',
      priority: 'primary',
      cell: (row) => (
        <span className="block">
          <span className="font-medium">{row.name}</span>
          <span className="block text-xs text-muted-foreground">
            {row.email ?? formatMobile(row.mobile)}
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortKey: 'role',
      priority: 'secondary',
      cell: (row) => <span className="text-sm">{ROLE_LABELS[row.role]}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      sortKey: 'status',
      priority: 'secondary',
      cell: (row) => <UserStatusBadge status={row.status} />,
    },
    {
      id: 'account',
      header: 'Account',
      sortKey: 'account',
      priority: 'detail',
      cell: (row) => <span className="text-muted-foreground">{row.accountName ?? '—'}</span>,
    },
    {
      id: 'lastSignedInAt',
      header: 'Last sign-in',
      sortKey: 'lastSignedInAt',
      priority: 'detail',
      cell: (row) => (
        <span className="text-muted-foreground">
          {row.status === 'invited'
            ? 'Never — invitation pending'
            : formatDateTime(row.lastSignedInAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      className: 'w-14',
      cell: (row) => (
        <Menu
          align="end"
          triggerLabel={`Actions for ${row.name}`}
          triggerClassName="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          trigger={<MoreHorizontalIcon aria-hidden className="size-4" />}
        >
          <MenuItem
            onSelect={() => {
              setEditingId(row.id);
              setFormOpen(true);
            }}
          >
            Edit user
          </MenuItem>
          {row.status === 'invited' && (
            <MenuItem
              icon={SendIcon}
              onSelect={() => {
                void invite(row);
              }}
            >
              Resend invitation
            </MenuItem>
          )}
          <MenuSeparator />
          {row.status === 'suspended' ? (
            <MenuItem
              icon={CheckIcon}
              onSelect={() => {
                void changeStatus(row, 'active');
              }}
            >
              Reactivate
            </MenuItem>
          ) : (
            <MenuItem
              icon={BanIcon}
              tone="destructive"
              onSelect={() => {
                setSuspendTarget(row);
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
    <div className="space-y-6">
      <PageHeader
        title="Users & access"
        description="The seven roles, who holds them, and the record of who signed in from where."
        actions={
          <Button
            onClick={() => {
              setEditingId(null);
              setFormOpen(true);
            }}
          >
            <UserPlusIcon aria-hidden />
            Invite user
          </Button>
        }
      />

      <Card className="overflow-hidden p-0">
        <DataTableToolbar
          controller={controller}
          searchPlaceholder="Search name, email, mobile or account…"
          filters={filters}
        />

        <DataTable
          caption="Users and roles"
          columns={columns}
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
          rowHref={(row) => `/admin/users/${row.id}`}
          empty={{
            icon: UsersIcon,
            title: 'No users yet',
            description: 'Invite your first user to get started.',
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

      <UserFormDialog
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingId(null);
        }}
        user={editingId ? (editing.data ?? null) : null}
      />

      <ConfirmDialog
        open={suspendTarget !== null}
        onCancel={() => {
          setSuspendTarget(null);
        }}
        onConfirm={() => {
          if (suspendTarget) void changeStatus(suspendTarget, 'suspended');
        }}
        title={`Suspend ${suspendTarget?.name ?? 'this user'}?`}
        description="They will not be able to sign in. Their history stays intact and you can reactivate them at any time."
        confirmLabel="Suspend access"
        tone="destructive"
        pending={setStatus.isPending}
      />
    </div>
  );
}
