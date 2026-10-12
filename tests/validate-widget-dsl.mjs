/**
 * Validates every widget DSL tree the scripts can emit against the
 * element/property vocabulary documented at
 * https://egernapp.com/docs/configuration/widgets
 *
 * Catches typos in `type` values and properties that Egern would
 * silently ignore.
 *
 * Usage: node tests/validate-widget-dsl.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------
// Schema derived from the Egern widget documentation
// ---------------------------------------------------------------------

const ELEMENT_TYPES = new Set(['widget', 'stack', 'text', 'image', 'spacer', 'date']);

const COMMON_PROPS = new Set([
  'type', 'url', 'opacity', 'width', 'height', 'flex', 'padding', 'gap',
  'backgroundColor', 'backgroundGradient', 'backgroundImage', 'borderRadius',
  'borderWidth', 'borderColor', 'shadowColor', 'shadowRadius', 'shadowOffset',
  'children',
]);

const PROPS_BY_TYPE = {
  widget: new Set([...COMMON_PROPS, 'refreshAfter']),
  stack: new Set([...COMMON_PROPS, 'direction', 'alignItems']),
  text: new Set([...COMMON_PROPS, 'text', 'font', 'textColor', 'textAlign', 'maxLines', 'minScale']),
  image: new Set([...COMMON_PROPS, 'src', 'color', 'resizeMode', 'resizable']),
  spacer: new Set([...COMMON_PROPS, 'length']),
  date: new Set([...COMMON_PROPS, 'date', 'format', 'font', 'textColor', 'textAlign', 'maxLines', 'minScale']),
};

const FONT_SIZES = new Set([
  'largeTitle', 'title', 'title2', 'title3', 'headline', 'body',
  'callout', 'subheadline', 'footnote', 'caption1', 'caption2',
]);

const FONT_WEIGHTS = new Set([
  'ultraLight', 'thin', 'light', 'regular', 'medium',
  'semibold', 'bold', 'heavy', 'black',
]);

const ALIGN_ITEMS = new Set(['start', 'end', 'center']);
const DIRECTIONS = new Set(['row', 'column']);
const RESIZE_MODES = new Set(['contain', 'cover']);
const WIDGET_FAMILIES = new Set([
  'systemSmall', 'systemMedium', 'systemLarge', 'systemExtraLarge',
  'accessoryCircular', 'accessoryRectangular', 'accessoryInline',
]);

/**
 * Egern's widget renderer accepts ONLY 6-digit hex or rgb()/rgba().
 *
 * An 8-digit hex such as #FFFFFFAA is NOT valid: the native renderer
 * parses the color itself and throws
 *   SyntaxError: Invalid character: '#'   (appendChild@[native code])
 * with no line number pointing at the offending element. That failure
 * mode is expensive to debug, hence this strict pattern.
 *
 * Note the alpha must be expressed via rgba(), not via hex digits.
 */
