/**
 * One-shot migration: replace 8-digit hex colors with 6-digit ones.
 *
 * Egern's widget renderer rejects 8-digit hex (`#RRGGBBAA`) with
 *   SyntaxError: Invalid character: '#'
 * so the alpha must be baked into an opaque color instead.
 *
 * Run with Node (NOT PowerShell): Get-Content/Set-Content round-trips
 * reinterpret UTF-8 bytes as the console codepage and destroy the
 * Chinese strings in these files.
 *
 * Usage: node tools/fix-alpha-colors.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Original alpha -> opaque equivalent.
 *
 * These were a white text hierarchy over a dark gradient. Each entry
 * keeps roughly the same perceived contrast against #1A1A2E.
 */
const MAP = {
  '#FFFFFFCC': '#D8DCE6', // 80% white — primary secondary text
  '#FFFFFFAA': '#B9BFCC', // 67% white — secondary text
  '#FFFFFF99': '#A3A9B8', // 60% white — tertiary text
  '#FFFFFF88': '#8E94A3', // 53% white — faint labels
  '#FFFFFF77': '#7C8290', // 47% white — faintest labels
  '#FFFFFF66': '#6B7280', // 40% white — captions
};

const TARGETS = ['src/ipquality.js', 'src/ipquality-widget.js'];

let totalChanged = 0;

for (const rel of TARGETS) {
  const path = join(root, rel);
  let source = readFileSync(path, 'utf8');

  const cjkBefore = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  let changed = 0;

  for (const [from, to] of Object.entries(MAP)) {
    const hits = source.split(from).length - 1;
    if (hits > 0) {
      source = source.split(from).join(to);
      changed += hits;
    }
  }

  // Refuse to write if anything looks wrong — this script exists because
  // an earlier attempt silently mangled these files.
  const cjkAfter = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkAfter !== cjkBefore) {
    throw new Error(
      `${rel}: CJK count changed ${cjkBefore} -> ${cjkAfter}; refusing to write`,
    );
  }
  const leftover = source.match(/#[0-9A-Fa-f]{8}/g) || [];
  if (leftover.length > 0) {
    throw new Error(`${rel}: ${leftover.length} eight-digit color(s) remain`);
  }
  if (source.includes('\uFFFD')) {
    throw new Error(`${rel}: contains U+FFFD replacement characters; refusing to write`);
  }

  writeFileSync(path, source, 'utf8');
  totalChanged += changed;
  console.log(`  ${rel}: replaced ${changed} color(s), CJK intact (${cjkAfter})`);
}

console.log(`\n${totalChanged} alpha color(s) replaced.\n`);
