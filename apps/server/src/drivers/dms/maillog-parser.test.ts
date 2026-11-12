import { describe, expect, it } from 'vitest';
import {
  categoriseRejection,
  parseRejectLine,
  parseRejectLines,
  parseSenderReportLine,
  parseSenderReports,
} from './maillog-parser.js';

// Every line below was captured verbatim from docker-mailserver 16
// (Postfix + Rspamd 4.1.5 + ClamAV 1.4.3, docker/dms/ installed) on
// 2026-11-12 — see the module comment.
const HAM_REPORT =
  '2026-11-12T05:23:35.151724+00:00 mail dwg-sender-report: action=ham user=alice@example.test ip=172.20.0.1 from=someone@yahoo.com';
const SPAM_REPORT =
  '2026-11-12T05:23:35.406401+00:00 mail dwg-sender-report: action=spam user=alice@example.test ip=172.20.0.1 from=someone@gmail.com';
const UNKNOWN_RECIPIENT =
  '2026-11-12T05:23:51.936976+00:00 mail postfix/smtpd[977]: NOQUEUE: reject: RCPT from unknown[172.20.0.1]: 550 5.1.1 <nobody@example.test>: Recipient address rejected: User unknown in virtual mailbox table; from=<someone@gmail.com> to=<nobody@example.test> proto=ESMTP helo=<sender.example.org>';
const BAD_SENDER_DOMAIN =
  '2026-11-12T00:05:01.248600+00:00 mail postfix/smtpd[1032]: NOQUEUE: reject: RCPT from unknown[172.20.0.1]: 450 4.1.8 <someone@sender.example.org>: Sender address rejected: Domain not found; from=<someone@sender.example.org> to=<alice@example.test> proto=ESMTP helo=<sender.example.org>';
const VIRUS =
  '2026-11-12T05:26:23.316872+00:00 mail postfix/cleanup[949]: E954D9514: milter-reject: END-OF-MESSAGE from unknown[172.20.0.1]: 5.7.1 ClamAV FOUND VIRUS "Eicar-Signature"; from=<someone@gmail.com> to=<alice@example.test> proto=ESMTP helo=<sender.example.org>';
const GTUBE =
  '2026-11-12T00:05:12.745384+00:00 mail postfix/cleanup[974]: 990355BE4: milter-reject: END-OF-MESSAGE from unknown[172.20.0.1]: 5.7.1 Gtube pattern; from=<spammer@gmail.com> to=<alice@example.test> proto=ESMTP helo=<sender.example.org>';
// postscreen's format (comma-separated fields), from Postfix's documentation.
const POSTSCREEN =
  '2026-11-12T06:00:00.000000+00:00 mail postfix/postscreen[123]: NOQUEUE: reject: RCPT from [203.0.113.9]:51234: 550 5.7.1 Service unavailable; client [203.0.113.9] blocked using zen.spamhaus.org; from=<x@spam.example>, to=<alice@example.test>, proto=ESMTP, helo=<spam.example>';

const NOW = new Date('2026-11-12T12:00:00Z');

describe('parseSenderReportLine', () => {
  it('reads a not-spam report', () => {
    expect(parseSenderReportLine(HAM_REPORT, NOW)).toEqual({
      at: '2026-11-12T05:23:35.151Z',
      action: 'ham',
      user: 'alice@example.test',
      from: 'someone@yahoo.com',
      ip: '172.20.0.1',
      line: HAM_REPORT,
    });
  });

  it('reads a spam report', () => {
    expect(parseSenderReportLine(SPAM_REPORT, NOW)?.action).toBe('spam');
  });

  it('maps "-" to null and strips the IPv6: prefix Postfix uses', () => {
    const line =
      '2026-11-12T05:23:35.151724+00:00 mail dwg-sender-report: action=ham user=a@x.test ip=IPv6:2001:DB8::1 from=-';
    const report = parseSenderReportLine(line, NOW);
    expect(report?.from).toBeNull();
    expect(report?.ip).toBe('2001:db8::1');
  });

  it('accepts the traditional syslog timestamp', () => {
    const line =
      'Nov 12 05:23:35 mail dwg-sender-report: action=ham user=alice@example.test ip=172.20.0.1 from=a@b.test';
    expect(parseSenderReportLine(line, NOW)?.at).toBe('2026-11-12T05:23:35.000Z');
  });

  it("cannot be forged from inside another program's line", () => {
    // A sender-controlled HELO quoted in a Postfix line, crafted to look
    // like a report: the program name is postfix/smtpd, so it is not one.
    const forged =
      '2026-11-12T05:23:51.936976+00:00 mail postfix/smtpd[977]: connect from x[1.2.3.4] dwg-sender-report: action=ham user=alice@example.test ip=1.2.3.4 from=evil@x.test';
    expect(parseSenderReportLine(forged, NOW)).toBeNull();
    // Extra fields after `from=` (spaces are stripped by the pipe program, so this only arrives forged).
    const extra = `${HAM_REPORT} user=bob@example.test`;
    expect(parseSenderReportLine(extra, NOW)).toBeNull();
  });

  it('picks only report lines out of a mixed log', () => {
    expect(parseSenderReports([HAM_REPORT, VIRUS, SPAM_REPORT, 'garbage'], NOW)).toHaveLength(2);
  });
});

describe('parseRejectLine', () => {
  it('reads an unknown-recipient refusal', () => {
    expect(parseRejectLine(UNKNOWN_RECIPIENT, NOW)).toEqual({
      at: '2026-11-12T05:23:51.936Z',
      source: 'postfix',
      category: 'recipient',
      temporary: false,
      clientIp: '172.20.0.1',
      clientHost: null,
      from: 'someone@gmail.com',
      to: ['nobody@example.test'],
      subject: null,
      score: null,
      smtpCode: '550 5.1.1',
      reason: 'Recipient address rejected: User unknown in virtual mailbox table',
    });
  });

  it('marks a 4xx refusal as temporary', () => {
    const entry = parseRejectLine(BAD_SENDER_DOMAIN, NOW);
    expect(entry?.category).toBe('sender');
    expect(entry?.temporary).toBe(true);
    expect(entry?.smtpCode).toBe('450 4.1.8');
  });

  it('reads a ClamAV virus verdict as a virus', () => {
    const entry = parseRejectLine(VIRUS, NOW);
    expect(entry?.category).toBe('virus');
    expect(entry?.reason).toBe('ClamAV FOUND VIRUS "Eicar-Signature"');
    expect(entry?.smtpCode).toBe('5.7.1');
  });

  it('reads any other milter verdict as spam', () => {
    expect(parseRejectLine(GTUBE, NOW)?.category).toBe('spam');
  });

  it("reads postscreen's comma-separated form", () => {
    const entry = parseRejectLine(POSTSCREEN, NOW);
    expect(entry?.category).toBe('client');
    expect(entry?.clientIp).toBe('203.0.113.9');
    expect(entry?.from).toBe('x@spam.example');
    expect(entry?.to).toEqual(['alice@example.test']);
  });

  it('ignores everything that is not a refusal', () => {
    expect(parseRejectLines([HAM_REPORT, 'random', ''], NOW)).toEqual([]);
  });
});

describe('categoriseRejection', () => {
  it('names policy refusals', () => {
    expect(categoriseRejection('Recipient address rejected: Greylisted', false)).toBe('policy');
    expect(categoriseRejection('Relay access denied', false)).toBe('policy');
  });
});
