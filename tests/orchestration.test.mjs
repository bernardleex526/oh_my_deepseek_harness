/**
 * Orchestration-row runtime mechanics tests: fail-closed boundary installation
 * and the single-writer guard around write-capable (Fixer) delegations.
 *
 * `src/orchestration/orchestration.mjs` is import-free (no DSH imports), so
 * plain node can import it directly and we drive its listeners with a minimal
 * FAKE Cordis ctx — no harness packages needed.
 *
 * The row's guard state (`writerLocks`) is a module-scope per-caller Map and is
 * therefore shared across every `apply()` call in this file. Each test that
 * takes a writer lock MUST drive the corresponding completion/error/deny/ask
 * path to release it (or use a distinct caller key so it cannot leak into the
 * next test), leaving the module state clean. The caller key is derived from
 * `exec.agent?.id`, so `fakeExec` lets a test pick a caller; the default
 * `"unknown"` bucket keeps all caller-less calls serialized with each other and
 * is used by the shared-state tests.
 *
 * @module multi-agent-orchestrator/tests/orchestration
 */

import test from "node:test";
import assert from "node:assert/strict";
import { apply, ORCHESTRATOR_ALLOW } from "../src/orchestration/orchestration.mjs";

const FIXER = "subagent_fixer";
const EXPLORER = "subagent_explorer";

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
 * A fake fixer exec with a stable token and an optional caller identity.
 * The caller key used by the guard is `agent?.id`, so callers map to distinct
 * locks (default: no agent → the shared `"unknown"` bucket).
 * @param {string} name - the tool name.
 * @param {string} token - a stable fake registry token.
 * @param {string} [callerId] - the caller agent id (undefined → "unknown").
 * @returns {{name: string, token: string, agent?: {id: string}}}
 */
