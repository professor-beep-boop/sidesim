# vscodesim

An embedded iOS Simulator panel for VS Code: a live video mirror of a booted
simulator with click/tap and keyboard input, streamed into a webview.

![Live iOS Simulator mirrored inside VS Code — opening a photo, swiping, and two-finger pinch-zooming, all rendered from the extension's H.264 stream](docs/demo.gif)

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
  brew install facebook/fb/idb-companion
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

## Running (development)

1. `npm install`
2. `cd sidecar && swift build` (builds the native sidecar for the `sidecar`
   backend; skip it to develop against the `companion`/`cli` backends)
3. Open this folder in VS Code
4. Press `F5` to launch an Extension Development Host
5. Boot a simulator, then run **iOS Simulator: Open Panel** from the Command
   Palette

## Install

### Native sidecar via Homebrew

The native `simhelper` sidecar (best video quality + multitouch) has its own
[tap](https://github.com/professor-beep-boop/homebrew-vscodesim), which also
pulls in the idb-companion frameworks automatically:

```bash
brew install professor-beep-boop/vscodesim/simhelper
```

Pair it with the extension from a [release
VSIX](https://github.com/professor-beep-boop/vscodesim/releases) (install
notes on each release). Note the precedence: a release VSIX bundles its own
version-matched sidecar, which the extension prefers; the brew binary serves
builds without a bundled one (e.g. a future Marketplace VSIX), or set
`VSCODESIM_SIMHELPER="$(brew --prefix)/bin/simhelper"` to use it explicitly —
then `brew upgrade` keeps the native side current.

### Install from source

The quickest way to get the extension into your editor:

```bash
git clone https://github.com/professor-beep-boop/vscodesim.git
cd vscodesim && ./install.sh
```

`install.sh` checks the prerequisites (macOS, Xcode, Node, Homebrew), offers to
install idb-companion if it's missing, builds everything, and installs the
packaged extension into VS Code (or `--editor codium|cursor`; it prefers VS
Code even when `code` isn't on your PATH). Because the sidecar is compiled
locally it carries no quarantine attribute, so Gatekeeper never prompts.
`./install.sh --uninstall` removes it.

## Packaging & installing (manual)

```bash
npm run package        # builds a universal simhelper + produces vscodesim-*.vsix
code --install-extension vscodesim-*.vsix
```

`npm run package` compiles the extension, builds `sidecar/simhelper` as a
**universal** binary (arm64 + x86_64), ad-hoc signs it, stages it at
`bin/simhelper`, and bundles everything into the VSIX.

**Prerequisite on the target machine:** `brew install facebook/fb/idb-companion`. The
sidecar is **not** bundled with the FBSimulatorControl frameworks — it links
against the Homebrew bottle at runtime (rpaths cover both `/opt/homebrew` and
`/usr/local`). Without it, the extension falls back to the `companion`/`cli`
backends. `pipx install fb-idb` additionally enables the `cli` backend.

If you download a prebuilt VSIX (rather than building locally), macOS may
quarantine the sidecar binary; clear it with
`xattr -dr com.apple.quarantine <installed-extension-path>/bin/simhelper`.

## License & disclaimers

MIT — see [LICENSE](LICENSE). Contributions welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md); security reports: see
[SECURITY.md](SECURITY.md).

This project is not affiliated with, endorsed by, or sponsored by Microsoft,
Apple, or Meta. "Visual Studio Code", "iOS", "Xcode", and "iPhone" are
trademarks of their respective owners. The sidecar drives the simulator
through Meta's open-source [idb](https://fbidb.io) frameworks (MIT), which in
turn use private Apple CoreSimulator APIs — standard for local developer
tooling, but this is not App Store material and a major Xcode update can
break it until idb catches up.
