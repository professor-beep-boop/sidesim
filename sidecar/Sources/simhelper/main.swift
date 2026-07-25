import Foundation
import CoreGraphics
import SimHelperCore
import FBControlCore
import FBSimulatorControl

/// simhelper — native simulator sidecar speaking JSON-RPC over stdio.
/// See ../../README.md for the protocol.

let workQueue = DispatchQueue(label: "simhelper.work")
let videoQueue = DispatchQueue(label: "simhelper.video")

/// Per-stream state. Owned exclusively by videoQueue after creation: the
/// consumer closure captures this (never the session), so trailing frames from
/// a replaced/stopped stream can neither resurrect an encoder nor feed a
/// wrong-sized one.
final class VideoContext {
	let streamId: UInt32
	let width: Int
	let height: Int
	let fps: Int
	let bitrate: Int
	let encoding: String
	let udid: String
	var encoder: H264Encoder?
	var stopped = false
	var expectedBytes = 0
	var strideErrorReported = false

	init(streamId: UInt32, width: Int, height: Int, fps: Int, bitrate: Int, encoding: String, udid: String) {
		self.streamId = streamId
		self.width = width
		self.height = height
		self.fps = fps
		self.bitrate = bitrate
		self.encoding = encoding
		self.udid = udid
	}

	/// videoQueue only.
	func consume(_ data: Data) {
		guard !stopped, data.count > 0 else {
			return
		}
		if encoding == "bgra" {
			StdoutWriter.shared.sendFrame(streamId: streamId, payload: data)
			return
		}
		// Size (or re-size, e.g. on rotation) the encoder from the frame length;
		// rows are stride-padded by the framebuffer.
		if encoder != nil && data.count != expectedBytes {
			encoder?.stop()
			encoder = nil
		}
		if encoder == nil {
			// The framebuffer pads rows AND row count (e.g. 1206x2622 arrives as
			// 4864-byte rows x 2624). deriveStride handles the search.
			guard let stride = deriveStride(frameByteCount: data.count, width: width, height: height) else {
				// Report once, but keep the context alive: rotation produces
				// frames we can't size against the start dimensions, and rotating
				// back must recover.
				if !strideErrorReported {
					strideErrorReported = true
					StdoutWriter.shared.sendEvent("videoError", ["udid": udid, "message": "cannot derive stride for \(data.count)-byte frame at \(width)x\(height)"])
				}
				return
			}
			strideErrorReported = false
			expectedBytes = data.count
			encoder = try? H264Encoder(width: width, height: height, stride: stride, fps: Int32(fps), bitrate: bitrate) { [streamId] annexB in
				StdoutWriter.shared.sendFrame(streamId: streamId, payload: annexB)
			}
			if encoder == nil {
				StdoutWriter.shared.sendEvent("videoError", ["udid": udid, "message": "encoder init failed"])
				return
			}
		}
		encoder?.encode(data)
	}

	/// videoQueue only.
	func stop() {
		stopped = true
		encoder?.stop()
		encoder = nil
	}
}

final class SimSession {
	let simulator: FBSimulator
	var hid: FBSimulatorHID?
	/// The framebuffer stream is created ONCE per session and kept running
	/// until detach: FBSimulator caches the stream object, and a stopped
	/// stream cannot be restarted (observed: second start yields no frames).
	/// Restarts swap `video` instead — a fresh context/encoder re-emits
	/// SPS/PPS + IDR immediately.
	var stream: FBVideoStream?
	var streamScale: Double?
	var streamFps: Int?
	/// Current sink for frames; read/written only on videoQueue.
	var video: VideoContext?
	var indigo: FBSimulatorIndigoHID?
	/// Set while a touch is down so an interrupted session can release it.
	var pendingTouch: (x: Double, y: Double)?
	/// Set while a two-finger gesture is down, for release on interruption.
	var pendingTouch2: (ax: Double, ay: Double, bx: Double, by: Double)?

	init(simulator: FBSimulator) {
		self.simulator = simulator
	}

	/// Stop delivering frames (keeps the underlying framebuffer stream alive).
	func stopVideo() {
		videoQueue.sync {
			video?.stop()
			video = nil
		}
	}

	func connectHID() throws -> FBSimulatorHID {
		if let hid {
			return hid
		}
		guard let connected: FBSimulatorHID = try waitFor(FBSimulatorHID.hid(for: simulator)) else {
			throw RequestError("could not create HID for \(simulator.udid)")
		}
		try waitFor(connected.connect())
		hid = connected
		return connected
	}

	/// Builds raw Indigo touch messages. The public FBSimulatorHID API is
	/// single-contact; two-finger gestures require patching a second contact
	/// into the raw message and sending it directly.
	func indigoBuilder() throws -> FBSimulatorIndigoHID {
		if let indigo {
			return indigo
		}
		let i = try FBSimulatorIndigoHID.simulatorKitHID()
		indigo = i
		return i
	}

