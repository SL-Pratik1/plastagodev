import { LeafIcon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react';
import { Outlet } from 'react-router';
import { BrandMark } from '@/components/brand/brand-mark';
import { ThemeToggle } from '@/components/theme/theme-toggle';

/**
 * Shell for the unauthenticated screens.
 *
 * A two-panel layout on desktop, form-only on phones. The brand panel is
 * `hidden lg:flex` rather than shrunk: on a 360px screen a site supervisor needs
 * the form above the fold, and marketing copy pushing it down is a real cost,
 * not a stylistic one. Everything the panel says is decoration — nothing in it
 * is needed to sign in.
 */
export function AuthLayout() {
  return (
    <div className="flex min-h-dvh bg-canvas">
      <aside
        aria-hidden
        className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex xl:p-16"
      >
        {/*
          A flat fill this large reads as a blocked-out rectangle. Two very low
          -opacity brand-green washes give the panel a light source — top-left,
          matching the card shadows on the other side — without becoming a
          "gradient background". Kept under 12% so the wordmark and the body copy
          keep their contrast against it.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_0%_0%,rgb(117_195_127/0.16),transparent_55%),radial-gradient(90%_70%_at_100%_100%,rgb(117_195_127/0.10),transparent_60%)]"
        />

        {/* Oversized glyph as a watermark — the logo's own recycling loop. */}
        <img
          src="/brand/plastago-mark-light.png"
          alt=""
          className="pointer-events-none absolute -right-24 -bottom-24 size-[26rem] opacity-[0.06]"
        />

        {/*
          `self-start` is load-bearing, not alignment fussiness. This aside is a
          column flex container, so its default `align-items: stretch` stretches
          the image's WIDTH to fill the panel — `w-auto` does not prevent that,
          because stretch only backs off when the cross-size is not `auto`. The
          result is a wordmark pulled to roughly 10:1 instead of its true 5.8:1.
        */}
        <BrandMark tone="light" className="h-8 self-start" />

        <div className="relative space-y-10">
          <div className="space-y-4">
            {/*
              `text-balance` rather than a hard `<br>`: the headline breaks into
              even lines at whatever width the panel resolves to between `lg` and
              a 21:9 monitor, instead of stranding one word on line two.
            */}
            <h2 className="max-w-md text-4xl leading-[1.1] font-semibold tracking-tight text-balance text-white xl:text-[2.75rem]">
              A better way with PlastaGo
            </h2>
            <p className="max-w-md text-[0.9375rem] leading-relaxed text-sidebar-muted-foreground">
              Book a pickup, follow it to completion, and download the diversion evidence your
              project reporting needs.
            </p>
          </div>

          {/* A hairline rule, not a full separator — it ends where the copy does. */}
          <div className="h-px w-16 bg-brand-400/40" />

          <ul className="space-y-5 text-sm">
            {[
              { icon: SmartphoneIcon, text: 'No passwords — we send a one-time code' },
              { icon: ShieldCheckIcon, text: 'Photo, GPS and timestamp evidence on every job' },
              { icon: LeafIcon, text: 'Plasterboard diverted from landfill, certified' },
            ].map((item) => (
              <li key={item.text} className="flex items-start gap-3.5">
                {/*
                  The ring is what stops the badge dissolving into the panel: at
                  10% white on a dark green the fill alone has almost no edge.
                */}
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/10">
                  <item.icon className="size-[1.05rem] text-brand-300" />
                </span>
                <span className="pt-1.5 leading-snug text-sidebar-foreground/90">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-sidebar-muted-foreground">
          Leumeah NSW · 1300 395 438 · All times Australia/Sydney
        </p>
      </aside>

      <main className="flex flex-1 flex-col">
        <div className="flex items-center justify-between p-4 lg:justify-end">
          <BrandMark className="h-6 lg:hidden" />
          <ThemeToggle />
        </div>

        {/*
          `max-w-sm` (384px) put the label, the input and the hint on a column
          narrower than the placeholder it has to show, so
          "you@company.com.au or 0412 345 678" clipped. 26rem fits it with room
          and still keeps the form a comfortable single-focus column.
        */}
        <div className="flex flex-1 items-center justify-center px-5 pb-16">
          <div className="w-full max-w-[26rem]">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
