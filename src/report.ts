/**
 * Report rendering. Every renderer states its own scope, because a diagnosis
 * that can print "0 candidates" while having read nothing is worse than no
 * diagnosis at all.
 *
 * @module @argszero/cordis-plugin-workspace-membership-doctor/src/report
 */
import type { Census, RepairStep, UnresolvedSession } from './census.js'
import type { RepairOutcome } from './repair.js'

/**
 * Most session ids printed per list. A workspace may legitimately own hundreds
 * of sessions and a machine may own many workspaces; the report says how many
 * it withheld rather than growing without bound.
 */
export const REPORT_LIMIT = 20

/** Print at most {@link REPORT_LIMIT} entries of a list, disclosing the rest. */
function bounded(ids: readonly string[], limit: number = REPORT_LIMIT): string[] {
  const shown = ids.slice(0, Math.max(0, limit))
  const rest = ids.length - shown.length
  return rest > 0 ? [...shown, `(+${rest} more not shown)`] : shown
}

/** The reason vocabulary, spelled out once so a report and a reader agree. */
function describeReason(reason: UnresolvedSession['reason']): string {
  switch (reason) {
    case 'no-cwd': return 'the header records no cwd at all'
    case 'not-fully-qualified': return 'the recorded cwd is not an absolute path'
    case 'not-a-directory': return 'the recorded cwd exists but is not a directory'
    case 'does-not-resolve': return 'the recorded cwd does not resolve on this filesystem'
  }
}

/**
 * Render the census.
 * @param value - the census.
 * @param options - `limit` bounds each printed list; `focus` names a workspace that was filtered to.
 * @returns the report text.
 */
export function renderCensus(value: Census, options: { limit?: number | undefined; focus?: string | undefined } = {}): string {
  const limit = options.limit ?? REPORT_LIMIT
  const sections: string[] = []
  const { coverage } = value

  const headline = value.verdict === 'ok'
    ? `Workspace membership — no unlisted member found (${coverage.workspaces} workspace(s), ${coverage.headers} stored session(s) read).`
    : `Workspace membership — ${value.candidates.length} stored session(s) belong to a workspace that does not list them.`
  sections.push(options.focus === undefined ? headline : `${headline}\nFiltered to: ${options.focus}`)

  for (const workspace of value.workspaces) {
    if (workspace.candidates.length === 0) continue
    const lines = [`  ${workspace.title}  (${workspace.path})`, `    listed members: ${workspace.attached.length}`]
    for (const candidate of bounded(workspace.candidates.map(entry => entry.sessionId), limit)) lines.push(`    ✗ ${candidate}`)
    lines.push('    ^ each of these is stored under this workspace\'s own directory and is not a member.')
    sections.push(lines.join('\n'))
  }

  if (value.unresolved.length > 0) {
    const lines = [
      `Sessions whose cwd this process could not place — ${value.unresolved.length}:`,
      '',
      'These are the cause set. The registry\'s startup index cannot place them either, so any workspace',
      'record that still lists one will drop it on its next write, and the drop is persisted. A session',
      'listed here that is *not* also a candidate above is still a member: it is at risk, not yet damaged.',
    ]
    for (const entry of bounded(value.unresolved.map(entry => entry.sessionId), limit)) {
      if (entry.startsWith('(+')) { lines.push(`  ${entry}`); continue }
      const detail = value.unresolved.find(candidate => candidate.sessionId === entry)!
      lines.push(`  ${entry}`)
      lines.push(`    cwd: ${detail.cwd ?? '(none)'}`)
      lines.push(`    ${describeReason(detail.reason)} — ${detail.detail}`)
    }
    sections.push(lines.join('\n'))
  }

  if (value.orphans.length > 0) {
    sections.push([
      `Sessions whose canonical cwd is no workspace's path — ${value.orphans.length}:`,
      '',
      'This is the operational meaning of "Ungrouped", and it is not damage: either the directory was',
      'never registered as a workspace, or the session genuinely lives outside every one. The doctor',
      'proposes nothing for them — a session whose cwd no longer matches a workspace is exactly the case',
      'the registry is right to prune.',
      '',
      ...bounded(value.orphans.map(entry => `${entry.sessionId}  (${entry.resolved})`), limit).map(line => `  ${line}`),
    ].join('\n'))
  }

  sections.push([
    'Coverage — what this census actually read:',
    '',
    `  workspaces published      ${coverage.workspaces}`,
    `  stored headers read       ${coverage.headers}`,
    `  cwd resolved              ${coverage.resolved}`,
    `  cwd not resolved          ${coverage.unresolved}`,
    `  matched a workspace       ${coverage.matched}`,
    `  matched none (ungrouped)  ${coverage.orphans}`,
  ].join('\n'))

  sections.push([
    'What this census cannot see:',
    '',
    '  - A session the durable record still lists whose index entry is missing reads exactly like one',
    '    already dropped: both appear as candidates above. That is deliberate — the registry publishes',
    '    only the filtered projection, and reading its private record would be a different plugin with a',
    '    different risk. The repair is the same for both: `attachSession` is a no-op when the record',
    '    already lists the session.',
    '  - A session a user deliberately detached from a workspace is, by the same records, identical to a',
    '    silently pruned one. This is why nothing here repairs on its own; see the README.',
    '  - A workspace whose own directory is gone keeps its `path` (the registry never rewrites it), so',
    '    its members still match by path. Nothing here can tell a moved workspace from a deleted one.',
  ].join('\n'))

  return sections.join('\n\n')
}

/**
 * Render the outcome of a repair, including the census taken before and after.
 * @param steps - the plan that ran.
 * @param outcomes - one outcome per step.
 * @param before - the census the plan came from.
 * @param after - a fresh census taken after the writes, or `undefined` when that re-read failed.
 * @returns the report text.
 */