	/// Send one two-finger phase. The single-touch Indigo message already
	/// carries two contact records at the same point; we overwrite the second
	/// record's coordinates so iOS sees two distinct fingers. Sent raw via the
	/// private `sendIndigoMessageData:` since the public API has no multi-touch.
	func sendTwoFinger(phase: String, ax: Double, ay: Double, bx: Double, by: Double) throws {
		let hid = try connectHID()
		let indigo = try indigoBuilder()
		guard let screen = simulator.screenInfo, screen.scale > 0 else {
			throw RequestError("no screen info")
		}
		// Coordinates arrive in points; scale to pixels. The Indigo message is
		// built at the pixel-sized surface (matching what the framework itself
		// uses) — a points-sized surface breaks multi-touch interpretation.
		let scale = Double(screen.scale)
		let size = CGSize(width: Double(screen.widthPixels), height: Double(screen.heightPixels))
		let axp = ax * scale, ayp = ay * scale, bxp = bx * scale, byp = by * scale
		let direction: FBSimulatorHIDDirection = phase == "up" ? .up : .down
		var msg = indigo.touchScreenSize(size, direction: direction, x: axp, y: ayp)
		patchSecondContact(&msg, nax: axp / size.width, nbx: bxp / size.width, nby: byp / size.height)
		_ = hid.perform(Selector(("sendIndigoMessageData:")), with: msg)
	}

	/// Overwrite the second contact's (x, y) doubles. The message is a 32-byte
	/// header + two equal-sized contact payloads; the builder wrote finger A into
	/// both, with each payload's xRatio at payload-offset 28 and yRatio at 36.
	/// We compute the second payload's offset directly (a value-scan would
	/// mis-hit zero-valued header fields when finger A sits at the left edge,
	/// nax≈0) and guard on the pre-patch value to catch any format drift.
	private func patchSecondContact(_ msg: inout Data, nax: Double, nbx: Double, nby: Double) {
		guard let xOff = secondContactXOffset(messageByteCount: msg.count) else { return }
		msg.withUnsafeMutableBytes { raw in
			guard let base = raw.baseAddress else { return }
			var cur = 0.0
			memcpy(&cur, base.advanced(by: xOff), 8)
			// Finger A was written into both contacts, so contact two's x must
			// currently equal finger A's normalized x — otherwise the layout
			// shifted and blind patching would corrupt the message.
			guard abs(cur - nax) < 1e-9 else { return }
			var x = nbx, y = nby
			memcpy(base.advanced(by: xOff), &x, 8)
			memcpy(base.advanced(by: xOff + 8), &y, 8)
		}
	}

	func teardown() {
		if let touch = pendingTouch, let hid {
			pendingTouch = nil
			_ = try? waitFor(hid.sendTouch(withType: .up, x: touch.x, y: touch.y), timeout: 5)
		}
		if let t2 = pendingTouch2 {
			pendingTouch2 = nil
			try? sendTwoFinger(phase: "up", ax: t2.ax, ay: t2.ay, bx: t2.bx, by: t2.by)
		}
		stopVideo()
		if let stream {
			_ = try? waitFor(stream.stopStreaming(), timeout: 5)
		}
		stream = nil
		hid?.disconnect()
		hid = nil
	}
}

final class Sidecar {
	private let control: FBSimulatorControl
	private var sessions: [String: SimSession] = [:]

	init() throws {
		// Load Xcode's private frameworks (CoreSimulator, SimulatorKit) before
		// touching anything — HID registration asserts on SimulatorKit classes.
		try FBSimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(nil)
		try FBSimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(nil)
		let config = FBSimulatorControlConfiguration(deviceSetPath: nil, logger: nil, reporter: nil)
		self.control = try FBSimulatorControl.withConfiguration(config)
	}

	private func session(_ udid: String) throws -> SimSession {
		if let s = sessions[udid] {
			// The sim can shut down under us; don't keep serving a dead session.
			guard s.simulator.state == .booted else {
				sessions.removeValue(forKey: udid)
				s.teardown()
				throw RequestError("simulator \(udid) is no longer booted")
			}
			return s
		}
		guard let simulator = control.set.allSimulators.first(where: { $0.udid == udid }) else {
			throw RequestError("no simulator with udid \(udid)")
		}
		guard simulator.state == .booted else {
			throw RequestError("simulator \(udid) is not booted")
		}
		let s = SimSession(simulator: simulator)
		sessions[udid] = s
		return s
	}

