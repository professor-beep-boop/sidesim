import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

/// Hardware H.264 encoder tuned for live mirroring of an infinite screen
/// stream: no B-frames (decode order == display order, so a dropped frame can
/// only skip, never smear) and periodic keyframes so any glitch heals within a
/// couple of seconds. This is the piece idb's own stream encoder lacks.
final class H264Encoder {
	private var session: VTCompressionSession?
	private let width: Int
	private let height: Int
	private let stride: Int
	private var frameIndex: Int64 = 0
	private let fps: Int32
	private let onAnnexB: (Data) -> Void

	init(width: Int, height: Int, stride: Int, fps: Int32, bitrate: Int, onAnnexB: @escaping (Data) -> Void) throws {
		self.width = width
		self.height = height
		self.stride = stride
		self.fps = fps
		self.onAnnexB = onAnnexB

		var s: VTCompressionSession?
		let status = VTCompressionSessionCreate(
			allocator: nil,
			width: Int32(width),
			height: Int32(height),
			codecType: kCMVideoCodecType_H264,
			encoderSpecification: nil,
			imageBufferAttributes: nil,
			compressedDataAllocator: nil,
			outputCallback: nil,
			refcon: nil,
			compressionSessionOut: &s
		)
		guard status == noErr, let session = s else {
			throw RequestError("VTCompressionSessionCreate failed: \(status)")
		}
		self.session = session

		let props: [(CFString, CFTypeRef)] = [
			(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue),
			(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
			// No B-frames: the whole point of this encoder.
			(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse),
			// A keyframe at least every 2 seconds so decode errors self-heal.
			(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 2)),
			(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: 2.0)),
			(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
			(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
		]
		for (key, value) in props {
			VTSessionSetProperty(session, key: key, value: value)
		}
		VTCompressionSessionPrepareToEncodeFrames(session)
	}

	/// Encode one stride-padded BGRA frame.
	func encode(_ frame: Data) {
		guard let session, frame.count >= stride * height else { return }
		var pixelBuffer: CVPixelBuffer?
		// Copy into a CVPixelBuffer the encoder can retain safely.
		let status = CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, [
			kCVPixelBufferBytesPerRowAlignmentKey: stride,
		] as CFDictionary, &pixelBuffer)
		guard status == kCVReturnSuccess, let pb = pixelBuffer else { return }

		CVPixelBufferLockBaseAddress(pb, [])
		let dstStride = CVPixelBufferGetBytesPerRow(pb)
		if let base = CVPixelBufferGetBaseAddress(pb) {
			frame.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
				guard let srcBase = src.baseAddress else { return }
				if dstStride == stride {
					memcpy(base, srcBase, min(frame.count, dstStride * height))
				} else {
					let rowBytes = min(stride, dstStride)
					for y in 0..<height {
						memcpy(base + y * dstStride, srcBase + y * stride, rowBytes)
					}
				}
			}
		}
		CVPixelBufferUnlockBaseAddress(pb, [])

		let pts = CMTime(value: frameIndex, timescale: fps)
		frameIndex += 1
		VTCompressionSessionEncodeFrame(
			session, imageBuffer: pb,
			presentationTimeStamp: pts, duration: CMTime(value: 1, timescale: fps),
			frameProperties: nil, infoFlagsOut: nil
		) { [weak self] status, _, sampleBuffer in
			guard let self, status == noErr, let sb = sampleBuffer else { return }
			if let annexB = Self.annexB(from: sb) {
				self.onAnnexB(annexB)
			}
		}
	}

	func stop() {
		if let session {
			VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
			VTCompressionSessionInvalidate(session)
		}
		session = nil
	}

	/// AVCC (length-prefixed) sample buffer → Annex-B, SPS/PPS before keyframes.
	private static func annexB(from sampleBuffer: CMSampleBuffer) -> Data? {
		guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
		var out = Data()
		let startCode = Data([0, 0, 0, 1])

		let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
		var isKey = true
		if let attachments = attachments as? [[CFString: Any]], let first = attachments.first {
			isKey = !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
		}

		if isKey, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
			var count = 0
			CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
			for i in 0..<count {
				var ptr: UnsafePointer<UInt8>?
				var size = 0
				if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &ptr, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr {
					out.append(startCode)
					out.append(UnsafeBufferPointer(start: ptr, count: size))
				}
			}
		}

		var totalLength = 0
		var lengthAtOffset = 0
		var dataPointer: UnsafeMutablePointer<CChar>?
		guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == noErr,
			let base = dataPointer,
			// VT output is in practice contiguous, but it isn't contractually
			// guaranteed; reading totalLength from a partial segment would be OOB.
			lengthAtOffset == totalLength
		else {
			return out.isEmpty ? nil : out
		}
		var offset = 0
		while offset + 4 <= totalLength {
			var nalLength: UInt32 = 0
			memcpy(&nalLength, base + offset, 4)
			nalLength = UInt32(bigEndian: nalLength)
			offset += 4
			guard offset + Int(nalLength) <= totalLength else { break }
			out.append(startCode)
			base.withMemoryRebound(to: UInt8.self, capacity: totalLength) { u8 in
				out.append(UnsafeBufferPointer(start: u8 + offset, count: Int(nalLength)))
			}
			offset += Int(nalLength)
		}
		return out
	}
}
