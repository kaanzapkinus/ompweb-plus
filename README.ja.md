# OMPWeb Plus — Japanese documentation entry

Public fork documentation is currently maintained in English. The application itself retains its Japanese, English, and Simplified Chinese interface translations. This entry replaces older upstream instructions so that users are not sent to the wrong package or given stale feature claims.

**OMPWeb Plus is an independent community fork of [kahme247/ompweb](https://github.com/kahme247/ompweb)**, integrated on the tested upstream 0.5.2 baseline, commit [`8888c15b23d7ff891da5d1670e158db851b10c27`](https://github.com/kahme247/ompweb/commit/8888c15b23d7ff891da5d1670e158db851b10c27). It is not an official upstream release. The original MIT license, **Copyright (c) 2026 agegr**, and upstream ancestry are retained; see [LICENSE](LICENSE).

## Install this fork from source

Node.js 24+, npm, Git, and a separately installed/configured [OMP runtime](https://github.com/can1357/oh-my-pi) are required.

```bash
git clone https://github.com/kaanzapkinus/ompweb-plus.git
cd ompweb-plus
npm ci
npm run build
node bin/omp-web.js
```

Open <http://127.0.0.1:30177>. The fork's npm namespace is **not published**: there is no supported `npx` installation, and upstream npm commands install a different project.

For authentication, generate a hash with `node bin/omp-web.js hash-password`, copy `.env.example` to private `.env.local`, set the complete hash there, and start with `node --env-file=.env.local bin/omp-web.js`. Use HTTPS or a trusted encrypted VPN and a password before remote access. Generate pairing QR links only from the server computer's direct loopback connection; a QR link does not provide encryption.

## Current feature and safety documentation

Read the [canonical README](README.md) for the complete feature inventory, source updates, CLI/service commands, environment variables, notifications, and PWA requirements. Read [release scope and limitations](docs/public-release.md) for inherited versus added capabilities and storage/security boundaries.

Important current behavior:

- Themes are in header **…**. Scheduling and per-chat fallback/keep-model policy are in composer **+**.
- Documents use exact workspace paths, with original bytes and no extracted/truncated prompt text: 10 files × 10 MiB. Images allow 10 × 10 MiB and 100 MiB decoded total; command/proxy limits are 135/145 MiB.
- Topic folders do not move transcripts or working directories; model recents are server-backed and shared across browsers. Branch-wide metrics survive compaction/history paging; the existing earlier-history control does not reset live generation.
- Scheduled prompts support an independent model and exact reset/delay/date-time selection, durable idempotent recovery, and conservative same-model quota waits. Ambiguous reset/account evidence stays manual; a reset choice selects a time, not an account.
- Normal text and scheduled drafts survive browser reopening when local storage is retained, but remain browser/profile/origin-local, **not cross-device**. Attachment selections are memory-only; submitted scheduled jobs live on the server.
- Skills/plugins use your installed native OMP runtime. The [optional failover extension](extensions/README.md) requires explicit installation and your own model chain.
- No model credentials, personal chats, separate private Hub application, or deployment state are included. The separate native voice bridge remains deferred. Packaged Electron installers are unsupported.

[English README](README.md) · [Contributing](CONTRIBUTING.md) · [Source release maintenance](docs/release.md) · [Fork issues](https://github.com/kaanzapkinus/ompweb-plus/issues)
