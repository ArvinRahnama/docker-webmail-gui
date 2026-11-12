/**
 * The per-mailbox sender-lists Sieve script (docker/dms/README.md).
 *
 * docker/dms/dwg/spam-to-junk.sieve — the mail server's spam-to-Junk step,
 * once the integration is installed — runs
 *
 *     global "dwg_sender_verdict";
 *     include :personal :optional "dwg-sender-lists";
 *
 * so this script only has to set that one variable to "allow" or "block"
 * and return. It files nothing itself; Junk/Inbox routing stays in one
 * place. It is stored as a normal personal script (never activated), so a
 * mailbox's own active filter or autoresponder is untouched.
 *
 * Like the autoresponder (`autoresponder-sieve.ts`), **the script is the
 * source of truth**: every entry is written as a machine-readable comment
 * line, and reading the lists back is parsing those lines. There is no
 * database copy to drift from what the mail server actually enforces.
 *
 * Matching, most specific first, so a narrower rule always beats a wider
 * one: exact address, then exact domain, then parent domain (block before
 * allow — when two wildcard rules overlap, the safe answer is Junk), then
 * the connecting client's IP. An "allow" is ignored when Rspamd found the
 * message failing DMARC for a domain whose policy is reject or quarantine:
 * that is someone forging the allowed sender, not the sender. Rspamd strips
 * any `X-Spamd-Result` a sender supplies and writes its own, so the header
 * is trustworthy here (verified against docker-mailserver 16).
 *
 * Every value embedded below has passed `validateSenderEntryValue`
 * (letters, digits and `.` `_` `%` `+` `-` `@` `:` only), so none can close
 * a Sieve string or act as a `:matches` wildcard.
 */
import {
  SENDER_ENTRY_KINDS,
  SENDER_ENTRY_SOURCES,
  SENDER_LISTS,
  validateSenderEntryValue,
  type SenderEntryKind,
  type SenderList,
  type SenderListEntry,
} from '@dwg/shared';

export const SENDER_LISTS_SCRIPT_NAME = 'dwg-sender-lists';

const FORMAT_MARKER = '# dwg-sender-lists: v1';
const ENTRY_PATTERN =
  /^# entry: (allow|block) (address|domain|ip) (\S+) (report|admin) (\d{4}-\d\d-\d\dT[\d:.]+Z)$/;

/** Rspamd's DMARC symbols for a failing message whose domain asks receivers to reject or quarantine it. */
const SPOOFING_SYMBOLS = ['DMARC_POLICY_REJECT', 'DMARC_POLICY_QUARANTINE'] as const;

function quoteList(values: readonly string[]): string {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`;
}

function verdict(list: SenderList): string {
  if (list === 'block') {
    return `{\n    set "dwg_sender_verdict" "block";\n    return;\n}`;
  }
  return (
    `{\n    if string :is "\${dwg_spoofed}" "" {\n` +
    `        set "dwg_sender_verdict" "allow";\n        return;\n    }\n}`
  );
}

function valuesOf(
  entries: readonly SenderListEntry[],
  list: SenderList,
  kind: SenderEntryKind,
): string[] {
  return entries.filter((e) => e.list === list && e.kind === kind).map((e) => e.value);
}

/** The bracketed form a Postfix `Received` header gives an IPv6 client (`[IPv6:2001:db8::1]`), which is what the script captures. */
function ipMatchValues(ips: readonly string[]): string[] {
  return ips.flatMap((ip) => (ip.includes(':') ? [ip, `ipv6:${ip}`] : [ip]));
}

export function generateSenderListsSieve(
  mailbox: string,
  entries: readonly SenderListEntry[],
): string {
  const lines: string[] = [
    `# Docker Webmail GUI — sender allow/block lists for ${mailbox}.`,
    '# Written by the panel and rewritten whenever the lists change: edits',
    "# made here are lost. docker-mailserver's spam-to-Junk step includes this",
    '# script (docker/dms/README.md); it only sets a verdict and files nothing.',
    FORMAT_MARKER,
  ];
  for (const e of entries) {
    lines.push(`# entry: ${e.list} ${e.kind} ${e.value} ${e.source} ${e.addedAt}`);
  }
  lines.push(
    '',
    'require ["include", "variables"];',
    'global "dwg_sender_verdict";',
    '',
    "# The topmost Postfix-added Received header is this server's own and",
    '# names the connecting client in brackets.',
    'set "dwg_ip" "";',
    'if header :matches "Received" "*[*])*(Postfix)*" { set "dwg_ip" "${2}"; }',
    '',
    '# Failing DMARC for a domain that asks for rejection means the From',
    '# address is forged: an allow entry must not let that through.',
    'set "dwg_spoofed" "";',
    `if header :contains "X-Spamd-Result" ${quoteList(SPOOFING_SYMBOLS)} { set "dwg_spoofed" "yes"; }`,
  );

  const rule = (test: string, list: SenderList) => {
    lines.push('', `if ${test} ${verdict(list)}`);
  };

  for (const list of SENDER_LISTS) {
    const addresses = valuesOf(entries, list, 'address');
    if (addresses.length > 0) rule(`address :all :is "from" ${quoteList(addresses)}`, list);
  }
  for (const list of SENDER_LISTS) {
    const domains = valuesOf(entries, list, 'domain');
    if (domains.length > 0) rule(`address :domain :is "from" ${quoteList(domains)}`, list);
  }
  for (const list of ['block', 'allow'] as const) {
    const domains = valuesOf(entries, list, 'domain');
    if (domains.length > 0) {
      rule(`address :domain :matches "from" ${quoteList(domains.map((d) => `*.${d}`))}`, list);
    }
  }
  for (const list of ['block', 'allow'] as const) {
    const ips = valuesOf(entries, list, 'ip');
    if (ips.length > 0) rule(`string :is "\${dwg_ip}" ${quoteList(ipMatchValues(ips))}`, list);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The entries a script written by {@link generateSenderListsSieve} holds,
 * or `null` when the content was not written by it (no format marker) —
 * never a partial guess at a hand-edited script. Lines that fail
 * validation are dropped, so a tampered entry can never reach the
 * regenerated script.
 */
export function parseSenderListsSieve(content: string): SenderListEntry[] | null {
  const lines = content.split(/\r?\n/);
  if (!lines.includes(FORMAT_MARKER)) return null;
  const entries: SenderListEntry[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = ENTRY_PATTERN.exec(line);
    if (match === null) continue;
    const [, list, kind, value, source, addedAt] = match as unknown as [
      string,
      SenderList,
      SenderEntryKind,
      string,
      (typeof SENDER_ENTRY_SOURCES)[number],
      string,
    ];
    if (!SENDER_ENTRY_KINDS.includes(kind)) continue;
    if (validateSenderEntryValue(kind, value) !== null) continue;
    const key = `${kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ list, kind, value, source, addedAt });
  }
  return entries;
}
