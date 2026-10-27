# Dependency maintenance

Renovate opens grouped dependency PRs on Monday mornings (Europe/Vienna). Compatible updates and monthly lockfile maintenance merge only after successful PR checks. Major versions and pre-1.0 minor versions require dashboard approval. Node stays on the validated Node 22 line; npm is declared in package.json and installed explicitly by CI and release builds.

Public GitHub-hosted runners run the Windows tests, lint, TypeScript build and installer build without publishing. A separate weekly/PR audit checks the committed lockfile, including development dependencies and production-only dependencies; high/critical findings or registry/parse failures block merging.

The tag-triggered release remains separate. Dependency PRs do not create release tags, publish GitHub releases or upload via SFTP. Keep video experiments outside Renovate. Provider credentials and local user data do not belong in CI.

Run npm ci, npm test, npm run lint, npm run build and npm run package to verify an update. Review Electron major upgrades and provider/auth changes explicitly. See TESTING.md for renderer verification when renderer code changes.