export function renderRepair(
  steps: readonly RepairStep[],
  outcomes: readonly RepairOutcome[],
  before: Census,
  after: Census | undefined,
): string {
  const attached = outcomes.filter(outcome => outcome.status === 'attached')
  const refused = outcomes.filter(outcome => outcome.status === 'refused')
  const missing = outcomes.filter(outcome => outcome.status === 'no-workspace')
  const lines = [
    `Repair — ${attached.length} attached, ${refused.length} refused by the registry, ${missing.length} workspace(s) gone.`,
    '',
    after === undefined
      ? 'Candidates after: unknown — membership could not be re-read, so this report claims nothing about what now holds.'
      : `Candidates before: ${before.candidates.length}. Candidates after: ${after.candidates.length}.`,
  ]
  for (const outcome of attached) {
    lines.push(`  attached  ${outcome.step.sessionId}  →  ${outcome.step.workspacePath}`)
  }
  for (const outcome of refused) {
    lines.push(`  refused   ${outcome.step.sessionId}  →  ${outcome.step.workspacePath}`)
    lines.push(`              ${outcome.error ?? ''}`)
  }
  for (const outcome of missing) {
    lines.push(`  gone      workspace ${outcome.step.workspaceId} no longer exists; nothing was written`)
  }
  if (refused.length > 0) {
    lines.push('')
    lines.push('A refusal above is the registry\'s own validation, quoted as it arrived: the stored cwd no')
    lines.push('longer resolves to that workspace\'s path, so the membership is not true any more. Nothing')
    lines.push('was written for those steps, and the doctor re-plans from a fresh census next time.')
  }
  if (after !== undefined
    && attached.length > 0
    && after.candidates.some(candidate => attached.some(outcome => outcome.step.sessionId === candidate.sessionId))) {
    lines.push('')
    lines.push('Note: a session the registry reported attached is still a candidate in the census taken after the')
    lines.push('write. That means the durable record took it but this process\'s index did not, which is a state')
    lines.push('worth reporting upstream rather than retrying here.')
  }
  lines.push(...['', 'A restart is not required: `attachSession` writes the durable record and updates the live index.'])
  return lines.join('\n\n')
}

/**
 * Render the plan without performing it — the default answer to a repair
 * request that did not confirm.
 * @param steps - the plan.
 * @returns the report text.
 */
export function renderPlan(steps: readonly RepairStep[]): string {
  const lines = [
    `Repair plan — ${steps.length} attach(es); nothing has been written.`,
    '',
    'Call again with `confirm: true` to perform them.',
  ]
  for (const step of steps) {
    lines.push(`  ${step.sessionId}  →  ${step.workspacePath}  (${step.workspaceId})`)
  }
  return lines.join('\n')
}

/**
 * Explain one stored session against the census: member, lost member, cause
 * (unplaceable cwd), or ungrouped.
 *
 * Every stored header lands in exactly one of the census's four lists, so
 * "absent from all four" is itself an answer and is reported as one — never as
 * "not a member", which is what a filtered census would also look like.
 * @param value - the census.
 * @param sessionId - the session to explain.
 * @param options - `filtered` states that the census covers one workspace only.
 * @returns the report text.
 */
export function renderSessionFocus(
  value: Census,
  sessionId: string,
  options: { filtered?: boolean | undefined } = {},
): string {
  const lines = [`Session ${sessionId}:`]
  let found = false

  for (const workspace of value.workspaces) {
    if (workspace.attached.includes(sessionId)) {
      found = true
      lines.push(`  listed as a member of '${workspace.title}' (${workspace.path})`)
    }
    if (workspace.candidates.some(entry => entry.sessionId === sessionId)) {
      found = true
      lines.push(`  NOT listed by '${workspace.title}' (${workspace.path}), which owns the directory its cwd resolves to`)
      lines.push('    → this is the loss: `action: "repair"` with `confirm: true` re-attaches it.')
    }
  }

  const unresolved = value.unresolved.find(entry => entry.sessionId === sessionId)
  if (unresolved !== undefined) {
    found = true
    lines.push(`  this process cannot place its cwd: ${describeReason(unresolved.reason)}`)
    lines.push(`    cwd: ${unresolved.cwd ?? '(none)'}`)
    lines.push(`    ${unresolved.detail}`)
    lines.push('    → it is in the cause set: while it stays unplaceable, the next write to a workspace record drops it.')
  }

  const orphan = value.orphans.find(entry => entry.sessionId === sessionId)
  if (orphan !== undefined) {
    found = true
    lines.push(`  its canonical cwd '${orphan.resolved}' is no workspace's path`)
    lines.push('    → ungrouped, which is not damage: no workspace owns that directory.')
  }

  if (!found) {
    lines.push(options.filtered === true
      ? '  nothing was read about it here: this census covers one workspace, so a membership in another one would not appear.'
      : '  no stored session read here carries that id — either the id is not a session of this process, or its persistence is not the one under this census.')
  }
  return lines.join('\n')
}

/**
 * Render the case where the census could not be taken at all. This must never
 * be rendered as an empty census: "could not read" and "read nothing" are
 * different answers.
 * @param error - the failure, as message text.
 * @returns the report text.
 */
export function renderUnavailable(error: string): string {
  return [
    'Workspace membership — the census could not be taken.',
    '',
    `The stored session headers could not be listed: ${error}`,
    '',
    'Nothing is known about membership in this process, and no candidates are reported — an empty list',
    'here would mean "nothing is wrong", which is not what happened.',
  ].join('\n')
}
