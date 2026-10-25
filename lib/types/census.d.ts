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
/**
 * The workspace fields this plugin reads. `sessionIds` is the registry's own
 * projection — already filtered by its canonical-cwd header index — and that is
 * the whole point: the projection is what hides a member whose index entry is
 * missing.
 *
 * Declared over plain `string` ids rather than the branded `SessionId` so the
 * census module stays a function of text and paths: it compares ids, it never
 * mints one, and a caller that owns the brand can still pass its values in.
 */
export interface WorkspaceView {
    readonly id: string;
    /** The canonical directory path the registry stored at create time, verbatim. */
    readonly path: string;
    readonly title: string;
    /** The listed members, as the registry published them (its filtered projection). */
    readonly sessionIds: readonly string[];
}
/**
 * The header fields this plugin reads.
 *
 * Spelled out rather than `Pick<SessionHeader, …>` on purpose: the stored
 * header's `cwd` is optional, and under `exactOptionalPropertyTypes` a `Pick`
 * keeps that optionality — which would make "the header carries no cwd" a
 * property that may be absent instead of a value that may be `undefined`. The
 * census reads the second, so it declares the second.
 */
export interface HeaderView {
    readonly id: string;
    /** The stored cwd, verbatim; `undefined` when the header recorded none. */
    readonly cwd: string | undefined;
    /** Creation instant, in the header's own spelling. */
    readonly createdAt: number;
}
/**
 * Why a stored header's `cwd` could not be placed on a workspace.
 *
 * The registry collapses the first three into one message
 * (`cwd '<x>' does not resolve`, `packages/workspace/workspace/src/index.ts` →
 * `indexHeader`); splitting them is this plugin's own refinement, and the
 * report says so, because a diagnosis that renames a cause must not look like
 * a reading of the cause.
 */
export type CwdFailure = 'no-cwd' | 'not-fully-qualified' | 'not-a-directory' | 'does-not-resolve';
/** The outcome of resolving one header's `cwd` to a canonical directory path. */
export type CwdResolution = {
    readonly ok: true;
    readonly path: string;
} | {
    readonly ok: false;
    readonly reason: CwdFailure;
    readonly detail: string;
};
/**
 * Resolve a header `cwd` exactly the way the registry's index does: canonicalize
 * it, then require the result to be a directory. Failure is data, not an
 * exception, because the caller's job is to report it.
 */
export type ResolveCwd = (cwd: string) => Promise<CwdResolution>;
/** One stored session a workspace should own and does not list. */
export interface Candidate {
    readonly sessionId: string;
    /** The session's stored header cwd, verbatim. */
    readonly cwd: string;
    /** The canonical path it resolved to, which equals the workspace path. */
    readonly resolved: string;
    /** Header creation instant, used to order the repair like `attachSession` prepends. */
    readonly createdAt: number;
}
/** The census of one workspace. */
export interface WorkspaceCensus {
    readonly id: string;
    readonly path: string;
    readonly title: string;
    /** Listed members, newest first: `sessionIds` as the registry published it. */
    readonly attached: readonly string[];
    /** Stored sessions whose canonical cwd is this workspace's path and which are not listed. */
    readonly candidates: readonly Candidate[];
}
/** A stored session whose `cwd` could not be resolved to any directory. */
export interface UnresolvedSession {
    readonly sessionId: string;
    readonly cwd: string | undefined;
    readonly reason: CwdFailure;
    readonly detail: string;
}
/** A stored session whose canonical cwd is no workspace's path. */
export interface OrphanSession {
    readonly sessionId: string;
    readonly cwd: string;
    readonly resolved: string;
    readonly createdAt: number;
}
/**
 * How much of the material the census could actually read, and what it could
 * not. A verdict without this block would let "I read nothing" print as "I
 * found nothing".
 */
export interface Coverage {
    /** Workspaces published by the registry. */
    readonly workspaces: number;
    /** Stored headers handed to the census. */
    readonly headers: number;
    /** Headers whose `cwd` resolved to an existing directory. */
    readonly resolved: number;
    /** Headers whose `cwd` did not resolve, by any of the four reasons. */
    readonly unresolved: number;
    /** Headers that resolved and matched some workspace path, member or not. */
    readonly matched: number;
    /** Resolved headers matching no workspace: the operational definition of "ungrouped". */
    readonly orphans: number;
}
/** The whole census. */
export interface Census {
    readonly workspaces: readonly WorkspaceCensus[];
    /** Every candidate, in workspace-registry order then newest-first within a workspace. */
    readonly candidates: readonly Candidate[];
    /** The cause set: sessions the index could not place. */
    readonly unresolved: readonly UnresolvedSession[];
    readonly orphans: readonly OrphanSession[];
    readonly coverage: Coverage;
    /** `repairable` iff at least one candidate exists; a census that read nothing is `ok` and says so. */
    readonly verdict: 'ok' | 'repairable';
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
export declare function census(workspaces: readonly WorkspaceView[], headers: readonly HeaderView[], resolveCwd: ResolveCwd): Promise<Census>;
/** One attach this plan will perform. */
export interface RepairStep {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly createdAt: number;
}
/**
 * Turn a census into the attaches it implies. Ordered as the census is:
 * workspace-registry order, newest first inside each workspace, so a repaired
 * workspace reads like one whose members were attached in the ordinary way.
 * @param value - the census to plan from.
 * @returns one step per candidate.
 */
export declare function planRepair(value: Census): readonly RepairStep[];
