import { Card, CardContent } from '@plastago/ui';
import { SmartphoneIcon } from 'lucide-react';
import { InstallButton } from './install-button';
import { useInstallState } from '@/pwa/use-install-state';

/**
 * The install offer, stated rather than tucked into an icon.
 *
 * ── Why this exists when the shell header already has the button ──────────
 * The header button is icon-only — there is no room beside a driver's name and
 * the sync badge for the word "Install" — and an unlabelled download glyph is
 * not something anyone taps on purpose. So the header serves the driver who
 * already knows what they are looking for, and this serves the far more common
 * case: someone told to "get the app on your phone" who is now hunting for it.
 *
 * Placed on the Me screen because that is where a driver already goes for their
 * own details, the sync queue and signing out — the app's settings drawer in
 * everything but name.
 *
 * Renders nothing once installed, or where the browser cannot install at all.
 * A permanent "install me" banner on an app that IS installed is the fastest
 * way to teach someone to ignore the whole card.
 */
export function InstallCard() {
  const { state } = useInstallState();
  if (state === 'installed' || state === 'unavailable') return null;

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
            <SmartphoneIcon aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">Put PlastaGo on your home screen</p>
            <p className="text-xs text-muted-foreground">
              Opens full screen, one tap, no browser bars — and your run sheet keeps working when
              you have no signal.
            </p>
          </div>
        </div>

        <InstallButton
          variant="default"
          size="touch"
          className="w-full"
          label={state === 'instructions' ? 'Show me how' : 'Install app'}
        />
      </CardContent>
    </Card>
  );
}
