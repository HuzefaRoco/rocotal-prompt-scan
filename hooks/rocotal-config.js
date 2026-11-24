#!/usr/bin/env node
// rocotal-prompt-scan — shared configuration resolver and writer.
//
// Resolution order per field: environment variable, then config file, then unset.
// Config file: %APPDATA%\rocotal\config.json on Windows, else
// $XDG_CONFIG_HOME/rocotal/config.json, else ~/.config/rocotal/config.json.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 60;

const URL_ENV = 'ROCOTAL_PROMPT_SCAN_URL';
const KEY_ENV = 'ROCOTAL_AGENT_KEY';
const TIMEOUT_ENV = 'ROCOTAL_PROMPT_SCAN_TIMEOUT_SECONDS';

function getConfigPath() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'rocotal',
      'config.json'
    );
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'rocotal', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'rocotal', 'config.json');
}

// A missing, unreadable or malformed file means "unset"; it must never throw,
// because a broken config may only skip the scan, never break a prompt.
function readConfigFile() {
  try {
    const text = fs.readFileSync(getConfigPath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) {
    return {};
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTimeoutSeconds(value) {
  const seconds = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS ? seconds : DEFAULT_TIMEOUT_SECONDS;
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function resolveConfig() {
  const file = readConfigFile();
  const envTimeout = trimString(process.env[TIMEOUT_ENV]);
  const timeoutValue = envTimeout || file.timeoutSeconds;
  return {
    gatewayUrl: trimString(process.env[URL_ENV]) || trimString(file.gatewayUrl),
    agentKey: trimString(process.env[KEY_ENV]) || trimString(file.agentKey),
    timeoutSeconds: normalizeTimeoutSeconds(timeoutValue),
  };
}

// Trust boundary: the setup command writes a user-supplied URL and secret here,
// so validate both before anything reaches disk.
function writeConfig({ gatewayUrl, agentKey, timeoutSeconds } = {}) {
  const url = trimString(gatewayUrl);
  if (!isHttpUrl(url)) {
    throw new Error('gatewayUrl must be an http(s) URL');
  }
  const key = trimString(agentKey);
  if (!key.startsWith('rct_')) {
    throw new Error('agentKey must start with rct_');
  }
  const given = timeoutSeconds === undefined || timeoutSeconds === null || String(timeoutSeconds).trim() === ''
    ? DEFAULT_TIMEOUT_SECONDS
    : timeoutSeconds;
  if (normalizeTimeoutSeconds(given) !== Number(given)) {
    throw new Error(`timeoutSeconds must be greater than 0 and at most ${MAX_TIMEOUT_SECONDS}`);
  }

  const configPath = getConfigPath();
  const config = { ...readConfigFile(), gatewayUrl: url, agentKey: key, timeoutSeconds: Number(given) };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // The file holds an agent key, so keep it private to the user (mode is ignored on Windows).
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // mode only applies at creation, so tighten a file that already existed. Best effort: Windows throws.
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (_) {
    // No POSIX permissions on this platform.
  }
  return configPath;
}

if (require.main === module && process.argv.includes('--write')) {
  try {
    const written = writeConfig({
      gatewayUrl: process.env.ROCOTAL_SETUP_GATEWAY_URL,
      agentKey: process.env.ROCOTAL_SETUP_AGENT_KEY,
      timeoutSeconds: process.env.ROCOTAL_SETUP_TIMEOUT_SECONDS,
    });
    process.stdout.write(`Wrote ${written}\n`);
  } catch (error) {
    process.stderr.write(`roco-prompt-scan: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  getConfigPath,
  resolveConfig,
  normalizeTimeoutSeconds,
  writeConfig,
};
