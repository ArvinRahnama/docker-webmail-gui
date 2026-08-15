# 05 — UX Architecture & Design System

**Author:** Lead architect
**Date:** 2026-08-15
**Status:** Specification. Implementation must follow this or amend it deliberately.

> This is a specification, not a mood board. Every value here is meant to be typed into a token file.
> Where a claim is a taste judgement rather than a standard, it is marked **(judgement)**.

---

## 1. Who this is for

One persona, and designing for anyone else weakens the product: **a systems administrator who owns a production mail server and is not a mail expert.** They open this panel for one of four reasons:

1. Something is broken and they need to know what, fast.
2. Mail is not arriving and they need to know whether it is DNS, TLS, spam filtering, or the queue.
3. Routine admin: add a mailbox, add an alias, change a password.
4. Periodic assurance: is anything about to break — disk, certificate expiry, failed backup?

Reason 1 and 2 dominate the emotional weight of the product. They arrive **stressed**, often on a phone, often at an inconvenient hour. That single fact drives most decisions below.

## 2. Design principles

| # | Principle | Consequence — we do this, not that |
| --- | --- | --- |
| 1 | **Answer the question before showing the data** | The dashboard leads with a resolved verdict — "Mail is flowing" / "3 problems" — not a wall of gauges the admin must interpret. Not: six sparklines and no conclusion. |
| 2 | **Honesty over completeness** | A metric we cannot source is absent or explicitly `Unknown`, never estimated. An `Unknown` state is a first-class visual, not an error. Not: a plausible-looking zero. |
| 3 | **Destructive actions are slow on purpose** | Deleting a mailbox costs an extra deliberate step and shows exactly what dies. Not: a trash icon in a table row that fires on click. |
| 4 | **Density with air** | Tables are compact — 36px rows, tabular numerals — but grouped and generously padded at the section level. An admin scanning 200 mailboxes needs rows; an admin reading a verdict needs space. |
| 5 | **Status is never colour alone** | Every status carries icon + shape + text. Works for colour-blind users, in greyscale, and in a screenshot pasted into a ticket. |
| 6 | **The panel must degrade, not collapse** | If Rspamd is unreachable, the Rspamd card shows unreachable and *every other card still renders*. Not: one failed request blanks the dashboard. |
| 7 | **Never imply we did something we didn't** | If a change requires a container restart to take effect, the UI says so before the admin walks away believing it is live. |
| 8 | **Recovery is part of every error** | Every error state names a next action. Not: "Something went wrong." |

Principles 2 and 7 are the ones that make this product trustworthy for mail specifically. Principle 6 is what makes it usable during the outage it is meant to help with. **(judgement)**

---

## 3. Colour system

Expressed as CSS custom properties in OKLCH. OKLCH is chosen because perceptual lightness is uniform across hues, so a status palette holds its relative weight without hand-tuning each hue. **(judgement)**

### 3.1 Neutrals

