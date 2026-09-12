// The C surface of the StoreKit 2 bridge, called from
// `backend/src/services/store/storekit.rs`.
//
// Every entry point is asynchronous: it returns at once and later calls
// `callback(ctx, json, error)` exactly once, from a thread of Swift's
// cooperative pool — never the main thread and never the caller's. Exactly
// one of `json` / `error` is non-null, and both point at memory that is only
// valid for the duration of the callback: the Rust side copies them before
// returning. `ctx` is passed back untouched; the caller owns it.
//
// `sk_start_updates` is the exception: its callback fires once per
// transaction update for the rest of the process, each time with the full
// current entitlements, so the caller never has to ask for them again.
//
// StoreKit 2 verifies transactions itself (JWS); an unverified one is
// reported as an error and never counted.

import Foundation
import StoreKit

public typealias SKCallback = @convention(c) (
    UnsafeMutableRawPointer?, UnsafePointer<CChar>?, UnsafePointer<CChar>?
) -> Void

// MARK: - Result delivery

/// Encode one callback payload, or say why it could not be encoded.
///
/// The shape is checked before `JSONSerialization` sees it, because a
/// top-level value that is not an array or a dictionary — `NSNull`, a
/// number, a string — makes `dataWithJSONObject:` *raise*
/// `NSInvalidArgumentException` rather than throw, and an Objective-C
/// exception crossing Swift aborts the process: no `catch` here can see it.
/// A bridge answering with the wrong shape is a bug, but it must surface as
/// an error like any other, never as a crash. (`sk_restore` answered `null`
/// and took the whole app down with it.)
///
/// Not `private`: `ParqseeStoreKitTests` covers this directly, since the
/// entry points only reach it when a real App Store answers them.
func encodeJSON(_ value: Any) -> Encoded {
    guard JSONSerialization.isValidJSONObject(value) else {
        return .refused("the result is not a JSON array or object: \(type(of: value))")
    }
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        guard let text = String(data: data, encoding: .utf8) else {
            return .refused("the result was not valid UTF-8")
        }
        return .json(text)
    } catch {
        return .refused("could not encode the result: \(error.localizedDescription)")
    }
}

/// What `encodeJSON` made of a payload: the JSON text, or the error string
/// the callback receives in its place.
enum Encoded: Equatable {
    case json(String)
    case refused(String)
}

private func deliver(_ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback, json: Any) {
    switch encodeJSON(json) {
    case .json(let text):
        text.withCString { cb(ctx, $0, nil) }
    case .refused(let message):
        deliver(ctx, cb, error: message)
    }
}

private func deliver(_ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback, error: String) {
    error.withCString { cb(ctx, nil, $0) }
}

private func describe(_ error: Error) -> String {
    if let e = error as? StoreKitError {
        switch e {
        case .networkError(let inner):
            return "network error: \(inner.localizedDescription)"
        case .userCancelled:
            return "cancelled"
        case .notAvailableInStorefront:
            return "not available in this storefront"
        case .notEntitled:
            return "not entitled"
        default:
            return "StoreKit error: \(e.localizedDescription)"
        }
    }
    return error.localizedDescription
}

// MARK: - Entitlements

/// Milliseconds since the Unix epoch, the unit the Rust side and the
/// webview agree on.
private func millis(_ date: Date) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1000).rounded())
}

private func entitlementRecord(_ tx: Transaction) -> [String: Any] {
    [
        "product_id": tx.productID,
        "original_purchase_date": millis(tx.originalPurchaseDate),
        "purchase_date": millis(tx.purchaseDate),
    ]
}

/// The verified, unrevoked transactions the account currently holds.
/// `Transaction.currentEntitlements` already excludes revoked (refunded)
/// ones; unverified ones are skipped rather than trusted.
private func currentEntitlements() async -> [[String: Any]] {
    var out: [[String: Any]] = []
    for await result in Transaction.currentEntitlements {
        if case .verified(let tx) = result {
            out.append(entitlementRecord(tx))
        }
    }
    return out
}

// MARK: - C entry points

