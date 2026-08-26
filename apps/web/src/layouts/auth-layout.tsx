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
        className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex"
      >
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

        <div className="relative space-y-8">
          <div className="space-y-3">
            <p className="font-display text-3xl leading-tight font-semibold text-white">
              A better way with PlastaGo
            </p>
            <p className="max-w-md text-sm text-sidebar-muted-foreground">
              Book a pickup, follow it to completion, and download the diversion evidence your
              project reporting needs.
            </p>
          </div>

          <ul className="space-y-4 text-sm">
            {[
              { icon: SmartphoneIcon, text: 'No passwords — we send a one-time code' },
              { icon: ShieldCheckIcon, text: 'Photo, GPS and timestamp evidence on every job' },
              { icon: LeafIcon, text: 'Plasterboard diverted from landfill, certified' },
            ].map((item) => (
              <li key={item.text} className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10">
                  <item.icon className="size-4 text-brand-300" />
                </span>
                <span className="text-sidebar-foreground">{item.text}</span>
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

        <div className="flex flex-1 items-center justify-center px-4 pb-12">
          <div className="w-full max-w-sm">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
