import Foundation
import FBSimulatorControl

/// USB HID keyboard usage codes (page 0x07) for ASCII, with shift handling.
/// CoreSimulator's Indigo keyboard events take these usages.
private let SHIFT: UInt32 = 0xE1 // Left Shift usage

private func usage(for ch: Character) -> (code: UInt32, shift: Bool)? {
	if let ascii = ch.asciiValue {
		switch ascii {
		case 0x61...0x7a: // a-z
			return (UInt32(ascii - 0x61) + 4, false)
		case 0x41...0x5a: // A-Z
			return (UInt32(ascii - 0x41) + 4, true)
		case 0x31...0x39: // 1-9
			return (UInt32(ascii - 0x31) + 30, false)
		case 0x30: return (39, false) // 0
		default: break
		}
		switch Character(UnicodeScalar(ascii)) {
		case "\n": return (40, false)
		case "\t": return (43, false)
		case " ": return (44, false)
		case "-": return (45, false)
		case "=": return (46, false)
		case "[": return (47, false)
		case "]": return (48, false)
		case "\\": return (49, false)
		case ";": return (51, false)
		case "'": return (52, false)
		case "`": return (53, false)
		case ",": return (54, false)
		case ".": return (55, false)
		case "/": return (56, false)
		case "!": return (30, true)
		case "@": return (31, true)
		case "#": return (32, true)
		case "$": return (33, true)
		case "%": return (34, true)
		case "^": return (35, true)
		case "&": return (36, true)
		case "*": return (37, true)
		case "(": return (38, true)
		case ")": return (39, true)
		case "_": return (45, true)
		case "+": return (46, true)
		case "{": return (47, true)
		case "}": return (48, true)
		case "|": return (49, true)
		case ":": return (51, true)
		case "\"": return (52, true)
		case "~": return (53, true)
		case "<": return (54, true)
		case ">": return (55, true)
		case "?": return (56, true)
		default: return nil
		}
	}
	return nil
}

func typeText(_ text: String, hid: FBSimulatorHID) throws {
	for ch in text {
		guard let (code, shift) = usage(for: ch) else {
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
