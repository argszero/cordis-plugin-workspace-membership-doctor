/**
 * Workspace membership, lost silently and never restored.
 *
 * A durable workspace record lists its sessions. The registry's own projection
 * filters that list through a canonical-cwd header index built once at startup,
 * and *any* later write to the record persists the filtered list
 * (`packages/workspace/workspace/src/entity.ts`: the `sessionIds` getter and the
 * `mutate` prune). When that startup index cannot place a session — because its
 * stored `cwd` does not resolve at that instant, or because the boot that built
 * the index was still migrating session logs — the session is dropped from the
 * durable record by a write it had nothing to do with. There is no re-attach
 * path: the registry logs a warning per filtered id and nothing else, and the
 * capability to put a session back is already public
 * (`Workspace.attachSession`, used by the webhook flow and the session
 * controller).
 *
 * This package supplies what is missing around that seam:
 *
 * - a **census** of stored headers against the published workspaces, using the
 *   registry's own canonicalizer, that names every session a workspace should
 *   own and does not list;
 * - the **cause set** — the sessions whose `cwd` this process cannot place —
 *   because those are the ones the next write will drop, while they are still
 *   members;
 * - a **repair** that calls the registry's existing `attachSession`, which
 *   re-validates the stored `cwd` itself, so a plan built from a stale snapshot
 *   cannot write a wrong membership;
 * - a **coverage block** on every report, so "I read nothing" can never print as
 *   "nothing is wrong".
 *
 * Nothing is written unless `confirm: true` arrives. The reason is stated where
 * it matters rather than implied: a deliberate `detachSession` and a silent
 * prune leave the same records behind, so an automatic repair at startup would
 * undo the first while fixing the second.
 *
 * ```yaml
 * - id: workspace-membership-doctor
 *   name: '@argszero/cordis-plugin-workspace-membership-doctor'
 * ```
 *
 * @module @argszero/cordis-plugin-workspace-membership-doctor
 */
import { stat } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { realpathNormalize } from '@deepseek-ai/dsh-workspace';
import { census, planRepair } from './census.js';
import { repair } from './repair.js';
import { renderCensus, renderPlan, renderRepair, renderSessionFocus, renderUnavailable } from './report.js';
export { census, planRepair } from './census.js';
export { repair } from './repair.js';
export { renderCensus, renderPlan, renderRepair, renderSessionFocus, renderUnavailable } from './report.js';
/** Cordis plugin name. */
export const name = 'workspace-membership-doctor';
/** The tool service is required to publish the doctor; the two data services are resolved per call. */
export const inject = ['tools'];
/** Tool name the model calls. */
export const TOOL = 'workspace_membership';
/**
 * Resolve a stored `cwd` the way the registry's startup index does: `realpath`,
 * then require a directory. The two calls and their order are copied from
 * `indexHeader` on purpose — a census that resolved differently from the index
 * would report candidates the registry would never have dropped, or miss the
 * ones it did.
 * @param resolve - the canonicalizer, defaulting to the registry's own export.
 * @param statDirectory - the stat used for the directory check, injectable for a test that must force a failure.
 * @returns a resolver returning failure as data.
 */
export function cwdResolver(resolve = realpathNormalize, statDirectory = stat) {
    return async (cwd) => {
        let canonical;
        try {
            canonical = await resolve(cwd);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            // `realpathNormalize` rejects a relative spelling with a TypeError before
            // touching the filesystem; the registry reports that as "does not
            // resolve", this census keeps the distinction and says so in the report.
            const reason = error instanceof TypeError ? 'not-fully-qualified' : 'does-not-resolve';
            return { ok: false, reason, detail };
        }
        try {
            if (!(await statDirectory(canonical)).isDirectory()) {
                return { ok: false, reason: 'not-a-directory', detail: `cwd '${cwd}' is not a directory` };
            }
        }
        catch (error) {
            return { ok: false, reason: 'does-not-resolve', detail: error instanceof Error ? error.message : String(error) };
        }
        return { ok: true, path: canonical };
    };
}
/**
 * Read the census inputs from the live services.
 * @param services - the workspace registry and session persistence.
 * @returns the port, or the failure that prevented reading it.
 */
