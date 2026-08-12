#!/usr/bin/env bash
set -euo pipefail

REPO="${CLIENT_WIZARD_REPO:-runvibe/client-wizard}"
APP_NAME="Client Wizard.app"
INSTALL_DIR="${CLIENT_WIZARD_INSTALL_DIR:-$HOME/Applications}"
OPEN_AFTER_INSTALL="${CLIENT_WIZARD_OPEN:-1}"
VERSION="${CLIENT_WIZARD_VERSION:-${1:-latest}}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar
need_cmd awk
need_cmd sed

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is only supported on macOS." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET_ARCH="aarch64" ;;
  x86_64) ASSET_ARCH="x64" ;;
  *)
    echo "Unsupported macOS architecture: $ARCH" >&2
    exit 1
    ;;
esac

api_get() {
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$1"
}

if [ "$VERSION" = "latest" ]; then
  RELEASE_JSON="$(api_get "https://api.github.com/repos/$REPO/releases/latest")"
else
  RELEASE_JSON="$(api_get "https://api.github.com/repos/$REPO/releases/tags/$VERSION")"
fi

TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$TAG" ]; then
  echo "Could not resolve release tag for $REPO." >&2
  exit 1
fi

ASSET_URL="$(
  printf '%s' "$RELEASE_JSON" |
    tr '{' '\n' |
    awk -v arch="$ASSET_ARCH" '
      /browser_download_url/ && /\.app\.tar\.gz"/ && $0 ~ arch {
        match($0, /"browser_download_url": *"[^"]+"/)
        if (RSTART) {
          value = substr($0, RSTART, RLENGTH)
          sub(/^"browser_download_url": *"/, "", value)
          sub(/"$/, "", value)
          print value
          exit
        }
      }
    '
)"

if [ -z "$ASSET_URL" ]; then
  echo "Could not find a macOS .app.tar.gz asset for architecture $ASSET_ARCH in release $TAG." >&2
  exit 1
fi

SHA_URL="$ASSET_URL.sha256"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/client-wizard.app.tar.gz"
SHA_FILE="$TMP_DIR/client-wizard.app.tar.gz.sha256"

echo "Downloading Client Wizard $TAG for macOS $ARCH..."
curl -fL "$ASSET_URL" -o "$ARCHIVE"
curl -fL "$SHA_URL" -o "$SHA_FILE"

EXPECTED_SHA="$(awk '{ print $1 }' "$SHA_FILE")"
if [ -z "$EXPECTED_SHA" ]; then
  echo "Checksum file is empty: $SHA_URL" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
else
  need_cmd openssl
  ACTUAL_SHA="$(openssl dgst -sha256 "$ARCHIVE" | awk '{ print $2 }')"
fi

if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  echo "Checksum mismatch." >&2
  echo "Expected: $EXPECTED_SHA" >&2
  echo "Actual:   $ACTUAL_SHA" >&2
  exit 1
fi

EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR"

EXTRACTED_APP="$EXTRACT_DIR/$APP_NAME"
if [ ! -d "$EXTRACTED_APP" ]; then
  EXTRACTED_APP="$(find "$EXTRACT_DIR" -maxdepth 2 -name "$APP_NAME" -type d | head -n 1)"
fi

if [ -z "${EXTRACTED_APP:-}" ] || [ ! -d "$EXTRACTED_APP" ]; then
  echo "Archive did not contain $APP_NAME." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
TARGET_APP="$INSTALL_DIR/$APP_NAME"
rm -rf "$TARGET_APP"
ditto "$EXTRACTED_APP" "$TARGET_APP"

if command -v codesign >/dev/null 2>&1; then
  echo "Applying local ad-hoc signature..."
  codesign --force --deep --sign - "$TARGET_APP"
fi

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true
fi

echo "Client Wizard installed at: $TARGET_APP"

if [ "$OPEN_AFTER_INSTALL" = "1" ]; then
  open "$TARGET_APP"
fi
