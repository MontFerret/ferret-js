# Changelog

## Unreleased

### Added

- Added symbol-based JavaScript host values, including atomic and composite
  Ferret capability protocols, synchronous and asynchronous iteration, stable
  object identity, runtime integration, and explicit output serialization.
- Added an explicit `http.allowLocalhost` engine option for trusted loopback
  access while preserving Ferret's secure HTTP defaults.
- Added declarative JavaScript modules through `defineModule()` and
  `create({ modules })`, including asynchronous engine, plan, and session
  lifecycle hooks.
- Added optional FQL namespaces for JavaScript module functions while keeping
  module registration identity independent.

### Changed

- Replaced Go's WASM HTTP adapter with per-engine browser and Node transports.
  Node validates and pins DNS results while Ferret policy-checks redirects;
  browsers allow same-origin requests only and reject redirects.
- Made plan compilation and session creation asynchronous across the
  JavaScript/WASM boundary.
- Added cancellation options for compilation and session creation.
- Exposed synchronous `closed` metadata on engines, plans, and sessions.
- Unified legacy `create({ functions })` registration with the Ferret module
  bootstrap path while keeping the public shorthand backward-compatible.

## 2.0.0-alpha.1

### Changed

- Migrated the compiler and runtime to Ferret v2.0.0-alpha.30.
- Replaced the v1 JavaScript API with explicit `Engine`, `Plan`, and `Session`
  lifecycles.
- Replaced the Go 1.12 runtime fork with the official runtime matching the
  build toolchain.
- Added ESM, CommonJS, Node.js, and browser package exports.
- Updated the build and test stack to TypeScript 5, tsup, Vitest, Playwright,
  and GitHub Actions.

### Added

- Immutable synchronous and asynchronous JavaScript host functions.
- AbortSignal cancellation.
- Named sources, plan parameter metadata, custom WASM sources, and deterministic
  cascading cleanup.
- Node.js and Chromium integration coverage.

### Removed

- Ferret v1, mutable function registration, `exec`, `destroy`, the custom
  `wasm_exec.ts` implementation, legacy polyfills, TSLint, Husky, and Travis CI.

## 1.0.0

### Changed

- Upgraded Ferret to v0.8.2.

### Added

- Added `compiler.destroy` to clean up cached programs.
