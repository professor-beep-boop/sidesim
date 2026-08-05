import * as vscode from 'vscode';
import * as fs from 'fs';
import {
	listBootedSimulators,
	openBackend,
	SimulatorTarget,
	BackendPreference,
} from './simulator';
import { idbFrameworksAvailable, IDB_INSTALL_COMMAND } from './sidecar';
import { setLogSink } from './log';

/**
 * Starter `sidesim.run.command` templates offered by the ▶ Run button when no
 * command is set yet. `detect` recognises the project's build system from
 * marker files so the matching template is surfaced first — but the command
 * stays fully user-owned (each template carries an obvious placeholder to
 * replace). Only build systems that actually deploy to a simulator are here;
 * SwiftPM is intentionally omitted (it can't build/launch an iOS app on a sim).
 */
interface RunTemplate {
	system: string;
	command: string;
	detect: (root: string) => boolean;
}

const RUN_TEMPLATES: RunTemplate[] = [
	{
		system: 'Bazel',
		command: 'bazel run //path/to:MyApp',
		detect: (root) =>
			['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel'].some((f) => fs.existsSync(`${root}/${f}`)),
	},
	{
		system: 'Xcode',
		command:
			'xcodebuild -scheme MyApp -destination "id=$SIDESIM_TARGET_UDID" && xcrun simctl launch "$SIDESIM_TARGET_UDID" com.example.MyApp',
		detect: (root) => {
			try {
				return fs.readdirSync(root).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
			} catch {
				return false;
			}
		},
	},
];

function backendPreference(): BackendPreference {
	const value = vscode.workspace
		.getConfiguration('sidesim')
		.get<string>('simulator.backend', 'auto');
	return value === 'sidecar' || value === 'companion' || value === 'cli' ? value : 'auto';
}

export function activate(context: vscode.ExtensionContext) {
	const channel = vscode.window.createOutputChannel('iOS Simulator');
	setLogSink((line) => channel.appendLine(line));
	context.subscriptions.push(
		{ dispose: () => setLogSink(undefined) },
		channel,
		vscode.commands.registerCommand('sidesim.openSimulator', async () => {
			try {
				if (!(await ensurePrerequisites())) {
					return;
				}
				await openSimulatorPanel(context);
			} catch (err) {
				vscode.window.showErrorMessage(`iOS Simulator: ${err instanceof Error ? err.message : err}`);
			}
		}),
	);
}

/**
 * Verify the host can actually mirror a simulator before we try — and if not,
 * tell the user exactly how to fix it. Every backend (sidecar, companion, cli)
 * ultimately drives CoreSimulator through idb's frameworks, so a missing
 * idb-companion is the one prerequisite that leaves nothing working; without
 * this the sidecar just dies at launch and the user sees a baffling
 * "no booted simulator" fallback. Returns false if the panel should not open.
 */
async function ensurePrerequisites(): Promise<boolean> {
	if (process.platform !== 'darwin') {
		void vscode.window.showErrorMessage(
			'iOS Simulator requires macOS with Xcode and the iOS Simulator installed.',
		);
		return false;
	}
	// An explicit binary override means the user is running a custom/self-contained
	// simhelper whose frameworks may live elsewhere — trust it, skip the probe.
	if (!idbFrameworksAvailable() && !process.env.SIDESIM_SIMHELPER) {
		const COPY = 'Copy Install Command';
		const DOCS = 'Open idb Docs';
		const choice = await vscode.window.showErrorMessage(
			"iOS Simulator needs Meta's idb (idb-companion) for live video and input. " +
				'Install it with Homebrew, then open the simulator again.',
			COPY,
			DOCS,
		);
		if (choice === COPY) {
			await vscode.env.clipboard.writeText(IDB_INSTALL_COMMAND);
			void vscode.window.showInformationMessage(
				'Install command copied — run it in a terminal, then open the simulator again.',
			);
		} else if (choice === DOCS) {
			void vscode.env.openExternal(vscode.Uri.parse('https://fbidb.io/'));
		}
		return false;
	}
	return true;
}

