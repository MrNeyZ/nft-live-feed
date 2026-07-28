# Windows executable packaging — readiness assessment

**Verdict: medium-low readiness — feasible, but non-trivial.** This is an
analysis/writeup deliverable per the Stage 5.4 spec, not something
implemented in this stage.

## Dependencies

- **`sharp`** ships platform-specific prebuilt native binaries as separate
  optional npm packages (e.g. `@img/sharp-win32-x64`), not portable
  bytecode. This is the dominant risk factor for packaging.
- **`yauzl`**, **`dotenv`** — pure JS, zero native-module risk.
- **`trait-extraction-core`** (workspace package this CLI depends on) is
  itself pure TS/JS with `sharp` as its only native dependency — same risk,
  once.

## Packaging tool options

- **pkg** — only the community-maintained `@yao-pkg/pkg` fork is still
  active (upstream `vercel/pkg` is unmaintained). Bundles pure JS into one
  executable but does **not** compile native addons — `sharp`'s `.node`
  binary must ship as a sibling asset and be resolved at runtime, not
  embedded in the exe.
- **nexe** — same native-addon caveat as pkg, and generally less actively
  maintained / rockier with modern package-exports resolution.
- **Node SEA** (`--experimental-sea-config`) — the most official/
  future-proof mechanism, but still explicitly experimental. Critically,
  SEA also does **not** embed native addons — the documented pattern is
  still "ship the `.node` file alongside the exe," so it doesn't solve the
  `sharp` problem any better than pkg/nexe.

## The common blocker: npm workspaces

None of the three tools understand npm/yarn **workspace** resolution —
this repo's `apps/trait-extractor-cli` depends on
`packages/trait-extraction-core` via a workspace symlink
(`"trait-extraction-core": "*"`). A flattening bundler pass (esbuild or
`@vercel/ncc`, with `sharp` marked `external` so it stays a real installed
native dependency rather than being incorrectly inlined) is a required
first step before any of the three packagers can be pointed at this CLI.

## Recommended next step

A small, isolated spike: package a minimal one-file program that only
calls `sharp.metadata()` on a test image, through the intended pipeline
(flatten with esbuild/ncc → package with `@yao-pkg/pkg`), and actually run
it on a real Windows target (native-module packaging failures are usually
only discoverable empirically, not from documentation). Only attempt
packaging the full CLI after that spike confirms the `sharp` native-binary
path resolves correctly in a packaged exe.

## Summary

| Concern | Status |
|---|---|
| Pure-JS dependencies (`yauzl`, `dotenv`) | No risk |
| `sharp` native binary | Must ship alongside the exe, not embedded — the main risk |
| npm workspace resolution | Not understood by any packager — requires a bundling/flattening pass first |
| Overall | Feasible with a bundling pass + explicit native-binary shipping; unproven until a real spike is run on Windows |
