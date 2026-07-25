#!/usr/bin/env bash
# Build the universal simhelper sidecar and stage it for packaging.
# The FBSimulatorControl frameworks are NOT bundled — the binary links against
# the Homebrew idb-companion bottle at runtime (rpaths for both prefixes), so
# `brew install idb-companion` is a prerequisite on the target machine.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/sidecar"

echo "==> swift build -c release (universal)"
swift build -c release --arch arm64 --arch x86_64

bin_dir="$root/bin"
mkdir -p "$bin_dir"
cp -f .build/apple/Products/Release/simhelper "$bin_dir/simhelper"

# The idb-companion bottle's frameworks have absolute install names
# (/opt/homebrew/...), which -framework copies verbatim into simhelper as
# top-level load commands. dyld only consults LC_RPATH for @rpath-prefixed
# loads, so rewrite these two to @rpath — only then do the Package.swift rpaths
# (both Homebrew prefixes) make the binary load on Apple Silicon AND Intel.
# Must run before codesign, which install_name_tool invalidates.
for fw in FBControlCore FBSimulatorControl; do
	cur="$(otool -L "$bin_dir/simhelper" | awk -v f="/$fw.framework/" '$1 ~ f && $1 !~ /^@rpath/ {print $1; exit}')"
	if [ -n "$cur" ]; then
		install_name_tool -change "$cur" "@rpath/$fw.framework/Versions/A/$fw" "$bin_dir/simhelper"
	fi
done

# Ad-hoc sign so the Mach-O carries a signature (Gatekeeper is friendlier to a
# signed helper; a locally-installed VSIX isn't quarantined either way).
codesign --force --sign - "$bin_dir/simhelper"

arches="$(lipo -info "$bin_dir/simhelper" | sed 's/.*: //')"
case "$arches" in
	*x86_64*arm64* | *arm64*x86_64*) ;;
	*) echo "ERROR: expected a universal binary, got: $arches" >&2; exit 1 ;;
esac
echo "==> staged $bin_dir/simhelper ($arches)"
