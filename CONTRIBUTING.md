# Contributing to OMPWeb Plus

Thanks for contributing to this independent community fork of [kahme247/ompweb](https://github.com/kahme247/ompweb). Its upstream integration baseline is 0.5.2, commit `8888c15b23d7ff891da5d1670e158db851b10c27`. Preserve the [MIT license](LICENSE), including the original **Copyright (c) 2026 agegr** notice and upstream credit.

Use [this fork's issues](https://github.com/kaanzapkinus/ompweb-plus/issues) and [pull requests](https://github.com/kaanzapkinus/ompweb-plus/pulls) for fork-specific work. Do not present a fork-specific problem as an upstream regression without isolating it.

## Source setup

Requirements: Node.js 24+, npm, Git, and a separately installed [OMP runtime](https://github.com/can1357/oh-my-pi) on `PATH` or configured with `OMP_WEB_OMP_BIN`.

```bash
git clone https://github.com/kaanzapkinus/ompweb-plus.git
cd ompweb-plus
npm ci
npm run dev
```

Development runs at <http://127.0.0.1:30178>. A production source install uses `npm run build` followed by `node bin/omp-web.js`; see [README](README.md). The fork is not published to npm: do not add registry installation examples, upstream-package self-update fallbacks, or release automation that silently replaces this source checkout.

Do not run a production build while a development server is using the same `.next` directory. Stop the server first or use a separate checkout.

## Isolate private runtime data

Use a throwaway OMP agent directory via `PI_CODING_AGENT_DIR` and synthetic workspaces for tests, screenshots, and runtime experiments. Do not connect automated smoke runs to real sessions, provider credentials, pairing authority, or scheduled jobs. Unit tests should isolate files with temporary directories and restore changed environment variables.

Never commit real transcripts, archived conversations, model configuration/auth databases, API keys, cookies, password hashes, QR/pairing links, device records, push subscriptions, browser drafts, service environment files, logs, or operational reports. Use generic test identities and paths. A sanitized filename does not sanitize an image: screenshots must show synthetic content, including every sidebar entry and address bar. Public documentation should be in English and must not include personal deployment details.

See [release scope and storage boundaries](docs/public-release.md) before adding data-handling features.

## Checks before submitting

These are contributor instructions, not a claim that any particular checkout has passed them:

```bash
npm run typecheck
npm run lint
npm test
```

For release work, stop any same-checkout development server and run `npm run build` separately. `npm test` includes the optional extension regression suite; the extension itself remains an explicit opt-in native installation. Document any check you did not run and any environment-dependent limitation rather than claiming unobserved success.

### Regression and React tests

Write a meaningful failing regression before changing executable behavior. Test the failure boundary, not just source text or a happy-path rendering. Scheduling tests should cover uncertain creation/retry identity, metadata-only retries, policy ownership, manual cancellation/timing, and ambiguous quota scope. Pairing changes must cover actual locality and durable failure behavior.

Tests use `node:test` and `jiti`; no Jest or Vitest setup is required. For interactive components/hooks, import `tests/setup-dom.mjs` before `@testing-library/react/pure.js` and register `cleanup` with `afterEach`. Use DOM queries and `@testing-library/user-event` for interactions, and `renderHook` for lifecycle tests. Keep the real jsdom `window`/`document`; mock only browser or network APIs the scenario requires.

Static HTML tests can use `react-dom/server`. Layout, keyboard/viewport behavior, scrolling, push delivery, PWA installation, and actual loopback/LAN/tunnel boundaries still need suitable real-browser/runtime verification. jsdom remains on 29.x; changing that major is separate work.

The optional extension lives at `extensions/agy-failover.ts`, with tests at `extensions/tests/agy-failover.test.mjs`. Keep its deployment-neutral chain configuration and fail-closed web-policy handling intact; never add a maintainer's provider/model choices as enabled defaults.

## Architecture and conventions

- **Architecture:** never import Bun-only `@oh-my-pi/*` or `@earendil-works/*` into the Node/Next server. Live agent work goes through the installed `omp` child process and RPC. Reuse the boundaries in `DESIGN.md` and `AGENTS.md`.
- **Styling:** use tokens in `app/globals.css` for colors, radius, shadow, and motion. Reuse `components/ui/` primitives and `lucide-react` icons.
- **Localization:** add user-visible strings to all dictionaries in `lib/i18n/locales/{en,zh-CN,ja}.json`; the UI supports all three languages even though public release documentation is maintained in English.
- **Mobile:** preserve keyboard-visible viewport behavior, focus ownership/return, 16px input sizing, bounded minimap layout, and older-browser compatibility.
- **Persistence:** keep browser-local drafts separate from shared server jobs/recents/folders. Do not move transcript files to implement topic folders or reinterpret an uncertain scheduling result as permission to replay a prompt.
- **Security:** remote access must fail closed when durable authority is unavailable. Host/forwarded headers are not proof of direct loopback. Keep deployment secrets out of child environments, public fixtures, and logs.
- **Scope:** preserve working native-backed features; do not introduce duplicate registries or pretend missing native diagnostics are a clean result. Update the relevant public documentation when behavior changes.

## Pull requests and reports

Keep changes focused. Describe user-visible behavior, provenance when integrating upstream changes, regression coverage, commands actually exercised, and remaining limitations. For UI changes, include synthetic before/after screenshots in light/dark modes when useful; never use actual conversation data.

Include OS, Node version, OMP version, browser, and reproducible steps in issue reports. Remove tokens, private URLs, usernames, workspace paths, and conversation contents before sharing logs. Check [docs/release.md](docs/release.md) for source-release maintenance, not npm publication instructions.
