import { spawn, execFile, ChildProcess } from 'child_process';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
	SimulatorTarget,
	ScreenDimensions,
	SimulatorBackend,
	InputSink,
	VideoSource,
	VideoMode,
	ButtonName,
} from './types';

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'idb.proto');
const COMPANION_BIN = process.env.VSCODESIM_IDB_COMPANION || 'idb_companion';
const PORT_TIMEOUT_MS = 15000;

// idb VideoStreamRequest.Format
const VIDEO_FORMAT_RBGA = 1; // raw BGRA frames — intra-only, so motion can never smear
// Fraction of native resolution to stream. Raw frames are large (~12.6 MB at
// full res); half scale keeps a phone mirror sharp at ~3 MB/frame.
const VIDEO_SCALE = 0.5;
// idb HIDEvent.HIDDirection
const HID_DOWN = 0;
const HID_UP = 1;

// idb HIDEvent.HIDButtonType
const HID_BUTTON: Record<ButtonName, number> = {
	APPLE_PAY: 0,
	HOME: 1,
	LOCK: 2,
	SIDE_BUTTON: 3,
	SIRI: 4,
};

interface CompanionService extends grpc.Client {
	describe(req: unknown, cb: (err: grpc.ServiceError | null, res: unknown) => void): void;
	video_stream(): grpc.ClientDuplexStream<unknown, unknown>;
	hid(cb: (err: grpc.ServiceError | null, res: unknown) => void): grpc.ClientWritableStream<unknown>;
}

let ServiceCtor: grpc.ServiceClientConstructor | undefined;

function loadService(): grpc.ServiceClientConstructor {
	if (!ServiceCtor) {
		const def = protoLoader.loadSync(PROTO_PATH, {
			keepCase: true,
			longs: Number,
			enums: Number,
			defaults: true,
			oneofs: true,
		});
		const pkg = grpc.loadPackageDefinition(def) as unknown as {
			idb: { CompanionService: grpc.ServiceClientConstructor };
		};
		ServiceCtor = pkg.idb.CompanionService;
	}
	return ServiceCtor;
}

export function isCompanionAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(COMPANION_BIN, ['--version'], (err) => resolve(!err));
	});
}

/**
 * Owns one `idb_companion` process for a single simulator plus the gRPC channel
 * to it. Video and input share this one connection.
 */
export class Companion implements SimulatorBackend {
	private proc: ChildProcess | undefined;
	private client: CompanionService | undefined;
	private hidCall: grpc.ClientWritableStream<unknown> | undefined;
	private videoCall: grpc.ClientDuplexStream<unknown, unknown> | undefined;
	private disposed = false;
	private exitNotified = false;
	private onExit: ((message: string) => void) | undefined;

	readonly videoMode: VideoMode = 'rbga';
	readonly videoScale = VIDEO_SCALE;

	private constructor(private readonly udid: string) {}

	static async open(udid: string): Promise<Companion> {
		const c = new Companion(udid);
		await c.connect();
		return c;
	}

	get input(): InputSink {
		return {
			tap: (x, y) => this.tap(x, y),
			swipe: (x1, y1, x2, y2, duration) => this.swipe(x1, y1, x2, y2, duration),
			text: (t) => this.text(t),
			key: (code) => this.key(code),
			button: (name) => this.button(name),
		};
	}

	async describe(): Promise<ScreenDimensions> {
		const res = await this.unary<{ target_description?: { screen_dimensions?: RawDimensions } }>(
			(client, cb) => client.describe({ fetch_diagnostics: false }, cb),
		);
		const d = res.target_description?.screen_dimensions;
		if (!d) {
			throw new Error('idb_companion describe returned no screen dimensions');
		}
		return {
			width: d.width,
			height: d.height,
			density: d.density,
			widthPoints: d.width_points,
			heightPoints: d.height_points,
		};
	}

	createVideo(onData: (chunk: Buffer) => void, onExit: (message: string) => void): VideoSource {
		return {
			start: () => this.startVideo(onData, onExit),
			stop: () => this.stopVideo(),
		};
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.stopVideo();
		try {
			this.hidCall?.end();
		} catch {
			// ignore
		}
		this.hidCall = undefined;
		this.client?.close();
		this.client = undefined;
		const proc = this.proc;
		this.proc = undefined;
		proc?.kill('SIGTERM');
	}

