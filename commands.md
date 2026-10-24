# OMPWeb Plus command reference

This fork is distributed as a source checkout. Its npm namespace and Electron installers are not published. Use the canonical [installation guide](README.md#install-from-source) and [source-release maintenance guide](docs/release.md).

## Install and run

```bash
git clone https://github.com/kaanzapkinus/ompweb-plus.git
cd ompweb-plus
npm ci
npm run build
node bin/omp-web.js --no-open
```

The default loopback URL is `http://127.0.0.1:30177`. Node.js 24 or newer and a separately configured OMP installation are required for native actions.

## Authentication

```bash
node bin/omp-web.js hash-password
cp .env.example .env.local
# Edit the private environment file and insert the generated hash.
node --env-file=.env.local bin/omp-web.js --no-open
```

Never commit the environment file, password hash, signing secret, pairing links, or runtime state. Use HTTPS or a trusted encrypted VPN for remote access. Generate pairing authority from an actual loopback connection through Settings → Remote Access; forging a Host header is not a locality test.

## Develop and verify

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

Do not build while the development server is using the same `.next` directory. Stop it before the production build. `npm run release:check` runs the complete verification sequence.

## Update the source checkout

Stop this instance and its supervisor first, then run:

```bash
git pull --ff-only
npm ci
npm run build
node --env-file=.env.local bin/omp-web.js --no-open
```

Restart using the same protected environment or service configuration. The web application is not updated by installing an upstream npm package. Updating the native OMP CLI is a separate operation.

## Source service helpers

```bash
node bin/omp-web-launchd.js status
node bin/omp-web-systemd.js status
node bin/omp-web-tray.js --status
node bin/linux-tray.js --status
```

Use the helper appropriate to your operating system. See README for installation and removal commands. Installing or removing a service changes local machine state; status commands do not install it.

## Optional quota fallback

See [extensions/README.md](extensions/README.md) for explicit opt-in installation and the user-configured model chain. Cloning this repository does not enable fallback or copy provider credentials.
