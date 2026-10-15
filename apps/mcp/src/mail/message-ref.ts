/**
 * Opaque-looking but self-describing message identifiers handed to the AI
 * client: `m1.<base64url(folder)>.<uidvalidity>.<uid>`. They carry no
 * authority — every use re-checks that the folder exists *in the bound
 * mailbox* and that its UIDVALIDITY still matches — so a model or attacker
 * crafting one can at most name a message the connection could already
 * reach.
 */
import type { MessageRef } from './types.js';

const MAX_FOLDER_LENGTH = 255;

export function encodeMessageRef(ref: MessageRef): string {
  return `m1.${Buffer.from(ref.folder, 'utf8').toString('base64url')}.${ref.uidValidity}.${ref.uid}`;
}

export function decodeMessageRef(id: string): MessageRef | null {
  const match = /^m1\.([A-Za-z0-9_-]{1,400})\.(\d{1,20})\.(\d{1,10})$/.exec(id);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined)
    return null;
  const folder = Buffer.from(match[1], 'base64url').toString('utf8');
  if (folder.length === 0 || folder.length > MAX_FOLDER_LENGTH || !isSafeFolderName(folder))
    return null;
  const uid = Number(match[3]);
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 4294967295) return null;
  return { folder, uidValidity: match[2], uid };
}

/** Folder names from tools: printable, bounded, no control characters or IMAP wildcards. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_FOLDER_CHARACTERS = /[\u0000-\u001f\u007f*%]/;

export function isSafeFolderName(folder: string): boolean {
  return (
    folder.length > 0 &&
    folder.length <= MAX_FOLDER_LENGTH &&
    !UNSAFE_FOLDER_CHARACTERS.test(folder)
  );
}

/** Restore handles for moved-to-Trash messages: the id of the recorded `delete` operation. */
export function isRestoreId(value: string): boolean {
  return /^op_[0-9a-z]{26}$/.test(value);
}
