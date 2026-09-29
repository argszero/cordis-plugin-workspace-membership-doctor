/**
 * Rendering. Each renderer's job is to keep three things separate that are easy
 * to blur: what was found, what could not be read, and what the tool refuses to
 * claim. The assertions here are on those distinctions, not on exact prose.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  REPORT_LIMIT,
  renderCensus,
  renderPlan,
  renderRepair,
  renderSessionFocus,
  renderUnavailable,
} from '../lib/report.js'

/** A hand-built census: renderers are pure, so they do not need real services. */
function mkCensus(overrides = {}) {
  return {
    workspaces: [],
    candidates: [],
    unresolved: [],
    orphans: [],
    coverage: { workspaces: 0, headers: 0, resolved: 0, unresolved: 0, matched: 0, orphans: 0 },
    verdict: 'ok',
    ...overrides,
  }
}

const candidate = (sessionId, createdAt = 1) => ({ sessionId, cwd: '/a', resolved: '/a', createdAt })

describe('renderCensus', () => {
  it('reads an empty report as "nothing found", and states what it read', () => {
    const text = renderCensus(mkCensus({ coverage: { workspaces: 2, headers: 5, resolved: 5, unresolved: 0, matched: 5, orphans: 0 } }))
    assert.match(text, /no unlisted member found \(2 workspace\(s\), 5 stored session\(s\) read\)/)
    assert.match(text, /workspaces published {6}2/)
    assert.match(text, /stored headers read {7}5/)
    assert.match(text, /What this census cannot see:/)
  })

  it('announces a narrowed census instead of looking like a global one', () => {
    const text = renderCensus(mkCensus(), { focus: "no workspace matched 'zz'" })
    assert.match(text, /Filtered to: no workspace matched 'zz'/)
  })

  it('names the workspace, its path, its member count, and every candidate', () => {
    const text = renderCensus(mkCensus({
      workspaces: [{ id: 'w1', path: '/a', title: 'Repo A', attached: ['m1', 'm2'], candidates: [candidate('s1'), candidate('s2', 2)] }],
      candidates: [candidate('s2', 2), candidate('s1')],
      verdict: 'repairable',
    }))
    assert.match(text, /2 stored session\(s\) belong to a workspace that does not list them/)
    assert.match(text, /Repo A {2}\(\/a\)/)
    assert.match(text, /listed members: 2/)
    assert.match(text, /✗ s1/)
    assert.match(text, /✗ s2/)
  })

  it('discloses what it withheld rather than growing without bound', () => {
    const many = Array.from({ length: REPORT_LIMIT + 3 }, (_, index) => candidate(`s${index}`))
    const text = renderCensus(mkCensus({
      workspaces: [{ id: 'w1', path: '/a', title: 'A', attached: [], candidates: many }],
      candidates: many,
      verdict: 'repairable',
    }))
    assert.match(text, /\+3 more not shown/)
    assert.equal(text.includes(`✗ s${REPORT_LIMIT}`), false)
  })

  it('explains the cause set per session, and truncating it still says how many were hidden', () => {
    const unresolved = [
      { sessionId: 'u1', cwd: undefined, reason: 'no-cwd', detail: 'the stored header carries no cwd' },
      { sessionId: 'u2', cwd: 'rel', reason: 'not-fully-qualified', detail: 'ERR_INVALID_ARG_TYPE' },
      { sessionId: 'u3', cwd: '/gone', reason: 'does-not-resolve', detail: 'ENOENT' },
    ]
    const text = renderCensus(mkCensus({ unresolved }))
    assert.match(text, /Sessions whose cwd this process could not place — 3:/)
    assert.match(text, /u1\n {4}cwd: \(none\)\n {4}the header records no cwd at all — the stored header carries no cwd/)
    assert.match(text, /u2\n {4}cwd: rel\n {4}the recorded cwd is not an absolute path — ERR_INVALID_ARG_TYPE/)
    assert.match(text, /u3\n {4}cwd: \/gone\n {4}the recorded cwd does not resolve on this filesystem — ENOENT/)
  })

  it('renders an unresolved non-directory with its own wording', () => {
    const text = renderCensus(mkCensus({
      unresolved: [{ sessionId: 'f', cwd: '/f', reason: 'not-a-directory', detail: "cwd '/f' is not a directory" }],
    }))
    assert.match(text, /the recorded cwd exists but is not a directory/)
  })

  it('bounds a long cause set and still reports the true total in the header', () => {
    const unresolved = Array.from({ length: 4 }, (_, index) => ({
      sessionId: `u${index}`, cwd: '/x', reason: 'does-not-resolve', detail: 'ENOENT',
    }))
    const text = renderCensus(mkCensus({ unresolved }), { limit: 2 })
    assert.match(text, /could not place — 4:/)
    assert.match(text, /\+2 more not shown/)
    assert.equal(text.includes('u2'), false)
  })

  it('calls orphans what they are — ungrouped, not damage', () => {
    const text = renderCensus(mkCensus({
      orphans: [{ sessionId: 'o1', cwd: '/b', resolved: '/b', createdAt: 1 }],
      coverage: { workspaces: 1, headers: 1, resolved: 1, unresolved: 0, matched: 0, orphans: 1 },
    }))
    assert.match(text, /no workspace's path — 1:/)
    assert.match(text, /not damage/)
    assert.match(text, /o1 {2}\(\/b\)/)
    assert.match(text, /matched none \(ungrouped\) {2}1/)
  })
})

describe('renderSessionFocus', () => {
  const listed = mkCensus({
    workspaces: [{ id: 'w1', path: '/a', title: 'A', attached: ['s1'], candidates: [] }],
  })

  it('says a listed session is a member', () => {
    const text = renderSessionFocus(listed, 's1')
    assert.match(text, /Session s1:/)
    assert.match(text, /listed as a member of 'A' \(\/a\)/)
  })

  it('rises to the loss and names the repair for an unlisted session', () => {
    const text = renderSessionFocus(mkCensus({
      workspaces: [{ id: 'w1', path: '/a', title: 'A', attached: [], candidates: [candidate('s2')] }],
      candidates: [candidate('s2')],
      verdict: 'repairable',
    }), 's2')
    assert.match(text, /NOT listed by 'A' \(\/a\)/)
    assert.match(text, /this is the loss/)
  })

  it('reports the cause for an unplaceable session, including that it is only at risk', () => {
    const text = renderSessionFocus(mkCensus({
      unresolved: [{ sessionId: 's3', cwd: undefined, reason: 'no-cwd', detail: 'the stored header carries no cwd' }],
    }), 's3')
    assert.match(text, /cannot place its cwd: the header records no cwd at all/)
    assert.match(text, /while it stays unplaceable, the next write to a workspace record drops it/)
  })

  it('reports both a membership and a cause when a session is listed but unplaceable', () => {
    const text = renderSessionFocus(mkCensus({
      workspaces: [{ id: 'w1', path: '/a', title: 'A', attached: ['s4'], candidates: [] }],
      unresolved: [{ sessionId: 's4', cwd: '/a', reason: 'does-not-resolve', detail: 'ENOENT' }],
    }), 's4')
    assert.match(text, /listed as a member of 'A'/)
    assert.match(text, /cannot place its cwd/)
  })

  it('calls an ungrouped session ungrouped, not lost', () => {
    const text = renderSessionFocus(mkCensus({
      orphans: [{ sessionId: 's5', cwd: '/b', resolved: '/b', createdAt: 1 }],
    }), 's5')
    assert.match(text, /no workspace's path/)
    assert.match(text, /ungrouped, which is not damage/)
  })

  it('separates "nothing known about it" from "not a member", and from a filtered census', () => {
    const nothing = renderSessionFocus(listed, 'zz')
    assert.match(nothing, /no stored session read here carries that id/)

    const filtered = renderSessionFocus(listed, 'zz', { filtered: true })
    assert.match(filtered, /this census covers one workspace/)
    assert.equal(filtered.includes('no stored session read here'), false)
  })
})

describe('renderPlan', () => {
  it('states that nothing was written and how to proceed', () => {
    const text = renderPlan([{ workspaceId: 'w1', workspacePath: '/a', sessionId: 's1', createdAt: 1 }])
    assert.match(text, /Repair plan — 1 attach\(es\); nothing has been written\./)
    assert.match(text, /Call again with `confirm: true`/)
    assert.match(text, /s1 {2}→ {2}\/a {2}\(w1\)/)
  })
})

describe('renderRepair', () => {
  const step = (sessionId) => ({ workspaceId: 'w1', workspacePath: '/a', sessionId, createdAt: 1 })
  const before = mkCensus({
    workspaces: [{ id: 'w1', path: '/a', title: 'A', attached: [], candidates: [candidate('s1'), candidate('s2')] }],
    candidates: [candidate('s1'), candidate('s2')],
    verdict: 'repairable',
  })
  const after = mkCensus({
    workspaces: [{ id: 'w1', path: '/a', title: 'A', attached: ['s1'], candidates: [] }],
    coverage: { workspaces: 1, headers: 2, resolved: 2, unresolved: 0, matched: 2, orphans: 0 },
  })

  it('counts the three outcomes and shows candidates before and after', () => {
    const text = renderRepair(
      [step('s1'), step('s2'), step('s3')],
      [
        { step: step('s1'), status: 'attached' },
        { step: step('s2'), status: 'refused', error: "cannot attach session 's2' to workspace '/a': its cwd resolves to '/b'" },
        { step: step('s3'), status: 'no-workspace' },
      ],
      before,
      after,
    )
    assert.match(text, /Repair — 1 attached, 1 refused by the registry, 1 workspace\(s\) gone\./)
    assert.match(text, /Candidates before: 2\. Candidates after: 0\./)
    assert.match(text, /attached {2}s1 {2}→ {2}\/a/)
    assert.match(text, /refused {3}s2/)
    assert.match(text, /its cwd resolves to '\/b'/)
    assert.match(text, /gone {6}workspace w1 no longer exists; nothing was written/)
    assert.match(text, /A refusal above is the registry's own validation, quoted as it arrived/)
    assert.match(text, /A restart is not required/)
  })

  it('flags the state worth reporting upstream: accepted by the record, still unlisted here', () => {
    const text = renderRepair([step('s1')], [{ step: step('s1'), status: 'attached' }], before, before)
    assert.match(text, /still a candidate in the census taken after the/)
  })

  it('omits both paragraphs when neither applies', () => {
    const text = renderRepair([step('s1')], [{ step: step('s1'), status: 'attached' }], before, after)
    assert.equal(text.includes('A refusal above'), false)
    assert.equal(text.includes('still a candidate'), false)
  })
})

describe('renderUnavailable', () => {
  it('never renders a blind report as an empty one', () => {
    const text = renderUnavailable('ENOENT: no such file or directory')
    assert.match(text, /the census could not be taken/)
    assert.match(text, /could not be listed: ENOENT: no such file or directory/)
    assert.match(text, /an empty list\nhere would mean "nothing is wrong", which is not what happened/)
  })
})