export async function readPort(services) {
    let workspaces;
    try {
        workspaces = services.registry.list().map(workspace => ({
            id: workspace.id,
            path: workspace.path,
            title: workspace.title,
            sessionIds: [...workspace.sessionIds],
        }));
    }
    catch (error) {
        return { ok: false, error: `the workspace registry could not be listed: ${error instanceof Error ? error.message : String(error)}` };
    }
    let snapshots;
    try {
        snapshots = await services.persistence.list();
    }
    catch (error) {
        return { ok: false, error: `session persistence refused to list stored sessions: ${error instanceof Error ? error.message : String(error)}` };
    }
    const headers = snapshots.map(snapshot => ({
        id: snapshot.header.id,
        cwd: snapshot.header.cwd,
        createdAt: snapshot.header.createdAt,
    }));
    return { ok: true, workspaces, headers, registry: services.registry };
}
/** Take a census from a port, optionally narrowed to one workspace and one session. */
export async function takeCensus(port, options = {}, resolveCwd = cwdResolver()) {
    const selection = options.workspace === undefined
        ? port.workspaces
        : port.workspaces.filter(workspace => workspace.id === options.workspace || workspace.path === options.workspace);
    const focus = options.workspace !== undefined && selection.length === 0
        ? `no workspace matched '${options.workspace}'`
        : undefined;
    return { census: await census(selection, port.headers, resolveCwd), focus };
}
/**
 * Register the doctor: a census at startup, and a tool that reports or repairs
 * on demand.
 * @param ctx - the plugin's context.
 */
