/**
 * The plugin end: the real resolver against real directories, the port reader,
 * the repair loop, the startup census, and the tool's own execute path.
 *
 * The only real I/O here is `fs` on directories this file creates under the OS
 * temp root — deliberately, because the census's contract is that it resolves a
 * cwd exactly the way the registry's index does.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  cwdResolver,
  readPort,
  takeCensus,
  TOOL,
} from '../lib/index.js'
import { default as defaultExport, name as pluginName, inject } from '../lib/index.js'
import { repair } from '../lib/repair.js'
import {
  makeHeader,
  makePersistence,
  makePluginContext,
  makeRegistry,
  makeWorkspace,
  waitFor,
} from '../test-support/fakes.mjs'

/** A directory the test owns, under the OS temp root. */
async function scratch() {
  return await realpath(await mkdtemp(join(tmpdir(), 'wmd-')))
}

/** A census resolver that never touches the filesystem. */
function fakeResolver(table) {
  return async (cwd) => {
    const entry = table[cwd]
    if (entry === undefined) return { ok: false, reason: 'does-not-resolve', detail: `nothing at '${cwd}'` }
    if (typeof entry === 'string') return { ok: true, path: entry }
    return { ok: false, reason: entry.reason, detail: entry.detail }
  }
}

describe('cwdResolver — the registry index, reproduced', () => {
  it('resolves an existing directory to its canonical path', async () => {
    const dir = await scratch()
    assert.deepEqual(await cwdResolver()(dir), { ok: true, path: dir })
  })

  it('canonicalizes through a symlinked spelling, like the index does', async () => {
    const dir = await scratch()
    const link = join(dir, 'link')
    await mkdir(join(dir, 'real'))
    await (await import('node:fs/promises')).symlink(join(dir, 'real'), link)
    assert.deepEqual(await cwdResolver()(link), { ok: true, path: join(dir, 'real') })
  })

  it('rejects a relative spelling before touching the filesystem', async () => {
    const result = await cwdResolver()('a/b')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-fully-qualified')
    assert.match(result.detail, /is not fully qualified/)
  })

  it('reports a path that does not exist as unresolvable', async () => {
    const dir = await scratch()
    const result = await cwdResolver()(join(dir, 'nope'))
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'does-not-resolve')
    assert.match(result.detail, /ENOENT/)
  })

  it('reports an existing non-directory as not a directory', async () => {
    const dir = await scratch()
    const file = join(dir, 'f.txt')
    await writeFile(file, 'x')
    const result = await cwdResolver()(file)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-a-directory')
    assert.match(result.detail, /is not a directory/)
  })

  it('turns a stat failure into data rather than an exception', async () => {
    const dir = await scratch()
    const throwing = async () => { throw new Error('EPERM: operation not permitted') }
    const result = await cwdResolver(undefined, throwing)(dir)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'does-not-resolve')
    assert.equal(result.detail, 'EPERM: operation not permitted')
  })

  it('is the export the package publishes, not a private copy of it', () => {
    assert.equal(typeof cwdResolver, 'function')
    assert.equal(typeof readPort, 'function')
    assert.equal(typeof takeCensus, 'function')
  })
})

describe('readPort', () => {
  it('projects the services into the plain views the census reads', async () => {
    const workspace = makeWorkspace({ id: 'w1', path: '/a', title: 'A', sessionIds: ['m1'] })
    const port = await readPort({
      registry: makeRegistry([workspace]),
      persistence: makePersistence([makeHeader('s1', '/a', 5)]),
    })
    assert.equal(port.ok, true)
    assert.deepEqual(port.workspaces, [{ id: 'w1', path: '/a', title: 'A', sessionIds: ['m1'] }])
    assert.deepEqual(port.headers, [{ id: 's1', cwd: '/a', createdAt: 5 }])
    // The projection is a snapshot of the registry's list, not the entity's own
    // array: the tool re-reads the port after a repair, and the point of that
    // re-read is that this view did NOT move on its own.
    assert.notEqual(port.workspaces[0].sessionIds, workspace.sessionIds)
  })

  it('reports a registry that cannot be listed instead of failing the call', async () => {
    const port = await readPort({
      registry: { list: () => { throw new Error('storage offline') }, get: () => undefined },
      persistence: makePersistence([]),
    })
    assert.deepEqual(port, { ok: false, error: 'the workspace registry could not be listed: storage offline' })
  })

  it('reports a persistence that refuses to list, and does not present it as an empty census', async () => {
    const port = await readPort({
      registry: makeRegistry([]),
      persistence: makePersistence([], { fail: new Error('EACCES') }),
    })
    assert.deepEqual(port, { ok: false, error: 'session persistence refused to list stored sessions: EACCES' })
  })

  it('stringifies a non-Error rejection rather than losing it', async () => {
    const port = await readPort({
      registry: makeRegistry([]),
      persistence: { async list() { throw 'plain string' } },
    })
    assert.deepEqual(port, { ok: false, error: 'session persistence refused to list stored sessions: plain string' })
  })
})

