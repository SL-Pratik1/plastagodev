import { zodResolver } from '@hookform/resolvers/zod';
import {
  BRAND_IDS,
  BRAND_LABELS,
  isAustralianMobile,
  ROLE_LABELS,
  ROLE_PRIMARY_CHANNEL,
  ROLES,
  type BrandId,
  type User,
} from '@plastago/shared';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import * as z from 'zod';
import { useAccountOptions } from '@/features/lookups/queries';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';
import { useCreateUser, useUpdateUser } from '../queries';

/**
 * Create or edit a user (M1.5 · W2).
 *
 * ── The validation encodes real rules, not just "required" ─────────────────
 * Three of them come straight from the scope and would be invisible bugs if
 * left to the server alone:
 *
 *  1. **A customer role must have an account.** Without one the portal cannot
 *     scope what they see — they would get everything or nothing, and both are
 *     wrong (M1.5). Conversely a staff role must NOT have one.
 *  2. **Drivers and site supervisors need a mobile**, because §9 says they sign
 *     in by SMS. An email-only site supervisor is an account nobody can use.
 *  3. **Either an email or a mobile**, never neither — there has to be somewhere
 *     to send the one-time code, since there are no passwords.
 *
 * The form states each rule as a message about the person, not about the field.
 */
const FormSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter their full name').max(80),
    email: z.string().trim(),
    mobile: z.string().trim(),
    role: z.enum(ROLES),
    jobTitle: z.string().trim().max(80),
    brandIds: z.array(z.enum(BRAND_IDS)).min(1, 'Choose at least one brand'),
    accountId: z.string(),
    notes: z.string().trim().max(500),
  })
  .check((ctx) => {
    const { email, mobile, role, accountId } = ctx.value;

    if (!email && !mobile) {
      ctx.issues.push({
        code: 'custom',
        input: email,
        path: ['email'],
        message: 'Enter an email address or a mobile number — we need somewhere to send their code',
      });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      ctx.issues.push({
        code: 'custom',
        input: email,
        path: ['email'],
        message: 'Enter a valid email address',
      });
    }
    if (mobile && !isAustralianMobile(mobile)) {
      ctx.issues.push({
        code: 'custom',
        input: mobile,
        path: ['mobile'],
        message: 'Enter a valid Australian mobile number, e.g. 0412 345 678',
      });
    }
    if ((role === 'driver' || role === 'customer-site-supervisor') && !mobile) {
      ctx.issues.push({
        code: 'custom',
        input: mobile,
        path: ['mobile'],
        message: 'This role signs in by SMS, so a mobile number is required',
      });
    }

    const isCustomerRole = role.startsWith('customer-');
    if (isCustomerRole && !accountId) {
      ctx.issues.push({
        code: 'custom',
        input: accountId,
        path: ['accountId'],
        message: 'Customer users must belong to an account — it is what scopes what they can see',
      });
    }
    if (!isCustomerRole && accountId) {
      ctx.issues.push({
        code: 'custom',
        input: accountId,
        path: ['accountId'],
        message: 'Only customer roles belong to an account',
      });
    }
  });

type FormValues = z.infer<typeof FormSchema>;

const EMPTY: FormValues = {
  name: '',
  email: '',
  mobile: '',
  role: 'office-staff',
  jobTitle: '',
  brandIds: ['plastago'],
  accountId: '',
  notes: '',
};

export interface UserFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Omit to create. Supply to edit. */
  user?: User | null;
}

