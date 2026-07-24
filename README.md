# vscodesim

An embedded iOS Simulator panel for VS Code: a live video mirror of a booted
simulator with click/tap and keyboard input, streamed into a webview.

## Features

- **iOS Simulator: Open Panel** command — mirrors a booted simulator and
  forwards clicks, drags, and keystrokes into it.
- Two connection backends (see below).
- **Two-finger pinch & rotate** on the `sidecar` backend: hold **⌥ Option** and drag (two fingers symmetric about the screen centre, like the iOS Simulator app).

### Video pipeline

The `companion` backend streams **raw BGRA frames** (idb `RBGA` format) and
draws them to a `<canvas>` with `putImageData`. This is deliberate: the
simulator's H.264 encoder produces an effectively infinite GOP (one keyframe)
*with B-frames*, so under motion a single dropped/late frame breaks the
reference chain and every decoder — WebCodecs or ffmpeg alike — smears the
picture permanently. Raw frames are intra-only, so they can't smear and hold a
steady frame rate under motion. Frames are streamed at half resolution to keep
the raw bandwidth reasonable; the renderer derives the stride-padded row length
from each frame's byte length.

The `cli` backend still delivers H.264, which the webview decodes with
**WebCodecs** (`VideoDecoder`) — usable for light motion but subject to the
smearing above.

## Requirements

- macOS with Xcode and at least one **booted** iOS Simulator.
- [`idb` / `idb_companion`](https://fbidb.io) on `PATH`:
  ```bash
  brew install idb-companion
  pipx install fb-idb   # provides the `idb` CLI
  ```

## Backends

The panel can talk to a simulator two ways, selected by
`vscodesim.simulator.backend`:

| Value | How it works | Trade-off |
| --- | --- | --- |
| `auto` (default) | Prefer `sidecar`, then `companion`, then `cli` | Best available |
| `sidecar` | Native `simhelper` process (see `sidecar/`): full-resolution H.264 encoded correctly (no B-frames, 2s keyframes) + in-process HID including native text | Best quality and latency; needs `swift build` in `sidecar/` |
| `companion` | Persistent gRPC connection to `idb_companion` — framebuffer H.264 video and a held-open HID input stream | Low latency; taps are instant |
| `cli` | `idb video-stream` for video, one `idb ui …` process per input event | Simple; ~0.5s per-tap latency |

The `companion` backend launches one `idb_companion` per open panel
(`--grpc-port 0`, auto-assigned) and disposes it when the panel closes. Text
entry is delegated to `idb ui text` on both backends so character→keycode
mapping stays correct.

## Running

1. `npm install`
2. Open this folder in VS Code
3. Press `F5` to launch an Extension Development Host
4. Boot a simulator, then run **iOS Simulator: Open Panel** from the Command
   Palette
