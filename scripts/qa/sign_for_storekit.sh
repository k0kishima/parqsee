#!/bin/sh
# Re-sign the store build of Parqsee.app so StoreKit talks to the sandbox
# App Store (docs/MANUAL_QA.md, MQ-12).
#
# StoreKit only answers an app that carries a provisioning profile and is
# signed by a certificate from the same team: without them the sandbox
# store is not used, `Product.products(for:)` returns nothing and the
# pre-trial screen shows "did not return a price". `pnpm tauri:store`
# signs ad hoc, and this Tauri version has no config key for a macOS
# provisioning profile, so the profile is embedded and the bundle signed
# again here. The result is for testing on the developer's own Macs; the
# App Store upload is signed differently (#16).
#
# Usage:
#   scripts/qa/sign_for_storekit.sh <Parqsee.app> <profile.provisionprofile> "<Apple Development: Name (TEAMID)>"
#
# The profile must be a *Mac App Development* profile for the App ID
# llc.fuji.parqsee (Certificates, Identifiers & Profiles); the identity is
# the Apple Development certificate it was made for (`security
# find-identity -v -p codesigning` lists what the keychain has).
set -eu

APP=${1:?path to Parqsee.app}
PROFILE=${2:?path to the .provisionprofile}
IDENTITY=${3:?signing identity}
HERE=$(cd "$(dirname "$0")" && pwd)
ENTITLEMENTS_IN="$HERE/../../backend/Entitlements.plist"

# The team and bundle identifiers, from the profile, for the entitlements
# that make the app the profile's app.
PLIST=$(security cms -D -i "$PROFILE")
TEAM=$(printf '%s' "$PLIST" | plutil -extract TeamIdentifier.0 raw -o - -)
APP_ID=$(printf '%s' "$PLIST" | plutil -extract Entitlements.com.apple.application-identifier raw -o - -)
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")
case "$APP_ID" in
  "$TEAM.$BUNDLE_ID") ;;
  *) echo "the profile is for $APP_ID, the app is $BUNDLE_ID" >&2; exit 1 ;;
esac

ENTITLEMENTS=$(mktemp -t parqsee-entitlements).plist
cp "$ENTITLEMENTS_IN" "$ENTITLEMENTS"
plutil -replace com.apple.application-identifier -string "$APP_ID" "$ENTITLEMENTS"
plutil -replace com.apple.developer.team-identifier -string "$TEAM" "$ENTITLEMENTS"

cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"

# Nested code first (Tauri's bundle has none today, but a framework or a
# helper would have to be signed before the bundle), then the bundle with
# the sandbox entitlements plus the two identifiers.
find "$APP/Contents" -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -depth | while read -r nested; do
  codesign --force --sign "$IDENTITY" --options runtime "$nested"
done
codesign --force --sign "$IDENTITY" --entitlements "$ENTITLEMENTS" --options runtime "$APP"
rm -f "$ENTITLEMENTS"

codesign --verify --deep --strict "$APP"
echo "signed $APP with $IDENTITY for $APP_ID"
codesign -d --entitlements - "$APP" 2>&1 | grep -E 'application-identifier|team-identifier|app-sandbox' || true
