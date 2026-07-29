import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from './log';
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

// Overridable for slow environments (cold CI VMs take >15s for the sidecar's
// first CoreSimulatorService contact).
const READY_TIMEOUT_MS = Number(process.env.VSCODESIM_READY_TIMEOUT_MS) || 15000;
const CALL_TIMEOUT_MS = Number(process.env.VSCODESIM_CALL_TIMEOUT_MS) || 20000;
const VIDEO_FPS = 30;
const VIDEO_SCALE = 1.0;
const VIDEO_BITRATE = 8_000_000;
/** A framed message larger than this means protocol corruption, not video. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_RESTARTS = 3;
/** A sidecar surviving this long resets the crash counter. */
const STABLE_MS = 60_000;

export interface SidecarOptions {
	/** Confine the sidecar with sandbox-exec (no network, scoped writes). */
	sandbox?: boolean;
	/** Stream frame rate (applied at open; the framebuffer stream is fixed per session). */
	fps?: number;
	/** Stream resolution as a fraction of native (applied at open). */
	scale?: number;
}

/**
 * Containment profile for sandbox-exec: the sidecar needs no network at all,
 * and only writes to CoreSimulator state/log dirs, temp, and devices.
 * Mach/XPC stays open (allow default) — CoreSimulatorService runs over XPC.
 */
