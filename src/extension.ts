import * as vscode from 'vscode';
import {
	listBootedSimulators,
	openBackend,
	SimulatorTarget,
	BackendPreference,
} from './simulator';

function backendPreference(): BackendPreference {
	const value = vscode.workspace
		.getConfiguration('vscodesim')
		.get<string>('simulator.backend', 'auto');
	return value === 'companion' || value === 'cli' ? value : 'auto';
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('vscodesim.openSimulator', async () => {
			try {
				await openSimulatorPanel(context);
			} catch (err) {
				vscode.window.showErrorMessage(`iOS Simulator: ${err instanceof Error ? err.message : err}`);
			}
		}),
	);
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

	const { backend, kind } = await openBackend(target.udid, backendPreference());
	let dims;
	try {
		dims = await backend.describe();
	} catch (err) {
		backend.dispose();
		throw err;
	}

	const panel = vscode.window.createWebviewPanel(
		'vscodesim.simulator',
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
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Simulator input failed: ${err instanceof Error ? err.message : err}`);
		}
	});

	panel.onDidDispose(() => {
		disposed = true;
		pendingFrame = undefined;
		stream.stop();
		backend.dispose();
	});
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
	const h264Uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'h264.js'));
	const mainUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource};">
<link rel="stylesheet" href="${cssUri}">
<title>${title}</title>
</head>
<body>
<div id="toolbar">
	<span id="device-label"></span>
	<button id="btn-home" title="Home">Home</button>
	<button id="btn-lock" title="Lock">Lock</button>
</div>
<div id="screen-wrap">
	<canvas id="player"></canvas>
	<div id="touch-layer" tabindex="0"></div>
</div>
<div id="status">connecting…</div>
<script src="${h264Uri}"></script>
<script src="${mainUri}"></script>
</body>
</html>`;
}

export function deactivate() {}
