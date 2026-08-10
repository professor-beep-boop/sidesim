#!/usr/bin/env bash
#
# install.sh — build the sidesim extension from this checkout and install it
# into VS Code (or a compatible editor).
#
#   git clone https://github.com/professor-beep-boop/sidesim.git
#   cd sidesim && ./install.sh
#
# What it does: checks the prerequisites below (with fix-it instructions when
# one is missing), builds the universal simhelper sidecar + bundles the
# extension (`vsce package`, which runs the full vscode:prepublish pipeline),
# and installs the resulting .vsix with the editor's CLI. A locally built
# binary carries no quarantine xattr, so Gatekeeper never prompts — this is
# the same reason a Homebrew from-source install "just works".
#
# Prerequisites:
#   - macOS with Xcode (the simulators themselves need it anyway)
#   - Node.js + npm
#   - Homebrew, for Meta's idb-companion (ships the FBSimulatorControl
#     frameworks the sidecar links against — offered automatically below)
#
# Usage:
#   ./install.sh                 build + install
#   ./install.sh --no-install    build + package only (leaves the .vsix)
#   ./install.sh --uninstall     remove the extension from the editor
#   ./install.sh --yes           don't prompt before `brew install idb-companion`
#   ./install.sh --editor cursor use a specific editor CLI (default: `code` on
#                                PATH, then VS Code.app's bundled CLI, then a
#                                codium/cursor CLI, then a fork app bundle)
set -euo pipefail
cd "$(dirname "$0")"

EXT_ID="jbmorgan.sidesim"
IDB_INSTALL_CMD='brew tap facebook/fb && brew trust --tap facebook/fb && brew install idb-companion'

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

