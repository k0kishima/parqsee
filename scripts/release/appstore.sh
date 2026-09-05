#!/bin/sh
# Build the Mac App Store variant of Parqsee, sign it for the store, wrap it
# into the installer package App Store Connect takes, and (on request)
# upload it. One script from a clean checkout to a build in App Store
# Connect, so the submission is reproducible before CI (#6) exists.
#
# Usage:
#   scripts/release/appstore.sh [options]
#
#   --unsigned          Skip every signature: the ad-hoc signed .app from
#                       `pnpm tauri:store` goes into an unsigned .pkg. The
#                       dry run — it needs no certificate and is what
#                       docs/MANUAL_QA.md (MQ-11) installs.
#   --target <triple>   universal-apple-darwin (default), aarch64-apple-darwin
#                       or x86_64-apple-darwin. The universal build needs
#                       both Rust targets installed (rustup target add …).
#   --build-number <n>  CFBundleVersion for this upload. App Store Connect
#                       refuses a second upload with the same build number,
#                       so every resubmission of one version needs a new one.
#   --skip-build        Reuse the .app the last build left for the target.
#   --app <path>        Sign and package this .app instead of building one
#                       (implies --skip-build).
#   --out <path>        Where to write the .pkg. Default: next to the .app,
#                       Parqsee-<version>.pkg, plus -<build number> when
#                       CFBundleVersion differs from the version.
#   --validate          Run `altool --validate-app` on the package.
#   --upload            Validate, then upload to App Store Connect.
#   -h, --help
#
# Environment (all read here, none by the build):
#   APPLE_SIGNING_IDENTITY     "Apple Distribution: <name> (<TEAM>)"
#   APPLE_INSTALLER_IDENTITY   "3rd Party Mac Developer Installer: <name> (<TEAM>)"
#   APPLE_PROVISIONING_PROFILE path to the Mac App Store provisioning profile
#                              for llc.fuji.parqsee (keep it outside the
#                              repository; *.provisionprofile is git-ignored)
#   APPLE_API_KEY              App Store Connect API key id      (--validate / --upload)
#   APPLE_API_ISSUER           the key's issuer id               (--validate / --upload)
#   APPLE_API_KEY_PATH         the .p8 file; without it altool looks for
#                              AuthKey_<APPLE_API_KEY>.p8 in ~/.appstoreconnect/private_keys
#                              and its other default directories
#
# How it works, and why the pieces are where they are:
#   1. `pnpm tauri:store` builds the .app with the `app-store` Cargo feature
#      (the StoreKit bridge). It runs with every APPLE_* variable unset:
#      Tauri would otherwise sign with APPLE_SIGNING_IDENTITY and, seeing
#      the API key, notarize — the wrong flow for a store build, which is
#      signed by the App Store after review. The .app is ad-hoc signed and
#      re-signed below; this Tauri version has no config key for a
#      provisioning profile, and Tauri does not add the application /
#      team identifiers to the entitlements.
#   2. sign_app.sh embeds the profile and signs with Entitlements.plist plus
#      the two identifiers from the profile — the same routine
#      scripts/qa/sign_for_storekit.sh uses with a development profile.
#   3. productbuild wraps the .app into a component package that installs
#      to /Applications, signed with the installer certificate.
#   4. `xcrun altool` validates and uploads with the API key. Transporter
#      (Mac App Store) does the same by dragging the .pkg onto it, if
#      altool is ever retired.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

die() {
  echo "appstore.sh: $*" >&2
  exit 1
}

TARGET=universal-apple-darwin
UNSIGNED=0
SKIP_BUILD=0
APP=
OUT=
BUILD_NUMBER=
VALIDATE=0
UPLOAD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --unsigned) UNSIGNED=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --validate) VALIDATE=1 ;;
    --upload) UPLOAD=1; VALIDATE=1 ;;
    --target) shift; TARGET=${1:?--target needs a triple} ;;
    --target=*) TARGET=${1#--target=} ;;
    --build-number) shift; BUILD_NUMBER=${1:?--build-number needs a number} ;;
    --build-number=*) BUILD_NUMBER=${1#--build-number=} ;;
    --app) shift; APP=${1:?--app needs a path}; SKIP_BUILD=1 ;;
    --app=*) APP=${1#--app=}; SKIP_BUILD=1 ;;
    --out) shift; OUT=${1:?--out needs a path} ;;
    --out=*) OUT=${1#--out=} ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

case "$TARGET" in
  universal-apple-darwin|aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) die "unsupported target: $TARGET" ;;
esac
if [ -n "$BUILD_NUMBER" ] && [ "$SKIP_BUILD" = 1 ]; then
  die "--build-number sets CFBundleVersion at build time; it cannot be combined with --skip-build / --app"
fi

# Everything the later steps need is checked before the build, which takes
# minutes: a missing certificate should fail in a second.
if [ "$UNSIGNED" = 0 ]; then
  : "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY (Apple Distribution: …) or pass --unsigned}"
  : "${APPLE_INSTALLER_IDENTITY:?set APPLE_INSTALLER_IDENTITY (3rd Party Mac Developer Installer: …) or pass --unsigned}"
  : "${APPLE_PROVISIONING_PROFILE:?set APPLE_PROVISIONING_PROFILE (path to the Mac App Store .provisionprofile) or pass --unsigned}"
  [ -f "$APPLE_PROVISIONING_PROFILE" ] || die "no provisioning profile at $APPLE_PROVISIONING_PROFILE"
