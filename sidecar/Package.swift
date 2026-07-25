// swift-tools-version:5.9
import PackageDescription
import Foundation

// Prebuilt FBSimulatorControl/FBControlCore frameworks (MIT, from facebook/idb).
// The Homebrew idb-companion bottle ships them (universal) with public headers
// and module maps, so we link against those instead of building Meta's
// private-API code from source. Override the LINK path with
// SIMHELPER_FB_FRAMEWORKS (build machine); RUNTIME resolution uses rpaths for
// both Homebrew prefixes so a packaged binary works on Apple Silicon and Intel.
let fwPath = ProcessInfo.processInfo.environment["SIMHELPER_FB_FRAMEWORKS"]
	?? "/opt/homebrew/opt/idb-companion/Frameworks"

let package = Package(
	name: "simhelper",
	platforms: [.macOS(.v13)],
	targets: [
		.executableTarget(
			name: "simhelper",
			path: "Sources/simhelper",
			swiftSettings: [
				.unsafeFlags(["-F", fwPath]),
			],
			linkerSettings: [
				.linkedFramework("FBControlCore"),
				.linkedFramework("FBSimulatorControl"),
				.linkedFramework("VideoToolbox"),
				.linkedFramework("CoreMedia"),
				.linkedFramework("CoreVideo"),
				.unsafeFlags([
					"-F", fwPath,
					"-Xlinker", "-rpath", "-Xlinker", "/opt/homebrew/opt/idb-companion/Frameworks",
					"-Xlinker", "-rpath", "-Xlinker", "/usr/local/opt/idb-companion/Frameworks",
				]),
			]
		),
	]
)
