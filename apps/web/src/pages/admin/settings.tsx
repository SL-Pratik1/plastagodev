import {
  BRAND_IDS,
  BRAND_LABELS,
  INVOICE_LAYOUT_DESCRIPTIONS,
  INVOICE_LAYOUT_LABELS,
  INVOICE_LAYOUTS,
  ROLE_LABELS,
  ROLES,
  type AdditionalServiceSetting,
  type BrandId,
  type InvoiceLayout,
  type InvoiceTemplate,
  type InvoiceTemplateWrite,
  type InvoicingSettings,
  type RateCardSummary,
  type RateSchedule,
  type Settings,
  type ZoneSummary,
  type ZoneRateInput,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  Textarea,
  cn,
  useToast,
} from '@plastago/ui';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  ImageIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useZoneOptions } from '@/features/lookups/queries';
import type { ZoneOption } from '@/services/types';
import { PageHeader } from '@/components/page-header';
import { UnsavedBar } from '@/components/unsaved-bar';
import { CAPABILITY_GROUPS, ROLE_CAPABILITIES, can } from '@/features/auth/permissions';
import {
  useCreateAdditionalService,
  useDeleteSchedule,
  usePreviewTemplate,
  useRemoveLogo,
  useUploadLogo,
  useCreateInvoiceTemplate,
  useCreateRateCard,
  useDeleteAdditionalService,
  useDeleteInvoiceTemplate,
  useDeleteRateCard,
  useIssueSchedule,
  useRenameRateCard,
  useSaveInvoicingSettings,
  useSettings,
  useUpdateAdditionalService,
  useUpdateInvoiceTemplate,
  useArchiveZone,
  useCreateZone,
  useRenameZone,
  useReorderZones,
  useRestoreZone,
} from '@/features/settings/queries';
import { describeError } from '@/lib/error-message';
import { formatMoney } from '@/lib/format';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';

const TABS = ['roles', 'pricing', 'invoicing'] as const;
type TabKey = (typeof TABS)[number];

/** The tab shown when the URL carries no `?tab=`, and the one it omits. */
const DEFAULT_TAB: TabKey = 'roles';

/**
 * Settings (W3), plus brands (M1.1), rate cards (M6) and invoice branding
 * (M7.5).
 *
 * ── Editable versus stated ─────────────────────────────────────────────────
 * Several things that belong on a settings screen are not settings, and a text
 * box around them would be a lie:
 *
 *  • **Rate cards are effective-dated** (M6.2): changing a rate means issuing a
 *    new schedule, never overwriting the old one, because pricing a job uses the
 *    rates in force on that job's date. Editing them here would silently reprice
 *    history — and pricing correctness is the highest-rated risk in the project.
 *
 * ── There is no General tab ───────────────────────────────────────────────
 * It held three cards and only one control. Timezone, data residency, the
 * retention floor and the two number sequences were read-only facts the office
 * never has to look up, and the zones card duplicated Pricing. That left the
 * SLA with a tab to itself, which the client did not want.
 *
 * ⚠️ So the SLA is settable by seed or migration only — the `general` block and
 * its route are gone from the contract entirely (see the note in
 * `@plastago/shared`'s settings schema). The VALUE is still live: it is what
 * every job's target date is computed from, read through
 * `settingsRepository.slaBusinessDays()`. Re-homing it on another tab means
 * adding a route back, not just a field.
 *
 * ── Three sections were removed for the same reason ───────────────────────
 * Notifications, Integrations and Driver credential types are gone, and so is
 * the Margin assumption card. Each was a control over a value nothing read:
 *
 *  • the per-event SMS/email matrix was never consulted — `outboundService`
 *    picks a channel from the RECIPIENT's own M8.4 preferences
 *  • the integrations board could configure nothing, and its "test connection"
 *    button recorded an outcome instead of performing a check
 *  • credential-type lead times reached no reminder
 *  • the margin card was read-only prose around one number
 *
 * ⚠️ Two of those VALUES are still live and must not be mistaken for dead:
 * `assumedCostPerJob` is what every figure on the financial summary report is
 * computed from (seed-time now), and driver credentials themselves — licences,
 * tickets, expiry states — are untouched on the driver profile. So is the
 * notification centre, the bell, and all outbound email and SMS.
 *
 * ── The invoice-template trap ─────────────────────────────────────────────
 * Branding and content control are in scope: bank details, footer and the
 * member badge are editable here today. Layout authoring is not — there is
 * deliberately no concept of a band, expression or drag-and-drop canvas
 * anywhere on this screen. That absence is the design.
 */
export function AdminSettingsPage() {
  const [params, setParams] = useSearchParams();
  const { data, error, isPending, refetch } = useSettings();

  const rawTab = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : DEFAULT_TAB;

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === DEFAULT_TAB) nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
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

  if (isPending || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-48 w-full" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="The values the whole platform reads, and the brands it trades under."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Settings sections">
          <TabsTrigger value="roles">Users & roles</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="invoicing">Invoicing</TabsTrigger>
        </TabsList>

        {/*
          Each editable section is keyed on its own saved slice, so a successful
          save remounts it and the form re-initialises from the new values. That
          is React's documented way to reset state when data changes — the
          alternative, an effect that calls setState, cascades a render and was
          what the linter caught here.
        */}
        <TabsPanel value="roles">
          <RolesSection />
        </TabsPanel>
        <TabsPanel value="pricing">
          <PricingSection settings={data} />
        </TabsPanel>
        <TabsPanel value="invoicing">
          {/*
            ⚠️ Keyed on the WRITABLE fields, not on `data.invoicing`.

            That object now carries `logoUrl`, which is a freshly signed
            storage link minted on every read — so keying on the whole thing
            produced a new key on every refetch, remounting this section and
            discarding whatever the administrator was halfway through typing.
            A derived, non-deterministic value must never reach an identity
            comparison.
          */}
          <InvoicingSection key={JSON.stringify(writable(data.invoicing))} settings={data} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}

/* ── Users & roles ───────────────────────────────────────────────────────── */

