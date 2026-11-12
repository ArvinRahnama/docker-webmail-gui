import { describe, expect, it } from 'vitest';
import { FakeBrokerClient } from '../../drivers/broker/fake-broker-client.js';
import { FakeDmsDriver } from '../../drivers/dms/fake-dms-driver.js';
import { FakeRspamdClient } from '../../drivers/rspamd/fake-client.js';
import { collectSenderReportsOnce } from './sender-report-collector.js';
import { SenderListsService } from './sender-lists.service.js';
import { authedInject, loginAs, setUpSecurityApp, testLogger } from './security-test-harness.js';
import { mergeRejections } from './rejected-mail.service.js';
import { parseRejectLine } from '../../drivers/dms/maillog-parser.js';
import { parseRspamdHistory } from '../../drivers/rspamd/parse-history.js';

const MAILBOX = 'user1@example.com';

class RspamdEnabledDriver extends FakeDmsDriver {
  override async getCapabilities() {
    const base = await super.getCapabilities();
    return { ...base, rspamd: { supported: true, reason: null } };
  }
}

/** A broker whose mail log is whatever the test says. */
class MailLogBroker extends FakeBrokerClient {
  lines: string[] = [];
  override async logsFile(): Promise<readonly string[]> {
    return this.lines;
  }
}

const VIRUS_LINE =
  '2026-11-12T05:26:23.316872+00:00 mail postfix/cleanup[949]: E954D9514: milter-reject: END-OF-MESSAGE from unknown[172.20.0.1]: 5.7.1 ClamAV FOUND VIRUS "Eicar-Signature"; from=<someone@gmail.com> to=<alice@example.test> proto=ESMTP helo=<sender.example.org>';
const UNKNOWN_RCPT_LINE =
  '2026-11-12T05:23:51.936976+00:00 mail postfix/smtpd[977]: NOQUEUE: reject: RCPT from unknown[172.20.0.1]: 550 5.1.1 <nobody@example.test>: Recipient address rejected: User unknown in virtual mailbox table; from=<someone@gmail.com> to=<nobody@example.test> proto=ESMTP helo=<sender.example.org>';
// Shape captured from Rspamd 4.1.5's /history on 2026-11-12.
const HISTORY = {
  version: 2,
  rows: [
    {
      unix_time: Date.parse('2026-11-12T05:26:23Z') / 1000,
      subject: 'EICAR virus test',
      score: 0,
      action: 'reject',
      ip: '172.20.0.1',
      sender_smtp: 'someone@gmail.com',
      rcpt_smtp: ['alice@example.test'],
      symbols: ['CLAM_VIRUS', 'FROM_EQ_ENVFROM'],
      'message-id': 'm1@x',
    },
    {
      unix_time: Date.parse('2026-11-12T04:00:00Z') / 1000,
      subject: 'Cheap pills',
      score: 25.4,
      action: 'reject',
      ip: '203.0.113.50',
      sender_smtp: 'x@spam.example',
      rcpt_smtp: ['alice@example.test'],
      symbols: ['LAB_HIGH_SCORE'],
    },
    { unix_time: 1, action: 'no action', sender_smtp: 'ok@ok.example', rcpt_smtp: [] },
  ],
};