function sandboxProfile(): string {
	// SBPL string literals: escape backslash and double-quote.
	const home = os.homedir().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write*
  (subpath "${home}/Library/Developer/CoreSimulator")
  (subpath "${home}/Library/Logs/CoreSimulator")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/dev"))
`;
}

function sandboxedSpawnArgs(binary: string): { cmd: string; args: string[] } {
	// Per-process filename: a fixed name races concurrent extension hosts
	// (truncate-then-write vs sandbox-exec's read).
	const profilePath = path.join(os.tmpdir(), `vscodesim-simhelper-${process.pid}.sb`);
	fs.writeFileSync(profilePath, sandboxProfile());
	return { cmd: '/usr/bin/sandbox-exec', args: ['-f', profilePath, binary] };
}

/**
 * Homebrew locations simhelper's rpath searches for idb's FBSimulatorControl
 * frameworks (Apple Silicon prefix, then Intel). These ship with
 * `brew install idb-companion` from the facebook/fb tap.
 */
const IDB_FRAMEWORK_DIRS = [
	'/opt/homebrew/opt/idb-companion/Frameworks',
	'/usr/local/opt/idb-companion/Frameworks',
];

/**
 * Whether idb's frameworks are installed. simhelper links FBSimulatorControl /
 * FBControlCore via @rpath; without them it dies at launch with a dyld error
 * that surfaces as a confusing "no simulator" fallback. The bundled binary is
 * always present in an installed VSIX, so this — not the binary — is the real
 * prerequisite a fresh machine is missing.
 */
export function idbFrameworksAvailable(): boolean {
	// simhelper hard-links BOTH frameworks via @rpath; require both present so a
	// partial/corrupt keg doesn't pass the check and then dyld-fail at launch.
	return IDB_FRAMEWORK_DIRS.some(
		(dir) =>
			fs.existsSync(path.join(dir, 'FBSimulatorControl.framework')) &&
			fs.existsSync(path.join(dir, 'FBControlCore.framework')),
	);
}

/** One-liner that installs idb-companion (and its frameworks) via Homebrew. */
export const IDB_INSTALL_COMMAND =
	'brew tap facebook/fb && brew trust --tap facebook/fb && brew install idb-companion';

/**
 * Locate the simhelper binary: explicit override, then the in-repo build
 * (dev flow), then the packaged binary, then a Homebrew install
 * (`brew install professor-beep-boop/vscodesim/simhelper`).
 */
export function findSidecarBinary(): string | undefined {
	const override = process.env.VSCODESIM_SIMHELPER;
	if (override && fs.existsSync(override)) {
		return override;
	}
	// In-repo dev builds win when present (a fresh `swift build` shouldn't be
	// shadowed by a stale staged binary); the packaged VSIX has no .build and
	// falls through to bin/simhelper (sibling of out/).
	for (const rel of [
		'../sidecar/.build/release/simhelper',
		'../sidecar/.build/debug/simhelper',
		'../bin/simhelper',
	]) {
		const p = path.join(__dirname, rel);
		if (fs.existsSync(p)) {
			return p;
		}
	}
	// Homebrew (Apple Silicon prefix, then Intel) — lets a VSIX without a
	// bundled binary (or a future pure-JS Marketplace build) use the tap.
	for (const p of ['/opt/homebrew/bin/simhelper', '/usr/local/bin/simhelper']) {
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
	/** Request-level input failure on a live sidecar (not a process death). */
	onInputError: ((message: string) => void) | undefined;

	private stderrTail = '';

	private constructor(binary: string, sandbox: boolean) {
		const { cmd, args } = sandbox ? sandboxedSpawnArgs(binary) : { cmd: binary, args: [] as string[] };
		log(`sidecar: spawning ${sandbox ? 'sandboxed ' : ''}${binary}`);
		this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
			log(`sidecar: exited (${code})`);
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

	static async start(binary: string, sandbox = false): Promise<SidecarProcess> {
		const p = new SidecarProcess(binary, sandbox);
		await p.waitForReady();
		return p;
	}

	get isAlive(): boolean {
		return !this.disposed && this.proc.exitCode === null && this.proc.signalCode === null;
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
			// drags silently no-op. Dead-process rejections are NOT surfaced
			// here — crash recovery owns those (routing them into onExit would
			// re-enter the recovery state machine).
			if (!this.sendErrorReported && this.isAlive) {
				this.sendErrorReported = true;
				this.onInputError?.(`input failed: ${err.message}`);
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
				if (length > MAX_FRAME_BYTES) {
					// Framing is corrupt; nothing downstream can resync. Kill the
					// process — the exit handler surfaces it (and recovery respawns).
					log(`sidecar: oversize frame (${length} bytes) — protocol corrupt, killing`);
					this.buf = Buffer.alloc(0);
					this.proc.kill('SIGKILL');
					return;
				}
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
export async function listBootedViaSidecar(options: SidecarOptions = {}): Promise<SimulatorTarget[]> {
	const binary = findSidecarBinary();
	if (!binary) {
		throw new Error('simhelper binary not found');
	}
	const proc = await SidecarProcess.start(binary, options.sandbox ?? false);
	try {
		const devices = await proc.call<Array<Record<string, unknown>>>('listDevices', {});
		return devices
			.filter((d): d is Record<string, string> => typeof d?.udid === 'string' && typeof d?.name === 'string')
			.map((d) => ({ name: d.name, udid: d.udid, osVersion: String(d.osVersion ?? '') }));
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
	readonly multiTouch = true;
	readonly videoMode: VideoMode = 'h264';

	private streamCounter = 0;
	private activeStreamId = 0;
	private lastTouch: { x: number; y: number } | undefined;
	private lastTouch2: { ax: number; ay: number; bx: number; by: number } | undefined;
	private video: { onData: (chunk: Buffer) => void; onExit: (message: string) => void; active: boolean } | undefined;
	private disposed = false;
	private restarts = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private stableTimer: NodeJS.Timeout | undefined;

	private constructor(
		private proc: SidecarProcess,
		private readonly binary: string,
		private readonly sandbox: boolean,
		private readonly udid: string,
		private readonly fps: number,
		readonly videoScale: number,
	) {
		this.wireProc();
	}

	static async open(udid: string, options: SidecarOptions = {}): Promise<SidecarBackend> {
		const binary = findSidecarBinary();
		if (!binary) {
			throw new Error('simhelper binary not found');
		}
		const sandbox = options.sandbox ?? false;
		const fps = Math.min(Math.max(options.fps ?? VIDEO_FPS, 5), 60);
		const scale = Math.min(Math.max(options.scale ?? VIDEO_SCALE, 0.25), 1);
		const proc = await SidecarProcess.start(binary, sandbox);
		return new SidecarBackend(proc, binary, sandbox, udid, fps, scale);
	}

	/** Attach frame/event/exit routing to the current process. */
	private wireProc(): void {
		this.proc.onFrame = (streamId, payload) => {
			if (streamId === this.activeStreamId) {
				this.video?.onData(payload);
			}
		};
		this.proc.onEvent = (event, payload) => {
			if (event === 'videoEnded' || event === 'videoError') {
				this.video?.onExit(`${event}: ${payload.message ?? payload.udid ?? ''}`);
			}
		};
		this.proc.onExit = (message) => this.onProcDeath(message);
		this.proc.onInputError = (message) => this.video?.onExit(message);
		// Stable for a while → forgive past crashes.
		clearTimeout(this.stableTimer);
		this.stableTimer = setTimeout(() => {
			this.restarts = 0;
		}, STABLE_MS);
		this.stableTimer.unref?.();
	}

	/**
	 * Crash recovery: respawn with exponential backoff and resume the video
	 * stream. After MAX_RESTARTS without a stable stretch, give up and surface
	 * the failure to the panel.
	 */
	private recovering = false;

	private onProcDeath(message: string): void {
		if (this.disposed || this.recovering) {
			// Idempotent per death: late rejections from the dying process's
			// pending calls must not schedule a second respawn.
			return;
		}
		this.recovering = true;
		// Sever and dispose the dead process: buffered events from its streams
		// must not reach current state, and if this "death" was actually an RPC
		// failure the old process must not linger alive contending for the sim.
		const dead = this.proc;
		dead.onFrame = undefined;
		dead.onEvent = undefined;
		dead.onExit = undefined;
		dead.onInputError = undefined;
		dead.dispose();

		clearTimeout(this.stableTimer);
		if (this.restarts >= MAX_RESTARTS) {
			log(`sidecar: giving up after ${this.restarts} restarts`);
			this.video?.onExit(message);
			return;
		}
		this.restarts++;
		const delay = 500 * 4 ** (this.restarts - 1); // 500ms, 2s, 8s
		log(`sidecar: died (${message}); restart ${this.restarts}/${MAX_RESTARTS} in ${delay}ms`);
		this.restartTimer = setTimeout(() => {
			void (async () => {
				if (this.disposed) {
					return;
				}
				try {
					const fresh = await SidecarProcess.start(this.binary, this.sandbox);
					if (this.disposed) {
						// Panel closed while the respawn was in flight.
						fresh.dispose();
						return;
					}
					this.proc = fresh;
					this.recovering = false;
					this.wireProc();
					if (this.video?.active) {
						this.startStream();
					}
					log('sidecar: recovered');
				} catch (err) {
					this.recovering = false;
					this.onProcDeath(err instanceof Error ? err.message : String(err));
				}
			})();
		}, delay);
	}

	private startStream(): void {
		const streamId = ++this.streamCounter;
		this.activeStreamId = streamId;
		void this.proc
			.call('startVideo', {
				udid: this.udid,
				streamId,
				fps: this.fps,
				scaleFactor: this.videoScale,
				encoding: 'h264',
				bitrate: VIDEO_BITRATE,
			})
			.catch((err) => {
				// Process deaths route through onProcDeath; only surface
				// request-level failures from a still-live sidecar.
				if (!this.disposed && this.proc.isAlive) {
					this.video?.onExit(err instanceof Error ? err.message : String(err));
				}
			});
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
			touch2: (phase: TouchPhase, ax, ay, bx, by) => {
				this.lastTouch2 = phase === 'up' ? undefined : { ax, ay, bx, by };
				this.proc.send('touch2', { udid: this.udid, phase, ax, ay, bx, by });
				return Promise.resolve();
			},
			cancelTouch: () => {
				const last = this.lastTouch;
				this.lastTouch = undefined;
				if (last) {
					this.proc.send('touch', { udid: this.udid, phase: 'up', x: last.x, y: last.y });
				}
				const last2 = this.lastTouch2;
				this.lastTouch2 = undefined;
				if (last2) {
					this.proc.send('touch2', { udid: this.udid, phase: 'up', ...last2 });
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
		this.video = { onData, onExit, active: false };
		return {
			start: () => {
				if (this.video) {
					this.video.active = true;
				}
				this.startStream();
			},
			stop: () => {
				if (this.video) {
					this.video.active = false;
				}
				this.activeStreamId = 0;
				this.proc.send('stopVideo', { udid: this.udid });
			},
		};
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.restartTimer);
		clearTimeout(this.stableTimer);
		// stdin EOF makes the sidecar release touches and stop streams itself.
		this.proc.dispose();
	}
}
