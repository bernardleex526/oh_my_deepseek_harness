/**
 * Orchestration-row runtime mechanics tests: fail-closed boundary installation
 * and the broker-driven delegation chain (workspace-keyed single-writer
 * guard, TASK_ID protocol gate, budget gates, ask-hold semantics).
 *
 * `src/orchestration/orchestration.mjs` is import-free except for its preset
 * siblings (`./broker.mjs`, `./protocol.mjs`), so plain node can import it
 * directly and we drive its listeners with a minimal FAKE Cordis ctx — no
 * harness packages needed.
 *
 * Lock semantics under test:
 * - the writer lock is keyed by the caller's normalized WORKSPACE (session
 *   cwd), falling back to the caller's agent id;
 * - the lock is HELD through `ask` and downstream `deny` decisions (dsh-tools
 *   does not re-run pre-execute after approval, so releasing on ask would let
 *   an approved fixer dispatch unlocked) and released by the execute `finally`
 *   or the post-execute settle — never stranded, never stolen by a non-owner;
 * - a downstream pre-execute THROW still releases in the catch (that path
 *   bypasses both execute and post-execute).
 *
 * @module multi-agent-orchestrator/tests/orchestration
 */

import test from "node:test";
import assert from "node:assert/strict";
import { apply, broker, ORCHESTRATOR_ALLOW } from "../src/orchestration/orchestration.mjs";

const FIXER = "subagent_fixer";
const EXPLORER = "subagent_explorer";
const PROMPT = "TASK_ID: t1\nDo the thing.";

// The module-level broker instance is shared across every apply() in this
// file; reset its state between cases so tokens/budgets cannot leak.
test.beforeEach(() => broker.reset());

/** Build a fake Cordis `(exec, next)` listener to mock the `next()` delegate. */
function makeNext(decision) {
	return async () => decision;
}

/** A `next()` that always throws, simulating a later pre-execute listener error. */
function throwingNext(message = "boom") {
	return async () => {
		throw new Error(message);
	};
}

/**
 * Minimal helper: capture the listeners a fake ctx registers, expose the
 * stored handlers, and shut the module state down for reuse.
 * @returns {{ctx: object, listeners: Record<string, Function>, handler(name: string): Function}}
 */
function bootFakeCtx({ withTools = true, defineToolsUnavailable = false } = {}) {
	const restricted = [];
	const listeners = {};
	let tools;
	if (defineToolsUnavailable) {
		tools = void 0; // simulate `ctx.get("tools")` returning undefined
	} else {
		tools = {
			restrict(filter) {
				restricted.push(filter);
			}
			// NOTE: `register` is intentionally absent — the broker_status
			// registration must degrade silently when the registry is not
			// available on the scope.
		};
	}
	const errors = [];
	const ctx = {
		on(event, handler) {
			(listeners[event] ??= []).push(handler);
		},
		get(name) {
			if (name === "tools") return withTools ? tools : undefined;
			return undefined;
		},
		logger: {
			error: (msg) => errors.push(msg),
			warn: () => {}
		},
		// test-only accessor to inspect what was restricted
		__restricted: restricted,
		__errors: errors
	};
	apply(ctx);
	return {
		ctx,
		handler(event, i = 0) {
			return listeners[event]?.[i];
		},
		listeners
	};
}

/**
 * A fake fixer exec with a stable token, an optional caller identity, an
 * optional session cwd (the workspace lock key), and a delegation prompt.
 * @param {string} name - the tool name.
 * @param {string} token - a stable fake registry token.
 * @param {string} [callerId] - the caller agent id (undefined → "unknown").
 * @param {{cwd?: string, prompt?: string}} [opts] - session cwd / prompt.
 * @returns {{name: string, token: string, agent?: {id: string, session?: {header: {cwd?: string}}}, arguments: {prompt: string}}}
 */
function fakeExec(name, token, callerId, { cwd, prompt = PROMPT } = {}) {
	const base = { name, token, arguments: { prompt } };
	if (callerId === void 0) return base;
	const agent = { id: callerId };
	if (cwd !== void 0) agent.session = { header: { cwd } };
	return { ...base, agent };
}

