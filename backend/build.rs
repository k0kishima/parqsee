use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_APP_STORE");
    if env::var_os("CARGO_FEATURE_APP_STORE").is_some() {
        if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            link_storekit();
        } else {
            println!("cargo:warning=the app-store feature only links StoreKit on macOS; this build is always unlocked");
        }
    }
    tauri_build::build()
}

/// Build `storekit/` with SwiftPM and link the static library plus what it
/// needs: the Swift runtime that ships with macOS 12+ (`.tbd` stubs in the
/// SDK, so no rpath) and the compatibility archives from the toolchain,
/// which the Swift objects request through their autolink entries. StoreKit
/// itself is a framework.
fn link_storekit() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let package = manifest.join("storekit");
    println!("cargo:rerun-if-changed={}", package.join("Package.swift").display());
    println!("cargo:rerun-if-changed={}", package.join("Sources").display());

    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64".to_string(),
        Ok(other) => other.to_string(),
        Err(_) => panic!("CARGO_CFG_TARGET_ARCH is not set"),
    };
    let triple = format!("{arch}-apple-macosx");
    let swift_args = ["build", "-c", "release", "--package-path"];
    let status = Command::new("swift")
        .args(swift_args)
        .arg(&package)
        .args(["--triple", &triple])
        .status()
        .expect("`swift build` could not be started; is Xcode installed?");
    if !status.success() {
        panic!("`swift build` failed for {}", package.display());
    }
    let bin_path = output(
        Command::new("swift")
            .args(swift_args)
            .arg(&package)
            .args(["--triple", &triple, "--show-bin-path"]),
    );

    println!("cargo:rustc-link-search=native={bin_path}");
    println!("cargo:rustc-link-lib=static=ParqseeStoreKit");

    let sdk = output(Command::new("xcrun").args(["--sdk", "macosx", "--show-sdk-path"]));
    println!("cargo:rustc-link-search=native={}", Path::new(&sdk).join("usr/lib/swift").display());

    // The Swift objects force-load `libswiftCompatibility56.a` and
    // `libswiftCompatibilityPacks.a` (runtime shims for older macOS), which
    // only the toolchain has. Its lib directory must not become a search
    // path as a whole — it would also satisfy other `-lswift*` requests
    // with copies that install as `@rpath/...` — so the archives are
    // mirrored into a directory of their own.
    // `xcrun --find swift` -> <toolchain>/usr/bin/swift
    let swift = PathBuf::from(output(Command::new("xcrun").args(["--find", "swift"])));
    let toolchain_lib = swift
        .parent()
        .and_then(Path::parent)
        .map(|usr| usr.join("lib/swift/macosx"))
        .expect("the swift binary has no toolchain directory");
    let compat_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("swift-compat");
    std::fs::create_dir_all(&compat_dir).expect("create the swift-compat directory");
    for entry in std::fs::read_dir(&toolchain_lib).expect("read the toolchain's swift lib directory") {
        let path = entry.expect("toolchain entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("libswiftCompatibility") && name.ends_with(".a") {
            std::fs::copy(&path, compat_dir.join(name)).expect("copy a Swift compatibility archive");
        }
    }
    println!("cargo:rustc-link-search=native={}", compat_dir.display());

    println!("cargo:rustc-link-lib=framework=StoreKit");
}

fn output(cmd: &mut Command) -> String {
    let out = cmd.output().unwrap_or_else(|e| panic!("could not run {:?}: {e}", cmd));
    if !out.status.success() {
        panic!("{:?} failed: {}", cmd, String::from_utf8_lossy(&out.stderr));
    }
    String::from_utf8(out.stdout).expect("utf-8 output").trim().to_string()
}
