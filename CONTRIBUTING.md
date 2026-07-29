# Contributing

Thanks for your interest! This is a small hobby project — contributions are
welcome, expectations are informal.

## Prerequisites

- macOS with full Xcode (the Command Line Tools alone aren't enough — the
  sidecar and the simulators need Xcode proper)
- Node.js + npm
- Homebrew, for Meta's idb frameworks:
  `brew tap facebook/fb && brew trust --tap facebook/fb && brew install idb-companion`

Or just run `./install.sh --no-install`, which checks all of the above with
fix-it messages and builds everything.

## Building & running

```bash
npm ci                      # extension dependencies
(cd sidecar && swift build) # native sidecar (debug)
```

Open the folder in VS Code and press **F5** to launch an Extension Development
Host; boot a simulator and run **iOS Simulator: Open Panel**.

## Tests

| Suite | Command | Needs |
|---|---|---|
| Extension lint + unit | `npm test` | nothing extra |
| Sidecar pure-logic unit | `cd sidecar && swift test` | Xcode + idb-companion (the package graph links the idb frameworks, even though the tests themselves are framework-free) |
| Simulator-in-the-loop | `npm run test:integration` | Xcode + idb-companion, after `npm run compile` and a sidecar `swift build` (boots a sim itself) |

CI runs `npm test` on every PR; the sidecar and integration suites run when
sidecar-related paths change. The `test` check is required to merge.

## Pull requests

- Branch from `main`; PRs are squash-merged.
- Keep each PR to one coherent change, and make sure it builds and tests
  locally before pushing.
- Architecture notes live in [README.md](README.md) and
  [sidecar/README.md](sidecar/README.md) — worth a read before touching the
  video or HID paths, which encode a lot of hard-won behavior.
