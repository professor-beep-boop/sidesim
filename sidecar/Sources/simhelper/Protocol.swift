import Foundation

/// stdout multiplexing: JSON-RPC replies are UTF-8 lines; video frames are
/// binary: [0x00][u32be streamId][u32be length][payload]. A JSON line never
/// begins with 0x00, so the reader demuxes on the first byte.
final class StdoutWriter {
	static let shared = StdoutWriter()
	private let queue = DispatchQueue(label: "simhelper.stdout")
	/// Set once the pipe breaks (parent died); all further writes are dropped —
	/// FileHandle would raise an uncatchable ObjC exception here, so raw
	/// POSIX writes with SIGPIPE ignored.
	private var broken = false

	init() {
		signal(SIGPIPE, SIG_IGN)
	}

	private func writeAll(_ data: Data) {
		if broken {
			return
		}
		data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
			guard let base = buf.baseAddress else { return }
			var off = 0
			while off < buf.count {
				let n = write(1, base + off, buf.count - off)
				if n > 0 {
					off += n
				} else if errno == EINTR {
					continue
				} else {
					broken = true
					return
				}
			}
		}
	}

	func sendLine(_ obj: [String: Any]) {
		let data = (try? JSONSerialization.data(withJSONObject: obj))
			?? Data("{\"error\":\"unserializable reply\"}".utf8)
		queue.sync {
			writeAll(data)
			writeAll(Data([0x0a]))
		}
	}

	func sendResult(id: Int, _ result: Any) {
		sendLine(["id": id, "result": result])
	}

	func sendError(id: Int, _ message: String) {
		sendLine(["id": id, "error": message])
	}

	/// Out-of-band event (no id), e.g. stream end notifications.
	func sendEvent(_ event: String, _ payload: [String: Any]) {
		var obj = payload
		obj["event"] = event
		sendLine(obj)
	}

	func sendFrame(streamId: UInt32, payload: Data) {
		var header = Data(capacity: 9)
		header.append(0x00)
		var sid = streamId.bigEndian
		var len = UInt32(payload.count).bigEndian
		withUnsafeBytes(of: &sid) { header.append(contentsOf: $0) }
		withUnsafeBytes(of: &len) { header.append(contentsOf: $0) }
		queue.sync {
			writeAll(header)
			writeAll(payload)
		}
	}
}

struct RequestError: Error, CustomStringConvertible {
	let description: String
	init(_ message: String) { description = message }
}

struct Request {
	let id: Int
	let method: String
	let params: [String: Any]

	static func parse(_ line: Data) throws -> Request {
		guard let obj = try JSONSerialization.jsonObject(with: line) as? [String: Any],
			let id = obj["id"] as? Int,
			let method = obj["method"] as? String
		else {
			throw RequestError("malformed request")
		}
		return Request(id: id, method: method, params: obj["params"] as? [String: Any] ?? [:])
	}

	func string(_ key: String) throws -> String {
		guard let v = params[key] as? String else { throw RequestError("missing param \(key)") }
		return v
	}

	func double(_ key: String) throws -> Double {
		guard let v = params[key] as? NSNumber else { throw RequestError("missing param \(key)") }
		return v.doubleValue
	}

	func doubleOr(_ key: String, _ fallback: Double) -> Double {
		(params[key] as? NSNumber)?.doubleValue ?? fallback
	}

	func intOr(_ key: String, _ fallback: Int) -> Int {
		(params[key] as? NSNumber)?.intValue ?? fallback
	}

	func stringOr(_ key: String, _ fallback: String) -> String {
		(params[key] as? String) ?? fallback
	}
}
