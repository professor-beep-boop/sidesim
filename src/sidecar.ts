import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
	SimulatorTarget,
	ScreenDimensions,
	SimulatorBackend,
	InputSink,
	VideoSource,
	VideoMode,
	ButtonName,
	TouchPhase,
} from './types';

const READY_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 20000;
const VIDEO_FPS = 30;
const VIDEO_SCALE = 1.0;
const VIDEO_BITRATE = 8_000_000;

/**
 * Locate the simhelper binary: explicit override, then the in-repo build
 * (dev flow), then PATH.
 */
export function findSidecarBinary(): string | undefined {
	const override = process.env.VSCODESIM_SIMHELPER;
	if (override && fs.existsSync(override)) {
		return override;
	}
	for (const rel of ['../sidecar/.build/release/simhelper', '../sidecar/.build/debug/simhelper']) {
		const p = path.join(__dirname, rel);
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return undefined;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * One simhelper process: JSON-RPC over stdio, with binary video frames
 * multiplexed on stdout ([0x00][u32be streamId][u32be length][payload]).
 */
class SidecarProcess {
	private proc: ChildProcess;
	private buf = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, PendingCall>();
	private disposed = false;

	/** Routes binary frames for the currently-active stream. */
	onFrame: ((streamId: number, payload: Buffer) => void) | undefined;
	/** Out-of-band events (videoEnded, videoError, protocolError). */
	onEvent: ((event: string, payload: Record<string, unknown>) => void) | undefined;
	/** Unexpected process death. */
	onExit: ((message: string) => void) | undefined;

	private stderrTail = '';

	private constructor(binary: string) {
		this.proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
		this.proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
		// A write racing the process's death surfaces as an async 'error' on
		// stdin; without a listener that is an uncaught exception in the
		// extension host. The 'exit' handler does the real surfacing.
		this.proc.stdin?.on('error', () => {
			/* swallowed; exit handler reports */
		});
		this.proc.stderr?.on('data', (c: Buffer) => {
			this.stderrTail = (this.stderrTail + c.toString()).slice(-2000);
		});
		this.proc.on('exit', (code) => {
			const failure = new Error(`simhelper exited (${code})`);
			for (const [, call] of this.pending) {
				clearTimeout(call.timer);
				call.reject(failure);
			}
			this.pending.clear();
			if (!this.disposed) {
				this.onExit?.(`simhelper exited (${code}): ${this.stderrTail.split('\n').slice(-3).join(' ')}`);
			}
		});
	}

	static async start(binary: string): Promise<SidecarProcess> {
		const p = new SidecarProcess(binary);
		await p.waitForReady();
		return p;
	}

	private waitForReady(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.dispose();
				reject(new Error('simhelper did not become ready'));
			}, READY_TIMEOUT_MS);
			// A stale build or bad Xcode selection makes the binary exit within
			// milliseconds — fail fast rather than eating the whole ready timeout.
			const onEarlyExit = (code: number | null) => {
				clearTimeout(timer);
				reject(new Error(`simhelper exited (${code}) before ready: ${this.stderrTail.split('\n').slice(-3).join(' ')}`));
			};
			this.proc.once('exit', onEarlyExit);
			const prev = this.onEvent;
			this.onEvent = (event, payload) => {
				if (event === 'ready') {
					clearTimeout(timer);
					this.proc.off('exit', onEarlyExit);
					this.onEvent = prev;
					resolve();
				} else {
					prev?.(event, payload);
				}
			};
			this.proc.on('error', (err) => {
				clearTimeout(timer);
				reject(new Error(`failed to launch simhelper: ${err.message}`));
			});
		});
	}

	call<T>(method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.disposed || !this.proc.stdin?.writable) {
				reject(new Error('simhelper is not running'));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`simhelper ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
		});
	}

	private sendErrorReported = false;

	/** Fire-and-forget for latency-critical input events. */
	send(method: string, params: Record<string, unknown>): void {
		void this.call(method, params).catch((err: Error) => {
			// The sidecar can reject while alive too (e.g. "simulator is no
			// longer booted"); surface the first such failure instead of letting
			// drags silently no-op.
			if (!this.sendErrorReported && !this.disposed) {
				this.sendErrorReported = true;
				this.onExit?.(`input failed: ${err.message}`);
			}
		});
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		try {
			this.proc.stdin?.end(); // EOF → sidecar releases touches, stops streams, exits
		} catch {
			/* already gone */
		}
		const proc = this.proc;
		// The sidecar handles requests serially, so a long in-flight gesture can
		// delay it noticing EOF; give it time to finish and run teardown (touch
		// release) before force-killing.
		setTimeout(() => {
			if (proc.exitCode === null) {
				proc.kill('SIGKILL');
			}
		}, 10000).unref();
	}

	private onStdout(chunk: Buffer): void {
		this.buf = Buffer.concat([this.buf, chunk]);
		for (;;) {
			if (this.buf.length === 0) {
				return;
			}
			if (this.buf[0] === 0x00) {
				if (this.buf.length < 9) {
					return;
				}
				const streamId = this.buf.readUInt32BE(1);
				const length = this.buf.readUInt32BE(5);
				if (this.buf.length < 9 + length) {
					return;
				}
				const payload = this.buf.subarray(9, 9 + length);
				this.buf = this.buf.subarray(9 + length);
				this.onFrame?.(streamId, payload);
			} else {
				const nl = this.buf.indexOf(0x0a);
				if (nl < 0) {
					return;
				}
				const line = this.buf.subarray(0, nl).toString();
				this.buf = this.buf.subarray(nl + 1);
				this.onLine(line);
			}
		}
	}

	private onLine(line: string): void {
		let msg: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== 'object' || parsed === null) {
				return;
			}
			msg = parsed as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof msg.event === 'string') {
			this.onEvent?.(msg.event, msg);
			return;
		}
		const id = msg.id as number;
		const call = this.pending.get(id);
		if (!call) {
			return;
		}
		this.pending.delete(id);
		clearTimeout(call.timer);
		if (typeof msg.error === 'string') {
			call.reject(new Error(msg.error));
		} else {
			call.resolve(msg.result);
		}
	}
}

/** List booted simulators via a short-lived simhelper. */
export async function listBootedViaSidecar(): Promise<SimulatorTarget[]> {
	const binary = findSidecarBinary();
	if (!binary) {
		throw new Error('simhelper binary not found');
	}
	const proc = await SidecarProcess.start(binary);
	try {
		const devices = await proc.call<Array<Record<string, string>>>('listDevices', {});
		return devices.map((d) => ({ name: d.name, udid: d.udid, osVersion: d.osVersion }));
	} finally {
		proc.dispose();
	}
}

export function isSidecarAvailable(): boolean {
	return findSidecarBinary() !== undefined;
}

/**
 * Backend on the native simhelper sidecar: correctly-encoded H.264 video
 * (no B-frames, periodic keyframes) and in-process HID input including text.
 */
export class SidecarBackend implements SimulatorBackend {
	readonly livePhases = true;
	readonly videoMode: VideoMode = 'h264';
	readonly videoScale = VIDEO_SCALE;

	private streamCounter = 0;
	private activeStreamId = 0;
	private lastTouch: { x: number; y: number } | undefined;

	private constructor(
		private readonly proc: SidecarProcess,
		private readonly udid: string,
	) {}

	static async open(udid: string): Promise<SidecarBackend> {
		const binary = findSidecarBinary();
		if (!binary) {
			throw new Error('simhelper binary not found');
		}
		const proc = await SidecarProcess.start(binary);
		return new SidecarBackend(proc, udid);
	}

	get input(): InputSink {
		return {
			tap: async (x, y) => {
				await this.proc.call('tap', { udid: this.udid, x, y });
			},
			swipe: async (x1, y1, x2, y2, durationSec) => {
				await this.proc.call('swipe', { udid: this.udid, x1, y1, x2, y2, durationSec });
			},
			touch: (phase: TouchPhase, x, y) => {
				this.lastTouch = phase === 'up' ? undefined : { x, y };
				// Fire-and-forget: touch phases stream at ~60Hz and must not
				// serialize on round-trips.
				this.proc.send('touch', { udid: this.udid, phase, x, y });
				return Promise.resolve();
			},
			cancelTouch: () => {
				const last = this.lastTouch;
				this.lastTouch = undefined;
				if (last) {
					this.proc.send('touch', { udid: this.udid, phase: 'up', x: last.x, y: last.y });
				}
				return Promise.resolve();
			},
			text: async (value) => {
				await this.proc.call('text', { udid: this.udid, value }, 60000);
			},
			key: async (code) => {
				await this.proc.call('key', { udid: this.udid, code });
			},
			button: async (name: ButtonName) => {
				await this.proc.call('button', { udid: this.udid, name });
			},
		};
	}

	describe(): Promise<ScreenDimensions> {
		return this.proc.call<ScreenDimensions>('describe', { udid: this.udid });
	}

	createVideo(onData: (chunk: Buffer) => void, onExit: (message: string) => void): VideoSource {
		this.proc.onFrame = (streamId, payload) => {
			if (streamId === this.activeStreamId) {
				onData(payload);
			}
		};
		this.proc.onEvent = (event, payload) => {
			if (event === 'videoEnded' || event === 'videoError') {
				onExit(`${event}: ${payload.message ?? payload.udid ?? ''}`);
			}
		};
		this.proc.onExit = onExit;
		return {
			start: () => {
				const streamId = ++this.streamCounter;
				this.activeStreamId = streamId;
				void this.proc
					.call('startVideo', {
						udid: this.udid,
						streamId,
						fps: VIDEO_FPS,
						scaleFactor: VIDEO_SCALE,
						encoding: 'h264',
						bitrate: VIDEO_BITRATE,
					})
					.catch((err) => onExit(err instanceof Error ? err.message : String(err)));
			},
			stop: () => {
				this.activeStreamId = 0;
				this.proc.send('stopVideo', { udid: this.udid });
			},
		};
	}

	dispose(): void {
		// stdin EOF makes the sidecar release touches and stop streams itself.
		this.proc.dispose();
	}
}
