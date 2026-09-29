/**
 * The classification half, exercised without Cordis, without files, and without
 * services: `census` and `planRepair` are pure functions of their arguments.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { census, planRepair } from '../lib/census.js'

/** Build a resolver from a plain table: `{ '<cwd>': '<canonical>' | {reason, detail} }`. */
function resolver(table) {
  return async (cwd) => {
    const entry = table[cwd]
    if (entry === undefined) return { ok: false, reason: 'does-not-resolve', detail: `nothing at '${cwd}'` }
    if (typeof entry === 'string') return { ok: true, path: entry }
    return { ok: false, reason: entry.reason, detail: entry.detail }
  }
}

const ws = (id, path, sessionIds = []) => ({ id, path, title: `title-${id}`, sessionIds })

describe('census — placement', () => {
  it('reports a stored session whose cwd resolves to a workspace that does not list it', async () => {
    const value = await census(
      [ws('w1', '/a')],
      [{ id: 's1', cwd: '/a', createdAt: 7 }],
      resolver({ '/a': '/a' }),
    )
    assert.equal(value.verdict, 'repairable')
    assert.equal(value.candidates.length, 1)
    assert.deepEqual(value.candidates[0], { sessionId: 's1', cwd: '/a', resolved: '/a', createdAt: 7 })
    assert.deepEqual(value.workspaces[0].attached, [])
    assert.deepEqual(value.workspaces[0].candidates.map(entry => entry.sessionId), ['s1'])
    assert.deepEqual(value.unresolved, [])
    assert.deepEqual(value.orphans, [])
  })

  it('leaves a listed member alone', async () => {
    const value = await census([ws('w1', '/a', ['s1'])], [{ id: 's1', cwd: '/a', createdAt: 1 }], resolver({ '/a': '/a' }))
    assert.equal(value.verdict, 'ok')
    assert.equal(value.candidates.length, 0)
    assert.deepEqual(value.workspaces[0].attached, ['s1'])
    assert.equal(value.coverage.matched, 1)
  })

  it('matches the resolved path against the workspace path verbatim, not loosely', async () => {
    // The registry stores `fs.realpath` output at create time and never rewrites
    // it, so a workspace whose stored path is a symlink spelling owns nothing:
    // the header side is canonicalized, the workspace side is read as it stands.
    const value = await census([ws('w1', '/link')], [{ id: 's1', cwd: '/link', createdAt: 1 }], resolver({ '/link': '/real' }))
    assert.equal(value.candidates.length, 0)
    assert.deepEqual(value.orphans.map(entry => entry.sessionId), ['s1'])
    assert.equal(value.orphans[0].resolved, '/real')
  })

  it('routes a resolved header matching no workspace into orphans, not candidates', async () => {
    const value = await census([ws('w1', '/a')], [{ id: 's1', cwd: '/b', createdAt: 1 }], resolver({ '/b': '/b' }))
    assert.equal(value.verdict, 'ok')
    assert.deepEqual(value.candidates, [])
    assert.deepEqual(value.orphans, [{ sessionId: 's1', cwd: '/b', resolved: '/b', createdAt: 1 }])
  })

  it('picks the workspace that owns the directory when several are published', async () => {
    const value = await census(
      [ws('w1', '/a'), ws('w2', '/b')],
      [{ id: 's1', cwd: '/b/x', createdAt: 1 }],
      resolver({ '/b/x': '/b' }),
    )
    assert.equal(value.candidates.length, 1)
    assert.equal(value.workspaces[1].candidates.length, 1)
    assert.equal(value.workspaces[0].candidates.length, 0)
  })
})