function fakeExec(name, token, callerId) {
	return callerId === void 0
		? { name, token }
		: { name, token, agent: { id: callerId } };
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
	const exec = fakeExec(FIXER, "token-A");

	const decision = await onPre(exec, makeNext({ kind: "allow" }));
	assert.deepEqual(decision, { kind: "allow" });

	// release so the module state is clean for the next test
	const onExecute = handler("tools/execute");
	await onExecute(exec, makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a second concurrent fixer call is denied", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const first = fakeExec(FIXER, "token-A");
	const second = fakeExec(FIXER, "token-B");

	// first call allowed
	assert.equal((await onPre(first, makeNext({ kind: "allow" }))).kind, "allow");
	// second call while the first is in flight → deny
	const denied = await onPre(second, makeNext({ kind: "allow" }));
	assert.equal(denied.kind, "deny");
	assert.match(denied.reason, /single-writer/);

	// after the first completes, the gate allows again
	const onExecute = handler("tools/execute");
	await onExecute(first, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: non-fixer calls pass through and never disturb the lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	const fixerA = fakeExec(FIXER, "token-A");
	const explorer = fakeExec(EXPLORER, "token-X");

	// take the writer lock
	assert.equal((await onPre(fixerA, makeNext({ kind: "allow" }))).kind, "allow");

	// a non-fixer call is allowed AND does not clear the writer lock
	const explDecision = await onPre(explorer, makeNext({ kind: "allow" }));
	assert.equal(explDecision.kind, "allow");
	// driving the non-fixer call "through execute" must not clear the fixer lock
	await onExecute(explorer, makeNext({ isError: false, value: 1, content: [] }));

	// the fixer lock is still held: a second fixer call is still denied
	const second = await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "deny");

	// releasing the fixer lock via execute now works
	await onExecute(fixerA, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C"), makeNext({ isError: false, value: 1, content: [] }));
});

// ── single-writer guard: completion AND error clearing ─────────────────────

test("single-writer: the execute finally clears the lock on completion", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	const exec = fakeExec(FIXER, "token-A");
	assert.equal((await onPre(exec, makeNext({ kind: "allow" }))).kind, "allow");

	// already held → a second call denied
	assert.equal((await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }))).kind, "deny");

	// completion path: execute resolves normally → finally releases
	await onExecute(exec, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: the execute finally clears the lock on error path", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	const exec = fakeExec(FIXER, "token-A");
	assert.equal((await onPre(exec, makeNext({ kind: "allow" }))).kind, "allow");
	assert.equal((await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }))).kind, "deny");

	// error path: the dispatch `next()` throws → finally still releases the lock
	await assert.rejects(
		onExecute(exec, async () => {
			throw new Error("boom");
		}),
		/boom/
	);
	assert.equal((await onPre(fakeExec(FIXER, "token-C"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-C"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: post-execute fallback clears a lock stranded pre-dispatch", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");

	const exec = fakeExec(FIXER, "token-A");
	assert.equal((await onPre(exec, makeNext({ kind: "allow" }))).kind, "allow");

	// the call is cancelled between the gate and dispatch: post-execute fires
	// but tools/execute never runs. It must still release the lock.
	const postDecision = await onPost(exec, { isError: false, value: 1, content: [] }, makeNext({ kind: "accept" }));
	assert.equal(postDecision.kind, "accept");

	// gate is now open
	assert.equal((await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup via execute
	await handler("tools/execute")(fakeExec(FIXER, "token-B"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a denied (non-owner) call's post-execute never clears another's lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onPost = handler("tools/post-execute");

	const fixerA = fakeExec(FIXER, "token-A");
	assert.equal((await onPre(fixerA, makeNext({ kind: "allow" }))).kind, "allow");

	// B is denied at the gate (does not own the lock), but a real pipeline
	// would still fire its post-execute. It must NOT clear A's lock.
	const b = fakeExec(FIXER, "token-B");
	const denied = await onPre(b, makeNext({ kind: "allow" }));
	assert.equal(denied.kind, "deny");
	await onPost(b, { isError: true, content: [], error: { message: "denied" } }, makeNext({ kind: "accept" }));

	// A's lock is still held
	assert.equal((await onPre(fakeExec(FIXER, "token-C"), makeNext({ kind: "allow" }))).kind, "deny");

	// A completes via execute → released
	await handler("tools/execute")(fixerA, makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-C"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await handler("tools/execute")(fakeExec(FIXER, "token-C"), makeNext({ isError: false, value: 1, content: [] }));
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
	await onPre(fakeExec(EXPLORER, "token-X"), tracedNext);
	assert.equal(nextCalls, 1, "non-fixer call must delegate to next()");

	// first fixer → next called
	await onPre(fakeExec(FIXER, "token-A"), tracedNext);
	assert.equal(nextCalls, 2, "first fixer call must delegate to next()");

	// second fixer (denied) → next NOT called (short-circuit deny)
	const denied = await onPre(fakeExec(FIXER, "token-B"), tracedNext);
	assert.equal(denied.kind, "deny");
	assert.equal(nextCalls, 2, "denied call must not delegate to next()");

	// release via execute to keep the module state clean
	await handler("tools/execute")(fakeExec(FIXER, "token-A"), makeNext({ isError: false, value: 1, content: [] }));
});

// ── single-writer guard: pre-execute non-dispatch releases (strand fixes) ──

test("single-writer: a downstream pre-execute DENY releases the lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	// First fixer call: the (later listener / innermost) next() decides deny.
	const denied = await onPre(fakeExec(FIXER, "token-A"), makeNext({ kind: "deny", reason: "denied downstream" }));
	assert.equal(denied.kind, "deny");
	assert.equal(denied.reason, "denied downstream");

	// The lock must NOT have been stranded: a subsequent fixer call is allowed.
	const second = await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "allow", "deny at the gate must not strand the lock");
	// cleanup so no lock leaks across tests
	await onExecute(fakeExec(FIXER, "token-B"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a downstream pre-execute ASK releases the lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	// First fixer call: the downstream chain returns a pending-approval ask.
	const asked = await onPre(fakeExec(FIXER, "token-A"), makeNext({ kind: "ask", reason: "please approve" }));
	assert.equal(asked.kind, "ask");
	assert.match(asked.reason ?? "", /please approve/);

	// The lock must be released: an approval that later dispatches re-takes it,
	// and meanwhile a second independent fixer call must be allowed.
	const second = await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "allow", "ask at the gate must not strand the lock");
	await onExecute(fakeExec(FIXER, "token-B"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a downstream pre-execute THROW releases the lock AND rethrows", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	// First fixer call: a later pre-execute listener throws → our branch must
	// release the lock and rethrow.
	await assert.rejects(
		onPre(fakeExec(FIXER, "token-A"), throwingNext("downstream pre-execute exploded")),
		/downstream pre-execute exploded/
	);

	// Lock released → next fixer call is allowed.
	const second = await onPre(fakeExec(FIXER, "token-B"), makeNext({ kind: "allow" }));
	assert.equal(second.kind, "allow", "throw at the gate must not strand the lock");
	await onExecute(fakeExec(FIXER, "token-B"), makeNext({ isError: false, value: 1, content: [] }));
});

// ── single-writer guard: per-caller isolation ──────────────────────────────

test("single-writer: cross-caller isolation — caller B is allowed while caller A holds the lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");

	// Caller A takes its own lock.
	assert.equal((await onPre(fakeExec(FIXER, "token-A1", "session-A"), makeNext({ kind: "allow" }))).kind, "allow");

	// A second caller-A fixer call is denied (its key is held).
	const a2 = await onPre(fakeExec(FIXER, "token-A2", "session-A"), makeNext({ kind: "allow" }));
	assert.equal(a2.kind, "deny", "same-caller second call must be denied");

	// Caller B (different session id) has an INDEPENDENT key → allowed.
	const b = await onPre(fakeExec(FIXER, "token-B1", "session-B"), makeNext({ kind: "allow" }));
	assert.equal(b.kind, "allow", "different caller must not be blocked by caller A's lock");

	// B completes and releases only its own key.
	await onExecute(fakeExec(FIXER, "token-B1", "session-B"), makeNext({ isError: false, value: 1, content: [] }));

	// A's lock is untouched: a caller-A call is still denied.
	assert.equal((await onPre(fakeExec(FIXER, "token-A3", "session-A"), makeNext({ kind: "allow" }))).kind, "deny");

	// A completes → its key released.
	await onExecute(fakeExec(FIXER, "token-A1", "session-A"), makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-A4", "session-A"), makeNext({ kind: "allow" }))).kind, "allow");
	// cleanup
	await onExecute(fakeExec(FIXER, "token-A4", "session-A"), makeNext({ isError: false, value: 1, content: [] }));
});

test("single-writer: a non-owner caller B completion never clears caller A's lock", async () => {
	const { handler } = bootFakeCtx();
	const onPre = handler("tools/pre-execute");
	const onExecute = handler("tools/execute");
	const onPost = handler("tools/post-execute");

	// Caller A takes its lock.
	assert.equal((await onPre(fakeExec(FIXER, "token-A1", "session-A"), makeNext({ kind: "allow" }))).kind, "allow");

	// Caller B runs a call through execute and post-execute — must NOT clear A.
	const b = fakeExec(FIXER, "token-B1", "session-B");
	assert.equal((await onPre(b, makeNext({ kind: "allow" }))).kind, "allow");
	await onPost(b, { isError: false, value: 1, content: [] }, makeNext({ kind: "accept" }));
	await onExecute(b, makeNext({ isError: false, value: 1, content: [] }));

	// A's lock is still held.
	assert.equal((await onPre(fakeExec(FIXER, "token-A2", "session-A"), makeNext({ kind: "allow" }))).kind, "deny");

	// A completes → released.
	await onExecute(fakeExec(FIXER, "token-A1", "session-A"), makeNext({ isError: false, value: 1, content: [] }));
	assert.equal((await onPre(fakeExec(FIXER, "token-A3", "session-A"), makeNext({ kind: "allow" }))).kind, "allow");
	await onExecute(fakeExec(FIXER, "token-A3", "session-A"), makeNext({ isError: false, value: 1, content: [] }));
});
