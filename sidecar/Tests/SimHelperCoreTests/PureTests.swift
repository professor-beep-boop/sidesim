import XCTest
@testable import SimHelperCore

final class PureTests: XCTestCase {
	// MARK: deriveStride

	func testStrideFullRes() {
		// iPhone 17 Pro: 1206×2622 arrives as 4864-byte rows × 2624 rows.
		XCTAssertEqual(deriveStride(frameByteCount: 4864 * 2624, width: 1206, height: 2622), 4864)
	}

	func testStrideHalfRes() {
		// Half scale: 603×1311 @ 2432-byte rows × 1311 rows.
		XCTAssertEqual(deriveStride(frameByteCount: 2432 * 1311, width: 603, height: 1311), 2432)
	}

	func testStrideUnpadded() {
		// Exactly width*4 rows, no padding.
		XCTAssertEqual(deriveStride(frameByteCount: 400 * 4 * 800, width: 400, height: 800), 1600)
	}

	func testStrideRejectsMismatch() {
		// No padded height in [h, h+64] divides the frame into a plausible stride.
		XCTAssertNil(deriveStride(frameByteCount: 0, width: 100, height: 100))
		XCTAssertNil(deriveStride(frameByteCount: 12345, width: 100, height: 100))
		XCTAssertNil(deriveStride(frameByteCount: 100, width: 100, height: 100))
	}

	// MARK: secondContactXOffset

	func testContactOffset320() {
		// 320-byte message: 32 header + 2×144; second xRatio at 32+144+28 = 204.
		XCTAssertEqual(secondContactXOffset(messageByteCount: 320), 204)
	}

	func testContactOffsetRejectsSmallOrOdd() {
		XCTAssertNil(secondContactXOffset(messageByteCount: 100))
		XCTAssertNil(secondContactXOffset(messageByteCount: 319)) // (319-32) is odd
	}

	// MARK: hidUsage

	func testHidLetters() {
		XCTAssertEqual(hidUsage(for: "a")?.code, 4)
		XCTAssertEqual(hidUsage(for: "a")?.shift, false)
		XCTAssertEqual(hidUsage(for: "z")?.code, 29)
		let A = hidUsage(for: "A")
		XCTAssertEqual(A?.code, 4)
		XCTAssertEqual(A?.shift, true)
	}

	func testHidDigits() {
		XCTAssertEqual(hidUsage(for: "1")?.code, 30)
		XCTAssertEqual(hidUsage(for: "9")?.code, 38)
		XCTAssertEqual(hidUsage(for: "0")?.code, 39)
	}

	func testHidSymbolsAndWhitespace() {
		XCTAssertEqual(hidUsage(for: " ")?.code, 44)
		XCTAssertEqual(hidUsage(for: "\n")?.code, 40)
		let bang = hidUsage(for: "!")
		XCTAssertEqual(bang?.code, 30) // shift+1
		XCTAssertEqual(bang?.shift, true)
		XCTAssertEqual(hidUsage(for: "?")?.shift, true)
	}

	func testHidRejectsNonAscii() {
		XCTAssertNil(hidUsage(for: "é"))
		XCTAssertNil(hidUsage(for: "🙂"))
	}
}
