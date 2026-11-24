'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  getConfigPath,
  normalizeTimeoutSeconds,
  resolveConfig,
  writeConfig,
} = require('../hooks/rocotal-config');

const CONFIG_CLI = path.join(__dirname, '..', 'hooks', 'rocotal-config.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'roco-scan-config-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const configRoot = path.join(temp, 'config');
const configDirEnv = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
const configFile = path.join(configRoot, 'rocotal', 'config.json');

// Run a block with a clean ROCOTAL_* environment pointed at the temp config root,
// then restore whatever the test process had.
function withEnv(extra, body) {
  const saved = {};
  for (const key of new Set([...Object.keys(process.env).filter((k) => k.startsWith('ROCOTAL_')), configDirEnv, ...Object.keys(extra)])) {
    saved[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ROCOTAL_')) delete process.env[key];
  }
  Object.assign(process.env, { [configDirEnv]: configRoot }, extra);
  try {
    return body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('getConfigPath honours the platform config root', () => {
  withEnv({}, () => {
    assert.equal(getConfigPath(), configFile);
  });
});

test('timeout parsing accepts a valid value and bounds everything else to 5', () => {
  assert.equal(normalizeTimeoutSeconds(25), 25);
  assert.equal(normalizeTimeoutSeconds('25'), 25);
  assert.equal(normalizeTimeoutSeconds(1), 1);
  assert.equal(normalizeTimeoutSeconds(MAX_TIMEOUT_SECONDS), 60);
  for (const bad of ['0', 0, '-3', -3, 'abc', '999', 999, null, undefined, '', ' ', NaN, Infinity, {}]) {
    assert.equal(normalizeTimeoutSeconds(bad), DEFAULT_TIMEOUT_SECONDS, 'value: ' + String(bad));
  }
});

test('an absent config resolves to unset values and the default timeout', () => {
  withEnv({}, () => {
    assert.deepEqual(resolveConfig(), { gatewayUrl: '', agentKey: '', timeoutSeconds: DEFAULT_TIMEOUT_SECONDS });
  });
});

test('the config file is read when no environment variable is set', () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ gatewayUrl: ' https://gw.test/scan ', agentKey: ' rct_file ', timeoutSeconds: 12 }));
  try {
    withEnv({}, () => {
      assert.deepEqual(resolveConfig(), { gatewayUrl: 'https://gw.test/scan', agentKey: 'rct_file', timeoutSeconds: 12 });
    });
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  }
});

test('environment variables win over the file, field by field', () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ gatewayUrl: 'https://file.test/scan', agentKey: 'rct_file', timeoutSeconds: 12 }));
  try {
    withEnv({ ROCOTAL_PROMPT_SCAN_URL: 'https://env.test/scan' }, () => {
      assert.deepEqual(resolveConfig(), { gatewayUrl: 'https://env.test/scan', agentKey: 'rct_file', timeoutSeconds: 12 });
    });
    withEnv({ ROCOTAL_AGENT_KEY: 'rct_env', ROCOTAL_PROMPT_SCAN_TIMEOUT_SECONDS: '30' }, () => {
      assert.deepEqual(resolveConfig(), { gatewayUrl: 'https://file.test/scan', agentKey: 'rct_env', timeoutSeconds: 30 });
    });
    withEnv({ ROCOTAL_PROMPT_SCAN_TIMEOUT_SECONDS: '999' }, () => {
      assert.equal(resolveConfig().timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 'an out-of-range env timeout falls back to 5');
    });
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  }
});

test('a BOM, an unreadable file, and malformed JSON all resolve without throwing', () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  try {
    fs.writeFileSync(configFile, '\uFEFF' + JSON.stringify({ gatewayUrl: 'https://bom.test/scan', agentKey: 'rct_bom' }), 'utf8');
    withEnv({}, () => {
      assert.equal(resolveConfig().gatewayUrl, 'https://bom.test/scan');
    });
    for (const content of ['{ not json', '[]', 'null', '"text"']) {
      fs.writeFileSync(configFile, content, 'utf8');
      withEnv({}, () => {
        assert.deepEqual(resolveConfig(), { gatewayUrl: '', agentKey: '', timeoutSeconds: DEFAULT_TIMEOUT_SECONDS });
      });
    }
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  }
});

test('writeConfig round-trips and preserves unrelated keys', () => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ unrelated: 'keep-me' }));
  try {
    const written = withEnv({}, () => writeConfig({ gatewayUrl: ' https://gw.test/scan ', agentKey: ' rct_live_key ', timeoutSeconds: 10 }));
    assert.equal(written, configFile);
    const text = fs.readFileSync(configFile, 'utf8');
    assert.ok(text.endsWith('\n'), 'the file ends with a newline');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, 'an existing file is tightened to 0600');
    }
    assert.deepEqual(JSON.parse(text), {
      unrelated: 'keep-me',
      gatewayUrl: 'https://gw.test/scan',
      agentKey: 'rct_live_key',
      timeoutSeconds: 10,
    });
    withEnv({}, () => {
      assert.deepEqual(resolveConfig(), { gatewayUrl: 'https://gw.test/scan', agentKey: 'rct_live_key', timeoutSeconds: 10 });
    });
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  }
});

test('writeConfig rejects a non-http URL, a bad key, and an out-of-range timeout', () => {
  withEnv({}, () => {
    assert.throws(() => writeConfig({ gatewayUrl: 'ftp://gw.test/scan', agentKey: 'rct_key' }), /http\(s\) URL/);
    assert.throws(() => writeConfig({ gatewayUrl: 'not a url', agentKey: 'rct_key' }), /http\(s\) URL/);
    assert.throws(() => writeConfig({ gatewayUrl: 'https://gw.test/scan', agentKey: 'nope' }), /rct_/);
    assert.throws(() => writeConfig({ gatewayUrl: 'https://gw.test/scan', agentKey: 'rct_key', timeoutSeconds: 0 }), /greater than 0/);
    assert.throws(() => writeConfig({ gatewayUrl: 'https://gw.test/scan', agentKey: 'rct_key', timeoutSeconds: 61 }), /greater than 0/);
  });
  assert.equal(fs.existsSync(configFile), false, 'a rejected write must not touch disk');
});

test('the --write CLI prints only the written path and exits 0', () => {
  try {
    const result = spawnSync(process.execPath, [CONFIG_CLI, '--write'], {
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ROCOTAL_'))),
        [configDirEnv]: configRoot,
        ROCOTAL_SETUP_GATEWAY_URL: 'https://gw.test/scan',
        ROCOTAL_SETUP_AGENT_KEY: 'rct_cli_key',
        ROCOTAL_SETUP_TIMEOUT_SECONDS: '15',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Wrote ' + configFile + '\n');
    assert.equal(result.stderr, '');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, 'the config holds a key, so it is 0600');
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), {
      gatewayUrl: 'https://gw.test/scan',
      agentKey: 'rct_cli_key',
      timeoutSeconds: 15,
    });
  } finally {
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  }
});

test('the --write CLI reports a failure on stderr and exits 1', () => {
  const result = spawnSync(process.execPath, [CONFIG_CLI, '--write'], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ROCOTAL_'))),
      [configDirEnv]: configRoot,
      ROCOTAL_SETUP_GATEWAY_URL: 'https://gw.test/scan',
      ROCOTAL_SETUP_AGENT_KEY: 'bad-key',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '', 'a failure prints nothing on stdout');
  assert.match(result.stderr, /^roco-prompt-scan: .*rct_/);
  assert.equal(fs.existsSync(configFile), false);
});
