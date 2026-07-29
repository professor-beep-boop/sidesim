# Security Policy

## Supported versions

Only the latest release (and `main`) receives fixes.

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** ("Report a
vulnerability" under the repository's Security tab) rather than a public
issue. If that's unavailable, open a plain issue that says only "security —
please reach out" with no details, and a maintainer will follow up with a
private channel.

This is a maintainer's-spare-time project: reports are handled best-effort,
usually within a couple of weeks. Please allow a fix to land before public
disclosure.

## Scope notes

The extension executes a local native helper (`simhelper`) that drives Apple's
CoreSimulator via Meta's FBSimulatorControl frameworks, and by default runs it
under a `sandbox-exec` profile with no network access and file writes limited
to CoreSimulator/temp paths (`sidesim.simulator.sandbox`); the optional
`companion`/`cli` backends run Meta's own binaries unsandboxed. Reports about
sandbox escapes, input-injection abuse, or the webview↔extension message
surface are especially welcome.
