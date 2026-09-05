#!/bin/sh
# Re-sign the store build of Parqsee.app so StoreKit talks to the sandbox
# App Store (docs/MANUAL_QA.md, MQ-12).
#
# StoreKit only answers an app that carries a provisioning profile and is
# signed by a certificate from the same team: without them the sandbox
# store is not used, `Product.products(for:)` returns nothing and the
# upgrade prompt shows "did not return a price". `pnpm tauri:store` signs
# ad hoc, so the profile is embedded and the bundle signed again — by
# scripts/release/sign_app.sh, the same routine the submission uses with
# the distribution profile. The result is for testing on the developer's
# own Macs; the App Store upload is scripts/release/appstore.sh (#16).
#
# Usage:
#   scripts/qa/sign_for_storekit.sh <Parqsee.app> <profile.provisionprofile> "<Apple Development: Name (TEAMID)>"
#
# The profile must be a *Mac App Development* profile for the App ID
# llc.fuji.parqsee (Certificates, Identifiers & Profiles); the identity is
# the Apple Development certificate it was made for (`security
# find-identity -v -p codesigning` lists what the keychain has).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
exec "$HERE/../release/sign_app.sh" "$@"
