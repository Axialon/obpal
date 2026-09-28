#!/bin/bash
# Remove only files installed by ob.Pal Desktop. Browsers can stay open.
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then echo 'This uninstaller is for macOS.' >&2; exit 1; fi
if [ "$(id -u)" = 0 ]; then echo 'Run this as your own user, without sudo.' >&2; exit 1; fi
support_dir="$HOME/Library/Application Support"
install_dir="$support_dir/obpal"
log_dir="$HOME/Library/Logs/obpal"
host=net.blackboxes.obpal.json
# Unregister before deleting the lifetime marker, so the browser cannot start a new session.
for browser in 'Google/Chrome' Chromium 'Microsoft Edge' 'BraveSoftware/Brave-Browser' Vivaldi 'Arc/User Data'; do
    hosts="$support_dir/$browser/NativeMessagingHosts"
    rm -f "$hosts/$host" "$hosts/$host.new"
    rmdir "$hosts" 2>/dev/null || true
done
rm -f "$install_dir/$host" "$install_dir/$host.new"
sleep 2
rm -f "$install_dir/obpal-desktop" "$install_dir/obpal-desktop.new" "$install_dir/desktop.json" "$install_dir/desktop.json.tmp" "$install_dir/uninstall.command"
rm -f "$log_dir/desktop.log"
rmdir "$install_dir" "$log_dir" 2>/dev/null || true
echo 'ob.Pal Desktop and its settings and log are removed. Your browsers can stay open.'
echo 'You can remove its old Accessibility entry in System Settings and delete the downloaded package.'
