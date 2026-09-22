use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The static library `storekit/Package.swift` produces.
const LIB_NAME: &str = "ParqseeStoreKit";

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

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
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
    // SwiftPM writes each triple's products into a directory of its own but
    // reports the same `--show-bin-path` for all of them — one directory
    // holding whatever it built last. A universal build runs this script
    // once per architecture, so linking against that path gives whichever
    // slice finished most recently: the x86_64 half of a universal build
    // picked up an arm64 archive and the link failed on the missing
    // `_sk_*` symbols. Take the library from the triple's own directory,
    // and copy it under OUT_DIR, which belongs to this target alone, so a
    // `swift build` for the other architecture cannot replace it midway.
    let lib = format!("lib{LIB_NAME}.a");
    let per_triple = package.join(".build").join(&triple).join("release").join(&lib);
    let built = if per_triple.is_file() {
        per_triple
    } else {
        let bin_path = output(
            Command::new("swift")
                .args(swift_args)
                .arg(&package)
                .args(["--triple", &triple, "--show-bin-path"]),
        );
        PathBuf::from(bin_path).join(&lib)
    };
    let lib_dir = out_dir.join("swift-lib");
    std::fs::create_dir_all(&lib_dir).expect("create the swift-lib directory");
    std::fs::copy(&built, lib_dir.join(&lib))
        .unwrap_or_else(|e| panic!("copy {} into {}: {e}", built.display(), lib_dir.display()));

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static={LIB_NAME}");

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
    let compat_dir = out_dir.join("swift-compat");
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
