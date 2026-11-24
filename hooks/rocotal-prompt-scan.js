#!/usr/bin/env node
// rocotal-prompt-scan - Codex UserPromptSubmit hook: hand each prompt to
// Rocotal before the model reads it.
//
// Monitor-only. Writes nothing to stdout, because Codex injects plain stdout as
// extra developer context. Every failure exits 0, so a prompt always reaches the
// model.

'use strict';

const { DEFAULT_TIMEOUT_SECONDS, resolveConfig } = require('./rocotal-config');

// shortcut: matches the gateway scan budget; longer prompts are scanned only in part.
const MAX_PROMPT_CHARS = 8000;
const CLIENT_NAME = 'codex-cli';
const DEBUG_ENV = 'ROCOTAL_PROMPT_SCAN_DEBUG';

function debug(message) {
  if (process.env[DEBUG_ENV]) {
    process.stderr.write('roco-prompt-scan: ' + message + '\n');
  }
}

// The scan body for one hook event, or null when there is nothing to scan.
function buildPayload(hookInput) {
  const prompt = hookInput && hookInput.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return null;
  }
  return {
    // Code points, not UTF-16 units, so a cut never leaves half a surrogate pair.
    prompt: Array.from(prompt).slice(0, MAX_PROMPT_CHARS).join(''),
    source: CLIENT_NAME,
    session_id: String(hookInput.session_id || '').slice(0, 256) || null,
    client: CLIENT_NAME,
  };
}

// POST the scan and return the HTTP status, or null when the call failed.
// A scan failure must never break the prompt, so this never throws.
async function postScan(url, key, payload, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1, timeoutSeconds * 1000)),
    });
    return response.status;
  } catch (error) {
    debug('scan failed: ' + error.message);
    return null;
  }
}

// Never wait on stdin forever: some hosts wrap hooks in a shell that swallows
// the piped JSON, and a hung hook would freeze the user's prompt.
function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve(input);
    };
    const fallback = setTimeout(finish, 1000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main() {
  let payload = null;
  try {
    const raw = (await readStdin()).replace(/^\uFEFF/, '');
    let hookInput;
    try {
      hookInput = JSON.parse(raw);
    } catch (_) {
      debug('unreadable hook input');
      return 0;
    }
    if (!hookInput || typeof hookInput !== 'object' || Array.isArray(hookInput)) {
      return 0;
    }
    payload = buildPayload(hookInput);
  } catch (error) {
    debug('unreadable hook input: ' + error.message);
    return 0;
  }

  const { gatewayUrl, agentKey, timeoutSeconds } = resolveConfig();
  if (!gatewayUrl || !agentKey || payload === null) {
    debug('skipped: missing url, key, or prompt');
    return 0;
  }

  const status = await postScan(gatewayUrl, agentKey, payload, timeoutSeconds);
  debug('scan status=' + status);
  return 0;
}

// The plugin launches this file through `node -e "require(...)"`, where
// require.main is undefined, so a plain require.main === module guard would never
// fire and no scan would ever be sent. Start in that case too; a test file that
// require()s this module has itself as require.main, so it never starts the hook.
function startedAsEntryPoint() {
  return require.main === module || require.main === undefined;
}

if (startedAsEntryPoint()) {
  main().then(
    () => process.exit(0),
    () => process.exit(0)
  );
}

module.exports = { buildPayload, postScan, main, MAX_PROMPT_CHARS, CLIENT_NAME };