Light theme is a warm-neutral grey, not pure white — pure white next to dense tables fatigues on long sessions. Dark theme is a desaturated blue-grey at `L≈0.18`, deliberately **not** near-black: true black with light text produces halation, and this is a tool people read logs in. **(judgement)**

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg-app` | `oklch(0.985 0.002 265)` | `oklch(0.178 0.008 265)` | Page background |
| `--bg-surface` | `oklch(1 0 0)` | `oklch(0.213 0.009 265)` | Cards, tables |
| `--bg-raised` | `oklch(0.975 0.003 265)` | `oklch(0.248 0.010 265)` | Popovers, dropdowns |
| `--bg-overlay` | `oklch(0.145 0.01 265 / 0.55)` | `oklch(0.09 0.01 265 / 0.70)` | Modal scrim |
| `--bg-inset` | `oklch(0.965 0.003 265)` | `oklch(0.158 0.008 265)` | Code blocks, log viewer, wells |
| `--border-subtle` | `oklch(0.925 0.004 265)` | `oklch(0.272 0.010 265)` | Table row dividers |
| `--border-default` | `oklch(0.878 0.005 265)` | `oklch(0.318 0.011 265)` | Card and input borders |
| `--border-strong` | `oklch(0.795 0.007 265)` | `oklch(0.398 0.012 265)` | Hover, active borders |
| `--text-primary` | `oklch(0.235 0.011 265)` | `oklch(0.962 0.003 265)` | Body, headings |
| `--text-secondary` | `oklch(0.455 0.011 265)` | `oklch(0.775 0.008 265)` | Labels, secondary column data |
| `--text-muted` | `oklch(0.578 0.011 265)` | `oklch(0.648 0.010 265)` | Timestamps, hints, placeholders |
| `--text-disabled` | `oklch(0.700 0.008 265)` | `oklch(0.505 0.009 265)` | Disabled controls |

### 3.2 Accent

A single restrained accent. This product is status-dense; a loud brand colour competes with the status palette for attention and loses the admin's eye. The accent marks *interactive* and *selected*, never *good*. **(judgement)**

| Token | Light | Dark |
| --- | --- | --- |
| `--accent` | `oklch(0.545 0.175 258)` | `oklch(0.685 0.155 258)` |
| `--accent-hover` | `oklch(0.495 0.180 258)` | `oklch(0.735 0.150 258)` |
| `--accent-fg` | `oklch(0.99 0 0)` | `oklch(0.15 0.01 265)` |
| `--accent-subtle-bg` | `oklch(0.955 0.030 258)` | `oklch(0.285 0.055 258)` |
| `--focus-ring` | `oklch(0.545 0.175 258)` | `oklch(0.735 0.150 258)` |

### 3.3 Status palette — the load-bearing one

Six states. Colour is the *last* channel, never the only one.

| State | Icon (lucide) | Shape cue | Light fg / bg | Dark fg / bg |
| --- | --- | --- | --- | --- |
| `healthy` | `check-circle-2` | filled dot | `oklch(0.475 0.135 150)` / `oklch(0.955 0.035 150)` | `oklch(0.760 0.140 150)` / `oklch(0.275 0.055 150)` |
| `warning` | `alert-triangle` | triangle | `oklch(0.505 0.130 75)` / `oklch(0.960 0.045 85)` | `oklch(0.805 0.140 85)` / `oklch(0.300 0.055 75)` |
| `critical` | `alert-octagon` | octagon | `oklch(0.505 0.190 25)` / `oklch(0.958 0.030 25)` | `oklch(0.735 0.170 25)` / `oklch(0.295 0.075 25)` |
| `unknown` | `help-circle` | hollow dot | `oklch(0.545 0.010 265)` / `oklch(0.955 0.003 265)` | `oklch(0.700 0.010 265)` / `oklch(0.285 0.008 265)` |
| `info` | `info` | filled dot | `oklch(0.520 0.140 258)` / `oklch(0.955 0.030 258)` | `oklch(0.740 0.130 258)` / `oklch(0.285 0.050 258)` |
| `pending` | `loader-2` (spin) | dashed ring | `oklch(0.520 0.105 300)` / `oklch(0.958 0.025 300)` | `oklch(0.755 0.110 300)` / `oklch(0.290 0.045 300)` |

**`unknown` is intentionally grey, not yellow.** "We could not determine this" is not a warning — conflating them trains admins to ignore yellow. This is the single most important colour decision in the product. **(judgement)**

### 3.4 Contrast is enforced, not asserted

Rather than publish hand-measured ratios that drift the moment a token changes, contrast is a **build-time test**:

- A Vitest suite parses the token file, converts OKLCH → sRGB, computes WCAG 2.1 contrast, and **fails CI** on violation.
- Requirements: body text ≥ **7.0:1** (AAA) on its background; secondary/muted text ≥ **4.5:1**; status foreground on its paired status background ≥ **4.5:1**; borders and focus ring ≥ **3.0:1** against adjacent surfaces; disabled text exempt but ≥ 2.5:1.
- Both themes are tested. Every pairing that ships is in the matrix.

This is stricter than a one-off audit and cannot rot. It is a hard acceptance criterion for Phase 10.

---

## 4. Typography, spacing, motion

**Fonts — self-hosted, no runtime CDN** (a CDN request from an admin panel is both a privacy leak and a CSP hole):

| Role | Font | Licence | Notes |
| --- | --- | --- | --- |
| UI | **Inter Variable**, subset latin | SIL OFL 1.1 | `font-variant-numeric: tabular-nums` globally on tables/metrics |
| Mono | **JetBrains Mono** | SIL OFL 1.1 | Logs, config, DNS records, code |
| Fallback | system stack | — | Renders before webfont; `font-display: swap` |

Both licences are verified permissive and self-hostable. Add to the NOTICE file.

| Scale | Size / line-height / weight | Use |
| --- | --- | --- |
| `display` | 30 / 36 / 600 | Dashboard verdict line only |
| `h1` | 22 / 28 / 600 | Page title |
| `h2` | 17 / 24 / 600 | Section, card title |
| `h3` | 15 / 20 / 600 | Sub-section |
| `body` | 14 / 20 / 400 | Default |
| `body-sm` | 13 / 18 / 400 | Table cells, dense data |
| `caption` | 12 / 16 / 500 | Labels, badges, timestamps |
| `mono` | 13 / 20 / 400 | Logs, records |
| `mono-sm` | 12 / 18 / 400 | Log viewer at density |

**Spacing:** 4px base — `0,1,2,3,4,6,8,12,16,20,24,32,40,48,64`. Table row height **36px** default, 44px comfortable (user preference, persisted).
**Radius:** `sm 4` inputs/badges · `md 6` buttons/cards · `lg 10` modals · `full` pills.
**Elevation:** light theme uses shadows (`0 1px 2px / 0 4px 12px` at low alpha); **dark theme uses border + background lift instead of shadow** — shadows are nearly invisible on dark surfaces and reading elevation from luminance is more reliable. This is the concrete way the dark theme is designed rather than inverted. **(judgement)**
**Motion:** `fast 120ms` hover/focus · `base 180ms` popover/dropdown · `slow 240ms` modal/drawer. Easing `cubic-bezier(0.32, 0.72, 0, 1)`. Under `prefers-reduced-motion: reduce`, all durations → `1ms` and the `pending` spinner becomes a static dashed ring with a live-region text update.

---

## 5. Information architecture

### 5.1 Critique of the proposed tree

The structure in the brief is sound but has eight concrete problems:

| # | Problem | Fix |
| --- | --- | --- |
| 1 | **`Maintenance > Restore` as a nav destination.** Restore is an *action on a specific backup*, not a place. A top-level link invites an admin to wander into the most destructive flow in the product with no object selected. | Delete the nav item. Restore is initiated only from a chosen backup row, carrying that backup's identity. |
| 2 | **`Docker > Health`.** Health is cross-cutting — DNS, TLS, disk, queue, containers. Filing it under Docker implies container health is the whole story. | Remove. The **Dashboard** answers continuous health; **Maintenance > Diagnostics** runs deep on-demand checks. |
| 3 | **`Configuration > Configuration`.** A parent and child with the same name is a navigation dead-end. | Rename to `Configuration > Files` (managed config files) vs `Configuration > Environment` (env vars). |
| 4 | **DKIM and SPF/DMARC split across two pages**, but both are DNS records an admin fixes *per domain*, in one sitting. Splitting them forces page-hopping during exactly the task they're for. | Merge into one **Email Authentication** area, organised **by domain**, showing MX/SPF/DKIM/DMARC/PTR together. Reachable from the domain row too. |
| 5 | **`Quotas` as a CRUD page.** Quota is an attribute of a mailbox, edited on the mailbox. A separate page duplicates it. | Keep the page but reframe as **Storage** — a read-oriented report: who is near the limit, sorted by usage. Editing happens on the mailbox. |
| 6 | **`Aliases` and `Forwarding` as separate pages.** Pending confirmation from the docker-mailserver research, these are likely the same underlying mechanism. Two pages for one mechanism guarantees user confusion about which to use. | If confirmed identical: **one page with a type filter**. Decision deferred to the feature matrix — flagged, not guessed. |
| 7 | **Three log-like destinations** — `Monitoring > Logs`, `Monitoring > Events`, `Administration > Audit Logs` — with no naming that distinguishes them. | Label by *whose* record it is: **Service Logs** (Postfix/Dovecot/container output), **Docker Events** (lifecycle, moved under Docker), **Audit Log** (who did what *in this panel*). |
| 8 | **`SMTP` / `IMAP` under Configuration**, away from Mail Server. Defensible — they are env-driven config — but an admin looking for "why is IMAP refusing connections" looks under Mail Server first. | Keep under Configuration (they *are* config), but surface a prominent cross-link from Mail Server and make them findable in global search and the command palette. |

### 5.2 Recommended tree

```
/                          Dashboard

