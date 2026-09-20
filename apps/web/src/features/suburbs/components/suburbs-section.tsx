import type { Place, PlaceWrite } from '@plastago/shared';
import {
  Alert,
  Badge,
  cn,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { useSelectableZones, useZoneOptions } from '@/features/lookups/queries';
import {
  useCreateSuburb,
  useRemoveSuburb,
  useRestoreSuburb,
  useSuburbList,
  useUpdateSuburb,
} from '@/features/suburbs/queries';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';

/**
 * The suburbs PlastaGo collects from (M6.3).
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * A job is zoned by its SUBURB, and the zone decides the service charge and the
 * per-m² rate. Until this screen, the table behind that was loaded by a seed
 * script — so "we now collect from Gregory Hills" was a deploy, and a newly
 * opened zone had no way to ever receive a job.
 *
 * ── Why it is a section and not a page ────────────────────────────────────
 * It used to be its own item under Configuration, a whole navigation group away
 * from the zones it feeds. Suburbs, zones and rate cards are one decision taken
 * in one sitting — what a job costs — so this is a tab under Settings →
 * Pricing, beside the zone register each row points at.
 *
 * ── Why it is unpaged ─────────────────────────────────────────────────────
 * It is the list of places one business goes to: a few dozen today, hundreds at
 * the very most. A page control here would be scaffolding around a list that
 * fits in a scroll, and a filter box answers the question people actually have
 * ("is Kellyville in here?") faster than paging ever would.
 */
export function SuburbsSection() {
  const [params, setParams] = useSearchParams();
  const { data, error, isPending, refetch } = useSuburbList();
  const zones = useZoneOptions().data ?? [];

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Place | null>(null);
  const [adding, setAdding] = useState(false);

  /* Deep-linked from the Zones tab: "which suburbs are in this zone?" */
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
    <div className="space-y-4">
      {/*
        ⚠️ The warning that matters on this screen.

        Re-zoning a suburb changes NOTHING about work already booked — a job
        froze its zone and its whole applied rate when it was priced. Saying so
        here is what makes an administrator willing to fix a wrong zone at all,
        instead of leaving it and quietly mispricing every future booking.
      */}
      <Alert
        variant="info"
        title="Changing a suburb’s zone reprices the next booking, never an old one"
      >
        Every job keeps the zone and the figures it was priced on, so moving a suburb is safe. It
        takes effect on the next pickup booked there.
      </Alert>

      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <span>
            <CardTitle>Suburbs</CardTitle>
            <CardDescription>
              The suburbs we collect from, and the zone each one prices in. A suburb that is not
              here means we do not go there.
            </CardDescription>
          </span>
          <Button
            size="sm"
            disabled={zones.length === 0}
            title={zones.length === 0 ? 'Add a zone first — every suburb needs one' : undefined}
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon aria-hidden />
            New suburb
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
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
            <div className="overflow-hidden rounded-lg border border-border">
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
                      <td
                        colSpan={4}
                        className="px-4 py-8 text-center text-sm text-muted-foreground"
                      >
                        {(data?.length ?? 0) === 0
                          ? 'No suburbs yet. Nothing can be booked until at least one is here.'
                          : 'Nothing matches that search.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

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
    <tr className={cn('border-b border-border/60 last:border-b-0', place.archived && 'opacity-60')}>
      <td className="px-4 py-2">
        <span className="font-medium">{place.suburb}</span>
        <span className="block text-xs text-muted-foreground">
          {place.state} {place.postcode}
          {/*
            ⚠️ Retired rows are SHOWN, not hidden. A retired suburb is not a
            different kind of thing — it is the same row with one flag — and
            hiding it is how somebody ends up re-adding a suburb that already
            exists and getting a duplicate refusal they cannot explain.
          */}
          {place.archived && <span className="ml-1 text-warning">· retired</span>}
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
          <Button variant="ghost" size="sm" disabled={place.archived} onClick={onEdit}>
            <PencilIcon aria-hidden />
            <span className="sr-only">Edit {place.suburb}</span>
          </Button>

          {/*
            One action or the other, never both. Offering "restore" on a suburb
            that was never retired is a button that cannot do anything, and the
            person clicking it has no way to know that in advance.
          */}
          {place.archived ? (
            <Button
              variant="outline"
              size="sm"
              disabled={restore.isPending}
              onClick={() => void submitRestore()}
            >
              {restore.isPending && <Spinner className="text-current" />}
              <RotateCcwIcon aria-hidden />
              Restore
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2Icon aria-hidden />
              <span className="sr-only">Remove {place.suburb}</span>
            </Button>
          )}
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

/**
 * One dialog for both create and edit — the fields are identical.
 *
 * ── Why there are no coordinate boxes on it ───────────────────────────────
 * There were, and they were the only two fields on this screen nobody could
 * answer: an office administrator adding "we now collect from Gregory Hills"
 * does not know a latitude. The server looks the suburb up instead (I3) — see
 * `locate` in `place.service.ts`.
 *
 * The pin itself is as load-bearing as it ever was: it is where every job in
 * this suburb sits on the dispatch map, and what a geocoded street address is
 * distance-checked against. So this is a change of who supplies it, not of
 * whether it exists — which is why the fields are still HERE, one click away,
 * for the two cases a lookup cannot serve:
 *
 *  • Google has never heard of the place, or the key is not configured. The
 *    save is refused, and the refusal reveals them with the reason.
 *  • The looked-up pin is wrong. This screen is the only place that can fix a
 *    pin, so a lookup that silently overrode a correction would make the
 *    correction impossible — hence editing keeps the stored pin by default and
 *    re-looking-it-up is a deliberate act.
 */
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
  const [error, setError] = useState<string | null>(null);

  /*
   * `null` means "the server finds it" — the state a NEW suburb starts in and
   * the only one most rows will ever be saved from. A pair of strings means
   * this exact pin, which is what an existing row starts in so that editing a
   * zone cannot quietly relocate a suburb somebody has already corrected.
   */
  const [pin, setPin] = useState<{ latitude: string; longitude: string } | null>(
    place ? { latitude: String(place.latitude), longitude: String(place.longitude) } : null,
  );
  const [editingPin, setEditingPin] = useState(false);

  const pending = create.isPending || update.isPending;

  const editPin = () => {
    setPin((current) => current ?? { latitude: '', longitude: '' });
    setEditingPin(true);
  };

  const lookUpPin = () => {
    setPin(null);
    setEditingPin(false);
    setError(null);
  };

  const submit = async () => {
    if (suburb.trim() === '') return setError('Name the suburb');
    if (!/^\d{4}$/.test(postcode.trim())) return setError('The postcode is four digits');
    if (zoneId === '') return setError('Choose the zone — it decides what a job there costs');

    /*
     * Only when a pin was actually supplied. Omitting it is now the normal
     * path, and an omitted pin is not an invalid one.
     *
     * ⚠️ Checked here as well as on the server, and the message says which way
     * to fix it. A positive latitude is one missing minus sign and a perfectly
     * valid coordinate — in Lebanon — so the only symptom would be the dispatch
     * map drawing the day's run across the Mediterranean.
     */
    let lat: number | undefined;
    let lng: number | undefined;
    if (pin !== null) {
      lat = Number(pin.latitude);
      lng = Number(pin.longitude);

      if (pin.latitude.trim() === '' || !Number.isFinite(lat) || lat > -9 || lat < -44) {
        setEditingPin(true);
        return setError('That latitude is not in Australia — it should be negative, like -33.7118');
      }
      if (pin.longitude.trim() === '' || !Number.isFinite(lng) || lng < 112 || lng > 154) {
        setEditingPin(true);
        return setError('That longitude is not in Australia — it should be around 150');
      }
    }

    setError(null);

    const draft: PlaceWrite = {
      suburb: suburb.trim(),
      postcode: postcode.trim(),
      state: state.trim().toUpperCase(),
      zoneId,
      // Absent, not null: the server reads "find it for me" from the omission.
      ...(lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : {}),
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
      /*
       * The one refusal this form can answer itself: the lookup found nothing,
       * so it asks for the pin rather than making the person guess what to try
       * differently. The server names the field; the toast would only have said
       * "check the highlighted fields", and none were on screen.
       */
      const fieldError = isServiceError(caught) ? caught.fieldErrors.latitude : undefined;
      if (fieldError !== undefined) {
        setPin((current) => current ?? { latitude: '', longitude: '' });
        setEditingPin(true);
        setError(`We could not find ${draft.suburb} ${draft.postcode} on the map. ${fieldError}`);
        return undefined;
      }

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

        {/*
          Three states, one block — see the note on this component. Which one is
          showing IS the answer to "where is this suburb's pin coming from?",
          which is why none of them is a checkbox somebody has to interpret.
        */}
        {editingPin && pin !== null ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                id="sub-lat"
                label="Latitude"
                required
                hint="Negative in Australia — e.g. -33.7118."
              >
                {(aria) => (
                  <Input
                    {...aria}
                    value={pin.latitude}
                    inputMode="decimal"
                    className="font-mono"
                    placeholder="-33.7118"
                    onChange={(event) => {
                      setPin({ ...pin, latitude: event.target.value });
                    }}
                  />
                )}
              </Field>

              <Field id="sub-lng" label="Longitude" required hint="Around 150 on the east coast.">
                {(aria) => (
                  <Input
                    {...aria}
                    value={pin.longitude}
                    inputMode="decimal"
                    className="font-mono"
                    placeholder="150.9542"
                    onChange={(event) => {
                      setPin({ ...pin, longitude: event.target.value });
                    }}
                  />
                )}
              </Field>
            </div>

            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <MapPinIcon aria-hidden className="size-3.5" />
              Right-click the suburb in Google Maps and copy the two numbers it shows.
              <Button variant="link" size="sm" className="h-auto px-0" onClick={lookUpPin}>
                Or find it automatically
              </Button>
            </p>
          </div>
        ) : pin !== null ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="inline-flex items-center gap-2 text-sm">
              <MapPinIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-mono text-xs tabular-nums">
                {pin.latitude}, {pin.longitude}
              </span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={editPin}>
                Change
              </Button>
              <Button variant="ghost" size="sm" onClick={lookUpPin}>
                Find it again
              </Button>
            </span>
          </div>
        ) : (
          <p className="flex flex-wrap items-center gap-1 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            <MapPinIcon aria-hidden className="size-3.5" />
            The map pin is found from the suburb, state and postcode when you save.
            <Button variant="link" size="sm" className="h-auto px-0" onClick={editPin}>
              Set it by hand instead
            </Button>
          </p>
        )}
      </div>
    </Dialog>
  );
}