async function pickTarget(): Promise<SimulatorTarget | undefined> {
	const targets = await listBootedSimulators(backendPreference());
	if (targets.length === 0) {
		vscode.window.showErrorMessage(
			'No booted iOS Simulator found. Boot one with the Simulator app or `xcrun simctl boot`.',
		);
		return undefined;
	}
	if (targets.length === 1) {
		return targets[0];
	}
	const pick = await vscode.window.showQuickPick(
		targets.map((t) => ({ label: t.name, description: `iOS ${t.osVersion}`, target: t })),
		{ placeHolder: 'Select a booted simulator' },
	);
	return pick?.target;
}

async function openSimulatorPanel(context: vscode.ExtensionContext): Promise<void> {
	const target = await pickTarget();
	if (!target) {
		return;
	}

	const config = vscode.workspace.getConfiguration('sidesim');
	const { backend, kind } = await openBackend(target.udid, backendPreference(), {
		sandbox: config.get<boolean>('simulator.sandbox', true),
		fps: config.get<number>('simulator.fps', 30),
		scale: config.get<number>('simulator.scale', 1),
	});
	let dims;
	try {
		dims = await backend.describe();
	} catch (err) {
		backend.dispose();
		throw err;
	}

	const panel = vscode.window.createWebviewPanel(
		'sidesim.simulator',
		target.name,
		vscode.ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
		},
	);

	const input = backend.input;

	// Raw frames are ~3 MB each; blindly posting 20/s can outrun the
	// extension→webview channel, queueing frames and lagging the mirror by
	// seconds. Backpressure: keep only the LATEST frame and send the next one
	// only after the webview acknowledged the previous (postMessage resolves).
	// Dropped frames are harmless — each raw frame is complete on its own.
	let disposed = false;
	let pendingFrame: Uint8Array | undefined;
	let sending = false;
	let sentFrames = 0;
	let droppedFrames = 0;
	const pump = async () => {
		if (sending) {
			return;
		}
		sending = true;
		while (pendingFrame && !disposed) {
			const data = pendingFrame;
			pendingFrame = undefined;
			try {
				await panel.webview.postMessage({ type: 'frame', data, sent: ++sentFrames, dropped: droppedFrames });
			} catch {
				break; // panel disposed mid-send
			}
		}
		sending = false;
	};

	const newStream = () =>
		backend.createVideo(
			(chunk) => {
				if (disposed) {
					return; // late chunk from a stream that outlived the panel
				}
				const data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				if (backend.videoMode === 'rbga') {
					if (pendingFrame) {
						droppedFrames++;
					}
					pendingFrame = data;
					void pump();
				} else {
					// h264 is a byte STREAM — chunks must all arrive, in order.
					// try/catch: webview access throws synchronously once disposed.
					try {
						void panel.webview.postMessage({ type: 'video', data });
					} catch {
						/* panel gone */
					}
				}
			},
			(message) => {
				if (!disposed) {
					vscode.window.showErrorMessage(`Simulator video stream ended: ${message}`);
				}
			},
		);
	let stream = newStream();
	let streamStarted = false;

	// rbga renders raw pixels; the webview needs the streamed image size (native
	// resolution scaled) to derive the stride-padded row length per frame.
	const rbgaWidth = Math.round(dims.width * backend.videoScale);
	const rbgaHeight = Math.round(dims.height * backend.videoScale);

	panel.webview.html = getHtml(panel.webview, context.extensionUri, target.name);

	panel.webview.onDidReceiveMessage(async (msg) => {
		try {
			switch (msg.type) {
				case 'ready':
					panel.webview.postMessage({
						type: 'init',
						widthPoints: dims.widthPoints,
						heightPoints: dims.heightPoints,
						name: target.name,
						osVersion: target.osVersion,
						backend: kind,
						videoMode: backend.videoMode,
						livePhases: backend.livePhases,
						multiTouch: backend.multiTouch,
						rbgaWidth,
						rbgaHeight,
					});
					// 'ready' fires again if the webview reloads (crash recovery,
					// Developer: Reload Webviews). Restart rather than double-start,
					// and release any touch the old webview left mid-drag.
					if (streamStarted) {
						await input.cancelTouch();
						stream.stop();
						stream = newStream();
					}
					stream.start();
					streamStarted = true;
					break;
				case 'restartVideo':
					// The webview's decoder hit an unrecoverable state; give it a
					// fresh stream so a new keyframe arrives.
					pendingFrame = undefined;
					stream.stop();
					stream = newStream();
					stream.start();
					panel.webview.postMessage({ type: 'restarted' });
					break;
				case 'tap':
					await input.tap(msg.x, msg.y);
					break;
				case 'touch2':
					await input.touch2(msg.phase, msg.ax, msg.ay, msg.bx, msg.by);
					break;
				case 'touch':
					await input.touch(msg.phase, msg.x, msg.y);
					break;
				case 'swipe':
					await input.swipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.duration);
					break;
				case 'text':
					await input.text(msg.text);
					break;
				case 'key':
					await input.key(msg.code);
					break;
				case 'button':
					await input.button(msg.name);
					break;
				case 'run':
					await runApp();
					break;
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Simulator input failed: ${err instanceof Error ? err.message : err}`);
		}
	});

	// The ▶ Run button. Sidesim doesn't build anything itself — the user names a
	// command (sidesim.run.command) that builds/installs/launches their app by
	// whatever toolchain (Bazel, xcodebuild, …); we run it against this panel's
	// booted device, and the mirror reflects the result live. It runs as a VS
	// Code Task (not a raw terminal) so we can report its exit status back to
	// the panel — the task terminal still gives full output and Ctrl-C.
	let runExecution: vscode.TaskExecution | undefined;
	// True between calling executeTask and seeing our start event — closes the
	// race where the process starts before `await executeTask` assigns
	// runExecution (which would otherwise drop the "Running…" state).
	let pendingRun = false;
	const runApp = async () => {
		const command = vscode.workspace
			.getConfiguration('sidesim', workspaceFolderUri())
			.get<string>('run.command', '')
			.trim();
		if (!command) {
			await offerRunTemplate();
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		const shell = new vscode.ShellExecution(command, {
			cwd: folder?.uri.fsPath,
			env: { SIDESIM_TARGET_UDID: target.udid },
		});
		const task = new vscode.Task(
			{ type: 'sidesim-run' },
			folder ?? vscode.TaskScope.Workspace,
			'Sidesim Run',
			'Sidesim',
			shell,
		);
		// Dedicated, cleared-each-run terminal; don't steal focus from the mirror.
		task.presentationOptions = {
			reveal: vscode.TaskRevealKind.Always,
			panel: vscode.TaskPanelKind.Dedicated,
			clear: true,
			focus: false,
		};
		pendingRun = true;
		try {
			runExecution = await vscode.tasks.executeTask(task);
		} catch (err) {
			pendingRun = false;
			void vscode.window.showErrorMessage(
				`Couldn't start the run command: ${err instanceof Error ? err.message : err}`,
			);
		}
	};

	// Reflect the run task's lifecycle on the panel's ▶ Run button. Guard on
	// `disposed` — a task can outlive the panel, and posting to a dead webview
	// throws. Match on the execution so other tasks in the window don't leak in.
	const runStatusListeners = [
		vscode.tasks.onDidStartTaskProcess((e) => {
			// Normally match on the execution; but if the start event beats the
			// `await executeTask` assignment, fall back to our still-pending
			// sidesim-run task and capture the execution so the end event matches.
			const ours =
				e.execution === runExecution ||
				(pendingRun && !runExecution && e.execution.task.definition.type === 'sidesim-run');
			if (ours && !disposed) {
				pendingRun = false;
				runExecution = e.execution;
				void panel.webview.postMessage({ type: 'runStatus', state: 'running' });
			}
		}),
		vscode.tasks.onDidEndTaskProcess((e) => {
			if (e.execution === runExecution && !disposed) {
				void panel.webview.postMessage({
					type: 'runStatus',
					state: e.exitCode === 0 ? 'ok' : 'fail',
					code: e.exitCode ?? null,
				});
				runExecution = undefined;
				pendingRun = false;
			}
		}),
	];

	panel.onDidDispose(() => {
		disposed = true;
		pendingFrame = undefined;
		stream.stop();
		backend.dispose();
		// Stop listening for run status, but leave the run task itself running:
		// a build/launch in flight (and its terminal output) should survive
		// closing the mirror.
		runStatusListeners.forEach((d) => d.dispose());
	});
}

