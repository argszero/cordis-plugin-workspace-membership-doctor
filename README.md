# @argszero/cordis-plugin-workspace-membership-doctor

Finds and heals **workspace membership that was lost silently**, and tells you
what it could not see while it was looking.

A workspace in DeepSeek Harness owns a directory and lists the sessions that
belong to it. The registry keeps that list honest by filtering it through a
canonical-cwd header index built **once, at startup**
(`packages/workspace/workspace/src/entity.ts`):

```ts
get sessionIds() {
  return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
}
```

and the single write path re-applies the same filter before it persists
(`mutate` prunes every id whose indexed canonical cwd is not the workspace's own
path). So a session whose stored `cwd` did not resolve at the instant the index
was built — a boot that was still migrating session logs, a directory that was
temporarily unreadable, a mount that was not up yet — is invisible to the
projection, and **the next write to that record, for any reason at all, drops it
from the durable record**:

```
workspace '<id>' filtered session '<id>' from membership: cwd '<x>' does not resolve
```

That log line is the only trace. The stored header is intact, the directory is
still the workspace's own directory, and nothing in the product ever puts the
session back: it shows up as *Ungrouped* and the grouping the user made is gone.

## What this plugin does

On mount it takes a **census** of the stored session headers against the
published workspaces, using the registry's own canonicalizer — so its
classification cannot disagree with the index that did the filtering — and logs
one warning naming what it found. It also registers a tool:

```yaml
- insert:
    - id: workspace-membership-doctor
      name: '@argszero/cordis-plugin-workspace-membership-doctor'
```

```
workspace_membership                                report; writes nothing
workspace_membership action=repair                  the plan; writes nothing
workspace_membership action=repair confirm=true     re-attaches the candidates
workspace_membership workspace=<id|path>            narrow to one workspace
workspace_membership session=<id>                   explain one session
```

The repair calls the registry's **existing** public `attachSession`, which
re-reads the stored header and re-validates the cwd itself. That is the whole
safety argument: the census decides *what to try*, and the registry alone decides
what is *true*, so a plan built from a stale snapshot cannot write a wrong
membership. A step the registry refuses is reported with its own message,
verbatim, and the rest of the plan still runs.

## What it reports, and what it refuses to claim

| List | Meaning | Is it damage? |
|------|---------|---------------|
| **candidates** | its cwd resolves to this workspace's path and the workspace does not list it | yes — this is the loss |
| **cause set** | this process cannot place its stored cwd (no cwd / not absolute / not a directory / does not resolve) | not yet: it is *at risk* — the next write to any workspace record drops it |
| **ungrouped** | its canonical cwd is no workspace's path | no — no workspace owns that directory |

The cause set is the half that matters most, because it is the only place where
damage is still preventable: those sessions are dropped by a write that has
nothing to do with them.

Every report ends with a **coverage block** — workspaces published, headers read,
cwd resolved, matched, ungrouped — because "I read nothing" must never print as
"nothing is wrong". When the headers cannot be listed at all, the tool says so
instead of printing an empty census.

Three things it states outright that it **cannot** tell apart:

- A session the durable record still lists whose index entry is missing reads
  exactly like one already dropped — both are candidates. That is deliberate: the
  registry publishes only the filtered projection, and reading its private record
  would be a different plugin with a different risk. The repair is the same for
  both, because `attachSession` is a no-op when the record already lists the id.
- A session a user **deliberately** detached is, by the same records, identical
  to a silently pruned one. This is exactly why nothing here repairs on its own:
  an automatic repair at startup would undo the first while fixing the second.
- A workspace whose own directory is gone keeps its `path` (the registry never
  rewrites it), so its members still match by path. Nothing here can tell a moved
  workspace from a deleted one.

## Install

```sh
dsh plugin add github:argszero/cordis-plugin-workspace-membership-doctor
```

The package declares `dsh.bundle.patch`, so the verb installs it and attaches it
to the profile's composition in one step.

## Requirements

- Node `^22.19 || >=24`
- `@deepseek-ai/cordis` `^4.0.2` (peer)
- `@deepseek-ai/dsh-workspace`, `@deepseek-ai/dsh-session-persistence`,
  `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-session` — peers, resolved from the
  running harness, each declared as
  `>=0.1.7-alpha.1 <0.1.7-rc.1 || >=0.2.0-rc.1 <0.2.0 || >=0.2.1-rc.1 <0.2.1`

No runtime dependencies of its own.

### Why that range has three spans

The harness publishes several prerelease lines at once (`alpha`, `next`, plus
untagged builds), and a peer range is a claim about which of them this plugin
was actually tested on. The obvious spelling — `>=0.1.7-alpha.1 <0.2.0` — admits
the `0.1.7-rc.*` line too, which the suite has never been run against. So the
range names the three lines that were run, and
`npm run test:probe-lines` fails if the declaration and the run list drift apart
(it also refuses a range that admits a build the suite never measured).

| line | build the suite ran on |
|------|------------------------|
| `0.1.7-alpha` | `0.1.7-alpha.2` |
| `0.2.0-rc` | `0.2.0-rc.2` |
| `0.2.1-rc` | `0.2.1-rc.3` |

Each line was run in a clean tree (`rm -rf node_modules package-lock.json`, then
install that line's four packages, then `npm test`) — installing a line on top
of another one's `node_modules` silently tests a mixed tree, which npm refuses
here rather than resolving.

## Seams it uses

Everything it calls is already public:

- `ctx.workspaceRegistry.list()` / `.get(id)` — the workspace entities, whose
  `sessionIds` is the registry's own filtered projection;
- `Workspace.attachSession(sessionId)` — the validated re-attach path the
  webhook flow already uses;
- `ctx.sessionPersistence.list()` — stored headers, for the census;
- `realpathNormalize` — the registry's own canonicalizer, so the census resolves
  a cwd exactly the way the index did;
- `ctx.tools.register` — one tool.

It reads no private field, patches no method, and wraps nothing.

## Tests

```sh
npm install
npm test                 # 71 assertions, node --test, no network, no real harness
npm run test:probe-lines # the peer range admits exactly the lines that were run
npm run test:inject      # mutation harness: break one decision per arm, require the suite to fail
```

`test:inject` rebuilds before every arm and after every restore — a reverted
source against a stale `lib/` is exactly the way a mutation harness reports
"caught" for a defect it never injected.

## Licence

MIT