/// `ids` is a JSON array of product identifiers. The result is a JSON array
/// of `{id, display_name, description, display_price}`; a product the store
/// does not know is simply absent from it.
@_cdecl("sk_load_products")
public func sk_load_products(
    _ ids: UnsafePointer<CChar>, _ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback
) {
    let raw = String(cString: ids)
    let sendableCtx = SendablePointer(ctx)
    Task.detached {
        guard let data = raw.data(using: .utf8),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [String]
        else {
            deliver(sendableCtx.pointer, cb, error: "product ids must be a JSON array of strings")
            return
        }
        do {
            let products = try await Product.products(for: list)
            let json: [[String: Any]] = products.map { p in
                [
                    "id": p.id,
                    "display_name": p.displayName,
                    "description": p.description,
                    "display_price": p.displayPrice,
                ]
            }
            deliver(sendableCtx.pointer, cb, json: json)
        } catch {
            deliver(sendableCtx.pointer, cb, error: describe(error))
        }
    }
}

/// Buys `id`. The result is `{"outcome": "purchased" | "cancelled" | "pending"}`;
/// a verified purchase is finished before the callback fires so the
/// entitlement is visible to `sk_entitlements` right away.
@_cdecl("sk_purchase")
public func sk_purchase(
    _ id: UnsafePointer<CChar>, _ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback
) {
    let productId = String(cString: id)
    let sendableCtx = SendablePointer(ctx)
    Task.detached {
        do {
            let products = try await Product.products(for: [productId])
            guard let product = products.first else {
                deliver(sendableCtx.pointer, cb, error: "the store has no product \(productId)")
                return
            }
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let tx):
                    await tx.finish()
                    deliver(sendableCtx.pointer, cb, json: ["outcome": "purchased"])
                case .unverified(_, let error):
                    deliver(sendableCtx.pointer, cb, error: "the purchase could not be verified: \(error.localizedDescription)")
                }
            case .userCancelled:
                deliver(sendableCtx.pointer, cb, json: ["outcome": "cancelled"])
            case .pending:
                deliver(sendableCtx.pointer, cb, json: ["outcome": "pending"])
            @unknown default:
                deliver(sendableCtx.pointer, cb, error: "the purchase ended in an unknown state")
            }
        } catch {
            deliver(sendableCtx.pointer, cb, error: describe(error))
        }
    }
}

/// Asks the App Store for the account's transactions again (Restore
/// Purchases). Result: an empty object, which the caller discards — the
/// entitlements are read separately. It must not be `null` — see
/// `encodeJSON` for what that cost.
@_cdecl("sk_restore")
public func sk_restore(_ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback) {
    let sendableCtx = SendablePointer(ctx)
    Task.detached {
        do {
            try await AppStore.sync()
            deliver(sendableCtx.pointer, cb, json: [String: Any]())
        } catch {
            deliver(sendableCtx.pointer, cb, error: describe(error))
        }
    }
}

/// Result: a JSON array of `{product_id, original_purchase_date, purchase_date}`
/// (dates in Unix milliseconds) for every product the account owns.
@_cdecl("sk_entitlements")
public func sk_entitlements(_ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback) {
    let sendableCtx = SendablePointer(ctx)
    Task.detached {
        let list = await currentEntitlements()
        deliver(sendableCtx.pointer, cb, json: list)
    }
}

/// Listens to `Transaction.updates` for the rest of the process: a purchase
/// completed elsewhere (another device, a pending approval, a refund)
/// arrives here. Each verified transaction is finished and the callback
/// receives the full current entitlements in the `sk_entitlements` format.
/// `ctx` must stay valid for the lifetime of the process.
@_cdecl("sk_start_updates")
public func sk_start_updates(_ ctx: UnsafeMutableRawPointer?, _ cb: SKCallback) {
    let sendableCtx = SendablePointer(ctx)
    Task.detached {
        for await result in Transaction.updates {
            if case .verified(let tx) = result {
                await tx.finish()
            }
            let list = await currentEntitlements()
            deliver(sendableCtx.pointer, cb, json: list)
        }
    }
}

/// A raw pointer that may cross into a detached task. The Rust side owns
/// what it points at and guarantees it outlives the callback.
private struct SendablePointer: @unchecked Sendable {
    let pointer: UnsafeMutableRawPointer?
    init(_ pointer: UnsafeMutableRawPointer?) { self.pointer = pointer }
}