describe('takeCensus', () => {
  const port = {
    ok: true,
    workspaces: [
      { id: 'w1', path: '/a', title: 'A', sessionIds: [] },
      { id: 'w2', path: '/b', title: 'B', sessionIds: [] },
    ],
    headers: [makeHeader('s1', '/a'), makeHeader('s2', '/b')],
    registry: makeRegistry([]),
  }

  it('narrows to one workspace by id and by exact path', async () => {
    const byId = await takeCensus(port, { workspace: 'w1' }, fakeResolver({ '/a': '/a' }))
    assert.deepEqual(byId.census.candidates.map(entry => entry.sessionId), ['s1'])
    const byPath = await takeCensus(port, { workspace: '/b' }, fakeResolver({ '/b': '/b' }))
    assert.deepEqual(byPath.census.candidates.map(entry => entry.sessionId), ['s2'])
    assert.equal(byId.focus, undefined)
  })

  it('says so when the requested workspace matched nothing, instead of reporting a clean run', async () => {
    const { census, focus } = await takeCensus(port, { workspace: 'nope' }, fakeResolver({}))
    assert.equal(census.coverage.workspaces, 0)
    assert.equal(focus, "no workspace matched 'nope'")
  })
})

describe('repair', () => {
  const step = (sessionId, workspaceId = 'w1') => ({ workspaceId, workspacePath: '/a', sessionId, createdAt: 1 })

  it('attaches through the registry and reports the acceptance', async () => {
    const workspace = makeWorkspace({ id: 'w1', path: '/a' })
    const outcomes = await repair([step('s1')], makeRegistry([workspace]))
    assert.deepEqual(outcomes.map(outcome => outcome.status), ['attached'])
    assert.deepEqual(workspace.calls, ['s1'])
    assert.deepEqual(workspace.sessionIds, ['s1'])
  })

  it('quotes the registry\'s own refusal and keeps going', async () => {
    const refusing = makeWorkspace({ id: 'w1', path: '/a', attach: 'refuse' })
    const accepting = makeWorkspace({ id: 'w2', path: '/b' })
    const outcomes = await repair(
      [step('s1', 'w1'), step('s2', 'w2')],
      makeRegistry([refusing, accepting]),
    )
    assert.deepEqual(outcomes.map(outcome => outcome.status), ['refused', 'attached'])
    assert.equal(outcomes[0].error, "cannot attach session 's1' to workspace '/a': its cwd does not resolve")
    assert.deepEqual(accepting.sessionIds, ['s2'])
  })

  it('reports a workspace that vanished between the census and the write', async () => {
    const outcomes = await repair([step('s1', 'gone')], makeRegistry([]))
    assert.deepEqual(outcomes, [{ step: step('s1', 'gone'), status: 'no-workspace' }])
  })

  it('runs steps in plan order, one at a time', async () => {
    const order = []
    const workspace = makeWorkspace({
      id: 'w1',
      path: '/a',
      attach: async (sessionId) => { order.push(sessionId) },
    })
    await repair([step('a'), step('b'), step('c')], makeRegistry([workspace]))
    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  it('survives a refusal dressed as a non-Error', async () => {
    const workspace = makeWorkspace({ id: 'w1', path: '/a', attach: async () => { throw 'nope' } })
    const outcomes = await repair([step('s1')], makeRegistry([workspace]))
    assert.deepEqual(outcomes, [{ step: step('s1'), status: 'refused', error: 'nope' }])
  })
})

describe('apply — mount', () => {
  it('publishes exactly one tool, named by the exported constant', () => {
    const { ctx, tools } = makePluginContext()
    apply(ctx)
    assert.equal(tools.registered.length, 1)
    assert.equal(tools.registered[0].name, TOOL)
    assert.equal(TOOL, 'workspace_membership')
    assert.match(tools.registered[0].description, /dropped from a workspace without\s+anyone detaching it/)
  })

  it('declares its plugin name, its tool dependency, and its default export', () => {
    assert.equal(pluginName, 'workspace-membership-doctor')
    assert.deepEqual(inject, ['tools'])
    assert.equal(defaultExport, apply)
  })

  it('asks for the two data services it cannot work without', () => {
    const { ctx, injections } = makePluginContext()
    apply(ctx)
    assert.deepEqual(injections.map(injection => injection.deps), [['workspaceRegistry', 'sessionPersistence']])
  })

  it('warns once at startup, naming what it found', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir, title: 'A' })
    const { ctx, logger, runInjections } = makePluginContext({
      services: {
        workspaceRegistry: makeRegistry([workspace]),
        sessionPersistence: makePersistence([makeHeader('s1', dir, 1)]),
      },
    })
    apply(ctx)
    runInjections()
    await waitFor(() => logger.warns.length > 0, 'the startup warning')
    assert.match(logger.warns[0], /1 stored session\(s\) belong to a workspace that does not\s+list them/)
    assert.match(logger.warns[0], /s1/)
    assert.match(logger.warns[0], new RegExp(`Call the ${TOOL} tool`))
  })

  it('discloses the count it truncated in the startup warning', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir })
    const headers = Array.from({ length: 7 }, (_, index) => makeHeader(`s${index}`, dir, index))
    const { ctx, logger, runInjections } = makePluginContext({
      services: { workspaceRegistry: makeRegistry([workspace]), sessionPersistence: makePersistence(headers) },
    })
    apply(ctx)
    runInjections()
    await waitFor(() => logger.warns.length > 0, 'the startup warning')
    assert.match(logger.warns[0], /\+2 more/)
  })

  it('stays quiet — at debug level — when there is nothing to report', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir, sessionIds: ['s1'] })
    const { ctx, logger, runInjections } = makePluginContext({
      services: { workspaceRegistry: makeRegistry([workspace]), sessionPersistence: makePersistence([makeHeader('s1', dir)]) },
    })
    apply(ctx)
    runInjections()
    await waitFor(() => logger.debugs.length > 0, 'the startup debug line')
    assert.deepEqual(logger.warns, [])
    assert.match(logger.debugs[0], /no unlisted member/)
  })

  it('warns, and claims nothing, when the census cannot be taken at startup', async () => {
    const dir = await scratch()
    const { ctx, logger, runInjections } = makePluginContext({
      services: {
        workspaceRegistry: makeRegistry([makeWorkspace({ id: 'w1', path: dir })]),
        sessionPersistence: makePersistence([], { fail: new Error('EACCES') }),
      },
    })
    apply(ctx)
    runInjections()
    await waitFor(() => logger.warns.length > 0, 'the startup warning')
    assert.match(logger.warns[0], /refused to list stored sessions: EACCES/)
  })

  it('does not start a census when the two services are not both there', async () => {
    const { ctx, logger, runInjections, tools } = makePluginContext({ services: {} })
    apply(ctx)
    runInjections()
    assert.deepEqual(logger.warns, [])
    assert.deepEqual(logger.debugs, [])
    assert.equal(tools.registered.length, 1)
  })

  it('reports a startup census that threw rather than dying silently', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir })
    const exploding = { async list() { throw new Error('boom') } }
    const { ctx, logger, runInjections } = makePluginContext({
      services: { workspaceRegistry: makeRegistry([workspace]), sessionPersistence: exploding },
    })
    apply(ctx)
    runInjections()
    await waitFor(() => logger.warns.length > 0, 'the startup warning')
    assert.match(logger.warns[0], /refused to list stored sessions: boom/)
  })
})

