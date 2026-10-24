# Optional terminal-quota failover extension

`agy-failover.ts` is an **opt-in OMP extension**, not a required OMPWeb Plus dependency. It handles terminal quota/account-exhaustion errors after the native retry engine has stopped, switches to the next model in your configured chain, and asks the agent to continue the same task.

Nothing in this repository automatically installs or activates it. There are **no built-in provider, account, or model defaults**. Installing the file without configuring a chain does not enable model switching.

## Manual installation

From a source checkout, copy `extensions/agy-failover.ts` into the extensions directory of the OMP agent installation you intend to use. For the default agent directory:

```sh
mkdir -p "$HOME/.omp/agent/extensions"
cp -i extensions/agy-failover.ts "$HOME/.omp/agent/extensions/agy-failover.ts"
```

Review an existing file before replacing it. If you use `PI_CODING_AGENT_DIR`, use its `extensions` directory instead. If you use `PI_CONFIG_DIR`, the default agent directory is `$HOME/$PI_CONFIG_DIR/agent`. Restart the intended OMP sessions after installation or removal so extension discovery runs again. Existing sessions are not modified by copying a file.

To uninstall, remove only the copy you installed and restart those sessions. Do not copy any runtime state or credentials from another installation.

## Configure your own chain

Set `OMP_AGY_FAILOVER_CHAIN` in the environment inherited by the OMP process. Its value is a JSON array of ordered `provider/model` selectors:

```sh
export OMP_AGY_FAILOVER_CHAIN='["provider-a/model-a","provider-b/model-b"]'
```

These are deliberately generic placeholders, **not working provider names or model recommendations**. Replace them with selectors available in your own OMP model registry. Authenticate those providers using your own OMP installation. The extension does not configure endpoints, load credentials, grant provider access, or change authentication settings. Selecting a different provider can send subsequent task context to that provider; include only providers you intend to use.

For terminal sessions, export the value before starting `omp`. For OMPWeb Plus, export it before starting the web server so spawned OMP sessions inherit it. If the web server runs as a service, configure the environment in your own service definition and restart it; setting a variable in an unrelated terminal does not change a running service's environment.

The chain is read on every terminal `session_stop` hook. There is no separate configuration file. An unset value, an empty array, malformed JSON, or any entry that is not a nonempty `provider/model` selector disables extension-driven model changes. Unresolvable models are skipped; a rejected or throwing model switch advances to the next candidate. The chain order is the same for every starting model family.

## Policy and continuation safety

- Only a terminal assistant error matching quota/account-exhaustion text can trigger this extension. Ordinary authentication failures and successful turns do not trigger fallback. This does not replace native retry behavior.
- Before switching models, the hook re-reads `web-session-execution.json` from the agent directory. A session's explicit `wait` policy blocks fallback. More generally, an existing policy must have `mode: "fallback"` to permit it.
- A scheduled job with `status: "running"` for that same session blocks extension fallback even when its policy allows fallback. Jobs for other sessions and completed jobs do not block it.
- Corrupt, unsupported, or unreadable execution metadata fails closed: keep the selected model and do not request continuation. A missing metadata file remains valid for native-only OMP sessions, provided you explicitly configured a chain.
- Models already tried in that session's current failure chain, including the current model and aliases resolving to a tried model, are not selected again. A successful/non-quota turn resets that in-memory tried state. Exhausting all candidates stops extension continuation rather than looping. Restarting the OMP process also discards the in-memory state.
- The extension never writes web execution metadata, schedules jobs, changes wait settings, or installs itself into another agent directory.

## Regression tests

From the repository root with Node.js 24 or newer:

```sh
node --experimental-strip-types --test extensions/tests/agy-failover.test.mjs
```

The tests import the actual extension, register its real hook against a small OMP API boundary fixture, and use temporary agent directories for configuration/policy isolation. They do not read or modify the developer's real agent directory, model credentials, or conversations.
