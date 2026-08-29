import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/**
 * Popover — an anchored panel that escapes its container.
 *
 * Radix rather than absolute positioning, because the one thing this is used
 * for is a date picker hanging off a field inside a card or a dialog: it has to
 * render in a portal to avoid the ancestor's `overflow: hidden`, and it has to
 * flip when the field sits near the bottom of the viewport. Those two are
 * exactly what hand-rolled popovers get wrong.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export interface PopoverContentProps extends ComponentProps<typeof PopoverPrimitive.Content> {
  /**
   * Where to portal the panel. Pass the enclosing `<dialog>` when the popover
   * lives inside a modal `Dialog` — the default `document.body` portal is in
   * the normal document, which the top layer paints over. `usePortalContainer`
   * resolves it; see that hook for the full explanation.
   */
  container?: HTMLElement;
}

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  container,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none',
          'data-[state=open]:animate-[var(--animate-zoom-in)]',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
