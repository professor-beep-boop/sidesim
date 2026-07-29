#!/usr/bin/env node
// Simulator-in-the-loop integration test for the native simhelper sidecar.
//
// Unlike the SimHelperCore unit tests (pure geometry/keymap logic, run on any
// macOS), this drives the FULL stack against a REAL booted simulator: it lists
// devices, describes the screen, streams live H.264 out of the VideoToolbox
// encoder, taps, and runs a two-finger pinch. It runs on the hosted macOS
// integration workflow (it boots a simulator itself; cold VMs need the larger
// VSCODESIM_*_TIMEOUT budgets the workflow sets) and on any Mac with Xcode +
// idb-companion.
//
// Run by hand:  npm run compile && node scripts/integration-sim.js
'use strict';

const { execFileSync } = require('child_process');
const { listBootedViaSidecar, SidecarBackend, findSidecarBinary } = require('../out/sidecar.js');
const { setLogSink } = require('../out/log.js');

// Surface backend logs (sidecar stderr tail, crash/restart notices) in CI output.
setLogSink((line) => console.error(`  [sidecar] ${line}`));

// Hard watchdog: a wedged sidecar or sim must never hang the runner. Force a
// nonzero exit well before any GitHub job timeout would kill us server-side.
// Overridable for cold CI VMs, where the simulator boot alone can eat a minute.
const WATCHDOG_MS = Number(process.env.VSCODESIM_TEST_WATCHDOG_MS) || 90_000;
const watchdog = setTimeout(() => {
	console.error(`FATAL: integration test exceeded ${WATCHDOG_MS}ms — forcing exit`);
	process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
	if (!cond) {
		throw new Error(`assertion failed: ${msg}`);
	}
	console.log(`  ok — ${msg}`);
}

/** Reuse an already-booted iPhone sim, or boot the newest available one. */
function ensureBooted() {
	const listed = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }));
	const all = Object.values(listed.devices).flat();
	const booted = all.find((d) => d.state === 'Booted' && /iPhone/i.test(d.name));
	if (booted) {
		console.log(`Reusing booted sim: ${booted.name} (${booted.udid})`);
		return;
	}
	const candidate = all
		.filter((d) => d.isAvailable && /iPhone/i.test(d.name))
		.pop();
	if (!candidate) {
		throw new Error('no available iPhone simulator to boot');
	}
	console.log(`Booting ${candidate.name} (${candidate.udid})…`);
	execFileSync('xcrun', ['simctl', 'boot', candidate.udid], { stdio: 'inherit' });
	execFileSync('xcrun', ['simctl', 'bootstatus', candidate.udid], { stdio: 'inherit' });
}

async function main() {
	console.log('simhelper binary:', findSidecarBinary() ?? '(not found)');
	assert(findSidecarBinary(), 'simhelper binary resolves');

	ensureBooted();

	console.log('\n[1] listDevices');
	const booted = await listBootedViaSidecar();
	console.log('  booted:', booted.map((d) => `${d.name} ${d.udid}`).join(', ') || '(none)');
	assert(booted.length >= 1, 'at least one booted simulator');
	// On a developer's Mac the booted list can include a custom-named sim that
	// belongs to something else entirely. Prefer a stock-named "iPhone <model>"
	// — the kind ensureBooted() brings up — so we don't stream/tap on it.
	// (Moot on hosted CI, where each VM's device set is isolated.)
	const target = booted.find((d) => /^iPhone /i.test(d.name)) ?? booted[0];
	console.log('  target:', `${target.name} ${target.udid}`);

	const backend = await SidecarBackend.open(target.udid);
	try {
		console.log('\n[2] describe');
		const dims = await backend.describe();
		console.log('  dims:', JSON.stringify(dims));
		assert(dims.width > 0 && dims.height > 0, 'screen has positive dimensions');

		console.log('\n[3] startVideo (H.264)');
		let chunks = 0;
		let bytes = 0;
		let firstFewHex = '';
		let videoError;
		const video = backend.createVideo(
			(chunk) => {
				chunks++;
				bytes += chunk.length;
				if (!firstFewHex) {
					firstFewHex = chunk.subarray(0, 8).toString('hex');
				}
			},
			(msg) => {
				videoError = msg;
			},
		);
		video.start();
		// The framebuffer pushes frames only when the screen CHANGES; a freshly
		// booted headless sim can sit perfectly static and deliver nothing. Poke
		// the screen while waiting for the first chunk (cold CI VMs also take a
		// while to spin up the encoder pipeline), then sample for 4s of activity.
		const firstFrameBudget = Number(process.env.VSCODESIM_TEST_FIRSTFRAME_MS) || 15_000;
		let pokeErrLogged = false;
		const poke = () =>
			backend.input.tap(Math.floor(dims.width / 2), Math.floor(dims.height / 2)).catch((e) => {
				// Swallow (a rejected tap must not kill the test) but surface the
				// first failure — if every poke rejects, that's the smoking gun.
				if (!pokeErrLogged) {
					pokeErrLogged = true;
					console.error('  poke failed:', e instanceof Error ? e.message : e);
				}
			});
		const t0 = Date.now();
		let lastPoke = 0;
		while (chunks === 0 && !videoError && Date.now() - t0 < firstFrameBudget) {
			if (Date.now() - lastPoke > 1200) {
				lastPoke = Date.now();
				void poke();
			}
			await sleep(250);
		}
		console.log(
			chunks
				? `  first frame after ${((Date.now() - t0) / 1000).toFixed(1)}s`
				: `  no first frame within ${firstFrameBudget}ms`,
		);
		for (let i = 0; i < 4; i++) {
			void poke(); // keep the screen changing so frames keep flowing
			await sleep(1000);
		}
		video.stop();
		console.log(`  chunks=${chunks} bytes=${bytes} firstBytes=${firstFewHex} error=${videoError ?? 'none'}`);
		assert(!videoError, 'no video error reported');
		// With the screen being poked throughout the 4s sample window, a live
		// stream yields many frames; this floor sits comfortably below that.
		assert(chunks >= 5, 'received multiple video frames');
		assert(bytes > 10_000, 'received a non-trivial amount of encoded video');

		console.log('\n[4] tap (screen center)');
		await backend.input.tap(Math.floor(dims.width / 2), Math.floor(dims.height / 2));
		assert(true, 'tap returned without error');

		console.log('\n[5] two-finger pinch (multitouch)');
		const cx = dims.width / 2;
		const cy = dims.height / 2;
		backend.input.touch2('down', cx - 40, cy, cx + 40, cy);
		for (let i = 1; i <= 6; i++) {
			const spread = 40 + i * 30;
			backend.input.touch2('move', cx - spread, cy, cx + spread, cy);
			await sleep(30);
		}
		backend.input.touch2('up', cx - 220, cy, cx + 220, cy);
		await sleep(100);
		assert(true, 'pinch gesture streamed without error');

		console.log('\nAll integration checks passed.');
	} finally {
		backend.dispose();
		clearTimeout(watchdog);
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error('\nINTEGRATION TEST FAILED:', err && err.stack ? err.stack : err);
		process.exit(1);
	},
);