Mail                       /mail
  Domains                  /mail/domains            · /mail/domains/:domain
  Mailboxes                /mail/mailboxes          · /mail/mailboxes/:address
  Aliases                  /mail/aliases            (+ forwarding, pending matrix)
  Storage                  /mail/storage            (quota usage report)
  Autoresponders           /mail/autoresponders
  Sieve Filters            /mail/sieve
  Queue                    /mail/queue              (NEW — see note)

Security                   /security
  Email Authentication     /security/email-auth     · /security/email-auth/:domain
  TLS Certificates         /security/tls
  Rspamd                   /security/rspamd
  ClamAV                   /security/clamav
  Fail2ban                 /security/fail2ban

Docker                     /docker
  Containers               /docker/containers       · /docker/containers/:id
  Images                   /docker/images
  Volumes                  /docker/volumes
  Networks                 /docker/networks
  Events                   /docker/events

Monitoring                 /monitoring
  System                   /monitoring/system
  Mail Traffic             /monitoring/mail
  Spam & Virus             /monitoring/spam
  Service Logs             /monitoring/logs

Configuration              /config
  SMTP                     /config/smtp
  IMAP                     /config/imap
  Environment              /config/environment
  Files                    /config/files
  Advanced                 /config/advanced

Maintenance                /maintenance
  Backups                  /maintenance/backups     (restore starts here)
  Updates                  /maintenance/updates
  Diagnostics              /maintenance/diagnostics

