# Release operations

## Safe sequence

1. Work on a `codex/` branch and keep unrelated changes untouched.
2. Run `npm run verify`.
3. Bump with `npm version <version>`.
4. Run `npm run verify` again for the new version.
5. Run `npm run prepare:release -- --tag v<version>`.
6. Verify `SHA256SUMS` locally.
7. Fast-forward `master`, then push branch/tag atomically.
8. Download every public release asset and verify its checksum.

Publishing requires explicit user approval. Never print or package credentials.

## Current release state

`v0.14.1` is the latest published release (its `versions.json` row keeps
`minAppVersion 1.7.2`). Its public `main.js` is 1,199,465 / 1,400,000 bytes (85.7%).
The working tree is on the `0.15.0-dev.0` prerelease with `minAppVersion 1.11.4`
(Obsidian SecretStorage floor for the CalDAV work); users below Obsidian 1.11.4
stay on 0.14.1.
Keep the budget gate: mobile-safe code must stay eager and desktop-only code must
remain behind dynamic runtime boundaries.

Android SDK platform 35, build-tools 34.0.0, and platform-tools are installed in
the release environment. Their licenses were accepted with explicit user approval;
Kotlin unit tests and debug/release APK assembly passed.
