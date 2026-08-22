/**
 * ⌘K / Ctrl+K command palette, and `/`'s global-search entry point into
 * the same dialog (UX_ARCHITECTURE.md §5.3: "global search (`/`), command
 * palette trigger (`⌘K`)" — one component serves both, since §7's
 * component inventory names exactly one `CommandPalette`, not two
 * separate search/palette implementations that could drift apart).
 *
 * **"May only reach features that exist"** (this project's working
 * agreement #1, applied to a palette exactly as it applies to a button —
 * UX_ARCHITECTURE.md §8: "the command palette may navigate to a
 * destructive action but never executes one directly"):
 *
 *  - Every static entry below is a real, routed page in `App.tsx` — this
 *    list is exhaustive over that file's route table, not a superset of
 *    it. No entry points at a domain create, a mailbox disable, a
 *    container recreate, or an update-apply that performs anything.
 *  - Live entity search covers domains and mailboxes only — both genuine
 *    `GET` reads this app already ships (`fetchDomains`/`fetchMailboxes`,
 *    the same calls the Domains/Mailboxes list pages themselves use).
 *    Alias quick-open is deliberately not included yet: it would be the
 *    same shape of addition, just not built in this pass — a real,
 *    reachable gap, not a silent omission.
 *  - Selecting any result only ever navigates. Nothing in this file calls
 *    a mutation.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@/components/ui/visually-hidden';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDomainsQuery } from '@/mail/use-mail-queries';
import { fetchMailboxes } from '@/lib/mail-api';

interface NavEntry {
  readonly to: string;
  readonly label: string;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavEntry[];
}

/** Exhaustive over `App.tsx`'s route table — every list-level (non-`:param`) route, grouped to match the nav bar's own sections (`app-layout.tsx`). */
const NAV_GROUPS: readonly NavGroup[] = [
  { heading: 'Overview', items: [{ to: '/', label: 'Dashboard' }] },
  {
    heading: 'Mail',
    items: [
      { to: '/mail/domains', label: 'Domains' },
      { to: '/mail/mailboxes', label: 'Mailboxes' },
      { to: '/mail/aliases', label: 'Aliases' },
      { to: '/mail/storage', label: 'Storage' },
    ],
  },
  {
    heading: 'Security',
    items: [
      { to: '/security/email-auth', label: 'Email Authentication' },
      { to: '/security/tls', label: 'TLS' },
      { to: '/security/clamav', label: 'ClamAV' },
      { to: '/security/fail2ban', label: 'Fail2ban' },
      { to: '/security/sieve', label: 'Sieve' },
      { to: '/security/autoresponder', label: 'Autoresponder' },
    ],
  },
  {
    heading: 'Docker',
    items: [
      { to: '/docker/containers', label: 'Containers' },
      { to: '/docker/images', label: 'Images' },
      { to: '/docker/volumes', label: 'Volumes' },
      { to: '/docker/networks', label: 'Networks' },
      { to: '/docker/logs', label: 'Logs' },
      { to: '/docker/monitoring', label: 'Monitoring' },
      { to: '/docker/health', label: 'Health' },
      { to: '/docker/console', label: 'Console' },
    ],
  },
  {
    heading: 'Maintenance',
    items: [
      { to: '/maintenance/jobs', label: 'Jobs' },
      { to: '/maintenance/backups', label: 'Backups' },
      { to: '/maintenance/updates', label: 'Updates' },
      { to: '/maintenance/config', label: 'Configuration' },
    ],
  },
];

const MAX_RESULTS_PER_GROUP = 5;
const SEARCH_DEBOUNCE_MS = 200;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Whether a keypress landed in something that should keep typing its own text — `/` must not steal focus away from an admin already typing in a form field. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const needle = debouncedQuery.trim().toLowerCase();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
      if (modifierHeld && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (event.key === '/' && !open && !isEditableTarget(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const domainsQuery = useDomainsQuery();
  const matchedDomains = useMemo(() => {
    if (needle.length === 0) return [];
    return (domainsQuery.data?.domains ?? [])
      .filter((domain) => domain.domain.toLowerCase().includes(needle))
      .slice(0, MAX_RESULTS_PER_GROUP);
  }, [domainsQuery.data, needle]);

  const mailboxSearch = useQuery({
    queryKey: ['command-palette', 'mailboxes', needle],
    queryFn: () => fetchMailboxes({ search: needle, pageSize: MAX_RESULTS_PER_GROUP }),
    enabled: open && needle.length > 0,
  });
  const matchedMailboxes = mailboxSearch.data?.mailboxes ?? [];

  const matchedNavGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        heading: group.heading,
        items:
          needle.length === 0
            ? group.items
            : group.items.filter((item) => item.label.toLowerCase().includes(needle)),
      })).filter((group) => group.items.length > 0),
    [needle],
  );

  const hasAnyResult =
    matchedDomains.length > 0 || matchedMailboxes.length > 0 || matchedNavGroups.length > 0;

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  const isMac =
    typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

  return (
    <>
      {/* The visible topbar affordance UX_ARCHITECTURE.md §5.3 calls for
          ("command palette trigger (⌘K)") — the keyboard shortcut alone
          would be undiscoverable to an admin who has never used one. */}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="gap-2 text-text-secondary"
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Search…</span>
        <kbd className="hidden rounded-sm border border-border-default bg-bg-inset px-1.5 py-0.5 text-caption sm:inline">
          {isMac ? '⌘K' : 'Ctrl+K'}
        </kbd>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
          <VisuallyHidden>
            <DialogTitle>Command palette</DialogTitle>
          </VisuallyHidden>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search or jump to…"
              value={query}
              onValueChange={setQuery}
              autoFocus
            />
            <CommandList>
              {!hasAnyResult ? <CommandEmpty>No results.</CommandEmpty> : null}

              {matchedDomains.length > 0 ? (
                <CommandGroup heading="Domains">
                  {matchedDomains.map((domain) => (
                    <CommandItem
                      key={domain.domain}
                      value={`domain-${domain.domain}`}
                      onSelect={() => go(`/mail/domains/${encodeURIComponent(domain.domain)}`)}
                    >
                      {domain.domain}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {matchedMailboxes.length > 0 ? (
                <CommandGroup heading="Mailboxes">
                  {matchedMailboxes.map((mailbox) => (
                    <CommandItem
                      key={mailbox.email}
                      value={`mailbox-${mailbox.email}`}
                      onSelect={() => go(`/mail/mailboxes/${encodeURIComponent(mailbox.email)}`)}
                    >
                      {mailbox.email}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {matchedNavGroups.map((group) => (
                <CommandGroup key={group.heading} heading={group.heading}>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.to}
                      value={`nav-${item.to}`}
                      onSelect={() => go(item.to)}
                    >
                      {item.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
