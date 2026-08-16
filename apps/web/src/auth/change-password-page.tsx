import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { NewPasswordSchema, SubmittedPasswordSchema } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import { useChangePasswordMutation, useLogoutMutation, useSessionQuery } from './use-session';

/**
 * A form-only schema, not `@dwg/shared`'s `ChangePasswordRequestSchema`
 * directly: it adds a "confirm new password" field purely for this UI
 * (typo protection before a request round-trip) that the API neither
 * needs nor accepts. `auth-api.ts`'s `changePassword()` still validates
 * the *submitted* `{ currentPassword, newPassword }` against the real
 * shared schema once `confirmNewPassword` is dropped below, so the
 * server-matching contract is never bypassed — this only adds a stricter
 * client-side check on top of it.
 */
const changePasswordFormSchema = z
  .object({
    currentPassword: SubmittedPasswordSchema,
    newPassword: NewPasswordSchema,
    confirmNewPassword: SubmittedPasswordSchema,
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'New password must differ from your current password.',
    path: ['newPassword'],
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Passwords do not match.',
    path: ['confirmNewPassword'],
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;

const GENERIC_FAILURE = 'Could not change your password. Check your connection and try again.';

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const session = useSessionQuery();
  const changePasswordMutation = useChangePasswordMutation();
  const logoutMutation = useLogoutMutation();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmNewPassword: '' },
  });

  const forced = session.data?.admin.forcePasswordChange ?? false;

  const onSubmit = handleSubmit(({ currentPassword, newPassword }) => {
    changePasswordMutation.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          toast.success('Password changed.');
          navigate('/', { replace: true });
        },
      },
    );
  });

  const failureMessage =
    changePasswordMutation.error instanceof ApiError
      ? changePasswordMutation.error.message
      : GENERIC_FAILURE;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-app px-4">
      <div className="w-full max-w-sm rounded-lg border border-border-default bg-bg-surface p-8 shadow-md">
        <div className="mb-6">
          <h1 className="text-h1 font-semibold text-text-primary">Change your password</h1>
          <p className="mt-1 text-body-sm text-text-secondary">
            {forced
              ? 'Your administrator set a temporary password. Choose a new one before continuing.'
              : 'Choose a new password for your account.'}
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              aria-invalid={errors.currentPassword ? true : undefined}
              aria-describedby={errors.currentPassword ? 'current-password-error' : undefined}
              {...register('currentPassword')}
            />
            {errors.currentPassword ? (
              <p
                id="current-password-error"
                role="alert"
                className="text-caption text-status-critical-fg"
              >
                {errors.currentPassword.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.newPassword ? true : undefined}
              aria-describedby={errors.newPassword ? 'new-password-error' : undefined}
              {...register('newPassword')}
            />
            {errors.newPassword ? (
              <p
                id="new-password-error"
                role="alert"
                className="text-caption text-status-critical-fg"
              >
                {errors.newPassword.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-new-password">Confirm new password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.confirmNewPassword ? true : undefined}
              aria-describedby={
                errors.confirmNewPassword ? 'confirm-new-password-error' : undefined
              }
              {...register('confirmNewPassword')}
            />
            {errors.confirmNewPassword ? (
              <p
                id="confirm-new-password-error"
                role="alert"
                className="text-caption text-status-critical-fg"
              >
                {errors.confirmNewPassword.message}
              </p>
            ) : null}
          </div>

          {changePasswordMutation.isError ? (
            <p role="alert" className="text-body-sm text-status-critical-fg">
              {failureMessage}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            pending={changePasswordMutation.isPending}
            className="w-full"
          >
            Change password
          </Button>
        </form>

        {/* §6: a forced-password-change admin must still be able to reach
            logout — this is the only other route besides /change-password
            (and the CSRF endpoint, which isn't a route) they can reach. */}
        <div className="mt-4 text-center">
          <Button
            type="button"
            variant="link"
            pending={logoutMutation.isPending}
            onClick={() => {
              logoutMutation.mutate(undefined, {
                onSuccess: () => navigate('/login', { replace: true }),
              });
            }}
          >
            Log out instead
          </Button>
        </div>
      </div>
    </div>
  );
}
