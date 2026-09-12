@testable import ParqseeStoreKit
import Foundation
import XCTest

private final class Reply {
    var calls = 0
    var json: String?
    var error: String?
}

private let capture: SKCallback = { ctx, json, error in
    let reply = Unmanaged<Reply>.fromOpaque(ctx!).takeUnretainedValue()
    reply.calls += 1
    reply.json = json.map { String(cString: $0) }
    reply.error = error.map { String(cString: $0) }
}

final class DeliveryTests: XCTestCase {
    func testDeliversSuccessPayloadsExactlyOnce() {
        for (payload, expected) in [
            ([String: Any]() as Any, "{}"),
            ([[String: Any]]() as Any, "[]"),
            (["outcome": "purchased"] as Any, #"{"outcome":"purchased"}"#),
        ] {
            let reply = Reply()
            deliver(Unmanaged.passUnretained(reply).toOpaque(), capture, json: payload)
            XCTAssertEqual(reply.calls, 1)
            XCTAssertEqual(reply.json, expected)
            XCTAssertNil(reply.error)
        }
    }

    func testDeliversEncodingFailureExactlyOnce() {
        let reply = Reply()
        deliver(Unmanaged.passUnretained(reply).toOpaque(), capture, json: NSNull())
        XCTAssertEqual(reply.calls, 1)
        XCTAssertNil(reply.json)
        XCTAssertTrue(reply.error?.contains("not a JSON array or object") == true)
    }

    func testDeliversAnExplicitErrorExactlyOnce() {
        let reply = Reply()
        deliver(Unmanaged.passUnretained(reply).toOpaque(), capture, error: "store unavailable")
        XCTAssertEqual(reply.calls, 1)
        XCTAssertNil(reply.json)
        XCTAssertEqual(reply.error, "store unavailable")
    }
}
