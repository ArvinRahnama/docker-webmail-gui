# Docker Webmail GUI — docker-mailserver integration (docker/dms/README.md).
#
# Dovecot 2.4 only. Takes the place of docker-mailserver's own
# 70-spam_to_junk.sieve. Spam is never rejected (install.sh disables
# Rspamd's reject threshold); it is filed in Junk here instead.
#
# Each mailbox's own sender lists run first: the panel writes them as the
# personal script "dwg-sender-lists", which files an allowed sender's mail
# in INBOX and a blocked sender's in Junk, then stops. A mailbox with no
# list, or a sender on neither list, falls through to the normal check.
# (On Dovecot 2.3 the same list script runs as its own after-script,
# ahead of docker-mailserver's unchanged spam_to_junk.sieve.)
require ["fileinto", "special-use", "include"];

include :personal :optional "dwg-sender-lists";

if anyof (header :contains "X-Spam-Flag" "YES",
          header :contains "X-Spam" "Yes") {
    fileinto :specialuse "\\Junk" "Junk";
}
