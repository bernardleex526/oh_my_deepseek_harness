/**
 * Custom role registration tests (P2): roles.json is merged into LOCAL
 * builds as additional delegation rows with the same isolation guarantees,
 * while dist builds stay deterministic and never read it.
 *
 * @module multi-agent-orchestrator/tests/roles
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCustomRoles, customSpecialist, CUSTOM_ROLES_FILE, KNOWN_ROLES } from "../src/config/roles.js";
import { renderComposition } from "../scripts/build.mjs";
import { SUBAGENT_TOOLS } from "../src/permissions/agent-permissions.js";

const VALID = {
	pen_tester: {
		role: "information-producer",
		personaFile: "prompts/pen_tester.md",
		description: "安全审计角色",
		permissions: { read: ["read"], search: ["grep", "glob"], shell: true, web: true }
	}
};

/** Create a temp project root with an optional roles.json (+ persona file). */
function tempRoot(roles) {
	const dir = mkdtempSync(join(tmpdir(), "mao-roles-"));
	if (roles !== void 0) {
		writeFileSync(join(dir, CUSTOM_ROLES_FILE), JSON.stringify(roles), "utf8");
		mkdirSync(join(dir, "prompts"), { recursive: true });
		writeFileSync(join(dir, "prompts", "pen_tester.md"), "# Pen Tester\n\nRole prompt body.", "utf8");
	}
	return dir;
}

test("absent roles.json yields no custom roles", () => {
	const root = tempRoot(void 0);
	try {
		assert.deepEqual(loadCustomRoles(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("valid custom roles load with full specialist shape", () => {
	const root = tempRoot(VALID);
	try {
		const roles = loadCustomRoles(root);
		assert.equal(roles.length, 1);
		const r = roles[0];
		assert.equal(r.id, "pen_tester");
		assert.equal(r.toolName, "subagent_pen_tester");
		assert.equal(r.role, "information-producer");
		assert.equal(r.maxDepth, 1, "custom roles must be one-shot depth-1 like builtins");
		assert.equal(r.provider, "spawn");
		assert.ok(SUBAGENT_TOOLS.every((t) => t !== r.toolName), "custom toolName stays outside the builtin list");
		// filter shape matches the builtin convention
		const allow = r.filterFor("posix").allow;
		assert.ok(allow.includes("read"));
		assert.ok(allow.includes("grep"));
		assert.ok(allow.includes("bash"));
		assert.ok(allow.includes("web_search"));
		assert.ok(!allow.includes("write"), "custom roles never get write access unless declared");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("colliding ids are rejected (custom roles cannot shadow builtins)", () => {
	const root = tempRoot({ fixer: { role: "executor", personaFile: "p.md", description: "x" } });
	try {
		assert.throws(() => loadCustomRoles(root), /collides with a builtin/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid entries fail loudly", () => {
	const cases = [
		{ bad: { role: "wizard", personaFile: "p.md", description: "x" }, re: /role must be one of/ },
		{ bad: { role: "executor", description: "x" }, re: /personaFile is required/ },
		{ bad: { role: "executor", personaFile: "p.md" }, re: /description is required/ },
		{ bad: { role: "executor", personaFile: "p.md", description: "x", toolName: "wrong_name" }, re: /toolName must be/ },
		{ bad: { role: "executor", personaFile: "p.md", description: "x", permissions: { write: true } }, re: /unknown key "write"/ },
		{ bad: { role: "executor", personaFile: "p.md", description: "x", permissions: { read: "read" } }, re: /permissions\.read must be an array/ },
		{ bad: { role: "executor", personaFile: "p.md", description: "x", permissions: { shell: "yes" } }, re: /permissions\.shell must be a boolean/ },
		{ bad: { role: "executor", personaFile: "p.md", description: "x", maxDepth: 0 }, re: /maxDepth/ }
	];
	for (const { bad, re } of cases) {
		const root = tempRoot({ tester: bad });
		try {
			assert.throws(() => loadCustomRoles(root), re);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	// id format: hyphens produce an unregisterable delegation tool name
	assert.throws(() => customSpecialist("pen-tester", { role: "executor", personaFile: "p.md", description: "x" }), /snake_case/);
	assert.throws(() => customSpecialist("Bad Id!", { role: "executor", personaFile: "p.md", description: "x" }), /id "Bad Id!"/);
});

test("dist builds never read roles.json; local builds merge custom delegation rows", () => {
	const root = tempRoot(VALID);
	try {
		const dist = renderComposition(root, { readRoutes: false, readRoles: false });
		assert.ok(!dist.includes("subagent_pen_tester"), "dist must not emit custom rows");
		assert.ok(!dist.includes("CUSTOM SPECIALISTS"), "dist persona must not mention custom roles");

		const local = renderComposition(root, { readRoutes: true, readRoles: true });
		assert.ok(local.includes("subagent_pen_tester"), "local build must emit the custom row");
		assert.ok(local.includes("toolName: subagent_pen_tester"));
		assert.ok(local.includes("CUSTOM SPECIALISTS"), "local persona must announce custom roles");
		assert.ok(local.includes("Pen Tester"), "local build must inline the custom persona");
		// custom rows respect the same isolation config as builtins
		assert.ok(local.includes("maxDepth: 1"));
		assert.ok(local.includes("backgroundMode: one-shot"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("role vocabulary is the catalog's", () => {
	assert.deepEqual(KNOWN_ROLES, ["information-producer", "decision-maker", "executor"]);
});
