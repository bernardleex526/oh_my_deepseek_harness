/**
 * Broker unit tests: the mechanical multi-agent runtime state
 * (workspace-keyed writer lock, per-task budgets, envelope gate, result
 * store) — all import-free, no harness packages needed.
 *
 * @module multi-agent-orchestrator/tests/broker
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
	createBroker,
	normalizeWorkspace,
	callerWorkspace,
	sessionKey,
	isDelegationTool,
	specialistId,
	FIXER_DELEGATION,
	DEFAULT_BUDGETS
} from "../src/orchestration/broker.mjs";

const FIXER = FIXER_DELEGATION;
const EXPLORER = "subagent_explorer";

/** A minimal fake execution object. */
function exec(name, token, { caller = "session-A", cwd, prompt = "TASK_ID: t1\nDo it." } = {}) {
	const agent = { id: caller };
	if (cwd !== void 0) agent.session = { header: { cwd } };
	return { name, token, agent, arguments: { prompt } };
}

/** Run a full pre-execute gate → dispatch → settle round for one call. */
function roundTrip(broker, e, { isError = false, text = "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: done." } = {}) {
	const gate = broker.gate(e);
	if (!gate.ok) return { gate };
	broker.markDispatched(e);
	return { gate, settled: broker.settle(e, { text, isError }) };
}

// ── workspace normalization ────────────────────────────────────────────────

test("normalizeWorkspace collapses separators, case and trailing slashes", () => {
	assert.equal(normalizeWorkspace("C:\\Proj\\App\\"), "c:/proj/app");
	assert.equal(normalizeWorkspace("c:/proj/app"), "c:/proj/app");
	assert.equal(normalizeWorkspace("/proj/app///"), "/proj/app");
	assert.equal(normalizeWorkspace(""), null);
	assert.equal(normalizeWorkspace(undefined), null);
});

test("callerWorkspace prefers the session cwd, falls back to caller id, then unknown", () => {
	assert.equal(callerWorkspace(exec(FIXER, "t", { cwd: "C:\\Proj\\App\\" })), "c:/proj/app");
	assert.equal(callerWorkspace(exec(FIXER, "t", { caller: "sess-1" })), "sess-1");
	assert.equal(callerWorkspace({ name: FIXER, token: "t" }), "unknown");
});

test("sessionKey is the caller agent id", () => {
	assert.equal(sessionKey(exec(FIXER, "t")), "session-A");
	assert.equal(sessionKey({ name: FIXER, token: "t" }), "unknown");
});

test("isDelegationTool / specialistId classify the subagent family", () => {
	assert.ok(isDelegationTool(EXPLORER));
	assert.ok(isDelegationTool(FIXER));
	assert.ok(!isDelegationTool("read"));
	assert.equal(specialistId(FIXER), "fixer");
	assert.equal(specialistId("read"), "read");
});

// ── writer lock ────────────────────────────────────────────────────────────

test("writer lock is per workspace and ownership-scoped", () => {
	const broker = createBroker();
	const a = exec(FIXER, "token-A", { cwd: "/proj/app" });
	const b = exec(FIXER, "token-B", { cwd: "/proj/other" });
	const a2 = exec(FIXER, "token-A2", { cwd: "/proj/app" });

	assert.deepEqual(broker.gate(a), { ok: true });
	assert.ok(broker.isWriterLocked("/proj/app"));
	// same workspace, different token → denied
	assert.equal(broker.gate(a2).ok, false);
	assert.match(broker.gate(a2).reason, /single-writer/);
	// different workspace → allowed
	assert.deepEqual(broker.gate(b), { ok: true });
	// a non-owner completion cannot release the workspace lock
	broker.releaseWriter(a2);
	assert.ok(broker.isWriterLocked("/proj/app"), "non-owner must not release");
	broker.releaseWriter(a);
	assert.ok(!broker.isWriterLocked("/proj/app"), "owner releases");
});

// ── TASK_ID protocol gate ──────────────────────────────────────────────────

test("gate denies delegations whose prompt declares no TASK_ID", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t", { prompt: "Find the auth code." });
	const gate = broker.gate(e);
	assert.equal(gate.ok, false);
	assert.match(gate.reason, /TASK_ID/);
});

test("gate passes non-delegation tools untouched", () => {
	const broker = createBroker();
	assert.deepEqual(broker.gate({ name: "read", token: "t" }), { ok: true });
});

// ── budgets ────────────────────────────────────────────────────────────────

