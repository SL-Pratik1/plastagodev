/**
 * The Google Maps JavaScript API, loaded once, on demand (Matt, 21 Oct: *"it
 * needs an actual map behind it"*).
 *
 * It uses the same browser key as the driver's embedded map. The client's
 * DevOps turned the JavaScript API on for that key (23 Oct), so there is no
 * second key to manage. Its website list decides where it works: the real
 * hostnames do, and a host not on the list gets Google's "not authorised"
 * answer, which `loadGoogleMaps` turns into a rejection the screen can show.
 *
 * Only what the allocator's map uses is typed below. The official type package
 * is a whole dependency for five classes.
 */

const key = import.meta.env.VITE_GOOGLE_MAPS_EMBED_KEY?.trim() ?? '';

/** True when there is a key to try. Whether Google accepts it is only known on load. */
export const GOOGLE_MAPS_ENABLED = key !== '';

export interface LatLngLiteral {
  lat: number;
  lng: number;
}

export interface GoogleMap {
  fitBounds: (bounds: GoogleLatLngBounds, padding?: number) => void;
  setCenter: (center: LatLngLiteral) => void;
  setZoom: (zoom: number) => void;
  getZoom: () => number | undefined;
}

export interface GoogleLatLngBounds {
  extend: (point: LatLngLiteral) => void;
}

export interface GoogleMarker {
  setMap: (map: GoogleMap | null) => void;
  addListener: (event: 'click', handler: () => void) => { remove: () => void };
}

export interface GoogleMapsApi {
  Map: new (
    element: HTMLElement,
    options: {
      center: LatLngLiteral;
      zoom: number;
      mapTypeControl?: boolean;
      streetViewControl?: boolean;
      fullscreenControl?: boolean;
      clickableIcons?: boolean;
    },
  ) => GoogleMap;
  /**
   * The classic marker. Google lists it as deprecated in favour of
   * `AdvancedMarkerElement`, but "not scheduled to be discontinued" — and the
   * advanced one needs a Map ID the client would have to create first.
   */
  Marker: new (options: {
    map: GoogleMap;
    position: LatLngLiteral;
    title: string;
    label?: { text: string; color: string; fontSize: string; fontWeight: string };
    icon: {
      path: number;
      scale: number;
      fillColor: string;
      fillOpacity: number;
      strokeColor: string;
      strokeWeight: number;
    };
    zIndex?: number;
  }) => GoogleMarker;
  LatLngBounds: new () => GoogleLatLngBounds;
  SymbolPath: { CIRCLE: number };
}

declare global {
  interface Window {
    google?: { maps: GoogleMapsApi };
    gm_authFailure?: () => void;
    __plastagoMapsReady?: () => void;
  }
}

let loading: Promise<GoogleMapsApi> | null = null;

/** Set once Google has refused the key. It does not change without a reload. */
let keyRefused = false;
const refusalListeners = new Set<() => void>();

const KEY_REFUSED = 'Google refused the map key for this address';

/**
 * Be told when Google refuses the key.
 *
 * ⚠️ Google reports a refused key AFTER the script has loaded and the map has
 * been drawn, through `window.gm_authFailure` — so a map that loaded fine can
 * still turn into Google's grey error box a moment later. A map listens here
 * to swap itself for something useful instead.
 */
export function onMapKeyRefused(listener: () => void): () => void {
  if (keyRefused) listener();
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/**
 * The API, or a rejection saying why not.
 *
 * Cached, so every map on the page shares one script tag. A failed load is
 * NOT cached — a dropped connection should not need a page reload to retry.
 */
export function loadGoogleMaps(): Promise<GoogleMapsApi> {
  if (!GOOGLE_MAPS_ENABLED) return Promise.reject(new Error('No Google Maps key is configured'));
  if (keyRefused) return Promise.reject(new Error(KEY_REFUSED));
  if (window.google?.maps.Map) return Promise.resolve(window.google.maps);

  loading ??= new Promise<GoogleMapsApi>((resolve, reject) => {
    const fail = (message: string) => {
      loading = null;
      reject(new Error(message));
    };

    window.gm_authFailure = () => {
      keyRefused = true;
      fail(KEY_REFUSED);
      for (const listener of refusalListeners) listener();
    };
    window.__plastagoMapsReady = () => {
      if (window.google?.maps.Map) resolve(window.google.maps);
      else fail('Google Maps loaded without the map library');
    };

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=__plastagoMapsReady`;
    script.async = true;
    script.onerror = () => {
      script.remove();
      fail('Google Maps could not be reached');
    };
    document.head.append(script);
  });

  return loading;
}
