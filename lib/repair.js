/** Render a thrown value the way a log line can carry it. */
function messageOf(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
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
export async function repair(steps, registry) {
    const outcomes = [];
    for (const step of steps) {
        const workspace = registry.get(step.workspaceId);
        if (workspace === undefined) {
            outcomes.push({ step, status: 'no-workspace' });
            continue;
        }
        try {
            await workspace.attachSession(step.sessionId);
            outcomes.push({ step, status: 'attached' });
        }
        catch (error) {
            outcomes.push({ step, status: 'refused', error: messageOf(error) });
        }
    }
    return outcomes;
}
