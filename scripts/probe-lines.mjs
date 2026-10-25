/**
 * The peer-range probe.
 *
 * A prerelease peer range is a claim about which harness builds this plugin
 * works on, and the tempting way to write it — `>=0.1.7-alpha.1 <0.2.0` —
 * quietly claims every prerelease line in between, including ones the suite was
 * never run against. This probe holds the declaration to the two things that
 * can be checked:
 *
 *   1. the range admits exactly the lines the suite was RUN against, and
 *      refuses the lines it was not;
 *   2. the tree sitting in `node_modules` right now — the one `npm test` just
 *      measured — is admitted by the declared range, so the evidence and the
 *      claim are about the same version.
 *
 * The `RUN_LINES` table is the honest half: adding a version here without
 * actually running the suite on it is the failure this file exists to make
 * visible.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'

const ROOT = new URL('..', import.meta.url).pathname
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const peers = manifest.peerDependencies

/**
 * The lines this suite was actually executed against, with the commands that
 * ran. Keep this list and the declared range in step: a line in the range that
 * is not here is an untested claim, and a line here that is not in the range
 * would leave a working version unable to install.
 */
const RUN_LINES = [
  {
    line: '0.1.7-alpha',
    version: '0.1.7-alpha.2',
    how: 'rm -rf node_modules package-lock.json && npm i --no-save @deepseek-ai/dsh-session@0.1.7-alpha.2'
      + ' @deepseek-ai/dsh-session-persistence@0.1.7-alpha.2 @deepseek-ai/dsh-tools@0.1.7-alpha.2'
      + ' @deepseek-ai/dsh-workspace@0.1.7-alpha.2 && npm test',
  },
  {
    line: '0.2.0-rc',
    version: '0.2.0-rc.2',
    how: 'rm -rf node_modules package-lock.json && npm i && npm test',
  },
  {
    line: '0.2.1-rc',
    version: '0.2.1-rc.3',
    how: 'rm -rf node_modules package-lock.json && npm i --no-save @deepseek-ai/dsh-session@0.2.1-rc.3'
      + ' @deepseek-ai/dsh-session-persistence@0.2.1-rc.3 @deepseek-ai/dsh-tools@0.2.1-rc.3'
      + ' @deepseek-ai/dsh-workspace@0.2.1-rc.3 && npm test',
  },
]

/** Versions whose membership is the whole point of the range's shape. */
const TABLE = [
  ['0.1.7-alpha.1', true, 'the earliest build of the alpha line that exists'],
  ['0.1.7-alpha.2', true, 'the alpha line, and the build the suite ran on'],
  ['0.1.7-rc.1', false, 'a line never run: excluding it is why the range is not a single span'],
  ['0.1.7-rc.2', false, 'a line never run'],
  ['0.1.7', false, 'a release never run'],
  ['0.2.0-rc.1', true, 'the rc line'],
  ['0.2.0-rc.2', true, 'the rc line, and the build the suite ran on'],
  ['0.2.0', false, 'a release never run'],
  ['0.2.1-rc.1', true, 'the 0.2.1 rc line'],
  ['0.2.1-rc.3', true, 'the 0.2.1 rc line, and the build the suite ran on'],
  ['0.2.1', false, 'a release never run'],
  ['0.3.0', false, 'a later line'],
  ['0.1.6-alpha.9', false, 'a line older than the workspace registry API this plugin uses'],
]

const RANGED = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-workspace']

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

// 1. Every ranged peer declares the same span, and that span is the table above.
const declared = new Set(RANGED.map(name => peers[name]))
check(declared.size === 1, `the ranged peers disagree: ${[...declared].join(' | ')}`)
const range = [...declared][0]
console.log(`declared range: ${range}\n`)
for (const [version, expected, why] of TABLE) {
  const admitted = semver.satisfies(version, range)
  const mark = admitted === expected ? 'ok  ' : 'MISS'
  console.log(`${mark} ${(admitted ? 'admits ' : 'refuses')} ${version.padEnd(14)} ${why}`)
  check(admitted === expected, `${version} should be ${expected ? 'admitted' : 'refused'}`)
}

// 2. The disjunction is load-bearing: a single span would claim the rc line.
const singleSpan = '>=0.1.7-alpha.1 <0.2.0'
check(semver.satisfies('0.1.7-rc.2', singleSpan) && !semver.satisfies('0.1.7-rc.2', range),
  'the single-span form no longer over-claims, so the disjunct is no longer justified')
console.log(`\nok   >=0.1.7-alpha.1 <0.2.0 would admit 0.1.7-rc.2; the declared range does not`)

// 3. The tree the suite measured is a tree the declared range admits.
for (const [name, peer] of Object.entries(peers)) {
  const packageJson = join(ROOT, 'node_modules', name, 'package.json')
  let installed
  try {
    installed = JSON.parse(readFileSync(packageJson, 'utf8')).version
  }
  catch {
    failures.push(`${name} is not installed under node_modules — run npm install before this probe`)
    continue
  }
  const admitted = semver.satisfies(installed, peer)
  console.log(`${admitted ? 'ok  ' : 'MISS'} installed ${name}@${installed} against ${peer}`)
  check(admitted, `installed ${name}@${installed} is outside the declared range ${peer}`)
  if (RANGED.includes(name)) {
    check(RUN_LINES.some(line => semver.satisfies(installed, `>=${line.version} <${line.version}`) || installed === line.version),
      `${name}@${installed} is not one of the builds in RUN_LINES — the suite has not run on this line`)
  }
}

// 4. Every run line's build is admitted, so the evidence and the claim agree.
for (const { line, version, how } of RUN_LINES) {
  const admitted = semver.satisfies(version, range)
  console.log(`${admitted ? 'ok  ' : 'MISS'} run line ${line} (${version}) is inside the declared range`)
  check(admitted, `run line ${line} (${version}) is outside the declared range — either widen the range or run it`)
  check(how.length > 0, `run line ${line} records no command`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\nall checks passed — ${RUN_LINES.length} run line(s), ${TABLE.length} table entries`)
