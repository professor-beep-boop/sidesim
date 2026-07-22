/* global JMuxer, acquireVsCodeApi */
(function () {
	const vscode = acquireVsCodeApi();
	const player = document.getElementById('player');
	const touchLayer = document.getElementById('touch-layer');
	const statusEl = document.getElementById('status');
	const deviceLabel = document.getElementById('device-label');

	let widthPoints = 0;
	let heightPoints = 0;
	let jmuxer = null;
	let frameBytes = 0;

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'init') {
			widthPoints = msg.widthPoints;
			heightPoints = msg.heightPoints;
			deviceLabel.textContent = `${msg.name} (iOS ${msg.osVersion})`;
			jmuxer = new JMuxer({
				node: 'player',
				mode: 'video',
				flushingTime: 0,
				fps: 30,
				clearBuffer: true,
				debug: false,
			});
			statusEl.textContent = 'streaming';
		} else if (msg.type === 'video' && jmuxer) {
			const data = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(Object.values(msg.data));
			frameBytes += data.length;
			jmuxer.feed({ video: data });
		}
	});

	// Keep the live edge: if buffered runs ahead of playback, jump forward.
	setInterval(() => {
		if (player.buffered.length > 0) {
			const end = player.buffered.end(player.buffered.length - 1);
			if (end - player.currentTime > 0.5) {
				player.currentTime = end - 0.1;
			}
		}
	}, 1000);

	function toPoints(clientX, clientY) {
		const rect = player.getBoundingClientRect();
		const x = ((clientX - rect.left) / rect.width) * widthPoints;
		const y = ((clientY - rect.top) / rect.height) * heightPoints;
		return {
			x: Math.min(Math.max(x, 0), widthPoints),
			y: Math.min(Math.max(y, 0), heightPoints),
		};
	}

	let downPos = null;
	let downTime = 0;

	touchLayer.addEventListener('mousedown', (e) => {
		touchLayer.focus();
		downPos = toPoints(e.clientX, e.clientY);
		downTime = Date.now();
	});

	touchLayer.addEventListener('mouseup', (e) => {
		if (!downPos) {
			return;
		}
		const up = toPoints(e.clientX, e.clientY);
		const dx = up.x - downPos.x;
		const dy = up.y - downPos.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 8) {
			vscode.postMessage({ type: 'tap', x: up.x, y: up.y });
		} else {
			const duration = Math.min(Math.max((Date.now() - downTime) / 1000, 0.1), 2);
			vscode.postMessage({
				type: 'swipe',
				x1: downPos.x, y1: downPos.y,
				x2: up.x, y2: up.y,
				duration,
			});
		}
		downPos = null;
	});

	// HID usage codes for non-printable keys
	const KEY_CODES = {
		Enter: 40,
		Backspace: 42,
		Tab: 43,
		Escape: 41,
		ArrowRight: 79,
		ArrowLeft: 80,
		ArrowDown: 81,
		ArrowUp: 82,
	};

	touchLayer.addEventListener('keydown', (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) {
			return;
		}
		if (KEY_CODES[e.key] !== undefined) {
			e.preventDefault();
			vscode.postMessage({ type: 'key', code: KEY_CODES[e.key] });
		} else if (e.key.length === 1) {
			e.preventDefault();
			vscode.postMessage({ type: 'text', text: e.key });
		}
	});

	document.getElementById('btn-home').addEventListener('click', () => {
		vscode.postMessage({ type: 'button', name: 'HOME' });
	});
	document.getElementById('btn-lock').addEventListener('click', () => {
		vscode.postMessage({ type: 'button', name: 'LOCK' });
	});

	setInterval(() => {
		if (frameBytes > 0) {
			statusEl.textContent = `streaming (${(frameBytes / 1024).toFixed(0)} KB/s)`;
			frameBytes = 0;
		}
	}, 1000);

	vscode.postMessage({ type: 'ready' });
})();
