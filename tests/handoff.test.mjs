/**
 * Delegation handoff tests: the role-specific constraints in the delegation
 * prompt template.
 *
 * Only Fixer may modify files; every other specialist is read-only. The
 * envelope template is present in every handoff so the Orchestrator can parse
 * the result uniformly.
 *
 * @module multi-agent-orchestrator/tests/handoff
 */

import test from "node:test";
import assert from "node:assert/strict";
import { renderDelegationPrompt, renderEnvelope } from "../src/routing/handoff.js";

const READ_ONLY_AGENTS = ["explorer", "oracle", "designer", "librarian", "observer"];
const MAY_MODIFY = "You MAY modify files to complete the task";
const NO_MODIFY = "Do not modify any files.";

test("fixer handoff authorizes modification and omits the no-modify line", () => {
	const prompt = renderDelegationPrompt({
		agent: "fixer",
		task: "Fix the bug in src/auth.js",
		context: "Root cause is established.",
		constraints: "Acceptance criteria: all tests pass."
	});
	assert.ok(!prompt.includes(NO_MODIFY), "fixer must not be told not to modify files");
	assert.ok(prompt.includes(MAY_MODIFY), "fixer must be authorized to modify files");
	assert.ok(prompt.includes("STATUS"), "envelope present");
});

test("non-fixer handoffs keep the no-modify constraint", () => {
	for (const agent of READ_ONLY_AGENTS) {
		const prompt = renderDelegationPrompt({ agent, task: `Investigate the thing (${agent}).` });
		assert.ok(prompt.includes(NO_MODIFY), `${agent} must be told not to modify files`);
		assert.ok(!prompt.includes(MAY_MODIFY), `${agent} must not be authorized to modify files`);
	}
});

test("every handoff embeds the standard envelope template", () => {
	const envelope = renderEnvelope();
	for (const agent of [...READ_ONLY_AGENTS, "fixer"]) {
		const prompt = renderDelegationPrompt({ agent, task: "task" });
		assert.ok(prompt.includes("STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE"), `${agent} envelope`);
		assert.ok(prompt.includes("SUMMARY:"), `${agent} envelope SUMMARY`);
		assert.ok(prompt.includes("EVIDENCE:"), `${agent} envelope EVIDENCE`);
		assert.ok(prompt.includes("UNCERTAINTIES:"), `${agent} envelope UNCERTAINTIES`);
	}
	assert.equal(typeof envelope, "string");
	assert.ok(envelope.includes("RECOMMENDED_NEXT_STEP:"));
});

test("optional context and constraints are included when provided", () => {
	const prompt = renderDelegationPrompt({
		agent: "observer",
		task: "Read the log.",
		context: "log.txt",
		constraints: "report only"
	});
	assert.ok(prompt.includes("KNOWN CONTEXT: log.txt"));
	assert.ok(prompt.includes("CONSTRAINTS: report only"));
});
