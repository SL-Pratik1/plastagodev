import { BRAND_LABELS, ROLE_LABELS } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from '@plastago/ui';
import { PencilIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { UserStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { UserFormDialog } from '@/features/users/components/user-form-dialog';
import { ROLE_CAPABILITIES } from '@/features/auth/permissions';
import { useUser } from '@/features/users/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMobile, formatRelative } from '@/lib/format';

const TABS = ['overview', 'permissions', 'devices', 'sign-ins'] as const;
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

  const breadcrumbs = [{ label: 'Users & access', to: '/admin/users' }];

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

  const capabilities = ROLE_CAPABILITIES[user.role];

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
          <TabsTrigger value="devices" badge={user.devices.length || undefined}>
            Devices
          </TabsTrigger>
          <TabsTrigger value="sign-ins" badge={user.recentSignIns.length || undefined}>
            Sign-ins
          </TabsTrigger>
        </TabsList>

        <TabsPanel value="overview">
          <Card>
            <CardContent className="pt-5">
              <DetailList
                columns={3}
                items={[
                  { label: 'Email', value: user.email ?? '—' },
                  { label: 'Mobile', value: formatMobile(user.mobile) },
                  { label: 'Role', value: ROLE_LABELS[user.role] },
                  { label: 'Account', value: user.accountName ?? 'Not tied to an account' },
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
                    label: 'Sites visible',
                    value: user.siteCount === 0 ? 'All (staff role)' : user.siteCount,
                  },
                  { label: 'Last sign-in', value: formatDateTime(user.lastSignedInAt) },
                  { label: 'Invited by', value: user.invitedBy ?? '—' },
                  { label: 'Created', value: formatDateTime(user.createdAt) },
                  { label: 'Notes', value: user.notes || '—', wide: true },
                ]}
              />
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="permissions">
          <Card>
            <CardHeader>
              <CardTitle>What {ROLE_LABELS[user.role]} can reach</CardTitle>
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
              </Alert>

              {capabilities.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This role has no console access. Drivers work in the separate driver app.
                </p>
              ) : (
                <ul className="grid gap-2 text-sm sm:grid-cols-2">
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

        <TabsPanel value="devices">
          <Card>
            <CardHeader>
              <CardTitle>Registered devices</CardTitle>
            </CardHeader>
            <CardContent>
              {user.devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No registered devices. Only the driver app registers a device.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {user.devices.map((device) => (
                    <li key={device.id} className="flex items-center gap-3 py-3">
                      <SmartphoneIcon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{device.label}</p>
                        <p className="text-xs text-muted-foreground">
                          Last seen {formatRelative(device.lastSeenAt)} · synced{' '}
                          {formatRelative(device.lastSyncAt)}
                        </p>
                      </div>
                      {/* §6A.8 — a stuck offline queue has to be visible here. */}
                      <Badge variant={device.pendingSyncActions > 0 ? 'warning' : 'success'}>
                        {device.pendingSyncActions > 0
                          ? `${String(device.pendingSyncActions)} queued`
                          : 'In sync'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="sign-ins">
          <Card>
            <CardHeader>
              <CardTitle>Recent sign-ins</CardTitle>
            </CardHeader>
            <CardContent>
              {user.recentSignIns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sign-ins recorded yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {user.recentSignIns.map((signIn) => (
                    <li
                      key={signIn.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm"
                    >
                      <span className="font-medium tabular-nums">{formatDateTime(signIn.at)}</span>
                      <Badge variant="outline">
                        {signIn.channel === 'sms' ? 'SMS code' : 'Email code'}
                      </Badge>
                      <Badge variant={signIn.outcome === 'success' ? 'success' : 'destructive'}>
                        {signIn.outcome === 'success'
                          ? 'Signed in'
                          : signIn.outcome === 'failed-code'
                            ? 'Wrong code'
                            : signIn.outcome === 'expired-code'
                              ? 'Code expired'
                              : 'Locked out'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{signIn.device}</span>
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
