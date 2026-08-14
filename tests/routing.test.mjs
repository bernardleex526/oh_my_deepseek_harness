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
import { ROUTING_RULES, route, scoreTask, renderRoutingTable, hasExplicitTarget } from "../src/routing/policy.js";
import { assertRoutingRules } from "../src/config/schema.js";

test("routing rules are structurally valid", () => {
	assertRoutingRules(ROUTING_RULES);
	assert.ok(ROUTING_RULES.length >= 6, "one rule per specialist");
	const agents = new Set(ROUTING_RULES.map((r) => r.agent));
	assert.deepEqual([...agents].sort(), ["designer", "explorer", "fixer", "librarian", "observer", "oracle"].sort());
});

test("assertRoutingRules rejects empty and invalid-regex triggers at build time", () => {
	// empty English trigger
	assert.throws(
		() => assertRoutingRules([{ agent: "fixer", triggers: [""] }]),
		/routing rule "fixer"\.triggers: English trigger must be a non-empty string/
	);
	// unwrapped (invalid) regex trigger — would throw at match time today
	assert.throws(
		() => assertRoutingRules([{ agent: "fixer", triggers: ["("] }]),
		(err) => err instanceof TypeError && /not a valid regular expression/.test(err.message)
	);
	// empty CJK trigger
	assert.throws(
		() => assertRoutingRules([{ agent: "fixer", triggers: ["fix"], triggersZh: [""] }]),
		/routing rule "fixer"\.triggersZh: CJK trigger must be a non-empty string/
	);
	// an already-well-formed regex trigger is accepted without a label error
	assert.doesNotThrow(() => assertRoutingRules([{ agent: "fixer", triggers: ["fix"] }]));
});

test("§17: 'where' questions route to Explorer", () => {
	for (const task of [
		"Where is AuthService implemented?",
		"Which file contains the login logic?",
		"Find the call chain of getSession().",
		"How is the config file loaded?",
		"What existing pattern do we use in this repo?",
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
		"Take a screenshot of the login flow and describe what renders at runtime.",
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

test("§13: explicit-target fixes route to Fixer (no risk vocabulary)", () => {
	for (const task of [
		"Fix the off-by-one bug in pagination.ts: the boundary check was wrong.",
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

// §13 batch 5: hasExplicitTarget must not be fooled by URLs, version strings,
// or generic "bug in X" / "so that" phrasing (no file-like reference present).

test("§13: 'so that' / generic phrases are NOT explicit targets", () => {
	const decision = route("Fix it so that it works");
	assert.notEqual(decision.primary, "fixer", "so that must not make a target explicit");
	assert.equal(decision.primary, "explorer", "no other trigger matches → explorer fallback");
});

test("§13: 'bug in production' / 'issue in the project' are NOT explicit targets", () => {
	for (const task of [
		"Fix the bug in production",
		"Fix the issue in the project"
	]) {
		const decision = route(task);
		assert.notEqual(decision.primary, "fixer", task);
		assert.equal(decision.primary, "explorer", `${task} → only fixer matched, so fall back to explorer`);
	}
});

test("§13: URLs and bare version strings are NOT explicit targets", () => {
	const url = route("check https://example.com docs");
	assert.notEqual(url.primary, "fixer", "a URL must not count as a file target");
	assert.equal(url.primary, "explorer", "no trigger matched → explorer fallback");

	const ver = route("bump to v1.2");
	assert.notEqual(ver.primary, "fixer", "a version string must not count as a file target");
	assert.equal(ver.primary, "explorer", "no trigger matched → explorer fallback");
});

test("§13: file-like references keep explicit targets (including CJK)", () => {
	// English, fixed extension token
	assert.equal(route("Implement the caching layer in src/cache.js").primary, "fixer");
	// English, file:line
	assert.equal(route("Fix the off-by-one bug in pagination.ts: the boundary check was wrong.").primary, "fixer");
	// CJK, path separator
	assert.equal(route("修复 src/auth.js 的空指针问题").primary, "fixer");
});

test("§13: hasExplicitTarget rejects URLs that carry a known extension", () => {
	// A URL with a .js path must not be treated as a local file target.
	assert.equal(hasExplicitTarget("check https://example.com/script.js"), false, "URL path must not be explicit");
	assert.equal(hasExplicitTarget("Fix the bug in auth.js."), true, "sentence-final period must still parse as a file target");
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

test("scoreTask includes a numeric priority in every score", () => {
	const scored = scoreTask("Where is the auth implementation and which design pattern do we use?");
	assert.ok(scored.length >= 1);
	for (const s of scored) {
		assert.equal(typeof s.priority, "number", `${s.agent} priority`);
		assert.ok(Number.isFinite(s.priority), `${s.agent} priority is finite`);
	}
});

test("priority breaks score ties (higher priority sorts first)", () => {
	// "查找" (explorer) and "哪个方案" (oracle) each match exactly once → tie at 1.
	const scored = scoreTask("查找哪个方案");
	const oracle = scored.find((s) => s.agent === "oracle");
	const explorer = scored.find((s) => s.agent === "explorer");
	assert.ok(oracle && explorer, "both oracle and explorer must match a single trigger");
	assert.equal(oracle.score, 1);
	assert.equal(explorer.score, 1);
	assert.equal(scored[0].agent, "oracle", "oracle (priority 60) sorts above explorer (40)");
});

test("RISK GATE: risk vocabulary beats file target + fixer intent", () => {
	const decision = route("Implement a high-risk security architecture redesign in src/auth.js");
	assert.equal(decision.primary, "oracle");
	assert.ok(decision.candidates.some((c) => c.agent === "fixer"), "fixer is still a candidate");
});

test("fixer still wins for a clear, non-risk file-target fix", () => {
	const decision = route("Implement the caching layer in src/cache.js");
	assert.equal(decision.primary, "fixer");
});

test("中国输入（中文）按同一张表路由", () => {
	// 风险闸门：并发/安全/架构/权衡 → oracle，即使同时出现文件路径和"修复"。
	assert.equal(route("请修复 src/auth.js 的并发安全问题，需要先评估架构权衡").primary, "oracle");
	// 空指针不含 oracle 词 → fixer（显式文件目标）。
	assert.equal(route("修复 src/auth.js 的空指针问题").primary, "fixer");
	// Explorer：询问文件位置。
	assert.equal(route("这个项目里登录逻辑在哪个文件").primary, "explorer");
	// Librarian：官方文档。
	assert.equal(route("查一下 React 19 的官方文档").primary, "librarian");
	// Observer：运行时截图与渲染。
	assert.equal(route("看看运行时的截图渲染效果").primary, "observer");
	// Oracle：迁移方案的架构权衡。
	assert.equal(route("需要评估这个数据库迁移方案的架构权衡").primary, "oracle");
	// Designer：布局间距排版。
	assert.equal(route("首页布局的间距和排版不太好看").primary, "designer");
});

test("renderRoutingTable includes Chinese triggers", () => {
	const table = renderRoutingTable();
	assert.ok(table.includes("explorer"), "table has explorer row");
	assert.ok(table.includes("哪个文件"), "Chinese explorer trigger rendered");
	assert.ok(table.includes("权衡"), "Chinese oracle trigger rendered");
});