export function UserFormDialog({ open, onClose, user }: UserFormDialogProps) {
  const toast = useToast();
  const accounts = useAccountOptions();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const editing = Boolean(user);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: EMPTY,
    mode: 'onTouched',
  });

  // Reset when the dialog opens so a cancelled edit does not leak into the next.
  useEffect(() => {
    if (!open) return;
    reset(
      user
        ? {
            name: user.name,
            email: user.email ?? '',
            mobile: user.mobile ?? '',
            role: user.role,
            jobTitle: user.jobTitle ?? '',
            brandIds: user.brandIds,
            accountId: user.accountId ?? '',
            notes: user.notes,
          }
        : EMPTY,
    );
  }, [open, user, reset]);

  const role = useWatch({ control, name: 'role' });
  const brandIds = useWatch({ control, name: 'brandIds' });
  const isCustomerRole = role.startsWith('customer-');
  const channel = ROLE_PRIMARY_CHANNEL[role];

  const onSubmit = async (values: FormValues) => {
    const draft = {
      ...values,
      accountId: values.accountId || null,
      brandIds: values.brandIds,
    };

    try {
      if (user) {
        await updateUser.mutateAsync({ id: user.id, draft });
        toast.success(`${values.name} updated`);
      } else {
        await createUser.mutateAsync(draft);
        toast.success(
          `Invitation sent to ${values.name}`,
          channel === 'sms'
            ? 'They will get a text with a link. Nothing to install.'
            : 'They will get an email with a link. Nothing to install.',
        );
      }
      onClose();
    } catch (caught) {
      // Field errors from the service land on their fields; anything else is a
      // form-level message. Either way the dialog stays open with the data in it.
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          setError(field as keyof FormValues, { type: 'server', message });
        }
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const toggleBrand = (brand: BrandId) => {
    setValue(
      'brandIds',
      brandIds.includes(brand) ? brandIds.filter((id) => id !== brand) : [...brandIds, brand],
      { shouldValidate: true, shouldTouch: true },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={isSubmitting ? () => undefined : onClose}
      title={editing ? `Edit ${user?.name ?? 'user'}` : 'Invite a user'}
      description={
        editing
          ? 'Changes take effect the next time they sign in.'
          : 'They will receive a one-time code. There are no passwords in this product.'
      }
      size="lg"
      dismissible={!isSubmitting}
      footer={
        <>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            form="user-form"
            type="submit"
            disabled={isSubmitting}
            className="w-full sm:w-auto"
          >
            {isSubmitting && <Spinner className="text-current" />}
            {editing ? 'Save changes' : 'Send invitation'}
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        className="space-y-4 py-2"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="user-name" label="Full name" required error={errors.name?.message}>
            {(aria) => <Input {...aria} {...register('name')} autoComplete="off" />}
          </Field>

          <Field id="user-role" label="Role" required error={errors.role?.message}>
            {(aria) => (
              <Select {...aria} {...register('role')}>
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            id="user-email"
            label="Email address"
            error={errors.email?.message}
            hint={channel === 'email' ? 'This role signs in by email code.' : undefined}
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('email')}
                type="email"
                autoComplete="off"
                placeholder="name@company.com.au"
              />
            )}
          </Field>

          <Field
            id="user-mobile"
            label="Mobile number"
            required={channel === 'sms'}
            error={errors.mobile?.message}
            hint={channel === 'sms' ? 'This role signs in by SMS code.' : undefined}
          >
            {(aria) => (
              <Input
                {...aria}
                {...register('mobile')}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="0412 345 678"
              />
            )}
          </Field>

          <Field id="user-job-title" label="Job title" error={errors.jobTitle?.message}>
            {(aria) => <Input {...aria} {...register('jobTitle')} autoComplete="off" />}
          </Field>

          <Field
            id="user-account"
            label="Account"
            required={isCustomerRole}
            error={errors.accountId?.message}
            hint={
              isCustomerRole
                ? 'Scopes the portal to this account’s sites, jobs and invoices.'
                : 'Staff roles are not tied to an account.'
            }
          >
            {(aria) => (
              <Select {...aria} {...register('accountId')} disabled={!isCustomerRole}>
                <option value="">{isCustomerRole ? 'Choose an account…' : 'Not applicable'}</option>
                {(accounts.data ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="flex items-center gap-1 text-sm font-medium">
            Brands
            <span aria-hidden className="text-destructive">
              *
            </span>
          </legend>
          <p className="text-xs text-muted-foreground">
            Brand is a dimension on every account, job and invoice — not a setting.
          </p>
          <div className="flex flex-wrap gap-4">
            {BRAND_IDS.map((brand) => (
              <label key={brand} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={brandIds.includes(brand)}
                  onChange={() => {
                    toggleBrand(brand);
                  }}
                />
                {BRAND_LABELS[brand]}
              </label>
            ))}
          </div>
          {errors.brandIds && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {errors.brandIds.message}
            </p>
          )}
        </fieldset>

        <Field id="user-notes" label="Notes" error={errors.notes?.message}>
          {(aria) => (
            <Textarea
              {...aria}
              {...register('notes')}
              rows={2}
              placeholder="Optional — internal only"
            />
          )}
        </Field>

        {role === 'driver' && (
          <Alert variant="info" title="Drivers use the separate driver app">
            This account signs in to the PlastaGo Driver app, not the console. Their run sheet,
            photos and status updates all live there.
          </Alert>
        )}
      </form>
    </Dialog>
  );
}
