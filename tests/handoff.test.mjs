/**
 * Delegation handoff tests: the role-specific constraints in the delegation
 * prompt template and the TASK_ID protocol.
 *
 * Only Fixer may modify files; every other specialist is read-only. The
 * envelope template is present in every handoff so the Orchestrator can parse
 * the result uniformly, and every handoff declares a TASK_ID on its first
 * line (the broker keys budgets and envelope linkage on it).
 *
 * @module multi-agent-orchestrator/tests/handoff
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderDelegationPrompt, renderEnvelope, extractTaskId } from "../src/routing/handoff.js";

const READ_ONLY_AGENTS = ["explorer", "oracle", "designer", "librarian", "observer"];
const MAY_MODIFY = "You MAY modify files to complete the task";
const NO_MODIFY = "Do not modify any files.";
const TASK_ID = "t1";

test("fixer handoff authorizes modification and omits the no-modify line", () => {
	const prompt = renderDelegationPrompt({
		agent: "fixer",
		task: "Fix the bug in src/auth.js",
		taskId: TASK_ID,
		context: "Root cause is established.",
		constraints: "Acceptance criteria: all tests pass."
	});
	assert.ok(!prompt.includes(NO_MODIFY), "fixer must not be told not to modify files");
	assert.ok(prompt.includes(MAY_MODIFY), "fixer must be authorized to modify files");
	assert.ok(prompt.includes("STATUS"), "envelope present");
});

test("non-fixer handoffs keep the no-modify constraint", () => {
	for (const agent of READ_ONLY_AGENTS) {
		const prompt = renderDelegationPrompt({ agent, task: `Investigate the thing (${agent}).`, taskId: TASK_ID });
		assert.ok(prompt.includes(NO_MODIFY), `${agent} must be told not to modify files`);
		assert.ok(!prompt.includes(MAY_MODIFY), `${agent} must not be authorized to modify files`);
	}
});

test("every handoff embeds the standard envelope template", () => {
	const envelope = renderEnvelope();
	for (const agent of [...READ_ONLY_AGENTS, "fixer"]) {
		const prompt = renderDelegationPrompt({ agent, task: "task", taskId: TASK_ID });
		assert.ok(prompt.includes("STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE"), `${agent} envelope`);
		assert.ok(prompt.includes("SUMMARY:"), `${agent} envelope SUMMARY`);
		assert.ok(prompt.includes("EVIDENCE:"), `${agent} envelope EVIDENCE`);
		assert.ok(prompt.includes("UNCERTAINTIES:"), `${agent} envelope UNCERTAINTIES`);
	}
	assert.equal(typeof envelope, "string");
	assert.ok(envelope.includes("RECOMMENDED_NEXT_STEP:"));
	assert.ok(envelope.includes("TASK_ID:"), "envelope template must carry TASK_ID");
});

test("every handoff declares TASK_ID on its first line", () => {
	for (const agent of [...READ_ONLY_AGENTS, "fixer"]) {
		const prompt = renderDelegationPrompt({ agent, task: "task", taskId: TASK_ID });
		assert.ok(prompt.startsWith(`TASK_ID: ${TASK_ID}`), `${agent} must declare TASK_ID first`);
		assert.equal(extractTaskId(prompt), TASK_ID, `${agent} extractTaskId`);
	}
});

test("renderDelegationPrompt rejects an invalid task id", () => {
	assert.throws(() => renderDelegationPrompt({ agent: "explorer", task: "t", taskId: "not valid!" }), /taskId/);
	assert.throws(() => renderDelegationPrompt({ agent: "explorer", task: "t" }), /taskId/);
});

test("optional context and constraints are included when provided", () => {
	const prompt = renderDelegationPrompt({
		agent: "observer",
		task: "Read the log.",
		taskId: TASK_ID,
		context: "log.txt",
		constraints: "report only"
	});
	assert.ok(prompt.includes("KNOWN CONTEXT: log.txt"));
	assert.ok(prompt.includes("CONSTRAINTS: report only"));
});