const COLOR_RE = /^(#[0-9a-fA-F]{6}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\))$/;

/** Catches the specific 8-digit mistake with a helpful message. */
const HEX_ALPHA_RE = /^#[0-9a-fA-F]{8}$/;

function checkColor(value, path, errors) {
  if (typeof value === 'string') {
    if (HEX_ALPHA_RE.test(value)) {
      errors.push(
        `${path}: "${value}" is 8-digit hex — Egern only accepts 6-digit hex ` +
          `(use rgba() if you need transparency)`,
      );
    } else if (!COLOR_RE.test(value)) {
      errors.push(`${path}: invalid color "${value}"`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of ['light', 'dark']) {
      if (value[key] !== undefined) checkColor(value[key], `${path}.${key}`, errors);
    }
    const known = new Set(['light', 'dark']);
    for (const key of Object.keys(value)) {
      if (!known.has(key)) errors.push(`${path}: unexpected adaptive-color key "${key}"`);
    }
    return;
  }
  errors.push(`${path}: color must be a string or {light,dark} object`);
}

function checkFont(font, path, errors) {
  if (!font || typeof font !== 'object') {
    errors.push(`${path}: font must be an object`);
    return;
  }
  const known = new Set(['size', 'weight', 'family']);
  for (const key of Object.keys(font)) {
    if (!known.has(key)) errors.push(`${path}.${key}: unknown font property`);
  }
  if (font.size !== undefined) {
    const ok = FONT_SIZES.has(font.size) || (typeof font.size === 'number' && font.size > 0);
    if (!ok) errors.push(`${path}.size: invalid size "${font.size}"`);
  }
  if (font.weight !== undefined && !FONT_WEIGHTS.has(font.weight)) {
    errors.push(`${path}.weight: invalid weight "${font.weight}"`);
  }
  if (font.family !== undefined && font.size === undefined) {
    errors.push(`${path}: "family" requires an explicit "size"`);
  }
}

/** Walk a widget tree, collecting schema violations. */
function validate(node, path, errors, family) {
  if (!node || typeof node !== 'object') {
    errors.push(`${path}: node must be an object`);
    return;
  }
  const type = node.type;
  if (!ELEMENT_TYPES.has(type)) {
    errors.push(`${path}.type: unknown element type "${type}"`);
    return;
  }

  const allowed = PROPS_BY_TYPE[type];
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: not valid on <${type}>`);
  }

  if (path === 'root' && type !== 'widget') {
    errors.push(`${path}: root element must be type "widget", got "${type}"`);
  }

  if (node.backgroundGradient) {
    const g = node.backgroundGradient;
    if (!Array.isArray(g.colors) || g.colors.length === 0) {
      errors.push(`${path}.backgroundGradient.colors: required non-empty array`);
    } else {
      g.colors.forEach((c, i) => checkColor(c, `${path}.backgroundGradient.colors[${i}]`, errors));
    }
    if (g.stops && g.stops.length !== g.colors.length) {
      errors.push(`${path}.backgroundGradient: stops length must match colors length`);
    }
    if (g.type && !['linear', 'radial', 'angular'].includes(g.type)) {
      errors.push(`${path}.backgroundGradient.type: invalid "${g.type}"`);
    }
  }

  for (const key of ['backgroundColor', 'borderColor', 'shadowColor', 'textColor', 'color']) {
    if (node[key] !== undefined) checkColor(node[key], `${path}.${key}`, errors);
  }

  if (node.font !== undefined) checkFont(node.font, `${path}.font`, errors);

  if (node.direction !== undefined && !DIRECTIONS.has(node.direction)) {
    errors.push(`${path}.direction: invalid "${node.direction}"`);
  }
  if (node.alignItems !== undefined && !ALIGN_ITEMS.has(node.alignItems)) {
    errors.push(`${path}.alignItems: invalid "${node.alignItems}"`);
  }
  if (node.resizeMode !== undefined && !RESIZE_MODES.has(node.resizeMode)) {
    errors.push(`${path}.resizeMode: invalid "${node.resizeMode}"`);
  }
  if (node.textAlign !== undefined && !['left', 'center', 'right'].includes(node.textAlign)) {
    errors.push(`${path}.textAlign: invalid "${node.textAlign}"`);
  }

  if (node.opacity !== undefined && (typeof node.opacity !== 'number' || node.opacity < 0 || node.opacity > 1)) {
    errors.push(`${path}.opacity: must be 0.0-1.0`);
  }
  if (node.minScale !== undefined && (typeof node.minScale !== 'number' || node.minScale < 0 || node.minScale > 1)) {
    errors.push(`${path}.minScale: must be 0.0-1.0`);
  }
  if (node.maxLines !== undefined && (!Number.isInteger(node.maxLines) || node.maxLines < 1)) {
    errors.push(`${path}.maxLines: must be a positive integer`);
  }

  if (type === 'text' && typeof node.text !== 'string') {
    errors.push(`${path}.text: text elements require a string "text"`);
  }
  if (type === 'image') {
    if (typeof node.src !== 'string' || node.src.length === 0) {
      errors.push(`${path}.src: image elements require a "src"`);
    } else if (!/^(sf-symbol:|data:image\/)/.test(node.src)) {
      errors.push(`${path}.src: unsupported URI scheme in "${node.src.slice(0, 40)}"`);
    }
  }
  if (type === 'date' && typeof node.date !== 'string') {
    errors.push(`${path}.date: date elements require an ISO date string`);
  }
  if (node.refreshAfter !== undefined && Number.isNaN(Date.parse(node.refreshAfter))) {
    errors.push(`${path}.refreshAfter: must be an ISO 8601 string`);
  }

  // Containers must have children; leaves must not.
  const isContainer = type === 'widget' || type === 'stack';
  if (isContainer) {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      errors.push(`${path}: <${type}> requires a non-empty children array`);
      return;
    }
  } else if (node.children !== undefined) {
    errors.push(`${path}: <${type}> cannot have children`);
  }

  // Lock Screen families render in a very tight space; guard against
  // accidentally shipping a Home Screen tree there.
  if (family && family.startsWith('accessory') && type === 'widget') {
    if (node.children.length > 3) {
      errors.push(`${path}: accessory widget has ${node.children.length} root children (max 3 looks right)`);
    }
  }

  (node.children || []).forEach((child, index) => {
    validate(child, `${path}.children[${index}]`, errors, family);
  });
}

// ---------------------------------------------------------------------
// Harness — shared with run-tests.mjs
// ---------------------------------------------------------------------

import { makeCtx, load as loadScript } from './harness.mjs';

const load = (name) => loadScript(name);

// ---------------------------------------------------------------------

const runReport = await load('ipquality.js');
const runWidget = await load('ipquality-widget.js');

let failures = 0;
async function treeFor(label, producer, family) {
  let tree;
  try {
    tree = await producer();
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}: threw ${error.message}`);
    return;
  }
  if (!tree || tree.type !== 'widget') {
    failures += 1;
    console.log(`  FAIL  ${label}: expected a widget tree, got ${tree && tree.type}`);
    return;
  }
  const errors = [];
  validate(tree, 'root', errors, family);
  // Must survive the JSON hop into the native renderer.
  try {
    JSON.parse(JSON.stringify(tree));
  } catch (error) {
    errors.push(`not JSON-serialisable: ${error.message}`);
  }
  if (errors.length === 0) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    for (const e of errors) console.log(`        ${e}`);
  }
}

