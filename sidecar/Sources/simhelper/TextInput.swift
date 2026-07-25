import Foundation
import SimHelperCore
import FBSimulatorControl

/// USB HID keyboard usage codes (page 0x07) for ASCII, with shift handling.
/// CoreSimulator's Indigo keyboard events take these usages.
private let SHIFT: UInt32 = 0xE1 // Left Shift usage

func typeText(_ text: String, hid: FBSimulatorHID) throws {
	for ch in text {
		guard let (code, shift) = hidUsage(for: ch) else {
			continue // non-ASCII: skip rather than guess
		}
		if shift {
			try waitFor(hid.sendKeyboardEvent(with: .down, keyCode: SHIFT))
		}
		try waitFor(hid.sendKeyboardEvent(with: .down, keyCode: code))
		try waitFor(hid.sendKeyboardEvent(with: .up, keyCode: code))
		if shift {
			try waitFor(hid.sendKeyboardEvent(with: .up, keyCode: SHIFT))
		}
		// Small settle so the OS keyboard pipeline keeps up with bursts.
		Thread.sleep(forTimeInterval: 0.02)
	}
}
