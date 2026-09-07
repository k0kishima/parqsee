#!/bin/sh
# Validate a signed Parqsee .pkg with App Store Connect and upload it.
#
# The last step of the submission on its own: scripts/release/appstore.sh
# calls this after building, signing and packaging, and re-signs and
# re-packages on every run, so this is how a package that was validated is
# uploaded later as the same bytes — and how the upload becomes its own
# stage once CI (#6) exists.
#
# Usage:
#   scripts/release/upload_pkg.sh [--validate-only] <Parqsee.pkg>
#
#   --validate-only     Run `altool --validate-app` and stop.
#   -h, --help
#
# Environment:
#   APPLE_API_KEY        App Store Connect API key id
#   APPLE_API_ISSUER     the key's issuer id
#   APPLE_API_KEY_PATH   the .p8 file; without it altool looks for
#                        AuthKey_<APPLE_API_KEY>.p8 in ~/.appstoreconnect/private_keys
#                        and its other default directories
#
# App Store Connect takes signed packages only, so an unsigned one is
# refused here (`pkgutil --check-signature`) rather than by altool after
# the upload. `xcrun altool` validates and uploads with the API key;
# Transporter (Mac App Store) does the same by dragging the .pkg onto it,
# if altool is ever retired — this file is the one place to change then.
set -eu

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

die() {
  echo "upload_pkg.sh: $*" >&2
  exit 1
}

VALIDATE_ONLY=0
PKG=

while [ $# -gt 0 ]; do
  case "$1" in
    --validate-only) VALIDATE_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$PKG" ] || die "one package at a time (see --help)"; PKG=$1 ;;
  esac
  shift
done
[ -n "$PKG" ] || die "which package? (see --help)"
[ -f "$PKG" ] || die "no package at $PKG"

: "${APPLE_API_KEY:?set APPLE_API_KEY (App Store Connect API key id)}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER (the issuer id of the key)}"
if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  [ -f "$APPLE_API_KEY_PATH" ] || die "no API key file at $APPLE_API_KEY_PATH"
fi
for tool in pkgutil xcrun; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found; this script runs on macOS with Xcode"
done

if ! SIGNATURE=$(pkgutil --check-signature "$PKG" 2>&1); then
  printf '%s\n' "$SIGNATURE" >&2
  die "$PKG is not signed; App Store Connect takes signed packages only"
fi

if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  # altool only finds the key under this name in one of its directories.
  KEY_DIR=$(mktemp -d -t parqsee-api-key)
  trap 'rm -rf "$KEY_DIR"' EXIT
  cp "$APPLE_API_KEY_PATH" "$KEY_DIR/AuthKey_$APPLE_API_KEY.p8"
  chmod 600 "$KEY_DIR/AuthKey_$APPLE_API_KEY.p8"
  export API_PRIVATE_KEYS_DIR="$KEY_DIR"
fi

echo "==> validating $PKG with App Store Connect"
xcrun altool --validate-app "$PKG" -t macos \
  --api-key "$APPLE_API_KEY" --api-issuer "$APPLE_API_ISSUER"
if [ "$VALIDATE_ONLY" = 1 ]; then
  echo "validated $PKG; upload it by running this again without --validate-only"
  exit 0
fi

echo "==> uploading $PKG"
xcrun altool --upload-app -f "$PKG" -t macos \
  --api-key "$APPLE_API_KEY" --api-issuer "$APPLE_API_ISSUER"
echo "uploaded $PKG to App Store Connect; it appears under the app's builds once processed"