describe('the tool', () => {
  /** A mounted tool over a scripted pair of services. */
  function mounted({ workspaces = [], headers = [], dir } = {}) {
    const registry = makeRegistry(workspaces)
    const persistence = makePersistence(headers)
    const harness = makePluginContext({ services: { workspaceRegistry: registry, sessionPersistence: persistence } })
    apply(harness.ctx)
    return { tool: harness.tools.registered[0], registry, persistence, ...harness }
  }

  it('reports a census and writes nothing', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir, title: 'A' })
    const { tool, registry } = mounted({ workspaces: [workspace], headers: [makeHeader('s1', dir, 1)] })
    const value = await tool.execute({})
    assert.equal(value.mode, 'report')
    assert.equal(value.verdict, 'repairable')
    assert.equal(value.candidates, 1)
    assert.deepEqual(value.candidateSessions, ['s1'])
    assert.equal(value.attached, 0)
    assert.deepEqual(workspace.calls, [])
    assert.equal(registry.entities.get('w1').sessionIds.length, 0)
  })

  it('returns the plan — and still writes nothing — for a repair that did not confirm', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir })
    const { tool } = mounted({ workspaces: [workspace], headers: [makeHeader('s1', dir)] })
    const value = await tool.execute({ action: 'repair' })
    assert.equal(value.mode, 'plan')
    assert.equal(value.attached, 0)
    assert.deepEqual(workspace.calls, [])
    assert.match(value.report, /Repair plan — 1 attach\(es\); nothing has been written\./)
  })

  it('repairs when confirmed, and re-censuses afterwards', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir })
    const { tool } = mounted({ workspaces: [workspace], headers: [makeHeader('s1', dir, 3)] })
    const value = await tool.execute({ action: 'repair', confirm: true })
    assert.equal(value.mode, 'repair')
    assert.equal(value.attached, 1)
    assert.equal(value.refused, 0)
    assert.deepEqual(value.repairedSessions, ['s1'])
    assert.equal(value.candidates, 0)
    assert.deepEqual(workspace.sessionIds, ['s1'])
    assert.match(value.report, /Candidates before: 1\. Candidates after: 0\./)
  })

  it('reports a refusal from the registry without pretending it attached', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir, attach: 'refuse' })
    const { tool } = mounted({ workspaces: [workspace], headers: [makeHeader('s1', dir)] })
    const value = await tool.execute({ action: 'repair', confirm: true })
    assert.equal(value.attached, 0)
    assert.equal(value.refused, 1)
    assert.equal(value.candidates, 1)
    assert.match(value.report, /refused by the registry/)
  })

  it('explains one session when asked', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir, title: 'A' })
    const { tool } = mounted({ workspaces: [workspace], headers: [makeHeader('s1', dir)] })
    const value = await tool.execute({ session: 's1' })
    assert.match(value.report, /Session s1:/)
    assert.match(value.report, /NOT listed by 'A'/)
  })

  it('marks a narrowed census as narrowed', async () => {
    const dir = await scratch()
    const { tool } = mounted({ workspaces: [makeWorkspace({ id: 'w1', path: dir })], headers: [] })
    const value = await tool.execute({ workspace: 'w1' })
    assert.equal(value.workspaces, 1)
    const missing = await tool.execute({ workspace: 'nope', session: 's1' })
    assert.match(missing.report, /Filtered to: no workspace matched 'nope'/)
    assert.match(missing.report, /this census covers one workspace/)
  })

  it('accepts a workspace path as well as an id', async () => {
    const dir = await scratch()
    const { tool } = mounted({ workspaces: [makeWorkspace({ id: 'w1', path: dir })], headers: [makeHeader('s1', dir)] })
    const value = await tool.execute({ workspace: dir })
    assert.equal(value.workspaces, 1)
    assert.equal(value.candidates, 1)
  })

  it('clamps the print limit instead of trusting it', async () => {
    const dir = await scratch()
    const headers = Array.from({ length: 3 }, (_, index) => makeHeader(`s${index}`, dir, index))
    const { tool } = mounted({ workspaces: [makeWorkspace({ id: 'w1', path: dir })], headers })
    assert.match((await tool.execute({ limit: 1 })).report, /\+2 more not shown/)
    assert.match((await tool.execute({ limit: 0 })).report, /\+2 more not shown/)
    assert.match((await tool.execute({ limit: 100000 })).report, /✗ s2/)
  })

  it('says "unavailable" rather than "clean" when a service is missing', async () => {
    const harness = makePluginContext({ services: { sessionPersistence: makePersistence([]) } })
    apply(harness.ctx)
    const value = await harness.tools.registered[0].execute({})
    assert.equal(value.mode, 'unavailable')
    assert.equal(value.verdict, 'unavailable')
    assert.equal(value.candidates, 0)
    assert.match(value.report, /provides no workspaceRegistry service/)
  })

  it('names both missing services when both are absent', async () => {
    const harness = makePluginContext({ services: {} })
    apply(harness.ctx)
    const value = await harness.tools.registered[0].execute({})
    assert.match(value.report, /no workspaceRegistry and sessionPersistence service/)
  })

  it('says the after-state is unknown when it cannot re-read it, rather than reusing the before-state', async () => {
    const dir = await scratch()
    const workspace = makeWorkspace({ id: 'w1', path: dir })
    let calls = 0
    const flaky = {
      async list() {
        calls += 1
        if (calls === 1) return [makeHeader('s1', dir, 1)].map(header => ({ header }))
        throw new Error('EACCES')
      },
    }
    const harness = makePluginContext({ services: { workspaceRegistry: makeRegistry([workspace]), sessionPersistence: flaky } })
    apply(harness.ctx)
    const value = await harness.tools.registered[0].execute({ action: 'repair', confirm: true })
    assert.equal(value.attached, 1)
    assert.match(value.report, /Candidates after: unknown/)
    assert.equal(value.report.includes('Candidates before:'), false)
    assert.equal(value.report.includes('still a candidate'), false)
  })

  it('refuses to report a census it could not take', async () => {
    const harness = makePluginContext({
      services: { workspaceRegistry: makeRegistry([]), sessionPersistence: makePersistence([], { fail: new Error('EACCES') }) },
    })
    apply(harness.ctx)
    const value = await harness.tools.registered[0].execute({})
    assert.equal(value.mode, 'unavailable')
    assert.match(value.report, /the census could not be taken/)
    assert.match(value.report, /EACCES/)
  })

  it('renders its own report text, and does not leak the object', async () => {
    const dir = await scratch()
    const { tool } = mounted({ workspaces: [makeWorkspace({ id: 'w1', path: dir })], headers: [] })
    const value = await tool.execute({})
    assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: value.report }])
  })
})
