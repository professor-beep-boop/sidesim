/* global H264, acquireVsCodeApi, VideoDecoder, EncodedVideoChunk */
(function () {
	const vscode = acquireVsCodeApi();
	const canvas = document.getElementById('player');
	const ctx = canvas.getContext('2d', { alpha: false });
	const touchLayer = document.getElementById('touch-layer');
	const statusEl = document.getElementById('status');
	const deviceLabel = document.getElementById('device-label');

	const BUILD = 'raw4';

	let widthPoints = 0;
	let heightPoints = 0;
	let backend = '';
	let videoMode = '';

	let frames = 0;
	let bytes = 0;
	let renderMsTotal = 0;
	let dropped = 0;
	let payloadKind = ''; // 'bin' when frames arrive as typed arrays, 'json' if serialized

	statusEl.textContent = `[${BUILD}] connecting…`;

	// ---- raw BGRA rendering (companion) ----
	// Frames are stride-padded BGRA; derive the row stride from the frame length.
	let rbgaW = 0;
	let rbgaH = 0;
	let stride = 0; // bytes per source row
	let imageData = null;

	// Geometry of the incoming frames: derived from the frame byte length and
	// re-derived whenever it changes (stream restart, device rotation). Tries
	// both orientations since rotation swaps width/height.
	let geomLen = 0; // frame length the current geometry was derived from
	let geomW = 0;
	let geomH = 0;

	function tryDerive(w, h, len) {
		for (let ph = h; ph <= h + 64; ph++) {
			if (len % ph === 0) {
				const s = len / ph;
				if (s % 4 === 0 && s >= w * 4 && s < w * 4 + 256) {
					return s;
				}
			}
		}
		return 0;
	}

	function deriveGeometry(len) {
		let s = tryDerive(rbgaW, rbgaH, len);
		if (s) {
			geomW = rbgaW;
			geomH = rbgaH;
		} else {
			s = tryDerive(rbgaH, rbgaW, len); // rotated
			if (s) {
				geomW = rbgaH;
				geomH = rbgaW;
			} else {
				geomW = rbgaW;
				geomH = rbgaH;
				s = rbgaW * 4; // last resort: assume unpadded portrait
			}
		}
		stride = s;
		geomLen = len;
		canvas.width = geomW;
		canvas.height = geomH;
		imageData = null;
	}

	// Fast path: wrap the BGRA buffer in a WebCodecs VideoFrame (native swizzle,
	// stride-aware) and drawImage it. Falls back to a JS pixel loop. A transient
	// per-frame failure (e.g. one odd-sized frame) must not disable the fast
	// path permanently — only repeated consecutive failures do.
	let useVideoFrame = typeof VideoFrame !== 'undefined';
	let vfFailures = 0;
	let renderPath = '';

	function renderRaw(frame) {
		if (frame.length !== geomLen) {
			deriveGeometry(frame.length);
		}
		if (useVideoFrame) {
			let vf;
			try {
				// BGRX: ignore the source alpha channel (matches the JS path's 255).
				vf = new VideoFrame(frame, {
					format: 'BGRX',
					codedWidth: geomW,
					codedHeight: geomH,
					timestamp: 0,
					layout: [{ offset: 0, stride }],
				});
				ctx.drawImage(vf, 0, 0);
				vfFailures = 0;
				renderPath = 'vf';
				frames++;
				return;
			} catch (err) {
				vfFailures++;
				console.warn(`VideoFrame render failed (${vfFailures}):`, err);
				if (vfFailures >= 3) {
					console.warn('disabling VideoFrame path; using pixel loop');
					useVideoFrame = false;
				}
			} finally {
				if (vf) {
					vf.close();
				}
			}
			if (useVideoFrame) {
				return; // transient failure: skip this frame, keep the fast path
			}
		}
		if (!imageData) {
			imageData = ctx.createImageData(geomW, geomH);
		}
		const src = frame; // Uint8Array, BGRA, stride-padded
		const dst = imageData.data; // RGBA, tightly packed
		for (let y = 0; y < geomH; y++) {
			let si = y * stride;
			let di = y * geomW * 4;
			for (let x = 0; x < geomW; x++) {
				dst[di] = src[si + 2]; // R
				dst[di + 1] = src[si + 1]; // G
				dst[di + 2] = src[si]; // B
				dst[di + 3] = 255;
				si += 4;
				di += 4;
			}
		}
		ctx.putImageData(imageData, 0, 0);
		renderPath = 'px';
		frames++;
	}

	// ---- H.264 decoding (idb CLI fallback) ----
	const parser = typeof H264 !== 'undefined' ? new H264.AnnexBParser() : null;
	let decoder = null;
	let configured = false;
	let seenKey = false;
	let ts = 0;
	const TS_STEP = Math.round(1e6 / 60);

	let restarts = 0;
	const MAX_RESTARTS = 5;

	// A fatal decoder error closes the VideoDecoder; without recovery the mirror
	// freezes forever. Reset decode state and ask the extension for a fresh
	// stream (which starts with new SPS/PPS + keyframe).
	function recoverDecoder(reason) {
		console.error('decoder unrecoverable:', reason);
		try {
			if (decoder && decoder.state !== 'closed') {
				decoder.close();
			}
		} catch {
			/* already closed */
		}
		decoder = null;
		configured = false;
		seenKey = false;
		if (parser) {
			parser.reset();
		}
		if (restarts >= MAX_RESTARTS) {
			statusEl.textContent = `[${BUILD}] decode failing; gave up after ${restarts} restarts: ${reason}`;
			return;
		}
		restarts++;
		statusEl.textContent = `[${BUILD}] recovering (${restarts})…`;
		vscode.postMessage({ type: 'restartVideo' });
	}

	function makeDecoder() {
		return new VideoDecoder({
			output: (f) => {
				try {
					if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
						canvas.width = f.displayWidth;
						canvas.height = f.displayHeight;
					}
					ctx.drawImage(f, 0, 0);
					frames++;
				} finally {
					f.close();
				}
			},
			error: (e) => {
				recoverDecoder(e.message);
			},
		});
	}

	function decodeH264(data) {
		if (!parser || typeof VideoDecoder === 'undefined') {
			statusEl.textContent = `[${BUILD}] WebCodecs unavailable`;
			return;
		}
		for (const u of parser.feed(data)) {
			if (!decoder) {
				decoder = makeDecoder();
			}
			if (!configured) {
				if (!parser.codec) {
					continue;
				}
				decoder.configure({ codec: parser.codec });
				configured = true;
			}
			if (!seenKey) {
				if (!u.key) {
					continue;
				}
				seenKey = true;
			}
			try {
				decoder.decode(new EncodedVideoChunk({ type: u.key ? 'key' : 'delta', timestamp: ts, data: u.data }));
				ts += TS_STEP;
			} catch (err) {
				recoverDecoder(err instanceof Error ? err.message : String(err));
				return;
			}
		}
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'init') {
			widthPoints = msg.widthPoints;
			heightPoints = msg.heightPoints;
			backend = msg.backend || '';
			videoMode = msg.videoMode || 'h264';
			rbgaW = msg.rbgaWidth || 0;
			rbgaH = msg.rbgaHeight || 0;
			deviceLabel.textContent = `${msg.name} (iOS ${msg.osVersion})`;
			statusEl.textContent = `[${BUILD}] streaming…`;
		} else if (msg.type === 'frame') {
			const data = toBytes(msg.data);
			dropped = msg.dropped || 0;
			bytes += data.length;
			const t0 = performance.now();
			renderRaw(data);
			renderMsTotal += performance.now() - t0;
		} else if (msg.type === 'video') {
			const data = toBytes(msg.data);
			bytes += data.length;
			decodeH264(data);
		} else if (msg.type === 'restarted') {
			// Fresh stream incoming: decode state was already reset in
			// recoverDecoder; nothing further to do.
			statusEl.textContent = `[${BUILD}] streaming…`;
		}
	});

	function toBytes(d) {
		if (d instanceof Uint8Array) {
			payloadKind = 'bin';
			return d;
		}
		if (d instanceof ArrayBuffer) {
			payloadKind = 'bin';
			return new Uint8Array(d);
		}
		// Fallback: the channel JSON-serialized the array into a plain object.
		// Slow, but keeps the picture correct — and the status line flags it.
		payloadKind = 'json';
		return new Uint8Array(Object.values(d));
	}

	function toPoints(clientX, clientY) {
		const rect = canvas.getBoundingClientRect();
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
		const dist = Math.hypot(up.x - downPos.x, up.y - downPos.y);
		if (dist < 8) {
			vscode.postMessage({ type: 'tap', x: up.x, y: up.y });
		} else {
			const duration = Math.min(Math.max((Date.now() - downTime) / 1000, 0.1), 2);
			vscode.postMessage({ type: 'swipe', x1: downPos.x, y1: downPos.y, x2: up.x, y2: up.y, duration });
		}
		downPos = null;
	});

	const KEY_CODES = {
		Enter: 40, Backspace: 42, Tab: 43, Escape: 41,
		ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
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
		const via = backend ? ` · ${backend}` : '';
		const mode = videoMode ? ` · ${videoMode}` : '';
		const mb = (bytes / 1024 / 1024).toFixed(1);
		const rms = frames > 0 ? ` · ${(renderMsTotal / frames).toFixed(1)}ms/frame` : '';
		const drop = dropped > 0 ? ` · dropped ${dropped}` : '';
		const kind = payloadKind ? ` · ${payloadKind}` : '';
		const path = renderPath ? ` · ${renderPath}` : '';
		statusEl.textContent = `[${BUILD}] ${frames} fps · ${mb} MB/s${via}${mode}${rms}${drop}${kind}${path}`;
		frames = 0;
		bytes = 0;
		renderMsTotal = 0;
	}, 1000);

	vscode.postMessage({ type: 'ready' });
})();
