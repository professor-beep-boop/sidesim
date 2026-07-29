import * as vscode from 'vscode';
import {
	listBootedSimulators,
	openBackend,
	SimulatorTarget,
	BackendPreference,
} from './simulator';
import { idbFrameworksAvailable, IDB_INSTALL_COMMAND } from './sidecar';
import { setLogSink } from './log';

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
	// booted device, and the mirror reflects the result live. A dedicated
	// terminal gives full output / Ctrl-C and is reused across clicks.
	let runTerminal: vscode.Terminal | undefined;
	const runApp = async () => {
		const command = vscode.workspace
			.getConfiguration('sidesim', workspaceFolderUri())
			.get<string>('run.command', '')
			.trim();
		if (!command) {
			const CONFIGURE = 'Configure';
			const choice = await vscode.window.showInformationMessage(
				'Set `sidesim.run.command` to build & launch your app (e.g. `bazel run //app:MyApp`). ' +
					'The booted device UDID is available to the command as $SIDESIM_TARGET_UDID.',
				CONFIGURE,
			);
			if (choice === CONFIGURE) {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'sidesim.run.command');
			}
			return;
		}
		// Reuse the panel's terminal unless it has exited; recreate so the env
		// (target UDID) is always current for this panel's device.
		if (!runTerminal || runTerminal.exitStatus !== undefined) {
			runTerminal = vscode.window.createTerminal({
				name: 'Sidesim Run',
				env: { SIDESIM_TARGET_UDID: target.udid },
			});
			context.subscriptions.push(runTerminal);
		}
		runTerminal.show(true);
		runTerminal.sendText(command);
	};

	panel.onDidDispose(() => {
		disposed = true;
		pendingFrame = undefined;
		stream.stop();
		backend.dispose();
		// Leave runTerminal alive on purpose: a build/launch in flight (and its
		// output) should survive closing the mirror.
	});
}

/** The workspace folder to resolve resource-scoped settings against, if any. */
function workspaceFolderUri(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
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
