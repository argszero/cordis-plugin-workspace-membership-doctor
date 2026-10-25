/**
 * The classification half of the doctor: given the workspaces a registry
 * publishes and the session headers a persistence service lists, decide which
 * stored sessions a workspace should own but does not list.
 *
 * This module holds no Cordis and no filesystem access. The one piece of
 * environment it needs — resolving a header's `cwd` the way the registry's own
 * index does — arrives as {@link ResolveCwd}, so the classification is a pure
 * function of its inputs and every branch is reachable from a test.
 *
 * @module @argszero/cordis-plugin-workspace-membership-doctor/src/census
 */
/** Newest first, then by id, mirroring the registry's own header comparison. */
function byHeaderOrder(left, right) {
    return right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId);
}
/**
 * Classify stored headers against published workspaces.
 *
 * A session is a candidate when its stored header `cwd` canonicalizes to a
 * workspace's own `path` and the registry does not list it for that workspace.
 * Both halves matter: the workspace path is compared verbatim because the
 * registry stores `fs.realpath` output at create time and never rewrites it,
 * and only the header side is canonicalized.
 * @param workspaces - workspaces in registry order.
 * @param headers - one entry per stored session the persistence service listed.
 * @param resolveCwd - the registry-equivalent resolver for a header `cwd`.
 * @returns the census.
 */
export async function census(workspaces, headers, resolveCwd) {
    const byPath = new Map();
    for (const workspace of workspaces)
        byPath.set(workspace.path, workspace);
    const resolvedBySession = new Map();
    const unresolved = [];
    for (const header of headers) {
        const cwd = header.cwd;
        if (cwd === undefined) {
            unresolved.push({ sessionId: header.id, cwd: undefined, reason: 'no-cwd', detail: 'the stored header carries no cwd' });
            continue;
        }
        const resolution = await resolveCwd(cwd);
        if (!resolution.ok) {
            unresolved.push({ sessionId: header.id, cwd, reason: resolution.reason, detail: resolution.detail });
            continue;
        }
        resolvedBySession.set(header.id, resolution.path);
    }
    const attachedByWorkspace = new Map();
    for (const workspace of workspaces)
        attachedByWorkspace.set(workspace.id, []);
    const orphans = [];
    let matched = 0;
    for (const header of headers) {
        const resolved = resolvedBySession.get(header.id);
        if (resolved === undefined)
            continue;
        const workspace = byPath.get(resolved);
        if (workspace === undefined) {
            orphans.push({ sessionId: header.id, cwd: header.cwd ?? '', resolved, createdAt: header.createdAt });
            continue;
        }
        matched += 1;
        if (workspace.sessionIds.includes(header.id))
            continue;
        attachedByWorkspace.get(workspace.id).push({
            sessionId: header.id,
            cwd: header.cwd ?? '',
            resolved,
            createdAt: header.createdAt,
        });
    }
    const workspacesCensus = [];
    const candidates = [];
    for (const workspace of workspaces) {
        const found = attachedByWorkspace.get(workspace.id).sort(byHeaderOrder);
        candidates.push(...found);
        workspacesCensus.push({
            id: workspace.id,
            path: workspace.path,
            title: workspace.title,
            attached: workspace.sessionIds,
            candidates: found,
        });
    }
    const coverage = {
        workspaces: workspaces.length,
        headers: headers.length,
        resolved: resolvedBySession.size,
        unresolved: unresolved.length,
        matched,
        orphans: orphans.length,
    };
    return {
        workspaces: workspacesCensus,
        candidates,
        unresolved,
        orphans,
        coverage,
        verdict: candidates.length > 0 ? 'repairable' : 'ok',
    };
}
/**
 * Turn a census into the attaches it implies. Ordered as the census is:
 * workspace-registry order, newest first inside each workspace, so a repaired
 * workspace reads like one whose members were attached in the ordinary way.
 * @param value - the census to plan from.
 * @returns one step per candidate.
 */
export function planRepair(value) {
    const steps = [];
    for (const workspace of value.workspaces) {
        for (const candidate of workspace.candidates) {
            steps.push({
                workspaceId: workspace.id,
                workspacePath: workspace.path,
                sessionId: candidate.sessionId,
                createdAt: candidate.createdAt,
            });
        }
    }
    return steps;
}