// ── fail-closed boundary ───────────────────────────────────────────────────

test("fail-closed: agent/created throws when the tools registry is unavailable", () => {
	const { handler, ctx } = bootFakeCtx({ defineToolsUnavailable: true });
	const onCreated = handler("agent/created");
	assert.equal(typeof onCreated, "function");

	const rootAgent = {
		session: { header: { parentSession: void 0 } },
		ctx: { get: ctx.get }
	};
	assert.throws(() => onCreated({ agent: rootAgent }), /tools registry unavailable/);
	assert.ok(ctx.__errors.length >= 1, "logger.error must be called");
});

test("fail-closed: when the registry is present, restrict() is called once with the allow-list", () => {
	const { handler, ctx } = bootFakeCtx();
	const onCreated = handler("agent/created");
	const rootAgent = {
		session: { header: { parentSession: void 0 } },
		ctx: { get: ctx.get }
	};
	onCreated({ agent: rootAgent });
	assert.equal(ctx.__restricted.length, 1, "restrict must be called exactly once");
	assert.deepEqual(ctx.__restricted[0].allow.sort(), [...ORCHESTRATOR_ALLOW].sort());
});

// ── single-writer guard: gate (pre-execute) ─────────────────────────────────

test("single-writer: first fixer call is allowed and sets the lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "C:\\proj\\app" });

	const decision = await onPre(exec, makeNext({ kind: "allow" }));
	assert.deepEqual(decision, { kind: "allow" });

	// release so the module state is clean for the next test
	const onExecute = handler("tools/execute");
	await onExecute(exec, makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a second concurrent fixer call on the SAME workspace is denied", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const first = fakeExec(FIXER, "token-A", "session-A", { cwd: "C:\\proj\\app" });
	const second = fakeExec(FIXER, "token-B", "session-B", { cwd: "C:/proj/app" }); // different session, SAME workspace

	// first call allowed
	assert.equal((await onPre(first, makeNext({ kind: "allow" }))).kind, "allow");
	// second call while the first is in flight → denied (workspace-keyed)
	const denied = await onPre(second, makeNext({ kind: "allow" }));
	assert.equal(denied.kind, "deny");
	assert.match(denied.reason, /single-writer/);

	// after the first completes, the gate allows again
	const onExecute = handler("tools/execute");
	await onExecute(first, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "C:/proj/app" }), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "C:/proj/app" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: DISJOINT workspaces never block each other (per-workspace lock)", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	// Caller A locks workspace /proj/one.
	assert.equal((await onPre(fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj/one" }), makeNext({ kind: "allow" }))).kind, "allow");
	// Caller B on a DIFFERENT workspace is allowed even while A holds its lock.
	const b = fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj/two" });
	assert.equal((await onPre(b, makeNext({ kind: "allow" }))).kind, "allow", "different workspace must not be blocked");
	// B completes and releases only its own key.
	await onExecute(b, makeNext({ isError: false, value: 1, content: [] }));
	// A's lock is untouched: a caller-A call is still denied.
	assert.equal((await onPre(fakeExec(FIXER, "token-A2", "session-A", { cwd: "/proj/one" }), makeNext({ kind: "allow" }))).kind, "deny");
	// A completes → its key released.
	await onExecute(fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj/one" }), makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-A3", "session-A", { cwd: "/proj/one" }), makeNext({ kind: "allow" }))).kind, "allow");
	await onExecute(fakeExec(FIXER, "token-A3", "session-A", { cwd: "/proj/one" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: without a session cwd the lock falls back to the caller id", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	assert.equal((await onPre(fakeExec(FIXER, "token-A1", "session-A"), makeNext({ kind: "allow" }))).kind, "allow");
	assert.equal((await onPre(fakeExec(FIXER, "token-A2", "session-A"), makeNext({ kind: "allow" }))).kind, "deny", "same caller id → same bucket");
	// caller-less executions share the "unknown" bucket, independent of session-A
	assert.equal((await onPre(fakeExec(FIXER, "token-U1"), makeNext({ kind: "allow" }))).kind, "allow", "unknown bucket is independent of session-A");
	assert.equal((await onPre(fakeExec(FIXER, "token-U2"), makeNext({ kind: "allow" }))).kind, "deny", "unknown bucket serializes with itself");
	await onExecute(fakeExec(FIXER, "token-U1"), makeNext({ isError: false, value: 1, content: [] }));
	await onExecute(fakeExec(FIXER, "token-A1", "session-A"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: non-fixer calls pass through and never disturb the lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	const fixerA = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	const explorer = fakeExec(EXPLORER, "token-X", "session-A", { cwd: "/proj" });

	// take the writer lock
	assert.equal((await onPre(fixerA, makeNext({ kind: "allow" }))).kind, "allow");

	// a non-fixer call is allowed AND does not clear the writer lock
	const explDecision = await onPre(explorer, makeNext({ kind: "allow" }));
	assert.equal(explDecision.kind, "allow");
	// driving the non-fixer call "through execute" must not clear the fixer lock
	await onExecute(explorer, makeNext({ isError: false, value: 1, content: [] }));

	// the fixer lock is still held: a second fixer call is still denied
	const second = await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "deny");

	// releasing the fixer lock via execute now works
	await onExecute(fixerA, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

// ── single-writer guard: completion AND error clearing ─────────────────────

test("single-writer: the execute finally clears the lock on completion", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	assert.equal((await onPre(exec, makeNext({ kind: "allow" }))).kind, "allow");

	// already held → a second call denied
	assert.equal((await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "deny");

	// completion path: execute resolves normally → finally releases
	await onExecute(exec, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: the execute finally clears the lock on error path", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	assert.equal((await onPre(exec, makeNext({ kind: "allow" }))).kind, "allow");
	assert.equal((await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "deny");

	// error path: the dispatch `next()` throws → finally still releases the lock
	await assert.rejects(
		onExecute(exec, async () => {
			throw new Error("boom");
		}),
		/boom/
	);
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: post-execute fallback clears a lock stranded pre-dispatch", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");

	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	assert.equal((await onPre(exec, makeNext({ kind: "allow" }))).kind, "allow");

	// the call is cancelled between the gate and dispatch: post-execute fires
	// but tools/execute never runs. It must still release the lock.
	const postDecision = await onPost(exec, { isError: false, value: 1, content: [] }, makeNext({ kind: "accept" }));
	assert.equal(postDecision.kind, "accept");

	// gate is now open
	assert.equal((await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup via execute
	await handler("tools/execute")(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a denied (non-owner) call's post-execute never clears another's lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");

	const fixerA = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	assert.equal((await onPre(fixerA, makeNext({ kind: "allow" }))).kind, "allow");

	// B is denied at the gate (does not own the lock), but a real pipeline
	// would still fire its post-execute. It must NOT clear A's lock.
	const b = fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" });
	const denied = await onPre(b, makeNext({ kind: "allow" }));
	assert.equal(denied.kind, "deny");
	await onPost(b, { isError: true, content: [], error: { message: "denied" } }, makeNext({ kind: "accept" }));

	// A's lock is still held
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "deny");

	// A completes via execute → released
	await handler("tools/execute")(fixerA, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await handler("tools/execute")(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: the waterfall next() is invoked exactly for allowed fixer calls", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");

	let nextCalls = 0;
	const tracedNext = async () => {
		nextCalls += 1;
		return { kind: "allow" };
	};

	// non-fixer → next called (delegation preserved)
	await onPre(fakeExec(EXPLORER, "token-X", "session-A", { cwd: "/proj" }), tracedNext);
	assert.equal(nextCalls, 1, "non-fixer call must delegate to next()");

	// first fixer → next called
	await onPre(fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" }), tracedNext);
	assert.equal(nextCalls, 2, "first fixer call must delegate to next()");

	// second fixer (denied) → next NOT called (short-circuit deny)
	const denied = await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), tracedNext);
	assert.equal(denied.kind, "deny");
	assert.equal(nextCalls, 2, "denied call must not delegate to next()");

	// release via execute to keep the module state clean
	await handler("tools/execute")(fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

// ── single-writer guard: ask/deny HOLD the lock (approval-dispatch hole) ──

test("single-writer: a downstream pre-execute DENY holds the lock until post-execute", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");
	const onExecute = handler("tools/execute");

	// First fixer call: the (later listener / innermost) next() decides deny.
	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	const denied = await onPre(exec, makeNext({ kind: "deny", reason: "denied downstream" }));
	assert.equal(denied.kind, "deny");
	assert.equal(denied.reason, "denied downstream");

	// The lock MUST still be held: approval/deny paths never re-run
	// pre-execute, so releasing here would open a concurrent-writer window.
	assert.equal(
		(await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind,
		"deny",
		"a denied call must not free the writer lock before post-execute"
	);

	// post-execute settles the denied call and releases the lock.
	await onPost(exec, { isError: true, content: [], error: { message: "denied" } }, makeNext({ kind: "accept" }));
	const third = await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }));
	assert.equal(third.kind, "allow", "post-execute must release the lock");
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: an ASK holds the lock, so an approved fixer stays serialized", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");
	const onExecute = handler("tools/execute");

	// First fixer call: the downstream chain returns a pending-approval ask.
	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	const asked = await onPre(exec, makeNext({ kind: "ask", reason: "please approve" }));
	assert.equal(asked.kind, "ask");
	assert.match(asked.reason ?? "", /please approve/);

	// CRITICAL: while the approval is pending, a second fixer must be DENIED.
	// dsh-tools does not re-run pre-execute after the approval upgrades
	// ask → allow (serviceAsk → dispatch), so the lock must survive the ask.
	const second = await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "deny", "the lock must be held through the approval window");

	// Approval granted → dispatch happens (execute runs) → finally releases.
	await onExecute(exec, makeNext({ isError: false, value: 1, content: [] }));

	// Gate reopens after the approved call completes.
	const third = await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }));
	assert.equal(third.kind, "allow", "gate must reopen after the approved fixer completes");
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: an ask that gets CANCELLED releases via post-execute", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");
	const onExecute = handler("tools/execute");

	const exec = fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" });
	assert.equal((await onPre(exec, makeNext({ kind: "ask", reason: "approve?" }))).kind, "ask");
	// lock held
	assert.equal((await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "deny");
	// user cancels the approval → post-result → post-execute releases
	await onPost(exec, { isError: true, content: [], error: { message: "approval cancelled" } }, makeNext({ kind: "accept" }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ kind: "allow" }))).kind, "allow");
	await onExecute(fakeExec(FIXER, "token-C", "session-C", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a downstream pre-execute THROW releases the lock AND rethrows", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	// First fixer call: a later pre-execute listener throws → our branch must
	// release the lock and rethrow (a throw bypasses execute AND post-execute).
	await assert.rejects(
		onPre(fakeExec(FIXER, "token-A", "session-A", { cwd: "/proj" }), throwingNext("downstream pre-execute exploded")),
		/downstream pre-execute exploded/
	);

	// Lock released → next fixer call is allowed.
	const second = await onPre(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "allow", "throw at the gate must not strand the lock");
	await onExecute(fakeExec(FIXER, "token-B", "session-B", { cwd: "/proj" }), makeNext({ isError: false, value: 1, content: [] }));
});

// ── TASK_ID protocol gate ───────────────────────────────────────────────────

test("protocol: a delegation without TASK_ID in the prompt is denied at the gate", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");

	const noId = await onPre(
		fakeExec(EXPLORER, "token-X", "session-A", { prompt: "Find the auth code." }),
		makeNext({ kind: "allow" })
	);
	assert.equal(noId.kind, "deny");
	assert.match(noId.reason, /TASK_ID/);
});

test("protocol: non-delegation tools are not subject to the TASK_ID gate", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const decision = await onPre({ name: "read", token: "token-R" }, makeNext({ kind: "allow" }));
	assert.equal(decision.kind, "allow");
});
