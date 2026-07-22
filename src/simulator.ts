import { spawn, execFile, ChildProcess } from 'child_process';

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

export async function listBootedSimulators(): Promise<SimulatorTarget[]> {
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

export async function getScreenDimensions(udid: string): Promise<ScreenDimensions> {
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

export class VideoStream {
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

export class InputController {
	constructor(private readonly udid: string) {}

	tap(x: number, y: number): Promise<string> {
		return idb(['ui', 'tap', '--udid', this.udid, String(Math.round(x)), String(Math.round(y))]);
	}

	swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<string> {
		return idb([
			'ui', 'swipe', '--udid', this.udid,
			String(Math.round(x1)), String(Math.round(y1)),
			String(Math.round(x2)), String(Math.round(y2)),
			'--duration', durationSec.toFixed(2),
		]);
	}

	text(text: string): Promise<string> {
		return idb(['ui', 'text', '--udid', this.udid, text]);
	}

	key(hidCode: number): Promise<string> {
		return idb(['ui', 'key', '--udid', this.udid, String(hidCode)]);
	}

	button(name: 'HOME' | 'LOCK' | 'SIRI'): Promise<string> {
		return idb(['ui', 'button', '--udid', this.udid, name]);
	}
}