describe('/api/v1/security/spam-filter', () => {
  it('requires authentication', async () => {
    const { app } = await setUpSecurityApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/security/spam-filter/integration',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('reports the integration status', async () => {
    const driver = new FakeDmsDriver();
    driver.spamIntegration = { installed: false, version: null };
    const { app } = await setUpSecurityApp({ dmsDriver: driver });
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/spam-filter/integration',
    });
    expect(response.json()).toEqual({ integration: { installed: false, version: null } });
    await app.close();
  });

  it('adds and removes sender list entries, auditing both', async () => {
    const { app, db } = await setUpSecurityApp();
    const auth = await loginAs(app);

    const added = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/spam-filter/sender-lists/${MAILBOX}`,
      payload: { list: 'allow', kind: 'domain', value: 'Partner.Example' },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().entries).toEqual([
      expect.objectContaining({
        list: 'allow',
        kind: 'domain',
        value: 'partner.example',
        source: 'admin',
      }),
    ]);

    const removed = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/spam-filter/sender-lists/${MAILBOX}/remove`,
      payload: { list: 'allow', kind: 'domain', value: 'partner.example' },
    });
    expect(removed.json().entries).toEqual([]);

    const actions = db
      .all<{ action: string }>(
        "SELECT action FROM audit_log WHERE action LIKE 'sender_list.%' ORDER BY occurred_at",
      )
      .map((r) => r.action);
    expect(actions).toEqual(['sender_list.add', 'sender_list.remove']);
    await app.close();
  });

  it('rejects an entry whose value does not fit its kind', async () => {
    const { app } = await setUpSecurityApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: `/api/v1/security/spam-filter/sender-lists/${MAILBOX}`,
      payload: { list: 'block', kind: 'ip', value: 'not-an-ip' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('lists rejected mail from the log and Rspamd, merging the message both saw', async () => {
    const broker = new MailLogBroker();
    broker.lines = [VIRUS_LINE, UNKNOWN_RCPT_LINE, 'unrelated line'];
    const rspamd = new FakeRspamdClient().setHistory(HISTORY);
    const { app } = await setUpSecurityApp({
      brokerClient: broker,
      rspamdClient: rspamd,
      dmsDriver: new RspamdEnabledDriver(),
    });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/security/spam-filter/rejected',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.logAvailable).toBe(true);
    expect(body.rspamdAvailable).toBe(true);
    expect(
      body.entries.map((e: { category: string; source: string; subject: string | null }) => [
        e.category,
        e.source,
        e.subject,
      ]),
    ).toEqual([
      ['virus', 'postfix', 'EICAR virus test'],
      ['recipient', 'postfix', null],
      ['spam', 'rspamd', 'Cheap pills'],
    ]);
    await app.close();
  });
});

describe('collectSenderReportsOnce', () => {
  it('applies new report lines and audits each change', async () => {
    const { app, db } = await setUpSecurityApp();
    const driver = new FakeDmsDriver();
    const broker = new MailLogBroker();
    broker.lines = [
      `2026-11-12T05:23:35.151724+00:00 mail dwg-sender-report: action=ham user=${MAILBOX} ip=172.20.0.1 from=someone@shop.example.org`,
    ];
    const service = new SenderListsService(driver, db);
    const deps = { db, brokerClient: broker, senderListsService: service, logger: testLogger() };

    expect(await collectSenderReportsOnce(deps)).toBe(1);
    expect(await collectSenderReportsOnce(deps)).toBe(0);
    expect((await service.get(MAILBOX)).entries).toEqual([
      expect.objectContaining({ list: 'allow', kind: 'domain', value: 'shop.example.org' }),
    ]);
    expect(db.all("SELECT * FROM audit_log WHERE action = 'sender_list.report'")).toHaveLength(1);
    await app.close();
  });

  it('does nothing while the integration is not installed', async () => {
    const { app, db } = await setUpSecurityApp();
    const driver = new FakeDmsDriver();
    driver.spamIntegration = { installed: false, version: null };
    const broker = new MailLogBroker();
    broker.lines = [
      `2026-11-12T05:23:35.151724+00:00 mail dwg-sender-report: action=ham user=${MAILBOX} ip=172.20.0.1 from=a@shop.example.org`,
    ];
    const service = new SenderListsService(driver, db);
    expect(
      await collectSenderReportsOnce({
        db,
        brokerClient: broker,
        senderListsService: service,
        logger: testLogger(),
      }),
    ).toBe(0);
    await app.close();
  });
});

describe('mergeRejections', () => {
  it('does not merge rows that are minutes apart', () => {
    const entry = parseRejectLine(VIRUS_LINE);
    if (entry === null) throw new Error('fixture');
    const [row] = parseRspamdHistory({
      rows: [{ ...HISTORY.rows[0], unix_time: Date.parse('2026-11-12T05:40:00Z') / 1000 }],
    });
    expect(mergeRejections([entry], row ? [row] : [])).toHaveLength(2);
  });
});
