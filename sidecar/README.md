# simhelper

Native simulator sidecar: a Swift executable that owns all CoreSimulator
interaction for the extension — framebuffer video and HID input — over one
long-lived process. It links the prebuilt **FBSimulatorControl /
FBControlCore** frameworks (MIT, from [facebook/idb](https://github.com/facebook/idb))
that the Homebrew `idb-companion` bottle ships, so nothing private is built
from source.

```bash
brew install idb-companion   # provides the frameworks
swift build                  # builds .build/debug/simhelper
```

Override the framework location with `SIMHELPER_FB_FRAMEWORKS` (default
`/opt/homebrew/opt/idb-companion/Frameworks`).

## Why not just use idb_companion?

Two reasons, both measured:

1. **Video.** The framework's own H.264 encoder (which `idb_companion` uses)
   produces an effectively infinite GOP *with B-frames* — under motion, one
   dropped frame corrupts every later frame and the smear never heals.
   `simhelper` pulls **raw BGRA** frames from the framebuffer and encodes
   H.264 itself with VideoToolbox: **no B-frames** (`AllowFrameReordering`
   off) and a **keyframe every 2 s**, so drops can only skip, never smear
   (verified: `I P×39 I P×39 …`, `has_b_frames=0`). ~190 KB/s vs ~64 MB/s
   for raw frames.
2. **Input.** In-process HID with no gRPC hop, plus direct access to the
   Indigo keyboard for text (ASCII→HID usage map with shift handling).

## Protocol

JSON-RPC over stdio. Requests are JSON lines on stdin:

```json
{"id": 1, "method": "startVideo", "params": {"udid": "…", "streamId": 7, "fps": 20, "scaleFactor": 0.5, "encoding": "h264"}}
```

stdout carries two interleaved message kinds, demuxed by first byte:

- `0x0a`-terminated JSON lines — replies `{"id":N,"result":…}` /
  `{"id":N,"error":"…"}` and events `{"event":"ready"}` etc.
- Binary video frames — `[0x00][u32be streamId][u32be length][payload]`.
  A JSON line never begins with `0x00`.

### Methods

| Method | Params | Notes |
| --- | --- | --- |
| `listDevices` | — | booted simulators: `{udid, name, state, osVersion}` |
| `describe` | `udid` | `{width, height, density, widthPoints, heightPoints}` |
| `startVideo` | `udid, streamId, fps, scaleFactor, encoding (h264\|bgra), bitrate?` | swaps the frame sink (fresh encoder → immediate keyframe); returns `{width, height}`. The underlying framebuffer stream is created once per session — CoreSimulator's cached stream object cannot be restarted — so `scaleFactor`/`fps` are fixed until `detach`. |
| `stopVideo` | `udid` | |
| `tap` | `udid, x, y` | points |
| `touch` | `udid, phase (down\|move\|up), x, y` | live phases; a `move` is a down-state event |
| `swipe` | `udid, x1, y1, x2, y2, durationSec` | interpolated at 60 steps/s |
| `key` | `udid, code` | USB HID usage code, down+up |
| `text` | `udid, value` | ASCII typed via HID keyboard |
| `button` | `udid, name (HOME\|LOCK\|SIRI\|SIDE_BUTTON\|APPLE_PAY)` | |
| `detach` | `udid` | releases HID/stream for that simulator |

Shutdown: close stdin. In-flight touches are released (synthetic up), streams
stopped, HID disconnected.

## Caveats

- macOS only; needs Xcode's CoreSimulator (the loader aborts cleanly if
  missing).
- The frameworks bundle-load Xcode private frameworks; a major Xcode update
  can break them — the same risk `idb_companion` itself carries, and the
  extension falls back to the companion/CLI backends if the sidecar dies.
- Two-finger gestures (pinch/rotate) need a hand-built Indigo message (the
  public FBSimulatorHID API is single-touch); tracked upstream in the epic.