Administration             /admin
  Administrators           /admin/administrators
  Authentication           /admin/authentication
  Audit Log                /admin/audit
  System Settings          /admin/settings
```

**One addition: `Mail > Queue`.** The brief lists mail queue as a dashboard metric but gives it no home. A stuck queue is a top-three real incident and `postqueue -j` gives us genuine per-message data, so it earns a page where an admin can inspect and flush. Adding it is justified by a real data source, not by symmetry.

### 5.3 App shell

- **Sidebar** 248px, collapsible to 56px icon rail (persisted). Groups are static headers, not accordions — collapsing hides the map from someone who is lost. **(judgement)**
- **Topbar** 52px: breadcrumb, global search (`/`), command palette trigger (`⌘K`), job indicator, notifications, theme, account.
- **Page header**: title, one-line description, primary action right-aligned, tabs below for detail pages.
- **Global status strip** directly under the topbar, visible on every page, only when non-healthy — e.g. *"Mail container unhealthy · 2 problems"*. This is what makes an incident impossible to miss from any page.
- **Job tray**: long-running operations (backup, restore, update, DKIM generation) live in a persistent tray, not a modal. The admin must be able to navigate away while a backup runs.

---

## 6. Screen specifications

### 6.1 Dashboard — the most important screen

Must answer, in ~5 seconds: *is it healthy · is anything broken · security issues · disk · mail flowing · spam rising · DNS/TLS correct*.

**Row 1 — Verdict.** Full-width. One `display`-size sentence with a status icon: *"All systems healthy"* or *"2 problems need attention"*. If not healthy, the problems are listed immediately beneath as rows, each with a direct link to the fix. Nothing else competes at this size. This row alone should satisfy the five-second test.

**Row 2 — Four metric tiles.** `Mail flow (24h)` sent/received with sparkline · `Queue depth` with deferred count · `Disk` used/total with bar, warns ≥80%, critical ≥90% · `Spam blocked (24h)` with trend arrow.
Each tile shows `Unknown` honestly if its source is unreachable.

**Row 3 — Two columns.**
*Left (wider):* **Service health list** — Postfix, Dovecot, Rspamd, ClamAV, Fail2ban, Container — each with status chip, last-checked time, and a link.
*Right:* **Security & expiry** — TLS expiry days, DKIM/SPF/DMARC pass counts per-domain rolled up, last backup age, update availability.

**Row 4 — Recent activity.** Last 10 audit + Docker events, mixed, timestamped. Compact.

**Deliberately excluded:** decorative gauges, CPU/RAM as hero tiles (they are rarely the mail admin's problem — they live on Monitoring > System), and any chart whose data we cannot source.

**Spam trend note:** because Rspamd's history is a 200-entry in-memory ring buffer that does not survive restart, the spam sparkline is backed by **our own periodic `/stat` samples stored in SQLite**. Before enough samples accumulate, the tile reads *"Collecting — trend available after 24h"*, never a fabricated line.

### 6.2 Other screens

| Screen | Layout & primary data | Actions | Notable states |
| --- | --- | --- | --- |
| **Domains list** (derived view — see §6.3) | Table: domain, mailboxes, aliases, DKIM, SPF, DMARC, TLS. Status chips per record. | Inspect, generate DKIM, re-check DNS. **No "Add domain"** | Empty: first-run guide pointing to *Add mailbox*, since that is what actually creates a domain |
| **Domain detail** | Tabs: Overview · Email Auth · Mailboxes · Aliases | Per-record fix guidance, copy DNS value, DKIM generation | Partial: DNS unreachable → records `Unknown`, page still renders |
| **Mailboxes list** | Table: address, domain, quota bar, usage, last login, status. Search, domain filter, sort, pagination, column visibility. | Add, edit, password, quota, delete (Tier 3) | Empty vs filtered-empty are distinct designs |
| **Mailbox detail** | Identity, quota with usage bar, aliases pointing here, autoresponder, sieve | Change password, set quota, delete | — |
| **Aliases** | Table: source → destinations, domain, type | Add, edit, delete | — |
| **Email Authentication** | Per-domain card stack: MX, SPF, DKIM, DMARC, PTR. Each = state chip + current value + expected value + copy button + explanation | Generate DKIM, re-check, copy record | `Unknown` when resolver fails — never rendered as `Invalid` |
| **TLS** | Cert card: subject, SANs, issuer, notBefore/notAfter, days remaining, source (`SSL_TYPE`) | Re-check | Warn ≤30d, critical ≤7d |
| **Rspamd / Spam** | `/stat` counters, action breakdown, top symbols, recent history (≤200, labelled as such) | Learn spam/ham (guarded) | Explicit note that history is not persistent |
| **Containers** | Table: name, image, state, health, uptime, CPU, memory, ports | Start/Stop/Restart (Tier 2), logs, inspect | Only allowlisted containers are actionable; others read-only with explanation |
| **Container detail** | Tabs: Overview · Logs · Stats · Inspect | Lifecycle actions | — |
| **Service Logs** | Virtualized viewer, source selector, severity + time filter, search with highlight, follow toggle, pause/resume, clear buffer, download | Download, clear view | Follow auto-pauses on scroll-up; "Jump to latest" pill appears |
| **Backups** | Table: created, size, contents, verification status | Create, verify, download, **Restore (Tier 4)**, delete (Tier 3) | Never auto-selects a backup |
| **Config / Environment** | Key/value with current vs pending, secrets masked | Edit → **diff** → impact → confirm → apply | Every change states restart/recreate impact before applying |
| **Diagnostics** | On-demand deep check list with per-check result and remediation | Run all, run one | Long-running → job tray |
| **Audit Log** | Table: time, actor, action, target, result, IP | Filter, export | Read-only by construction |
| **Login** | Centered card, minimal | Sign in | Generic failure message; never reveals whether the account exists |

### 6.3 Domains are a derived view — the honest design

docker-mailserver has **no concept of a domain as a manageable object**. There is no `setup domain` command; the domain list is computed from the address parts of `postfix-accounts.cf` and `postfix-virtual.cf`. A domain begins to exist the moment the first mailbox or alias uses it, and ceases to exist when the last one is removed.

This is a case where the honest design is also the better one:

- **There is no "Add domain" button.** Adding one would be a fake control — it could not write anything durable. The Domains page instead offers *Add mailbox*, with a domain field, and explains that creating the first mailbox for a new domain is what brings the domain into being.
- **There is no "Delete domain" button.** A domain disappears as a consequence of removing its last mailbox and alias. The domain page shows what still references the domain and links to those objects.
- **Domain-level DNS and DKIM operations are real** and remain first-class here — `setup config dkim` genuinely operates per domain, and DNS lookups are per domain. This is the page's actual job.
- The page states its own nature in one line of helper text, so an admin who goes looking for "add domain" understands within seconds why it is absent rather than assuming the panel is broken.

Everything on this page is therefore backed by a real operation. Nothing is decorative, and nothing is disabled-with-an-apology — the page is simply scoped to what exists.

---

## 7. Component inventory

| Component | Base | Purpose | Key variants | Accessibility |
| --- | --- | --- | --- | --- |
| `StatusBadge` | custom | Status as chip | 6 states × solid/subtle | Icon + text, never colour alone |
| `HealthIndicator` | custom | Inline dot + label | 6 states | `aria-label` carries state word |
| `MetricTile` | Card | Dashboard number + trend | with/without sparkline, unknown | Value in `aria-label`, not just visual |
| `DataTable` | TanStack Table (headless) + custom | All tables | selectable, paginated, virtualized | Native `<table>`; `aria-sort` on headers; roving tabindex |
| `LogViewer` | custom + `@tanstack/react-virtual` | High-volume logs | follow, paused, filtered | Live region for new lines, throttled |
| `DiffViewer` | custom | Config change preview | unified/split | Changes announced textually, not by colour alone |
| `ConfirmDialog` | AlertDialog (Radix) | Tiered confirmation | 4 tiers (§8) | Focus trap, `aria-describedby` on impact summary |
| `SecretField` | Input + Button | Masked values | show/hide/copy/reveal-audited | Toggle state announced |
| `DnsRecordCard` | Card | One DNS record's state | 5 states | Expected vs actual as text |
| `JobProgress` | custom | Long-running op | tray + inline | `role="progressbar"`, polite updates |
| `EmptyState` | custom | No data | first-run vs filtered | Action is a real focusable button |
| `ErrorState` | custom | Failure + recovery | inline, page, boundary | Error ID selectable for support |
| `UnsupportedNotice` | custom | Capability absent upstream | inline, tooltip | Explains *why*, links to docs |
| `CommandPalette` | `cmdk` | ⌘K navigation/search | — | Full keyboard, announced results |
| `CodeBlock` | custom | Config, DNS records | with copy | Copy result announced |
| `PageHeader`/`Toolbar`/`FilterBar` | custom | Layout | — | Landmarks |

Standard shadcn/ui components (Button, Input, Select, Dialog, Drawer, Tabs, Tooltip, Toast/Sonner, Badge, Card, Sheet, Popover, Checkbox, Switch, Skeleton) are used as-is, restyled through tokens only.

---

## 8. Destructive action tiers

Four tiers. Every destructive operation is assigned one; nothing destructive is unassigned.

| Tier | Pattern | Applies to |
| --- | --- | --- |
| **1 — Confirm** | Standard dialog, "Cancel / Confirm", no default focus on the destructive button | Cancel a job · clear log view · dismiss notification · unban an IP |
| **2 — Confirm + consequence** | Dialog stating the operational consequence ("Mail delivery stops until restart completes") | Stop/restart container · flush queue · delete a queued message · reload service |
| **3 — Type-to-confirm + impact summary** | Must type the exact resource name. Impact summary lists what will be deleted, its size, and what depends on it | **Delete mailbox** (and its mail) · delete domain · delete volume · delete alias with dependents · delete administrator |
| **4 — Type-to-confirm + pre-flight + backup gate** | Full pre-flight report, requires typing the resource name, **and** either a verified recent backup or an explicit acknowledgement that none exists | **Restore a backup** · destructive config apply · update with container recreation |

**Tier 3 impact summary must contain:** exact resource identity · what is destroyed (e.g. "1,284 messages, 2.3 GB of mail data") · dependent objects (aliases pointing at this mailbox) · whether a recent backup exists and its age · a clear statement of reversibility.

Rules that apply across all tiers:
- The destructive button is **never** the default-focused element and never the only one styled prominently.
- Row-level delete icons **do not exist** in tables — destructive actions live behind an explicit menu.
- The command palette may *navigate to* a destructive action but never executes one directly.
- Bulk destructive operations get Tier 3 minimum, with the full affected list enumerated and scrollable.

---

## 9. State patterns

| State | Rule |
| --- | --- |
| **Loading — skeleton** | Layout is known: tables, cards, detail pages. Skeleton matches final geometry to avoid shift. |
| **Loading — spinner** | Only for actions inside an already-rendered surface (button pending). |
| **Loading — inline/optimistic** | Toggles and small edits update optimistically, revert with a toast on failure. |
| **Empty — first run** | No data ever existed. Explains what the thing is and offers the primary creating action. |
| **Empty — filtered** | Data exists but the filter matched nothing. Shows the active filters and a *Clear filters* action. **Never** shows the create action, which would be the wrong offer. |
| **Error** | Human sentence, then error ID (selectable), then collapsible technical detail, then a recovery action. Never a raw stack trace. |
| **Partial / degraded** | One subsystem unreachable → that card shows `Unknown` with a retry; the rest of the page renders normally. Never blanks the page. |
| **Unsupported** | Capability docker-mailserver genuinely lacks. Control is **visible but disabled**, with a short explanation and a docs link. We neither hide it (the admin then hunts for it) nor fake it. |

The **Unsupported** state is a hard project requirement and gets a dedicated component so it is applied consistently rather than improvised per screen.

---

## 10. Responsive strategy

| Breakpoint | Change |
| --- | --- |
| `≥1536` | Dashboard 4 tiles/row; tables show all optional columns |
| `1280–1535` | Default desktop; sidebar expanded |
| `1024–1279` | Sidebar auto-collapses to icon rail; tables drop lowest-priority columns |
| `768–1023` (tablet) | Sidebar becomes a drawer; dashboard 2 tiles/row; tables drop to essential columns + row expander |
| `<768` (mobile) | Single column; **tables become card lists**, not horizontally scrolling grids |

**Mobile prioritises** — dashboard verdict, service health, container status and restart, log viewing, mailbox/domain lookup, password reset. **Mobile defers** — config/env editing, diff review, backup creation and restore, exec console, bulk operations. Deferred features show a clear "best done on a larger screen" notice rather than a broken cramped form. Restore is *not available on mobile at all*: a four-tier destructive flow on a phone is a data-loss hazard. **(judgement)**

"Dense tables degrade to card lists" concretely means: each row becomes a card with the primary identifier as its title, 2–3 key fields as labelled pairs, the status chip top-right, and actions in an overflow menu.

---

## 11. Keyboard & accessibility

**Global shortcuts:** `⌘/Ctrl+K` palette · `/` focus search · `g` then `d/m/c/l` go to Dashboard/Mailboxes/Containers/Logs · `?` shortcut help · `Esc` close top layer.

**Rules:**
- Visible focus ring on every interactive element: 2px `--focus-ring` + 2px offset, never removed.
- Skip-to-content link as the first tab stop.
- Dialogs/drawers: focus trapped, focus returns to the trigger on close (Radix guarantees this — we must not fight it).
- Tables use a **native `<table>`** with `aria-sort` on sortable headers. `role="grid"` is used **only** if we implement full cell-level arrow-key navigation; a half-implemented grid role is worse for screen readers than a plain table.
- Async results announce via `aria-live="polite"`; errors via `role="alert"`. The log viewer throttles announcements to avoid flooding.
- Colour is never the sole carrier of meaning (§3.3).
- All form fields have real `<label>` associations; errors linked by `aria-describedby`.
- `prefers-reduced-motion` honoured globally (§4).

**Acceptance criteria for Phase 10 (testable):**
1. Automated contrast test passes for both themes (§3.4).
2. `axe-core` reports zero critical/serious violations on every route.
3. Every critical workflow completable with keyboard only.
4. Every interactive element reachable by Tab with a visible focus indicator.
5. No `role="grid"` without full arrow-key cell navigation.
6. Reduced-motion verified on modals, toasts, and the job tray.

---

## 12. Dependencies on other research — all resolved

| Item | Resolution | Where it landed |
| --- | --- | --- |
| Domains as a real object | **Resolved: not first-class.** No `setup domain` command exists; domains are derived from address parts in `postfix-accounts.cf` / `postfix-virtual.cf` | §6.3 — no Add/Delete domain controls; page scoped to DNS, DKIM and membership |
| Aliases and Forwarding as one page | **Resolved: one mechanism.** DMS has `setup alias {add,del,list}` writing `postfix-virtual.cf`; there is no separate forwarding subsystem | One **Aliases** page. Forwarding is presented as an alias whose destination is external, distinguished by a type column, not a second page |
| Autoresponder date window | **Resolved: real.** RFC 5260 `currentdate` wrapping RFC 5230 `vacation` expresses a start/end window | Feature is buildable as specified |
| Spam trend chart | **Resolved: needs our own sampling.** Rspamd `/history` is a 200-entry in-memory ring buffer, lost on restart | §6.1 — we sample `/stat` into SQLite and say "Collecting" until we have data |

One correction carried in from research: the brief refers to `postfix-aliases.cf`, which **does not exist** in docker-mailserver. The real alias file is `postfix-virtual.cf`. Any UI copy or documentation referencing the former must be corrected.