/**
 * The workspace folder to resolve resource-scoped settings against, if any.
 * Uses the first folder — a panel maps to a device, not a folder, so in a
 * multi-root workspace per-folder run.command overrides on folders 2+ aren't
 * picked up (single-project is the assumed case). Undefined → merged user/
 * workspace settings.
 */
function workspaceFolderUri(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

interface TemplateItem extends vscode.QuickPickItem {
	command?: string;
	system?: string;
}

/**
 * No run command set yet: offer build-system templates (the ones detected in
 * the workspace first), save the pick to settings, and point the user at the
 * placeholder to fill in. Dismissing does nothing.
 */
async function offerRunTemplate(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const root = folder?.uri.fsPath;
	const detected = root ? RUN_TEMPLATES.filter((t) => t.detect(root)).map((t) => t.system) : [];

	const templateItems: TemplateItem[] = RUN_TEMPLATES.map((t) => ({
		label: `$(rocket) ${t.system}`,
		description: detected.includes(t.system) ? 'detected in this workspace' : undefined,
		detail: t.command,
		command: t.command,
		system: t.system,
	}));
	templateItems.sort((a, b) => (a.description ? 0 : 1) - (b.description ? 0 : 1));
	const items: TemplateItem[] = [
		...templateItems,
		{ label: '$(gear) Custom…', detail: 'Open settings and write your own command' },
	];

	const pick = await vscode.window.showQuickPick(items, {
		title: 'Set a build & run command for ▶ Run',
		placeHolder: 'Sidesim runs this to build and launch your app on the simulator',
	});
	if (!pick) {
		return;
	}
	if (!pick.command) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'sidesim.run.command');
		return;
	}

	// A build command is project-specific, so prefer workspace settings; fall
	// back to user settings only when no folder is open. A write failure (e.g.
	// read-only settings) is surfaced here, not left to bubble up as a
	// misleading "Simulator input failed".
	const target = folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	try {
		await vscode.workspace.getConfiguration('sidesim', folder?.uri).update('run.command', pick.command, target);
	} catch (err) {
		void vscode.window.showErrorMessage(
			`Couldn't save the run command to settings: ${err instanceof Error ? err.message : err}`,
		);
		return;
	}

	const EDIT = 'Edit command';
	const choice = await vscode.window.showInformationMessage(
		`Saved a ${pick.system} template to ${folder ? 'workspace' : 'user'} settings — ` +
			'replace the placeholder, then click ▶ Run again.',
		EDIT,
	);
	if (choice === EDIT) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'sidesim.run.command');
	}
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
	const h264Uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'h264.js'));
	const mainUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
	// The title is the simulator's device name — attacker-influenceable data.
	// The CSP already blocks script execution, but don't rely on it as the sole
	// backstop: escape before it reaches the HTML.
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource};">
<link rel="stylesheet" href="${cssUri}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="toolbar">
	<button id="btn-run" class="primary" title="Build & run your app (configure sidesim.run.command)">▶ Run</button>
	<span id="device-label"></span>
	<span class="spacer"></span>
	<button id="btn-home" title="Home button">⌂ Home</button>
	<button id="btn-lock" title="Lock button">⏻ Lock</button>
</div>
<div id="screen-wrap">
	<div id="bezel">
		<canvas id="player"></canvas>
		<div id="touch-layer" tabindex="0"></div>
	</div>
</div>
<div id="status">connecting…</div>
<script src="${h264Uri}"></script>
<script src="${mainUri}"></script>
</body>
</html>`;
}

export function deactivate() {}