	func handle(_ req: Request) {
		do {
			let result = try dispatch(req)
			StdoutWriter.shared.sendResult(id: req.id, result)
		} catch {
			StdoutWriter.shared.sendError(id: req.id, String(describing: error))
		}
	}

	private func dispatch(_ req: Request) throws -> Any {
		switch req.method {
		case "listDevices":
			return control.set.allSimulators
				.filter { $0.state == .booted }
				.map { [
					"udid": $0.udid,
					"name": $0.name,
					"state": FBiOSTargetStateStringFromState($0.state),
					"osVersion": $0.osVersion.name,
				] }

		case "describe":
			let s = try session(req.string("udid"))
			guard let screen = s.simulator.screenInfo else {
				throw RequestError("no screen info for \(s.simulator.udid)")
			}
			let scale = Double(screen.scale)
			guard scale > 0 else {
				throw RequestError("invalid screen scale \(scale)")
			}
			return [
				"width": Int(screen.widthPixels),
				"height": Int(screen.heightPixels),
				"density": scale,
				"widthPoints": Int(Double(screen.widthPixels) / scale),
				"heightPoints": Int(Double(screen.heightPixels) / scale),
			]

		case "startVideo":
			return try startVideo(req)

		case "stopVideo":
			try session(req.string("udid")).stopVideo()
			return ["ok": true]

		case "tap":
			let s = try session(req.string("udid"))
			let hid = try s.connectHID()
			let x = try req.double("x"), y = try req.double("y")
			try waitFor(hid.sendTouch(withType: .down, x: x, y: y))
			try waitFor(hid.sendTouch(withType: .up, x: x, y: y))
			return ["ok": true]

		case "touch":
			let s = try session(req.string("udid"))
			let hid = try s.connectHID()
			let x = try req.double("x"), y = try req.double("y")
			let phase = try req.string("phase")
			// A 'move' is a down-state event at the new point; CoreSimulator's
			// touch state machine treats it as motion of the held finger.
			let direction: FBSimulatorHIDDirection = phase == "up" ? .up : .down
			try waitFor(hid.sendTouch(withType: direction, x: x, y: y))
			s.pendingTouch = phase == "up" ? nil : (x, y)
			return ["ok": true]

		case "touch2":
			let s = try session(req.string("udid"))
			let phase = try req.string("phase")
			let ax = try req.double("ax"), ay = try req.double("ay")
			let bx = try req.double("bx"), by = try req.double("by")
			try s.sendTwoFinger(phase: phase, ax: ax, ay: ay, bx: bx, by: by)
			s.pendingTouch2 = phase == "up" ? nil : (ax, ay, bx, by)
			return ["ok": true]

		case "swipe":
			let s = try session(req.string("udid"))
			let hid = try s.connectHID()
			let x1 = try req.double("x1"), y1 = try req.double("y1")
			let x2 = try req.double("x2"), y2 = try req.double("y2")
			// Clamp: requests execute serially, so an absurd duration would wedge
			// the whole request pipeline.
			let duration = min(max(req.doubleOr("durationSec", 0.3), 0.05), 5.0)
			let steps = max(Int(duration * 60), 4)
			try waitFor(hid.sendTouch(withType: .down, x: x1, y: y1))
			for i in 1...steps {
				let t = Double(i) / Double(steps)
				try waitFor(hid.sendTouch(withType: .down, x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t))
				Thread.sleep(forTimeInterval: duration / Double(steps))
			}
			try waitFor(hid.sendTouch(withType: .up, x: x2, y: y2))
			return ["ok": true]

		case "key":
			let s = try session(req.string("udid"))
			let hid = try s.connectHID()
			let code = UInt32(try req.double("code"))
			try waitFor(hid.sendKeyboardEvent(with: .down, keyCode: code))
			try waitFor(hid.sendKeyboardEvent(with: .up, keyCode: code))
			return ["ok": true]

		case "text":
			let s = try session(req.string("udid"))
			let hid = try s.connectHID()
			// Serial pipeline: cap so one huge paste can't wedge other requests.
			try typeText(String(try req.string("value").prefix(1000)), hid: hid)
			return ["ok": true]

		case "button":
			let s = try session(req.string("udid"))
			let hid = try s.connectHID()
			let button = try hidButton(req.string("name"))
			try waitFor(hid.sendButtonEvent(with: .down, button: button))
			try waitFor(hid.sendButtonEvent(with: .up, button: button))
			return ["ok": true]

		case "detach":
			let udid = try req.string("udid")
			sessions.removeValue(forKey: udid)?.teardown()
			return ["ok": true]

		default:
			throw RequestError("unknown method \(req.method)")
		}
	}

