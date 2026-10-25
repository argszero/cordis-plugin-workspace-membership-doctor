/**
 * Report rendering. Every renderer states its own scope, because a diagnosis
 * that can print "0 candidates" while having read nothing is worse than no
 * diagnosis at all.
 *
 * @module @argszero/cordis-plugin-workspace-membership-doctor/src/report
 */
import type { Census, RepairStep } from './census.js';
import type { RepairOutcome } from './repair.js';
/**
 * Most session ids printed per list. A workspace may legitimately own hundreds
 * of sessions and a machine may own many workspaces; the report says how many
 * it withheld rather than growing without bound.
 */
export declare const REPORT_LIMIT = 20;
/**
 * Render the census.
 * @param value - the census.
 * @param options - `limit` bounds each printed list; `focus` names a workspace that was filtered to.
 * @returns the report text.
 */
export declare function renderCensus(value: Census, options?: {
    limit?: number | undefined;
    focus?: string | undefined;
}): string;
/**
 * Render the outcome of a repair, including the census taken before and after.
 * @param steps - the plan that ran.
 * @param outcomes - one outcome per step.
 * @param before - the census the plan came from.
 * @param after - a fresh census taken after the writes, or `undefined` when that re-read failed.
 * @returns the report text.
 */
export declare function renderRepair(steps: readonly RepairStep[], outcomes: readonly RepairOutcome[], before: Census, after: Census | undefined): string;
/**
 * Render the plan without performing it — the default answer to a repair
 * request that did not confirm.
 * @param steps - the plan.
 * @returns the report text.
 */
export declare function renderPlan(steps: readonly RepairStep[]): string;
/**
 * Explain one stored session against the census: member, lost member, cause
 * (unplaceable cwd), or ungrouped.
 *
 * Every stored header lands in exactly one of the census's four lists, so
 * "absent from all four" is itself an answer and is reported as one — never as
 * "not a member", which is what a filtered census would also look like.
 * @param value - the census.
 * @param sessionId - the session to explain.
 * @param options - `filtered` states that the census covers one workspace only.
 * @returns the report text.
 */
export declare function renderSessionFocus(value: Census, sessionId: string, options?: {
    filtered?: boolean | undefined;
}): string;
/**
 * Render the case where the census could not be taken at all. This must never
 * be rendered as an empty census: "could not read" and "read nothing" are
 * different answers.
 * @param error - the failure, as message text.
 * @returns the report text.
 */
export declare function renderUnavailable(error: string): string;