function RolesSection() {
  /* Groups start open; the portal block is the one an office admin rarely needs. */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Roles and permissions</CardTitle>
          <CardDescription>
            Access is granted to a role, never to an individual — that is what makes it auditable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/*
            Read-only by design, and deliberately NOT checkboxes.

            A checkbox is a promise that clicking it changes something. This
            matrix is compiled into the build — the row a capability sits on is
            reviewed in a pull request, not toggled at 6pm on a Friday — so a
            checkbox here would be a control that silently does nothing, which
            is worse than the bare count it replaced.

            The count alone was the actual defect: "Operations — 18" cannot
            answer the only question this card exists for, which is *why can the
            allocator not see prices*. Reading down the "See prices" row answers
            it in about two seconds.
          */}
          {/*
            `relative` is load-bearing, not decoration.

            The cells carry `sr-only` labels, and `sr-only` positions absolutely.
            With no positioned ancestor those resolve against the INITIAL
            containing block rather than this scroller — so they sat out at the
            table's full 1437px width, outside the clip, and dragged the whole
            document to 1383px. Settings was the only screen in the console that
            scrolled sideways below 1400px, and the table itself was innocent: it
            was already being clipped correctly.
          */}
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">
                Capabilities by role. A tick means the role holds that capability; a dash means it
                does not.
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="w-[17rem] py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Capability
                  </th>
                  {ROLES.map((role) => (
                    <th
                      key={role}
                      scope="col"
                      className="px-1 py-2 align-bottom text-center text-xs font-semibold text-muted-foreground"
                    >
                      {ROLE_LABELS[role]}
                    </th>
                  ))}
                </tr>
              </thead>
              {CAPABILITY_GROUPS.map((group) => {
                const collapsed = collapsedGroups.has(group.title);
                return (
                  <tbody key={group.title} className="border-b border-border last:border-b-0">
                    <tr>
                      <th
                        scope="colgroup"
                        colSpan={ROLES.length + 1}
                        className="bg-muted/40 px-0 py-0 text-left"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Set(collapsedGroups);
                            if (collapsed) next.delete(group.title);
                            else next.add(group.title);
                            setCollapsedGroups(next);
                          }}
                          aria-expanded={!collapsed}
                          className="focus-ring flex w-full items-center gap-2 px-2 py-2 text-left"
                        >
                          <ChevronDownIcon
                            className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                              collapsed ? '-rotate-90' : ''
                            }`}
                            aria-hidden
                          />
                          <span className="text-sm font-semibold">{group.title}</span>
                          <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
                            {group.note}
                          </span>
                        </button>
                      </th>
                    </tr>

                    {!collapsed &&
                      group.capabilities.map(({ capability, label }) => (
                        <tr key={capability} className="border-t border-border/60">
                          <th
                            scope="row"
                            className="py-2 pr-3 text-left font-normal"
                            title={capability}
                          >
                            {label}
                          </th>
                          {ROLES.map((role) => {
                            const held = can(role, capability);
                            return (
                              <td key={role} className="px-1 py-2 text-center">
                                <span
                                  className={
                                    held ? 'font-medium text-primary' : 'text-muted-foreground/40'
                                  }
                                >
                                  {held ? '✓' : '—'}
                                </span>
                                <span className="sr-only">
                                  {ROLE_LABELS[role]}: {held ? 'yes' : 'no'}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                  </tbody>
                );
              })}
              <tfoot>
                <tr className="border-t-2 border-border">
                  <th scope="row" className="py-2 text-left text-xs font-semibold uppercase">
                    Total capabilities
                  </th>
                  {ROLES.map((role) => (
                    <td
                      key={role}
                      className="px-1 py-2 text-center text-sm font-medium tabular-nums"
                    >
                      {ROLE_CAPABILITIES[role].length}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <Alert variant="neutral" title="Mirrors their existing security groups">
            The seven roles match the groups they already use, so nothing has to be re-learned. This
            table is a reference, not a control — the rows are fixed in the build so that a change
            to what a role may reach is reviewed rather than clicked. To change what one person can
            reach, change their role on{' '}
            <Link
              to="/admin/users"
              className="focus-ring rounded text-primary underline underline-offset-4"
            >
              Users
            </Link>
            .
          </Alert>
        </CardContent>
      </Card>

      {/*
        The "Driver credential types" card used to sit here. It set a reminder
        lead time per credential type — and nothing ever read one, so no
        reminder was ever sent from it.

        ⚠️ Driver credentials THEMSELVES are untouched: licences, tickets,
        medicals, their expiry states and the "expiring this month" filter are
        all still on the driver profile and the Drivers list. What went is the
        settings register above them, not the compliance data.
      */}
    </div>
  );
}

/* ── Pricing ─────────────────────────────────────────────────────────────── */

function PricingSection({ settings }: { settings: Settings }) {
  const [newCardOpen, setNewCardOpen] = useState(false);

  /*
   * The zone register, read once for the whole tab.
   *
   * ⚠️ Two different lists, deliberately. `zoneOptions` is what a NEW schedule
   * may price — live zones only, because a retired zone must not acquire a
   * future price. `zoneLabels` names every zone ever, including retired ones,
   * because an existing card may still carry a row for one.
   */
  const allZones = useZoneOptions().data ?? [];
  const zoneOptions = allZones.filter((zone) => !zone.archived);
  const zoneLabels = new Map(allZones.map((zone) => [zone.value, zone.label]));

  /*
   * Remounts both dialogs when the register changes, so a grid seeded on mount
   * cannot be left showing a stale set of zones — see the note on the seed.
   */
  const zoneKey = zoneOptions.map((zone) => zone.value).join(',');

  return (
    <div className="space-y-4">
      {/*
        Editable, but only through the one operation that is safe.

        Rates are effective-dated: pricing a job reads the rates in force on
        that job's date. So there is no "edit these rates" control anywhere on
        this tab — changing a price means ISSUING A NEW SCHEDULE with its own
        start date, and the old one stays exactly as it was. Every job also
        carries a frozen copy of the rates it was priced on, so even deleting a
        card cannot move a figure on an invoice somebody has already been sent.
      */}
      <Alert variant="info" title="Changing a rate issues a new schedule — it never overwrites">
        Pricing a job always uses the rates in force on that job’s date, so reissuing or crediting
        a March invoice uses March’s rates. Add a schedule with a start date and the current one is
        closed the day before; nothing already priced moves.
      </Alert>

      {/*
        Zones FIRST, because they are the columns of everything below: a rate
        schedule prices one row per zone and the server refuses a partial one.
      */}
      <ZonesCard zones={settings.pricing.zones} />

      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <span>
            <CardTitle>Rate cards</CardTitle>
            <CardDescription>Resolution order is named card → tier → default.</CardDescription>
          </span>
          <Button
            size="sm"
            onClick={() => {
              setNewCardOpen(true);
            }}
          >
            <PlusIcon aria-hidden />
            New rate card
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {settings.pricing.rateCards.map((card) => (
            <RateCardRow
              key={card.id}
              card={card}
              zoneOptions={zoneOptions}
              zoneLabels={zoneLabels}
              zoneKey={zoneKey}
            />
          ))}

          {settings.pricing.rateCards.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No rate cards yet. Every account needs one before it can be priced.
            </p>
          )}
        </CardContent>
      </Card>

      <NewRateCardDialog
        /*
          ⚠️ Keyed on the zone ids, because the grid inside is seeded ONCE.

          `useState` runs its initialiser on mount and never again. Open this
          before the register lands and the grid seeds empty, then sits empty
          while the rest of the screen fills in — and the only clue is a Create
          button complaining about zones it is not showing. Remounting on a
          changed key is React's own answer; the alternative is an effect that
          calls setState and cascades a render.
        */
        key={zoneKey}
        zoneOptions={zoneOptions}
        zoneLabels={zoneLabels}
        open={newCardOpen}
        onClose={() => {
          setNewCardOpen(false);
        }}
      />

      <AdditionalServicesCard services={settings.pricing.additionalServices} />

      {/*
        The "Margin assumption" card used to sit here. It was two read-only
        facts and a paragraph, which is a document rather than a screen.

        ⚠️ `assumedCostPerJob` itself is NOT dead — the financial summary report
        computes every margin figure from it, and says so in its own footnote,
        which is where a reader actually needs the number. It is a seed-time
        value now, like the SLA.
      */}
    </div>
  );
}

/**
 * One rate card: its name, its current prices, and its history.
 *
 * ── Why history is collapsed rather than absent ───────────────────────────
 * The current schedule is what the office reads ninety-nine times out of a
 * hundred. The hundredth is "what were we charging Clarendon in March?", asked
 * while somebody is on the phone disputing an invoice — and that question has
 * no other home in the product. Collapsed keeps the common case clean without
 * making the rare one a database query.
 */
/**
 * The service zones (M6.3).
 *
 * ── Why zones sit above rate cards, and not on a tab of their own ─────────
 * Because they are the COLUMNS of everything below. Every rate schedule prices
 * one row per zone and the server refuses a partial one, so adding a zone here
 * changes the shape of every form underneath — and that is a cause and effect
 * somebody should be able to see without navigating.
 *
 * ── Why a new zone is not usable the moment it is created ─────────────────
 * A job is zoned by its SUBURB. Until a suburb points at a new zone nothing can
 * be booked in it and no quote will ever name it, so each row says how many
 * suburbs it has and links to where that is fixed.
 *
 * ── Why there is no capability check in here ──────────────────────────────
 * The whole screen is behind `settings:manage`, and that capability belongs to
 * the administrator alone — `operations` is not granted it. A second check on
 * this card could never fail, which is worse than none: it reads as though the
 * gate were here, so the day somebody widens it they widen the wrong file.
 */
function ZonesCard({ zones }: { zones: readonly ZoneSummary[] }) {
  const [adding, setAdding] = useState(false);
  const order = zones.filter((zone) => !zone.archived).map((zone) => zone.id);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <span>
            <CardTitle>Service zones</CardTitle>
            <CardDescription>
              Every rate schedule prices one row per zone, and a job is zoned by its suburb. The
              order here is the order they appear in on every rate grid and filter.
            </CardDescription>
          </span>
          <Button
            size="sm"
            disabled={zones.length === 0}
            title={zones.length === 0 ? 'A new zone copies its prices from an existing one' : undefined}
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon aria-hidden />
            New zone
          </Button>
        </CardHeader>

        <CardContent className="space-y-2">
          {zones.map((zone, index) => (
            <ZoneRow
              key={zone.id}
              zone={zone}
              order={order}
              isFirst={index === 0}
              isLast={index === zones.length - 1}
            />
          ))}

          {zones.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No zones yet. Nothing can be priced until there is at least one.
            </p>
          )}
        </CardContent>
      </Card>

      <AddZoneDialog
        zones={zones}
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </>
  );
}

function ZoneRow({
  zone,
  order,
  isFirst,
  isLast,
}: {
  zone: ZoneSummary;
  order: readonly string[];
  isFirst: boolean;
  isLast: boolean;
}) {
  const toast = useToast();
  const rename = useRenameZone();
  const reorder = useReorderZones();
  const archive = useArchiveZone();
  const restore = useRestoreZone();

  const [label, setLabel] = useState(zone.label);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const dirty = label.trim() !== zone.label && label.trim() !== '';

  /*
   * ── Up and down, not drag ─────────────────────────────────────────────
   * There are three zones today and there will not be thirty. A drag handle
   * costs a dependency this app does not carry and needs a keyboard equivalent
   * to be usable at all — two buttons ARE that equivalent, so they are the whole
   * control.
   *
   * ⚠️ Each press sends the WHOLE new order, never this row's new number. The
   * server then assigns 0..n with no ties, so two people reordering at once
   * cannot interleave into an order neither of them chose.
   */
  const submitMove = async (direction: -1 | 1) => {
    const from = order.indexOf(zone.id);
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(from + direction, 0, moved);

    try {
      await reorder.mutateAsync(next);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitRename = async () => {
    try {
      await rename.mutateAsync({ id: zone.id, label: label.trim() });
      toast.success(`Renamed to ${label.trim()}`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitArchive = async () => {
    try {
      await archive.mutateAsync(zone.id);
      setConfirmArchive(false);
      toast.success(
        `${zone.label} retired`,
        'Jobs already booked in it keep their zone and their prices.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitRestore = async () => {
    try {
      await restore.mutateAsync(zone.id);
      toast.success(`${zone.label} is back in service`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className={cn('rounded-lg border border-border p-3', zone.archived && 'opacity-70')}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="text-xs text-muted-foreground">
          Zone
          <Input
            value={label}
            className="mt-1"
            disabled={zone.archived}
            aria-label={`Name for ${zone.slug}`}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
          {/* Permanent, and shown for the same reason a charge code is. */}
          <span className="mt-1 block font-mono text-[11px]">{zone.slug}</span>
        </label>

        <span className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={isFirst || zone.archived || reorder.isPending}
            onClick={() => void submitMove(-1)}
          >
            <ChevronUpIcon aria-hidden />
            <span className="sr-only">Move {zone.label} up</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLast || zone.archived || reorder.isPending}
            onClick={() => void submitMove(1)}
          >
            <ChevronDownIcon aria-hidden />
            <span className="sr-only">Move {zone.label} down</span>
          </Button>
        </span>

        <span className="flex items-center gap-1">
          {zone.archived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={restore.isPending}
              onClick={() => void submitRestore()}
            >
              {restore.isPending && <Spinner className="text-current" />}
              Restore
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant={dirty ? 'default' : 'outline'}
                disabled={!dirty || rename.isPending}
                onClick={() => void submitRename()}
              >
                {rename.isPending && <Spinner className="text-current" />}
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                /*
                  From the SERVER's answer, not a rule re-derived here. A zone
                  with suburbs or customers still pointing at it cannot be
                  retired, and the counts below say which.
                */
                disabled={!zone.archivable}
                title={
                  zone.archivable
                    ? undefined
                    : zone.placeCount > 0
                      ? `${String(zone.placeCount)} suburb${zone.placeCount === 1 ? '' : 's'} still in this zone — move them first`
                      : `${String(zone.accountCount)} customer${zone.accountCount === 1 ? ' has' : 's have'} this as their primary zone`
                }
                onClick={() => {
                  setConfirmArchive(true);
                }}
              >
                <Trash2Icon aria-hidden />
                <span className="sr-only">Retire {zone.label}</span>
              </Button>
            </>
          )}
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {zone.archived ? (
          <span className="text-warning">Retired — not offered on new work.</span>
        ) : zone.placeCount === 0 ? (
          <span className="text-warning">
            No suburbs yet — nothing can be booked in this zone until one points at it.
          </span>
        ) : (
          <>
            {zone.placeCount} suburb{zone.placeCount === 1 ? '' : 's'} · {zone.jobCount} job
            {zone.jobCount === 1 ? '' : 's'}
          </>
        )}{' '}
        <Link className="underline underline-offset-2" to={`/admin/suburbs?zoneId=${zone.id}`}>
          Manage suburbs
        </Link>
      </p>

      <ConfirmDialog
        open={confirmArchive}
        title={`Retire ${zone.label}?`}
        description={`It stops being offered on new bookings and on new rate schedules. Everything already priced in it — ${String(zone.jobCount)} job${zone.jobCount === 1 ? '' : 's'} — keeps its zone and its figures, and you can put it back at any time.`}
        confirmLabel="Retire zone"
        tone="destructive"
        pending={archive.isPending}
        onCancel={() => {
          setConfirmArchive(false);
        }}
        onConfirm={() => void submitArchive()}
      />
    </div>
  );
}

/**
 * Open a new service area.
 *
 * ── Why it asks which zone to copy ────────────────────────────────────────
 * A zone with no prices prices NOTHING on any card, so the first booking into
 * it is refused with an error the office cannot act on. Copying happens per
 * card, so each customer's negotiated discount comes across — Clarendon's new
 * row from Clarendon's, not one flat number applied to everybody.
 */
function AddZoneDialog({
  zones,
  open,
  onClose,
}: {
  zones: readonly ZoneSummary[];
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateZone();

  const live = zones.filter((zone) => !zone.archived);

  const [label, setLabel] = useState('');
  const [copyFrom, setCopyFrom] = useState(live[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel('');
    setCopyFrom(live[0]?.id ?? '');
    setError(null);
  };

  const submit = async () => {
    if (label.trim() === '') {
      setError('Name the zone — it appears on every rate card and every quote');
      return;
    }
    if (copyFrom === '') {
      setError('Choose a zone to copy prices from');
      return;
    }
    setError(null);

    try {
      const zone = await create.mutateAsync({
        label: label.trim(),
        copyRatesFromZoneId: copyFrom,
      });
      reset();
      onClose();
      toast.success(
        `${zone.label} added`,
        'Every rate card now prices it. Point a suburb at it before booking.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New zone"
      description="A service area with its own service charge and rate per m²."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={() => void submit()}>
            {create.isPending && <Spinner className="text-current" />}
            Add zone
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="destructive" title={error} />}

        <Field id="zone-label" label="Name" required hint="How it reads on every quote and grid.">
          {(aria) => (
            <Input
              {...aria}
              value={label}
              placeholder="Central Coast"
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="zone-copy"
          label="Copy prices from"
          required
          hint="Each rate card copies its own figures for that zone, so per-customer discounts carry across."
        >
          {(aria) => (
            <Select
              {...aria}
              value={copyFrom}
              onChange={(event) => {
                setCopyFrom(event.target.value);
              }}
            >
              {live.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Alert variant="neutral" title="Nothing can be booked here yet">
          A job is zoned by its suburb, so this zone stays empty until a suburb points at it. Add
          or re-zone one on the Suburbs screen straight after.
        </Alert>
      </div>
    </Dialog>
  );
}

function RateCardRow({
  card,
  zoneOptions,
  zoneLabels,
  zoneKey,
}: {
  card: RateCardSummary;
  zoneOptions: readonly ZoneOption[];
  zoneLabels: ReadonlyMap<string, string>;
  zoneKey: string;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = useDeleteRateCard();

  const current = card.schedules.find(
    (schedule) => schedule.effectiveFrom === currentScheduleFrom(card),
  );

  /*
   * Three groups, not two. A schedule that starts tomorrow is neither in force
   * nor superseded — it is what this card is ABOUT to charge, and that is the
   * only one an administrator may remove.
   */
  const today = todayInSydney();
  const pending = card.schedules.filter(
    (schedule) => schedule !== current && schedule.effectiveFrom > today,
  );
  const superseded = card.schedules.filter(
    (schedule) => schedule !== current && schedule.effectiveFrom <= today,
  );

  const submitDelete = async () => {
    try {
      await remove.mutateAsync(card.id);
      setConfirmDelete(false);
      toast.success(`${card.label} deleted`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          type="button"
          onClick={() => {
            setExpanded(!expanded);
          }}
          aria-expanded={expanded}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded text-left"
        >
          <ChevronDownIcon
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${
              expanded ? '' : '-rotate-90'
            }`}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{card.label}</span>
            <span className="block font-mono text-xs text-muted-foreground">{card.id}</span>
          </span>
        </button>

        {/*
          The current prices inline, so the common question is answered without
          expanding anything. Hidden on phones, where three zones and six
          figures cannot fit beside a name.
        */}
        {current ? (
          <span className="hidden gap-4 text-xs tabular-nums text-muted-foreground md:flex">
            {current.zones.map((zone) => (
              <span key={zone.zoneId}>
                <span className="block">{zone.zoneLabel}</span>
                <span className="block font-medium text-foreground">
                  {formatMoney(zone.serviceCharge)} + ${zone.ratePerM2}/m²
                </span>
              </span>
            ))}
          </span>
        ) : (
          /*
            A card with no schedule covering today prices NOTHING — every quote
            against it silently falls back to the default card. That is worth a
            warning rather than an empty space.
          */
          <Badge variant="warning">No rates in force today</Badge>
        )}

        <Badge variant="secondary">
          {card.accountCount} account{card.accountCount === 1 ? '' : 's'}
        </Badge>

        <span className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setScheduleOpen(true);
            }}
          >
            New schedule
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRenaming(true);
            }}
          >
            Rename
          </Button>
          <Button
            variant="ghost"
            size="sm"
            /*
              Disabled from the SERVER's answer, not from a rule the browser
              re-derives. `deletable` already folds in "is this the default
              card" and "does an account still use it", so the button cannot
              offer something that comes back a 409.
            */
            disabled={!card.deletable}
            title={
              card.deletable
                ? undefined
                : card.accountCount > 0
                  ? 'Accounts still price against this card'
                  : 'The default card cannot be deleted'
            }
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2Icon aria-hidden />
            <span className="sr-only">Delete {card.label}</span>
          </Button>
        </span>
      </div>

      {expanded && (
        <div className="border-t border-border p-3">
          <ScheduleTable schedule={current} label="In force now" />

          {/*
            ⚠️ Pending and superseded are separated, and the split is not
            cosmetic.

            Everything that is not in force today used to be listed under
            "Superseded", which is wrong in the one direction that matters: a
            schedule starting next month has superseded nothing — it is what
            this card will charge, and reading it as history is how a wrong
            future rate goes unnoticed until the day it takes effect.

            Only a PENDING schedule can be removed, which is the same boundary,
            so the two facts are drawn from one comparison.
          */}
          {pending.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Scheduled — not yet in force
              </p>
              {pending.map((schedule) => (
                <ScheduleTable
                  key={schedule.effectiveFrom}
                  schedule={schedule}
                  label={`From ${schedule.effectiveFrom}`}
                  removableFrom={card.id}
                />
              ))}
            </div>
          )}

          {superseded.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Superseded
              </p>
              {superseded.map((schedule) => (
                <ScheduleTable
                  key={schedule.effectiveFrom}
                  schedule={schedule}
                  label={`${schedule.effectiveFrom} → ${schedule.effectiveTo || 'open'}`}
                  muted
                />
              ))}
            </div>
          )}

          {card.schedules.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No schedule yet. Add one so this card can price a job.
            </p>
          )}
        </div>
      )}

      <IssueScheduleDialog
        /* Seeded once on mount — see the note on the other dialog. */
        key={zoneKey}
        card={card}
        zoneOptions={zoneOptions}
        zoneLabels={zoneLabels}
        open={scheduleOpen}
        onClose={() => {
          setScheduleOpen(false);
        }}
      />
      <RenameCardDialog
        card={card}
        open={renaming}
        onClose={() => {
          setRenaming(false);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => {
          setConfirmDelete(false);
        }}
        onConfirm={() => void submitDelete()}
        title={`Delete ${card.label}?`}
        description="Its rate schedules go with it. Jobs already priced on this card keep the figures they were invoiced at — each one stores its own copy — so no invoice changes."
        confirmLabel="Delete rate card"
        tone="destructive"
        pending={remove.isPending}
      />
    </div>
  );
}