describe('census — the cause set', () => {
  it('names a header that carries no cwd at all', async () => {
    const value = await census([ws('w1', '/a')], [{ id: 's1', cwd: undefined, createdAt: 1 }], resolver({}))
    assert.deepEqual(value.unresolved, [{
      sessionId: 's1',
      cwd: undefined,
      reason: 'no-cwd',
      detail: 'the stored header carries no cwd',
    }])
    assert.equal(value.verdict, 'ok')
    assert.equal(value.coverage.unresolved, 1)
  })

  it('keeps each resolver reason and detail verbatim', async () => {
    const value = await census(
      [ws('w1', '/a')],
      [
        { id: 'rel', cwd: 'a/b', createdAt: 3 },
        { id: 'file', cwd: '/f', createdAt: 2 },
        { id: 'gone', cwd: '/g', createdAt: 1 },
      ],
      resolver({
        'a/b': { reason: 'not-fully-qualified', detail: "cwd 'a/b' is not absolute" },
        '/f': { reason: 'not-a-directory', detail: "cwd '/f' is not a directory" },
        '/g': { reason: 'does-not-resolve', detail: 'ENOENT' },
      }),
    )
    assert.deepEqual(value.unresolved.map(entry => [entry.sessionId, entry.reason]), [
      ['rel', 'not-fully-qualified'],
      ['file', 'not-a-directory'],
      ['gone', 'does-not-resolve'],
    ])
    assert.equal(value.unresolved[2].detail, 'ENOENT')
    assert.equal(value.coverage.resolved, 0)
    assert.equal(value.coverage.matched, 0)
  })

  it('does not treat an unplaceable session as a candidate, even when its spelling names the workspace', async () => {
    // The point of the cause set: this session is a member today and damage
    // tomorrow, but the census must not claim the registry would accept it.
    const value = await census([ws('w1', '/a')], [{ id: 's1', cwd: '/a', createdAt: 1 }], resolver({
      '/a': { reason: 'does-not-resolve', detail: 'ENOENT' },
    }))
    assert.equal(value.candidates.length, 0)
    assert.equal(value.unresolved.length, 1)
    assert.equal(value.verdict, 'ok')
  })
})

describe('census — ordering and coverage', () => {
  it('orders candidates newest first, then by id', async () => {
    const value = await census(
      [ws('w1', '/a')],
      [
        { id: 'old', cwd: '/a', createdAt: 1 },
        { id: 'new-z', cwd: '/a', createdAt: 9 },
        { id: 'new-a', cwd: '/a', createdAt: 9 },
      ],
      resolver({ '/a': '/a' }),
    )
    assert.deepEqual(value.candidates.map(entry => entry.sessionId), ['new-a', 'new-z', 'old'])
  })

  it('plans in registry order, so a repaired workspace reads like an ordinary one', async () => {
    const value = await census(
      [ws('w1', '/a'), ws('w2', '/b')],
      [
        { id: 'a1', cwd: '/a', createdAt: 1 },
        { id: 'b1', cwd: '/b', createdAt: 2 },
        { id: 'a2', cwd: '/a', createdAt: 3 },
      ],
      resolver({ '/a': '/a', '/b': '/b' }),
    )
    assert.deepEqual(planRepair(value).map(step => [step.workspaceId, step.sessionId]), [
      ['w1', 'a2'],
      ['w1', 'a1'],
      ['w2', 'b1'],
    ])
    assert.deepEqual(planRepair(value)[0], { workspaceId: 'w1', workspacePath: '/a', sessionId: 'a2', createdAt: 3 })
  })

  it('counts what it read, so an empty census is distinguishable from a blind one', async () => {
    const value = await census(
      [ws('w1', '/a'), ws('w2', '/b')],
      [
        { id: 'c', cwd: '/a', createdAt: 1 },
        { id: 'o', cwd: '/elsewhere', createdAt: 1 },
        { id: 'u', cwd: '/a', createdAt: 1 },
      ],
      resolver({ '/a': '/a', '/elsewhere': '/elsewhere' }),
    )
    assert.deepEqual(value.coverage, { workspaces: 2, headers: 3, resolved: 3, unresolved: 0, matched: 2, orphans: 1 })
    assert.equal(value.workspaces.length, 2)
  })

  it('says "ok" — not "fine" — when nothing was inspected', async () => {
    const value = await census([], [], resolver({}))
    assert.equal(value.verdict, 'ok')
    assert.deepEqual(value.coverage, { workspaces: 0, headers: 0, resolved: 0, unresolved: 0, matched: 0, orphans: 0 })
  })
})
