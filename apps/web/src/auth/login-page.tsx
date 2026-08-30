import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequestSchema, type LoginRequest } from '@dwg/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BrandMark } from '@/components/brand-mark';
import { ApiError } from '@/lib/api-client';
import { useLoginMutation } from './use-session';

const GENERIC_LOGIN_FAILURE = 'Could not sign in. Check your connection and try again.';

/**
 * §6.2 Login: "Centered card, minimal ... Generic failure message; never
 * reveals whether the account exists." The server already enforces that
 * (auth.routes.ts's `/login` handler throws the same `INVALID_CREDENTIALS`
 * regardless of *why* — unknown email, wrong password, locked-out or
 * disabled account are indistinguishable by design, SECURITY.md §3.5), so
 * this page can safely render the server's own message verbatim rather
 * than maintaining a second copy of "generic" wording that could drift
 * from it.
 */
export function LoginPage() {
  const loginMutation = useLoginMutation();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginRequest>({
    resolver: zodResolver(LoginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit((values) => {
    loginMutation.mutate(values);
  });

  const failureMessage =
    loginMutation.error instanceof ApiError ? loginMutation.error.message : GENERIC_LOGIN_FAILURE;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-app px-4">
      <div className="w-full max-w-sm rounded-lg border border-border-default bg-bg-surface p-8 shadow-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark className="mb-3 size-14" />
          <h1 className="text-h1 font-semibold text-text-primary">Docker Webmail GUI</h1>
          <p className="mt-1 text-body-sm text-text-secondary">
            Sign in to manage your mail server.
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              autoFocus
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
              {...register('email')}
            />
            {errors.email ? (
              <p
                id="login-email-error"
                role="alert"
                className="text-caption text-status-critical-fg"
              >
                {errors.email.message}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? 'login-password-error' : undefined}
              {...register('password')}
            />
            {errors.password ? (
              <p
                id="login-password-error"
                role="alert"
                className="text-caption text-status-critical-fg"
              >
                {errors.password.message}
              </p>
            ) : null}
          </div>

          {loginMutation.isError ? (
            <p role="alert" className="text-body-sm text-status-critical-fg">
              {failureMessage}
            </p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            pending={loginMutation.isPending}
            className="mt-2 w-full"
          >
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
