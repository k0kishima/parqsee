// Run with `swift test --package-path backend/storekit`.

@testable import ParqseeStoreKit
import XCTest

final class EncodeJSONTests: XCTestCase {
    /// The shapes the entry points answer with: a list of entitlements or
    /// products, the purchase outcome, and the empty object `sk_restore`
    /// hands back for want of anything to say.
    func testEncodesTheShapesTheBridgeAnswersWith() {
        XCTAssertEqual(encodeJSON([String: Any]()), .json("{}"))
        XCTAssertEqual(encodeJSON([[String: Any]]()), .json("[]"))
        XCTAssertEqual(encodeJSON(["outcome": "purchased"]), .json(#"{"outcome":"purchased"}"#))
        XCTAssertEqual(
            encodeJSON([["product_id": "parqsee.full"]]),
            .json(#"[{"product_id":"parqsee.full"}]"#)
        )
    }

    /// `NSNull` is what `sk_restore` used to answer, and `JSONSerialization`
    /// raises an Objective-C exception on it rather than throwing: pressing
    /// Restore Purchases aborted the app. Only XCTest catches that exception
    /// and reports it as a failure — in the app it is the end of the
    /// process, so the shape has to be refused before it is encoded.
    func testRefusesATopLevelValueThatIsNotAnArrayOrObject() {
        for value in [NSNull(), "text", 42] as [Any] {
            guard case .refused(let message) = encodeJSON(value) else {
                return XCTFail("\(type(of: value)) was encoded instead of refused")
            }
            XCTAssertTrue(message.contains("not a JSON array or object"), message)
        }
    }

    /// The other refusal `deliver` turns into an error string: a value
    /// `JSONSerialization` accepts by type but cannot write.
    func testRefusesAValueItCannotWrite() {
        guard case .refused(let message) = encodeJSON([Double.nan]) else {
            return XCTFail("NaN was encoded instead of refused")
        }
        XCTAssertFalse(message.isEmpty)
    }
}
