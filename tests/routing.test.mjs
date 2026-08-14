/**
 * Routing policy tests: the Orchestrator's "who should do what" decisions.
 *
 * These encode §17 (Routing Policy) and §13 (决策 ≠ 执行) of the design doc:
 * investigation agents fire on their trigger vocabulary, and Fixer is only
 * routed to when the target is explicit.
 *
 * @module multi-agent-orchestrator/tests/routing
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ROUTING_RULES, route, scoreTask } from "../src/routing/policy.js";
import { assertRoutingRules } from "../src/config/schema.js";

test("routing rules are structurally valid", () => {
	assertRoutingRules(ROUTING_RULES);
	assert.ok(ROUTING_RULES.length >= 6, "one rule per specialist");
	const agents = new Set(ROUTING_RULES.map((r) => r.agent));
	assert.deepEqual([...agents].sort(), ["designer", "explorer", "fixer", "librarian", "observer", "oracle"].sort());
});

test("§17: 'where' questions route to Explorer", () => {
	for (const task of [
		"Where is AuthService implemented?",
		"Which file contains the login logic?",
		"Find the call chain of getSession().",
		"How is the config file loaded?",
		"What existing pattern do we use for API clients?",
		"Locate the tests for the billing module."
	]) {
		assert.equal(route(task).primary, "explorer", task);
	}
});

test("§17: documentation/library/API questions route to Librarian", () => {
	for (const task of [
		"What does the official React documentation say about useEffect?",
		"Which version of lodash is compatible with Node 22?",
		"What is the recommended usage of the OpenAI API for streaming?",
		"Check the changelog of our framework for breaking changes.",
		"Is this API deprecated in the latest release?"
	]) {
		assert.equal(route(task).primary, "librarian", task);
	}
});

test("§17: runtime/UI/test questions route to Observer", () => {
	for (const task of [
		"The app crashes at runtime — here is the log, what happens?",
		"Take a screenshot of the login page and describe the rendering.",
		"What does the test output say about the failing suite?",
		"Check the browser console for errors on this page.",
		"Does this bug reproduce when we run the app?"
	]) {
		assert.equal(route(task).primary, "observer", task);
	}
});

test("§17: architecture/tradeoff/security questions route to Oracle", () => {
	for (const task of [
		"There are two plausible solutions — which is better?",
		"Analyze the root cause of this deadlock.",
		"Weigh the tradeoffs of queue-based vs lock-based sync.",
		"Is this migration strategy sound?",
		"Review the security implications of this auth design.",
		"Explain why this race condition occurs."
	]) {
		assert.equal(route(task).primary, "oracle", task);
	}
});

test("§17: UI/UX/accessibility questions route to Designer", () => {
	for (const task of [
		"The login button looks misaligned — review the layout.",
		"What should the new settings page look like?",
		"Review spacing and typography on the dashboard.",
		"Check accessibility of the modal dialog.",
		"Is the mobile layout responsive?"
	]) {
		assert.equal(route(task).primary, "designer", task);
	}
});

test("§13: explicit-target fixes route to Fixer", () => {
	for (const task of [
		"Fix the off-by-one bug in pagination.ts: root cause is the boundary check.",
		"Implement the missing error handling in auth.ts as specified.",
		"Refactor the retry logic in client.js per the agreed design.",
		"Update the config schema to add the new field, tests included."
	]) {
		assert.equal(route(task).primary, "fixer", task);
	}
});

test("§13: vague bug reports do NOT route to Fixer (investigate first)", () => {
	for (const task of [
		"Something is broken, figure out what and fix it.",
		"There's a bug somewhere in the project, please handle it.",
		"Make the app better.",
		"Investigate and fix the issue."
	]) {
		const decision = route(task);
		assert.notEqual(decision.primary, "fixer", task);
		assert.ok(["explorer", "observer", "oracle"].includes(decision.primary), `${task} → ${decision.primary}`);
	}
});

test("scoreTask returns candidates sorted by score", () => {
	const scored = scoreTask("Where is the auth implementation and which design pattern do we use?");
	assert.ok(scored.length >= 1);
	for (let i = 1; i < scored.length; i += 1) {
		assert.ok(scored[i - 1].score >= scored[i].score);
	}
});

test("unknown/noise input falls back to a sane default", () => {
	const decision = route("please proceed");
	assert.equal(decision.primary, "explorer", "no-signal tasks investigate first");
	assert.ok(Array.isArray(decision.candidates));
});
