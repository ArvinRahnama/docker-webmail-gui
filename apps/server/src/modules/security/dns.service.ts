/**
 * DNS diagnostics service (FEATURE_MATRIX.md §10; UX_ARCHITECTURE.md §6.2
 * "Email Authentication"). A thin layer over `drivers/dns`: validate the
 * admin-supplied domain against the SSRF gate (SECURITY.md §3.4) before
 * it ever reaches a resolver call, then delegate to the pure checker
 * functions.
 */
import {
  checkEmailAuth,
  checkPropagation,
  validateHostnameForDns,
  type DnsLookupPort,
  type DnsLookupPortFactory,
} from '../../drivers/dns/index.js';
import { AppError } from '../../platform/errors.js';
import type { EmailAuthReport, PropagationReport, PropagationRecordType } from '@dwg/shared';

function assertValidDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  const result = validateHostnameForDns(normalized);
  if (!result.ok) {
    throw new AppError('VALIDATION_FAILED', result.error ?? 'Invalid domain.');
  }
  return normalized;
}

export class DnsService {
  constructor(
    private readonly resolver: DnsLookupPort,
    private readonly resolverFactory: DnsLookupPortFactory,
  ) {}

  async checkDomain(domain: string, selector?: string): Promise<EmailAuthReport> {
    const validated = assertValidDomain(domain);
    return checkEmailAuth(this.resolver, validated, selector !== undefined ? { selector } : {});
  }

  async checkPropagation(
    domain: string,
    recordType: PropagationRecordType,
    selector?: string,
  ): Promise<PropagationReport> {
    const validated = assertValidDomain(domain);
    return checkPropagation(this.resolverFactory, validated, recordType, selector);
  }
}
