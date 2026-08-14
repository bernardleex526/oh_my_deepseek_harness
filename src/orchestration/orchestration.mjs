/**
 * The orchestration preset row: enforces the control-plane permission boundary
 * and the single-writer delegation guard.
 *
 * Mounted by the `orchestrator` agent preset (agent.cordis.yml row
 * `- id: orchestration / name: ./orchestration.mjs`). It listens for
 * `agent/created` in the preset's standing scope and narrows each ROOT agent's
 * tool surface to the Orchestrator allow-list. It also installs the
 * `tools/pre-execute` + `tools/execute` (+ `tools/post-execute` fallback)
 * single-writer guard so only one write-capable (Fixer) delegation is in
 * flight at once. Specialist children are untouched here: their surfaces are
 * already narrowed by the delegation tool's `toolFilter`, which is compiled
 * into `tools.restrict()` on the child's own scope layer during setup.
 *
 * Why a root-only restriction:
 * - The preset composition registers the FULL tool union (specialists need
 *   write/edit/shell/web), so the session agent would otherwise see
 *   everything. Prompt-only discipline is not a boundary; this restriction
 *   makes "Orchestrator does not execute" mechanically true.
 * - Children must NOT inherit it: they are filtered per-role by the
 *   delegation tools instead. The check below keys on the absence of a
 *   durable `parentSession` header, which is exactly what distinguishes a
 *   top-level session agent from a spawned child.
 *
 * Timing: `agent/created` fires after scoped setup and registry entry, before
 * the first model request, so the catalog is narrowed before any request is
 * composed — the KV-cache prefix stays stable from request one.
 *
 * This file is intentionally IMPORT-FREE: it is loaded from the preset
 * directory (a user-writable location with no node_modules), so it may only
 * use the `ctx` API, the `agent` payload, and globals.
 *
 * @module multi-agent-orchestrator/orchestration
 */

/** Delegation tool names the Orchestrator may invoke. */
const SUBAGENT_TOOLS = [
	"subagent_explorer",
	"subagent_librarian",
	"subagent_observer",
	"subagent_oracle",
	"subagent_designer",
	"subagent_fixer"
];

/** The single write-capable delegation tool (the executor sibling). */
const FIXER_DELEGATION = "subagent_fixer";

/**
 * Single-writer mechanical guard state.
 *
 * `writerLocks` is a per-caller lock map (`Map<callerKey, token>`). Only one
 * write-capable (Fixer) delegation may be in flight per caller at once, so
 * all fixer calls issued by the SAME root session/caller serialize — two of
 * them can never interleave writes. Different callers (separate root
 * sessions running in the same process) get independent keys and never block
 * each other, because their workspace writes belong to disjoint sessions.
 *
 * Each key's value records the owning execution's registry token. Cleanup
 * only ever clears a key's lock for the exact call that took it — a denied
 * (or otherwise unrelated) call can never release another caller's lock, and
 * a non-owner caller B can never clear caller A's held lock.
 *
 * This file is intentionally IMPORT-FREE and process-local. Each process that
 * loads the preset row gets its own copy of the guard state, which is the
 * correct granularity: delegations are dispatched by one agent loop in one
 * process, so the map is the single point of truth for that process. Entries
 * are created lazily on acquire and removed on release, so the map never
 * grows unboundedly.
 */
const writerLocks = new Map();

/**
 * Compute the per-caller lock key from an execution's caller identity.
 *
 * `exec.agent` is the agent on whose behalf the call runs (set by the agent
 * loop); a root session agent's `id` is its SessionId. Calls without an
 * agent (rare, e.g. direct SDK sub-dispatches) share the `"unknown"` bucket
 * so they still serialize against each other. Two separate root sessions
 * have distinct agent ids → distinct keys → independent write guards.
 * @param {object} exec - the pending tool execution carrying `.agent`.
 * @returns {string} the caller key.
 */
function callerKey(exec) {
	return `${exec.agent?.id ?? "unknown"}`;
}

/**
 * The Orchestrator's own tool surface (allow list).
 *
 * Control plane: limited read/search, the user channel, task tracking,
 * web search, child catalog, and delegation. NO write/edit, NO shell, NO
 * background-job tools. Platform-independent: no shell tool is named here.
 */
export const ORCHESTRATOR_ALLOW = [
	"read",
	"read_image",
	"grep",
	"glob",
	"ask_user_question",
	"todo_write",
	"web_search",
	"list_agents",
	...SUBAGENT_TOOLS
];

/** Stable Cordis plugin name for this row. */
export const name = "orchestration";

/**
 * Plugin entry: register the root-agent boundary listener and the
 * single-writer delegation guard.
 * @param {object} ctx - the preset standing scope's Cordis context.
 */