export function apply(ctx) {
    const resolveCwd = cwdResolver();
    ctx.inject(['workspaceRegistry', 'sessionPersistence'], (scoped) => {
        const registry = scoped.get('workspaceRegistry');
        const persistence = scoped.get('sessionPersistence');
        if (registry === undefined || persistence === undefined)
            return;
        void (async () => {
            try {
                const port = await readPort({ registry, persistence });
                if (!port.ok) {
                    ctx.logger.warn(`workspace-membership-doctor: ${port.error}`);
                    return;
                }
                const { census: value } = await takeCensus(port, {}, resolveCwd);
                const { coverage } = value;
                if (value.candidates.length === 0) {
                    ctx.logger.debug(`workspace-membership-doctor: ${coverage.workspaces} workspace(s), ${coverage.headers} stored session(s),`
                        + ` ${coverage.unresolved} cwd not placed, no unlisted member`);
                    return;
                }
                ctx.logger.warn(`workspace-membership-doctor: ${value.candidates.length} stored session(s) belong to a workspace that does not`
                    + ` list them (${coverage.workspaces} workspace(s), ${coverage.headers} stored session(s) read).`
                    + ` Call the ${TOOL} tool to see them and re-attach through the registry: ${value.candidates.map(entry => entry.sessionId).slice(0, 5).join(', ')}`
                    + (value.candidates.length > 5 ? `, +${value.candidates.length - 5} more` : ''));
            }
            catch (error) {
                ctx.logger.warn(`workspace-membership-doctor: the startup census failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    });
    ctx.tools.register(defineTool({
        name: TOOL,
        description: 'Check and repair durable workspace membership. A session can be dropped from a workspace without'
            + ' anyone detaching it: the registry filters a workspace\'s members through a canonical-cwd index built at'
            + ' startup, and any later write persists that filtered list. A session whose cwd did not resolve at that'
            + ' moment — a boot that was still migrating session logs, a directory that was temporarily unreadable — is'
            + ' then missing from the workspace forever, and shows up as "Ungrouped". Use this when sessions you expect'
            + ' in a workspace appear ungrouped, when members disappeared after an upgrade, or to check one session'
            + ' before trusting that its grouping is durable. Reporting is read-only; re-attaching requires `confirm`.',
        parameters: {
            action: {
                type: 'string',
                description: '`report` (default) takes a census and writes nothing. `repair` re-attaches the candidates through'
                    + ' the registry\'s own validated attach path, and still writes nothing unless `confirm` is true.',
            },
            workspace: {
                type: 'string',
                description: 'Restrict the census to one workspace, by id or by exact canonical path.',
            },
            session: {
                type: 'string',
                description: 'Explain one stored session: whether a workspace lists it, should list it, cannot place its cwd, or'
                    + ' whether its cwd matches no workspace.',
            },
            confirm: {
                type: 'boolean',
                description: 'Required for `action: "repair"` to write anything. Without it a repair request returns the plan.',
            },
            limit: {
                type: 'integer',
                description: 'How many session ids to print per list. Default 20; the report states how many it withheld.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    mode: { type: 'string', required: true },
                    verdict: { type: 'string', required: true },
                    workspaces: { type: 'integer', required: true },
                    candidates: { type: 'integer', required: true },
                    unresolved: { type: 'integer', required: true },
                    orphans: { type: 'integer', required: true },
                    attached: { type: 'integer', required: true },
                    refused: { type: 'integer', required: true },
                    repairedSessions: { type: 'array', required: true, items: { type: 'string' } },
                    candidateSessions: { type: 'array', required: true, items: { type: 'string' } },
                    report: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
        },
        async execute(rawArgs) {
            const args = rawArgs;
            const limit = args.limit === undefined ? undefined : Math.max(1, Math.min(args.limit, 500));
            const registry = ctx.get('workspaceRegistry');
            const persistence = ctx.get('sessionPersistence');
            const empty = {
                workspaces: 0, candidates: 0, unresolved: 0, orphans: 0,
                attached: 0, refused: 0, repairedSessions: [], candidateSessions: [],
            };
            if (registry === undefined || persistence === undefined) {
                const missing = [
                    registry === undefined ? 'workspaceRegistry' : undefined,
                    persistence === undefined ? 'sessionPersistence' : undefined,
                ].filter((entry) => entry !== undefined);
                return {
                    ...empty,
                    mode: 'unavailable',
                    verdict: 'unavailable',
                    report: [
                        `Workspace membership — unavailable: this process provides no ${missing.join(' and ')} service.`,
                        '',
                        'Membership is read from those two services and from nothing else. Without them this tool cannot',
                        'tell "no workspace lost a member" apart from "no workspace could be read", so it reports neither.',
                    ].join('\n'),
                };
            }
            const port = await readPort({ registry, persistence });
            if (!port.ok) {
                return { ...empty, mode: 'unavailable', verdict: 'unavailable', report: renderUnavailable(port.error) };
            }
            const { census: value, focus } = await takeCensus(port, { workspace: args.workspace }, resolveCwd);
            const sections = [renderCensus(value, { limit, focus })];
            if (args.session !== undefined) {
                sections.push(renderSessionFocus(value, args.session, { filtered: args.workspace !== undefined }));
            }
            const plan = planRepair(value);
            let performed = [];
            let after;
            let mode = 'report';
            if (args.action === 'repair') {
                if (args.confirm !== true) {
                    mode = 'plan';
                    sections.push(renderPlan(plan));
                }
                else {
                    mode = 'repair';
                    performed = await repair(plan, port.registry);
                    // Re-read rather than reuse `port`: its projection is a snapshot taken
                    // before the writes, so a census over it would report the state the
                    // repair was supposed to change and make every repair look inert.
                    const refreshed = await readPort({ registry, persistence });
                    after = refreshed.ok
                        ? (await takeCensus(refreshed, { workspace: args.workspace }, resolveCwd)).census
                        : undefined;
                    sections.push(renderRepair(plan, performed, value, after));
                }
            }
            const finalCensus = after ?? value;
            return {
                mode,
                verdict: finalCensus.verdict,
                workspaces: finalCensus.coverage.workspaces,
                candidates: finalCensus.candidates.length,
                unresolved: finalCensus.coverage.unresolved,
                orphans: finalCensus.coverage.orphans,
                attached: performed.filter(outcome => outcome.status === 'attached').length,
                refused: performed.filter(outcome => outcome.status === 'refused').length,
                repairedSessions: performed.filter(outcome => outcome.status === 'attached').map(outcome => outcome.step.sessionId),
                candidateSessions: finalCensus.candidates.map(candidate => candidate.sessionId),
                report: sections.join('\n\n'),
            };
        },
    }));
}
export default apply;
