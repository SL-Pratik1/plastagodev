import { zodResolver } from '@hookform/resolvers/zod';
import type { Surface } from '@plastago/shared';
import {
  AuthIdentifierSchema,
  channelForIdentifier,
  ROLE_LABELS,
  ROLE_SURFACE,
} from '@plastago/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  Field,
  Input,
  Spinner,
} from '@plastago/ui';
import { ArrowRightIcon, MailIcon, SmartphoneIcon } from 'lucide-react';
import { useForm, useWatch } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router';
import * as z from 'zod';
import type { SeededIdentity } from '@/config/seeded-identities';
import { SEEDED_IDENTITIES } from '@/config/seeded-identities';
import { useAuth } from '@/features/auth/auth-context';
import { describeAuthError } from '@/features/auth/auth-messages';

/**
 * Step 1 of 2 — identify yourself (§9 A1/A2).
 *
 * ── Why one field for both email and mobile ────────────────────────────────
 * The screen cannot know the user's role yet, and the role is what decides the
 * channel (email for office and customer admins, SMS for site supervisors and
 * drivers). Two tabs would make the user classify themselves before they have
 * been identified — and a supervisor who picks wrong gets a dead end. One field
 * that accepts either, with the channel echoed back live as they type, removes
 * the question entirely.
 *
 * No toast on success: the next screen opens saying "we've texted a code to
 * •••• ••• 678". A toast would repeat, on top of, information already on screen.
 */
const FormSchema = z.object({ identifier: AuthIdentifierSchema });
type FormValues = z.infer<typeof FormSchema>;

export function SignInPage() {
  const { requestCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Carried by RequireAuth so a deep link survives the round trip through here.
  const from = (location.state as { from?: string } | null)?.from;

  const {
    register,
    handleSubmit,
    control,
    setError,
    setValue,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { identifier: '' },
    // Validate when the field is left, then live once it has been touched:
    // errors while someone is still typing their email are just noise.
    mode: 'onTouched',
  });

  // `useWatch` rather than `watch()`: the latter returns a fresh function each
  // render, which the React Compiler cannot memoise — so it bails out of
  // optimising the whole component. This subscribes to one field and returns a
  // value.
  const identifier = useWatch({ control, name: 'identifier' });
  const channel = identifier.trim() ? channelForIdentifier(identifier) : null;

  /**
   * Tap-to-fill: the demo panel writes into the one field rather than signing
   * in behind the user's back. The flow being demonstrated is the one-time-code
   * flow, so jumping straight to the code screen would show something the
   * product does not do — and would hide which identifier a role actually uses,
   * which is the whole point of a driver and a supervisor being on mobile.
   */
  const fillIdentifier = (identity: SeededIdentity) => {
    setValue('identifier', identity.email ?? identity.mobile ?? '', {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    });
    setFocus('identifier');
  };

  const onSubmit = async (values: FormValues) => {
    try {
      await requestCode(values.identifier);
      await navigate('/auth/verify', { state: from ? { from } : null });
    } catch (error) {
      // Every failure at this step belongs to the one field on this screen — a
      // code-related message cannot arise before a code has been issued. The
      // verify screen handles those.
      setError('identifier', { type: 'server', message: describeAuthError(error).message });
    }
  };

  return (
    <div className="space-y-5">
      {/*
        This card is the only object on its half of the screen, so it carries a
        deeper shadow than the app default — a dashboard tiles eight cards and
        needs restraint, a sign-in panel is meant to float.
      */}
      <Card className="p-1.5 shadow-[0_1px_2px_rgb(16_24_16/0.04),0_12px_32px_-8px_rgb(16_24_16/0.12)]">
        <CardHeader className="gap-1.5 p-5 pb-4">
          <CardTitle className="text-xl tracking-tight">Sign in</CardTitle>
          <CardDescription className="text-[0.9375rem]">
            We’ll send you a one-time code. No password to remember.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            onSubmit={(event) => void handleSubmit(onSubmit)(event)}
            className="space-y-5"
            noValidate
          >
            <Field
              id="identifier"
              label="Email or mobile number"
              required
              error={errors.identifier?.message}
              hint={
                channel === 'sms'
                  ? 'We’ll text your code.'
                  : channel === 'email'
                    ? 'We’ll email your code.'
                    : 'Office staff use email. Site supervisors and drivers use their mobile.'
              }
            >
              {/* Named `aria` to avoid shadowing `control` from useForm above. */}
              {(aria) => (
                <div className="relative">
                  <Input
                    {...aria}
                    {...register('identifier')}
                    type="text"
                    // `username` rather than `email`: the field takes both, and
                    // telling the password manager it is an email makes it offer
                    // the wrong autofill to a supervisor entering a mobile.
                    autoComplete="username"
                    inputMode={channel === 'sms' ? 'tel' : 'email'}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="send"
                    placeholder="you@company.com.au or 0412 345 678"
                    // Taller than the app's 36px default. This is the single
                    // field on the screen and the first thing anyone touches on
                    // a phone, where 36px is below the comfortable tap target.
                    className="h-11 pr-10 text-[0.9375rem]"
                  />
                  {channel && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
                    >
                      {channel === 'sms' ? (
                        <SmartphoneIcon className="size-4" />
                      ) : (
                        <MailIcon className="size-4" />
                      )}
                    </span>
                  )}
                </div>
              )}
            </Field>

            <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Spinner className="text-current" label="Sending your code" />
                  Sending code…
                </>
              ) : (
                <>
                  Send code
                  <ArrowRightIcon aria-hidden />
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Trouble signing in? Call the office on{' '}
        <a
          href="tel:1300395438"
          className="font-medium text-foreground underline underline-offset-4"
        >
          1300 395 438
        </a>
      </p>

      <SeededIdentityPanel onPick={fillIdentifier} />
    </div>
  );
}

