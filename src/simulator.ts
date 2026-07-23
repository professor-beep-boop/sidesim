import { spawn, execFile, ChildProcess } from 'child_process';
import {
	SimulatorTarget,
	ScreenDimensions,
	SimulatorBackend,
	InputSink,
	VideoSource,
	ButtonName,
	BackendPreference,
} from './types';
import { Companion, isCompanionAvailable, listBootedViaCompanion } from './companion';

export {
	SimulatorTarget,
	ScreenDimensions,
	SimulatorBackend,
	InputSink,
	VideoSource,
	VideoMode,
	ButtonName,
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
export type BackendKind = 'companion' | 'cli';

export async function listBootedSimulators(
	preference: BackendPreference = 'auto',
): Promise<SimulatorTarget[]> {
	if (preference !== 'cli' && (await isCompanionAvailable())) {
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
 * Open a backend for a booted simulator. In `auto` mode, prefer the idb
 * companion gRPC path (low-latency input, framebuffer video) and fall back to
 * the idb CLI when the companion is unavailable or fails to connect.
 */
export async function openBackend(
	udid: string,
	preference: BackendPreference = 'auto',
): Promise<{ backend: SimulatorBackend; kind: BackendKind }> {
	if (preference !== 'cli' && (await isCompanionAvailable())) {
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
