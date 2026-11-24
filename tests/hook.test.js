'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { buildPayload, MAX_PROMPT_CHARS, CLIENT_NAME } = require('../hooks/rocotal-prompt-scan');

const HOOK = path.join(__dirname, '..', 'hooks', 'rocotal-prompt-scan.js');
const PLUGIN_ROOT = path.join(__dirname, '..');
const HOOKS_JSON = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roco-scan-hook-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// Point config resolution at a throwaway directory so no real user config is read.
const configRoot = path.join(temp, 'config');
const configDirEnv = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
const configFile = path.join(configRoot, 'rocotal', 'config.json');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ROCOTAL_')) delete env[key];
  }
  env[configDirEnv] = configRoot;
  return { ...env, ...extra };
}

function runHook({ env = {}, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    requests,
    url: 'http://127.0.0.1:' + server.address().port + '/integrations/prompt-scan',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('buildPayload returns the exact scan body', () => {
  const payload = buildPayload({ prompt: 'hello', session_id: 's1' });
  assert.deepEqual(payload, {
    prompt: 'hello',
    source: 'codex-cli',
    session_id: 's1',
    client: 'codex-cli',
  });
  assert.deepEqual(Object.keys(payload).sort(), ['client', 'prompt', 'session_id', 'source']);
  assert.equal(CLIENT_NAME, 'codex-cli');
});

test('buildPayload sends session_id null when the host omits it', () => {
  assert.equal(buildPayload({ prompt: 'hello' }).session_id, null);
  assert.equal(buildPayload({ prompt: 'hello', session_id: '' }).session_id, null);
  assert.equal(buildPayload({ prompt: 'hello', session_id: 'x'.repeat(300) }).session_id.length, 256);
});

test('buildPayload ignores missing and blank prompts', () => {
  assert.equal(buildPayload({}), null);
  assert.equal(buildPayload({ prompt: '   ' }), null);
  assert.equal(buildPayload({ prompt: 42 }), null);
  assert.equal(buildPayload(null), null);
});

test('buildPayload truncates the prompt to 8,000 characters', () => {
  const payload = buildPayload({ prompt: 'x'.repeat(50000) });
  assert.equal(payload.prompt.length, MAX_PROMPT_CHARS);
  assert.equal(MAX_PROMPT_CHARS, 8000);
});

test('buildPayload never splits a surrogate pair at the truncation boundary', () => {
  const payload = buildPayload({ prompt: 'x'.repeat(MAX_PROMPT_CHARS - 1) + '\u{1F600}' + 'tail' });
  assert.equal(Array.from(payload.prompt).length, MAX_PROMPT_CHARS);
  assert.ok(payload.prompt.endsWith('\u{1F600}'), 'the last code point is the whole emoji');
  assert.equal(/\uD83D$/.test(payload.prompt), false, 'no lone high surrogate at the cut');
});

test('the hook posts the payload with a bearer key and prints nothing', async () => {
  const gateway = await startServer();
  try {
    const result = await runHook({
      env: { ROCOTAL_PROMPT_SCAN_URL: gateway.url, ROCOTAL_AGENT_KEY: 'rct_test_key' },
      input: JSON.stringify({ prompt: 'hello', session_id: 's1' }),
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(gateway.requests.length, 1);
    const [request] = gateway.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer rct_test_key');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), {
      prompt: 'hello',
      source: 'codex-cli',
      session_id: 's1',
      client: 'codex-cli',
    });
  } finally {
    await gateway.close();
  }
});

test('environment values win over the config file', async () => {
  const gateway = await startServer();
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ gatewayUrl: 'http://127.0.0.1:1/scan', agentKey: 'rct_file_key' }));
  try {
    const result = await runHook({
      env: { ROCOTAL_PROMPT_SCAN_URL: gateway.url, ROCOTAL_AGENT_KEY: 'rct_env_key' },
      input: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0].headers.authorization, 'Bearer rct_env_key');
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
    await gateway.close();
  }
});

test('the config file is used when no environment variable is set', async () => {
  const gateway = await startServer();
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ gatewayUrl: gateway.url, agentKey: 'rct_file_key', timeoutSeconds: 10 }));
  try {
    const result = await runHook({ input: JSON.stringify({ prompt: 'hello' }) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0].headers.authorization, 'Bearer rct_file_key');
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
    await gateway.close();
  }
});

