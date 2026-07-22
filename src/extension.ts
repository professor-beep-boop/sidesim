import * as vscode from 'vscode';
import {
	listBootedSimulators,
	getScreenDimensions,
	VideoStream,
	InputController,
	SimulatorTarget,
} from './simulator';

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
	const targets = await listBootedSimulators();
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
	const dims = await getScreenDimensions(target.udid);

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

	const input = new InputController(target.udid);
	const stream = new VideoStream(
		target.udid,
		(chunk) => {
			panel.webview.postMessage({ type: 'video', data: new Uint8Array(chunk) });
		},
		(message) => {
			vscode.window.showErrorMessage(`Simulator video stream ended: ${message}`);
		},
	);

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
					});
					stream.start();
					break;
				case 'tap':
					await input.tap(msg.x, msg.y);
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

	panel.onDidDispose(() => stream.stop());
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
	const jmuxerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'jmuxer.min.js'));
	const mainUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; media-src blob:;">
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
	<video id="player" autoplay muted playsinline></video>
	<div id="touch-layer" tabindex="0"></div>
</div>
<div id="status">connecting…</div>
<script src="${jmuxerUri}"></script>
<script src="${mainUri}"></script>
</body>
</html>`;
}

export function deactivate() {}
