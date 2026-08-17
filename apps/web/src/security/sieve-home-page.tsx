import { MailboxPicker } from './mailbox-picker';

/** `/security/sieve` (FEATURE_MATRIX.md §17). */
export function SieveHomePage() {
  return (
    <MailboxPicker
      title="Sieve filters"
      description="Per-mailbox filter scripts — inspect, edit, validate, and choose which one is active."
      destinationPrefix="/security/sieve"
    />
  );
}
