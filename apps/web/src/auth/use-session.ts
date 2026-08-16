import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, ChangePasswordRequest } from '@dwg/shared';
import { changePassword, fetchSession, login, logout } from '@/lib/auth-api';

export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * The session bootstrap query (milestone brief §6). A failed fetch here
 * almost always means "not logged in" (`GET /auth/session` 401s with no
 * cookie or an expired one) rather than a transient failure worth
 * retrying, so `retry` is off — retrying would just delay the login
 * screen appearing behind a spinner for no benefit.
 */
export function useSessionQuery() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    retry: false,
    staleTime: 60_000,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credentials: LoginRequest) => login(credentials),
    onSuccess: async () => {
      // Re-fetch rather than hand-assemble SessionInfoResponse from
      // LoginResponse — the two shapes differ (session also carries
      // `expiresAt`), and this is the one endpoint that returns it.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      // A clean slate on logout: nothing cached under the previous
      // admin's session should be visible if a different admin signs in
      // on the same browser next.
      queryClient.clear();
    },
  });
}

export function useChangePasswordMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordRequest) => changePassword(input),
    onSuccess: async (data) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, (previous: unknown) => {
        if (!previous || typeof previous !== 'object') return previous;
        return { ...previous, admin: data.admin };
      });
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    },
  });
}