	// --- connection lifecycle ---

	private async connect(): Promise<void> {
		const port = await this.launch();
		const Service = loadService();
		this.client = new Service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
			// Raw frames exceed gRPC's default 4 MB message cap.
			{ 'grpc.max_receive_message_length': 64 * 1024 * 1024 },
		) as unknown as CompanionService;
	}

	private launch(): Promise<number> {
		return new Promise((resolve, reject) => {
			const proc = spawn(COMPANION_BIN, ['--udid', this.udid, '--grpc-port', '0']);
			this.proc = proc;
			let settled = false;
			let stdout = '';
			let stderr = '';

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					proc.kill('SIGTERM');
					reject(new Error('Timed out waiting for idb_companion to report its port'));
				}
			}, PORT_TIMEOUT_MS);

			const onStdout = (c: Buffer) => {
				stdout += c.toString();
				// Require a terminator so the match only fires on a complete number
				// (a chunk boundary can otherwise split the port digits).
				const m = stdout.match(/"grpc_port"\s*:\s*(\d+)\s*[},\n]/);
				if (m && !settled) {
					settled = true;
					clearTimeout(timer);
					// Companion logs to stdout for the whole session; stop buffering
					// it now that we have the port.
					proc.stdout?.off('data', onStdout);
					stdout = '';
					resolve(Number(m[1]));
				}
			};
			proc.stdout?.on('data', onStdout);
			proc.stderr?.on('data', (c: Buffer) => {
				if (!settled) {
					stderr += c.toString();
				}
			});
			proc.on('error', (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error(`Failed to launch ${COMPANION_BIN}: ${err.message}`));
				}
			});
			proc.on('exit', (code) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					const tail = stderr.split('\n').slice(-4).join('\n');
					reject(new Error(`idb_companion exited (${code}) before reporting a port:\n${tail}`));
				} else {
					// Crashed mid-session: surface it even if no video stream is up to
					// catch the gRPC error first.
					this.notifyExit(`idb_companion exited (${code})`);
				}
			});
		});
	}

	// --- video ---

	private startVideo(onData: (chunk: Buffer) => void, onExit: (message: string) => void): void {
		const client = this.requireClient();
		// Defensive: a stray second start (e.g. webview reload racing a restart)
		// must not leave an orphaned stream running.
		if (this.videoCall) {
			this.stopVideo();
		}
		this.onExit = onExit;
		this.exitNotified = false; // a fresh stream gets fresh error reporting
		const call = client.video_stream();
		this.videoCall = call;
		call.on('data', (resp: RawVideoResponse) => {
			const data = resp.payload?.data;
			// Events from a superseded call are stale — only the current stream's
			// data and lifecycle events count.
			if (this.videoCall === call && data && data.length > 0) {
				onData(Buffer.isBuffer(data) ? data : Buffer.from(data));
			}
		});
		call.on('error', (err: grpc.ServiceError) => {
			if (this.videoCall === call) {
				this.notifyExit(err.message);
			}
		});
		call.on('end', () => {
			if (this.videoCall === call) {
				this.notifyExit('idb_companion video stream ended');
			}
		});
		call.write({
			// Raw frames are large; 20 fps keeps the mirror smooth without
			// swamping the extension↔webview channel.
			start: { fps: 20, format: VIDEO_FORMAT_RBGA, compression_quality: 1.0, scale_factor: VIDEO_SCALE },
		});
	}

	/**
	 * Surface an unexpected stream/process death to the panel, once per stream.
	 * Intentional stops clear `videoCall` first, so their late end/error events
	 * are filtered out by the callers above.
	 */
	private notifyExit(message: string): void {
		if (this.disposed || this.exitNotified) {
			return;
		}
		this.exitNotified = true;
		this.onExit?.(message);
	}

	private stopVideo(): void {
		const call = this.videoCall;
		this.videoCall = undefined;
		if (!call) {
			return;
		}
		try {
			call.write({ stop: {} });
			call.end();
		} catch {
			// stream may already be torn down
		}
	}

	// --- input ---

	private tap(x: number, y: number): Promise<void> {
		const point = { x: Math.round(x), y: Math.round(y) };
		this.writeHid({ press: { action: { touch: { point } }, direction: HID_DOWN } });
		this.writeHid({ press: { action: { touch: { point } }, direction: HID_UP } });
		return Promise.resolve();
	}

	private swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<void> {
		this.writeHid({
			swipe: {
				start: { x: Math.round(x1), y: Math.round(y1) },
				end: { x: Math.round(x2), y: Math.round(y2) },
				duration: durationSec,
			},
		});
		return Promise.resolve();
	}

	private key(hidCode: number): Promise<void> {
		this.writeHid({ press: { action: { key: { keycode: hidCode } }, direction: HID_DOWN } });
		this.writeHid({ press: { action: { key: { keycode: hidCode } }, direction: HID_UP } });
		return Promise.resolve();
	}

	private button(name: ButtonName): Promise<void> {
		const button = HID_BUTTON[name];
		this.writeHid({ press: { action: { button: { button } }, direction: HID_DOWN } });
		this.writeHid({ press: { action: { button: { button } }, direction: HID_UP } });
		return Promise.resolve();
	}

	/**
	 * Text entry needs a full character→HID-usage keymap (with shift handling)
	 * that the companion HID stream does not provide. Delegate to the idb CLI,
	 * which owns that mapping. Typing is not latency-critical the way touch is.
	 */
	private text(value: string): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile('idb', ['ui', 'text', '--udid', this.udid, value], (err, _stdout, stderr) => {
				if (err) {
					reject(new Error(stderr || err.message));
				} else {
					resolve();
				}
			});
		});
	}

	private writeHid(event: unknown): void {
		try {
			this.hidStream().write(event);
		} catch (err) {
			// A broken HID stream should not crash the panel; drop the event and
			// let the next one re-open the stream.
			this.hidCall = undefined;
			void err;
		}
	}

	private hidStream(): grpc.ClientWritableStream<unknown> {
		if (!this.hidCall) {
			const client = this.requireClient();
			// Guard nulling on the *specific* stream: a late error from a
			// previously-discarded stream must not clobber a newer one.
			const stream = client.hid((err) => {
				if (err && this.hidCall === stream) {
					this.hidCall = undefined;
				}
			});
			stream.on('error', () => {
				if (this.hidCall === stream) {
					this.hidCall = undefined;
				}
			});
			this.hidCall = stream;
		}
		return this.hidCall;
	}

	private requireClient(): CompanionService {
		if (!this.client) {
			throw new Error('idb_companion connection is not open');
		}
		return this.client;
	}

	private unary<T>(
		call: (client: CompanionService, cb: (err: grpc.ServiceError | null, res: unknown) => void) => void,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			call(this.requireClient(), (err, res) => {
				if (err) {
					reject(err);
				} else {
					resolve(res as T);
				}
			});
		});
	}
}

interface RawDimensions {
	width: number;
	height: number;
	density: number;
	width_points: number;
	height_points: number;
}

interface RawVideoResponse {
	payload?: { data?: Uint8Array | Buffer };
}

/**
 * Enumerate booted simulators using `idb_companion --list 1`, avoiding the
 * Python idb CLI entirely on the companion path.
 */
export function listBootedViaCompanion(): Promise<SimulatorTarget[]> {
	return new Promise((resolve, reject) => {
		execFile(
			COMPANION_BIN,
			['--list', '1'],
			{ maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr || err.message));
					return;
				}
				const targets: SimulatorTarget[] = [];
				for (const line of stdout.split('\n')) {
					if (!line.trim()) {
						continue;
					}
					try {
						const t = JSON.parse(line);
						if (t.type === 'Simulator' && t.state === 'Booted') {
							targets.push({ name: t.name, udid: t.udid, osVersion: t.os_version });
						}
					} catch {
						// non-JSON lines (e.g. warnings)
					}
				}
				resolve(targets);
			},
		);
	});
}
