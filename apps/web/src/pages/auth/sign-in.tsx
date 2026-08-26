import { zodResolver } from '@hookform/resolvers/zod';
import { AuthIdentifierSchema, channelForIdentifier, ROLE_LABELS } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Spinner,
} from '@plastago/ui';
import { ArrowRightIcon, MailIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router';
import * as z from 'zod';
import { DEMO_IDENTITIES, DEMO_OTP_CODE } from '@/services/mock/fixtures/identities';
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
  const [showDemo, setShowDemo] = useState(false);

  // Carried by RequireAuth so a deep link survives the round trip through here.
  const from = (location.state as { from?: string } | null)?.from;

  const {
    register,
    handleSubmit,
    control,
    setError,
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sign in</CardTitle>
          <CardDescription>
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
                    className="pr-9"
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

      <DemoIdentityPanel open={showDemo} onToggle={setShowDemo} />
    </div>
  );
}

/**
 * Demo affordance, not a feature.
 *
 * A UI-only build has no directory to authenticate against, so without this
 * nobody — including the client in the demo meeting — can get past this screen.
 * It is deliberately conspicuous and clearly labelled so it cannot be mistaken
 * for product, and it is the single thing to delete when the real auth endpoints
 * land: this panel, and the `mocks/fixtures` folder it reads from.
 */
function DemoIdentityPanel({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  return (
    <Alert variant="warning" title="Demo build — no backend connected">
      <p>
        Sign in as any role below. The code is{' '}
        <code className="rounded bg-warning/15 px-1 py-0.5 font-mono font-semibold text-foreground">
          {DEMO_OTP_CODE}
        </code>
        .
      </p>

      <button
        type="button"
        onClick={() => {
          onToggle(!open);
        }}
        className="focus-ring mt-2 rounded text-xs font-medium text-foreground underline underline-offset-4"
        aria-expanded={open}
      >
        {open ? 'Hide demo sign-ins' : 'Show demo sign-ins'}
      </button>

      {open && (
        <ul className="mt-3 space-y-2 border-t border-warning/25 pt-3">
          {DEMO_IDENTITIES.map((identity) => (
            <li key={identity.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <code className="font-mono text-foreground">{identity.email ?? identity.mobile}</code>
              <Badge variant="outline">{ROLE_LABELS[identity.role]}</Badge>
              <span className="text-muted-foreground">{identity.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