/**
 * Demo affordance, not a feature.
 *
 * A UI-only build has no directory to authenticate against, so without this
 * nobody — including the client in the demo meeting — can get past this screen.
 * Tapping a role fills the field above rather than signing in, so what is being
 * demonstrated stays the real one-time-code flow.
 *
 * It is deliberately conspicuous and clearly labelled so it cannot be mistaken
 * for product, and it is the single thing to delete when the real auth endpoints
 * land: this panel, and the `mocks/fixtures` folder it reads from.
 */

/**
 * Dot colour by surface, not by role.
 *
 * Seven colours for seven roles is a legend nobody reads. Three say the thing
 * that actually changes when you tap: which application you land in.
 */
const SURFACE_DOT: Record<Surface, string> = {
  admin: 'bg-brand-600',
  portal: 'bg-info',
  driver: 'bg-warning',
};

function SeededIdentityPanel({ onPick }: { onPick: (identity: SeededIdentity) => void }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[0_1px_2px_rgb(16_24_16/0.04)]">
      <p className="text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        Seeded accounts — tap to fill
      </p>

      <ul className="mt-3 flex flex-wrap gap-2">
        {SEEDED_IDENTITIES.map((identity) => {
          const identifier = identity.email ?? identity.mobile ?? '';
          return (
            <li key={identity.role}>
              <button
                type="button"
                onClick={() => {
                  onPick(identity);
                }}
                // The identifier is what the tap actually does, so it belongs in
                // the accessible name — the chip only has room for the role, and
                // a screen reader would otherwise hear seven buttons that differ
                // by a colour it cannot see.
                aria-label={`Fill ${identifier} — ${identity.name}, ${ROLE_LABELS[identity.role]}`}
                title={`${identity.name} · ${identifier}`}
                className="focus-ring flex items-center gap-2 rounded-full border border-border bg-background py-1.5 pr-3.5 pl-3 text-xs font-medium text-foreground transition-colors hover:border-primary hover:bg-accent"
              >
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    SURFACE_DOT[ROLE_SURFACE[identity.role]],
                  )}
                />
                {ROLE_LABELS[identity.role]}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
        Development build. These are the accounts <code className="font-mono">seed:auth</code>{' '}
        creates — tap one to fill the field, then send a real code. Email codes are printed by the
        API when <code className="font-mono">MAIL_PROVIDER=stub</code>.
      </p>
    </div>
  );
}
