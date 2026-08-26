import { cn } from '@plastago/ui';

export interface BrandMarkProps {
  /** `light` is the white cut, for the dark sidebar and dark backgrounds. */
  tone?: 'dark' | 'light';
  /** `mark` is the recycling glyph alone — for collapsed rails and avatars. */
  variant?: 'wordmark' | 'mark';
  /** Set when adjacent text already says "PlastaGo", to avoid a double read. */
  decorative?: boolean;
  className?: string;
}

/**
 * The PlastaGo logo.
 *
 * The artwork is the client's own primary RGB logo — a `#193920` wordmark whose
 * final "o" is a two-arrow recycling loop. Two things follow from that shape:
 *
 *  • It is very wide (about 5.8:1), so a collapsed sidebar or an avatar slot
 *    needs the glyph on its own. That is the `mark` variant, cut from the same
 *    artwork so the curves match exactly rather than being redrawn.
 *  • The wordmark is a single solid colour, so a white cut is a recolour rather
 *    than a different asset. Both are committed, because tinting a PNG with CSS
 *    filters produces a grey-white, not white.
 *
 * Sized by height in CSS; width follows the intrinsic ratio.
 *
 * ⚠️ One trap worth knowing: inside a **column** flex container, the default
 * `align-items: stretch` pulls the image's width to fill the parent and the
 * wordmark comes out visibly stretched. `w-auto` does not save you — stretch
 * only stands down when the cross-size is something other than `auto`. Add
 * `self-start` (or `items-start` on the parent) in that case, as
 * `auth-layout.tsx` does.
 */
export function BrandMark({
  tone = 'dark',
  variant = 'wordmark',
  decorative = false,
  className,
}: BrandMarkProps) {
  const file =
    variant === 'mark'
      ? tone === 'light'
        ? 'plastago-mark-light.png'
        : 'plastago-mark.png'
      : tone === 'light'
        ? 'plastago-wordmark-light.png'
        : 'plastago-wordmark.png';

  return (
    <img
      src={`/brand/${file}`}
      alt={decorative ? '' : 'PlastaGo'}
      aria-hidden={decorative || undefined}
      // Above the fold on the sign-in screen and in every page header, so it
      // must not be lazy — a logo that pops in reads as a slow app.
      loading="eager"
      decoding="async"
      className={cn('w-auto select-none', variant === 'mark' ? 'h-8' : 'h-7', className)}
    />
  );
}
