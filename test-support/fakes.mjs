/**
 * The test doubles. Every one of them is deliberately smaller than the real
 * service: the plugin's contract is the handful of methods it calls, and a
 * double that grew to match the real service would hide a call the plugin
 * should not be making.
 *
 * Nothing here touches the network or a real harness. The only real I/O any
 * test performs is `fs.realpath`/`stat` on directories the test itself creates
 * under the OS temp root, because the census's whole job is to resolve paths
 * the way the registry's index does.
 */

/** One fake workspace entity: a mutable membership list plus a scripted attach. */
export function makeWorkspace({ id, path, title = path, sessionIds = [], attach = 'accept' }) {
  const members = [...sessionIds]
  const calls = []
  return {
    id,
    path,
    title,
    get sessionIds() { return members },
    /** Every id this entity was asked to attach, in order. */
    calls,
    async attachSession(sessionId) {
      calls.push(sessionId)
      if (typeof attach === 'function') return attach(sessionId, members)
      if (attach === 'refuse') {
        throw new Error(`cannot attach session '${sessionId}' to workspace '${path}': its cwd does not resolve`)
      }
      if (!members.includes(sessionId)) members.unshift(sessionId)
    },
  }
}

/** The workspace registry, as far as the plugin can tell. */
export function makeRegistry(entities) {
  const byId = new Map(entities.map(entity => [entity.id, entity]))
  return {
    entities: byId,
    list: () => [...byId.values()],
    get: id => byId.get(id),
  }
}

/**
 * Session persistence's listing, as far as the plugin can tell.
 * @param headers - the stored headers to offer.
 * @param options - `fail` makes the listing reject with that error.
 */
export function makePersistence(headers, { fail } = {}) {
  return {
    calls: 0,
    async list() {
      this.calls += 1
      if (fail !== undefined) throw fail
      return headers.map(header => ({ header }))
    },
  }
}

/** A header record advanced to the fields the census reads. */
export function makeHeader(id, cwd, createdAt = 1) {
  const header = { id, createdAt }
  if (cwd !== undefined) header.cwd = cwd
  return header
}

/** A logger that keeps what it was told. */
export function makeLogger() {
  const warns = []
  const debugs = []
  return { warns, debugs, warn: message => warns.push(message), debug: message => debugs.push(message) }
}

/**
 * The slice of a Cordis context `apply` uses: `inject` (captured, not run),
 * `logger`, `tools.register`, and `get` over a service map.
 *
 * `runInjections()` invokes each captured callback with a scoped context whose
 * `get` reads the same service map — which is exactly how the plugin uses it.
 * The callback starts an async chain it does not return, so tests that await
 * its effect must poll (see {@link waitFor}).
 */
export function makePluginContext({ services = {} } = {}) {
  const logger = makeLogger()
  const registered = []
  const injections = []
  const tools = {
    registered,
    register(definition) { registered.push(definition) },
    get(name) { return registered.find(definition => definition.name === name) },
  }
  const ctx = {
    logger,
    tools,
    injections,
    get: name => services[name],
    inject(deps, callback) { injections.push({ deps, callback }) },
  }
  return {
    ctx,
    logger,
    tools,
    injections,
    runInjections: () => {
      for (const injection of injections) injection.callback({ get: name => services[name] })
    },
  }
}

/** Poll until `predicate()` is truthy, or fail with a message naming what never happened. */
export async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
