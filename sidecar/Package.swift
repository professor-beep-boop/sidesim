// swift-tools-version:5.9
import PackageDescription
import Foundation

// Prebuilt FBSimulatorControl/FBControlCore frameworks (MIT, from facebook/idb).
// The Homebrew idb-companion bottle ships them with public headers and module
// maps, so we link against those instead of building Meta's private-API code
// from source. Override with SIMHELPER_FB_FRAMEWORKS for a custom location.
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
				.unsafeFlags(["-F", fwPath, "-Xlinker", "-rpath", "-Xlinker", fwPath]),
			]
		),
	]
)
