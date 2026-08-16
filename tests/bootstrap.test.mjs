/**
 * Anchored bootstrap unit tests: the pure config/phase logic fused from
 * dsh-anchored-standard — env parsing, durable-signal resume detection,
 * root-vs-child phase, and first-request context stripping.
 *
 * @module multi-agent-orchestrator/tests/bootstrap
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	parseBootstrapEnv,
	sessionHasDurableSignal,
	shouldBootstrapAgent,
	stripSuppressedContext,
	DEFAULT_BOOTSTRAP_ALLOW,
	BOOTSTRAP_SUPPRESSED_SOURCES,
	BOOTSTRAP_ENV
} from "../src/orchestration/bootstrap.mjs";

test("parseBootstrapEnv: absent / on / true → the default control-plane set", () => {
	const before = process.env[BOOTSTRAP_ENV];
	try {
		delete process.env[BOOTSTRAP_ENV];
		assert.deepEqual(parseBootstrapEnv(), DEFAULT_BOOTSTRAP_ALLOW);
		assert.deepEqual(parseBootstrapEnv("1"), DEFAULT_BOOTSTRAP_ALLOW);
		assert.deepEqual(parseBootstrapEnv("on"), DEFAULT_BOOTSTRAP_ALLOW);
		assert.deepEqual(parseBootstrapEnv("TRUE"), DEFAULT_BOOTSTRAP_ALLOW);
	} finally {
		if (before === void 0) delete process.env[BOOTSTRAP_ENV];
		else process.env[BOOTSTRAP_ENV] = before;
	}
});

test("parseBootstrapEnv: off values disable bootstrap", () => {
	for (const raw of ["0", "off", "false", "none"]) {
		assert.equal(parseBootstrapEnv(raw), null, `"${raw}" must disable`);
	}
});

test("parseBootstrapEnv: a JSON array becomes the custom tool list", () => {
	const list = ["read", "grep", "ask_user_question"];
	assert.deepEqual(parseBootstrapEnv(JSON.stringify(list)), list);
	assert.deepEqual(parseBootstrapEnv(JSON.stringify(["read", "read"])), ["read"], "duplicates collapse");
	// malformed / wrong shapes fall back to the safe default
	assert.deepEqual(parseBootstrapEnv("not json"), DEFAULT_BOOTSTRAP_ALLOW);
	assert.deepEqual(parseBootstrapEnv("[]"), DEFAULT_BOOTSTRAP_ALLOW);
	assert.deepEqual(parseBootstrapEnv('{"tools":[]}'), DEFAULT_BOOTSTRAP_ALLOW);
});

test("sessionHasDurableSignal scans the event log for tool/call or assistant/message", () => {
	assert.equal(sessionHasDurableSignal({ session: { events: [] } }), false);
	assert.equal(sessionHasDurableSignal({ session: { events: [{ type: "turn/start" }] } }), false);
	assert.equal(sessionHasDurableSignal({ session: { events: [{ type: "tool/call" }] } }), true);
	assert.equal(sessionHasDurableSignal({ session: { events: [{ type: "assistant/message" }] } }), true);
	assert.equal(sessionHasDurableSignal({ session: {} }), false);
	assert.equal(sessionHasDurableSignal({}), false);
});

test("shouldBootstrapAgent: fresh roots bootstrap, resumed roots and children do not", () => {
	const root = (events = []) => ({ session: { header: { parentSession: void 0 }, events } });
	const child = { session: { header: { parentSession: "root-1" }, events: [] } };
	assert.equal(shouldBootstrapAgent(root()), true, "fresh root session bootstraps");
	assert.equal(shouldBootstrapAgent(root([{ type: "turn/start" }])), true, "turn bookkeeping alone is not a signal");
	assert.equal(shouldBootstrapAgent(root([{ type: "tool/call" }])), false, "resumed session keeps the full catalog");
	assert.equal(shouldBootstrapAgent(root([{ type: "assistant/message" }])), false);
	assert.equal(shouldBootstrapAgent(child), false, "one-shot children never bootstrap");
});

test("stripSuppressedContext removes only automatic injection kinds", () => {
	const decision = {
		kind: "enter",
		messages: [
			{ type: "text", text: "user task", source: { kind: "user" } },
			{ type: "text", text: "digest", source: { kind: "agent-instructions" } },
			{ type: "text", text: "skills", source: { kind: "skill-catalog" } },
			{ type: "text", text: "gesture", source: { kind: "skill-invocation" } }
		]
	};
	const out = stripSuppressedContext(decision);
	assert.equal(out.messages.length, 2, "automatic injections stripped, user + explicit gestures kept");
	assert.deepEqual(out.messages.map((m) => m.source.kind), ["user", "skill-invocation"]);
	assert.ok(BOOTSTRAP_SUPPRESSED_SOURCES.includes("agent-instructions"));
});

test("stripSuppressedContext degrades to keeping everything on malformed input", () => {
	assert.deepEqual(stripSuppressedContext(null), null);
	assert.deepEqual(stripSuppressedContext({ kind: "reject" }), { kind: "reject" });
	assert.deepEqual(stripSuppressedContext({ kind: "enter" }), { kind: "enter" }, "no messages → untouched");
});
