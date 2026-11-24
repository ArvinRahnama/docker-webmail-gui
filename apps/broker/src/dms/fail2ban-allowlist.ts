import { Fail2banAllowlistIpSchema } from '@dwg/shared';
import type { CommandResult } from './commands.js';

type AllowlistParams =
  { readonly action: 'list' } | { readonly action: 'add' | 'remove'; readonly ip: string };

/** Only this fixed program can write the DMS Fail2ban override. The action and IP are argv. */
export const fail2banAllowlistScript = String.raw`
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

saved = Path('/tmp/docker-mailserver/fail2ban-jail.cf')
active = Path('/etc/fail2ban/jail.d/user-jail.local')
jail = 'postfix'
option = 'dwg_postfix_allowlist'
section_pattern = re.compile(r'(?m)^[ \t]*\[([^\]\r\n]+)\][^\r\n]*$')
entries_pattern = re.compile(r'(?m)^' + option + r' =([^\r\n]*)$')
ignore_pattern = re.compile(r'(?im)^([ \t]*)ignoreip[ \t]*[:=][^\r\n]*$')

def read(path):
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError('Expected a regular Fail2ban configuration file.')
        return path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return None

def replace(path, contents):
    if contents is None:
        path.unlink(missing_ok=True)
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix='.' + path.name + '.', mode='w', encoding='utf-8', delete=False
        ) as handle:
            temporary = Path(handle.name)
            if path.exists():
                current = path.stat()
                os.fchown(handle.fileno(), current.st_uid, current.st_gid)
                os.fchmod(handle.fileno(), stat.S_IMODE(current.st_mode))
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def postfix(config):
    sections = list(section_pattern.finditer(config))
    for index, section in enumerate(sections):
        if section.group(1) == jail:
            end = sections[index + 1].start() if index + 1 < len(sections) else len(config)
            return config[:section.end()], config[section.end():end], config[end:]
    return config.rstrip('\n') + '\n\n[postfix]', '\n', ''

def managed_ips(section):
    match = entries_pattern.search(section)
    return {str(ipaddress.ip_address(ip)) for ip in match.group(1).split()} if match else set()

def update(section, addresses):
    value = option + ' =' + (' ' + ' '.join(sorted(addresses)) if addresses else '')
    if entries_pattern.search(section):
        return entries_pattern.sub(value, section, count=1)
    interpolation = '%(' + option + ')s'
    ignore = ignore_pattern.search(section)
    if ignore:
        # Extend the existing value on its own continuation line so comments,
        # inherited settings and existing addresses keep their meaning.
        section = section[:ignore.end()] + '\n' + ignore.group(1) + '    ' + interpolation + section[ignore.end():]
    else:
        section = section.rstrip('\n') + '\nignoreip = %(known/ignoreip)s ' + interpolation + '\n'
    return section.rstrip('\n') + '\n' + value + '\n\n'

def client(*args):
    return subprocess.run(
        ['fail2ban-client', *args], check=True, capture_output=True, text=True, timeout=15
    ).stdout

def apply(action, ip):
    old_saved = read(saved)
    prefix, section, suffix = postfix(old_saved or '')
    addresses = managed_ips(section)
    if action == 'remove' and ip not in addresses:
        return
    if action == 'add':
        addresses.add(ip)
    else:
        addresses.remove(ip)
    updated = prefix + update(section, addresses) + suffix
    old_active = read(active)
    replace(active, updated)
    try:
        client('-t')
        replace(saved, updated)
        client('reload', jail)
    except (OSError, subprocess.SubprocessError):
        replace(active, old_active)
        if read(saved) != old_saved:
            replace(saved, old_saved)
        client('reload', jail)
        raise
    if action == 'add' and ip in client('get', jail, 'banip').split():
        client('set', jail, 'unbanip', ip)

def main():
    action = sys.argv[1]
    if action == 'list':
        _, section, _ = postfix(read(saved) or '')
        print(json.dumps(sorted(managed_ips(section))))
        return
    if action not in ('add', 'remove'):
        raise ValueError('Unknown allowlist action.')
    ip = str(ipaddress.ip_address(sys.argv[2]))
    with open('/run/dwg-postfix-allowlist.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        apply(action, ip)

try:
    main()
except (OSError, ValueError, subprocess.SubprocessError):
    sys.exit('Could not update or read the Postfix Fail2ban allowlist.')
`;

export function buildFail2banAllowlistCommand(params: AllowlistParams): CommandResult {
  const argv = ['python3', '-', params.action];
  if (params.action !== 'list') {
    if (!Fail2banAllowlistIpSchema.safeParse(params.ip).success) {
      return { ok: false, error: 'Expected an IPv4 or IPv6 address.' };
    }
    argv.push(params.ip);
  }
  return { ok: true, command: { argv, stdin: fail2banAllowlistScript } };
}