test('missing configuration sends no request and exits 0', async () => {
  const gateway = await startServer();
  try {
    const result = await runHook({
      env: { ROCOTAL_PROMPT_SCAN_URL: gateway.url },
      input: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(gateway.requests.length, 0, 'no agent key means no request');
  } finally {
    await gateway.close();
  }
});

test('an unreachable host exits 0 and prints nothing', async () => {
  const result = await runHook({
    env: { ROCOTAL_PROMPT_SCAN_URL: 'http://127.0.0.1:1/scan', ROCOTAL_AGENT_KEY: 'rct_test_key' },
    input: JSON.stringify({ prompt: 'hello' }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
});

test('no environment and no config file skips silently without a request', async () => {
  assert.equal(fs.existsSync(configFile), false, 'the test must not inherit a config file');
  const result = await runHook({ input: JSON.stringify({ prompt: 'hello' }) });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('the hook exits 0 when stdin never closes', async () => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('hook hung on open stdin and would freeze the prompt'));
    }, 4000);
    child.on('error', reject);
    child.on('close', (exitCode) => { clearTimeout(guard); resolve(exitCode); });
  });
  assert.equal(code, 0);
});

test('malformed stdin exits 0 and sends nothing', async () => {
  const gateway = await startServer();
  try {
    for (const input of ['not json', '[]', 'null', '']) {
      const result = await runHook({
        env: { ROCOTAL_PROMPT_SCAN_URL: gateway.url, ROCOTAL_AGENT_KEY: 'rct_test_key' },
        input,
      });
      assert.equal(result.code, 0, 'input: ' + JSON.stringify(input));
      assert.equal(result.stdout, '');
    }
    assert.equal(gateway.requests.length, 0);
  } finally {
    await gateway.close();
  }
});

// The shipped launcher is `node -e "require(...)"`, where require.main is undefined.
// Spawning the script file directly (above) proves the port, not the install path,
// so this runs the literal command from hooks/hooks.json the way Codex does.
function shippedCommand() {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8').replace(/^\uFEFF/, ''));
  const entries = Object.values(hooks.hooks).flat();
  assert.equal(entries.length, 1, 'hooks.json declares exactly one hook entry');
  assert.equal(entries[0].hooks.length, 1, 'the entry declares exactly one command hook');
  const [hook] = entries[0].hooks;
  assert.equal(hook.type, 'command');
  assert.equal(hook.timeout, 30);
  assert.equal(hook.statusMessage, 'Scanning prompt with Rocotal');
  assert.match(hook.command, /^node -e /);
  return hook.command;
}

// Async, unlike runHook: spawnSync would block this process's event loop and the
// in-process gateway server could never answer the hook's request.
function runShippedCommand(command, env, input) {
  const [shell, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', command]]
    : ['/bin/sh', ['-c', command]];
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('launcher hung')); }, 20000);
    child.on('error', (error) => { clearTimeout(guard); reject(error); });
    child.on('close', (code) => { clearTimeout(guard); resolve({ status: code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('the shipped hooks.json launcher sends a scan', async () => {
  const command = shippedCommand();
  const gateway = await startServer();
  try {
    const result = await runShippedCommand(
      command,
      cleanEnv({
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        ROCOTAL_PROMPT_SCAN_URL: gateway.url,
        ROCOTAL_AGENT_KEY: 'rct_launcher_key',
      }),
      JSON.stringify({ prompt: 'launcher check', session_id: 's-launcher' }),
    );
    assert.equal(result.status, 0, 'launcher must exit 0: ' + result.stderr);
    assert.equal(result.stdout, '', 'launcher must write nothing to stdout');
    assert.equal(gateway.requests.length, 1, 'the launcher must actually send the scan');
    const [request] = gateway.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer rct_launcher_key');
    assert.deepEqual(JSON.parse(request.body), {
      prompt: 'launcher check',
      source: 'codex-cli',
      session_id: 's-launcher',
      client: 'codex-cli',
    });
  } finally {
    await gateway.close();
  }
});

test('the shipped launcher exits 0 when the gateway is unreachable', async () => {
  const result = await runShippedCommand(
    shippedCommand(),
    cleanEnv({
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      ROCOTAL_PROMPT_SCAN_URL: 'http://127.0.0.1:1/scan',
      ROCOTAL_AGENT_KEY: 'rct_launcher_key',
    }),
    JSON.stringify({ prompt: 'launcher check' }),
  );
  assert.equal(result.status, 0, 'launcher must exit 0 on failure: ' + result.stderr);
  assert.equal(result.stdout, '');
});