fi
if [ "$VALIDATE" = 1 ]; then
  [ "$UNSIGNED" = 0 ] || die "App Store Connect takes signed packages only; --validate / --upload cannot be combined with --unsigned"
  : "${APPLE_API_KEY:?set APPLE_API_KEY (App Store Connect API key id) for --validate / --upload}"
  : "${APPLE_API_ISSUER:?set APPLE_API_ISSUER (the issuer id of the key) for --validate / --upload}"
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    [ -f "$APPLE_API_KEY_PATH" ] || die "no API key file at $APPLE_API_KEY_PATH"
  fi
fi
for tool in productbuild plutil; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found; this script runs on macOS with Xcode"
done

# 1. Build.
if [ -z "$APP" ]; then
  APP="$ROOT/backend/target/$TARGET/release/bundle/macos/Parqsee.app"
fi
if [ "$SKIP_BUILD" = 0 ]; then
  echo "==> building the store variant for $TARGET"
  # A subshell so the unset stays local; Tauri must neither sign with
  # the distribution identity nor notarize (see the header).
  (
    unset APPLE_SIGNING_IDENTITY APPLE_INSTALLER_IDENTITY APPLE_PROVISIONING_PROFILE \
      APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
      APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
    cd "$ROOT/frontend"
    if [ -n "$BUILD_NUMBER" ]; then
      pnpm tauri:store --target "$TARGET" \
        --config "{\"bundle\":{\"macOS\":{\"bundleVersion\":\"$BUILD_NUMBER\"}}}"
    else
      pnpm tauri:store --target "$TARGET"
    fi
  )
fi
[ -d "$APP" ] || die "no app bundle at $APP"

INFO="$APP/Contents/Info.plist"
VERSION=$(plutil -extract CFBundleShortVersionString raw -o - "$INFO")
BUNDLE_VERSION=$(plutil -extract CFBundleVersion raw -o - "$INFO")
if [ -n "$BUILD_NUMBER" ] && [ "$BUNDLE_VERSION" != "$BUILD_NUMBER" ]; then
  die "the build carries CFBundleVersion $BUNDLE_VERSION, not the requested $BUILD_NUMBER"
fi

# 2. Sign.
if [ "$UNSIGNED" = 0 ]; then
  echo "==> signing $APP"
  "$HERE/sign_app.sh" "$APP" "$APPLE_PROVISIONING_PROFILE" "$APPLE_SIGNING_IDENTITY"
else
  echo "==> --unsigned: leaving the ad-hoc signature on $APP"
fi

# 3. Package.
if [ -z "$OUT" ]; then
  NAME="Parqsee-$VERSION"
  [ "$BUNDLE_VERSION" = "$VERSION" ] || NAME="$NAME-$BUNDLE_VERSION"
  OUT="$(dirname "$APP")/$NAME.pkg"
fi
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
echo "==> packaging $OUT"
if [ "$UNSIGNED" = 0 ]; then
  productbuild --component "$APP" /Applications --sign "$APPLE_INSTALLER_IDENTITY" "$OUT"
  pkgutil --check-signature "$OUT"
else
  productbuild --component "$APP" /Applications "$OUT"
fi

# 4. Validate / upload.
if [ "$VALIDATE" = 1 ]; then
  KEY_DIR=
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    # altool only finds the key under this name in one of its directories.
    KEY_DIR=$(mktemp -d -t parqsee-api-key)
    trap 'rm -rf "$KEY_DIR"' EXIT
    cp "$APPLE_API_KEY_PATH" "$KEY_DIR/AuthKey_$APPLE_API_KEY.p8"
    chmod 600 "$KEY_DIR/AuthKey_$APPLE_API_KEY.p8"
    export API_PRIVATE_KEYS_DIR="$KEY_DIR"
  fi
  echo "==> validating $OUT with App Store Connect"
  xcrun altool --validate-app "$OUT" -t macos \
    --api-key "$APPLE_API_KEY" --api-issuer "$APPLE_API_ISSUER"
  if [ "$UPLOAD" = 1 ]; then
    echo "==> uploading $OUT"
    xcrun altool --upload-app -f "$OUT" -t macos \
      --api-key "$APPLE_API_KEY" --api-issuer "$APPLE_API_ISSUER"
  fi
fi

echo
echo "app:     $APP"
SIGNATURE="signed"
[ "$UNSIGNED" = 0 ] || SIGNATURE="unsigned"
echo "package: $OUT ($VERSION, build $BUNDLE_VERSION, $TARGET, $SIGNATURE)"
if [ "$UPLOAD" = 1 ]; then
  echo "uploaded to App Store Connect; it appears under the app's builds once processed"
elif [ "$UNSIGNED" = 1 ]; then
  echo "install for a look with: sudo installer -pkg \"$OUT\" -target /"
else
  echo "upload with --upload, or drop the package on Transporter"
fi
