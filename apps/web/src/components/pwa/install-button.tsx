import { Button, Dialog, useToast, type ButtonProps } from '@plastago/ui';
import { DownloadIcon, PlusSquareIcon, ShareIcon } from 'lucide-react';
import { useState } from 'react';
import { useInstallState } from '@/pwa/use-install-state';

export interface InstallButtonProps {
  /** Passed through so the driver header and a page body can size it differently. */
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  /** `false` for the icon-only button in a cramped header. */
  showLabel?: boolean;
  label?: string;
}

/**
 * "Install app" — the real one, not a link to somewhere else.
 *
 * This works because the driver screens live in THIS app: the page installs
 * itself, which is the only kind of install a browser permits. See the note at
 * the top of `pwa/install-prompt.ts` for why that constraint drove the whole
 * shape of the migration.
 *
 * ── Three outcomes, and only one of them is a button that installs ─────────
 * On Chromium it opens the native prompt. On iOS — where Apple ships no install
 * API and every browser is WebKit underneath — it opens a dialog describing the
 * Share → Add to Home Screen gesture, because the alternative is a button that
 * appears to do nothing. Where neither applies it renders NOTHING at all, so
 * nobody is offered a control that cannot work.
 */
export function InstallButton({
  variant = 'outline',
  size = 'sm',
  className,
  showLabel = true,
  label = 'Install app',
}: InstallButtonProps) {
  const { state, install } = useInstallState();
  const { success } = useToast();
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  // Already on the home screen, or a browser that cannot do this. Either way
  // there is nothing honest to offer.
  if (state === 'installed' || state === 'unavailable') return null;

  const handleClick = async () => {
    if (state === 'instructions') {
      setInstructionsOpen(true);
      return;
    }

    const outcome = await install();
    if (outcome === 'accepted') {
      success('Installing', 'PlastaGo will appear on your home screen in a moment.');
    }
    // A dismissal is silent on purpose. Someone who just declined does not need
    // to be told they declined.
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => void handleClick()}
      >
        <DownloadIcon aria-hidden className="size-4 shrink-0" />
        {showLabel ? label : <span className="sr-only">{label}</span>}
      </Button>

      <IosInstructionsDialog
        open={instructionsOpen}
        onClose={() => {
          setInstructionsOpen(false);
        }}
      />
    </>
  );
}

/**
 * The iPhone path, written as the two taps it actually is.
 *
 * Deliberately not a paragraph of prose: this is read one-handed, on a phone,
 * usually by someone who has been told "just install it" and is now looking for
 * a button that does not exist. Naming the icons — and drawing them — is what
 * makes it followable, because "Share" on iOS is a square with an arrow and is
 * not labelled with the word.
 */
function IosInstructionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Add PlastaGo to your home screen"
      description="On iPhone and iPad, Apple asks you to do this yourself — it takes two taps."
      footer={
        <Button type="button" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <ol className="space-y-4 text-sm">
        <li className="flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold">
            1
          </span>
          <span className="flex flex-wrap items-center gap-1.5 pt-1">
            Tap
            <ShareIcon aria-hidden className="size-4" />
            <strong>Share</strong> in the browser toolbar.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-bold">
            2
          </span>
          <span className="flex flex-wrap items-center gap-1.5 pt-1">
            Scroll down and choose
            <PlusSquareIcon aria-hidden className="size-4" />
            <strong>Add to Home Screen</strong>.
          </span>
        </li>
      </ol>

      <p className="mt-4 text-xs text-muted-foreground">
        The app then opens full screen, with no browser bars — and your run sheet keeps working when
        you have no signal.
      </p>
    </Dialog>
  );
}
