# Docker Webmail GUI — docker-mailserver integration (docker/dms/README.md).
#
# Replaces docker-mailserver's own 70-spam_to_junk.sieve. Spam is never
# rejected (install.sh disables Rspamd's reject threshold); it is filed in
# Junk here instead. Each mailbox's own sender lists override the verdict:
# the panel writes them as the personal script "dwg-sender-lists", which
# sets the shared variable below to "allow" or "block".
require ["fileinto", "special-use", "include", "variables"];

global "dwg_sender_verdict";
include :personal :optional "dwg-sender-lists";

if string :is "${dwg_sender_verdict}" "allow" {
    stop;
}

if anyof (string :is "${dwg_sender_verdict}" "block",
          header :contains "X-Spam-Flag" "YES",
          header :contains "X-Spam" "Yes") {
    fileinto :specialuse "\\Junk" "Junk";
}
