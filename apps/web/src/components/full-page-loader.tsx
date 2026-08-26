import { Spinner } from '@plastago/ui';
import { BrandMark } from '@/components/brand/brand-mark';

/**
 * The only full-screen loader in the app, shown while the session is resolving
 * and we genuinely cannot know which shell to render yet.
 *
 * Everywhere else, prefer a skeleton inside the real layout: replacing a whole
 * page with a spinner throws away the chrome the user was already looking at and
 * makes a 300 ms fetch feel like a page load.
 */
export function FullPageLoader({ label = 'Loading PlastaGo' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-6">
      <BrandMark className="h-8" />
      <Spinner label={label} />
      <p className="text-sm text-muted-foreground">{label}…</p>
    </div>
  );
}
