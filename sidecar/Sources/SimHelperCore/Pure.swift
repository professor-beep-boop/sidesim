import Foundation

/// Pure, framework-free logic shared by the executable and unit tests.
/// Nothing here links FBSimulatorControl, so it builds and tests anywhere a
/// Swift toolchain is available.

/// Derive the stride-padded row length (bytes) of a raw BGRA framebuffer frame.
///
/// The simulator pads both the row length AND the row count (e.g. a 1206×2622
/// screen arrives as 4864-byte rows × 2624 rows). We know the visible
/// width/height; search plausible padded heights for a stride that divides the
/// frame and lies just above `width*4`. Returns nil if none fits (e.g. a
/// rotation-sized frame that doesn't match these dimensions).
public func deriveStride(frameByteCount: Int, width: Int, height: Int) -> Int? {
	guard width > 0, height > 0, frameByteCount > 0 else {
		return nil
	}
	for paddedHeight in height...(height + 64) where frameByteCount % paddedHeight == 0 {
		let stride = frameByteCount / paddedHeight
		if stride % 4 == 0 && stride >= width * 4 && stride < width * 4 + 256 {
			return stride
		}
	}
	return nil
}

/// Byte offset of the second touch contact's xRatio double within a raw Indigo
/// touch message. The message is a 32-byte header + two equal-sized contact
/// payloads; each payload's xRatio sits at payload-offset 28 (yRatio at +8).
/// Returns nil if the message is too small or oddly sized to be this layout.
public func secondContactXOffset(messageByteCount count: Int) -> Int? {
	guard count >= 320, (count - 32) % 2 == 0 else {
		return nil
	}
	let payloadSize = (count - 32) / 2
	let xOff = 32 + payloadSize + 28
	guard xOff + 16 <= count else {
		return nil
	}
	return xOff
}

/// USB HID keyboard usage code (page 0x07) and shift state for an ASCII
/// character, or nil for anything non-ASCII / unmapped.
public func hidUsage(for ch: Character) -> (code: UInt32, shift: Bool)? {
	guard let ascii = ch.asciiValue else {
		return nil
	}
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
