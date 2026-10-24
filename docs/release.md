# OMPWeb Plus source releases

Repository: <https://github.com/kaanzapkinus/ompweb-plus>.

OMPWeb Plus is an independent community fork, integrated on upstream kahme247/ompweb 0.5.2 at `8888c15b23d7ff891da5d1670e158db851b10c27`. Preserve [LICENSE](../LICENSE), its original **Copyright (c) 2026 agegr** notice, and explicit upstream attribution in the README.

## Distribution contract

- This fork is **source-only**. Its package metadata uses `@kaanzapkinus/ompweb-plus` and is marked private; the namespace is not published to npm.
- Do not run `npm publish`, configure npm trusted publishing, or advertise a nonexistent `npx`/global installation. Do not publish under the upstream package name.
- A GitHub source release/tag is distinct from an npm package or bundled desktop installer. The source-release workflow performs repository checks and creates a source release; it must not enable Pages, publish user data, or install upstream packages over this fork.
- Supported installation is clone → `npm ci` → `npm run build` → `node bin/omp-web.js`. The built `.next` output and dependencies belong to the checkout. Source service helpers must launch that same checkout with its Node interpreter.
- The web application's own updates are manual source updates. Native OMP runtime updates are a separate capability. Never turn an unavailable fork registry version into an upstream-package fallback.
- Optional native failover is shipped as source and tests, not auto-installed into the user's OMP environment. Prebuilt Electron installers are not a supported release artifact.

## Prepare a source release

Use a clean release checkout and isolated private test data. Do not run release smoke checks against a real agent directory or production jobs. Before selecting a release commit:

1. Record the fork changes and upstream integration baseline accurately. Update relevant README/release-scope/changelog entries without claiming unexercised runtime results.
2. Keep `package.json` and `package-lock.json` versions aligned. A release tag must match the selected package version, including a fork prerelease suffix when present.
3. Review tracked content and the intended source archive for credentials, real paths/accounts, sessions, execution/pairing state, browser exports, logs, symlinks into private locations, and personal operations material. Use only synthetic fixtures and synthetic screenshots; do not assume an upstream screenshot is safe merely because it was already public.
4. Preserve the original license notices. Confirm source install/update commands refer to this repository, not upstream npm or a nonexistent fork package.
5. Exercise the repository's checks and production build, then record exactly what ran and any failures. Stop any development server sharing `.next` before building.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` includes `extensions/tests/*.test.mjs`. Native/browser integration needs a separately installed compatible OMP runtime. Smoke the source CLI with a throwaway `PI_CODING_AGENT_DIR` and synthetic workspace; do not reuse private model/auth stores just to make a release test pass.

When all release gates pass, a maintainer may push a reviewed matching `v<version>` tag to trigger the GitHub source-release workflow. Review the workflow/release result and public source contents. A public repository should not receive unrelated local branches, original private Git history, tags, stashes, or hidden state. No npm publication is part of this process.

## User updates

Tell users to stop the web instance and its supervisor before replacing dependencies/build output. From a clean source checkout:

```bash
git pull --ff-only
npm ci
npm run build
node bin/omp-web.js
```

Restart with the same protected environment as before. If using the README's private environment file, the final command is `node --env-file=.env.local bin/omp-web.js`. Restart a service through its service manager rather than starting a second competing instance. Resolve local changes explicitly; do not instruct users to discard them or overwrite native runtime data.

Back up runtime data privately. Browser drafts belong to a browser origin/profile and are not included in a server backup. Folder metadata, model recents, jobs, pairing authority, push subscriptions, signing keys, and transcripts are runtime data, **not source-release content**. Do not publish backups or include them in an issue report.

Upgrade all web processes sharing execution metadata together. Do not mix old/new locking protocols. Never delete a live execution lock; stop all writers before investigating an invalid stranded lock. A source update must not replay uncertain scheduled requests merely to repair metadata.

## Service paths

Canonical source helpers are `bin/omp-web-launchd.js` (macOS), `bin/omp-web-systemd.js` (Linux), `bin/omp-web-tray.js` (Windows), and `bin/linux-tray.js` (Linux desktop tray). The macOS/Linux installers pin this checkout rather than running an npm package. Keep the checkout and Node path stable, and supply runtime environment to the installer as documented in the [README](../README.md#updating-and-background-services).

Do not restore obsolete package-spec/`OMP_WEB_PKG` launchd overrides, an upstream registry updater, automatic public Pages deployment, or the unsupported Electron packaging workflow. Review platform prerequisites instead of claiming every service path was tested on every release.

See [public-release.md](public-release.md) for provenance, storage boundaries, feature limitations, and intentional exclusions.
