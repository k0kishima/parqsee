"""Tests for scripts/release/appstore.sh.

The script is a sequence of tool invocations (pnpm, codesign, productbuild,
altool), so it is run against a fake checkout with stubs of those tools on
PATH that record how they were called. What the stubs check is the
script's own logic: argument handling, where the artifacts go, that the
build never sees the signing environment, that nothing is signed or
uploaded unless asked. One test runs the real productbuild on a minimal
bundle to make sure the package it produces installs to /Applications.

Run from the repository root:

    python3 scripts/release/test_appstore.py
"""

import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

INFO_PLIST = {
    "CFBundleIdentifier": "llc.fuji.parqsee",
    "CFBundleName": "Parqsee",
    "CFBundleShortVersionString": "0.1.0",
    "CFBundleVersion": "0.1.0",
    "CFBundlePackageType": "APPL",
}

# What `security cms -D -i` prints for a profile of the app's team.
PROFILE_PLIST = plistlib.dumps(
    {
        "TeamIdentifier": ["TEAM123456"],
        "Entitlements": {"com.apple.application-identifier": "TEAM123456.llc.fuji.parqsee"},
    }
).decode()

# Each stub appends one tab-separated line per call to $STUB_LOG.
STUB_PRELUDE = '#!/bin/sh\n{ printf "%s" "$(basename "$0")"; for a in "$@"; do printf "\\t%s" "$a"; done; printf "\\n"; } >> "$STUB_LOG"\n'

STUBS = {
    # `pnpm tauri:store --target T [--config JSON]`: leaves the .app where
    # Tauri would, and records the environment the build ran in.
    "pnpm": r'''
env | grep '^APPLE_' >> "$STUB_LOG.env" || true
echo "cwd=$PWD" >> "$STUB_LOG.env"
target=; build=0.1.0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) shift; target=$1 ;;
    --config) shift; build=$(printf '%s' "$1" | sed 's/.*"bundleVersion":"\([^"]*\)".*/\1/') ;;
  esac
  shift
done
app="$PWD/../backend/target/$target/release/bundle/macos/Parqsee.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>llc.fuji.parqsee</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>$build</string>
</dict></plist>
EOF
''',
    # productbuild writes its last argument.
    "productbuild": 'for a in "$@"; do out=$a; done; echo pkg > "$out"\n',
    "pkgutil": "",
    "codesign": "",
    "security": 'cat <<EOF\n' + PROFILE_PLIST + 'EOF\n',
    # altool: also record where it was told to look for the API key,
    # since the directory is gone once the script exits.
    "xcrun": 'if [ -n "${API_PRIVATE_KEYS_DIR:-}" ]; then ls "$API_PRIVATE_KEYS_DIR" >> "$STUB_LOG.keys"; fi\n',
}


def make_checkout(root: Path) -> None:
    """A fake repository with only what the scripts touch."""
    (root / "scripts" / "release").mkdir(parents=True)
    for name in ("appstore.sh", "sign_app.sh"):
        shutil.copy(HERE / name, root / "scripts" / "release" / name)
    (root / "frontend").mkdir()
    (root / "backend").mkdir()
    shutil.copy(REPO / "backend" / "Entitlements.plist", root / "backend" / "Entitlements.plist")


