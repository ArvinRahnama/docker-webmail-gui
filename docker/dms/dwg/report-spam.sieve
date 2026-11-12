# Docker Webmail GUI — docker-mailserver integration (docker/dms/README.md).
#
# IMAPSieve: a message moved INTO Junk is the user saying "this is spam" —
# blocking the sender. Records the sender so the panel can add it to that
# mailbox's block list (and take it off the allow list).
require ["vnd.dovecot.pipe", "copy", "imapsieve", "environment", "variables"];

set "user" "";
if environment :matches "imap.user" "*" { set "user" "${1}"; }
set "from" "";
if address :all :matches "from" "*" { set :lower "from" "${1}"; }
set "ip" "";
if header :matches "Received" "*[*])*(Postfix)*" { set "ip" "${2}"; }

pipe :copy "dwg-sender-report" ["spam", "${user}", "${from}", "${ip}"];
