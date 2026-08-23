/**
 * Fixtures **captured from a live docker-mailserver**, not constructed.
 *
 * Provenance in full, because AGENT_BRIEF.md working agreement #8 turns on
 * it: taken 2026-08-23 from `ghcr.io/docker-mailserver/docker-mailserver`,
 * image version v15.1.0, digest
 * sha256:af51b15dd3fc72153c0e90eb7692bb5e3a463212d87959a80fa7aa89b617d44a,
 * run with ENABLE_RSPAMD=1, ENABLE_CLAMAV=1, ENABLE_FAIL2BAN=1,
 * ENABLE_QUOTAS=1, ENABLE_OPENDKIM=0, ACCOUNT_PROVISIONER=FILE, hostname
 * mail.example.test, one account first@example.test carrying a 500M quota
 * and a send restriction. Every value below records the command that
 * produced it.
 *
 * These exist because nine rows of FEATURE_MATRIX.md's "Deferred to runtime
 * verification" table had never been checked against anything real — every
 * parser behind them was written from documentation. M17 was the first time
 * this project had a Docker daemon. Two of the nine turned out to be wrong
 * (see `dkim-record.ts` and `apps/broker/src/dms/handlers.ts`); the rest
 * confirmed the documented behaviour, including one fallback that fires in
 * practice.
 *
 * The DKIM key below is a **public** record from a throwaway container that
 * no longer exists. Nothing here is a secret.
 */

/** `doveadm -f json quota get -u first@example.test`, after `setup quota set … 500M` and `doveadm reload`. Settles deferred item 8: keys are lower-case, values are **strings**, and STORAGE `limit` is `512000` for a 500M quota — KiB, exactly the convention `quota-usage.ts` already assumed. `-` means unlimited. */
export const LIVE_DOVEADM_QUOTA_GET_JSON =
  '[{"root":"User quota","type":"STORAGE","value":"0","limit":"512000","percent":"0"},{"root":"User quota","type":"MESSAGE","value":"0","limit":"-","percent":"0"}]';

/** `setup fail2ban status`. Settles deferred item 5: several jails, each an ASCII tree block with tab-separated labels, and an empty `Banned IP list:` when nothing is banned. */
export const LIVE_FAIL2BAN_STATUS =
  'Status for the jail: custom\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t0\n|  `- File list:\t\n`- Actions\n   |- Currently banned:\t0\n   |- Total banned:\t0\n   `- Banned IP list:\t\n\nStatus for the jail: dovecot\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t0\n|  `- File list:\t/var/log/mail.log\n`- Actions\n   |- Currently banned:\t0\n   |- Total banned:\t0\n   `- Banned IP list:\t\n\nStatus for the jail: postfix\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t0\n|  `- File list:\t/var/log/mail.log\n`- Actions\n   |- Currently banned:\t0\n   |- Total banned:\t0\n   `- Banned IP list:\t\n\n';

/** `postfix-send-access.cf` after `setup email restrict add send first@example.test`. Settles deferred item 9: address, whitespace, action — standard `access(5)`, which `parsers/postfix-access.ts` already parsed. */
export const LIVE_POSTFIX_SEND_ACCESS_CF = 'first@example.test \t\t REJECT\n';

/** Rspamd controller `GET /stat`. Settles deferred item 3: the fields really are `scanned`, `learned`, `spam_count`, `ham_count`, `actions` — and the action keys contain **spaces** (`soft reject`, `rewrite subject`, `add header`, `no action`). */
export const LIVE_RSPAMD_STAT_JSON =
  '{"version":"3.12.1","config_id":"r5hmexspy5femco7kd6ndf5jqb4zkcat79pkphb5kibyzsmn3dczzaezjdng49ysxrfewy1ebatgep6dyurzzbw36jt1uugtaqw76xn","uptime":143,"read_only":false,"scanned":0,"learned":0,"actions":{"reject":0,"soft reject":0,"rewrite subject":0,"add header":0,"greylist":0,"no action":0},"scan_times":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],"spam_count":0,"ham_count":0,"connections":0,"control_connections":1,"pools_allocated":29,"pools_freed":1,"bytes_allocated":27868496,"chunks_allocated":122,"shared_chunks_allocated":3,"chunks_freed":0,"chunks_oversized":1,"fragmented":0,"total_learns":0,"statfiles":[{"users":0,"revision":0,"used":0,"total":0,"size":0,"symbol":"BAYES_SPAM","type":"redis","languages":0},{"users":0,"revision":0,"used":0,"total":0,"size":0,"symbol":"BAYES_HAM","type":"redis","languages":0}],"fuzzy_hashes":{"rspamd.com":2057159277}}';

/** `rspamd/dkim/rsa-2048-mail-example.test.public.dns.txt`, written by `setup config dkim domain example.test` under ENABLE_RSPAMD=1. Settles deferred item 2, and disproved two assumptions at once: the file is **not** under `opendkim/keys/<domain>/`, and its contents are **not** RFC 1035 quoted zone-file syntax — it is the bare record value on one line. */
export const LIVE_DKIM_RSPAMD_PUBLIC_DNS =
  'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwPdCf2hymp9X4RJQcRmNQiawYZngZqDzuyBeL3cop60QrOvpeyjOftbdU18KJfirn6EcHdOBP8zZcjjPk4+INGFeMKhKLPZ+2k1cSf/Iv9ajf/C4wOnIHTQlriSRVesvt4322BCDLFpPUOv3IUBTkpKgZRuYyvkKLpXd3n4JZ5KBctD1mDHArWGg0znWRnEBtiHQ2CNoxapPSOHFu+vXpSA8dK3mn2zrqRFu8IM8KVW9AtzLwzjnnQjKOSwZTFpoHPShD4PHC82odqjnQno3v/gk2V28sr5sLkJVnD8xDZ+ZKvB8th/8lKxALaJWcURuTEkVop1Kv96Oft9aN+HsSwIDAQAB';

/** `freshclam --version`. Settles deferred item 6: `ClamAV <engine>/<signature-version>/<date>`, which `clamav-parser.ts` already parsed correctly. */
export const LIVE_CLAMAV_VERSION = 'ClamAV 1.0.7/27728/Sun Aug 10 08:32:45 2025';

/** `ls -1 /var/mail-state`. Settles deferred item 4: eight service state directories. Backups copy the whole volume regardless, so this confirms completeness rather than changing anything. */
export const LIVE_MAIL_STATE_ENTRIES = [
  'lib-clamav',
  'lib-dovecot',
  'lib-fail2ban',
  'lib-logrotate',
  'lib-postfix',
  'lib-redis',
  'lib-rspamd',
  'spool-postfix',
] as const;
