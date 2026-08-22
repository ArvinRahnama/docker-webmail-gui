/**
 * Fixture provenance: **CONSTRUCTED**, from the confirmed `postqueue -j`
 * field names and JSON-Lines shape in
 * `docs/research/03-mail-stack-components.md` §3 (itself
 * `[CONFIRMED: postfix.org/postqueue.1.html]` for the fields, with the
 * sample line explicitly marked `[INFERRED formatting example around
 * CONFIRMED field names]`) — no live docker-mailserver container exists
 * in this environment to capture a real queue snapshot from
 * (ARCHITECTURE.md §9).
 *
 * Three entries, deliberately not all in the same queue: one `deferred`
 * (the queue depth's "with deferred count" half — UX_ARCHITECTURE.md
 * §6.1 Row 2), one `active`, one `hold` — so `countByQueueName`
 * (`parsers/postqueue.ts`) has more than one non-zero bucket to prove it
 * tallies correctly rather than only ever seeing a single-queue fixture.
 * `incoming` is left at zero on purpose, for the same reason
 * `countByQueueName` zero-fills every known name: a caller must not be
 * able to mistake "no fixture data for this queue" for "this queue key
 * doesn't exist".
 */
export const FIXTURE_POSTQUEUE_JSON = [
  JSON.stringify({
    queue_name: 'deferred',
    queue_id: '4Xk2mP1abc',
    arrival_time: 1_755_123_000,
    message_size: 2345,
    forced_expire: false,
    sender: 'newsletter@example.com',
    recipients: [
      { address: 'user1@example.com', delay_reason: 'connection timed out' },
      { address: 'user2@example.com', delay_reason: 'connection timed out' },
    ],
  }),
  JSON.stringify({
    queue_name: 'active',
    queue_id: '5Yl3nQ2bcd',
    arrival_time: 1_755_123_400,
    message_size: 890,
    forced_expire: false,
    sender: 'admin@example.com',
    recipients: [{ address: 'sales@example.com' }],
  }),
  JSON.stringify({
    queue_name: 'hold',
    queue_id: '6Zm4oR3cde',
    arrival_time: 1_755_120_000,
    message_size: 512,
    forced_expire: false,
    sender: 'suspicious@otherdomain.tld',
    recipients: [{ address: 'user1@example.com' }],
  }),
].join('\n');
