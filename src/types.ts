export interface SimulatorTarget {
	name: string;
	udid: string;
	osVersion: string;
}

export interface ScreenDimensions {
	width: number;
	height: number;
	density: number;
	widthPoints: number;
	heightPoints: number;
}

export type ButtonName = 'HOME' | 'LOCK' | 'SIRI' | 'SIDE_BUTTON' | 'APPLE_PAY';

/** Forwards user input into the simulator. */
export interface InputSink {
	tap(x: number, y: number): Promise<void>;
	swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<void>;
	text(value: string): Promise<void>;
	key(hidCode: number): Promise<void>;
	button(name: ButtonName): Promise<void>;
}

/** A running video stream from the simulator. */
export interface VideoSource {
	start(): void;
	stop(): void;
}

/**
 * How a backend delivers frames.
 * - `rbga`: each frame is one complete raw BGRA image (intra-only; immune to the
 *   inter-frame reference corruption that plagues the simulator's H.264). Bytes
 *   are stride-padded; the renderer derives the stride from the frame length.
 * - `h264`: an Annex-B byte stream to be decoded (WebCodecs).
 */
export type VideoMode = 'rbga' | 'h264';

/**
 * A connection to one booted simulator that provides both a video feed and an
 * input channel. Backends: {@link CliBackend} (idb CLI) and Companion (idb
 * gRPC). Callers dispose the backend when the panel closes.
 */
export interface SimulatorBackend {
	readonly input: InputSink;
	/** How frames from {@link createVideo} are encoded. */
	readonly videoMode: VideoMode;
	/** Fraction of native resolution the video is streamed at (rbga only). */
	readonly videoScale: number;
	describe(): Promise<ScreenDimensions>;
	createVideo(onData: (chunk: Buffer) => void, onExit: (message: string) => void): VideoSource;
	dispose(): void;
}

export type BackendPreference = 'auto' | 'companion' | 'cli';
