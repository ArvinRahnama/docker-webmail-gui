# Docker Webmail GUI — docker-mailserver integration (docker/dms/README.md).
#
# IMAPSieve: a message moved OUT of Junk is the user saying "not spam".
# Records the sender so the panel can add it to that mailbox's allow list.
# Moving junk to Trash is deleting it, not a report, so it is ignored.
require ["vnd.dovecot.pipe", "copy", "imapsieve", "environment", "variables"];

set "mailbox" "";
if environment :matches "imap.mailbox" "*" { set "mailbox" "${1}"; }
if string :comparator "i;ascii-casemap" :matches "${mailbox}"
    ["Trash", "Trash/*", "Trash.*", "Deleted*", "Bin", "Junk", "Spam"] {
    stop;
}

set "user" "";
if environment :matches "imap.user" "*" { set "user" "${1}"; }
set "from" "";
if address :all :matches "from" "*" { set :lower "from" "${1}"; }
# The topmost Postfix-added Received header is this server's own, and names
# the connecting client's IP in brackets. Headers a sender adds sit below it.
set "ip" "";
if header :matches "Received" "*[*])*(Postfix)*" { set "ip" "${2}"; }

pipe :copy "dwg-sender-report" ["ham", "${user}", "${from}", "${ip}"];
