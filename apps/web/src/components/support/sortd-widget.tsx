import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTheme } from '@/components/theme/theme-context';
import { useSupportSession } from '@/features/support/queries';

/**
 * The support bubble (Sortd) — floating on every screen behind sign-in.
 *
 * The browser never sees a Sortd key. It asks the API for a session, gets an
 * opaque one-day id, and hands only that to Sortd's loader. The API decides
 * which of PlastaGo's three Sortd apps it belongs to, from the active role.
 *
 * ── Why the loader and not a hand-built launcher ──────────────────────────
 * A custom launcher has to keep the iframe mounted and its `src` stable across
 * a minimise, or every collapse throws away the in-flight reply, the draft and
 * the scroll position. `embed.js` already does that correctly.
 */

const SCRIPT_ID = 'sortd-embed';
const ROOT_ID = 'sortd-support-root';

/**
 * Where the bubble sits.
 *
 * `above-tab-bar` is the driver phone: the shell's fixed bottom bar is where
 * the driver's thumb lives, and the bubble's default corner is on top of the
 * Report tab. The rule that moves it lives in `styles/index.css`, keyed off
 * the body attribute this component sets.
 */
export type SupportPlacement = 'default' | 'above-tab-bar';

/**
 * PlastaGo's tokens resolved to literal hex, per mode.
 *
 * ⚠️ Sortd rejects CSS variables, named colours and `rgb()`, and on a rejected
 * value it SILENTLY keeps its own amber-on-dark default — so a `var(--primary)`
 * here would look wired up and render the wrong theme. Copied from
 * `packages/ui/src/styles/theme.css`; if the palette moves, this moves with it.
 */
const PALETTE = {
  light: {
    accent: '#1b3820', // --primary → --brand-800
    accentForeground: '#ffffff', // --primary-foreground
    background: '#f7f9f6', // --canvas
    surface: '#ffffff', // --card
    text: '#1e241f', // --foreground
  },
  dark: {
    accent: '#75c37f', // --primary → --brand-500
    accentForeground: '#0e1a10',
    background: '#0b0e0b',
    surface: '#171c17',
    text: '#e8ede7',
  },
} as const;

/** 0.625rem, the console's `--radius`. */
const RADIUS = '10';

/**
 * Inter is self-hosted, and the widget renders in an iframe on Sortd's origin
 * that cannot reach our copy. The stack is passed anyway: a machine with Inter
 * installed gets the brand face, everyone else the same fallback the app uses.
 */
const FONT = "Inter, 'Open Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/** The loader's runtime surface, as much of it as this component uses. */
interface SortdSupport {
  onNavigate?: (handler: (target: { path: string; label?: string }) => void) => void;
  setTheme?: (theme: Record<string, string>) => void;
  setReportedFrom?: (location: { url?: string; label?: string }) => void;
}

declare global {
  interface Window {
    SortdSupport?: SortdSupport;
  }
}

type Mode = 'light' | 'dark';

