# Rocotal prompt scan for Codex (RCT-460)

Monitor-only: every prompt Codex submits is scanned by Rocotal before the model reads it. Nothing is blocked, and the prompt still reaches the model when Rocotal is unreachable.

## Install

1. Add the marketplace: `codex plugin marketplace add https://github.com/HuzefaRoco/rocotal-prompt-scan`
2. Install it: `codex plugin add rocotal-prompt-scan@rocotal`
3. Restart Codex and approve the hook once with `/hooks`.

## One-time setup

Create an agent key on Rocotal's AI apps and agents page, then run `/rocotal-setup` and paste the gateway scan URL and the key.

To skip the command, write the config file yourself:

- Windows: `%APPDATA%\rocotal\config.json`
- macOS and Linux: `~/.config/rocotal/config.json` (or `$XDG_CONFIG_HOME/rocotal/config.json`)

```json
{
  "gatewayUrl": "https://<your-rocotal-host>/integrations/prompt-scan",
  "agentKey": "rct_live_...",
  "timeoutSeconds": 10
}
```

Environment variables also work and win over the file, field by field: `ROCOTAL_PROMPT_SCAN_URL`, `ROCOTAL_AGENT_KEY`, `ROCOTAL_PROMPT_SCAN_TIMEOUT_SECONDS`.

The hook itself gives up after 30 seconds, so a timeout above that cannot delay a prompt longer than 30 seconds.

## Verify

The gateway must run with `PROMPT_SCAN_ENABLED` on (it defaults to false); otherwise nothing is recorded.

Send one prompt containing a fake email address, then open **Monitor -> Guardrails evidence** and filter by the `external_tool` workflow. The prompt should appear with its sensitivity label and still reach the model.

## What gets sent

To the gateway URL you configured, with `Authorization: Bearer <agent key>`: the prompt truncated to 8,000 characters, plus `source`, `session_id`, and `client` (`codex-cli`).

## Tests

From this directory: `node --test`

## Releasing

The catalog in this repo points back at this repo, pinned to a tag, so a release is two steps and
the order matters.

1. Bump `version` in `.codex-plugin/plugin.json`, commit, then tag and push:

   ```
   git tag -a v0.2.0 -m "rocotal-prompt-scan 0.2.0"
   git push origin main v0.2.0
   ```

2. Point the catalog at the new tag and push `main` again:

   ```
   # .agents/plugins/marketplace.json -> "ref": "v0.2.0"
   git commit -am "release v0.2.0"
   git push origin main
   ```

The tagged tree still carries the previous `ref`; installs follow the catalog on `main`, so the
second push is what makes the new version available. Existing installs keep the version they
installed until someone upgrades.
