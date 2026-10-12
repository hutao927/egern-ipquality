/**
 * Validates IPQuality.module.yaml against the Egern module spec:
 *  - the file parses as YAML
 *  - every {{{PLACEHOLDER}}} is declared in compat_arguments or env_schema
 *  - every declared argument is actually referenced
 *  - script names referenced by widgets exist
 *
 * Usage: node tests/validate-module.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  // Fall back to whatever the host has available.
  yaml = require('D:/Program Files (x86)/DSH Next/resources/app/node_modules/js-yaml');
}

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, '..', 'IPQuality.module.yaml');
const text = readFileSync(modulePath, 'utf8');

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\nModule YAML validation');

let doc;
try {
  doc = yaml.load(text);
  check('parses as YAML', true);
} catch (error) {
  check('parses as YAML', false, error.message);
  process.exit(1);
}

// ---- metadata -------------------------------------------------------
check('has a module name', typeof doc.name === 'string' && doc.name.length > 0);
check('declares compat_arguments', !!doc.compat_arguments && typeof doc.compat_arguments === 'object');

// ---- placeholders ---------------------------------------------------
const declaredArgs = new Set(Object.keys(doc.compat_arguments || {}));
const declaredEnv = new Set(Object.keys(doc.env_schema || {}));
const used = new Set([...text.matchAll(/\{\{\{([A-Z_]+)\}\}\}/g)].map((m) => m[1]));

const undeclared = [...used].filter((k) => !declaredArgs.has(k) && !declaredEnv.has(k));
check('every placeholder is declared', undeclared.length === 0, undeclared.join(', '));

const unused = [...declaredArgs].filter((k) => !used.has(k));
check('every compat argument is referenced', unused.length === 0, unused.join(', '));

// ---- scripts --------------------------------------------------------
const scriptings = doc.scriptings || [];
check('declares at least one script', scriptings.length > 0);

const scriptNames = new Map();
for (const entry of scriptings) {
  const kind = Object.keys(entry)[0];
  const body = entry[kind];
  check(`script "${body.name}" has a script_url`, typeof body.script_url === 'string');
  check(`script "${body.name}" has a valid type`, ['generic', 'schedule', 'http_request', 'http_response', 'network'].includes(kind), kind);
  if (kind === 'schedule') {
    check(`schedule "${body.name}" has a cron`, typeof body.cron === 'string' && body.cron.split(/\s+/).length >= 5);
  }
  check(`script "${body.name}" timeout is 1-600s`, body.timeout === undefined || (body.timeout >= 1 && body.timeout <= 600), String(body.timeout));
  scriptNames.set(body.name, kind);
}

// ---- widgets --------------------------------------------------------
for (const widget of doc.widgets || []) {
  check(`widget "${widget.name}" is named`, typeof widget.name === 'string' && widget.name.length > 0);
  const target = widget.script_name || widget.name;
  check(`widget "${widget.name}" references a generic script`, scriptNames.get(target) === 'generic', `-> ${target} (${scriptNames.get(target) || 'missing'})`);
}

// ---- env_schema -----------------------------------------------------
for (const [key, schema] of Object.entries(doc.env_schema || {})) {
  check(`env_schema.${key} has a name`, typeof schema.name === 'string' && schema.name.length > 0);
  if (schema.options) {
    check(`env_schema.${key} default is among options`, !schema.default_value || schema.options.includes(schema.default_value), `${schema.default_value} not in [${schema.options}]`);
  }
}

// ---- script urls point at real files --------------------------------
for (const entry of scriptings) {
  const body = entry[Object.keys(entry)[0]];
  const file = body.script_url.split('/').pop();
  let exists = true;
  try {
    readFileSync(join(here, '..', 'scripts', file), 'utf8');
  } catch {
    exists = false;
  }
  check(`script file referenced by "${body.name}" exists`, exists, file);
}

// ---- hosting URL must be real and consistent ------------------------
// A placeholder here means every script 404s on the user's device, and
// Egern reports that as an opaque script error.
const base = (doc.compat_arguments || {}).SCRIPT_BASE || '';
check('SCRIPT_BASE is set', base.length > 0);
check(
  'SCRIPT_BASE is not a placeholder',
  !/YOUR_GITHUB_USERNAME|YOUR_|example\.com/i.test(base),
  base,
);
check(
  'SCRIPT_BASE is an https URL or an absolute local path',
  /^https:\/\//.test(base) || base.startsWith('/'),
  base,
);

// raw.githubusercontent.com/<user>/<repo>/<branch> — verify the path
// depth so the generated script URLs cannot end up malformed.
if (/^https:\/\//.test(base)) {
  const parts = base.replace(/^https:\/\//, '').split('/').filter(Boolean);
  check(
    'SCRIPT_BASE points at a repo branch',
    parts.length >= 4,
    `expected host/user/repo/branch, got: ${parts.join('/')}`,
  );
  check(
    'SCRIPT_BASE has no trailing slash',
    !base.endsWith('/'),
    base,
  );
}

// Every script_url must resolve under SCRIPT_BASE once the
// {{{SCRIPT_BASE}}} placeholder is substituted — this is what Egern
// does at install time.
for (const entry of scriptings) {
  const body = entry[Object.keys(entry)[0]];
  const resolved = body.script_url.replace('{{{SCRIPT_BASE}}}', base);
  check(
    `"${body.name}" resolves under SCRIPT_BASE`,
    resolved.startsWith(`${base}/scripts/`),
    resolved,
  );
}

// ---- every env the entry scripts read must be declared --------------
// A typo here is invisible at runtime: the script just silently uses a
// default. Catch it statically instead.
//
// Only the ENTRY section counts — the inlined core reads a handful of
// shared vars (API keys) through the same helper, and those are
// legitimately absent from scripts that never need them.
const ENV_RE = /env(?:Flag|Int)?\(\s*ctx\s*,\s*'([A-Z0-9_]+)'/g;
const CORE_BEGIN = '/* ==== CORE:BEGIN ==== */';
const CORE_END = '/* ==== CORE:END ==== */';

