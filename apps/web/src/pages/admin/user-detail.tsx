import { BRAND_LABELS, ROLE_LABELS, ROLE_PRIMARY_CHANNEL } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from '@plastago/ui';
import { LockIcon, PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { UserStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { UserFormDialog } from '@/features/users/components/user-form-dialog';
import { useAuth } from '@/features/auth/auth-context';
import { ROLE_CAPABILITIES } from '@/features/auth/permissions';
import { useUser } from '@/features/users/queries';
import { isCustomerRole } from '@/features/users/roles';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMobile } from '@/lib/format';

/**
 * Two tabs, deliberately.
 *
 * Devices and the sign-in log used to sit here as well. They are §9 material
 * and the API still returns both on the record, but on this screen they were
 * two tabs an administrator opened once and never again — the questions people
 * actually bring to a user row are "what can they reach" and "how do we contact
 * them". The device and login audit belongs with the security/audit surface
 * that owns it, not bolted to a person's profile.
 */
const TABS = ['overview', 'permissions'] as const;
type TabKey = (typeof TABS)[number];

/**
 * One user (M1.5 · W2, W16, and the §9 session/audit commitments).
 *
 * The active tab lives in the URL so a link to someone's login history opens on
 * that tab rather than making the recipient hunt for it.
 */
export function AdminUserDetailPage() {
  const { userId } = useParams();
  const [params, setParams] = useSearchParams();
  const [editOpen, setEditOpen] = useState(false);
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManageAll = can('users:manage');

  const { data: user, error, isPending, refetch } = useUser(userId);

  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'overview';

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === 'overview') nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  const breadcrumbs = [
    { label: canManageAll ? 'Users & access' : 'Customer users', to: '/admin/users' },
  ];

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="User" breadcrumbs={breadcrumbs} />
        <Card>
          <ErrorState
            title={described.title}
            description={described.detail}
            onRetry={() => void refetch()}
          />
        </Card>
      </div>
    );
  }

  if (isPending || !user) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading…" breadcrumbs={breadcrumbs} />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-32 w-full" />
        </Card>
      </div>
    );
  }

  /*
   * A narrowed seat (`users:manage-customers`) reaches this route by the same
   * guard as the administrator, because both open the users screen. The grid
   * never offers it a staff row — but a pasted link, a bookmark or the browser's
   * back button can, and rendering an office worker's devices and sign-in
   * history there would undo the whole narrowing. So the record is refused here,
   * where the row's role is finally known.
   */
  if (!canManageAll && !isCustomerRole(user.role)) {
    return (
      <div className="space-y-6">
        <PageHeader title="User" breadcrumbs={breadcrumbs} />
        <Card>
          <EmptyState
            icon={LockIcon}
            title="This is a staff account"
            description="You can view and manage customer administrators and site supervisors. Office, allocator and driver accounts are the administrator's."
            action={
              <Button variant="outline" onClick={() => navigate('/admin/users')}>
                Back to customer users
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  /*
   * The union of every role they hold, not just the main one.
   *
   * Matt's driver manager is an allocator who also drives (27:01). Reading the
   * main role alone hid `driver:access` from this list, so the screen said he
   * could not open the driver app on the very day he is covering a shift —
   * the one question this tab exists to answer.
   */
  const heldRoles = [user.role, ...user.roles.filter((held) => held !== user.role)];
  const capabilities = [...new Set(heldRoles.flatMap((held) => ROLE_CAPABILITIES[held]))];
  const signsInBy = ROLE_PRIMARY_CHANNEL[user.role];

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.name}
        breadcrumbs={breadcrumbs}
        description={`${ROLE_LABELS[user.role]}${user.jobTitle ? ` · ${user.jobTitle}` : ''}`}
        badge={<UserStatusBadge status={user.status} />}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              setEditOpen(true);
            }}
          >
            <PencilIcon aria-hidden />
            Edit
          </Button>
        }
      />

      {user.status === 'invited' && (
        <Alert variant="warning" title="Invitation not yet accepted">
          They have never signed in. Activation rate across an account is a go-live gate, so this is
          worth chasing rather than assuming.
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="User sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
        </TabsList>

        <TabsPanel value="overview">
          <Card>
            <CardContent className="pt-5">
              <DetailList
                columns={3}
                items={[
                  /*
                   * Each blank says which of the two it is: nothing was ever
                   * recorded, or nothing is expected for this role. A dash made
                   * "no email because they sign in by SMS" look identical to
                   * "somebody forgot the email", and only one of those is worth
                   * chasing.
                   */
                  {
                    label: 'Email',
                    value:
                      user.email ??
                      (signsInBy === 'sms' ? 'Not provided — signs in by SMS' : 'Not provided'),
                  },
                  {
                    label: 'Mobile',
                    value: formatMobile(
                      user.mobile,
                      signsInBy === 'email' ? 'Not provided — signs in by email' : 'Not provided',
                    ),
                  },
                  {
                    label: user.roles.length > 1 ? 'Roles' : 'Role',
                    // Both roles listed, main one first. A driver manager who
                    // covers shifts holds two (Matt, 27:01) and the second one
                    // is not a detail — it is why he can open the driver app.
                    value: [user.role, ...user.roles.filter((held) => held !== user.role)]
                      .map((held) => ROLE_LABELS[held])
                      .join(' · '),
                  },
                  {
                    label: 'Account',
                    value:
                      user.accountName ??
                      (isCustomerRole(user.role)
                        ? 'No account linked — the portal will show them nothing'
                        : 'Not applicable — staff roles are not tied to an account'),
                  },
                  {
                    label: 'Brands',
                    value: (
                      <span className="flex flex-wrap gap-1">
                        {user.brandIds.map((brand) => (
                          <Badge key={brand} variant="secondary">
                            {BRAND_LABELS[brand]}
                          </Badge>
                        ))}
                      </span>
                    ),
                  },
                  {
                    label: 'Last sign-in',
                    value: formatDateTime(
                      user.lastSignedInAt,
                      user.status === 'invited' ? 'Never — invitation pending' : 'Never signed in',
                    ),
                  },
                  { label: 'Invited by', value: user.invitedBy ?? 'Not recorded' },
                  { label: 'Created', value: formatDateTime(user.createdAt, 'Not recorded') },
                  { label: 'Notes', value: user.notes || 'No notes', wide: true },
                ]}
              />
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="permissions">
          <Card>
            <CardHeader>
              <CardTitle>
              What {heldRoles.map((held) => ROLE_LABELS[held]).join(' + ')} can reach
            </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/*
                Read-only, and deliberately so. Permissions are held per ROLE, not
                per user — that is what makes them auditable and what stops the
                matrix drifting into 40 bespoke arrangements nobody can reason
                about. Changing what a role can do is a settings-level decision.
              */}
              <Alert variant="neutral" title="Permissions follow the role">
                Access is granted to a role, never to an individual. To change what this person can
                reach, change their role — or change the role’s permissions for everyone who holds
                it.
                {heldRoles.length > 1 && (
                  <>
                    {' '}
                    This person holds two roles, so the list below is everything both of them
                    reach.
                  </>
                )}
              </Alert>

              {capabilities.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This role has no console access. Drivers work in the separate driver app.
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  {capabilities.map((capability) => (
                    <li key={capability} className="flex items-center gap-2">
                      <span aria-hidden className="text-brand-500">
                        ✓
                      </span>
                      <code className="text-xs text-muted-foreground">{capability}</code>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

      </Tabs>

      <UserFormDialog
        open={editOpen}
        onClose={() => {
          setEditOpen(false);
        }}
        user={user}
      />
    </div>
  );
}
