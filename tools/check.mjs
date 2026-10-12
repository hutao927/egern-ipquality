/**
 * Runs every check in order: bundler consistency, behaviour tests,
 * module validation, widget DSL validation.
 *
 * Usage: node tools/check.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failed = 0;

function run(label, args) {
  console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

/**
 * The generated core inside each script must match src/core.js. If
 * someone edits a bundled script in place, that edit silently
 * disappears the next time the bundler runs — catch it here.
 *
 * The bundler is spawned with inherited stdio: capturing a child's
 * output through a pipe is blocked under some sandboxes, and this
 * check must not depend on being able to pipe.
 */
function checkBundledIsCurrent() {
  console.log(`\n${'='.repeat(60)}\nBundled scripts match src/core.js\n${'='.repeat(60)}`);
  const before = new Map();
  for (const file of readdirSync(join(root, 'scripts'))) {
    before.set(file, readFileSync(join(root, 'scripts', file), 'utf8'));
  }

  const result = spawnSync(process.execPath, [join(root, 'tools', 'bundle.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed += 1;
    console.log(`  FAIL  bundler exited with ${result.status}`);
    return;
  }

  let stale = 0;
  for (const file of readdirSync(join(root, 'scripts'))) {
    const after = readFileSync(join(root, 'scripts', file), 'utf8');
    if (before.get(file) !== after) {
      stale += 1;
      console.log(`  STALE  scripts/${file} — regenerated from src/`);
    }
  }
  if (stale === 0) {
    console.log('  PASS  all bundled scripts are up to date');
  } else {
    console.log(`  FAIL  ${stale} script(s) were stale and have been regenerated; re-run tests`);
    failed += 1;
  }
}

checkBundledIsCurrent();
run('Behaviour tests', [join(root, 'tests', 'run-tests.mjs')]);
run('Module validation', [join(root, 'tests', 'validate-module.mjs')]);
run('Widget DSL validation', [join(root, 'tests', 'validate-widget-dsl.mjs')]);

if (failed === 0) {
  console.log('\n✅ All checks passed\n');
  process.exit(0);
} else {
  console.log(`\n❌ ${failed} check group(s) failed\n`);
  process.exit(1);
}
