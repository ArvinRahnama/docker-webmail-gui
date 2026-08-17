/**
 * Fixture provenance: **CONSTRUCTED**, not captured — there is no live
 * Rspamd controller in this environment (ARCHITECTURE.md §9). The
 * `/stat` shape is built from `docs/research/03-mail-stack-components.md`
 * §1's one confirmed real-deployment snippet
 * (`{"scanned":0,"learned":0,"connections":0,"control_connections":0}`)
 * extended with the widely-reported (not independently verified)
 * `actions`/`ham_count`/`spam_count` fields, explicitly to exercise
 * `parse-stat.ts` against the *documented-uncertain* shape rather than
 * an invented one. `/symbols` and `/actions` are built directly from
 * docs.rspamd.com's own documented purpose for each endpoint ("weights,
 * descriptions, groups" / "score thresholds per action").
 */

export const FIXTURE_RSPAMD_STAT = {
  scanned: 4821,
  learned: 312,
  connections: 12,
  control_connections: 1,
  ham_count: 4390,
  spam_count: 431,
  actions: {
    'no action': 4390,
    'add header': 280,
    greylist: 90,
    'soft reject': 5,
    reject: 56,
  },
};

export const FIXTURE_RSPAMD_SYMBOLS = [
  {
    symbol: 'BAYES_SPAM',
    score: 3.5,
    description: 'Message is likely spam (Bayes)',
    group: 'statistics',
  },
  {
    symbol: 'BAYES_HAM',
    score: -3.0,
    description: 'Message is likely ham (Bayes)',
    group: 'statistics',
  },
  {
    symbol: 'HFILTER_HOSTNAME_UNKNOWN',
    score: 6,
    description: 'Unknown sender hostname',
    group: 'hfilter',
  },
  { symbol: 'DKIM_VALID', score: -1, description: 'Valid DKIM signature', group: 'dkim' },
  { symbol: 'SPF_ALLOW', score: -0.5, description: 'SPF passed', group: 'spf' },
];

export const FIXTURE_RSPAMD_ACTIONS = [
  { action: 'reject', value: 15 },
  { action: 'add header', value: 6 },
  { action: 'greylist', value: 4 },
];
