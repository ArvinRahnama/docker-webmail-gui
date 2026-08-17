import { MailboxPicker } from './mailbox-picker';

/** `/security/autoresponder` (FEATURE_MATRIX.md §18). */
export function AutoresponderHomePage() {
  return (
    <MailboxPicker
      title="Autoresponder"
      description="Out-of-office replies with an optional start/end date window."
      destinationPrefix="/security/autoresponder"
    />
  );
}
