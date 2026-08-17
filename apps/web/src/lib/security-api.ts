/**
 * Typed wrappers over `/api/v1/security/dns/*`
 * (`apps/server/src/modules/security/dns.routes.ts`). Mirrors
 * `mail-api.ts`'s shape.
 */
import {
  DkimStatusResponseSchema,
  EmailAuthReportSchema,
  GenerateDkimRequestSchema,
  PropagationReportSchema,
  TlsStatusResponseSchema,
  type DkimStatus,
  type EmailAuthReport,
  type GenerateDkimRequest,
  type PropagationRecordType,
  type PropagationReport,
  type TlsStatusResponse,
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
