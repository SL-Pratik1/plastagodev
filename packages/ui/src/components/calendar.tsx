import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import { enAU } from 'react-day-picker/locale';
import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/**
 * Calendar — react-day-picker, dressed in the console's own tokens.
 *
 * ── Why not the browser's date picker ─────────────────────────────────────
 * `<input type="date">` hands the drop-down to the operating system, and it
 * arrives in the OS's colours, the OS's type, and the OS's idea of a date
 * format — a blue-highlighted Chrome grid with "Clear"/"Today" links in system
 * blue, which is the same mismatch the native `<select>` had. It also honours
 * the OS locale, so an operator with a US profile sees 08/26/2026 for a field
 * the rest of the console renders as 26 Aug 2026.
 *
 * ── Styling ───────────────────────────────────────────────────────────────
 * Every class name is supplied here rather than importing the library's
 * stylesheet. The shipped CSS carries its own palette and sizing that would
 * then need overriding, and it is a second source of truth for how a day looks.
 * The keys come from the library's `UI` enum.
 *
 * The locale is pinned to en-AU: this is an Australian operation, weeks start on
 * Monday, and the month grid should not shift shape with the viewer's machine.
 */
export type CalendarProps = ComponentProps<typeof DayPicker>;

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'dropdown',
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      locale={enAU}
      weekStartsOn={1}
      showOutsideDays={showOutsideDays}
      captionLayout={captionLayout}
      className={cn('w-fit', className)}
      classNames={{
        months: 'flex flex-col gap-4 sm:flex-row',
        month: 'flex flex-col gap-3',

        // The caption is centred and the nav floats over it, so a long month
        // name ("September") cannot push the arrows out of alignment.
        month_caption: 'relative flex h-8 items-center justify-center',
        caption_label: 'relative z-[1] inline-flex items-center gap-1 whitespace-nowrap text-sm font-semibold tracking-tight',
        nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between',

        // Month/year jump — a real `<select>` sits invisibly over the visible
        // label + chevron so it keeps native keyboard and screen-reader
        // behaviour without looking like an OS control. Same trick `Select`
        // uses elsewhere in this file's family of components.
        //
        // ⚠️ The select is invisible, so its focus is too: Shift+Tab from the
        // day grid landed on two stops nobody could see. The wrapper draws the
        // same ring `focus-ring` does whenever the select inside has keyboard
        // focus.
        dropdowns: 'relative inline-flex items-center gap-1.5',
        dropdown_root:
          'relative inline-flex items-center rounded-md px-0.5 has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-2 has-[select:focus-visible]:outline-ring',
        dropdown: 'absolute inset-0 z-10 w-full cursor-pointer appearance-none border-none bg-transparent opacity-0',
        button_previous:
          'focus-ring grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        button_next:
          'focus-ring grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',

        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-[0.7rem] font-medium text-muted-foreground',
        weeks: '',
        week: 'flex w-full',

        day: 'p-0 text-center',
        day_button:
          'focus-ring grid size-9 place-items-center rounded-md text-sm tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground aria-selected:hover:bg-primary',

        // Selected wins over today: a ring under a filled cell just muddies it.
        selected:
          '[&>button]:bg-primary [&>button]:font-semibold [&>button]:text-primary-foreground',
        today: '[&>button]:font-semibold [&>button]:text-primary',
        outside: '[&>button]:text-muted-foreground/50',
        disabled: '[&>button]:pointer-events-none [&>button]:opacity-35',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        // The library renders one chevron and rotates it; supplying all three
        // directions keeps them optically identical to the rest of the UI.
        // 'down' is the small indicator next to the month/year dropdown text.
        Chevron: ({ orientation, ...rest }) => {
          if (orientation === 'left') return <ChevronLeftIcon aria-hidden className="size-4" {...rest} />;
          if (orientation === 'down') return <ChevronDownIcon aria-hidden className="size-3.5" {...rest} />;
          return <ChevronRightIcon aria-hidden className="size-4" {...rest} />;
        },
      }}
      {...props}
    />
  );
}
