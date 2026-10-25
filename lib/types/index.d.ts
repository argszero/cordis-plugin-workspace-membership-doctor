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
import { realpathNormalize } from '@deepseek-ai/dsh-workspace';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { Census, HeaderView, ResolveCwd, WorkspaceView } from './census.js';
import type { RegistryPort } from './repair.js';
export { census, planRepair } from './census.js';
export type { Candidate, Census, Coverage, CwdFailure, CwdResolution, HeaderView, OrphanSession, RepairStep, ResolveCwd, UnresolvedSession, WorkspaceCensus, WorkspaceView, } from './census.js';
export { repair } from './repair.js';
export type { AttachPort, RegistryPort, RepairOutcome } from './repair.js';
export { renderCensus, renderPlan, renderRepair, renderSessionFocus, renderUnavailable } from './report.js';
/** Cordis plugin name. */
export declare const name = "workspace-membership-doctor";
/** The tool service is required to publish the doctor; the two data services are resolved per call. */
export declare const inject: string[];
/** Tool name the model calls. */
export declare const TOOL = "workspace_membership";
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
export declare function cwdResolver(resolve?: typeof realpathNormalize, statDirectory?: typeof stat): ResolveCwd;
/** The services the census reads, or the reason it cannot. */
export type DoctorPort = {
    readonly ok: true;
    readonly workspaces: readonly WorkspaceView[];
    readonly headers: readonly HeaderView[];
    readonly registry: RegistryPort;
} | {
    readonly ok: false;
    readonly error: string;
};
/** The two services, as far as this plugin is concerned. */
interface DoctorServices {
    readonly registry: {
        list(): Workspace[];
        get(id: string): Workspace | undefined;
    };
    readonly persistence: Pick<SessionPersistence, 'list'>;
}
/**
 * Read the census inputs from the live services.
 * @param services - the workspace registry and session persistence.
 * @returns the port, or the failure that prevented reading it.
 */
export declare function readPort(services: DoctorServices): Promise<DoctorPort>;
/** Take a census from a port, optionally narrowed to one workspace and one session. */
export declare function takeCensus(port: DoctorPort & {
    readonly ok: true;
}, options?: {
    workspace?: string | undefined;
    session?: string | undefined;
}, resolveCwd?: ResolveCwd): Promise<{
    readonly census: Census;
    readonly focus: string | undefined;
}>;
/**
 * Register the doctor: a census at startup, and a tool that reports or repairs
 * on demand.
 * @param ctx - the plugin's context.
 */
export declare function apply(ctx: import('@deepseek-ai/cordis').Context): void;
export default apply;
