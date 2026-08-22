/**
 * Typed wrappers over `/api/v1/{mail/capabilities,domains,mailboxes,aliases,quotas}`
 * (`apps/server/src/modules/mail/*.routes.ts`). Thin on purpose, mirroring
 * `auth-api.ts`: each function is a path, a method and the shared Zod
 * schema for that endpoint's response, so a route/schema change in
 * `@dwg/shared` is felt here at compile time.
 */
import { z } from 'zod';
import {
  AliasListResponseSchema,
  BulkMailboxResponseSchema,
  BulkQuotaMailboxRequestSchema,
  BulkRestrictMailboxRequestSchema,
  ChangeMailboxPasswordRequestSchema,
  ChangeMailboxPasswordResponseSchema,
  CreateAliasRequestSchema,
  CreateAliasResponseSchema,
  CreateMailboxRequestSchema,
  CreateMailboxResponseSchema,
  DeleteMailboxRequestSchema,
  DomainDetailResponseSchema,
  DomainListResponseSchema,
  MailCapabilitiesResponseSchema,
  MailQueueListResponseSchema,
  MailboxDetailResponseSchema,
  MailboxListResponseSchema,
  QuotaListResponseSchema,
  RestrictMailboxRequestSchema,
  RestrictMailboxResponseSchema,
  SetMailboxQuotaRequestSchema,
  SetMailboxQuotaResponseSchema,
  UpdateAliasRequestSchema,
  UpdateAliasResponseSchema,
  type AliasListResponse,
  type BulkMailboxResponse,
  type BulkQuotaMailboxRequest,
  type BulkRestrictMailboxRequest,
  type ChangeMailboxPasswordResponse,
  type CreateAliasRequest,
  type CreateAliasResponse,
  type CreateMailboxRequest,
  type CreateMailboxResponse,
  type DeleteMailboxRequest,
  type DomainDetailResponse,
  type DomainListResponse,
  type MailCapabilitiesResponse,
  type MailQueueListResponse,
  type MailboxDetailResponse,
  type MailboxListResponse,
  type MailboxRestrictScope,
  type QuotaListResponse,
  type RestrictMailboxResponse,
  type SetMailboxQuotaResponse,
  type UpdateAliasRequest,
  type UpdateAliasResponse,
} from '@dwg/shared';
import { request } from './api-client';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export async function fetchMailCapabilities(): Promise<MailCapabilitiesResponse> {
  return request('/api/v1/mail/capabilities', MailCapabilitiesResponseSchema, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Domains — read-only (FEATURE_MATRIX.md §2). No create/update/delete
// wrapper exists here, on purpose.
// ---------------------------------------------------------------------------

export async function fetchDomains(): Promise<DomainListResponse> {
  return request('/api/v1/domains', DomainListResponseSchema, { method: 'GET' });
}

export async function fetchDomainDetail(domain: string): Promise<DomainDetailResponse> {
  return request(`/api/v1/domains/${encodeURIComponent(domain)}`, DomainDetailResponseSchema, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

// Every field explicitly admits `| undefined` (not a bare optional) —
// callers build these with conditional spreads like `domain: x || undefined`,
// and exactOptionalPropertyTypes treats "key absent" and "key present with
// value undefined" as different things.
export interface MailboxListParams {
  readonly page?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly domain?: string | undefined;
  readonly search?: string | undefined;
  readonly sortBy?: 'email' | 'domain' | 'quota' | undefined;
  readonly sortDir?: 'asc' | 'desc' | undefined;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

export async function fetchMailboxes(params: MailboxListParams = {}): Promise<MailboxListResponse> {
  const qs = toQueryString({ ...params });
  return request(`/api/v1/mailboxes${qs}`, MailboxListResponseSchema, { method: 'GET' });
}

export async function fetchMailboxDetail(address: string): Promise<MailboxDetailResponse> {
  return request(`/api/v1/mailboxes/${encodeURIComponent(address)}`, MailboxDetailResponseSchema, {
    method: 'GET',
  });
}

export async function createMailbox(input: CreateMailboxRequest): Promise<CreateMailboxResponse> {
  const body = CreateMailboxRequestSchema.parse(input);
  return request('/api/v1/mailboxes', CreateMailboxResponseSchema, { method: 'POST', body });
}

export async function changeMailboxPassword(
  address: string,
  password: string,
): Promise<ChangeMailboxPasswordResponse> {
  const body = ChangeMailboxPasswordRequestSchema.parse({ password });
  return request(
    `/api/v1/mailboxes/${encodeURIComponent(address)}/password`,
    ChangeMailboxPasswordResponseSchema,
    { method: 'PATCH', body },
  );
}

export async function restrictMailbox(
  address: string,
  scope: MailboxRestrictScope,
  restricted: boolean,
): Promise<RestrictMailboxResponse> {
  const body = RestrictMailboxRequestSchema.parse({ scope, restricted });
  return request(
    `/api/v1/mailboxes/${encodeURIComponent(address)}/restrict`,
    RestrictMailboxResponseSchema,
    { method: 'POST', body },
  );
}

export async function setMailboxQuota(
  address: string,
  quota: string,
): Promise<SetMailboxQuotaResponse> {
  const body = SetMailboxQuotaRequestSchema.parse({ quota });
  return request(
    `/api/v1/mailboxes/${encodeURIComponent(address)}/quota`,
    SetMailboxQuotaResponseSchema,
    { method: 'PUT', body },
  );
}

export async function clearMailboxQuota(address: string): Promise<SetMailboxQuotaResponse> {
  return request(
    `/api/v1/mailboxes/${encodeURIComponent(address)}/quota`,
    SetMailboxQuotaResponseSchema,
    { method: 'DELETE' },
  );
}

/** `mailData` is required — see `@dwg/shared`'s `MailDataChoiceSchema` doc comment. There is no overload that omits it. */
export async function deleteMailbox(address: string, mailData: DeleteMailboxRequest['mailData']) {
  const body = DeleteMailboxRequestSchema.parse({ mailData });
  return request(`/api/v1/mailboxes/${encodeURIComponent(address)}`, z.void(), {
    method: 'DELETE',
    body,
  });
}

export async function bulkRestrictMailboxes(
  input: BulkRestrictMailboxRequest,
): Promise<BulkMailboxResponse> {
  const body = BulkRestrictMailboxRequestSchema.parse(input);
  return request('/api/v1/mailboxes/bulk-restrict', BulkMailboxResponseSchema, {
    method: 'POST',
    body,
  });
}

export async function bulkQuotaMailboxes(
  input: BulkQuotaMailboxRequest,
): Promise<BulkMailboxResponse> {
  const body = BulkQuotaMailboxRequestSchema.parse(input);
  return request('/api/v1/mailboxes/bulk-quota', BulkMailboxResponseSchema, {
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------------------
// Aliases / forwarding — one page, one API (FEATURE_MATRIX.md §4, §5)
// ---------------------------------------------------------------------------

export interface AliasListParams {
  readonly domain?: string | undefined;
  readonly search?: string | undefined;
  readonly type?: 'internal' | 'external' | 'mixed' | undefined;
}

export async function fetchAliases(params: AliasListParams = {}): Promise<AliasListResponse> {
  const qs = toQueryString({ ...params });
  return request(`/api/v1/aliases${qs}`, AliasListResponseSchema, { method: 'GET' });
}

export async function createAlias(input: CreateAliasRequest): Promise<CreateAliasResponse> {
  const body = CreateAliasRequestSchema.parse(input);
  return request('/api/v1/aliases', CreateAliasResponseSchema, { method: 'POST', body });
}

export async function updateAlias(
  id: string,
  input: UpdateAliasRequest,
): Promise<UpdateAliasResponse> {
  const body = UpdateAliasRequestSchema.parse(input);
  return request(`/api/v1/aliases/${encodeURIComponent(id)}`, UpdateAliasResponseSchema, {
    method: 'PUT',
    body,
  });
}

export async function deleteAlias(id: string): Promise<void> {
  await request(`/api/v1/aliases/${encodeURIComponent(id)}`, z.void(), { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Quotas / Storage — read-only report; mutations reuse the mailbox
// endpoints above (UX_ARCHITECTURE.md §5.1 row 5).
// ---------------------------------------------------------------------------

export async function fetchQuotaReport(): Promise<QuotaListResponse> {
  return request('/api/v1/quotas', QuotaListResponseSchema, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Mail queue (M11 gap-closing pass — UX_ARCHITECTURE.md §5.2). Read-only;
// see `@dwg/shared`'s `mail.ts` for why flush/hold/delete have no
// request schema here.
// ---------------------------------------------------------------------------

export async function fetchMailQueue(): Promise<MailQueueListResponse> {
  return request('/api/v1/mail/queue', MailQueueListResponseSchema, { method: 'GET' });
}
