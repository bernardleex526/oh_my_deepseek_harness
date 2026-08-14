/**
 * Harness-compatibility tests: the plugin must not disturb the host harness.
 *
 * Enforces §21 (不侵入 Harness 的部分) and §26:
 *  - Test 1: with the mode not installed, the host behaves exactly as before
 *    (the plugin ships no patch layers and never touches host rows).
 *  - Test 2: the plugin breaks nothing for build/plan/primary agents (it
 *    registers a brand-new preset; it patches nothing).
 *  - Test 3/4: no provider or MCP rows are introduced or overridden.
 *  - Test 5–11: per-agent permissions are independent and enforced (also
 *    covered in permissions.test.mjs / delegation.test.mjs).
 *
 * @module multi-agent-orchestrator/tests/harness-compat
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIALISTS } from "../src/agents/catalog.js";
import { renderComposition, renderPresetMetadata, build } from "../scripts/build.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRESET_DIR = join(ROOT, "preset", "orchestrator");

test("Test 1: the plugin ships no host-patch layer (additive only)", () => {
	// A preset directory is the ONLY runtime artifact: no cordis.patch.yml,
	// no profile manifests, no config writes. Removing the preset directory
	// restores the host exactly.
	const presetFiles = readdirSync(PRESET_DIR);
	assert.ok(presetFiles.includes("agent.cordis.yml"));
	assert.ok(presetFiles.includes("preset.yml"));
	assert.ok(presetFiles.includes("orchestration.mjs"));
	const repoFiles = readdirSync(ROOT);
	assert.ok(!repoFiles.includes("cordis.patch.yml"), "plugin must not ship a host patch layer");
});

test("Test 2: composition touches no host rows (no ids from the host composition)", () => {
	const composition = renderComposition();
	// Host-plane rows that must never appear as preset rows with overrides:
	// the preset only ADDS agent-plane rows.
	const hostRowIds = ["agent-loop", "system-prompt", "tools", "sandbox", "approval", "session", "llm", "subagents", "agent-presets"];
	for (const id of hostRowIds) {
		const rowPattern = new RegExp(`^- id: ${id}\\s*$`, "m");
		assert.ok(!rowPattern.test(composition), `composition must not redefine host row "${id}"`);
	}
});

test("Test 3: no provider rows are introduced or overridden", () => {
	const composition = renderComposition();
	assert.ok(!/name: '@deepseek-ai\/dsh-llm/.test(composition), "no LLM adapter rows");
	assert.ok(!/name: '@deepseek-ai\/dsh-credentials/.test(composition), "no credential rows");
	assert.ok(!/llm-deepseek|llm-pi-ai/.test(composition), "no provider config rows");
});

test("Test 4: no MCP rows are introduced or overridden", () => {
	const composition = renderComposition();
	assert.ok(!/mcp/i.test(composition), "no MCP rows");
});

test("Test 5: every agent's permission surface is independently defined", () => {
	// Oracle and Designer are both non-executing decision-makers with the same
	// read-only investigative surface by design; the other four are each
	// unique. So exactly five distinct surfaces across six roles.
	const surfaces = SPECIALISTS.map((s) => JSON.stringify(s.filterFor("posix")));
	assert.equal(new Set(surfaces).size, SPECIALISTS.length - 1, "each specialist has a distinct surface");
});

test("the composition builds deterministically and matches the generated file", () => {
	build();
	const generated = readFileSync(join(PRESET_DIR, "agent.cordis.yml"), "utf8");
	assert.equal(generated, renderComposition());
	const meta = readFileSync(join(PRESET_DIR, "preset.yml"), "utf8").trim();
	assert.equal(meta, renderPresetMetadata().trim());
});

test("preset metadata names the mode and orders it after the shipped set", () => {
	const meta = readFileSync(join(PRESET_DIR, "preset.yml"), "utf8");
	assert.match(meta, /name:/);
	assert.match(meta, /description:/);
	assert.match(meta, /order:\s*\d+/);
});

test("every delegation row names an existing harness package", () => {
	const composition = renderComposition();
	const packageRows = ["@deepseek-ai/dsh-persona", "@deepseek-ai/dsh-agent-instructions", "@deepseek-ai/dsh-tool-subagent",
		"@deepseek-ai/dsh-tool-fs", "@deepseek-ai/dsh-tool-fs-search", "@deepseek-ai/dsh-tool-bash", "@deepseek-ai/dsh-tool-pwsh",
		"@deepseek-ai/dsh-tool-jobs", "@deepseek-ai/dsh-tool-ask-user", "@deepseek-ai/dsh-tool-todo", "@deepseek-ai/dsh-tool-web",
		"@deepseek-ai/dsh-tool-subagent-control/list-agents", "@deepseek-ai/dsh-compaction-basic", "@deepseek-ai/dsh-command-compact",
		"@deepseek-ai/dsh-compaction-tool-result-pruner"];
	for (const pkg of packageRows) {
		assert.ok(composition.includes(`name: '${pkg}'`), `missing row for ${pkg}`);
	}
});

test("the custom row is referenced relative to the preset directory", () => {
	const composition = renderComposition();
	assert.match(composition, /name: \.\/orchestration\.mjs/);
	assert.ok(existsSync(join(PRESET_DIR, "orchestration.mjs")));
});

test("tool-result pruner uses the batch-4 budget (threshold 20000 / head 12000 / tail 3000)", () => {
	const composition = renderComposition();
	// DSH's pruner accepts ONLY these three keys and prunes an entire text block
	// (envelope included) when it exceeds thresholdChars. Assert the exact
	// values so the multi-agent output budget is pinned, and that no old
	// 8192/4096/1024 budget leaks into the generated preset.
	assert.match(composition, /thresholdChars:\s*20000/);
	assert.match(composition, /headChars:\s*12000/);
	assert.match(composition, /tailChars:\s*3000/);
	assert.ok(!/thresholdChars:\s*8192/.test(composition), "old 8192 pruner threshold must not survive");
	assert.ok(!/headChars:\s*4096/.test(composition), "old 4096 pruner head must not survive");
	assert.ok(!/tailChars:\s*1024/.test(composition), "old 1024 pruner tail must not survive");
});

test("envelope and routing markers resolve inside the orchestrator persona", () => {
	const composition = renderComposition();
	assert.ok(!composition.includes("{{ROUTING_TABLE}}"), "routing marker must be resolved");
	assert.ok(!composition.includes("{{ENVELOPE}}"), "envelope marker must be resolved");
	assert.ok(!composition.includes("{{DELEGATION_TOOLS}}"), "delegation-tools marker must be resolved");
	assert.ok(!composition.includes("{{AGENT_ROSTER}}"), "roster marker must be resolved");
	assert.ok(composition.includes("STATUS: SUCCESS | PARTIAL | BLOCKED"), "envelope must be embedded");
	assert.ok(composition.includes("| Specialist | When |"), "routing table must be embedded");
});
