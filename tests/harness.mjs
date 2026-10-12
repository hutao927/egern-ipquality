/**
 * Shared test harness: a mock Egern `ctx` plus a script loader.
 *
 * Implements the subset of the Egern API the scripts use, backed by
 * tests/fixtures.json, so behaviour can be verified without a device.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');

export const FIXTURES = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8'));

/** Keys that are grouping helpers, not real URLs. */
const META_KEYS = new Set(['egress']);

/** Build a mock Response from a fixture entry. */
export function makeResponse(entry) {
  const isObj = entry && typeof entry === 'object';
  const status = isObj ? (entry.__status ?? 200) : 200;
  const text = isObj
    ? entry.__text !== undefined
      ? entry.__text
      : JSON.stringify(entry)
    : String(entry ?? '');
  const location = isObj && entry.__location ? entry.__location : null;
  return {
    status,
    headers: {
      get(name) {
        return location && String(name).toLowerCase() === 'location' ? location : null;
      },
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/** Resolve a URL to a fixture entry, or undefined. */
export function lookup(url) {
  const keys = Object.keys(FIXTURES)
    .filter((k) => !META_KEYS.has(k))
    .filter((k) => url.startsWith(k))
    .sort((a, b) => b.length - a.length);
  return keys.length > 0 ? FIXTURES[keys[0]] : undefined;
}

/**
 * Create a mock ctx.
 *
 * @param {object} spec
 * @param {object} [spec.env]          environment variables
 * @param {string} [spec.widgetFamily] makes isWidget() true
 * @param {object} [spec.storageSeed]  initial storage contents
 * @param {boolean}[spec.failAll]      every HTTP call throws
 * @param {boolean}[spec.failServices] service hosts throw, providers work
 * @param {object} [spec.overrides]    per-URL fixture overrides
 */
export function makeCtx(spec = {}) {
  const {
    env: envVars = {},
    widgetFamily,
    storageSeed = {},
    failAll = false,
    failServices = false,
    overrides = {},
  } = spec;

  const store = new Map(Object.entries(storageSeed));
  const calls = [];
  const notifications = [];

  const SERVICE_HOSTS = /netflix\.com|youtube\.com|disney|primevideo|tiktok|reddit|chatgpt|play\.google/;

  const ctx = {
    script: { name: 'ipquality' },
    env: envVars,
    app: { version: '1.0', language: 'zh-Hans' },
    device: {
      cellular: { carrier: 'Test', radio: '5G' },
      wifi: { ssid: 'TestWiFi', bssid: '00:11:22:33:44:55' },
      ipv4: { address: '192.168.1.5', gateway: '192.168.1.1', interface: 'en0' },
      ipv6: { address: null, interface: null },
      dnsServers: ['1.1.1.1'],
    },
    widgetFamily,
    http: {
      async get(url, options = {}) {
        calls.push({ url, options });
        if (failAll) throw new Error('network down');
        if (failServices && SERVICE_HOSTS.test(url)) throw new Error('service unreachable');

        for (const [pattern, entry] of Object.entries(overrides)) {
          if (url.startsWith(pattern)) return makeResponse(entry);
        }
        const entry = lookup(url);
        if (entry === undefined) throw new Error(`no fixture for ${url}`);
        return makeResponse(entry);
      },
    },
    storage: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, String(v)),
      getJSON: (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      setJSON: (k, v) => store.set(k, JSON.stringify(v)),
      delete: (k) => store.delete(k),
    },
    notify: (opts) => notifications.push(opts),
    lookupIP: () => ({ country: 'JP', asn: 64500, organization: 'EXAMPLE' }),

    // Test-only inspection hooks.
    __calls: calls,
    __notifications: notifications,
    __store: store,
  };
  return ctx;
}

/** Load a bundled script from scripts/ as an ES module. */
export async function load(name) {
  const src = readFileSync(join(root, 'scripts', name), 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  return mod.default;
}

/** Minimal test runner shared by every suite. */
export function createRunner() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  return {
    async test(name, fn) {
      try {
        await fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
      } catch (error) {
        failed += 1;
        failures.push({ name, message: error.message });
        console.log(`  FAIL  ${name}`);
        console.log(`        ${error.message}`);
      }
    },
    section(title) {
      console.log(`\n${title}`);
    },
    finish() {
      console.log(`\n${passed} passed, ${failed} failed\n`);
      if (failures.length > 0) {
        console.log('Failures:');
        for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
        console.log('');
      }
      process.exit(failed === 0 ? 0 : 1);
    },
    get counts() {
      return { passed, failed };
    },
  };
}