console.log('\nWidget DSL validation');

// ---- static scan: 8-digit hex anywhere in a widget-painting script ----
// The runtime tests only exercise the branches they trigger, so scan the
// source too: an 8-digit color in an untested code path would still
// crash the renderer on a real device.
const srcDir = join(here, '..', 'src');
const scriptDir = join(here, '..', 'scripts');

for (const [dir, label] of [[srcDir, 'src'], [scriptDir, 'scripts']]) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    const bad = [...source.matchAll(/['"]#[0-9a-fA-F]{8}['"]/g)].map((m) => m[0].slice(1, -1));
    if (bad.length > 0) {
      failures += 1;
      console.log(
        `  FAIL  ${label}/${file}: ${bad.length} eight-digit hex color(s): ${[...new Set(bad)].join(', ')}`,
      );
    } else {
      console.log(`  PASS  ${label}/${file} has no eight-digit hex colors`);
    }
  }
}

const families = [
  'systemSmall', 'systemMedium', 'systemLarge', 'systemExtraLarge',
  'accessoryCircular', 'accessoryRectangular', 'accessoryInline',
];

// ipquality.js in widget mode (cold cache, full probe).
for (const family of families) {
  await treeFor(
    `ipquality.js widget tree — ${family}`,
    () => runReport(makeCtx({ widgetFamily: family })),
    family,
  );
}

// ipquality.js error card.
for (const family of ['systemMedium', 'accessoryCircular']) {
  await treeFor(
    `ipquality.js error card — ${family}`,
    () => runReport(makeCtx({ widgetFamily: family, failAll: true })),
    family,
  );
}

// A warm cache must render for every family too, and — importantly —
// without touching the network.
const warmSeed = (() => {
  const ctx = makeCtx({});
  return ctx;
})();
await runReport(warmSeed);
const seed = Object.fromEntries(warmSeed.__store);
const seeded = () => makeCtx({ widgetFamily: 'systemMedium', storageSeed: seed });

for (const family of families) {
  await treeFor(
    `ipquality-widget.js warm cache — ${family}`,
    () => runWidget(makeCtx({ widgetFamily: family, storageSeed: seed })),
    family,
  );
}

// No cache and no network => the empty state must still be valid DSL.
for (const family of families) {
  await treeFor(
    `ipquality-widget.js empty state — ${family}`,
    () => runWidget(makeCtx({ widgetFamily: family, failAll: true })),
    family,
  );
}

// Stale cache that cannot refresh => labelled cache card.
for (const family of ['systemMedium', 'accessoryRectangular']) {
  await treeFor(
    `ipquality-widget.js stale cache — ${family}`,
    () => {
      const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const cached = JSON.parse(seed['ipquality:last']);
      cached.at = old;
      return runWidget(
        makeCtx({
          widgetFamily: family,
          failAll: true,
          storageSeed: { 'ipquality:last': JSON.stringify(cached) },
        }),
      );
    },
    family,
  );
}

// Cold cache (network available) — the widget's own quick probe.
for (const family of families) {
  await treeFor(
    `ipquality-widget.js cold probe — ${family}`,
    () => runWidget(makeCtx({ widgetFamily: family })),
    family,
  );
}

console.log(failures === 0 ? '\nAll widget DSL checks passed\n' : `\n${failures} widget DSL check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
