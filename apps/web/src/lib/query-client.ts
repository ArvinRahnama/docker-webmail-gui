import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api-client';

/**
 * A 401 means the *session* is gone, not that this particular query is
 * wrong — retrying it is pointless (it will fail identically) and
 * `api-client.ts`'s `unauthenticatedHandler` already routes the admin to
 * `/login`, so retries here would just add noise before that redirect
 * lands. Everything else keeps TanStack Query's own default retry
 * behaviour.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (
    error instanceof ApiError &&
    (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN')
  ) {
    return false;
  }
  return failureCount < 3;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
