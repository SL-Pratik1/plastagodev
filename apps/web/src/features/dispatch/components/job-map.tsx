import type { MapPin } from '@plastago/shared';
import { Skeleton } from '@plastago/ui';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  loadGoogleMaps,
  onMapKeyRefused,
  type GoogleMap,
  type GoogleMapsApi,
  type GoogleMarker,
} from '@/lib/google-maps';

/**
 * Pin colours, as hex: the pins are drawn by Google on its own tiles, where the
 * app's CSS variables do not reach. Light-theme values of the same tokens the
 * legend uses (`--brand-600`, `--warning`, `--destructive`).
 */
const PIN_COLOURS = { onRun: '#4e9a5b', notOnRun: '#a65a08', atRisk: '#c0362c' } as const;

/** At risk outranks everything: that is the pin the allocator must not miss. */
function pinColour(pin: MapPin): string {
  if (pin.atRisk) return PIN_COLOURS.atRisk;
  return pin.runId === null ? PIN_COLOURS.notOnRun : PIN_COLOURS.onRun;
}

/** The hover text — there is no room on a pin for more than its number. */
function pinTitle(pin: MapPin): string {
  const run = pin.runName ?? 'Not on a run';
  const driver = pin.driverName ? ` · ${pin.driverName}` : '';
  const risk = pin.atRisk ? ' · At risk' : '';
  return `#${String(pin.jobNumber)} · ${pin.accountName} · ${pin.suburb} · ${run}${driver}${risk}`;
}

/** Where the map opens before the pins frame it: Sydney. */
const SYDNEY = { lat: -33.8688, lng: 151.2093 };

/**
 * The allocator's map (Matt, 21 Oct: *"If I can see them on an actual map
 * based on that pin location… it has value, but it needs an actual map behind
 * it"*).
 *
 * Each job at its site pin, coloured on a run / not on a run / at risk.
 * Clicking a pin opens the job.
 *
 * ── Why the pins are redrawn but the view is not ──────────────────────────
 * The pins re-read every 20 seconds. Re-framing on each read would throw away
 * wherever the allocator had panned or zoomed to, so the map frames the pins
 * once per day shown, and after that only the pins themselves change.
 *
 * `onUnavailable` hears why Google would not draw a map — no key, the key
 * refused at this address, no connection — so the screen can fall back to the
 * plotted layout instead of Google's grey error box.
 */
export function JobMap({
  pins,
  date,
  onUnavailable,
}: {
  pins: readonly MapPin[];
  date: string;
  onUnavailable: (reason: string) => void;
}) {
  const navigate = useNavigate();
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<GoogleMap | null>(null);
  const markers = useRef<GoogleMarker[]>([]);
  const framedFor = useRef<string | null>(null);
  const [api, setApi] = useState<GoogleMapsApi | null>(null);

  // The latest pins, for the drawing effect below — which is keyed on what they
  // SAY, not on the array, which is new on every 20-second read. Synced in an
  // effect declared first, so it is current by the time the drawing runs.
  const latest = useRef(pins);
  useEffect(() => {
    latest.current = pins;
  }, [pins]);
  const signature = pins
    .map((pin) => `${pin.id}:${String(pin.latitude)}:${String(pin.longitude)}:${pinColour(pin)}`)
    .join('|');

  useEffect(() => {
    let live = true;
    loadGoogleMaps().then(
      (loaded) => {
        if (live) setApi(loaded);
      },
      (error: unknown) => {
        if (live) onUnavailable(error instanceof Error ? error.message : 'The map could not load');
      },
    );
    const stopListening = onMapKeyRefused(() => {
      if (live) onUnavailable('Google refused the map key for this address');
    });
    return () => {
      live = false;
      stopListening();
    };
  }, [onUnavailable]);

  useEffect(() => {
    if (!api || !element.current || map.current) return;
    map.current = new api.Map(element.current, {
      center: SYDNEY,
      zoom: 9,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      // Google's own shops and parks are noise on a map of pickups.
      clickableIcons: false,
    });
  }, [api]);

  useEffect(() => {
    const current = map.current;
    if (!api || !current) return;

    for (const marker of markers.current) marker.setMap(null);
    markers.current = latest.current.map((pin) => {
      const marker = new api.Marker({
        map: current,
        position: { lat: pin.latitude, lng: pin.longitude },
        title: pinTitle(pin),
        // The last two digits, as on the board's cards — enough to tell
        // neighbours apart; the full number is in the hover text.
        label: {
          text: String(pin.jobNumber % 100).padStart(2, '0'),
          color: '#ffffff',
          fontSize: '10px',
          fontWeight: '600',
        },
        icon: {
          path: api.SymbolPath.CIRCLE,
          scale: 11,
          fillColor: pinColour(pin),
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        zIndex: pin.atRisk ? 2 : 1,
      });
      marker.addListener('click', () => {
        void navigate(`/admin/jobs/${pin.id}`);
      });
      return marker;
    });

    const positions = latest.current.map((pin) => ({ lat: pin.latitude, lng: pin.longitude }));
    if (framedFor.current !== date && positions.length > 0) {
      framedFor.current = date;
      const [only] = positions;
      if (positions.length === 1 && only) {
        current.setCenter(only);
        current.setZoom(14);
      } else {
        const bounds = new api.LatLngBounds();
        for (const position of positions) bounds.extend(position);
        current.fitBounds(bounds, 48);
      }
    }
  }, [api, signature, date, navigate]);

  // Pins belong to this map; leaving the tab takes them with it.
  useEffect(
    () => () => {
      for (const marker of markers.current) marker.setMap(null);
      markers.current = [];
    },
    [],
  );

  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border">
        <div
          ref={element}
          role="region"
          aria-label="Map of the jobs for this day"
          className="size-full"
        />
        {!api && <Skeleton className="absolute inset-0 rounded-none" />}
      </div>

      {/* Under the map, not on it: Google's logo and terms sit in its corners. */}
      <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: PIN_COLOURS.onRun }} />
          On a run
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: PIN_COLOURS.notOnRun }} />
          Not on a run
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-full" style={{ background: PIN_COLOURS.atRisk }} />
          At risk
        </li>
      </ul>
    </div>
  );
}