test("delegation budget caps total delegations per TASK_ID", () => {
	const broker = createBroker({ maxDelegationsPerTask: 2 });
	const e1 = roundTrip(broker, exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	const e2 = roundTrip(broker, exec(EXPLORER, "t2", { prompt: "TASK_ID: t1\nFind y." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	assert.equal(e1.gate.ok, true);
	assert.equal(e2.gate.ok, true);
	const third = broker.gate(exec(EXPLORER, "t3", { prompt: "TASK_ID: t1\nFind z." }));
	assert.equal(third.ok, false);
	assert.match(third.reason, /budget exhausted/);
	// a NEW task id resets the budget
	assert.equal(broker.gate(exec(EXPLORER, "t4", { prompt: "TASK_ID: t2\nFind z." })).ok, true);
});

test("a new TASK_ID resets per-task counters", () => {
	const broker = createBroker({ maxDelegationsPerTask: 1 });
	// consume t1's single delegation (budget counts at settle)
	const first = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nA" });
	assert.equal(broker.gate(first).ok, true);
	broker.markDispatched(first);
	broker.settle(first, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.", isError: false });
	assert.equal(broker.gate(exec(EXPLORER, "t2", { prompt: "TASK_ID: t1\nB" })).ok, false, "t1 exhausted");
	assert.equal(broker.gate(exec(EXPLORER, "t3", { prompt: "TASK_ID: t2\nC" })).ok, true, "t2 fresh");
});

test("retry budget caps attempts per specialist per task", () => {
	const broker = createBroker({ maxAttemptsPerSpecialist: 2 });
	const mk = (token) => exec(EXPLORER, token, { prompt: "TASK_ID: t1\nFind x." });
	const ok = (token) => roundTrip(broker, mk(token), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	assert.equal(ok("a1").gate.ok, true);
	assert.equal(ok("a2").gate.ok, true);
	const third = broker.gate(mk("a3"));
	assert.equal(third.ok, false);
	assert.match(third.reason, /retry budget exhausted/);
	// other specialists on the same task are unaffected
	assert.equal(broker.gate(exec("subagent_oracle", "a4", { prompt: "TASK_ID: t1\nWhy?" })).ok, true);
});

test("consecutive non-SUCCESS results hard-stop the task", () => {
	const broker = createBroker({ maxConsecutiveFailures: 2 });
	const mk = (token, prompt) => exec(EXPLORER, token, { prompt: `TASK_ID: t1\n${prompt}` });
	// two failures
	roundTrip(broker, mk("f1", "A"), { text: "TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: nope." });
	roundTrip(broker, mk("f2", "B"), { text: "TASK_ID: t1\nSTATUS: PARTIAL\nSUMMARY: partly." });
	const gate = broker.gate(mk("f3", "C"));
	assert.equal(gate.ok, false);
	assert.match(gate.reason, /consecutive non-SUCCESS/);
});

test("a SUCCESS resets the consecutive-failure counter", () => {
	const broker = createBroker({ maxConsecutiveFailures: 2 });
	const mk = (token, prompt) => exec(EXPLORER, token, { prompt: `TASK_ID: t1\n${prompt}` });
	roundTrip(broker, mk("f1", "A"), { text: "TASK_ID: t1\nSTATUS: BLOCKED\nSUMMARY: nope." });
	roundTrip(broker, mk("s1", "B"), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok." });
	// counter reset → still allowed
	assert.equal(broker.gate(mk("f2", "C")).ok, true);
});

// ── settle / envelope gate ─────────────────────────────────────────────────

test("settle records dispatched attempts and stores results", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found it.\nFINDINGS: src/a.js:1", isError: false });
	assert.equal(outcome.decision.kind, "accept");
	assert.equal(outcome.recorded.status, "SUCCESS");
	const snap = broker.snapshot("session-A");
	assert.equal(snap.tasks.length, 1);
	assert.equal(snap.tasks[0].delegationsUsed, 1);
	assert.equal(snap.tasks[0].attempts[EXPLORER], 1);
	assert.equal(snap.tasks[0].results[0].summary, "found it.");
	assert.equal(snap.tasks[0].consecutiveFailures, 0);
});

test("settle ignores calls that never dispatched (gate denials)", () => {
	const broker = createBroker();
	// gate denies (no TASK_ID)
	const e = exec(EXPLORER, "t1", { prompt: "no id" });
	broker.gate(e);
	// a real pipeline still fires post-execute for the denied call
	const outcome = broker.settle(e, { text: "Error: denied", isError: true });
	assert.equal(outcome.decision.kind, "accept");
	assert.equal(outcome.recorded, null);
	assert.deepEqual(broker.snapshot("session-A").tasks, []);
});

test("settle passes real tool errors through but counts the attempt", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "Error: provider timeout", isError: true });
	assert.equal(outcome.decision.kind, "accept", "real tool errors are already visible; do not double-block");
	const snap = broker.snapshot("session-A");
	assert.equal(snap.tasks[0].results[0].status, "ERROR");
	assert.equal(snap.tasks[0].consecutiveFailures, 1);
});

test("envelope gate blocks a result without STATUS", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "TASK_ID: t1\nSUMMARY: no status here", isError: false });
	assert.equal(outcome.decision.kind, "block");
	assert.match(outcome.decision.feedback[0].text, /missing STATUS/);
	// the failed protocol attempt still counts (consumed delegation)
	assert.equal(broker.snapshot("session-A").tasks[0].consecutiveFailures, 1);
});

