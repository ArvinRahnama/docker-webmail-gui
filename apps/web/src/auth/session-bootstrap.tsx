import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { setUnauthenticatedHandler } from '@/lib/api-client';
import { SESSION_QUERY_KEY } from './use-session';

/**
 * Wires `api-client.ts`'s session-expiry hook to a real SPA navigation
 * — an expired session sends the admin to the login screen rather than
 * surfacing a raw 401. Mounted once, inside the router, so `useNavigate`
 * is available — `api-client.ts` itself stays framework-agnostic and
 * falls back to a hard `location.assign` if this never mounts (e.g. a
 * unit test that exercises the client directly).
 */
export function SessionBootstrap() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      // Drop the stale session from the cache before navigating, so a
      // guard reading it on the next render doesn't briefly see
      // "authenticated" data that's already known to be wrong.
      queryClient.setQueryData(SESSION_QUERY_KEY, undefined);
      navigate('/login', { replace: true });
    });
  }, [navigate, queryClient]);

  return null;
}
