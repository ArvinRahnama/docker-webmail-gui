/**
 * TanStack Query hooks over `lib/security-api.ts`, mirroring
 * `mail/use-mail-queries.ts`'s shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GenerateDkimRequest, PropagationRecordType } from '@dwg/shared';
import {
  fetchDkimStatus,
  fetchDnsPropagation,
  fetchEmailAuthReport,
  fetchTlsStatus,
  generateDkim,
} from '@/lib/security-api';

export const emailAuthReportKey = (domain: string, selector: string) =>
  ['security', 'dns', domain, selector] as const;

export function useEmailAuthReportQuery(domain: string, selector: string) {
  return useQuery({
    queryKey: emailAuthReportKey(domain, selector),
    queryFn: () => fetchEmailAuthReport(domain, selector),
    enabled: domain.length > 0,
  });
}

// ---------------------------------------------------------------------------
// DKIM (FEATURE_MATRIX.md §11)
// ---------------------------------------------------------------------------

export const dkimStatusKey = (domain: string, selector: string) =>
  ['security', 'dkim', domain, selector] as const;

export function useDkimStatusQuery(domain: string, selector: string) {
  return useQuery({
    queryKey: dkimStatusKey(domain, selector),
    queryFn: () => fetchDkimStatus(domain, selector),
    enabled: domain.length > 0,
  });
}

// ---------------------------------------------------------------------------
// TLS (FEATURE_MATRIX.md §12)
// ---------------------------------------------------------------------------

export const tlsStatusKey = ['security', 'tls'] as const;

export function useTlsStatusQuery() {
  return useQuery({ queryKey: tlsStatusKey, queryFn: fetchTlsStatus });
}

export function useGenerateDkimMutation(domain: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateDkimRequest) => generateDkim(domain, input),
    onSuccess: (status) => {
      void queryClient.invalidateQueries({ queryKey: ['security', 'dkim', domain] });
      void queryClient.invalidateQueries({ queryKey: emailAuthReportKey(domain, status.selector) });
    },
  });
}

export const dnsPropagationKey = (
  domain: string,
  recordType: PropagationRecordType,
  selector: string,
) => ['security', 'dns-propagation', domain, recordType, selector] as const;

export function useDnsPropagationQuery(
  domain: string,
  recordType: PropagationRecordType,
  selector: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: dnsPropagationKey(domain, recordType, selector),
    queryFn: () => fetchDnsPropagation(domain, recordType, selector),
    enabled: enabled && domain.length > 0,
  });
}