def make_app(path: Path, **overrides) -> Path:
    info = dict(INFO_PLIST, **overrides)
    (path / "Contents" / "MacOS").mkdir(parents=True)
    (path / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
    return path


class ScriptRun:
    def __init__(self, result, log_path: Path):
        self.returncode = result.returncode
        self.stdout = result.stdout
        self.stderr = result.stderr
        self.calls = []
        if log_path.exists():
            self.calls = [line.split("\t") for line in log_path.read_text().splitlines()]
        env_path = Path(str(log_path) + ".env")
        self.build_env = env_path.read_text().splitlines() if env_path.exists() else []
        keys_path = Path(str(log_path) + ".keys")
        self.key_files = keys_path.read_text().split() if keys_path.exists() else []

    def called(self, tool: str):
        return [c for c in self.calls if c[0] == tool]


@unittest.skipUnless(sys.platform == "darwin", "the script and its stubs need macOS's plutil")
class AppstoreScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="parqsee-appstore-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = self.tmp / "checkout"
        make_checkout(self.root)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls.log"
        for name, body in STUBS.items():
            stub = self.bin / name
            stub.write_text(STUB_PRELUDE + body)
            stub.chmod(0o755)
        self.profile = self.tmp / "store.provisionprofile"
        self.profile.write_text("not a real profile; `security` is stubbed")

    def run_script(self, *args, env=None, real_tools=()):
        path = os.pathsep.join([str(self.bin), os.environ["PATH"]])
        if real_tools:
            # Keep the stubs for everything but these.
            for tool in real_tools:
                (self.bin / tool).unlink()
        full_env = {
            k: v for k, v in os.environ.items() if not k.startswith("APPLE_") and k != "API_PRIVATE_KEYS_DIR"
        }
        full_env.update({"PATH": path, "STUB_LOG": str(self.log)})
        full_env.update(env or {})
        result = subprocess.run(
            [str(self.root / "scripts" / "release" / "appstore.sh"), *args],
            capture_output=True,
            text=True,
            env=full_env,
            cwd=self.tmp,
        )
        return ScriptRun(result, self.log)

    def signing_env(self):
        return {
            "APPLE_SIGNING_IDENTITY": "Apple Distribution: Fuji (TEAM123456)",
            "APPLE_INSTALLER_IDENTITY": "3rd Party Mac Developer Installer: Fuji (TEAM123456)",
            "APPLE_PROVISIONING_PROFILE": str(self.profile),
        }

    def bundle_dir(self, target="universal-apple-darwin"):
        return self.root / "backend" / "target" / target / "release" / "bundle" / "macos"

    # -- the dry run -------------------------------------------------------

    def test_unsigned_builds_universal_and_packages_without_any_signature(self):
        run = self.run_script("--unsigned")

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.called("pnpm"), [["pnpm", "tauri:store", "--target", "universal-apple-darwin"]])
        self.assertIn(f"cwd={self.root / 'frontend'}", run.build_env)
        app = self.bundle_dir() / "Parqsee.app"
        pkg = self.bundle_dir() / "Parqsee-0.1.0.pkg"
        self.assertEqual(
            run.called("productbuild"),
            [["productbuild", "--component", str(app), "/Applications", str(pkg)]],
        )
        self.assertTrue(pkg.exists())
        self.assertEqual(run.called("codesign"), [])
        self.assertEqual(run.called("security"), [])
        self.assertEqual(run.called("pkgutil"), [])
        self.assertEqual(run.called("xcrun"), [])
        self.assertFalse((app / "Contents" / "embedded.provisionprofile").exists())
        self.assertIn(f"package: {pkg} (0.1.0, build 0.1.0, universal-apple-darwin, unsigned)", run.stdout)
        self.assertIn("sudo installer -pkg", run.stdout)

    def test_the_build_never_sees_the_signing_environment(self):
        env = dict(
            self.signing_env(),
            APPLE_API_KEY="KEY1",
            APPLE_API_ISSUER="issuer",
            APPLE_API_KEY_PATH=str(self.profile),
            APPLE_ID="me@example.com",
            APPLE_TEAM_ID="TEAM123456",
        )

        run = self.run_script("--unsigned", env=env)

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual([line for line in run.build_env if line.startswith("APPLE_")], [])

    def test_target_selects_the_build_and_the_bundle_directory(self):
        run = self.run_script("--unsigned", "--target", "aarch64-apple-darwin")

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.called("pnpm"), [["pnpm", "tauri:store", "--target", "aarch64-apple-darwin"]])
        self.assertTrue((self.bundle_dir("aarch64-apple-darwin") / "Parqsee-0.1.0.pkg").exists())

    def test_an_unsupported_target_is_refused_before_anything_runs(self):
        run = self.run_script("--unsigned", "--target=x86_64-pc-windows-msvc")

        self.assertEqual(run.returncode, 1)
        self.assertIn("unsupported target", run.stderr)
        self.assertEqual(run.calls, [])

    def test_unknown_options_are_refused(self):
        run = self.run_script("--unsigned", "--notarize")

        self.assertEqual(run.returncode, 1)
        self.assertIn("unknown option: --notarize", run.stderr)
        self.assertEqual(run.calls, [])

    def test_help_prints_the_header(self):
        run = self.run_script("--help")

        self.assertEqual(run.returncode, 0)
        self.assertIn("Usage:", run.stdout)
        self.assertIn("APPLE_INSTALLER_IDENTITY", run.stdout)
        self.assertNotIn("set -eu", run.stdout)

    # -- build numbers -----------------------------------------------------

    def test_build_number_reaches_tauri_and_names_the_package(self):
        run = self.run_script("--unsigned", "--build-number", "7")

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(
            run.called("pnpm"),
            [[
                "pnpm", "tauri:store", "--target", "universal-apple-darwin",
                "--config", '{"bundle":{"macOS":{"bundleVersion":"7"}}}',
            ]],
        )
        self.assertTrue((self.bundle_dir() / "Parqsee-0.1.0-7.pkg").exists())
        self.assertIn("build 7", run.stdout)

    def test_build_number_cannot_be_combined_with_skip_build(self):
        run = self.run_script("--unsigned", "--skip-build", "--build-number=7")

        self.assertEqual(run.returncode, 1)
        self.assertIn("--build-number", run.stderr)
        self.assertEqual(run.calls, [])

    # -- reusing a build ---------------------------------------------------

    def test_skip_build_reuses_the_last_build_of_the_target(self):
        make_app(self.bundle_dir() / "Parqsee.app")

        run = self.run_script("--unsigned", "--skip-build")

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.called("pnpm"), [])
        self.assertTrue((self.bundle_dir() / "Parqsee-0.1.0.pkg").exists())

    def test_skip_build_without_a_build_fails(self):
        run = self.run_script("--unsigned", "--skip-build")

        self.assertEqual(run.returncode, 1)
        self.assertIn("no app bundle at", run.stderr)
        self.assertEqual(run.calls, [])

    def test_app_and_out_take_explicit_paths(self):
        app = make_app(self.tmp / "elsewhere" / "Parqsee.app", CFBundleVersion="12")
        out = self.tmp / "pkgs" / "submission.pkg"

        run = self.run_script("--unsigned", "--app", str(app), "--out", str(out))

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.called("pnpm"), [])
        self.assertEqual(
            run.called("productbuild"),
            [["productbuild", "--component", str(app), "/Applications", str(out)]],
        )
        self.assertTrue(out.exists())

    def test_the_default_package_sits_next_to_the_app(self):
        app = make_app(self.tmp / "elsewhere" / "Parqsee.app", CFBundleVersion="12")

        run = self.run_script("--unsigned", f"--app={app}")

        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((self.tmp / "elsewhere" / "Parqsee-0.1.0-12.pkg").exists())

    # -- signing -----------------------------------------------------------

    def test_signing_needs_the_identities_and_the_profile_before_building(self):
        for missing in ("APPLE_SIGNING_IDENTITY", "APPLE_INSTALLER_IDENTITY", "APPLE_PROVISIONING_PROFILE"):
            with self.subTest(missing=missing):
                env = self.signing_env()
                del env[missing]
                self.log.unlink(missing_ok=True)

                run = self.run_script(env=env)

                self.assertEqual(run.returncode, 1)
                self.assertIn(missing, run.stderr)
                self.assertIn("--unsigned", run.stderr)
                self.assertEqual(run.calls, [])

    def test_a_missing_profile_file_fails_before_building(self):
        env = self.signing_env()
        env["APPLE_PROVISIONING_PROFILE"] = str(self.tmp / "nowhere.provisionprofile")

        run = self.run_script(env=env)

        self.assertEqual(run.returncode, 1)
        self.assertIn("no provisioning profile at", run.stderr)
        self.assertEqual(run.calls, [])

    def test_signed_run_embeds_the_profile_signs_the_app_and_the_package(self):
        run = self.run_script(env=self.signing_env())

        self.assertEqual(run.returncode, 0, run.stderr)
        app = self.bundle_dir() / "Parqsee.app"
        pkg = self.bundle_dir() / "Parqsee-0.1.0.pkg"
        self.assertEqual([c[0] for c in run.calls], [
            "pnpm", "security", "codesign", "codesign", "codesign", "productbuild", "pkgutil",
        ])
        self.assertEqual(run.called("security"), [["security", "cms", "-D", "-i", str(self.profile)]])
        self.assertEqual(
            (app / "Contents" / "embedded.provisionprofile").read_text(),
            self.profile.read_text(),
        )
        sign, verify, _ = run.called("codesign")
        self.assertEqual(sign[:4], ["codesign", "--force", "--sign", "Apple Distribution: Fuji (TEAM123456)"])
        self.assertEqual(sign[-3:], ["--options", "runtime", str(app)])
        entitlements = sign[sign.index("--entitlements") + 1]
        self.assertTrue(entitlements.endswith(".plist"))
        self.assertEqual(verify, ["codesign", "--verify", "--deep", "--strict", str(app)])
        self.assertEqual(
            run.called("productbuild"),
            [[
                "productbuild", "--component", str(app), "/Applications",
                "--sign", "3rd Party Mac Developer Installer: Fuji (TEAM123456)", str(pkg),
            ]],
        )
        self.assertEqual(run.called("pkgutil"), [["pkgutil", "--check-signature", str(pkg)]])
        self.assertEqual(run.called("xcrun"), [])
        self.assertIn("drop the package on Transporter", run.stdout)

    def test_the_signing_entitlements_carry_the_profile_identifiers(self):
        # A codesign stub that keeps the entitlements file it was given.
        keep = self.tmp / "entitlements.plist"
        (self.bin / "codesign").write_text(
            STUB_PRELUDE
            + 'while [ $# -gt 0 ]; do [ "$1" = --entitlements ] && cp "$2" "%s"; shift; done\n' % keep
        )

        run = self.run_script(env=self.signing_env())

        self.assertEqual(run.returncode, 0, run.stderr)
        with keep.open("rb") as f:
            entitlements = plistlib.load(f)
        with (REPO / "backend" / "Entitlements.plist").open("rb") as f:
            base = plistlib.load(f)
        self.assertEqual(
            entitlements,
            dict(
                base,
                **{
                    "com.apple.application-identifier": "TEAM123456.llc.fuji.parqsee",
                    "com.apple.developer.team-identifier": "TEAM123456",
                },
            ),
        )

    def test_a_profile_for_another_app_is_refused(self):
        (self.bin / "security").write_text(
            STUB_PRELUDE + "cat <<EOF\n" + PROFILE_PLIST.replace("llc.fuji.parqsee", "llc.fuji.other") + "EOF\n"
        )

        run = self.run_script(env=self.signing_env())

        self.assertEqual(run.returncode, 1)
        self.assertIn("the profile is for TEAM123456.llc.fuji.other, the app is llc.fuji.parqsee", run.stderr)
        self.assertEqual(run.called("codesign"), [])
        self.assertEqual(run.called("productbuild"), [])

    # -- validation and upload ----------------------------------------------

    def test_validate_and_upload_refuse_an_unsigned_package(self):
        for flag in ("--validate", "--upload"):
            with self.subTest(flag=flag):
                run = self.run_script("--unsigned", flag, env={"APPLE_API_KEY": "K", "APPLE_API_ISSUER": "I"})

                self.assertEqual(run.returncode, 1)
                self.assertIn("signed packages only", run.stderr)
                self.assertEqual(run.calls, [])

    def test_upload_needs_the_api_key_before_building(self):
        run = self.run_script("--upload", env=self.signing_env())

        self.assertEqual(run.returncode, 1)
        self.assertIn("APPLE_API_KEY", run.stderr)
        self.assertEqual(run.calls, [])

    def test_validate_runs_altool_without_uploading(self):
        env = dict(self.signing_env(), APPLE_API_KEY="KEY1", APPLE_API_ISSUER="issuer-1")

        run = self.run_script("--validate", env=env)

        self.assertEqual(run.returncode, 0, run.stderr)
        pkg = self.bundle_dir() / "Parqsee-0.1.0.pkg"
        self.assertEqual(
            run.called("xcrun"),
            [["xcrun", "altool", "--validate-app", str(pkg), "-t", "macos", "--api-key", "KEY1", "--api-issuer", "issuer-1"]],
        )
        self.assertEqual(run.key_files, [])

    def test_upload_validates_then_uploads_with_the_key_file(self):
        key = self.tmp / "AuthKey.p8"
        key.write_text("-----BEGIN PRIVATE KEY-----\nnot really\n-----END PRIVATE KEY-----\n")
        env = dict(
            self.signing_env(), APPLE_API_KEY="KEY1", APPLE_API_ISSUER="issuer-1", APPLE_API_KEY_PATH=str(key)
        )

        run = self.run_script("--upload", env=env)

        self.assertEqual(run.returncode, 0, run.stderr)
        pkg = self.bundle_dir() / "Parqsee-0.1.0.pkg"
        self.assertEqual(
            run.called("xcrun"),
            [
                ["xcrun", "altool", "--validate-app", str(pkg), "-t", "macos", "--api-key", "KEY1", "--api-issuer", "issuer-1"],
                ["xcrun", "altool", "--upload-app", "-f", str(pkg), "-t", "macos", "--api-key", "KEY1", "--api-issuer", "issuer-1"],
            ],
        )
        # altool finds the key only as AuthKey_<id>.p8 in $API_PRIVATE_KEYS_DIR.
        self.assertEqual(run.key_files, ["AuthKey_KEY1.p8", "AuthKey_KEY1.p8"])
        self.assertIn("uploaded to App Store Connect", run.stdout)

    def test_a_missing_key_file_fails_before_building(self):
        env = dict(
            self.signing_env(),
            APPLE_API_KEY="KEY1",
            APPLE_API_ISSUER="issuer-1",
            APPLE_API_KEY_PATH=str(self.tmp / "nowhere.p8"),
        )

        run = self.run_script("--upload", env=env)

        self.assertEqual(run.returncode, 1)
        self.assertIn("no API key file at", run.stderr)
        self.assertEqual(run.calls, [])

    # -- the real productbuild ----------------------------------------------

    @unittest.skipUnless(shutil.which("productbuild") and shutil.which("pkgutil"), "needs Xcode's productbuild")
    def test_the_real_productbuild_makes_a_package_that_installs_to_applications(self):
        app = make_app(self.tmp / "elsewhere" / "Parqsee.app")
        (app / "Contents" / "MacOS" / "parqsee").write_text("#!/bin/sh\n")
        out = self.tmp / "Parqsee.pkg"

        run = self.run_script("--unsigned", "--app", str(app), "--out", str(out), real_tools=("productbuild", "pkgutil"))

        self.assertEqual(run.returncode, 0, run.stderr)
        expanded = self.tmp / "expanded"
        subprocess.run(["pkgutil", "--expand", str(out), str(expanded)], check=True)
        component = next(expanded.glob("*.pkg"))
        package_info = (component / "PackageInfo").read_text()
        self.assertIn('identifier="llc.fuji.parqsee"', package_info)
        self.assertIn('install-location="/Applications"', package_info)
        self.assertIn('version="0.1.0"', package_info)
        self.assertIn("<bundle-version>", package_info)
        self.assertIn('path="./Parqsee.app"', package_info)


if __name__ == "__main__":
    unittest.main()
