# Public release: scope, provenance, and limitations

OMPWeb Plus is the independent community fork at <https://github.com/kaanzapkinus/ompweb-plus>. Its integration baseline is upstream [kahme247/ompweb](https://github.com/kahme247/ompweb) **0.5.2**, commit [`8888c15b23d7ff891da5d1670e158db851b10c27`](https://github.com/kahme247/ompweb/commit/8888c15b23d7ff891da5d1670e158db851b10c27). That tested baseline is a provenance reference, not a blanket compatibility certification for this fork or future OMP releases.

This is a source distribution, not a published npm package, a hosted service, or a preconfigured OMP account. Follow the [source installation instructions](../README.md#install-from-source). Upstream package installation commands do not install this fork.

The original MIT license and **Copyright (c) 2026 agegr** notice are retained in [LICENSE](../LICENSE). Upstream ancestry is kahme247/ompweb → agegr/pi-web, with the OMP integration targeting can1357/oh-my-pi. Fork attribution does not replace the upstream notice or imply upstream endorsement.

## Inherited and added capabilities

The following distinguishes inherited foundations from the fork's integrated enhancements. A row may combine an upstream capability with changes layered onto it; it does not claim that every line of the feature was newly authored here.

| Capability | Provenance and public behavior |
| --- | --- |
| Native session browser and streaming RPC chat | Inherited foundation: reads OMP sessions, starts your installed OMP runtime for live work, and streams chat/tool events. No bundled model service. |
| Projects, files, worktrees, model/provider settings, MCP, usage | Inherited foundation retained, including project cloning, allow-listed previews, Git worktree management, native-backed configuration, and usage analytics. File-channel reliability enhancements keep previews current across ordinary/atomic writes, deletion, and recreation. |
| Forks, branches, archive/restore, import/export, deep links | Inherited session-management foundation retained. A fork creates a separate conversation; a branch navigates the current conversation's entry tree. Archiving is user-directed, not automatic by age. |
| Queues, stop/edit/steer, copying, tool visibility | Integrated upstream/native behavior retained: cancellation-confirmed edit/delete, still-pending text recovery, original/visible-text copy, live tool output and Process details folding, compact phone tool rows, and System-prompt access. Delivered steering cannot be recalled. |
| Live todo, subagents, side questions, tool presets and shortcuts | Inherited/integrated foundation retained: composer-adjacent live panels, transcript inspection/history recovery, `/btw`, slash commands, command palette, and model/reasoning shortcuts. |
| Phone layout | Fork enhancements: responsive composer/sheets, input sizes avoiding mobile focus zoom, keyboard-visible safe scheduling dialog, pinned dialog actions, composer focus restoration, and a minimap bounded to the conversation. |
| Remote access and QR pairing | Integrated enhancements: direct-loopback authority verified from actual socket evidence; expiring single-use QR links, durable device/revocation state, presence, explicit quick-tunnel/manual-public-URL controls, and fail-closed authority storage. |
| Document attachments | Fork enhancement: up to 10 files × 10 MiB; unchanged bytes saved in the selected workspace without overwriting existing files; prompts contain exact paths and full-file inspection instructions, not extracted/truncated text. |
| Image attachments | Fork transport enhancement: 10 images × 10 MiB, at most 100 MiB decoded aggregate; 135 MiB command JSON and 145 MiB proxy ceilings. Provider/proxy limits can be stricter. |
| Logical workspaces | Fork enhancement: metadata-only create/rename/remove and chat membership, shared sidebar/new-chat records, independent IDs for same-directory topics, preserved native cwd and ancestry, and selected membership for normal/scheduled creation and forks. Legacy folders migrate once; external unassigned conversations remain visible in directory-based defaults. |
| Recent models | Fork enhancement: server-backed cross-browser recents and an independent provider-labelled column on phone/desktop; retained during provider drilldown/search, with explicit hidden-model preferences preserved. |
| Metrics and history | Fork enhancement: live/average TPS, two-decimal estimated USD cost and context gauge in the chat strip; cache details on demand; unknown/zero distinction and full-branch totals before compaction/pagination. Existing earlier-history control loads pre-compaction pages read-only without resetting live work. |
| Per-chat quota behavior | Fork enhancement: composer **+** chooses fallback or same-model wait using a session-process policy overlay, not global configuration mutation. Manual timing/cancellation remains authoritative. |
| Scheduled prompts | Fork enhancement: model/timing selection for new or existing conversations, durable jobs, exact quota resets, delay or specific time, idempotent request identities, pre-creation journaling, execution ownership fencing, and no automatic duplicate prompt after uncertain creation or terminal metadata failure. |
| Durable drafts | Fork enhancement: server-backed normal and scheduled drafts, cross-device text/photo/settings recovery, autosaved checkpoints and restore, independent offline edit queues, and explicit revision conflicts. Accepted sends clear only the submitted active snapshot; history/photos remain until explicit draft cleanup. |
| Themes | Inherited themes/localization with updated placement: header **…** on phones and desktop, persistent browser preferences, light/dark/midnight themes, font/scale settings. Not a standalone phone theme trigger. |
| Native skills and plugins | Integrated native-backed management: workspace-scoped discovery, supported install/update controls and diagnostics through installed OMP, including managed/read-only sources. This is not a web-only replacement registry. |
| Notifications and PWA branding | Inherited notification delivery/history foundation with integrated phone/desktop surfaces, authenticated install metadata and bundled shared-source logo assets. Browser/OS delivery constraints still apply; PWA installation is not offline mode. |
| Optional quota failover extension | Separately shipped opt-in native extension with its own tests and user-configured model chain; not installed or enabled by web startup. Wait policies/running scheduled jobs take precedence over switching. |

## Storage boundaries

Default paths below describe generic OMP locations, not files shipped by this repository. `PI_CODING_AGENT_DIR` and OMP's directory resolution can relocate the agent root.

| Data | Where it lives | Shared between devices? |
| --- | --- | --- |
| Transcript files and native configuration/authentication | Your OMP agent directory and native stores | Browsers on this server see the same permitted sessions; credentials are not exported to browser drafts |
| Logical workspaces and chat memberships | Agent-root `workspaces.json`; legacy `session-folders.json` retained only as migration/rollback data | Yes, through the server; existing chat working directories remain unchanged |
| Model recents | Agent-root `recent-models.json`, plus browser cache | Yes, server-backed; the local cache alone is not authoritative |
| Execution policies, jobs, request receipts | Agent-root `web-session-execution.json` and associated durable metadata | Yes, through the server |
| Pairing tokens, devices, presence, revocations | Server-side pairing authority store | Yes, as authority; do not copy it between unrelated installations |
| Web-login signing key | Agent-root `omp-web/web-auth-secret.json` | Installation-private; not a password hash or browser preference |
| Push keys, device subscriptions and notification history | Server-side private notification database | Browser preferences remain device-specific |
| Normal and scheduled drafts, checkpoints, draft-owned photos | Private agent-root `omp-web/drafts/` with immutable checkpoints, content-addressed photos, and revision heads; supplementary device cache | Yes after server acknowledgement; offline-only edits still depend on device storage |
| Offline draft queues and photo cache | Small browser-local cache and independent writer journals; photos stored separately in IndexedDB | Not by themselves; reconnecting uploads edits with revision conflict checks |
| Uploaded documents | Original files saved in the chosen workspace | Ordinary server-side workspace files; not deleted when a selection or draft is cleared |

Clearing browser data, private browsing, or blocked storage can lose edits not yet acknowledged by the server. A new hostname/port/protocol or browser/profile has a separate offline cache but can recover acknowledged drafts after authenticating to the same server. Competing edits are retained and require an explicit conflict choice, not automatic merging. Draft checkpoints and photos have no automatic expiry; explicit cleanup removes only draft-owned content and keeps a content-free revision tombstone to reject stale requests. Server jobs already submitted are distinct from drafts and do not disappear merely because a dialog closes.

Keep data directories and service environment files owner-restricted. Back them up privately before upgrades; never include them in a public support bundle. A browser authorized to the web UI can drive the agent with the server user's capabilities, so pairing/passwords do not create a filesystem sandbox.

## Scheduling and quota semantics

- The composer's **+** menu owns scheduling and quota policy. Header **…** owns theme selection. Earlier history uses the existing conversation-top loading control; there is no second history toolbar.
- A schedule's model is independent of the active chat model. Once a scheduled/quota-resume job runs, its saved model is pinned for that execution.
- Exact provider reset choices retain account, model, and quota-window scope. A reset choice picks a time, **not an account**, and cannot guarantee that every applicable quota has cleared. Changing model invalidates a previous reset selection.
- Unknown waits automatically become timed waits only when exhausted quota evidence is unambiguously applicable. Multiple binding exhausted windows use the latest reset. Ambiguous/missing account or model evidence is not permission to guess. Users can supply a manual time or cancel.
- Hours/minutes delays are normalized; a specific date/time uses the selected instant. The OMPWeb Plus server must be running to send a due job. Restart recovery preserves pending state, but suspension, unavailable authentication, provider errors, and clock changes can affect actual execution time.
- New-chat scheduling records creation intent before starting native conversation creation. Repeated requests reuse their identity/body, including after a deadline. An unconfirmed native outcome remains uncertain instead of silently creating a second chat. Investigate known conversations before choosing to issue a genuinely new request.
- Genuine native persistence moves transfer ownership metadata. Deliberate branch/switch/new-session boundaries do not turn an unrelated conversation into the previous job owner. Fenced locks prevent stale writers from committing as current owners.
- Terminal evidence is retained until its metadata transaction commits; scheduler retries are metadata-only, not prompt replay. This is conservative recovery, not a universal exactly-once guarantee for third-party actions.
- Upgrade all web writers sharing an execution store together. Older locking protocols must not write alongside the current one. An ownerless/malformed `.lock` is not automatically reclaimed merely because it is old. Stop every writer before investigating and repairing a stranded lock; never delete a live writer's lock.

For optional native fallback, see [extensions/README.md](../extensions/README.md), [`agy-failover.ts`](../extensions/agy-failover.ts), and [its regression tests](../extensions/tests/agy-failover.test.mjs). `OMP_AGY_FAILOVER_CHAIN` is an ordered JSON list of your own authenticated `provider/model` selectors, inherited by the native OMP process. Missing, empty, or invalid configuration disables switching. Install only by following the opt-in guide. The extension rereads configuration and web execution policy at terminal failure, blocks keep-model and running scheduled-job fallback, and denies switching when policy is corrupt/unreadable. Native-only use with no web store is a separate supported case.

## Remote deployment limitations

- Use a password hash and HTTPS or a trusted encrypted VPN before remote use. LAN HTTP is plaintext. A firewall, pairing, or obscure URL does not encrypt passwords, cookies, prompts, or responses.
- The recommended proxy/tunnel origin is the loopback-bound production server. A direct non-loopback CLI bind requires a password hash. Do not expose the development server as a production endpoint.
- Only direct verified loopback can mint pairing authority. Host spoofing is insufficient, and forwarded/proxied connections remain remote. Revalidate this boundary after Node upgrades because socket attestation uses Node's experimental HTTP diagnostics channel.
- Pairing persistence failure is an access failure, not a reason to reset authority. Keep old valid state intact when settings are invalid; resolve storage errors before trying to pair again.
- `cloudflared` must be installed separately. Explicit quick-tunnel startup requires Internet access, supplies no stable hostname/availability guarantee, and involves a third party. A configured public URL is only a URL: DNS, TLS, proxying, external identity checks, and reachability are your responsibility. The stored auto-tunnel checkbox does not implement a startup guarantee.
- Proxies must support streaming and the app's request sizes. Image base64 overhead is included in the 135/145 MiB command/proxy limits, but an additional proxy/CDN/provider may reject smaller payloads. Do not solve this by silently truncating attachments.
- An optional trusted-proxy password bypass needs a random high-entropy shared secret with only its digest configured in the app. The proxy must remove client-supplied auth headers, enforce intended hostnames, trust only real known upstream peers, and prevent direct origin access. It does not confer local pairing authority.

## Native/runtime requirements

Feature availability follows the separately installed OMP runtime, not this web package's version. Unsupported native commands must remain explicit limitations.

- Native queue state: OMP 18.4.4+ `queuedMessages` and `queue_update`.
- Promote queued follow-up: `promote_queued_message`; queue edit/delete: `remove_queued_message`. Delivered input cannot be recalled. Atomic stop/queue restore is used when supported; older compatibility paths do not invent native queue state.
- Completion notification evidence: OMP 18.3.1+ `prompt_result` and `session_settled`.
- Skill startup diagnostics: `get_skill_diagnostics`, `set_skill_startup_diagnostics`, and `skill_diagnostics_update`; notices use native `skills.showStartupDiagnostics`. A stopped session is not resumed just to inspect diagnostics, and missing support is not reported as a clean scan.
- Native skills/plugins use the selected workspace and runtime. Managed/plugin-provided entries may be read-only. Installation may require network access and executing third-party tooling; review the source and requested operation first.
- Quota reports/reset scope, model access, reasoning options, provider pricing, and transcription models depend on your own authenticated OMP installation. No model catalog entry guarantees a free tier, subscription entitlement, or continued endpoint availability.

## File observation

Saved-chat updates from external OMP processes use a shared native session-tree watcher. Because native watcher registration can return before event delivery is armed, startup compares file metadata once per second until the current native handle delivers its first event, then performs a final reconciliation and stops sampling. An initially idle tree can remain in this metadata-only startup phase until its first native event. No probe files are written and transcript contents are not polled.

Detected changes retain the existing debounce and targeted cache invalidation. The last subscriber releases the native handle and outstanding startup, debounce, and retry work. Native watch errors keep read-only startup coverage while registration is retried; this is not a guarantee against every operating-system event loss or inaccessible filesystem.

## Dependency advisories

The publication-time `npm audit --omit=dev` reports 22 production dependency findings: 5 low, 6 moderate, 6 high, and 5 critical. The counts describe affected dependency records, not a verified number of independently exploitable application vulnerabilities, and the registry's advisory data can change.

These inherited dependency findings were not remediated as part of the source/privacy migration. Passing tests, builds, and secret scans do not establish that the application is vulnerability-free. Run `npm audit --omit=dev` against the installed lockfile, review affected execution paths and upstream fixes, and do not treat this repository as security-certified for Internet exposure. Authentication, pairing, and encrypted transport do not repair vulnerable dependencies. Avoid blanket `npm audit fix --force` upgrades without reviewing their compatibility effects.

## Notifications and installable app

The server must be running for delivery. Web Push additionally requires a secure context, subscription/permission, supported browser/OS, and outbound access to push services. System-only fallback needs an open tab; non-localhost plain HTTP supports only in-app toasts. Desktop push can require the browser process running. iOS/iPadOS 16.4+ requires an installed Home Screen app for push. Presence and user settings suppress delivery in some active-session cases; OS policies can defer notifications.

Sign in first, then use the browser's installation menu. The authenticated manifest embeds the bundled icons rather than requiring a public icon/manifest bypass. Keep application and external access controls in place. OS icon caching can delay branding changes. No offline agent or offline browsing mode is promised.

## Intentionally not included

- Any user's credentials, API keys, cookies, password hashes, model/auth databases, native personal configuration, sessions, archived transcripts, folder assignments, recent models, execution/pairing state, push subscriptions, browser drafts, logs, or launch configuration.
- Historical provider/model setup as portable defaults: configure your own supported models and credentials. No automatic substitution of a retired free endpoint with a paid model is promised.
- A separate private Hub application or its provider-quota dashboard/backend. Native OMP usage information in this web app is not that separate integration.
- A separate native voice bridge: that work is deferred. Existing optional transcription endpoints and audio-job code are inherited capabilities, not evidence of completion of the bridge.
- Private deployment/activation automation, private operational reviews, or screenshots containing actual conversations. Public documentation is not an operational health report.
- Prebuilt Electron desktop installers or an npm-published fork. Source CLI, platform service/tray helpers, browser installation, and the optional native extension remain distinct distribution/use paths.

For installation see [README](../README.md); for source maintenance see [release.md](release.md); for contributions see [CONTRIBUTING](../CONTRIBUTING.md). These documents describe the shipped design and limitations and do not substitute for the checks exercised on a particular release.