/** Which schedule is in force today, by the same rule the server applies. */
function currentScheduleFrom(card: RateCardSummary): string | undefined {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

  return card.schedules.find(
    (schedule) =>
      schedule.effectiveFrom <= today &&
      (schedule.effectiveTo === '' || schedule.effectiveTo >= today),
  )?.effectiveFrom;
}

/**
 * One schedule's rates, and — for a schedule that has not started — the undo.
 *
 * `removableFrom` carries the CARD id rather than a boolean, so a row can only
 * offer the action when it also knows what to act on. Undefined means the
 * schedule is in force or past, which is exactly when removing it would move a
 * figure on an invoice somebody already has.
 */
function ScheduleTable({
  schedule,
  label,
  muted = false,
  removableFrom,
}: {
  schedule: RateSchedule | undefined;
  label: string;
  muted?: boolean;
  removableFrom?: string | undefined;
}) {
  const toast = useToast();
  const remove = useDeleteSchedule();
  const [confirming, setConfirming] = useState(false);

  const submit = async () => {
    if (removableFrom === undefined || !schedule) return;

    try {
      await remove.mutateAsync({ id: removableFrom, effectiveFrom: schedule.effectiveFrom });
      setConfirming(false);
      toast.success('Schedule removed', 'The rates in force before it apply again.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  if (!schedule) return null;

  return (
    <div className={muted ? 'opacity-70' : undefined}>
      <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {label}
        {!muted && ` · from ${schedule.effectiveFrom}`}
        {removableFrom !== undefined && (
          <>
            <Badge variant="secondary">Starts in the future</Badge>
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
              }}
              className="focus-ring rounded text-destructive underline underline-offset-4"
            >
              Remove
            </button>
          </>
        )}
      </p>

      <ConfirmDialog
        open={confirming}
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => void submit()}
        title={`Remove the schedule starting ${schedule.effectiveFrom}?`}
        description="It has not started, so nothing has been priced on it. The schedule in force before it becomes open-ended again."
        confirmLabel="Remove schedule"
        tone="destructive"
        pending={remove.isPending}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] text-sm">
          <caption className="sr-only">Zone rates {label}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1.5 text-left text-xs font-medium">
                Zone
              </th>
              <th scope="col" className="py-1.5 text-right text-xs font-medium">
                Service charge
              </th>
              <th scope="col" className="py-1.5 text-right text-xs font-medium">
                Rate per m²
              </th>
            </tr>
          </thead>
          <tbody>
            {schedule.zones.map((zone) => (
              <tr key={zone.zoneId} className="border-b border-border/60 last:border-b-0">
                <td className="py-1.5">{zone.zoneLabel}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatMoney(zone.serviceCharge)}
                </td>
                <td className="py-1.5 text-right tabular-nums">${zone.ratePerM2}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Editing rates ───────────────────────────────────────────────────────── */

/**
 * Today in Sydney, as `YYYY-MM-DD`.
 *
 * ⚠️ Not `new Date().toISOString().slice(0, 10)`. That is UTC, which is the
 * previous day for the first ten or eleven hours of every Sydney morning — so
 * a schedule someone meant to start "today" would be back-dated by one day,
 * and the server would reject it against an invoiced job for no reason the
 * person could see.
 */
function todayInSydney(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

/**
 * A blank set of zone rates — one row per LIVE zone, every one required.
 *
 * ⚠️ Takes the list rather than reading a constant. The grid used to be built
 * from `ZONES`, so it could not be empty; it can be now, and `zoneRateErrors`
 * below has a check for exactly that.
 */
function emptyZoneRates(zones: readonly ZoneOption[]): ZoneRateInput[] {
  return zones.map((zone) => ({ zoneId: zone.value, serviceCharge: '', ratePerM2: '' }));
}

/**
 * The zone rate grid, shared by "new card" and "new schedule".
 *
 * One component because the two forms ask for exactly the same thing, and a
 * second copy is how the create form ends up accepting a precision the issue
 * form rejects.
 *
 * ⚠️ `labels` is threaded in rather than looked up here. The rows are
 * `ZoneRateInput`, which carries only the id — it is a WRITE shape, and the
 * server does not want a name it would have to ignore.
 */
function ZoneRateFields({
  zones,
  labels,
  onChange,
  disabled,
}: {
  zones: readonly ZoneRateInput[];
  labels: ReadonlyMap<string, string>;
  onChange: (next: ZoneRateInput[]) => void;
  disabled?: boolean;
}) {
  const setZone = (index: number, patch: Partial<ZoneRateInput>) => {
    onChange(zones.map((zone, i) => (i === index ? { ...zone, ...patch } : zone)));
  };

  return (
    <div className="space-y-3">
      {zones.map((zone, index) => (
        <div
          key={zone.zoneId}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr_1fr] sm:items-center"
        >
          <span className="text-sm font-medium">{labels.get(zone.zoneId) ?? 'Unknown zone'}</span>

          <label className="text-xs text-muted-foreground">
            Service charge
            <Input
              value={zone.serviceCharge}
              disabled={disabled}
              inputMode="decimal"
              placeholder="220.00"
              className="mt-1 font-mono"
              aria-label={`Service charge for ${labels.get(zone.zoneId) ?? 'this zone'}`}
              onChange={(event) => {
                setZone(index, { serviceCharge: event.target.value });
              }}
            />
          </label>

          <label className="text-xs text-muted-foreground">
            Rate per m²
            <Input
              value={zone.ratePerM2}
              disabled={disabled}
              inputMode="decimal"
              placeholder="0.1600"
              className="mt-1 font-mono"
              aria-label={`Rate per square metre for ${labels.get(zone.zoneId) ?? 'this zone'}`}
              onChange={(event) => {
                setZone(index, { ratePerM2: event.target.value });
              }}
            />
          </label>
        </div>
      ))}

      {/*
        Said out loud because it is the one thing a person keying these in will
        get wrong. $0.1625 rounded to $0.16 before multiplying by 823 m² loses
        real money on every large job, and the loss is invisible per invoice.
      */}
      <p className="text-xs text-muted-foreground">
        Rates take four decimal places — 0.1625 is kept as 0.1625, not rounded to cents.
      </p>
    </div>
  );
}

/**
 * Client-side check on a zone grid.
 *
 * Duplicated deliberately with the server's, which is the authority. This one
 * exists so the person typing gets told at the field rather than after a round
 * trip that clears nothing.
 */
function zoneRateErrors(
  zones: readonly ZoneRateInput[],
  labels: ReadonlyMap<string, string>,
): string | null {
  /*
   * ⚠️ A new check, and it only became possible to fail once zones were data.
   *
   * The grid used to be built from `ZONES`, so it could not be empty. It can be
   * now — a dialog opened before the register answered, or a deployment with no
   * zones at all — and an empty array passes every loop below, so the form would
   * happily post a schedule that prices nothing.
   */
  if (zones.length === 0) {
    return 'There are no zones to price — add one on this tab before issuing rates';
  }

  const nameOf = (zoneId: string) => labels.get(zoneId) ?? 'That zone';

  for (const zone of zones) {
    if (zone.serviceCharge.trim() === '' || zone.ratePerM2.trim() === '') {
      return `Every zone needs both figures — ${nameOf(zone.zoneId)} is incomplete`;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(zone.serviceCharge.trim())) {
      return `${nameOf(zone.zoneId)}'s service charge is not a valid amount`;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(zone.ratePerM2.trim())) {
      return `${nameOf(zone.zoneId)}'s rate per m² is not a valid amount`;
    }
  }
  return null;
}

function NewRateCardDialog({
  open,
  onClose,
  zoneOptions,
  zoneLabels,
}: {
  open: boolean;
  onClose: () => void;
  /** Live zones only: a new schedule never prices a retired one. */
  zoneOptions: readonly ZoneOption[];
  zoneLabels: ReadonlyMap<string, string>;
}) {
  const toast = useToast();
  const create = useCreateRateCard();

  const [label, setLabel] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayInSydney);
  /*
   * ⚠️ Seeded ONCE, on mount — `useState` never re-runs its initialiser.
   *
   * That was safe while zones were a constant and is not now. Two things guard
   * it: the button that opens this dialog is disabled until the register lands,
   * and the dialog is keyed on the zone ids so it remounts if the list changes
   * underneath — which is what happens when somebody adds a zone in a second
   * tab.
   */
  const [zones, setZones] = useState<ZoneRateInput[]>(() => emptyZoneRates(zoneOptions));
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel('');
    setEffectiveFrom(todayInSydney());
    setZones(emptyZoneRates(zoneOptions));
    setError(null);
  };

  const submit = async () => {
    if (label.trim() === '') {
      setError('Give the card a name — it appears wherever an account is assigned one');
      return;
    }
    const zoneError = zoneRateErrors(zones, zoneLabels);
    if (zoneError) {
      setError(zoneError);
      return;
    }
    setError(null);

    try {
      const card = await create.mutateAsync({
        label: label.trim(),
        effectiveFrom,
        zones: zones.map((zone) => ({
          zoneId: zone.zoneId,
          serviceCharge: zone.serviceCharge.trim(),
          ratePerM2: zone.ratePerM2.trim(),
        })),
      });
      reset();
      onClose();
      toast.success(`${card.label} created`, `Accounts can be assigned to it now.`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New rate card"
      description="A card is one negotiated agreement. Its prices are a dated schedule underneath it."
      size="lg"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending && <Spinner className="text-current" />}
            Create rate card
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && (
          <Alert variant="destructive" title="Check the schedule">
            {error}
          </Alert>
        )}

        <Field
          id="rc-label"
          label="Name"
          required
          hint="What the office calls this agreement — “Metricon Homes”, “Tier 5”."
        >
          {(aria) => (
            <Input
              {...aria}
              value={label}
              placeholder="Metricon Homes"
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="rc-from"
          label="Rates effective from"
          required
          hint="A job on or after this date is priced on these rates."
        >
          {(aria) => (
            <Input
              {...aria}
              type="date"
              value={effectiveFrom}
              onChange={(event) => {
                setEffectiveFrom(event.target.value);
              }}
            />
          )}
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium">Zone rates</p>
          <ZoneRateFields zones={zones} labels={zoneLabels} onChange={setZones} disabled={create.isPending} />
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Issue a new schedule on an existing card (M6.2).
 *
 * ── Why it opens pre-filled with today's figures ──────────────────────────
 * Because a price change is almost always a change to ONE number. Making
 * somebody retype three service charges and three rates to put the Sydney rate
 * up by two cents is how a typo gets into the other five.
 */
function IssueScheduleDialog({
  card,
  open,
  onClose,
  zoneOptions,
  zoneLabels,
}: {
  card: RateCardSummary;
  open: boolean;
  onClose: () => void;
  /** Live zones only: a new schedule never prices a retired one. */
  zoneOptions: readonly ZoneOption[];
  zoneLabels: ReadonlyMap<string, string>;
}) {
  const toast = useToast();
  const issue = useIssueSchedule();

  /*
   * One row per LIVE zone, pre-filled from what the card charges today.
   *
   * ⚠️ Matched by id against the card's current rates, so a zone added AFTER
   * this card was written seeds blank rather than inheriting a neighbour's
   * price. The office is asked to fill it in; it is never guessed at.
   */
  const seed = (): ZoneRateInput[] =>
    zoneOptions.map((zone) => {
      const existing = card.zones.find((rate) => rate.zoneId === zone.value);
      return {
        zoneId: zone.value,
        serviceCharge: existing?.serviceCharge ?? '',
        ratePerM2: existing?.ratePerM2 ?? '',
      };
    });

  const [effectiveFrom, setEffectiveFrom] = useState(todayInSydney);
  const [zones, setZones] = useState<ZoneRateInput[]>(seed);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const zoneError = zoneRateErrors(zones, zoneLabels);
    if (zoneError) {
      setError(zoneError);
      return;
    }
    setError(null);

    try {
      await issue.mutateAsync({
        id: card.id,
        schedule: {
          effectiveFrom,
          zones: zones.map((zone) => ({
            zoneId: zone.zoneId,
            serviceCharge: zone.serviceCharge.trim(),
            ratePerM2: zone.ratePerM2.trim(),
          })),
        },
      });
      onClose();
      toast.success(
        `New schedule for ${card.label}`,
        `In force from ${effectiveFrom}. Jobs already priced are unchanged.`,
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`New schedule — ${card.label}`}
      description="The current schedule closes the day before this one starts. Nothing already priced moves."
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={issue.isPending}>
            {issue.isPending && <Spinner className="text-current" />}
            Issue schedule
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && (
          <Alert variant="destructive" title="Check the schedule">
            {error}
          </Alert>
        )}

        <Field
          id="sched-from"
          label="Effective from"
          required
          hint="A job on or after this date is priced on the rates below."
        >
          {(aria) => (
            <Input
              {...aria}
              type="date"
              value={effectiveFrom}
              onChange={(event) => {
                setEffectiveFrom(event.target.value);
              }}
            />
          )}
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium">Zone rates</p>
          <ZoneRateFields zones={zones} labels={zoneLabels} onChange={setZones} disabled={issue.isPending} />
        </div>

        <Alert variant="neutral" title="Pre-filled with today’s rates">
          Change only what is changing. Everything here is written as a new dated version — the
          figures currently in force stay exactly as they are.
        </Alert>
      </div>
    </Dialog>
  );
}

function RenameCardDialog({
  card,
  open,
  onClose,
}: {
  card: RateCardSummary;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const rename = useRenameRateCard();
  const [label, setLabel] = useState(card.label);

  const submit = async () => {
    if (label.trim() === '') return;

    try {
      await rename.mutateAsync({ id: card.id, label: label.trim() });
      onClose();
      toast.success('Rate card renamed');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename rate card"
      description="Only the name changes. The id and every rate stay as they are."
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={rename.isPending}>
            {rename.isPending && <Spinner className="text-current" />}
            Save name
          </Button>
        </>
      }
    >
      <Field id="rc-rename" label="Name" required>
        {(aria) => (
          <Input
            {...aria}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
        )}
      </Field>
    </Dialog>
  );
}

/* ── Additional services ─────────────────────────────────────────────────── */

/**
 * The chargeable extras, editable in place.
 *
 * ── Why editing here IS safe, unlike a rate ───────────────────────────────
 * A job's charges are written onto the job when they are raised, with the
 * amount as it stood — so repricing "Futile pickup" from $120 to $135 changes
 * what the NEXT futile costs and nothing that has already happened. Rates are
 * different because they are read at pricing time, which is why those get
 * dated schedules and these get a text box.
 */
function AdditionalServicesCard({
  services,
}: {
  services: readonly AdditionalServiceSetting[];
}) {
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <span>
            <CardTitle>Additional services</CardTitle>
            <CardDescription>
              Fixed amounts and percentages. Editing one changes what the next job is charged, not
              what has already been invoiced.
            </CardDescription>
          </span>
          <Button
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon aria-hidden />
            New charge
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {services.map((service) => (
            <ServiceRow key={service.code} service={service} />
          ))}
        </CardContent>
      </Card>

      <NewServiceDialog
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </>
  );
}

function ServiceRow({ service }: { service: AdditionalServiceSetting }) {
  const toast = useToast();
  const update = useUpdateAdditionalService();
  const remove = useDeleteAdditionalService();

  const [value, setValue] = useState(service.value);
  const [label, setLabel] = useState(service.label);
  const [requiresApproval, setRequiresApproval] = useState(service.requiresApproval);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty =
    value !== service.value ||
    label !== service.label ||
    requiresApproval !== service.requiresApproval;

  const submit = async () => {
    if (!/^\d+(\.\d{1,4})?$/.test(value.trim())) {
      toast.error('That amount does not look right', 'Use digits and at most four decimals.');
      return;
    }

    try {
      await update.mutateAsync({
        code: service.code,
        patch: {
          label: label.trim(),
          value: value.trim(),
          requiresApproval,
        },
      });
      toast.success(`${label.trim()} updated`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitDelete = async () => {
    try {
      await remove.mutateAsync(service.code);
      setConfirmDelete(false);
      toast.success(`${service.label} removed`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
        <label className="text-xs text-muted-foreground">
          Charge
          <Input
            value={label}
            className="mt-1"
            aria-label={`Name for ${service.code}`}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
          <span className="mt-1 block font-mono text-[11px]">{service.code}</span>
        </label>

        <label className="text-xs text-muted-foreground">
          {service.kind === 'percentage' ? 'Percentage' : 'Amount'}
          <Input
            value={value}
            inputMode="decimal"
            className="mt-1 font-mono"
            aria-label={`${service.kind === 'percentage' ? 'Percentage' : 'Amount'} for ${service.label}`}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>

        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant={dirty ? 'default' : 'outline'}
            disabled={!dirty || update.isPending}
            onClick={() => void submit()}
          >
            {update.isPending && <Spinner className="text-current" />}
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            /*
              The five codes the application looks up by literal name cannot be
              removed — deleting one turns a driver tapping "Report
              contamination" into a 500. The server refuses it too; this just
              stops the button being offered.
            */
            disabled={!service.deletable}
            title={
              service.deletable
                ? undefined
                : 'The system raises this charge by name — set it to 0.00 instead'
            }
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2Icon aria-hidden />
            <span className="sr-only">Delete {service.label}</span>
          </Button>
        </span>
      </div>

      {/*
        ⚠️ "Driver can raise it" used to sit beside this, and it is gone.

        It wrote a column nothing read. The driver app offers the screens it
        ships — report contamination, report futile — and decides what to show
        from those screens existing, never from a flag here. So ticking it told
        an administrator they had just put a button on a driver's phone, and
        put nothing anywhere.

        Removed rather than disabled: a control that cannot be used still
        implies the setting matters. The FIELD survives on the record, so
        wiring the driver app to it later is a change to that app rather than a
        migration.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={requiresApproval}
            onChange={() => {
              setRequiresApproval(!requiresApproval);
            }}
          />
          Requires approval
        </label>

        {service.systemGenerated && (
          <Badge variant="outline">System — derived, not raised by hand</Badge>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => {
          setConfirmDelete(false);
        }}
        onConfirm={() => void submitDelete()}
        title={`Delete ${service.label}?`}
        description="Jobs already charged for it keep their line — the amount was copied onto the job when it was raised. It just stops being offered."
        confirmLabel="Delete charge"
        tone="destructive"
        pending={remove.isPending}
      />
    </div>
  );
}

function NewServiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateAdditionalService();

  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'fixed' | 'percentage'>('fixed');
  const [value, setValue] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCode('');
    setLabel('');
    setKind('fixed');
    setValue('');
    setRequiresApproval(true);
    setError(null);
  };

  const submit = async () => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(code.trim())) {
      setError('The code is lowercase letters, digits and hyphens — “site-access-fee”.');
      return;
    }
    if (label.trim() === '') {
      setError('Give the charge a name — it prints on the invoice line.');
      return;
    }
    if (!/^\d+(\.\d{1,4})?$/.test(value.trim())) {
      setError('The amount is digits and at most four decimals.');
      return;
    }
    setError(null);

    try {
      await create.mutateAsync({
        code: code.trim(),
        label: label.trim(),
        kind,
        value: value.trim(),
        requiresApproval,
      });
      reset();
      onClose();
      toast.success(`${label.trim()} added`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New charge"
      description="An extra the office or a driver can add to a job."
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending}>
            {create.isPending && <Spinner className="text-current" />}
            Add charge
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && (
          <Alert variant="destructive" title="Check the charge">
            {error}
          </Alert>
        )}

        <Field
          id="svc-code"
          label="Code"
          required
          hint="Permanent — it identifies the charge on invoices and in Xero."
        >
          {(aria) => (
            <Input
              {...aria}
              value={code}
              placeholder="site-access-fee"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setCode(event.target.value.toLowerCase());
              }}
            />
          )}
        </Field>

        <Field id="svc-label" label="Name" required hint="What prints on the invoice line.">
          {(aria) => (
            <Input
              {...aria}
              value={label}
              placeholder="Site access fee"
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="svc-kind"
            label="Kind"
            required
            /*
              Chosen once and never changed. Switching a $90 fixed charge to a
              90% one would reprice every future job by a factor of thousands,
              so the API has no route for it — retiring the charge and adding a
              new one is the deliberate path.
            */
            hint="Cannot be changed later."
          >
            {(aria) => (
              <Select
                {...aria}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as 'fixed' | 'percentage');
                }}
              >
                <option value="fixed">Fixed amount</option>
                <option value="percentage">Percentage of the job</option>
              </Select>
            )}
          </Field>

          <Field
            id="svc-value"
            label={kind === 'percentage' ? 'Percentage' : 'Amount'}
            required
            hint={kind === 'percentage' ? '10 means ten percent.' : 'Dollars, e.g. 90.00.'}
          >
            {(aria) => (
              <Input
                {...aria}
                value={value}
                inputMode="decimal"
                className="font-mono"
                placeholder={kind === 'percentage' ? '10' : '90.00'}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={requiresApproval}
              onChange={() => {
                setRequiresApproval(!requiresApproval);
              }}
            />
            The office approves it before it can be invoiced
          </label>
        </div>

        {/*
          Said plainly, because the alternative is an administrator creating a
          charge and waiting for it to appear on a driver's phone. A new charge
          is a PRICE the office applies to a job; the driver app's buttons are
          the ones it ships with.
        */}
        <Alert variant="neutral" title="A new charge is added by the office">
          Drivers report contamination and futile pickups from their own screens. A charge created
          here is one the office applies to a job.
        </Alert>
      </div>
    </Dialog>
  );
}

/* ── Invoicing ───────────────────────────────────────────────────────────── */

function InvoicingSection({ settings }: { settings: Settings }) {
  const toast = useToast();
  const save = useSaveInvoicingSettings();
  /*
   * The draft is the WRITE shape. Holding the read shape here would mean the
   * save body carried `logoUrl` back to a server that only strips it, and —
   * worse — that the comparison below saw it.
   */
  const [draft, setDraft] = useState(() => writable(settings.invoicing));
  const [termsError, setTermsError] = useState<string | null>(null);
  const [prefixError, setPrefixError] = useState<string | null>(null);

  /*
   * ⚠️ Compared against the writable projection for the same reason the key
   * above uses it: `logoUrl` differs on every read, so comparing it would put
   * this form into "unsaved changes" — with a navigation guard attached —
   * without anybody having typed anything.
   */
  const dirty = JSON.stringify(draft) !== JSON.stringify(writable(settings.invoicing));
  useUnsavedChanges(dirty);

  const submit = async () => {
    if (draft.defaultPaymentTermsDays < 0 || draft.defaultPaymentTermsDays > 90) {
      setTermsError('Enter between 0 and 90 days');
      return;
    }
    setTermsError(null);

    // Letters, digits and hyphens only. A prefix with a slash or a space in it
    // ends up in Xero and in a builder's accounts system, where it is somebody
    // else's problem to unpick.
    if (!/^[A-Za-z0-9-]*$/.test(draft.invoiceNumberPrefix.trim())) {
      setPrefixError('Letters, digits and hyphens only');
      return;
    }
    setPrefixError(null);

    try {
      await save.mutateAsync(draft);
      toast.success('Invoicing settings saved');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Workflow</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <Switch
              checked={draft.splitAdditionalCharges}
              onCheckedChange={(checked) => {
                setDraft({ ...draft, splitAdditionalCharges: checked });
              }}
              id="split-charges"
              aria-label="Invoice additional charges separately"
            />
            <label htmlFor="split-charges" className="text-sm">
              Invoice additional charges separately
              <span className="block text-xs text-muted-foreground">
                The base invoice goes out on completion against the original PO; additional charges
                follow once their own PO arrives, so cash for the job is never delayed.
              </span>
            </label>
          </div>

          {/*
            Matt, 7:07: *"customisable invoice number prefixes… select the prefix
            like, for example, if we had PGA, it would put PGA dash in front of
            the invoice number."*

            Presentation only. The stored number is a bare sequence Xero matches
            on, so changing this renumbers nothing.
          */}
          <div className="sm:max-w-xs">
            <Field
              id="invoice-prefix"
              label="Invoice number prefix"
              error={prefixError ?? undefined}
              hint={
                draft.invoiceNumberPrefix.trim() === ''
                  ? 'Leave blank for plain numbers, e.g. #104312.'
                  : `Invoices will read ${draft.invoiceNumberPrefix.trim()}-104312.`
              }
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.invoiceNumberPrefix}
                  maxLength={8}
                  placeholder="PGA"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setDraft({ ...draft, invoiceNumberPrefix: event.target.value });
                    setPrefixError(null);
                  }}
                />
              )}
            </Field>
          </div>

          <div className="sm:max-w-xs">
            <Field
              id="payment-terms"
              label="Default payment terms"
              required
              error={termsError ?? undefined}
              hint="Days. Their standard is 7."
            >
              {(aria) => (
                <Input
                  {...aria}
                  type="number"
                  min={0}
                  max={90}
                  value={draft.defaultPaymentTermsDays}
                  onChange={(event) => {
                    setDraft({ ...draft, defaultPaymentTermsDays: Number(event.target.value) });
                  }}
                />
              )}
            </Field>
          </div>
        </CardContent>
      </Card>

      <LogoCard logoUrl={settings.invoicing.logoUrl} />

      <Card>
        <CardHeader>
          <CardTitle>Your business, as it prints</CardTitle>
          <CardDescription>
            These appear on every invoice PDF. Leave a field blank and it is left off the page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="company-name" label="Company name">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.companyName}
                  placeholder="PlastaGo Pty Ltd"
                  onChange={(event) => {
                    setDraft({ ...draft, companyName: event.target.value });
                  }}
                />
              )}
            </Field>
            {/*
              ⚠️ Not decoration. A tax invoice over $82.50 must carry the
              supplier's ABN, and a customer may lawfully withhold payment on
              one that does not — so the hint says what it is FOR.
            */}
            <Field
              id="company-abn"
              label="ABN"
              hint="Required on a tax invoice. Without it a customer can refuse to pay."
            >
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.companyAbn}
                  placeholder="51 824 753 556"
                  onChange={(event) => {
                    setDraft({ ...draft, companyAbn: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <Field id="company-address" label="Address">
            {(aria) => (
              <Input
                {...aria}
                value={draft.companyAddress}
                placeholder="1 Recycling Way, Smithfield NSW 2164"
                onChange={(event) => {
                  setDraft({ ...draft, companyAddress: event.target.value });
                }}
              />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="company-phone" label="Phone">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.companyPhone}
                  onChange={(event) => {
                    setDraft({ ...draft, companyPhone: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field id="company-email" label="Accounts email">
              {(aria) => (
                <Input
                  {...aria}
                  type="email"
                  value={draft.companyEmail}
                  onChange={(event) => {
                    setDraft({ ...draft, companyEmail: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment details</CardTitle>
          <CardDescription>Printed under the totals, with the invoice number as the reference.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="bank-bsb" label="BSB">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.bankBsb}
                  placeholder="062-000"
                  onChange={(event) => {
                    setDraft({ ...draft, bankBsb: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field id="bank-account" label="Account number">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.bankAccount}
                  onChange={(event) => {
                    setDraft({ ...draft, bankAccount: event.target.value });
                  }}
                />
              )}
            </Field>
            {/*
              The payer's own banking software asks for this. An invoice
              without it generates a phone call on every first payment.
            */}
            <Field id="bank-account-name" label="Account name">
              {(aria) => (
                <Input
                  {...aria}
                  value={draft.bankAccountName}
                  placeholder="PlastaGo Pty Ltd"
                  onChange={(event) => {
                    setDraft({ ...draft, bankAccountName: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <Field id="terms-text" label="Payment terms wording">
            {(aria) => (
              <Textarea
                {...aria}
                rows={2}
                value={draft.termsText}
                placeholder="Payment due within 7 days of the invoice date."
                onChange={(event) => {
                  setDraft({ ...draft, termsText: event.target.value });
                }}
              />
            )}
          </Field>

          <Field id="footer-text" label="Footer text" hint="One line, at the foot of every page.">
            {(aria) => (
              <Textarea
                {...aria}
                rows={2}
                value={draft.footerText}
                onChange={(event) => {
                  setDraft({ ...draft, footerText: event.target.value });
                }}
              />
            )}
          </Field>

          <div className="flex items-center gap-3">
            <Switch
              checked={draft.showGbcaBadge}
              onCheckedChange={(checked) => {
                setDraft({ ...draft, showGbcaBadge: checked });
              }}
              id="gbca-badge"
              aria-label="Show the GBCA member badge"
            />
            <label htmlFor="gbca-badge" className="text-sm">
              Show the GBCA member badge
            </label>
          </div>
        </CardContent>
      </Card>

      <InvoiceTemplatesCard templates={settings.invoicing.templates} />

      <UnsavedBar
        visible={dirty}
        pending={save.isPending}
        onSave={() => void submit()}
        onDiscard={() => {
          setDraft(writable(settings.invoicing));
          setTermsError(null);
        }}
      />
    </div>
  );
}


/* ── The logo (M7.5) ─────────────────────────────────────────────────────── */

/**
 * The mark every invoice carries.
 *
 * ── Why this is its own card and not a field in the form below ────────────
 * Because it does not save with the form. The bytes go straight to storage and
 * the change takes effect the moment they land, so putting it inside a section
 * with an unsaved-changes bar would promise a "discard" that cannot undo it.
 *
 * ⚠️ PNG or JPEG only. The renderer embeds those two and nothing else, so an
 * SVG would store happily and then silently fail to appear on every invoice —
 * the fallback is the company name in text, so nobody would see an error.
 */
function LogoCard({ logoUrl }: { logoUrl: string | null }) {
  const toast = useToast();
  const upload = useUploadLogo();
  const remove = useRemoveLogo();
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;

    /*
     * Checked here as well as on the server, so somebody who picks a 12 MB
     * photograph is told at the button rather than after the upload.
     */
    if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.type)) {
      toast.error('That file type cannot be printed', 'Use a PNG or a JPEG.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('That logo is too large', 'Keep it under 2 MB — it goes on every invoice.');
      return;
    }

    try {
      await upload.mutateAsync(file);
      toast.success('Logo updated', 'It will appear on the next invoice rendered.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitRemove = async () => {
    try {
      await remove.mutateAsync();
      setConfirmRemove(false);
      toast.success('Logo removed', 'Invoices will print the company name instead.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>
          Printed at the top of every invoice. Without one, the company name is printed as text.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-4">
          {/*
            A real preview rather than a filename. The only question a person
            has here is whether that is the right mark, the right way up, and a
            storage key answers neither.
          */}
          <span className="flex size-24 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30 p-2">
            {logoUrl === null ? (
              <ImageIcon className="size-8 text-muted-foreground/50" aria-hidden />
            ) : (
              <img
                src={logoUrl}
                alt="The logo as it appears on invoices"
                className="max-h-full max-w-full object-contain"
              />
            )}
          </span>

          <span className="flex min-w-0 flex-col gap-2">
            <span className="text-sm text-muted-foreground">
              {logoUrl === null
                ? 'No logo yet — invoices print the company name.'
                : 'This is what your invoices carry today.'}
            </span>

            <span className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={upload.isPending}
                onClick={() => {
                  inputRef.current?.click();
                }}
              >
                {upload.isPending && <Spinner className="text-current" />}
                <UploadIcon aria-hidden />
                {logoUrl === null ? 'Upload a logo' : 'Replace'}
              </Button>

              {logoUrl !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => {
                    setConfirmRemove(true);
                  }}
                >
                  <Trash2Icon aria-hidden />
                  Remove
                </Button>
              )}
            </span>

            <span className="text-xs text-muted-foreground">PNG or JPEG, up to 2 MB.</span>
          </span>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the SAME file again still fires a change.
            event.target.value = '';
            void choose(file);
          }}
        />
      </CardContent>

      <ConfirmDialog
        open={confirmRemove}
        onCancel={() => {
          setConfirmRemove(false);
        }}
        onConfirm={() => void submitRemove()}
        title="Remove the logo?"
        description="Invoices will print the company name as text instead. Invoices already rendered keep the logo they were drawn with."
        confirmLabel="Remove logo"
        tone="destructive"
        pending={remove.isPending}
      />
    </Card>
  );
}

/* ── Invoice templates (M7.5) ────────────────────────────────────────────── */

/**
 * The templates, and the controls to manage them.
 *
 * ── What is editable here, and what is deliberately not ──────────────────
 * A template is a NAMED CONFIGURATION of a shipped layout: its name, brand,
 * accent colour, and whether kilograms print. The layout itself — where the
 * logo sits, how the table is ruled — is drawn by the renderer and chosen
 * from a fixed list.
 *
 * That split is the entire defence against the layout-authoring scope trap.
 * Offering a canvas here would be a product in its own right; offering a
 * dropdown of four drawings answers the real requirement, which is that
 * EasyLift and PlastaGo invoices look different and an RCTI looks different
 * from both.
 */
function InvoiceTemplatesCard({ templates }: { templates: readonly InvoiceTemplate[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Templates</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon aria-hidden />
            New template
          </Button>
        </CardTitle>
        <CardDescription>
          Assigned per customer. An account with none chosen falls back to its brand.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {templates.map((template) => (
            <InvoiceTemplateRow key={template.id} template={template} />
          ))}
        </ul>

        {templates.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            No templates yet. An invoice cannot be rendered until its brand has one.
          </p>
        )}
      </CardContent>

      <InvoiceTemplateDialog
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </Card>
  );
}

function InvoiceTemplateRow({ template }: { template: InvoiceTemplate }) {
  const toast = useToast();
  const remove = useDeleteInvoiceTemplate();
  const preview = usePreviewTemplate();
  const [editing, setEditing] = useState(false);

  const showPreview = async () => {
    /*
     * The tab is reserved DURING the click, before the await. Opening it after
     * the render comes back is the call a popup blocker silently refuses, and
     * the button would appear to do nothing — the same trap the invoice
     * download hook documents.
     */
    const reserved = window.open('', '_blank');

    try {
      const rendered = await preview.mutateAsync(template.id);
      if (reserved) {
        reserved.opener = null;
        reserved.location.href = rendered.url;
      } else {
        toast.error('The preview could not be opened', 'Allow pop-ups for this site, then retry.');
      }
    } catch (caught) {
      reserved?.close();
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const destroy = async () => {
    try {
      await remove.mutateAsync(template.id);
      toast.success(`${template.name} deleted`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: template.accentColour }}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{template.name}</span>
        <span className="block text-xs text-muted-foreground">
          {INVOICE_LAYOUT_LABELS[template.layout]}
        </span>
      </span>

      <Badge variant="outline">{BRAND_LABELS[template.brandId]}</Badge>
      <Badge variant="secondary">{template.showsWeight ? 'kg & m²' : 'm² only'}</Badge>

      <span className="text-xs text-muted-foreground">
        {template.assignedAccountCount} assigned
      </span>

      {/*
        ⚠️ The control this screen was missing.

        A template used to be chosen blind — pick a layout, type a hex colour,
        and the first rendering anybody saw was on a real invoice already on
        its way to a builder. A sent invoice cannot be unsent, so "check it
        afterwards" was never a recovery.

        The sample is drawn server-side from invented figures; previewing a
        real invoice would put one customer's job and amounts on screen for
        whoever happens to be editing a template.
      */}
      <Button
        size="sm"
        variant="ghost"
        disabled={preview.isPending}
        onClick={() => void showPreview()}
      >
        {preview.isPending && <Spinner className="text-current" />}
        <EyeIcon aria-hidden />
        Preview
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setEditing(true);
        }}
      >
        Edit
      </Button>

      {/*
        Disabled from the server's own flag rather than re-derived here. A
        button that offered a delete the API answers with a 409 is worse than
        no button at all.
      */}
      <Button
        size="sm"
        variant="ghost"
        disabled={!template.deletable || remove.isPending}
        title={
          template.deletable
            ? undefined
            : 'Accounts still invoice on this template — move them first'
        }
        onClick={() => void destroy()}
      >
        Delete
      </Button>

      <InvoiceTemplateDialog
        open={editing}
        template={template}
        onClose={() => {
          setEditing(false);
        }}
      />
    </li>
  );
}

/** One dialog for both create and edit — the fields are identical. */
function InvoiceTemplateDialog({
  open,
  template,
  onClose,
}: {
  open: boolean;
  template?: InvoiceTemplate;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateInvoiceTemplate();
  const update = useUpdateInvoiceTemplate();

  const [form, setForm] = useState<InvoiceTemplateWrite>(() => ({
    name: template?.name ?? '',
    brandId: template?.brandId ?? 'plastago',
    showsWeight: template?.showsWeight ?? false,
    layout: template?.layout ?? 'standard',
    accentColour: template?.accentColour ?? '#1a4d3a',
  }));
  const [error, setError] = useState<string | null>(null);

  const pending = create.isPending || update.isPending;

  const submit = async () => {
    if (form.name.trim() === '') {
      setError('Give the template a name');
      return;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(form.accentColour)) {
      setError('Use a six-digit hex colour, e.g. #1a4d3a');
      return;
    }
    setError(null);

    try {
      if (template) await update.mutateAsync({ id: template.id, body: form });
      else await create.mutateAsync(form);

      toast.success(template ? `${form.name} updated` : `${form.name} created`);
      onClose();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={template ? `Edit ${template.name}` : 'New invoice template'}
      description="What the document says and which brand it carries. The drawing itself is chosen from the list."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending && <Spinner className="text-current" />}
            {template ? 'Save' : 'Create template'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && <Alert variant="destructive" title={error} />}

        <Field id="template-name" label="Name" required>
          {(aria) => (
            <Input
              {...aria}
              value={form.name}
              placeholder="PlastaGo Recycling Invoice (m²)"
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
              }}
            />
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="template-brand" label="Brand" required>
            {(aria) => (
              <Select
                {...aria}
                value={form.brandId}
                onChange={(event) => {
                  setForm({ ...form, brandId: event.target.value as BrandId });
                }}
              >
                {BRAND_IDS.map((id) => (
                  <option key={id} value={id}>
                    {BRAND_LABELS[id]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            id="template-accent"
            label="Accent colour"
            hint="The heading rule and table accent."
          >
            {(aria) => (
              <Input
                {...aria}
                value={form.accentColour}
                placeholder="#1a4d3a"
                className="font-mono"
                onChange={(event) => {
                  setForm({ ...form, accentColour: event.target.value });
                }}
              />
            )}
          </Field>
        </div>

        <Field
          id="template-layout"
          label="Layout"
          required
          hint={INVOICE_LAYOUT_DESCRIPTIONS[form.layout]}
        >
          {(aria) => (
            <Select
              {...aria}
              value={form.layout}
              onChange={(event) => {
                setForm({ ...form, layout: event.target.value as InvoiceLayout });
              }}
            >
              {INVOICE_LAYOUTS.map((layout) => (
                <option key={layout} value={layout}>
                  {INVOICE_LAYOUT_LABELS[layout]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex items-start gap-3">
          <Switch
            checked={form.showsWeight}
            onCheckedChange={(checked) => {
              setForm({ ...form, showsWeight: checked });
            }}
            id="template-weight"
            aria-label="Print kilograms alongside square metres"
          />
          <label htmlFor="template-weight" className="text-sm">
            Print kilograms alongside square metres
            <span className="block text-xs text-muted-foreground">
              For accounts whose capture mode records weight. An m²-only account has none to
              print.
            </span>
          </label>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The invoicing settings with the derived fields removed.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 * ⚠️ `logoUrl` is minted fresh on every read — a signed link with its own
 * expiry — so two reads of an unchanged database produce two different values.
 * Anything that asks "is this the same as it was?" therefore has to compare the
 * fields a person can actually change, and nothing else.
 *
 * Both callers here learned that the hard way: the section's remount key and
 * its unsaved-changes check each said "changed" on every refetch, which
 * discarded a half-typed form and raised a navigation guard over nothing.
 */
function writable(invoicing: Settings['invoicing']): InvoicingSettings {
  const { logoUrl: _logoUrl, ...rest } = invoicing;
  return rest;
}
