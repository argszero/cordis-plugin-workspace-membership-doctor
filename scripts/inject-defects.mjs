/**
 * The mutation harness.
 *
 * A green test suite proves nothing on its own: it may be green because it
 * never asserts anything. So each arm here breaks one decision the plugin
 * makes, rebuilds, and requires the suite to *fail*. The final arm is a
 * deliberate no-op, required to survive — which is what shows the other arms
 * fail for the reason claimed rather than because the suite is red anyway.
 *
 * Two traps this harness exists to avoid, both measured on a sibling plugin:
 * `tsc --noEmit` leaves a stale `lib/`, so an arm whose source was reverted
 * still runs the mutated build and goes silently green; and a `git checkout` of
 * the source is not enough either, because the *build output* is the thing the
 * tests import. Every arm therefore rebuilds after restoring, and the run ends
 * by re-running the untouched suite and requiring it green.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const NODE = process.execPath

/** `CAUGHT` = the suite must fail; `SURVIVED` = the mutation is equivalent and must not. */
const EXPECT = { CAUGHT: 'CAUGHT', SURVIVED: 'SURVIVED' }

const ARMS = [
  {
    name: 'census: candidate order reversed',
    file: 'src/census.ts',
    from: 'return right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId)',
    to: 'return left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId)',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'census: a listed member is also a candidate',
    file: 'src/census.ts',
    from: '    if (workspace.sessionIds.includes(header.id)) continue',
    to: '    if (false) continue',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'census: verdict never says repairable',
    file: 'src/census.ts',
    from: "    verdict: candidates.length > 0 ? 'repairable' : 'ok',",
    to: "    verdict: 'ok',",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'census: an orphan is counted as a match instead',
    file: 'src/census.ts',
    from: "      orphans.push({ sessionId: header.id, cwd: header.cwd ?? '', resolved, createdAt: header.createdAt })\n      continue",
    to: '      matched += 1\n      continue',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'census: matched header no longer counted',
    file: 'src/census.ts',
    from: '    matched += 1',
    to: '    matched += 0',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'repair: a refusal is reported as an attach',
    file: 'src/repair.ts',
    from: "      outcomes.push({ step, status: 'refused', error: messageOf(error) })",
    to: "      outcomes.push({ step, status: 'attached' })",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'repair: looks the workspace up by session id',
    file: 'src/repair.ts',
    from: '    const workspace = registry.get(step.workspaceId)',
    to: '    const workspace = registry.get(step.sessionId)',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'repair: a vanished workspace is reported as an attach',
    file: 'src/repair.ts',
    from: "      outcomes.push({ step, status: 'no-workspace' })\n      continue",
    to: "      outcomes.push({ step, status: 'attached' })\n      continue",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'report: truncation is no longer disclosed',
    file: 'src/report.ts',
    from: '  return rest > 0 ? [...shown, `(+${rest} more not shown)`] : shown',
    to: '  return shown',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'report: "no cwd" is explained as nothing at all',
    file: 'src/report.ts',
    from: "    case 'no-cwd': return 'the header records no cwd at all'",
    to: "    case 'no-cwd': return ''",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'report: coverage prints a hard-coded ungrouped count',
    file: 'src/report.ts',
    from: '    `  matched none (ungrouped)  ${coverage.orphans}`,',
    to: '    `  matched none (ungrouped)  0`,',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'report: "unavailable" is rendered as a clean census',
    file: 'src/report.ts',
    from: "'Workspace membership — the census could not be taken.'",
    to: "'Workspace membership — nothing is wrong.'",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: a relative cwd is not distinguished from an unresolvable one',
    file: 'src/index.ts',
    from: "      const reason = error instanceof TypeError ? 'not-fully-qualified' : 'does-not-resolve'",
    to: "      const reason = 'does-not-resolve'",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: the registry projection is aliased instead of snapshotted',
    file: 'src/index.ts',
    from: '      sessionIds: [...workspace.sessionIds],',
    to: '      sessionIds: workspace.sessionIds,',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: the post-repair census reuses the stale port',
    file: 'src/index.ts',
    from: '          const refreshed = await readPort({ registry, persistence })',
    to: '          const refreshed: DoctorPort & { readonly ok: true } = port',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: a repair request writes without confirmation',
    file: 'src/index.ts',
    from: '        if (args.confirm !== true) {',
    to: '        if (false) {',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: the print limit is not clamped',
    file: 'src/index.ts',
    from: '      const limit = args.limit === undefined ? undefined : Math.max(1, Math.min(args.limit, 500))',
    to: '      const limit = args.limit',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: the startup census no longer warns',
    file: 'src/index.ts',
    from: '        ctx.logger.warn(`workspace-membership-doctor: ${value.candidates.length} stored session(s) belong',
    to: '        ctx.logger.debug(`workspace-membership-doctor: ${value.candidates.length} stored session(s) belong',
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'index: an uncountable census is returned as a normal report',
    file: 'src/index.ts',
    from: "        return { ...empty, mode: 'unavailable', verdict: 'unavailable', report: renderUnavailable(port.error) }",
    to: "        return { ...empty, mode: 'report', verdict: 'unavailable', report: renderUnavailable(port.error) }",
    expect: EXPECT.CAUGHT,
  },
  {
    name: 'no-op: equivalent way to floor the print limit',
    file: 'src/report.ts',
    from: '  const shown = ids.slice(0, Math.max(0, limit))',
    to: '  const shown = ids.slice(0, limit < 0 ? 0 : limit)',
    expect: EXPECT.SURVIVED,
  },
]

function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: 'pipe' })
    return { ok: true, output: '' }
  }
  catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return { ok: false, output: typeof output === 'string' ? output : '' }
  }
}

function build() {
  return run(NODE, [join(ROOT, 'node_modules/.bin/tsc')])
}

function specs() {
  return readdirSync(join(ROOT, 'test'))
    .filter(entry => entry.endsWith('.spec.mjs'))
    .map(entry => `test/${entry}`)
}

function test() {
  return run(NODE, ['--test', ...specs()])
}

const results = []
let typefail = 0

for (const arm of ARMS) {
  const path = join(ROOT, arm.file)
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(arm.from).length - 1
  if (occurrences !== 1) {
    results.push({ arm, actual: `ANCHOR(${occurrences})` })
    continue
  }

  writeFileSync(path, original.replace(arm.from, arm.to))
  let actual
  try {
    const compiled = build()
    if (!compiled.ok) {
      typefail += 1
      actual = 'TYPEFAIL'
    }
    else {
      actual = test().ok ? 'SURVIVED' : 'CAUGHT'
    }
  }
  finally {
    writeFileSync(path, original)
    build()
  }
  results.push({ arm, actual })
}

// The build left behind by the last arm must be the untouched one.
const finalSuite = test()

let failed = 0
for (const { arm, actual } of results) {
  const mark = actual === arm.expect ? 'ok  ' : 'MISS'
  if (actual !== arm.expect) failed += 1
  console.log(`${mark} ${arm.expect.padEnd(8)} got ${String(actual).padEnd(8)} ${arm.name}`)
}
console.log(`\n${results.length} arms: ${results.filter(entry => entry.actual === 'CAUGHT').length} CAUGHT,`
  + ` ${results.filter(entry => entry.actual === 'SURVIVED').length} SURVIVED, ${typefail} TYPEFAIL, ${failed} unexpected`)
console.log(`restored suite: ${finalSuite.ok ? 'GREEN' : 'RED — the harness did not restore the tree'}`)

if (failed > 0 || !finalSuite.ok) process.exit(1)
