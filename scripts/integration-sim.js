#!/usr/bin/env node
// Simulator-in-the-loop integration test for the native simhelper sidecar.
//
// Unlike the SimHelperCore unit tests (pure geometry/keymap logic, run on any
// macOS), this drives the FULL stack against a REAL booted simulator: it lists
// devices, describes the screen, streams live H.264 out of the VideoToolbox
// encoder, taps, and runs a two-finger pinch. It only passes on a machine that
// actually has CoreSimulator + the idb frameworks + a booted sim — i.e. the
// self-hosted runner. Hosted CI can't run it, which is exactly why it lives on
// its own workflow.
//
// Run by hand:  npm run compile && node scripts/integration-sim.js
'use strict';

const { execFileSync } = require('child_process');
const { listBootedViaSidecar, SidecarBackend, findSidecarBinary } = require('../out/sidecar.js');

// Hard watchdog: a wedged sidecar or sim must never hang the runner. Force a
// nonzero exit well before any GitHub job timeout would kill us server-side.
const WATCHDOG_MS = 90_000;
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
	// Several self-hosted runners share this Mac's global device set, so the
	// booted list can include a NEIGHBOURING repo's sim (custom-named, e.g.
	// "nitrate-diag"). Prefer a stock-named "iPhone <model>" — the kind
	// ensureBooted() brings up — so we don't stream/tap on someone else's sim.
	const target = booted.find((d) => /^iPhone /i.test(d.name)) ?? booted[0];
	console.log('  target:', `${target.name} ${target.udid}`);

	const backend = await SidecarBackend.open(target.udid);
	try {
		console.log('\n[2] describe');
		const dims = await backend.describe();
		console.log('  dims:', JSON.stringify(dims));
		assert(dims.width > 0 && dims.height > 0, 'screen has positive dimensions');

		console.log('\n[3] startVideo (H.264, ~4s)');
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
		await sleep(4000);
		video.stop();
		console.log(`  chunks=${chunks} bytes=${bytes} firstBytes=${firstFewHex} error=${videoError ?? 'none'}`);
		assert(!videoError, 'no video error reported');
		// A live 30fps stream over 4s yields many frames and real payload; require
		// a floor comfortably below that so a slow boot doesn't false-fail.
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