/** Strip the generated core block, leaving only authored entry code. */
function entryOnly(source) {
  const begin = source.indexOf(CORE_BEGIN);
  const end = source.indexOf(CORE_END);
  if (begin === -1 || end === -1) return source;
  return source.slice(0, begin) + source.slice(end + CORE_END.length);
}

const envRead = new Set();
for (const entry of scriptings) {
  const body = entry[Object.keys(entry)[0]];
  const file = body.script_url.split('/').pop();
  let source = '';
  try {
    source = entryOnly(readFileSync(join(here, '..', 'scripts', file), 'utf8'));
  } catch {
    continue;
  }
  for (const m of source.matchAll(ENV_RE)) envRead.add(m[1]);
}

const notDeclared = [...envRead].filter((k) => !declaredEnv.has(k));
check(
  'every env var read by an entry script is declared in env_schema',
  notDeclared.length === 0,
  notDeclared.join(', '),
);

// Env a script reads but the module entry does not forward — the script
// would silently fall back to its default.
for (const entry of scriptings) {
  const kind = Object.keys(entry)[0];
  const body = entry[kind];
  const file = body.script_url.split('/').pop();
  let source = '';
  try {
    source = entryOnly(readFileSync(join(here, '..', 'scripts', file), 'utf8'));
  } catch {
    continue;
  }
  const needs = new Set([...source.matchAll(ENV_RE)].map((m) => m[1]));
  const forwarded = new Set(Object.keys(body.env || {}));
  const missing = [...needs].filter((k) => !forwarded.has(k));
  check(`"${body.name}" forwards every env it reads`, missing.length === 0, missing.join(', '));
}

console.log(failures === 0 ? '\nAll module checks passed\n' : `\n${failures} module check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
