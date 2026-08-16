/**
 * TanStack Query hooks over `lib/mail-api.ts`, one per mail page's data
 * needs (mirrors `auth/use-session.ts`'s shape). Every mutation hook
 * invalidates exactly the query keys its write could have changed —
 * mailbox/alias mutations invalidate the domains list too, since domain
 * membership counts are derived from the same underlying data
 * (FEATURE_MATRIX.md §2).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkQuotaMailboxRequest,
  BulkRestrictMailboxRequest,
  CreateAliasRequest,
  CreateMailboxRequest,
  MailboxRestrictScope,
  UpdateAliasRequest,
} from '@dwg/shared';
import {
  bulkQuotaMailboxes,
  bulkRestrictMailboxes,
  changeMailboxPassword,
  clearMailboxQuota,
  createAlias,
  createMailbox,
  deleteAlias,
  deleteMailbox,
  fetchAliases,
  fetchDomainDetail,
  fetchDomains,
  fetchMailCapabilities,
  fetchMailboxDetail,
  fetchMailboxes,
  fetchQuotaReport,
  restrictMailbox,
  setMailboxQuota,
  updateAlias,
  type AliasListParams,
  type MailboxListParams,
} from '@/lib/mail-api';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const mailCapabilitiesKey = ['mail-capabilities'] as const;
export const domainsKey = ['domains'] as const;
export const domainDetailKey = (domain: string) => ['domains', domain] as const;
export const mailboxesKey = (params: MailboxListParams) => ['mailboxes', params] as const;
export const mailboxDetailKey = (address: string) => ['mailboxes', address] as const;
export const aliasesKey = (params: AliasListParams) => ['aliases', params] as const;
export const quotasKey = ['quotas'] as const;

// ---------------------------------------------------------------------------
// Capabilities — every mail page reads this to decide UnsupportedNotice
// vs. its normal view (FEATURE_MATRIX.md §7, UX_ARCHITECTURE.md §9).
// ---------------------------------------------------------------------------

export function useMailCapabilitiesQuery() {
  return useQuery({
    queryKey: mailCapabilitiesKey,
    queryFn: fetchMailCapabilities,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Domains — read-only
// ---------------------------------------------------------------------------

export function useDomainsQuery() {
  return useQuery({ queryKey: domainsKey, queryFn: fetchDomains });
}

export function useDomainDetailQuery(domain: string) {
  return useQuery({
    queryKey: domainDetailKey(domain),
    queryFn: () => fetchDomainDetail(domain),
    enabled: domain.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

export function useMailboxesQuery(params: MailboxListParams) {
  return useQuery({ queryKey: mailboxesKey(params), queryFn: () => fetchMailboxes(params) });
}

export function useMailboxDetailQuery(address: string) {
  return useQuery({
    queryKey: mailboxDetailKey(address),
    queryFn: () => fetchMailboxDetail(address),
    enabled: address.length > 0,
  });
}

/** Every mailbox mutation invalidates this shared prefix — simplest correct rule, and mailbox lists are cheap fixture/file reads, not expensive queries worth fine-grained invalidation. */
function useInvalidateMailboxes() {
  const queryClient = useQueryClient();
  return (address?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    void queryClient.invalidateQueries({ queryKey: domainsKey });
    void queryClient.invalidateQueries({ queryKey: quotasKey });
    if (address) void queryClient.invalidateQueries({ queryKey: mailboxDetailKey(address) });
  };
}

export function useCreateMailboxMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: (input: CreateMailboxRequest) => createMailbox(input),
    onSuccess: (data) => invalidate(data.mailbox.email),
  });
}

export function useChangeMailboxPasswordMutation() {
  return useMutation({
    mutationFn: ({ address, password }: { address: string; password: string }) =>
      changeMailboxPassword(address, password),
  });
}

export function useRestrictMailboxMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: ({
      address,
      scope,
      restricted,
    }: {
      address: string;
      scope: MailboxRestrictScope;
      restricted: boolean;
    }) => restrictMailbox(address, scope, restricted),
    onSuccess: (data) => invalidate(data.mailbox.email),
  });
}

export function useSetMailboxQuotaMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: ({ address, quota }: { address: string; quota: string }) =>
      setMailboxQuota(address, quota),
    onSuccess: (data) => invalidate(data.mailbox.email),
  });
}

export function useClearMailboxQuotaMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: (address: string) => clearMailboxQuota(address),
    onSuccess: (data) => invalidate(data.mailbox.email),
  });
}

export function useDeleteMailboxMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: ({ address, mailData }: { address: string; mailData: 'delete' | 'keep' }) =>
      deleteMailbox(address, mailData),
    onSuccess: (_data, variables) => invalidate(variables.address),
  });
}

export function useBulkRestrictMailboxesMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: (input: BulkRestrictMailboxRequest) => bulkRestrictMailboxes(input),
    onSuccess: () => invalidate(),
  });
}

export function useBulkQuotaMailboxesMutation() {
  const invalidate = useInvalidateMailboxes();
  return useMutation({
    mutationFn: (input: BulkQuotaMailboxRequest) => bulkQuotaMailboxes(input),
    onSuccess: () => invalidate(),
  });
}

// ---------------------------------------------------------------------------
// Aliases / forwarding
// ---------------------------------------------------------------------------

export function useAliasesQuery(params: AliasListParams) {
  return useQuery({ queryKey: aliasesKey(params), queryFn: () => fetchAliases(params) });
}

function useInvalidateAliases() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['aliases'] });
    void queryClient.invalidateQueries({ queryKey: domainsKey });
    void queryClient.invalidateQueries({ queryKey: ['mailboxes'] }); // dependentAliases can change
  };
}

export function useCreateAliasMutation() {
  const invalidate = useInvalidateAliases();
  return useMutation({
    mutationFn: (input: CreateAliasRequest) => createAlias(input),
    onSuccess: invalidate,
  });
}

export function useUpdateAliasMutation() {
  const invalidate = useInvalidateAliases();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAliasRequest }) =>
      updateAlias(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAliasMutation() {
  const invalidate = useInvalidateAliases();
  return useMutation({
    mutationFn: (id: string) => deleteAlias(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Quotas / Storage — read-only
// ---------------------------------------------------------------------------

/**
 * `enabled` defaults to `true` for any caller that already knows quotas
 * are supported; the Storage page passes `false` while it is still
 * waiting on (or has already read a "no") from the capability document,
 * so an unsupported deployment never even issues the report request —
 * consistent with rendering `UnsupportedNotice` instead of an empty
 * table (FEATURE_MATRIX.md §7) rather than fetching anyway and hiding
 * the result.
 */
export function useQuotaReportQuery(enabled = true) {
  return useQuery({ queryKey: quotasKey, queryFn: fetchQuotaReport, enabled });
}
