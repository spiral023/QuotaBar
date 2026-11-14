# Dependency maintenance

Renovate opens grouped dependency PRs on Monday mornings (Europe/Vienna). Compatible updates and monthly lockfile maintenance merge only after successful PR checks. Major versions and pre-1.0 minor versions require dashboard approval. Node stays on the validated Node 22 line; npm is declared in package.json and installed explicitly by CI and release builds.

Public GitHub-hosted runners run the Windows tests, lint, TypeScript build and installer build without publishing. A separate weekly/PR audit checks the committed lockfile, including development dependencies and production-only dependencies; high/critical findings or registry/parse failures block merging.

The tag-triggered release remains separate. Dependency PRs do not create release tags, publish GitHub releases or upload via SFTP. Keep video experiments outside Renovate. Provider credentials and local user data do not belong in CI.

Run npm ci, npm run verify, npm run test:electron and npm run package to verify an update. Review Electron major upgrades and provider/auth changes explicitly. See TESTING.md for renderer verification when renderer code changes.

The application now uses Electron 45. Its root postinstall downloads the runtime
once before parallel tests can import Electron, avoiding concurrent extraction. The preload is bundled by esbuild because
sandboxed preloads cannot load local CommonJS modules. `build-assets.mjs` also
refreshes the checked-in Chart.js vendor copy from the locked npm package.
`dev:watch` rebuilds before restarting Electron, including the preload bundle.

The minimatch override applies only to affected versions 7–10 and selects the
patched 11.x API. Legacy 3.x/5.x consumers are not overridden. Remove this override
when all affected parent packages adopt patched releases. Verify lint, tests and
Windows packaging when changing it.

Build and strict application/test typechecking use the native TypeScript 7.0.2
compiler, installed under the `@typescript/native` npm alias. ESLint requires the
classic compiler API, which TypeScript 7 does not yet provide. Its supported
TypeScript 6.0.2 compatibility package remains installed under `typescript`,
following the [official side-by-side migration guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/).
Scripts call the native compiler explicitly; do not replace this setup with
`--force`, `--legacy-peer-deps` or an unsupported parser peer dependency.
Production uses NodeNext module resolution; Vitest's transformed tests use
Preserve/Bundler resolution. Strict checking remains enabled for both.

Vitest 5.1.0 runs the full suite with its default mock clearing behavior. Keep
`vitest.config.mts` as an ES module and verify tests against the declared Node 22
runtime. The seven subprocess fixture suites are deliberately excluded from
the ordinary test run and execute through their owning integration tests.

Tag releases run typecheck, lint, unit tests and a production dependency audit
before building or publishing. Windows CI additionally runs the isolated Electron
smoke test and uploads its screenshots. None of these jobs installs updates or
contacts provider quota APIs.

`npm run test:update` builds two local NSIS versions and tests the production
updater inside Windows Sandbox. It requires the Windows Sandbox feature.
The generated generic feed uses guest loopback only; public publishing is
disabled. It tests checksum rejection, retry/download, the real System install
button, automatic installation/relaunch, retained settings/usage and a final
no-newer-update check. This does not validate GitHub/CDN availability, code
signing or SmartScreen reputation. See TESTING.md for artifacts and boundaries.