/** The theme actually on screen — `system` resolved against the OS. */
function useResolvedMode(): Mode {
  const { mode } = useTheme();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      setSystemDark(query.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

/** The runtime form of the same theme, for `SortdSupport.setTheme`. */
function themeFor(mode: Mode): Record<string, string> {
  return { mode, ...PALETTE[mode], radius: RADIUS, font: FONT };
}

export function SortdWidget({ placement = 'default' }: { placement?: SupportPlacement }) {
  const { data } = useSupportSession();
  const navigate = useNavigate();
  const location = useLocation();
  const mode = useResolvedMode();

  /*
   * ⚠️ `navigate`, the mode and the path are held in REFS, and the install
   * effect must never depend on them directly.
   *
   * `useNavigate` returns a new function on every navigation. As a dependency
   * it would tear the widget down and re-inject the script on every route
   * change — and `embed.js` refuses to install twice (`__installed`), so the
   * re-injected script is a silent no-op and the bubble vanishes until a full
   * reload. That is armpal's bug report, verbatim: "the icon is there at
   * first, then disappears when I click into another tab".
   */
  const navigateRef = useRef(navigate);
  const modeRef = useRef(mode);
  const pathRef = useRef(location.pathname);
  useEffect(() => {
    navigateRef.current = navigate;
    modeRef.current = mode;
    pathRef.current = location.pathname;
  });

  const baseUrl = data?.enabled ? data.baseUrl : undefined;
  const sessionId = data?.enabled ? data.sessionId : undefined;

  useEffect(() => {
    if (!baseUrl || !sessionId) return;
    // Already injected — a re-render must never boot a second widget.
    if (document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = `${baseUrl}/embed.js`;
    script.defer = true;
    script.dataset.sessionId = sessionId;
    script.dataset.baseUrl = baseUrl;
    script.dataset.views = 'chat,tickets';
    script.dataset.initial = 'chat';
    script.dataset.position = 'bottom-right';
    script.dataset.openOnLoad = 'false';
    /*
     * The path only. The loader's default is the full `location.href`, query
     * string included, and a query is where a search term or a filter on a
     * customer's name lives.
     */
    script.dataset.reportedFromUrl = pathRef.current;

    const palette = PALETTE[modeRef.current];
    script.dataset.theme = modeRef.current;
    script.dataset.accent = palette.accent;
    script.dataset.accentForeground = palette.accentForeground;
    script.dataset.background = palette.background;
    script.dataset.surface = palette.surface;
    script.dataset.text = palette.text;
    script.dataset.radius = RADIUS;
    script.dataset.font = FONT;

    /*
     * Route a deep link through React Router instead of a full page load.
     * Wired on `load` because `window.SortdSupport` does not exist until the
     * script has run, and guarded because `onNavigate` only appears once Sortd
     * has a navigation map for the repo — before that, links render as text.
     */
    script.addEventListener('load', () => {
      window.SortdSupport?.onNavigate?.(({ path }) => {
        // Same-origin paths only; never let an answer send someone off-site.
        if (path.startsWith('/') && !path.startsWith('//')) void navigateRef.current(path);
      });
    });

    document.body.appendChild(script);

    return () => {
      /*
       * Teardown — on sign-out, a role switch, or anything else that unmounts
       * the shell. `embed.js` has no destroy method and installs at most once
       * per page, so an honest teardown has THREE parts:
       *
       *  1. The script tag, so the next mount injects a fresh one.
       *  2. `#sortd-support-root` — the bubble, the panel and the loader's own
       *     <style> are all inside it.
       *  3. `window.SortdSupport`. Easy to miss and fatal to omit: while
       *     `__installed` is true the loader returns at once, so signing out
       *     and back in without a reload would land on a bubble-less app.
       *
       * Its two document listeners (Escape, postMessage) cannot be removed —
       * they are anonymous — and are inert once the DOM they drive is gone.
       */
      document.getElementById(SCRIPT_ID)?.remove();
      document.getElementById(ROOT_ID)?.remove();
      delete window.SortdSupport;
    };
  }, [baseUrl, sessionId]);

  // Placement: an attribute the stylesheet keys off, present only while the
  // widget is, so a surface without a bubble keeps its own padding.
  useEffect(() => {
    if (!sessionId || placement === 'default') return;
    document.body.dataset.supportPlacement = placement;
    return () => {
      delete document.body.dataset.supportPlacement;
    };
  }, [placement, sessionId]);

  // The widget cannot see the app's theme toggle, so it is told.
  useEffect(() => {
    window.SortdSupport?.setTheme?.(themeFor(mode));
  }, [mode]);

  // Keep "which screen was this raised from" true as the person moves around.
  useEffect(() => {
    window.SortdSupport?.setReportedFrom?.({ url: location.pathname });
  }, [location.pathname]);

  // Nothing renders into the React tree — the loader owns its own DOM, and a
  // placeholder bubble that might never become real would be worse than none.
  return null;
}