	private func startVideo(_ req: Request) throws -> Any {
		let udid = try req.string("udid")
		let s = try session(udid)
		let streamId = UInt32(req.intOr("streamId", 0))
		let fps = req.intOr("fps", 30)
		let scale = req.doubleOr("scaleFactor", 1.0)
		let encoding = req.stringOr("encoding", "h264")
		let bitrate = req.intOr("bitrate", 6_000_000)

		// Stop delivering to any previous context.
		s.stopVideo()

		guard let screen = s.simulator.screenInfo else {
			throw RequestError("no screen info")
		}
		let width = Int((Double(screen.widthPixels) * scale).rounded())
		let height = Int((Double(screen.heightPixels) * scale).rounded())

		if s.stream != nil, s.streamScale != scale || s.streamFps != fps {
			// The cached framebuffer stream is unrestartable, so its scale/fps are
			// fixed for the session. The client keeps these constant in practice.
			throw RequestError("scale/fps change requires detach (stream is \(s.streamScale ?? 0)x/\(s.streamFps ?? 0)fps)")
		}

		let ctx = VideoContext(streamId: streamId, width: width, height: height, fps: fps, bitrate: bitrate, encoding: encoding, udid: udid)

		if s.stream == nil {
			// Always pull BGRA from the framework; encode ourselves. The
			// framework's own H.264 encoder produces an infinite GOP with
			// B-frames, which smears under motion — the reason this sidecar
			// exists.
			let config = FBVideoStreamConfiguration(
				encoding: .BGRA,
				framesPerSecond: NSNumber(value: fps),
				compressionQuality: 1.0,
				scaleFactor: NSNumber(value: scale),
				avgBitrate: nil
			)
			guard let stream: FBVideoStream = try waitFor(s.simulator.createStream(with: config)) else {
				throw RequestError("createStream returned nil")
			}
			// The consumer forwards to whatever context is current, so restarts
			// swap sinks without touching the framebuffer connection.
			let consumer = FBBlockDataConsumer.asynchronousDataConsumer(on: videoQueue) { [weak s] data in
				s?.video?.consume(data)
			}
			try waitFor(stream.startStreaming(consumer))
			s.stream = stream
			s.streamScale = scale
			s.streamFps = fps

			// Tell the client when the stream dies out from under it (sim
			// shutdown, framebuffer teardown) so a frozen mirror is
			// distinguishable from a static screen.
			stream.completed.onQueue(videoQueue, notifyOfCompletion: { [weak s] _ in
				guard let s, let current = s.video, !current.stopped else {
					return
				}
				current.stop()
				s.video = nil
				StdoutWriter.shared.sendEvent("videoEnded", ["udid": udid, "streamId": Int(current.streamId)])
			})
		}

		videoQueue.sync { s.video = ctx }
		return ["ok": true, "width": width, "height": height]
	}

	private func hidButton(_ name: String) throws -> FBSimulatorHIDButton {
		switch name {
		case "APPLE_PAY": return .applePay
		case "HOME": return .homeButton
		case "LOCK": return .lock
		case "SIDE_BUTTON": return .sideButton
		case "SIRI": return .siri
		default: throw RequestError("unknown button \(name)")
		}
	}

	func shutdown() {
		for (_, s) in sessions {
			s.teardown()
		}
		sessions.removeAll()
	}
}

// --- main loop ---

let sidecar: Sidecar
do {
	sidecar = try Sidecar()
} catch {
	FileHandle.standardError.write("simhelper: init failed: \(error)\n".data(using: .utf8)!)
	exit(1)
}

StdoutWriter.shared.sendEvent("ready", [:])

// CoreSimulator/SimulatorKit schedule work on the main queue, so the main
// thread must run the dispatch main loop; stdin is read from a background
// thread and requests execute on workQueue.
Thread.detachNewThread {
	let stdin = FileHandle.standardInput
	var buffer = Data()
	while true {
		let chunk = stdin.availableData
		if chunk.isEmpty {
			break // EOF: parent went away
		}
		buffer.append(chunk)
		while let nl = buffer.firstIndex(of: 0x0a) {
			let line = buffer.subdata(in: buffer.startIndex..<nl)
			buffer.removeSubrange(buffer.startIndex...nl)
			guard !line.isEmpty else { continue }
			do {
				let req = try Request.parse(line)
				workQueue.sync { sidecar.handle(req) }
			} catch {
				// Reply if an id is recoverable so the client's request doesn't
				// hang forever; otherwise emit a protocol-level event.
				let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
				if let id = (obj?["id"] as? NSNumber)?.intValue {
					StdoutWriter.shared.sendError(id: id, "malformed request: \(error)")
				} else {
					StdoutWriter.shared.sendEvent("protocolError", ["message": "unparseable request line"])
				}
			}
		}
	}
	workQueue.sync { sidecar.shutdown() }
	exit(0)
}

dispatchMain()
