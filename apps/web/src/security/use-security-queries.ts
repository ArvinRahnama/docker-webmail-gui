/**
 * TanStack Query hooks over `lib/security-api.ts`, mirroring
 * `mail/use-mail-queries.ts`'s shape.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GenerateDkimRequest,
  PropagationRecordType,
  UpdateAutoresponderRequest,
} from '@dwg/shared';
import {
  activateSieveScript,
  banFail2banIp,
  deactivateSieveScripts,
  fetchAutoresponderStatus,
  fetchClamavDetections,
  fetchClamavStatus,
  fetchDkimStatus,
  fetchDnsPropagation,
  fetchEmailAuthReport,
  fetchFail2banStatus,
  fetchSieveScript,
  fetchSieveScripts,
  fetchTlsStatus,
  generateDkim,
  putSieveScript,
  triggerClamavUpdate,
  unbanFail2banIp,
  updateAutoresponder,
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

// ---------------------------------------------------------------------------
// ClamAV (FEATURE_MATRIX.md §16)
// ---------------------------------------------------------------------------

export const clamavStatusKey = ['security', 'clamav'] as const;
export const clamavDetectionsKey = ['security', 'clamav', 'detections'] as const;

export function useClamavStatusQuery() {
  return useQuery({ queryKey: clamavStatusKey, queryFn: fetchClamavStatus });
}

export function useClamavDetectionsQuery() {
  return useQuery({ queryKey: clamavDetectionsKey, queryFn: fetchClamavDetections });
}

export function useTriggerClamavUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: triggerClamavUpdate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clamavStatusKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Fail2ban (`docs/research/03-mail-stack-components.md` §10)
// ---------------------------------------------------------------------------

export const fail2banStatusKey = ['security', 'fail2ban'] as const;

export function useFail2banStatusQuery() {
  return useQuery({ queryKey: fail2banStatusKey, queryFn: fetchFail2banStatus });
}

export function useBanIpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: banFail2banIp,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fail2banStatusKey });
    },
  });
}

export function useUnbanIpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: unbanFail2banIp,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fail2banStatusKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Sieve (FEATURE_MATRIX.md §17)
// ---------------------------------------------------------------------------

export const sieveScriptsKey = (user: string) => ['security', 'sieve', user] as const;
export const sieveScriptKey = (user: string, name: string) =>
  ['security', 'sieve', user, name] as const;

export function useSieveScriptsQuery(user: string) {
  return useQuery({
    queryKey: sieveScriptsKey(user),
    queryFn: () => fetchSieveScripts(user),
    enabled: user.length > 0,
  });
}

export function useSieveScriptQuery(user: string, name: string) {
  return useQuery({
    queryKey: sieveScriptKey(user, name),
    queryFn: () => fetchSieveScript(user, name),
    enabled: user.length > 0 && name.length > 0,
  });
}

export function usePutSieveScriptMutation(user: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) =>
      putSieveScript(user, name, content),
    onSuccess: (_result, { name }) => {
      void queryClient.invalidateQueries({ queryKey: sieveScriptsKey(user) });
      void queryClient.invalidateQueries({ queryKey: sieveScriptKey(user, name) });
    },
  });
}

export function useActivateSieveScriptMutation(user: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => activateSieveScript(user, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sieveScriptsKey(user) });
    },
  });
}

export function useDeactivateSieveScriptsMutation(user: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deactivateSieveScripts(user),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sieveScriptsKey(user) });
    },
  });
}

// ---------------------------------------------------------------------------
// Autoresponder (FEATURE_MATRIX.md §18)
// ---------------------------------------------------------------------------

export const autoresponderStatusKey = (user: string) =>
  ['security', 'autoresponder', user] as const;

export function useAutoresponderStatusQuery(user: string) {
  return useQuery({
    queryKey: autoresponderStatusKey(user),
    queryFn: () => fetchAutoresponderStatus(user),
    enabled: user.length > 0,
  });
}

export function useUpdateAutoresponderMutation(user: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAutoresponderRequest) => updateAutoresponder(user, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: autoresponderStatusKey(user) });
      // The autoresponder writes into the same per-mailbox Sieve script
      // list this mailbox's general Sieve page also reads (its own
      // reserved script name becomes active/inactive) — invalidate that
      // too so the two pages never show stale, disagreeing state.
      void queryClient.invalidateQueries({ queryKey: sieveScriptsKey(user) });
    },
  });
}
