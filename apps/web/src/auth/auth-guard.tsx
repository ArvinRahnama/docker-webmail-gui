import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useSessionQuery } from './use-session';

function FullPageLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg-app">
      <Loader2 className="size-6 animate-spin text-text-muted" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/**
 * The one place §6's routing rules are enforced: no session -> `/login`;
 * a session whose admin has `forcePasswordChange` set -> `/change-password`
 * regardless of which protected route was requested ("a user with
 * forcePasswordChange can reach only change-password, logout and the CSRF
 * endpoint" — logout and the CSRF endpoint are API calls, not routes, so
 * they're unaffected by this route guard either way).
 */
export function RequireAuth() {
  const location = useLocation();
  const { data, isLoading, isError } = useSessionQuery();

  if (isLoading) return <FullPageLoading />;

  // Any failure — UNAUTHENTICATED (no/expired session), a network error,
  // or a malformed response — means there is no usable session, so
  // `/login` is the right destination either way. A non-auth failure that
  // recurs surfaces again from the login page's own session check rather
  // than being swallowed here.
  if (isError || !data) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (data.admin.forcePasswordChange && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  return <Outlet />;
}

/** Wraps `/login`: an already-authenticated admin who navigates back there is sent on rather than shown the form again. */
export function RedirectIfAuthenticated() {
  const { data, isLoading } = useSessionQuery();

  if (isLoading) return <FullPageLoading />;

  if (data) {
    return <Navigate to={data.admin.forcePasswordChange ? '/change-password' : '/'} replace />;
  }

  return <Outlet />;
}
