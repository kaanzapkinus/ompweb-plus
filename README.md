# OMPWeb Plus

An independent community fork of [kahme247/ompweb](https://github.com/kahme247/ompweb), a browser workspace for the [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) coding agent.

This fork carries the integrated custom features described below on the tested upstream **0.5.2 baseline**, commit [`8888c15b23d7ff891da5d1670e158db851b10c27`](https://github.com/kahme247/ompweb/commit/8888c15b23d7ff891da5d1670e158db851b10c27). It is not an official upstream release or an OMP distribution. The baseline identifies the integration target, not a claim that every browser, provider, or operating system has been tested.

[Source](https://github.com/kaanzapkinus/ompweb-plus) · [Issues](https://github.com/kaanzapkinus/ompweb-plus/issues) · [Release scope and limitations](docs/public-release.md) · [Contributing](CONTRIBUTING.md)

[English](README.md) · [Japanese documentation entry](README.ja.md) · [Chinese documentation entry](README.zh-CN.md)

## Install from source

**This fork is source-only. Its npm namespace is not published.** Upstream npm packages install upstream, not OMPWeb Plus; there is no supported `npx` installation for this fork.

Requirements:

- Node.js **24 or newer**, npm, and Git.
- A separately installed [OMP runtime](https://github.com/can1357/oh-my-pi) on `PATH`, or an explicit `OMP_WEB_OMP_BIN`. Configure provider authentication and models in your own OMP installation. No model credentials are included here.
- A writable OMP agent directory and access to the workspaces you intend the agent to use. Session browsing can work without OMP; sending prompts and native management actions require it.

```bash
git clone https://github.com/kaanzapkinus/ompweb-plus.git
cd ompweb-plus
npm ci
npm run build
node bin/omp-web.js
```

Open <http://127.0.0.1:30177>. The source CLI uses the build in this checkout. Keep the checkout and its dependencies in place while running it.

```bash
node bin/omp-web.js --port 8080
node bin/omp-web.js --no-open
node bin/omp-web.js --help
node bin/omp-web.js --version
```

Do not substitute `npm run start:lan` for the CLI's authentication-aware startup. For development use `npm run dev` at <http://127.0.0.1:30178>; do not run a production build while that development server is using the same `.next` directory.

### Authentication

The web interface can run commands and access files with the server user's permissions. It is a trusted single-user agent interface, **not a multi-user sandbox**. Loopback without a password is intended only for a trusted local machine. Require authentication and protected transport before allowing remote access.

**Dependency advisory warning:** the publication-time `npm audit --omit=dev` reports 22 production dependency findings, including 5 rated critical. These inherited dependency findings are not resolved by this source migration; passing tests and secret scans are not a vulnerability-free certification. Review [the release limitations](docs/public-release.md#dependency-advisories) before exposing an installation.

Generate a web password hash interactively; the password is read from standard input, not an argument:

```bash
node bin/omp-web.js hash-password
cp .env.example .env.local
```

Put the complete generated value in the commented `OMP_WEB_PASSWORD_HASH` entry in `.env.local`, uncomment it, and keep that file private. Then start with the environment loaded **before the launcher runs**:

```bash
node --env-file=.env.local bin/omp-web.js
```

The example uses loopback by default. For a direct network bind, set `OMP_WEB_HOSTNAME=0.0.0.0` in the private environment file only after configuring a password and HTTPS or a trusted encrypted VPN. The CLI refuses a non-loopback bind without a password hash. Plain LAN HTTP is not encrypted; pairing does not change that.

The hash format is `scrypt$<ln>$<r>$<p>$<salt>$<digest>` with a random salt. A hash is not a login credential or a session-signing key, but it is still sensitive because weak passwords can be guessed offline. Choose a long, unique password. A separate random signing secret is stored in the installation's agent data directory. Changing the password invalidates existing web logins.

Do not use the removed `--password` flag. Legacy `OMP_WEB_PASSWORD` migration exists for compatibility, but plaintext can be exposed through the launcher environment; use `OMP_WEB_PASSWORD_HASH` instead, and never set both.

### Phone pairing, LAN, and HTTPS

1. Start the server with appropriate authentication and transport protection. Keep it bound to loopback when a reverse proxy or tunnel can reach it locally; use a network bind only when needed, with a firewall allowing only intended clients.
2. On the server computer, open its actual loopback URL and select **Settings → Remote Access**. Generate the pairing QR there.
3. Use a phone-reachable LAN or configured HTTPS public URL, scan the QR, and complete pairing before the token expires. Password login remains a separate control. A loopback URL itself is not reachable from another device.
4. Review paired devices and revoke individual devices or all devices when needed. Treat QR codes and pairing links as temporary secrets; do not post them or include them in issue screenshots.

Only a verified direct loopback connection can issue local pairing authority. A `Host` header is not proof of locality; forwarded requests remain remote even when their proxy connects locally. Pairing has one active, expiring, single-use token; issuing another invalidates the previous one. Durable authority failures deny remote access rather than silently restoring revoked devices. Numeric setting errors do not replace valid configuration.

**Tunnel limitations:** the explicit **Start tunnel** action can launch a separately installed `cloudflared` quick tunnel, or return your manually configured public URL. Use `OMP_WEB_CLOUDFLARED_BIN` for an absolute binary override. A manual URL does not create DNS, configure a reverse proxy, or prove that the endpoint works. Quick tunnels require outbound connectivity and expose the service through a third party; URLs and availability are not permanent. The UI's stored auto-tunnel preference is not a guarantee of automatic startup: start and verify the tunnel explicitly. Do not use the development server as an Internet deployment. A tunnel is not a replacement for authentication, pairing, or access policy.

For a reverse proxy, preserve streaming responses and allow the attachment request budgets below. Keep application authentication enabled behind external access control. Optional `OMP_WEB_TRUSTED_HEADER_SHA256` bypasses the password only for a matching high-entropy `X-Omp-Web-Auth` secret supplied by your trusted proxy; the proxy must strip/replace client headers, validate hostnames, and be the only route to the loopback server. Never use a guessable secret or trust arbitrary forwarded addresses. This password bypass does not grant local pairing authority.

## Features

The fork retains the upstream browser/OMP architecture and adds the mobile, organization, attachment, execution, and persistence improvements below. See the [provenance table](docs/public-release.md#inherited-and-added-capabilities) for the inherited/custom distinction.

### Chat, tools, and workspaces

- Streaming chat with reasoning, model/thinking/tool selection, interrupt/retry, native queue controls, and live tool results. Active tool work can be folded into **Process details**, with compact phone rendering and configurable thinking expansion. System-prompt inspection remains available.
- Live todo phases, `/btw` side questions, and nested subagent panels with transcript dialogs and history recovery; tool presets for new sessions; slash commands and the `⌘K` / `Ctrl+K` command palette.
- Message copying as rendered plain text or original Markdown, excluding reasoning/tool/control chrome. Oversized raw-text views copy the full source.
- Project browsing, managed project cloning, file tabs/previews, Git worktrees, session import/export, archive/restore, deep links, forks into separate conversations, and branches within a conversation. Archiving is explicit; there is no automatic age-based archive policy.
- The file viewer follows ordinary and atomic writes, including deletion and recreation, rather than remaining stuck on the old file.
- External OMP session-file changes refresh saved-chat views. Watcher startup stays read-only and reconciles metadata until the native watcher begins delivering events; it does not write probe files or poll transcript contents.
- Native queues are shared across devices. Edit/delete wait for OMP cancellation confirmation; Stop restores still-pending text when supported. Already-delivered steering cannot be recalled. Queue display needs OMP's `queuedMessages` / `queue_update` support (18.4.4+); promoting follow-ups requires `promote_queued_message`, and edit/delete require `remove_queued_message`. Unsupported actions report their limitation rather than duplicate a message.

### Logical workspaces and recent models

- Create, rename, and remove logical workspaces, and move chats between them as **metadata only**. Membership never changes an existing conversation's working directory or transcript. Removing a workspace returns its chats to directory-based workspaces; it never deletes conversations.
- The sidebar and new-chat picker use the same workspace records. Workspaces have independent IDs and a default directory, so two topics can share a directory without sharing selection, drafts, or new-chat membership. Normal and scheduled new chats retain the selected workspace; genuine Git checkout selection remains available separately.
- Existing topic-folder metadata migrates once into agent-root `workspaces.json`, retaining the old registry for rollback. Same-name folders merge, inherited memberships become explicit, and unassigned external conversations remain visible. Forks inherit membership initially and can be moved independently; ancestry remains navigable across workspaces. Search/running filters never shrink new-chat choices.
- Search all chats from the always-visible sidebar field. Literal, case-insensitive word or phrase searches include user and assistant messages across workspaces and stored branches, with matching excerpts and workspace labels. Results are paginated; unreadable files are reported. Search runs on the server with a bounded in-memory text cache, not by downloading full transcripts or creating a second persistent conversation store.
- **Recent chats** appears above workspaces and can be collapsed. Its last ten conversations are ordered by actual user/assistant message timestamps; opening, reading, renaming, or moving a chat never promotes it. These are shortcuts to the original conversations, not copies or changed memberships.
- An independent **Recent models** column remains visible on phones and desktop during provider drilldown and full-catalog search. Provider labels distinguish equal model names. Recents are saved on the server and shared between browsers; local cache is supplementary. Explicit hidden-model choices survive catalog refreshes.

### Metrics and earlier history

- The chat-top strip shows live generation TPS, or average TPS while idle, two-decimal USD cost, and context usage/capacity. Open it for cache reads/writes, hit rate, and full details.
- Cost is a provider/API-valued estimate, not necessarily your invoice. Missing telemetry remains unknown; a measured zero remains zero. Whole-branch totals are calculated before history pagination/compaction, not from only the visible page.
- Scroll up or use the existing conversation-top load control for earlier messages, including pre-compaction history. Paging advances from a stable history anchor while new turns arrive. Read-only history loading does not restart generation or change the live model; there is no separate toolbar history toggle.
- The minimap stays within the conversation area, below metrics/execution information and above the composer.

### Documents and images

- Attach up to **10 document files, each up to 10 MiB**. Their original bytes are saved in the selected workspace, with conflicts reported instead of overwriting existing files.
- Document prompts include the **exact saved paths**, not extracted or silently truncated document text, and instruct the agent to inspect each full original. Format support still depends on the selected agent/tools; unreadable content must be reported, not assumed readable.
- Images allow **10 images × 10 MiB**, with a **100 MiB decoded aggregate** per message. The complete agent command JSON has a **135 MiB** limit; the Next proxy ceiling is **145 MiB** to allow base64 overhead. Reverse proxies may impose lower limits and must be configured accordingly. These transport limits do not override a provider's own image/context limits.
- Unsent photos are uploaded to private server-side draft storage while editing and cached on the device for offline recovery. Document selections retain their saved paths; the original workspace files are not deleted when a selection or draft is cleared.

### Quota policy and scheduled prompts

Open the composer's **+** menu for **Allow fallback**, **Keep model, wait for quota**, or **Schedule prompt**. Scheduling and quota policy are not separate top-toolbar buttons.

- A saved chat's keep-model policy applies a per-process native policy overlay, not a change to global OMP retry settings. A known reset resumes on the **same model**; an unknown reset stays waiting until safe usage information arrives or you set a manual resume time. You can cancel the wait.
- Automatic unknown-wait resolution requires exhausted windows with unambiguous account/model scope. When several applicable exhausted windows bind the wait, the latest reset wins. Missing or ambiguous information remains manual; cancellation and a manually chosen time are authoritative.
- Schedule a prompt in an existing chat or create a persisted new conversation **without sending immediately**. The dialog has its own model picker; selecting there does not change the active chat model. Saved scheduled/quota-resume executions pin their model while running, and unavailable choices are explicit.
- Scheduled prompts use the normal composer: slash commands, model-specific reasoning and Fast/Slow settings, tool presets, advisor, saved-path document attachments, images, and automatic textarea growth. Workspace slash discovery does not create a conversation. Immediate-only local commands cannot be scheduled as if they were provider prompts.
- A compact **Scheduled prompts** status opens job management. Edit or cancel pending prompts, set waiting jobs' resume times, stop active work, and dismiss terminal records. Dismissing a failure hides its card without replaying it or deleting the conversation.
- Timing supports **Provider quota reset**, **After a delay** (hours/minutes, including normalized values such as 90 minutes), and **At a specific time**. Reset options preserve exact timestamps and account/window labels for the selected model or provider-wide limits. Changing the model requires a new reset selection. Choosing a reset selects a **time, not an account**, and does not promise every quota has cleared.
- Jobs are stored on the server and survive restart, but the server must be running to execute them; they are not an OS alarm or an offline browser timer. Provider usage and credential availability still govern execution.
- Scheduling uses durable request identities and a pre-creation journal. Retrying the same request retains the original chat/job, even after its deadline. If native creation has an uncertain outcome, the UI reports uncertainty instead of creating another chat or replaying a prompt. Inspect existing conversations before deliberately starting another request.
- Confirmed native persistence moves transfer policy/job ownership; explicit fork/switch/new-session boundaries do not. Terminal metadata retries do not replay a submitted prompt. These safeguards avoid automatic duplication; they cannot promise exactly-once external provider side effects after every possible crash.
- The phone schedule dialog fits the keyboard-visible safe viewport, keeps its header/actions pinned, scrolls the body when needed, and returns focus to **+** on close. Mobile inputs avoid focus zoom.

### Drafts, themes, and native configuration

- Normal and scheduled unsent drafts autosave to the server per conversation or new-chat workspace. Reopening the same draft on another authorized device restores text, photos, saved document paths, and the schedule's model/timing settings. **Draft saved on server** means the save was acknowledged; saving, offline, upload, and conflict states remain explicit.
- **Draft history** restores earlier autosaved checkpoints without sending them. Accepted sends clear only the submitted active snapshot, never its history or newer edits. Checkpoints and draft-owned photos have no automatic expiry; **Delete draft and history** explicitly removes them, not conversations or workspace documents. A content-free revision tombstone remains to reject stale saves and cleanup requests.
- Offline text and queues use a small local cache; photos are stored separately in IndexedDB. Competing offline tabs retain independent pending edits. Reconnection uses revision checks and explicit local/server conflict choices, not silent merging or last-writer replacement. Edits not yet saved on the server still depend on that device's storage; clearing browser data can lose unsynced work. Photo-bearing drafts cannot be submitted until their retained photos have loaded.
- Open the header **…** menu for themes on phones and desktop. Paper light/dark and midnight themes, font size/interface scale, and English, Japanese, and Simplified Chinese UI are retained. Clearing browser data or using another origin/profile can reset device preferences and offline-only edits; acknowledged drafts remain on the server.
- Workspace-scoped **Skills** and **Plugins** settings use your installed OMP CLI for discovery, supported installation/update operations, and diagnostics rather than a competing web-only registry. Managed/plugin-provided skills can be read-only. Startup notices show native conflicts/duplicates when the runtime supports them; unavailable diagnostics are not an all-clear result. Native diagnostic controls require `get_skill_diagnostics`, `set_skill_startup_diagnostics`, and `skill_diagnostics_update`.
- Models/providers, API keys, MCP, safety/approvals, agent settings, usage analytics, and optional auto-resume remain native-backed. Provider/model availability is whatever your OMP setup currently offers, not a promised bundled subscription or free endpoint.

### Notifications and PWA

Enable events and delivery preferences in **Settings → Notifications**. Desktop has a bell/history popover; phones have a notification panel. Events include finished tasks, waiting for input, failed runs, and automatic model switches. Clicking a notification opens its session; active-session presence suppresses redundant delivery.

Web Push needs a secure context (HTTPS or localhost), browser permission/support, outbound HTTPS to browser push services, and a running OMPWeb Plus server. Without Push, system notifications require an open tab; on non-localhost plain HTTP only in-app toasts remain. Browser/OS policies can delay or prevent delivery, and some desktop browsers need their process running. On iOS/iPadOS 16.4+, Web Push requires the app added to the Home Screen. Completion events require OMP's `prompt_result` / `session_settled` support (18.3.1+).

Sign in before installing from the browser's app menu. The authenticated `/api/manifest` embeds packaged PNG icons so installation does not require a public authentication bypass. Custom UI/PWA/notification branding shares the bundled logo source; operating systems may cache old installed icons. Installation does **not** add offline agent execution or offline session browsing. Keep external access control and application authentication enabled.

### Optional native failover extension

The opt-in [`extensions/agy-failover.ts`](extensions/agy-failover.ts) and regression tests at [`extensions/tests/agy-failover.test.mjs`](extensions/tests/agy-failover.test.mjs) are included separately from the web server. Follow [the extension guide](extensions/README.md) to configure a chain using your own available, authenticated models. It is not enabled by cloning or starting the web app and supplies no provider credentials or deployment-specific default chain.

The extension rereads web execution policy at terminal failure: keep-model waits and running scheduled jobs must not authorize fallback, and corrupt/unreadable policy fails closed. Native-only use without a web execution store remains distinct. It is not a substitute for native model configuration or the web scheduler.

## Updating and background services

The web app's update UI points to a **manual source update**; it must not install an upstream npm package over this checkout. Stop this web instance and its service/tray supervisor before updating a clean checkout:

```bash
git pull --ff-only
npm ci
npm run build
node --env-file=.env.local bin/omp-web.js
```

If you do not use `.env.local`, restart with the same protected environment/service configuration you originally used. Back up private runtime data separately; never commit it. See [release maintenance](docs/release.md). Native OMP updates are separate from updating this web fork.

Included source service/tray helpers:

```bash
# macOS: install, inspect, or remove this checkout's launchd service
node bin/omp-web-launchd.js install
node bin/omp-web-launchd.js status
node bin/omp-web-launchd.js uninstall

# Linux: install or manage this checkout's systemd user service
node bin/omp-web-systemd.js install
node bin/omp-web-systemd.js status
node bin/omp-web-systemd.js stop
node bin/omp-web-systemd.js start
node bin/omp-web-systemd.js uninstall

# Windows tray/service helper
node bin/omp-web-tray.js --install
node bin/omp-web-tray.js --status
node bin/omp-web-tray.js --uninstall

# Linux StatusNotifierItem tray (compatible desktop/session required)
node bin/linux-tray.js --install
node bin/linux-tray.js --status
node bin/linux-tray.js --uninstall
```

Pass your environment to the **installer process** as well, for example `node --env-file=.env.local bin/omp-web-launchd.js install`; keep the checkout/Node path stable. Service helpers have platform-specific prerequisites and generated private configuration. Windows tray/services read password-hash changes from the configured user/system environment on their next start. Review generated service configuration before enabling remote access. Packaged Electron installers are not a supported distribution of this source release.

## Environment variables

Use [`.env.example`](.env.example) as a private local template. Never put passwords, hashes, model credentials, pairing data, or real deployment URLs into committed examples.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Production CLI port | `30177` |
| `OMP_WEB_HOSTNAME` | CLI bind host; non-loopback needs a password hash | `127.0.0.1` |
| `OMP_WEB_PASSWORD_HASH` | Complete generated web-login scrypt hash | Unset |
| `OMP_WEB_OMP_BIN` | OMP executable override | Discover from `PATH` |
| `PI_CODING_AGENT_DIR` | Separate OMP agent data root | OMP's resolved agent directory, normally `~/.omp/agent` |
| `OMP_WEB_NO_OPEN` | `1` prevents opening a browser on startup | `0` |
| `OMP_WEB_NAME` | Display/PWA name; `url`, `host`, or `domain` derives it from the request hostname | `omp web` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | `1` disables update checks/actions, including native runtime updates; web-fork updates are manual regardless | `0` |
| `OMP_WEB_CLOUDFLARED_BIN` | Absolute path to separately installed quick-tunnel executable | Discover locally |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | Optional digest of a high-entropy trusted-proxy password-bypass secret | Disabled |
| `OMP_WEB_DEV_ORIGIN` | Additional development hostname only, without scheme/port; does not change binding or add authentication | Unset |
| `OMP_WEB_STT_ENDPOINT` | Optional compatible transcription endpoint | Unset |
| `OMP_WEB_STT_KEY` | Optional transcription endpoint credential; keep private | Unset |
| `OMP_WEB_STT_MODEL` | Optional endpoint model, or a transcription model supported by your OMP runtime/authentication | Unset |

## Scope and privacy

This repository contains source and synthetic test data, not an OMP account or a deployment snapshot. It does not include credentials, native user configuration, actual chats, folder assignments, model recents, browser drafts, pairing state, notification subscriptions, or private operations. The separate private Hub/quota dashboard is not included. A separate native voice bridge is **deferred**; inherited optional transcription endpoints do not mean that bridge is implemented. Historical provider credential/model setup is not a portable feature or a promise of model availability.

Treat your agent directory, workspace files, scheduled prompts, notification history, browser drafts, and service configuration as private. Read the [data and limitations guide](docs/public-release.md) before remote deployment or sharing diagnostics.

## License and attribution

Released under the [MIT License](LICENSE). The original notice **Copyright (c) 2026 agegr** remains unchanged. OMPWeb Plus builds on [kahme247/ompweb](https://github.com/kahme247/ompweb), itself forked from [agegr/pi-web](https://github.com/agegr/pi-web), and adapts that work for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). Fork maintenance is published at [kaanzapkinus/ompweb-plus](https://github.com/kaanzapkinus/ompweb-plus); this does not imply endorsement by those upstream projects.
