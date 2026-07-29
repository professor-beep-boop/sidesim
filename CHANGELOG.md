# Change Log

## [Unreleased]

- **Build & run from the panel.** A new ▶ Run button runs a user-configured
  command (`sidesim.run.command`) to build/install/launch your app on the
  mirrored device — build-system-agnostic (Bazel, xcodebuild, …), with the
  target UDID exported as `$SIDESIM_TARGET_UDID`.
- **Renamed: vscodesim → Sidesim.** Breaking if you installed the v0.0.1
  release under the old identity:
  - Settings moved from `vscodesim.simulator.*` to `sidesim.simulator.*`
    (old values silently stop applying — re-set them under the new keys).
  - The command ID is now `sidesim.openSimulator`; keybindings referencing
    `vscodesim.openSimulator` must be updated.
  - Env vars are now `SIDESIM_*` (previously `VSCODESIM_*`).
  - The extension ID is now `jbmorgan.sidesim`; installing it does **not**
    remove the old `jbmorgan.vscodesim` — uninstall that one manually or the
    two will coexist with identically named commands.

## [0.0.1]

- Initial scaffold