test("envelope gate blocks a TASK_ID mismatch between prompt and envelope", () => {
	const broker = createBroker();
	const e = exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." });
	broker.gate(e);
	broker.markDispatched(e);
	const outcome = broker.settle(e, { text: "TASK_ID: t9\nSTATUS: SUCCESS\nSUMMARY: done.", isError: false });
	assert.equal(outcome.decision.kind, "block");
	assert.match(outcome.decision.feedback[0].text, /TASK_ID mismatch/);
});

test("envelope gate blocks SUCCESS without the role's required evidence", () => {
	const broker = createBroker();
	// fixer SUCCESS must carry CHANGES + VERIFICATION
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	const outcome = broker.settle(fix, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: fixed.", isError: false });
	assert.equal(outcome.decision.kind, "block");
	assert.match(outcome.decision.feedback[0].text, /CHANGES/);
	assert.match(outcome.decision.feedback[0].text, /VERIFICATION/);

	// observer SUCCESS must carry OBSERVED
	const obs = exec("subagent_observer", "t2", { prompt: "TASK_ID: t1\nObserve." });
	broker.gate(obs);
	broker.markDispatched(obs);
	const obsOutcome = broker.settle(obs, { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: saw things.", isError: false });
	assert.equal(obsOutcome.decision.kind, "block");
	assert.match(obsOutcome.decision.feedback[0].text, /OBSERVED/);
});

test("envelope gate ACCEPTS a complete fixer SUCCESS with CHANGES + VERIFICATION", () => {
	const broker = createBroker();
	const fix = exec(FIXER, "t1", { prompt: "TASK_ID: t1\nFix it." });
	broker.gate(fix);
	broker.markDispatched(fix);
	const outcome = broker.settle(fix, {
		text: [
			"TASK_ID: t1",
			"STATUS: SUCCESS",
			"SUMMARY: fixed the bug",
			"CHANGES:",
			"  src/a.js: corrected the check",
			"VERIFICATION:",
			"  npm test: 12 passed",
			"EVIDENCE: git diff src/a.js",
			"UNCERTAINTIES: none",
			"RECOMMENDED_NEXT_STEP: run the full suite"
		].join("\n"),
		isError: false
	});
	assert.equal(outcome.decision.kind, "accept", `unexpected block: ${outcome.decision.kind === "block" ? outcome.decision.feedback[0].text : ""}`);
	assert.equal(broker.snapshot("session-A").tasks[0].results[0].status, "SUCCESS");
});

// ── observability ──────────────────────────────────────────────────────────

test("report renders per-task budget state and empty state", () => {
	const broker = createBroker();
	assert.match(broker.report("session-A"), /no delegations recorded/);
	roundTrip(broker, exec(EXPLORER, "t1", { prompt: "TASK_ID: t1\nFind x." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: found." });
	const report = broker.report("session-A");
	assert.match(report, /task "t1"/);
	assert.match(report, new RegExp(String(DEFAULT_BUDGETS.maxDelegationsPerTask)));
	assert.match(report, new RegExp(EXPLORER));
});

test("reset clears all broker state", () => {
	const broker = createBroker();
	roundTrip(broker, exec(FIXER, "t1", { cwd: "/proj", prompt: "TASK_ID: t1\nFix." }), { text: "TASK_ID: t1\nSTATUS: SUCCESS\nSUMMARY: ok.\nCHANGES:\n  a: b\nVERIFICATION:\n  t: pass" });
	broker.reset();
	assert.deepEqual(broker.snapshot("session-A").tasks, []);
	assert.ok(!broker.isWriterLocked("/proj"));
	assert.deepEqual(broker.gate(exec(FIXER, "t2", { cwd: "/proj", prompt: "TASK_ID: t1\nFix." })), { ok: true });
});
