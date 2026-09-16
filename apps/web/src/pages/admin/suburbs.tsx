import type { Place, PlaceWrite } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  useToast,
} from '@plastago/ui';
import { MapPinIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { useSelectableZones, useZoneOptions } from '@/features/lookups/queries';
import {
  useCreateSuburb,
  useRemoveSuburb,
  useRestoreSuburb,
  useSuburbList,
  useUpdateSuburb,
} from '@/features/suburbs/queries';
import { describeError } from '@/lib/error-message';

/**
 * The suburbs PlastaGo collects from (M6.3).
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * A job is zoned by its SUBURB, and the zone decides the service charge and the
 * per-m² rate. Until this screen, the table behind that was loaded by a seed
 * script — so "we now collect from Gregory Hills" was a deploy, and a newly
 * opened zone had no way to ever receive a job.
 *
 * ── Why it is unpaged ─────────────────────────────────────────────────────
 * It is the list of places one business goes to: a few dozen today, hundreds at
 * the very most. A page control here would be scaffolding around a list that
 * fits in a scroll, and a filter box answers the question people actually have
 * ("is Kellyville in here?") faster than paging ever would.
 */
export function AdminSuburbsPage() {
  const [params, setParams] = useSearchParams();
  const { data, error, isPending, refetch } = useSuburbList();
  const zones = useZoneOptions().data ?? [];

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Place | null>(null);
  const [adding, setAdding] = useState(false);

  /* Deep-linked from the Zones card: "which suburbs are in this zone?" */
  const zoneFilter = params.get('zoneId') ?? '';

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data ?? []).filter((place) => {
      if (zoneFilter !== '' && place.zoneId !== zoneFilter) return false;
      if (needle === '') return true;
      return (
        place.suburb.toLowerCase().includes(needle) ||
        place.postcode.startsWith(needle) ||
        place.zoneLabel.toLowerCase().includes(needle)
      );
    });
  }, [data, search, zoneFilter]);

  if (error) {
    const described = describeError(error);
    return (
      <Card className="p-6">
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={() => void refetch()}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suburbs"
        description="The suburbs we collect from, and the zone each one prices in. A suburb that is not here means we do not go there."
        actions={
          <Button
            disabled={zones.length === 0}
            title={zones.length === 0 ? 'Add a zone first — every suburb needs one' : undefined}
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon aria-hidden />
            New suburb
          </Button>
        }
      />

      {/*
        ⚠️ The warning that matters on this screen.

        Re-zoning a suburb changes NOTHING about work already booked — a job
        froze its zone and its whole applied rate when it was priced. Saying so
        here is what makes an administrator willing to fix a wrong zone at all,
        instead of leaving it and quietly mispricing every future booking.
      */}
      <Alert variant="info" title="Changing a suburb’s zone reprices the next booking, never an old one">
        Every job keeps the zone and the figures it was priced on, so moving a suburb is safe. It
        takes effect on the next pickup booked there.
      </Alert>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          Search
          <Input
            value={search}
            className="mt-1 w-64"
            placeholder="Suburb, postcode or zone"
            aria-label="Search suburbs"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </label>

        <label className="text-xs text-muted-foreground">
          Zone
          <Select
            value={zoneFilter}
            className="mt-1 w-56"
            aria-label="Filter by zone"
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value === '') next.delete('zoneId');
              else next.set('zoneId', event.target.value);
              setParams(next, { replace: true });
            }}
          >
            <option value="">All zones</option>
            {zones.map((zone) => (
              <option key={zone.value} value={zone.value}>
                {zone.archived ? `${zone.label} (retired)` : zone.label}
              </option>
            ))}
          </Select>
        </label>

        <span className="pb-2 text-xs text-muted-foreground">
          {rows.length} of {data?.length ?? 0}
        </span>
      </div>

      {isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Suburb</th>
                <th className="px-4 py-2">Zone</th>
                <th className="hidden px-4 py-2 md:table-cell">Pin</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((place) => (
                <SuburbRow
                  key={place.id}
                  place={place}
                  onEdit={() => {
                    setEditing(place);
                  }}
                />
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {(data?.length ?? 0) === 0
                      ? 'No suburbs yet. Nothing can be booked until at least one is here.'
                      : 'Nothing matches that search.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      <SuburbDialog
        key={editing?.id ?? 'new'}
        place={editing}
        open={adding || editing !== null}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function SuburbRow({ place, onEdit }: { place: Place; onEdit: () => void }) {
  const toast = useToast();
  const remove = useRemoveSuburb();
  const restore = useRestoreSuburb();

  const [confirming, setConfirming] = useState(false);

  const submitRemove = async () => {
    try {
      const archived = await remove.mutateAsync(place.id);
      setConfirming(false);

      /*
       * The server decides which of the two happened, and the toast says which.
       * "Removed" when nothing was ever collected there; "retired" when jobs
       * stand behind it and the row has to survive for them.
       */
      if (archived) {
        toast.success(
          `${place.suburb} retired`,
          'Jobs already collected there keep their address, so it stays out of the picker only.',
        );
      } else {
        toast.success(`${place.suburb} removed`);
      }
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitRestore = async () => {
    try {
      await restore.mutateAsync(place.id);
      toast.success(`${place.suburb} is back in the picker`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <tr className="border-b border-border/60 last:border-b-0">
      <td className="px-4 py-2">
        <span className="font-medium">{place.suburb}</span>
        <span className="block text-xs text-muted-foreground">
          {place.state} {place.postcode}
        </span>
      </td>

      <td className="px-4 py-2">
        <Badge variant="secondary">{place.zoneLabel}</Badge>
      </td>

      {/*
        Shown because a wrong pin plots the job in the wrong cluster on the
        dispatch map, and this is the only screen that can correct it.
      */}
      <td className="hidden px-4 py-2 font-mono text-xs tabular-nums text-muted-foreground md:table-cell">
        {place.latitude.toFixed(4)}, {place.longitude.toFixed(4)}
      </td>

      <td className="px-4 py-2 text-right">
        <span className="inline-flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <PencilIcon aria-hidden />
            <span className="sr-only">Edit {place.suburb}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending || restore.isPending}
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Trash2Icon aria-hidden />
            <span className="sr-only">Remove {place.suburb}</span>
          </Button>
          {/*
            Restoring is offered from the row itself rather than a separate
            "retired" view, because a retired suburb is not a different kind of
            thing — it is the same row with one flag, and hiding it is how
            somebody ends up re-adding a suburb that already exists.
          */}
          <Button
            variant="ghost"
            size="sm"
            disabled={restore.isPending}
            onClick={() => void submitRestore()}
          >
            <RotateCcwIcon aria-hidden />
            <span className="sr-only">Restore {place.suburb}</span>
          </Button>
        </span>

        <ConfirmDialog
          open={confirming}
          title={`Take ${place.suburb} off the picker?`}
          description="If nothing has ever been collected there it is removed outright. If jobs stand behind it, it is retired instead — they keep their address, and rebooking a futile pickup there still works."
          confirmLabel="Remove suburb"
          tone="destructive"
          pending={remove.isPending}
          onCancel={() => {
            setConfirming(false);
          }}
          onConfirm={() => void submitRemove()}
        />
      </td>
    </tr>
  );
}

/** One dialog for both create and edit — the fields are identical. */
function SuburbDialog({
  place,
  open,
  onClose,
}: {
  place: Place | null;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateSuburb();
  const update = useUpdateSuburb();

  /* The suburb's own zone stays offered even if it has since been retired. */
  const zones = useSelectableZones(place?.zoneId ?? null);

  const [suburb, setSuburb] = useState(place?.suburb ?? '');
  const [postcode, setPostcode] = useState(place?.postcode ?? '');
  const [state, setState] = useState(place?.state ?? 'NSW');
  const [zoneId, setZoneId] = useState(place?.zoneId ?? '');
  const [latitude, setLatitude] = useState(place ? String(place.latitude) : '');
  const [longitude, setLongitude] = useState(place ? String(place.longitude) : '');
  const [error, setError] = useState<string | null>(null);

  const pending = create.isPending || update.isPending;

  const submit = async () => {
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (suburb.trim() === '') return setError('Name the suburb');
    if (!/^\d{4}$/.test(postcode.trim())) return setError('The postcode is four digits');
    if (zoneId === '') return setError('Choose the zone — it decides what a job there costs');
    /*
     * ⚠️ Checked here as well as on the server, and the message says which way
     * to fix it. A positive latitude is one missing minus sign and a perfectly
     * valid coordinate — in Lebanon — so the only symptom would be the dispatch
     * map drawing the day's run across the Mediterranean.
     */
    if (!Number.isFinite(lat) || lat > -9 || lat < -44) {
      return setError('That latitude is not in Australia — it should be negative, like -33.7118');
    }
    if (!Number.isFinite(lng) || lng < 112 || lng > 154) {
      return setError('That longitude is not in Australia — it should be around 150');
    }

    setError(null);

    const draft: PlaceWrite = {
      suburb: suburb.trim(),
      postcode: postcode.trim(),
      state: state.trim().toUpperCase(),
      zoneId,
      latitude: lat,
      longitude: lng,
    };

    try {
      if (place) {
        await update.mutateAsync({ id: place.id, draft });
        toast.success(`${draft.suburb} updated`);
      } else {
        await create.mutateAsync(draft);
        toast.success(`${draft.suburb} added`, 'It is in the booking picker now.');
      }
      onClose();
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }

    return undefined;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={place ? `Edit ${place.suburb}` : 'New suburb'}
      description="The zone decides the service charge and the rate per m². The pin plots the job on the dispatch map."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => void submit()}>
            {pending && <Spinner className="text-current" />}
            {place ? 'Save suburb' : 'Add suburb'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert variant="destructive" title={error} />}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_7rem_6rem]">
          <Field id="sub-name" label="Suburb" required>
            {(aria) => (
              <Input
                {...aria}
                value={suburb}
                placeholder="Kellyville"
                onChange={(event) => {
                  setSuburb(event.target.value);
                }}
              />
            )}
          </Field>

          <Field id="sub-postcode" label="Postcode" required>
            {(aria) => (
              <Input
                {...aria}
                value={postcode}
                inputMode="numeric"
                placeholder="2155"
                onChange={(event) => {
                  setPostcode(event.target.value);
                }}
              />
            )}
          </Field>

          <Field id="sub-state" label="State" required>
            {(aria) => (
              <Input
                {...aria}
                value={state}
                placeholder="NSW"
                onChange={(event) => {
                  setState(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        <Field
          id="sub-zone"
          label="Zone"
          required
          hint="Decides the service charge and the rate per m² for every job booked here."
        >
          {(aria) => (
            <Select
              {...aria}
              value={zoneId}
              onChange={(event) => {
                setZoneId(event.target.value);
              }}
            >
              <option value="">Choose a zone…</option>
              {zones.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.archived ? `${zone.label} (retired)` : zone.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="sub-lat" label="Latitude" required hint="Negative in Australia — e.g. -33.7118.">
            {(aria) => (
              <Input
                {...aria}
                value={latitude}
                inputMode="decimal"
                className="font-mono"
                placeholder="-33.7118"
                onChange={(event) => {
                  setLatitude(event.target.value);
                }}
              />
            )}
          </Field>

          <Field id="sub-lng" label="Longitude" required hint="Around 150 on the east coast.">
            {(aria) => (
              <Input
                {...aria}
                value={longitude}
                inputMode="decimal"
                className="font-mono"
                placeholder="150.9542"
                onChange={(event) => {
                  setLongitude(event.target.value);
                }}
              />
            )}
          </Field>
        </div>

        {place === null && (
          <Alert variant="neutral" title="Where the pin comes from">
            <span className="inline-flex items-center gap-1">
              <MapPinIcon aria-hidden className="size-3.5" />
              Right-click the suburb in Google Maps and copy the two numbers it shows.
            </span>
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