ASSUME_YES=0
NO_INSTALL=0
UNINSTALL=0
EDITOR_CLI=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--yes) ASSUME_YES=1; shift ;;
		--no-install) NO_INSTALL=1; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		--editor) [[ $# -ge 2 ]] || die "--editor requires a value"; EDITOR_CLI="$2"; shift 2 ;;
		# Print the header comment: every leading #-line after the shebang.
		-h|--help) awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
done

# VS Code ships its CLI inside the app bundle; it's only on PATH if the user
# ran "Shell Command: Install 'code' command in PATH" — many never have.
VSCODE_APP_CLIS=(
	"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
	"$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
)

# Same story for VS Code forks (Sidesim runs in them — Cursor is verified): the
# CLI is inside the bundle and may never have been linked onto PATH.
FORK_APP_CLIS=(
	"/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
	"$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
	"/Applications/VSCodium.app/Contents/Resources/app/bin/codium"
	"$HOME/Applications/VSCodium.app/Contents/Resources/app/bin/codium"
)

find_editor() {
	if [[ -n "$EDITOR_CLI" ]]; then
		command -v "$EDITOR_CLI" >/dev/null || die "editor CLI '$EDITOR_CLI' not found on PATH"
		return
	fi
	# Prefer VS Code even when its CLI isn't on PATH — falling straight through
	# to codium/cursor silently installs into a DIFFERENT editor than the one
	# most users mean (this bit us in testing: PATH had cursor but not code).
	if command -v code >/dev/null; then
		EDITOR_CLI="code"
	else
		local app_cli
		for app_cli in "${VSCODE_APP_CLIS[@]}"; do
			if [[ -x "$app_cli" ]]; then
				EDITOR_CLI="$app_cli"
				break
			fi
		done
	fi
	if [[ -z "$EDITOR_CLI" ]]; then
		for cli in codium cursor; do
			if command -v "$cli" >/dev/null; then
				EDITOR_CLI="$cli"
				break
			fi
		done
	fi
	if [[ -z "$EDITOR_CLI" ]]; then
		local fork_cli
		for fork_cli in "${FORK_APP_CLIS[@]}"; do
			if [[ -x "$fork_cli" ]]; then
				EDITOR_CLI="$fork_cli"
				break
			fi
		done
	fi
	[[ -n "$EDITOR_CLI" ]] || die "no editor CLI found (code/codium/cursor, or a \
VS Code / Cursor / VSCodium app bundle). In VS Code, run 'Shell Command: \
Install \"code\" command in PATH' from the Command Palette, or pass --editor <cli>."
	# Report the resolved path, not the bare name: a fork's own `code` shim on
	# PATH would otherwise be announced as plain "code", hiding which editor
	# is about to be installed into.
	say "Using editor CLI: $(command -v "$EDITOR_CLI" 2>/dev/null || echo "$EDITOR_CLI")"
}

if [[ "$UNINSTALL" == 1 ]]; then
	find_editor
	say "Uninstalling $EXT_ID via $EDITOR_CLI…"
	"$EDITOR_CLI" --uninstall-extension "$EXT_ID"
	say "Done. (idb-companion was left installed — it's a shared Homebrew package;"
	say " remove it yourself with 'brew uninstall idb-companion' if nothing else uses it.)"
	exit 0
fi

# --- prerequisite checks ------------------------------------------------------
[[ "$(uname -s)" == Darwin ]] || die "macOS only — the sidecar drives Apple's CoreSimulator."
# xcode-select -p passes on Command-Line-Tools-only machines, which can't build
# the sidecar or run simulators; xcodebuild only exists with full Xcode.
xcodebuild -version >/dev/null 2>&1 || die "full Xcode is required (Command Line Tools alone can't build the sidecar or run simulators). Install it from the App Store, then: sudo xcode-select -s /Applications/Xcode.app"
command -v swift >/dev/null || die "swift not found — install Xcode and accept its license (sudo xcodebuild -license accept)."
command -v npm >/dev/null || die "Node.js/npm required — install from https://nodejs.org or 'brew install node'."
command -v brew >/dev/null || die "Homebrew required (for Meta's idb-companion frameworks) — https://brew.sh"

# Same probe the extension uses at runtime: simhelper links BOTH frameworks
# via @rpath into the idb-companion keg.
frameworks_present() {
	local dir
	for dir in /opt/homebrew/opt/idb-companion/Frameworks /usr/local/opt/idb-companion/Frameworks; do
		[[ -e "$dir/FBSimulatorControl.framework" && -e "$dir/FBControlCore.framework" ]] && return 0
	done
	return 1
}

if ! frameworks_present; then
	say "Meta's idb-companion is not installed (the sidecar links its FBSimulatorControl frameworks)."
	if [[ "$ASSUME_YES" != 1 ]]; then
		printf 'Run `%s` now? [y/N] ' "$IDB_INSTALL_CMD"
		# `|| reply=""`: at EOF (non-TTY stdin, no --yes) read fails under set -e;
		# fall through to the die below so the user still gets the fix-it hint.
		read -r reply || reply=""
		[[ "$reply" =~ ^[Yy] ]] || die "cannot continue without idb-companion. Install it yourself with: $IDB_INSTALL_CMD"
	fi
	say "Installing idb-companion via Homebrew…"
	brew tap facebook/fb
	# `brew trust` exists only on newer Homebrew (where untrusted taps refuse to
	# install); on older versions the tap is already usable.
	brew trust --tap facebook/fb 2>/dev/null || true
	brew install idb-companion
	frameworks_present || die "idb-companion installed but its frameworks were not found — check 'brew info idb-companion'."
fi

# --- build + package ----------------------------------------------------------
say "Installing npm dependencies…"
npm ci

say "Building sidecar + extension and packaging the VSIX…"
# vsce runs vscode:prepublish → build:sidecar (universal binary, rpath fix,
# ad-hoc codesign), check-types, and the esbuild bundle.
npx vsce package

VSIX="sidesim-$(node -p "require('./package.json').version").vsix"
[[ -f "$VSIX" ]] || die "expected $VSIX after packaging, but it's not here."

if [[ "$NO_INSTALL" == 1 ]]; then
	say "Built $VSIX (skipping install per --no-install)."
	exit 0
fi

# --- install ------------------------------------------------------------------
find_editor
say "Installing $VSIX via $EDITOR_CLI…"
# --force: replacing an already-installed copy (reinstall/update) is expected.
"$EDITOR_CLI" --install-extension "$VSIX" --force

say "Installed. Reload the editor window, boot a simulator (Simulator.app or"
say "'xcrun simctl boot <device>'), and run 'iOS Simulator: Open Panel'."
