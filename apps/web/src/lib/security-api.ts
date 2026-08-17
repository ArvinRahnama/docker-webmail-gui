/**
 * Typed wrappers over `/api/v1/security/*`
 * (`apps/server/src/modules/security/*.routes.ts`). Mirrors
 * `mail-api.ts`'s shape.
 */
import {
  AutoresponderStatusResponseSchema,
  ClamAvDetectionsResponseSchema,
  ClamAvStatusResponseSchema,
  ClamAvUpdateResponseSchema,
  DkimStatusResponseSchema,
  EmailAuthReportSchema,
  Fail2banStatusResponseSchema,
  Fail2banWriteResponseSchema,
  GenerateDkimRequestSchema,
  PropagationReportSchema,
  PutSieveScriptRequestSchema,
  SieveScriptDetailResponseSchema,
  SieveScriptListResponseSchema,
  SieveWriteResponseSchema,
  TlsStatusResponseSchema,
  UpdateAutoresponderRequestSchema,
  type AutoresponderStatus,
  type ClamAvDetectionsResponse,
  type ClamAvStatusResponse,
  type ClamAvUpdateResponse,
  type DkimStatus,
  type EmailAuthReport,
  type Fail2banStatusResponse,
  type GenerateDkimRequest,
  type PropagationRecordType,
  type PropagationReport,
  type SieveScriptDetailResponse,
  type SieveScriptSummary,
  type TlsStatusResponse,
  type UpdateAutoresponderRequest,
} from '@dwg/shared';
import { request } from './api-client';

export async function fetchEmailAuthReport(
  domain: string,
  selector?: string,
): Promise<EmailAuthReport> {
  const qs = selector ? `?selector=${encodeURIComponent(selector)}` : '';
  return request(`/api/v1/security/dns/${encodeURIComponent(domain)}${qs}`, EmailAuthReportSchema, {
    method: 'GET',
  });
}

// ---------------------------------------------------------------------------
// DKIM (FEATURE_MATRIX.md §11) — generate/rotate return only a public
// record; there is no request/response field anywhere that could carry a
// private key.
// ---------------------------------------------------------------------------

export async function fetchDkimStatus(domain: string, selector?: string): Promise<DkimStatus> {
  const qs = selector ? `?selector=${encodeURIComponent(selector)}` : '';
  const { status } = await request(
    `/api/v1/security/dkim/${encodeURIComponent(domain)}${qs}`,
    DkimStatusResponseSchema,
    { method: 'GET' },
  );
  return status;
}

export async function generateDkim(
  domain: string,
  input: GenerateDkimRequest = {},
): Promise<DkimStatus> {
  const body = GenerateDkimRequestSchema.parse(input);
  const { status } = await request(
    `/api/v1/security/dkim/${encodeURIComponent(domain)}/generate`,
    DkimStatusResponseSchema,
    { method: 'POST', body },
  );
  return status;
}

// ---------------------------------------------------------------------------
// TLS (FEATURE_MATRIX.md §12)
// ---------------------------------------------------------------------------

export async function fetchTlsStatus(): Promise<TlsStatusResponse> {
  return request('/api/v1/security/tls', TlsStatusResponseSchema, { method: 'GET' });
}

export async function fetchDnsPropagation(
  domain: string,
  recordType: PropagationRecordType,
  selector?: string,
): Promise<PropagationReport> {
  const params = new URLSearchParams({ recordType });
  if (selector) params.set('selector', selector);
  return request(
    `/api/v1/security/dns/${encodeURIComponent(domain)}/propagation?${params.toString()}`,
    PropagationReportSchema,
    { method: 'GET' },
  );
}

// ---------------------------------------------------------------------------
// ClamAV (FEATURE_MATRIX.md §16)
// ---------------------------------------------------------------------------

export async function fetchClamavStatus(): Promise<ClamAvStatusResponse> {
  return request('/api/v1/security/clamav', ClamAvStatusResponseSchema, { method: 'GET' });
}

export async function fetchClamavDetections(): Promise<ClamAvDetectionsResponse> {
  return request('/api/v1/security/clamav/detections', ClamAvDetectionsResponseSchema, {
    method: 'GET',
  });
}

export async function triggerClamavUpdate(): Promise<ClamAvUpdateResponse> {
  return request('/api/v1/security/clamav/update', ClamAvUpdateResponseSchema, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Fail2ban (`docs/research/03-mail-stack-components.md` §10)
// ---------------------------------------------------------------------------

export async function fetchFail2banStatus(): Promise<Fail2banStatusResponse> {
  return request('/api/v1/security/fail2ban', Fail2banStatusResponseSchema, { method: 'GET' });
}

export async function banFail2banIp(ip: string): Promise<void> {
  await request('/api/v1/security/fail2ban/ban', Fail2banWriteResponseSchema, {
    method: 'POST',
    body: { ip },
  });
}

export async function unbanFail2banIp(ip: string): Promise<void> {
  await request('/api/v1/security/fail2ban/unban', Fail2banWriteResponseSchema, {
    method: 'POST',
    body: { ip },
  });
}

// ---------------------------------------------------------------------------
// Sieve (FEATURE_MATRIX.md §17)
// ---------------------------------------------------------------------------

export async function fetchSieveScripts(user: string): Promise<readonly SieveScriptSummary[]> {
  const { scripts } = await request(
    `/api/v1/security/sieve/${encodeURIComponent(user)}`,
    SieveScriptListResponseSchema,
    { method: 'GET' },
  );
  return scripts;
}

export async function fetchSieveScript(
  user: string,
  name: string,
): Promise<SieveScriptDetailResponse> {
  return request(
    `/api/v1/security/sieve/${encodeURIComponent(user)}/${encodeURIComponent(name)}`,
    SieveScriptDetailResponseSchema,
    { method: 'GET' },
  );
}

export async function putSieveScript(user: string, name: string, content: string): Promise<void> {
  const body = PutSieveScriptRequestSchema.parse({ content });
  await request(
    `/api/v1/security/sieve/${encodeURIComponent(user)}/${encodeURIComponent(name)}`,
    SieveWriteResponseSchema,
    { method: 'PUT', body },
  );
}

export async function activateSieveScript(user: string, name: string): Promise<void> {
  await request(
    `/api/v1/security/sieve/${encodeURIComponent(user)}/${encodeURIComponent(name)}/activate`,
    SieveWriteResponseSchema,
    { method: 'POST' },
  );
}

export async function deactivateSieveScripts(user: string): Promise<void> {
  await request(
    `/api/v1/security/sieve/${encodeURIComponent(user)}/deactivate`,
    SieveWriteResponseSchema,
    { method: 'POST' },
  );
}

// ---------------------------------------------------------------------------
// Autoresponder (FEATURE_MATRIX.md §18) — built on Sieve; see
// `sieve.service.ts`'s doc comment server-side. Never a schema for raw
// Sieve text here — only structured fields.
// ---------------------------------------------------------------------------

export async function fetchAutoresponderStatus(user: string): Promise<AutoresponderStatus> {
  const { status } = await request(
    `/api/v1/security/autoresponder/${encodeURIComponent(user)}`,
    AutoresponderStatusResponseSchema,
    { method: 'GET' },
  );
  return status;
}

export async function updateAutoresponder(
  user: string,
  input: UpdateAutoresponderRequest,
): Promise<AutoresponderStatus> {
  const body = UpdateAutoresponderRequestSchema.parse(input);
  const { status } = await request(
    `/api/v1/security/autoresponder/${encodeURIComponent(user)}`,
    AutoresponderStatusResponseSchema,
    { method: 'PUT', body },
  );
  return status;
}
