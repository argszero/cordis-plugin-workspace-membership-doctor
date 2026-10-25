/**
 * The repair half of the doctor: perform a {@link RepairStep} through the
 * registry's own public `attachSession`, and classify what happened.
 *
 * The doctor implements no membership rule of its own here. `attachSession`
 * re-reads the stored header, canonicalizes its `cwd`, refuses anything that is
 * not a directory or does not resolve to that workspace's own path, and is a
 * no-op when the durable record already lists the session
 * (`packages/workspace/workspace/src/entity.ts`). So the census decides *what
 * to try* and the registry alone decides what is *true* — a plan built from a
 * stale snapshot cannot write a wrong membership.
 *
 * @module @argszero/cordis-plugin-workspace-membership-doctor/src/repair
 */
import type { RepairStep } from './census.js';
/** The one workspace capability a repair uses. */
export interface AttachPort {
    /**
     * Attach a session to this workspace, validating its stored `cwd`.
     * @param sessionId - the session to attach.
     */
    attachSession(sessionId: string): Promise<void>;
}
/** The registry lookup a repair uses. */
export interface RegistryPort {
    /**
     * Look up one workspace entity.
     * @param id - the workspace id.
     */
    get(id: string): AttachPort | undefined;
}
/** What happened to one step. */
export interface RepairOutcome {
    readonly step: RepairStep;
    /**
     * `attached` — the registry accepted it (or already listed it).
     * `refused` — the registry's own validation rejected it; `error` is its message verbatim.
     * `no-workspace` — the registry no longer publishes that workspace.
     */
    readonly status: 'attached' | 'refused' | 'no-workspace';
    /** The registry's message, for `refused`; absent otherwise. */
    readonly error?: string;
}
/**
 * Run a repair plan one step at a time, in order.
 *
 * Sequential on purpose: `attachSession` funnels through the workspace's own
 * write chain, and a plan is at most one step per affected session, so
 * overlapping them would buy nothing and would make the reported order differ
 * from the order the registry wrote.
 * @param steps - the plan, as {@link planRepair} produced it.
 * @param registry - the workspace registry.
 * @returns one outcome per step, in plan order. A refusal never aborts the rest.
 */
export declare function repair(steps: readonly RepairStep[], registry: RegistryPort): Promise<readonly RepairOutcome[]>;
