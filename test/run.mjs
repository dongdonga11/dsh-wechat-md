/**
 * Cross-platform test entry point.
 *
 * Why this exists instead of a plain `node --test ...` in package.json: running
 * every test file in one process needs `--test-isolation=none`, and that option
 * is not portable in either spelling.
 *
 *   Node 20          neither `--test-isolation` nor the experimental spelling
 *   Node 22.8–22.x   only `--experimental-test-isolation=none`
 *   Node 23+/24      `--test-isolation=none` (the experimental name also works)
 *
 * Locally we want the single-process form because a confined sandbox forbids
 * the stdio pipes the default per-file child processes need. CI has no such
 * restriction, so when no spelling is available the runner simply omits the
 * flag — isolation is a sandbox workaround here, never a test requirement.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const roots = [join(dirname(fileURLToPath(import.meta.url)), '..'), process.cwd()]
const root = roots.find((candidate) => {
  try {
    return readdirSync(join(candidate, 'test')).some((name) => name.endsWith('.test.mjs'))
  } catch {
    return false
  }
})
if (root === undefined) {
  console.error('[test] could not locate the test/ directory')
  process.exit(1)
}

const files = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join('test', name))

/** Prefer the stable spelling when the runtime advertises it, else the older one. */
const isolationFlag = () => {
  const allowed = process.allowedNodeEnvironmentFlags
  if (allowed.has('--test-isolation')) return ['--test-isolation=none']
  if (allowed.has('--experimental-test-isolation')) return ['--experimental-test-isolation=none']
  return []
}

/** Treat "this runtime rejected the flag" as a retry signal, not a test failure. */
const rejectedTheFlag = (run) =>
  run.status === 9 ||
  /bad option|not allowed in NODE_OPTIONS|is not allowed|unknown option/iu.test(`${run.stderr ?? ''}`)

const attempts = [isolationFlag(), []]

let result = null
for (const flags of attempts) {
  const args = ['--test', ...flags, '--test-timeout=30000', ...files]
  const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  result = run
  if (!rejectedTheFlag(run)) break
}

process.exit(result === null ? 1 : result.status ?? 1)
