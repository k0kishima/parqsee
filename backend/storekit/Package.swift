// swift-tools-version: 5.9
// The StoreKit 2 bridge linked into the Rust binary when the `app-store`
// Cargo feature is on; `backend/build.rs` runs `swift build` and links the
// static library. Tools version 5.9 keeps the Swift 5 language mode: the
// bridge hands raw C pointers across threads on purpose, which Swift 6's
// strict concurrency checking would refuse.
import PackageDescription

let package = Package(
    name: "ParqseeStoreKit",
    // StoreKit 2 (`Product`, `Transaction.currentEntitlements`, `AppStore.sync`).
    platforms: [.macOS(.v12)],
    products: [
        .library(name: "ParqseeStoreKit", type: .static, targets: ["ParqseeStoreKit"])
    ],
    targets: [
        .target(name: "ParqseeStoreKit", path: "Sources/ParqseeStoreKit")
    ]
)
