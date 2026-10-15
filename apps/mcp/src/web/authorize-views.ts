/**
 * Server-rendered HTML for the limited-purpose OAuth authorization page.
 *
 * Deliberately not part of the admin SPA and not a mailbox dashboard: it is
 * two small forms (sign in with the postmaster-issued setup credential, then
 * approve or deny) and an error page. No JavaScript at all, so the page's
 * CSP can forbid every script source. Every interpolated value passes
 * through {@link escapeHtml}.
 */
import { MCP_SCOPE_LABELS, type McpScope } from '@dwg/shared';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `sales@example.com` → `s***s@example.com` — shown before the user has proven anything. */
export function maskMailbox(mailbox: string): string {
  const at = mailbox.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  const masked =
    local.length <= 2 ? `${local[0] ?? ''}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}

const SCOPE_WARNINGS: Readonly<Record<McpScope, string | null>> = {
  'mail.read': 'The application can read the content of every message in this mailbox.',
  'mail.send': 'The application can send email that comes from this address.',
  'mail.delete': 'The application can move messages to Trash.',
};

export const AUTHORIZE_STYLESHEET = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#14171c;--muted:#5b6472;--border:#d9dee5;--accent:#2952cc;--accent-fg:#fff;--warn-bg:#fff6e5;--warn-fg:#7a4b00;--err-bg:#fdecec;--err-fg:#8a1c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e7eaf0;--muted:#a3abb8;--border:#2a303b;--accent:#7c9cff;--accent-fg:#0f1115;--warn-bg:#2d2412;--warn-fg:#f3c76b;--err-bg:#2f1517;--err-fg:#f2a5a5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem}
h1{font-size:1.35rem;margin:0 0 .25rem}
p{margin:.5rem 0}
.muted{color:var(--muted);font-size:.9rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem .75rem;margin:1rem 0;font-size:.95rem}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
ul.perms{padding-left:1.1rem;margin:.5rem 0 1rem}
ul.perms li{margin:.35rem 0}
.warn{background:var(--warn-bg);color:var(--warn-fg);border-radius:8px;padding:.75rem;font-size:.92rem;margin:1rem 0}
.error{background:var(--err-bg);color:var(--err-fg);border-radius:8px;padding:.75rem;margin:1rem 0}
label{display:block;font-weight:600;margin:1rem 0 .3rem}
input[type=text],input[type=password]{width:100%;padding:.6rem .7rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem}
button{font:inherit;font-weight:600;padding:.6rem 1.1rem;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
footer{margin-top:1rem;font-size:.82rem;color:var(--muted);text-align:center}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/oauth/assets/authorize.css">
</head>
<body>
<main>
<div class="card">
${body}
</div>
<footer>This page only authorizes an MCP connection to one mailbox. It is not a webmail or administration login.</footer>
</main>
</body>
</html>`;
}

function permissionsList(scopes: readonly McpScope[], withWarnings: boolean): string {
  const items = scopes
    .map((scope) => {
      const warning = withWarnings ? SCOPE_WARNINGS[scope] : null;
      return `<li><strong>${escapeHtml(MCP_SCOPE_LABELS[scope])}</strong>${
        warning !== null ? `<br><span class="muted">${escapeHtml(warning)}</span>` : ''
      }</li>`;
    })
    .join('');
  return `<ul class="perms">${items}</ul>`;
}

export interface ClientDisplay {
  /** Self-asserted client name — labelled as such. */
  readonly name: string | null;
  readonly clientIdHost: string | null;
  readonly redirectHost: string;
  readonly loopbackRedirect: boolean;
}

function clientRows(client: ClientDisplay): string {
  const name = client.name ?? client.clientIdHost ?? 'Unnamed application';
  return `
<dt>Application</dt><dd>${escapeHtml(name)} <span class="muted">(name provided by the application)</span></dd>
${client.clientIdHost !== null ? `<dt>Published by</dt><dd>${escapeHtml(client.clientIdHost)}</dd>` : ''}
<dt>Returns you to</dt><dd>${escapeHtml(client.redirectHost)}</dd>`;
}

export function renderLoginPage(input: {
  readonly txn: string;
  readonly csrf: string;
  readonly client: ClientDisplay;
  readonly maskedMailbox: string | null;
  readonly scopes: readonly McpScope[] | null;
  readonly expiresAt: string;
  readonly error: string | null;
  readonly username: string;
}): string {
  const perms =
    input.scopes === null
      ? '<p class="muted">The permissions are those your postmaster set for this connection; you will review them before anything is authorized.</p>'
      : permissionsList(input.scopes, false);
  return layout(
    'Authorize MCP access',
    `<h1>Authorize MCP access to a mailbox</h1>
<p class="muted">Sign in with the MCP username and one-time setup password your postmaster gave you. This is not your email password.</p>
<dl>
${clientRows(input.client)}
<dt>Mailbox</dt><dd>${input.maskedMailbox !== null ? escapeHtml(input.maskedMailbox) : 'Identified by your MCP username'}</dd>
</dl>
<p><strong>Requested permissions</strong></p>
${perms}
${input.error !== null ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>` : ''}
<form method="post" action="/oauth/authorize/login" autocomplete="off">
<input type="hidden" name="txn" value="${escapeHtml(input.txn)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<label for="username">MCP username</label>
<input type="text" id="username" name="username" required maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeHtml(input.username)}">
<label for="password">Setup password</label>
<input type="password" id="password" name="password" required maxlength="128" autocomplete="one-time-code" spellcheck="false">
<div class="actions"><button type="submit" class="primary">Continue</button></div>
</form>
<p class="muted">This sign-in request expires at ${escapeHtml(input.expiresAt)} (UTC).</p>`,
  );
}

export function renderConsentPage(input: {
  readonly txn: string;
  readonly csrf: string;
  readonly client: ClientDisplay;
  readonly mailbox: string;
  readonly scopes: readonly McpScope[];
}): string {
  const writeScopes = input.scopes.filter((scope) => scope !== 'mail.read');
  return layout(
    'Review MCP access',
    `<h1>Review access to ${escapeHtml(input.mailbox)}</h1>
<dl>
${clientRows(input.client)}
<dt>Mailbox</dt><dd><strong>${escapeHtml(input.mailbox)}</strong></dd>
</dl>
<p><strong>If you authorize, this application will be able to:</strong></p>
${permissionsList(input.scopes, true)}
${
  writeScopes.length > 0
    ? '<div class="warn" role="note"><strong>Write access.</strong> The application will be able to act as this mailbox. Content of emails it reads is untrusted and may try to instruct it — review what it does on your behalf.</div>'
    : ''
}
${
  input.client.loopbackRedirect
    ? '<div class="warn" role="note"><strong>Local application.</strong> This request returns to an address on your own computer. Continue only if you started it from an application you trust on this device.</div>'
    : ''
}
<form method="post" action="/oauth/authorize/decision">
<input type="hidden" name="txn" value="${escapeHtml(input.txn)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<div class="actions">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="approve" class="primary">Authorize</button>
</div>
</form>
<p class="muted">Your postmaster can see this authorization and revoke it at any time.</p>`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1><div class="error" role="alert">${escapeHtml(message)}</div>
<p class="muted">You can close this window. If you were connecting ChatGPT, start the connection again from ChatGPT, or ask your postmaster for help.</p>`,
  );
}
