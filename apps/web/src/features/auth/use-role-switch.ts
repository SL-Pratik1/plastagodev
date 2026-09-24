import { ROLE_LABELS, type Role } from '@plastago/shared';
import { useToast } from '@plastago/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { roleSurfaceHref } from '@/config/surfaces';
import { useAuth } from './auth-context';
import { landingPathFor } from './permissions';

/**
 * Moving between the roles one person holds — the whole manoeuvre, in one place.
 *
 * ── Why this is a hook and not two copies of an `onSelect` ─────────────────
 * Because it is needed from both ends. The console has offered "Work as driver"
 * since the surfaces were folded together; the driver shell offered nothing at
 * all, which is what made the switch a trapdoor — an allocator who stepped into
 * the run sheet could not step back out, because typing `/admin` put him behind
 * a guard that read his now-driver role and returned him to `/driver`. Sign out
 * and a fresh code was the only way home.
 *
 * The way back has to do everything the way in does — save first, then clear
 * the cache, then cross the origin — so the two belong in one function rather
 * than in two menus that drift.
 *
 * ── The order of operations is the fix ────────────────────────────────────
 * 1. SAVE, and wait for it. The old code switched a local state and navigated
 *    in the same breath; the navigation to the driver origin is a page load,
 *    which threw the state away before anything could read it.
 * 2. CLEAR the query cache. The two surfaces share a `QueryClient`, so a run
 *    sheet mounted straight after a dispatch board would otherwise render from
 *    whatever the console had already fetched under a colliding key — and,
 *    worse, keep the office's data resident in a tab now being used on site.
 * 3. LEAVE, by page load across an origin and by route change within one.
 */
export interface RoleSwitch {
  /** Save the new role, then go to that role's home. */
  switchTo: (role: Role) => Promise<void>;
  /** True while the save is in flight, so a menu can disable itself. */
  switching: boolean;
}

export function useRoleSwitch(): RoleSwitch {
  const { switchRole } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [switching, setSwitching] = useState(false);

  const switchTo = useCallback(
    async (role: Role) => {
      if (switching) return;
      setSwitching(true);

      try {
        await switchRole(role);
      } catch {
        /*
         * Stay put and say so. The alternative — navigating anyway — lands them
         * on a surface their stored role does not open, and the guard there
         * bounces them back with no explanation at all, which is the failure
         * this whole change exists to remove.
         */
        toast.error('Could not switch roles — try again');
        setSwitching(false);
        return;
      }

      /*
       * Between surfaces, not merely between screens: the office's jobs, runs
       * and invoices have no business being served from cache to a run sheet.
       */
      queryClient.clear();

      const home = landingPathFor(role);
      const external = roleSurfaceHref(role, home);

      if (external !== null) {
        /*
         * `assign`, not `replace`: crossing to the other surface is a move the
         * person chose and may well want to undo, and the back button is the
         * cheapest possible way back. Nothing is left behind them that a guard
         * would bounce, because the role is saved before we get here.
         *
         * `switching` is deliberately left true — the page is on its way out,
         * and re-enabling the menu underneath it only invites a second click.
         */
        window.location.assign(external);
        return;
      }

      await navigate(home);
      setSwitching(false);
    },
    [navigate, queryClient, switchRole, switching, toast],
  );

  return { switchTo, switching };
}

/**
 * How to label the switch, from the point of view of the person reading it.
 *
 * "Work as driver" going in, "Back to the console" coming out — because they
 * are not the same act. One is picking up a shift; the other is putting it
 * down, and offering it as "work as allocator" would make the way out read like
 * another commitment rather than an exit.
 */
export function switchLabel(target: Role, isReturn: boolean): string {
  return isReturn ? 'Back to the console' : `Work as ${ROLE_LABELS[target].toLowerCase()}`;
}
