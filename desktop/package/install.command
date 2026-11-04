#!/bin/bash
# Per-user install. Never launches the helper or asks for administrator rights.
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then echo 'This installer is for macOS.' >&2; exit 1; fi
if [ "$(id -u)" = 0 ]; then echo 'Run this as your own user, without sudo.' >&2; exit 1; fi
package_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
support_dir="$HOME/Library/Application Support"
install_dir="$support_dir/obpal"
host=net.blackboxes.obpal.json
test -f "$package_dir/obpal-desktop"
umask 077
mkdir -p "$install_dir"
# Remove the lifetime marker first: existing sessions release and exit within one second.
rm -f "$install_dir/$host"
sleep 2
cp "$package_dir/obpal-desktop" "$install_dir/obpal-desktop.new"
chmod 700 "$install_dir/obpal-desktop.new"
# Clear only quarantine, retaining any other extended attributes (including signing data).
if /usr/bin/xattr -p com.apple.quarantine "$install_dir/obpal-desktop.new" >/dev/null 2>&1; then
    /usr/bin/xattr -d com.apple.quarantine "$install_dir/obpal-desktop.new"
fi
mv -f "$install_dir/obpal-desktop.new" "$install_dir/obpal-desktop"
if [ "$package_dir" != "$install_dir" ]; then cp "$package_dir/uninstall.command" "$install_dir/uninstall.command"; fi
chmod 700 "$install_dir/uninstall.command"
# plutil quotes the absolute path correctly, including spaces, quotes and non-ASCII home names.
manifest="$install_dir/$host.new"
/usr/bin/plutil -create json "$manifest"
/usr/bin/plutil -insert name -string net.blackboxes.obpal "$manifest"
/usr/bin/plutil -insert description -string 'ob.Pal Desktop' "$manifest"
/usr/bin/plutil -insert type -string stdio "$manifest"
/usr/bin/plutil -insert path -string "$install_dir/obpal-desktop" "$manifest"
/usr/bin/plutil -insert allowed_origins -json '["chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemg/"]' "$manifest"
for browser in 'Google/Chrome' Chromium 'Microsoft Edge' 'BraveSoftware/Brave-Browser' Vivaldi 'Arc/User Data'; do
    hosts="$support_dir/$browser/NativeMessagingHosts"
    mkdir -p "$hosts"
    cp "$manifest" "$hosts/$host.new"
    mv -f "$hosts/$host.new" "$hosts/$host"
done
mv -f "$manifest" "$install_dir/$host"
echo 'Installed ob.Pal Desktop for Chrome, Chromium, Edge, Brave, Vivaldi and Arc.'
echo 'Allow ob.Pal Desktop in System Settings, then Privacy & Security, then Accessibility.'
echo 'Use + and select ~/Library/Application Support/obpal/obpal-desktop if it is not listed.'
echo 'In Link, select PC and allow your phone. Panic key: Control+Option+Delete (backward delete).'
/usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