export function apply(ctx) {
	ctx.on("agent/created", ({ agent }) => {
		if (agent.session.header.parentSession !== void 0) return;
		const tools = agent.ctx.get("tools");
		// FAIL-CLOSED: a synchronous throw inside an `agent/created` listener
		// vetoes publication — the agent is rolled back and never published
		// (a returned-promise rejection is only logged, non-vetoing). So we
		// throw synchronously rather than warn+return, to refuse to run a root
		// agent whose boundary could not be installed.
		if (tools === void 0) {
			ctx.logger?.error("orchestration: tools registry unavailable at agent/created — refusing to run the root agent without the boundary");
			throw new Error("orchestration: tools registry unavailable; orchestrator boundary cannot be installed (fail-closed)");
		}
		tools.restrict({ allow: [...ORCHESTRATOR_ALLOW] });
	});

	// ── single-writer gate ─────────────────────────────────────────────────
	//
	// `tools/pre-execute` is the reorderable allow/deny gate (dsh-tools
	// lib/index.js:3098 dispatches it via `ctx.waterfall(carrier,
	// "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }))`).
	// We take the lock HERE — before dispatch — so a second concurrent Fixer
	// delegation from the same caller is rejected at the gate with a
	// deniable reason rather than being allowed to start. All non-Fixer
	// tools pass through untouched (`return next()`), so every other call
	// keeps the exact default waterfall semantics.
	//
	// CRITICAL: because this listener is one entry in a reorderable chain,
	// `next()` may (a) delegate to LATER pre-execute listeners that throw, or
	// (b) yield a final decision that is NOT `{ kind: "allow" }` (a `deny`, or
	// an unresolved `ask`). In both cases dsh-tools (lib/index.js:3109-3136)
	// produces a terminal result that bypasses BOTH `tools/execute` and
	// `tools/post-execute` — so the execute-finally and post-execute fallback
	// below would never run and the caller's lock would be stranded forever.
	// We therefore release the lock directly in this branch on every
	// non-dispatch path:
	//   - `next()` throws           → release + rethrow.
	//   - final decision is not allow → release (only if this owner holds it).
	// This guarantees the lock is cleared exactly once, on the exact call
	// that took it, even though the real dispatch never happens.
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (exec.name !== FIXER_DELEGATION) return next();
		const key = callerKey(exec);
		if (writerLocks.has(key)) {
			return {
				kind: "deny",
				reason: "single-writer: a fixer delegation is already in progress for this caller; writes are serialized — wait for it to finish."
			};
		}
		writerLocks.set(key, exec.token);
		let decision;
		try {
			decision = await next();
		} catch (error) {
			// A later listener in the pre-execute chain threw. That becomes a
			// `final-result` in dsh-tools and never reaches execute/post-execute.
			releaseLock(key, exec.token);
			throw error;
		}
		// Returning undefined from a listener means "continue/allow" in the
		// waterfall; any explicit decision other than allow (deny/ask) means no
		// dispatch will occur for this call. For `ask`, the approval path may
		// later dispatch (serviceAsk can upgrade ask → allow), but our lock was
		// already re-checked per-caller at the gate: releasing here is safe
		// because a subsequent dispatch re-takes the lock before running. We
		// release now so a deny/ask outcome can never strand the lock.
		if (decision === void 0) decision = { kind: "allow" };
		if (decision.kind !== "allow") {
			releaseLock(key, exec.token);
		}
		return decision;
	});

	/**
	 * Clear one caller's writer lock, but only if `token` still owns it.
	 * Uses a captured `token` so a non-owner completion (e.g. a concurrent
	 * denied call, or a different caller's call entirely) can never clear an
	 * owner's lock. Deleting the key keeps the map from growing unboundedly.
	 * @param {string} key - the caller key.
	 * @param {symbol} token - the owning execution's registry token.
	 * @returns {void}
	 */
	function releaseLock(key, token) {
		if (writerLocks.get(key) === token) {
			writerLocks.delete(key);
		}
	}

	// Clear the lock on completion OR error.
	//
	// Mechanism choice: `tools/execute` is the around-dispatch waterfall
	// (dsh-tools lib/index.js:3195 — `ctx.waterfall(carrier, "tools/execute",
	// mutableExec, () => this.dispatchToolBody(mutableExec))`). Its handler
	// receives `(exec, next)`, where `next()` resolves to the normalized
	// dispatch result. Wrapping `next()` in a `try/finally` is therefore the
	// ONLY seam whose cleanup is guaranteed to fire on BOTH the success path
	// and the error path — a thrown `next()` (pipeline error) still runs the
	// `finally`, which simply clears the lock before the error propagates.
	// `tools/post-execute` would NOT cover the "pre-dispatch cancellation"
	// window (dsh-tools lib/index.js:3110-3126), so execute-finally is the
	// primary mechanism; we additionally clear in `tools/pre-execute`
	// (non-dispatch paths) and `tools/post-execute` (ownership scoped) so a
	// call cancelled between the gate and dispatch can never strand the lock.
	ctx.on("tools/execute", async (exec, next) => {
		try {
			return await next();
		} finally {
			releaseLock(callerKey(exec), exec.token);
		}
	});

	// Fallback clear for executions that set the lock at the gate but never
	// reached `tools/execute` (e.g. cancelled by the caller between the
	// allow decision and dispatch — a `post-result` that still runs
	// post-execute, see dsh-tools lib/index.js:3122-3126). Ownership-scoped:
	// only the exact call that holds the lock releases it, so a denied
	// concurrent call reaching this point with a different token clears
	// nothing, and a different caller's completion clears nothing either. The
	// handler ALWAYS proceeds to `next()` and returns its decision, preserving
	// the default `{ kind: "accept" }` post-execute semantics for every call
	// (dsh-tools lib/index.js:3360) — it only clears state; it never changes
	// a result.
	ctx.on("tools/post-execute", (exec, result, next) => {
		releaseLock(callerKey(exec), exec.token);
		return next();
	});
}
