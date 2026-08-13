#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_not_contains() {
  local file="$1"
  local expected_absent="$2"
  if grep -Fq "$expected_absent" "$file"; then
    fail "Expected $file to not contain: $expected_absent"
  fi
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$file"; then
    fail "Expected $file to contain: $expected"
  fi
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

app_dir="$tmp_dir/Client Wizard.app"
plist="$app_dir/Contents/Info.plist"
mkdir -p "$app_dir/Contents"
cat > "$plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Client Wizard</string>
  <key>LSRequiresCarbon</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

CLIENT_WIZARD_TESTING=1 source "$SCRIPT_DIR/macos.sh"

patch_macos_plist "$app_dir"

assert_contains "$plist" "<key>CFBundleName</key>"
assert_contains "$plist" "<key>NSHighResolutionCapable</key>"
assert_not_contains "$plist" "<key>LSRequiresCarbon</key>"

release_json="$tmp_dir/release.json"
cat > "$release_json" <<'JSON'
{
  "tag_name": "2026.08.0",
  "assets": [
    {
      "name": "Client.Wizard_2026.8.0_aarch64.app.tar.gz",
      "browser_download_url": "https://example.invalid/Client.Wizard_2026.8.0_aarch64.app.tar.gz"
    },
    {
      "name": "Client.Wizard_2026.8.0_aarch64.app.tar.gz.sha256",
      "browser_download_url": "https://example.invalid/Client.Wizard_2026.8.0_aarch64.app.tar.gz.sha256"
    }
  ]
}
JSON

asset_url="$(select_macos_asset_url "$(cat "$release_json")" "aarch64")"
if [ "$asset_url" != "https://example.invalid/Client.Wizard_2026.8.0_aarch64.app.tar.gz" ]; then
  fail "Unexpected asset URL: $asset_url"
fi
