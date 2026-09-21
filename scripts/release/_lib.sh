# Shared by the release scripts in this directory; sourced, never run.
#
# Sourcing has to happen after the sourcing script's own `set -eu`, because
# `usage` prints that script's header comment and stops at that line.

# The header comment of the script being run, as help text: everything from
# the second line (past the shebang) to `set -eu`, with the comment markers
# taken off. Each script therefore documents itself exactly once, where a
# reader of the file sees it.
usage() {
  sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

# Fail with a message that names the script, which matters because these
# scripts call each other: `appstore.sh` runs `upload_pkg.sh`, and without
# the name the reader cannot tell which of the two refused.
die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

# Refuse early when a tool the script shells out to is missing, rather than
# part-way through a build.
need_tools() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found; this script runs on macOS with Xcode"
  done
}

# The App Store Connect API key, as `xcrun altool` wants it. `$1` says what
# asked for it ("" when the script does nothing else), so a script that only
# needs the key for one of its options can say which one. The key file is
# optional: altool also finds a key installed under ~/.appstoreconnect.
#
# `die`, not `${APPLE_API_KEY:?...}`: the shell's own diagnostic names the
# file and line the expansion sits on, which from here is this file rather
# than the script the operator ran.
need_api_key() {
  _for_what=$1
  [ -n "${APPLE_API_KEY:-}" ] || die "set APPLE_API_KEY (App Store Connect API key id)$_for_what"
  [ -n "${APPLE_API_ISSUER:-}" ] || die "set APPLE_API_ISSUER (the issuer id of the key)$_for_what"
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    [ -f "$APPLE_API_KEY_PATH" ] || die "no API key file at $APPLE_API_KEY_PATH"
  fi
}
