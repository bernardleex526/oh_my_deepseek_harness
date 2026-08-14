/**
 * Permission-model tests: role isolation is mechanically enforced by the
 * per-agent tool filters (§19, §25, §26 Test 6–11).
 *
 * The harness compiles every specialist's `toolFilter` into
 * `tools.restrict()` on the child's OWN scope layer, so an allow list that
 * omits `write`/`edit`/`bash` makes those tools invisible — not merely
 * discouraged. These tests assert exactly that shape.
 *
 * @module multi-agent-orchestrator/tests/permissions
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SPECIALISTS } from "../src/agents/catalog.js";
import {
	ASK_USER_TOOL,
	JOB_TOOLS,
	LIST_AGENTS_TOOL,
	ORCHESTRATOR_ALLOW,
	SHELL_TOOLS,
	SUBAGENT_TOOLS,
	TODO_TOOL,
	WEB_SEARCH_TOOL,
	filterForAgent,
	shellTool
} from "../src/permissions/agent-permissions.js";

/** The tools the preset registers (the filterable universe). */
const REGISTERED = new Set([
	"read", "read_image", "write", "edit",
	"grep", "glob",
	...SHELL_TOOLS,
	"web_search", "web_fetch",
	ASK_USER_TOOL,
	TODO_TOOL,
	...JOB_TOOLS,
	LIST_AGENTS_TOOL,
	...SUBAGENT_TOOLS
]);

const WRITERS = ["write", "edit"];

test("every filter name is a tool the preset actually registers", () => {
	for (const specialist of SPECIALISTS) {
		const { allow } = specialist.filterFor("posix");
		for (const tool of allow) {
			assert.ok(REGISTERED.has(tool), `${specialist.id} allows unregistered tool "${tool}"`);
		}
	}
});

test("every specialist filter is an allow list (deny-by-default)", () => {
	for (const specialist of SPECIALISTS) {
		assert.ok(Array.isArray(specialist.filterFor("posix").allow));
		assert.equal(specialist.filterFor("posix").deny, void 0);
	}
});

test("Test 6: Explorer cannot write files", () => {
	const allow = filterForAgent("explorer").allow;
	for (const tool of WRITERS) assert.ok(!allow.includes(tool), `explorer allows "${tool}"`);
	assert.ok(allow.includes("read") && allow.includes("grep") && allow.includes("glob"));
});

test("Test 7: Librarian cannot modify code (web-only surface)", () => {
	const allow = filterForAgent("librarian").allow;
	assert.deepEqual(allow, [WEB_SEARCH_TOOL]);
	for (const tool of [...WRITERS, "read", "grep", "glob", ...SHELL_TOOLS]) {
		assert.ok(!allow.includes(tool), `librarian allows "${tool}"`);
	}
});

test("Test 8: Observer cannot modify code", () => {
	const allow = filterForAgent("observer").allow;
	for (const tool of WRITERS) assert.ok(!allow.includes(tool), `observer allows "${tool}"`);
	// Observer does need the runtime: shell + jobs + reads.
	assert.ok(allow.includes(shellTool()), "observer needs the platform shell");
	assert.ok(JOB_TOOLS.every((t) => allow.includes(t)));
});

test("Test 9: Fixer can modify code (and only Fixer has both write+edit)", () => {
	const fixer = filterForAgent("fixer").allow;
	for (const tool of WRITERS) assert.ok(fixer.includes(tool), `fixer lacks "${tool}"`);
	for (const specialist of SPECIALISTS) {
		if (specialist.id === "fixer") continue;
		const allow = specialist.filterFor("posix").allow;
		for (const tool of WRITERS) assert.ok(!allow.includes(tool), `${specialist.id} wrongly allows "${tool}"`);
	}
});

test("Test 10: Orchestrator may invoke the allowed subagents (and nothing mutating)", () => {
	for (const tool of SUBAGENT_TOOLS) {
		assert.ok(ORCHESTRATOR_ALLOW.includes(tool), `orchestrator lacks "${tool}"`);
	}
	for (const tool of [...WRITERS, ...SHELL_TOOLS, ...JOB_TOOLS]) {
		assert.ok(!ORCHESTRATOR_ALLOW.includes(tool), `orchestrator wrongly allows "${tool}"`);
	}
});

test("Test 11: no specialist surface includes any subagent tool", () => {
	for (const specialist of SPECIALISTS) {
		const allow = specialist.filterFor("posix").allow;
		for (const tool of SUBAGENT_TOOLS) {
			assert.ok(!allow.includes(tool), `${specialist.id} sees "${tool}"`);
		}
		assert.ok(!allow.includes(LIST_AGENTS_TOOL), `${specialist.id} sees list_agents`);
	}
});

test("shell tools are platform-aware (bash on POSIX, pwsh on Windows)", () => {
	assert.equal(shellTool("posix"), "bash");
	assert.equal(shellTool("win32"), "pwsh");
	const posixExplorer = filterForAgent("explorer", "posix").allow;
	const winExplorer = filterForAgent("explorer", "win32").allow;
	assert.ok(posixExplorer.includes("bash") && !posixExplorer.includes("pwsh"));
	assert.ok(winExplorer.includes("pwsh") && !winExplorer.includes("bash"));
});

test("role matrix matches the design doc §19 table", () => {
	// information producers never write
	for (const id of ["explorer", "librarian", "observer"]) {
		for (const tool of WRITERS) assert.ok(!filterForAgent(id).allow.includes(tool), `${id} writes`);
	}
	// decision makers never write; Designer has limited shell, Oracle none
	for (const id of ["oracle", "designer"]) {
		for (const tool of WRITERS) assert.ok(!filterForAgent(id).allow.includes(tool), `${id} writes`);
	}
	assert.ok(!filterForAgent("oracle").allow.includes(shellTool()), "oracle has no shell");
	assert.ok(filterForAgent("designer").allow.includes(shellTool()), "designer has limited shell");
	// executor is the only writer
	assert.ok(filterForAgent("fixer").allow.includes("write"));
});

test("per-agent surfaces are pairwise distinct (no role collapse)", () => {
	const seen = new Set();
	for (const specialist of SPECIALISTS) {
		const key = specialist.filterFor("posix").allow.join(",");
		assert.ok(!seen.has(key), `${specialist.id} duplicates another role's surface`);
		seen.add(key);
	}
});
