/*
 * Streaming H.264 Annex-B reframer.
 *
 * idb_companion delivers a raw Annex-B byte stream in arbitrarily-chunked gRPC
 * messages: NAL units are split across chunks and several may share one chunk.
 * WebCodecs needs one EncodedVideoChunk per access unit (picture), correctly
 * tagged key/delta, with parameter sets in-band. This reassembles that.
 *
 * Assumes one slice (one VCL NAL) per picture, which is what the simulator
 * framebuffer encoder produces.
 */
(function (root) {
	const START = new Uint8Array([0, 0, 0, 1]);

	// NAL unit types (nal_unit_type, low 5 bits of the header byte)
	const NAL_SEI = 6;
	const NAL_SPS = 7;
	const NAL_PPS = 8;
	const NAL_AUD = 9;
	const isVcl = (t) => t >= 1 && t <= 5;
	const NAL_IDR = 5;

	function findStart(buf, from) {
		for (let i = from; i + 3 < buf.length; i++) {
			if (buf[i] === 0 && buf[i + 1] === 0) {
				if (buf[i + 2] === 1) {
					return { pos: i, len: 3 };
				}
				if (buf[i + 2] === 0 && buf[i + 3] === 1) {
					return { pos: i, len: 4 };
				}
			}
		}
		return null;
	}

	function toHex2(n) {
		return n.toString(16).padStart(2, '0');
	}

	class AnnexBParser {
		constructor() {
			this.buf = new Uint8Array(0);
			this.pending = []; // NAL payloads (with header byte) awaiting a VCL to close the AU
			this.pendingKey = false;
			this.codec = null; // e.g. "avc1.640033", set once the first SPS is seen
		}

		reset() {
			this.buf = new Uint8Array(0);
			this.pending = [];
			this.pendingKey = false;
			// keep codec: SPS rarely changes and the next stream re-sends it anyway
		}

		/** Feed a chunk; returns an array of { data: Uint8Array, key: boolean }. */
		feed(chunk) {
			const merged = new Uint8Array(this.buf.length + chunk.length);
			merged.set(this.buf, 0);
			merged.set(chunk, this.buf.length);
			this.buf = merged;

			const units = [];
			let first = findStart(this.buf, 0);
			if (!first) {
				return units;
			}
			let cur = first;
			while (cur) {
				const next = findStart(this.buf, cur.pos + cur.len);
				if (!next) {
					break; // NAL incomplete; wait for more bytes
				}
				const nal = this.buf.subarray(cur.pos + cur.len, next.pos);
				this.onNal(nal, units);
				cur = next;
			}
			// keep the trailing, still-incomplete NAL (from the last start code on)
			this.buf = this.buf.slice(cur.pos);
			return units;
		}

		onNal(nal, units) {
			if (nal.length === 0) {
				return;
			}
			const type = nal[0] & 0x1f;
			if (type === NAL_AUD) {
				return; // access-unit delimiter: not needed by WebCodecs
			}
			if (type === NAL_SPS && !this.codec && nal.length >= 4) {
				this.codec = 'avc1.' + toHex2(nal[1]) + toHex2(nal[2]) + toHex2(nal[3]);
			}
			if (type === NAL_SPS || type === NAL_PPS || type === NAL_SEI) {
				this.pending.push(nal);
				return;
			}
			if (isVcl(type)) {
				this.pending.push(nal);
				if (type === NAL_IDR) {
					this.pendingKey = true;
				}
				units.push({ data: assemble(this.pending), key: this.pendingKey });
				this.pending = [];
				this.pendingKey = false;
			}
		}
	}

	function assemble(nals) {
		let size = 0;
		for (const n of nals) {
			size += START.length + n.length;
		}
		const out = new Uint8Array(size);
		let off = 0;
		for (const n of nals) {
			out.set(START, off);
			off += START.length;
			out.set(n, off);
			off += n.length;
		}
		return out;
	}

	const H264 = { AnnexBParser };
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = H264;
	}
	root.H264 = H264;
})(typeof globalThis !== 'undefined' ? globalThis : this);
