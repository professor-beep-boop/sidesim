import { spawn, execFile, ChildProcess } from 'child_process';
import {
	SimulatorTarget,
	ScreenDimensions,
	SimulatorBackend,
	InputSink,
	VideoSource,
	ButtonName,
	TouchPhase,
	BackendPreference,
} from './types';
import { Companion, isCompanionAvailable, listBootedViaCompanion } from './companion';
import { SidecarBackend, isSidecarAvailable, listBootedViaSidecar } from './sidecar';

export {
	SimulatorTarget,
	ScreenDimensions,
	SimulatorBackend,
	InputSink,
	VideoSource,
	VideoMode,
	ButtonName,
	TouchPhase,
	BackendPreference,
} from './types';

function idb(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('idb', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr || err.message));
			} else {
				resolve(stdout);
			}
		});
	});
}

async function listBootedViaCli(): Promise<SimulatorTarget[]> {
	const out = await idb(['list-targets', '--json']);
	const targets: SimulatorTarget[] = [];
	for (const line of out.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const t = JSON.parse(line);
			if (t.type === 'simulator' && t.state === 'Booted') {
				targets.push({ name: t.name, udid: t.udid, osVersion: t.os_version });
			}
		} catch {
			// non-JSON output lines
		}
	}
	return targets;
}

async function describeViaCli(udid: string): Promise<ScreenDimensions> {
	const out = await idb(['describe', '--udid', udid, '--json']);
	const d = JSON.parse(out).screen_dimensions;
	return {
		width: d.width,
		height: d.height,
		density: d.density,
		widthPoints: d.width_points,
		heightPoints: d.height_points,
	};
}

/** Video feed backed by `idb video-stream` (one persistent process). */
class CliVideoStream implements VideoSource {
	private proc: ChildProcess | undefined;

	constructor(
		private readonly udid: string,
		private readonly onData: (chunk: Buffer) => void,
		private readonly onExit: (message: string) => void,
	) {}

	start(): void {
		this.proc = spawn('idb', [
			'video-stream',
			'--udid', this.udid,
			'--format', 'h264',
			'--fps', '30',
		]);
		this.proc.stdout?.on('data', this.onData);
		let stderr = '';
		this.proc.stderr?.on('data', (c: Buffer) => {
			stderr += c.toString();
		});
		this.proc.on('exit', (code) => {
			const proc = this.proc;
			this.proc = undefined;
			if (proc && code !== null && code !== 0) {
				this.onExit(stderr.split('\n').slice(-5).join('\n'));
			}
		});
	}

	stop(): void {
		const proc = this.proc;
		this.proc = undefined;
		proc?.kill('SIGINT');
	}
}

/** Input backed by one `idb ui …` process per event (~0.5s latency each). */
class CliInput implements InputSink {
	private touchStart: { x: number; y: number; at: number } | undefined;

	constructor(private readonly udid: string) {}

	async tap(x: number, y: number): Promise<void> {
		await idb(['ui', 'tap', '--udid', this.udid, String(Math.round(x)), String(Math.round(y))]);
	}

	async swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<void> {
		await idb([
			'ui', 'swipe', '--udid', this.udid,
			String(Math.round(x1)), String(Math.round(y1)),
			String(Math.round(x2)), String(Math.round(y2)),
			'--duration', durationSec.toFixed(2),
		]);
	}

	/**
	 * The CLI can't stream live phases (one process per event, ~0.5s each).
	 * Synthesize: remember 'down', ignore 'move', emit a tap or swipe on 'up'.
	 */
	async touch(phase: TouchPhase, x: number, y: number): Promise<void> {
		if (phase === 'down') {
			this.touchStart = { x, y, at: Date.now() };
			return;
		}
		if (phase !== 'up' || !this.touchStart) {
			return;
		}
		const start = this.touchStart;
		this.touchStart = undefined;
		if (Math.hypot(x - start.x, y - start.y) < 8) {
			await this.tap(x, y);
		} else {
			const duration = Math.min(Math.max((Date.now() - start.at) / 1000, 0.1), 2);
			await this.swipe(start.x, start.y, x, y, duration);
		}
	}

	async cancelTouch(): Promise<void> {
		// Nothing was injected yet (effects happen on 'up'); just forget the gesture.
		this.touchStart = undefined;
	}

	async text(value: string): Promise<void> {
		await idb(['ui', 'text', '--udid', this.udid, value]);
	}

	async key(hidCode: number): Promise<void> {
		await idb(['ui', 'key', '--udid', this.udid, String(hidCode)]);
	}

	async button(name: ButtonName): Promise<void> {
		await idb(['ui', 'button', '--udid', this.udid, name]);
	}
}

class CliBackend implements SimulatorBackend {
	readonly input: InputSink;
	readonly livePhases = false;
	readonly videoMode = 'h264' as const;
	readonly videoScale = 1;

	constructor(private readonly udid: string) {
		this.input = new CliInput(udid);
	}

	describe(): Promise<ScreenDimensions> {
		return describeViaCli(this.udid);
	}

	createVideo(onData: (chunk: Buffer) => void, onExit: (message: string) => void): VideoSource {
		return new CliVideoStream(this.udid, onData, onExit);
	}

	dispose(): void {
		// CLI processes are owned per-video-stream; nothing session-scoped to release.
	}
}

/** Which backend a live panel ended up using, for status display. */
export type BackendKind = 'sidecar' | 'companion' | 'cli';

export async function listBootedSimulators(
	preference: BackendPreference = 'auto',
): Promise<SimulatorTarget[]> {
	if (preference === 'sidecar' && !isSidecarAvailable()) {
		throw new Error('simhelper binary not found — run `swift build` in sidecar/');
	}
	if ((preference === 'auto' || preference === 'sidecar') && isSidecarAvailable()) {
		try {
			return await listBootedViaSidecar();
		} catch (err) {
			if (preference === 'sidecar') {
				throw err;
			}
		}
	}
	if (preference !== 'cli' && preference !== 'sidecar' && (await isCompanionAvailable())) {
		try {
			return await listBootedViaCompanion();
		} catch {
			if (preference === 'companion') {
				throw new Error('idb_companion failed to list targets');
			}
			// fall through to CLI in auto mode
		}
	}
	return listBootedViaCli();
}

/**
 * Open a backend for a booted simulator. In `auto` mode, prefer the native
 * simhelper sidecar (correct H.264 + in-process HID), then the idb companion
 * gRPC path, then the idb CLI.
 */
export async function openBackend(
	udid: string,
	preference: BackendPreference = 'auto',
): Promise<{ backend: SimulatorBackend; kind: BackendKind }> {
	if (preference === 'sidecar' && !isSidecarAvailable()) {
		throw new Error('simhelper binary not found — run `swift build` in sidecar/');
	}
	if ((preference === 'auto' || preference === 'sidecar') && isSidecarAvailable()) {
		try {
			const backend = await SidecarBackend.open(udid);
			return { backend, kind: 'sidecar' };
		} catch (err) {
			if (preference === 'sidecar') {
				throw err;
			}
			// auto: fall through
		}
	}
	if (preference !== 'cli' && preference !== 'sidecar' && (await isCompanionAvailable())) {
		try {
			const backend = await Companion.open(udid);
			return { backend, kind: 'companion' };
		} catch (err) {
			if (preference === 'companion') {
				throw err;
			}
			// auto: fall back to CLI
		}
	}
	return { backend: new CliBackend(udid), kind: 'cli' };
}
