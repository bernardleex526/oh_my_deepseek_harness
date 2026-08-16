/**
 * Build script: generate the installable agent preset under `preset/orchestrator/`.
 *
 * The preset is a self-contained DSH agent-preset directory:
 *
 *   preset/orchestrator/
 *   ├── agent.cordis.yml       (the composition, generated from src + prompts)
 *   ├── preset.yml             (display metadata)
 *   └── orchestration.mjs      (the boundary row, copied from src)
 *
 * Installation is a plain directory copy into `$DSH_HOME/.agent-presets/`.
 *
 * Run: node scripts/build.mjs
 *
 * @module multi-agent-orchestrator/scripts/build
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPECIALISTS } from "../src/agents/catalog.js";
import { AGENT_INSTRUCTIONS_MAX_BYTES, PRESET_ID, PRESET_METADATA } from "../src/config/defaults.js";
import { loadModelRouting } from "../src/config/model-routing.js";
import { loadCustomRoles } from "../src/config/roles.js";
import { loadOrchestratorPersona, loadSpecialistPersona } from "../src/config/loader.js";
import { shellTool } from "../src/permissions/agent-permissions.js";
import { assertAgentDefinition } from "../src/config/schema.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRESET_DIR = join(ROOT, "preset", PRESET_ID);

/** YAML-safe string: must not contain control chars; block scalars handle the rest. */
function blockScalar(text, indent) {
	const pad = " ".repeat(indent);
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	// Keep trailing newline semantics simple: literal block, no strip marker.
	return lines.map((line) => (line === "" ? "" : `${pad}${line}`)).join("\n");
}

/**
 * Render the toolFilter for one specialist as platform-conditional YAML.
 *
 * The `!!js` expression MUST be a quoted scalar: the loader parses
 * agent.cordis.yml with js-yaml's JSON_SCHEMA + the JsExpr type, and an
 * unquoted plain scalar containing `[`/`]`/`?` breaks plain-scalar parsing.
 * The expression uses single quotes inside, so double-quoted YAML works.
 * @param {object} specialist - the specialist definition.
 * @returns {string} YAML for `toolFilter`.
 */
function renderToolFilter(specialist) {
	const posix = specialist.filterFor("posix");
	const win32 = specialist.filterFor("win32");
	const same = JSON.stringify(posix.allow) === JSON.stringify(win32.allow);
	if (same) {
		return [
			"    toolFilter:",
			`      allow: ${JSON.stringify(posix.allow)}`
		].join("\n");
	}
	const expr = `process.platform === 'win32' ? ${JSON.stringify(win32.allow)} : ${JSON.stringify(posix.allow)}`;
	return [
		"    toolFilter:",
		`      allow: !!js "${expr.replaceAll('"', '\\"')}"`
	].join("\n");
}

/**
 * Render one delegation tool row.
 * @param {object} specialist - the specialist definition.
 * @param {string} persona - the specialist's system prompt.
 * @param {object} [modelRoute] - optional per-specialist agentOptions
 *   `{ provider, model, maxTokens }` from model-routing.json.
 * @returns {string} YAML row text.
 */
function renderDelegationRow(specialist, persona, modelRoute) {
	const lines = [
		`- id: tool-subagent-${specialist.id}`,
		"  name: '@deepseek-ai/dsh-tool-subagent'",
		"  config:",
		"    provider: spawn",
		`    toolName: ${specialist.toolName}`,
		"    enableRunInBackground: false",
		"    backgroundMode: one-shot",
		`    maxDepth: ${specialist.maxDepth}`,
		"    persona: |",
		blockScalar(persona, 10),
		renderToolFilter(specialist)
	];
	if (modelRoute !== void 0) {
		// provider/model are emitted as JSON double-quoted scalars: a model
		// name containing `: `, `#`, `[`, or other YAML-significant characters
		// must not be able to restructure the composition (JSON escaping is a
		// subset of YAML double-quoted escaping, so the round-trip is exact).
		lines.push("    agentOptions:",
			`      provider: ${JSON.stringify(modelRoute.provider)}`,
			`      model: ${JSON.stringify(modelRoute.model)}`,
			`      maxTokens: ${modelRoute.maxTokens}`);
	}
	return lines.join("\n");
}

/**
 * Determine the build mode from argv / env.
 *   `--local` on argv OR `BUILD_MODE=local` -> local build (reads model-routing.json)
 *   otherwise                               -> dist build (ships a clean preset; never
 *                                              reads model-routing.json, even if present
 *                                              locally)
 * @returns {"dist" | "local"}
 */
export function buildMode() {
	if (process.argv.includes("--local")) return "local";
	if (process.env.BUILD_MODE === "local") return "local";
	return "dist";
}

/**
 * Compose the full agent.cordis.yml text.
 * @param {string} [root] - project root directory.
 * @param {{readRoutes?: boolean, readRoles?: boolean}} [options] - if
 *   `readRoutes` is true the composition calls `loadModelRouting(root)` and
 *   if `readRoles` is true it calls `loadCustomRoles(root)` (both local
 *   mode); defaults to false so the default composition is the dist build
 *   (never emits agentOptions lines nor custom rows, even if
 *   model-routing.json / roles.json are present locally).
 * @returns {string} the composition YAML.
 */
export function renderComposition(root = ROOT, { readRoutes = false, readRoles = false } = {}) {
	const customRoles = readRoles ? loadCustomRoles(root) : [];
	const modelRoutes = readRoutes ? loadModelRouting(root, customRoles.map((s) => s.id)) : {};
	const specialists = readRoles ? [...SPECIALISTS, ...customRoles] : SPECIALISTS;
	let orchestratorPersona = loadOrchestratorPersona(ROOT);
	if (customRoles.length > 0) {
		const roster = customRoles.map((s) => `- \`${s.toolName}\` — ${s.description}`).join("\n");
		orchestratorPersona += `\n\n## CUSTOM SPECIALISTS\n\nThis build registers ${customRoles.length} additional custom specialist(s). Use them exactly like the builtin delegation tools (same TASK_ID protocol, same envelope, same budgets):\n\n${roster}\n`;
	}
	const rows = [];
	rows.push("# The `orchestrator` agent preset: multi-agent orchestration mode.");
	rows.push("#");
	rows.push("# GENERATED BY scripts/build.mjs — edit src/ and prompts/, then rebuild.");
	rows.push("#");
	rows.push("# The session agent is the Orchestrator (control plane). The six");
	rows.push("# specialist tools below spawn role-isolated subagents: each child gets");
	rows.push("# its own persona, its own toolFilter (compiled into tools.restrict()"),
	rows.push("# on the child's scope), and maxDepth 1, so a specialist can never");
	rows.push("# spawn another agent. The orchestration row narrows the root agent's");
	rows.push("# own tools at agent/created.");
	rows.push("");
	rows.push("# ── identity ────────────────────────────────────────────────────────");
	rows.push("");
	rows.push("- id: persona");
	rows.push("  name: '@deepseek-ai/dsh-persona'");
	rows.push("  config:");
	rows.push("    text: |");
	rows.push(blockScalar(orchestratorPersona, 6));
	rows.push("    complete: true");
	rows.push("");
	rows.push("- id: agent-instructions");
	rows.push("  name: '@deepseek-ai/dsh-agent-instructions'");
	rows.push("  config:");
	rows.push(`    maxBytes: ${AGENT_INSTRUCTIONS_MAX_BYTES}`);
	rows.push("");
	rows.push("# ── shell ───────────────────────────────────────────────────────────");
	rows.push("");
	rows.push("- id: tool-bash");
	rows.push("  name: '@deepseek-ai/dsh-tool-bash'");
	rows.push("  disabled: !!js process.platform === 'win32'");
	rows.push("");
	rows.push("- id: tool-pwsh");
	rows.push("  name: '@deepseek-ai/dsh-tool-pwsh'");
	rows.push("  disabled: !!js process.platform !== 'win32'");
	rows.push("");
	rows.push("# ── filesystem and search ───────────────────────────────────────────");
	rows.push("");
	rows.push("- id: tool-fs");
	rows.push("  name: '@deepseek-ai/dsh-tool-fs'");
	rows.push("");
	rows.push("- id: tool-fs-search");
	rows.push("  name: '@deepseek-ai/dsh-tool-fs-search'");
	rows.push("  config:");
	rows.push("    sampleOverCapGlobResults: false");
	rows.push("");
	rows.push("# ── background jobs ─────────────────────────────────────────────────");
	rows.push("");
	rows.push("- id: tool-jobs");
	rows.push("  name: '@deepseek-ai/dsh-tool-jobs'");
	rows.push("");
	rows.push("# ── model-facing rows ───────────────────────────────────────────────");
	rows.push("");
	rows.push("- id: tool-ask-user");
	rows.push("  name: '@deepseek-ai/dsh-tool-ask-user'");
	rows.push("");
	rows.push("- id: tool-todo");
	rows.push("  name: '@deepseek-ai/dsh-tool-todo'");
	rows.push("  config:");
	rows.push("    allowParallelInProgress: true");
	rows.push("");
	rows.push("- id: tool-web");
	rows.push("  name: '@deepseek-ai/dsh-tool-web'");
	rows.push("  config:");
	rows.push("    fetch: false");
	rows.push("    searchTimeoutMs: 60000");
	rows.push("");
	rows.push("# The child catalog tool: the Orchestrator can list its specialists.");
	rows.push("- id: tool-subagent-list-agents");
	rows.push("  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'");
	rows.push("");
	rows.push("# ── delegation: the builtin specialists (+ custom roles in local builds) ──");
	rows.push("");
	for (const specialist of specialists) {
		// Builtin personas resolve from the package root; custom roles'
		// personaFile is relative to the project root (where roles.json lives).
		const persona = loadSpecialistPersona(SPECIALISTS.includes(specialist) ? ROOT : root, specialist);
		const modelRoute = modelRoutes[specialist.id];
		rows.push(renderDelegationRow(specialist, persona, modelRoute));
		rows.push("");
	}
	rows.push("# ── control-plane boundary ──────────────────────────────────────────");
	rows.push("");
	rows.push("- id: orchestration");
	rows.push("  name: ./orchestration.mjs");
	rows.push("");
	rows.push("# ── compaction ──────────────────────────────────────────────────────");
	rows.push("");
	rows.push("- id: compaction");
	rows.push("  name: cordis:group");
	rows.push("  group: true");
	rows.push("  isolate:");
	rows.push("    compaction: true");
	rows.push("    toolResultPruner: true");
	rows.push("  config:");
	rows.push("    - id: compaction-basic");
	rows.push("      name: '@deepseek-ai/dsh-compaction-basic'");
	rows.push("");
	rows.push("    - id: command-compact");
	rows.push("      name: '@deepseek-ai/dsh-command-compact'");
	rows.push("");
	rows.push("    - id: tool-result-pruner");
	rows.push("      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'");
	rows.push("      config:");
	rows.push("        thresholdChars: 20000");
	rows.push("        headChars: 12000");
	rows.push("        tailChars: 3000");
	rows.push("");
	rows.push("# Budget rationale for the pruner values above:");
	rows.push("#   - A specialist's ENTIRE tool result (envelope + body) is pruned as one");
	rows.push("#     block when it exceeds thresholdChars, keeping the first headChars plus");
	rows.push("#     a fixed PRUNE_MARKER plus the last tailChars. 12000 + marker + 3000 fits");
	rows.push("#     20000, so the key evidence and the envelope's head stay intact.");
	rows.push("#   - DSH's pruner has NO field/exclusion mechanism (verified in");
	rows.push("#     dsh-compaction-tool-result-pruner lib/index.js:14-18, 42-43, 78-123): it");
	rows.push("#     cannot keep 'the envelope' and prune 'the body' separately. The envelope");
	rows.push("#     is therefore pruned WITH the whole result, which is why every specialist");
	rows.push("#     prompt instructs: keep SUMmary + envelope short and inside the head window,");
	rows.push("#     and prefer precise references over long pasted content.");
	rows.push("");
	return rows.join("\n");
}

/**
 * Render preset.yml (display metadata).
 * @returns {string} the metadata YAML.
 */
export function renderPresetMetadata() {
	const lines = [
		`name: ${PRESET_METADATA.name}`,
		`description: ${PRESET_METADATA.description}`,
		`order: ${PRESET_METADATA.order}`
	];
	return lines.join("\n");
}

/**
 * Validate and write the generated preset directory.
 * @returns {{written: string[], mode: "dist" | "local"}} paths written.
 */
export function build() {
	const mode = buildMode();
	for (const specialist of SPECIALISTS) {
		assertAgentDefinition(specialist, `specialist:${specialist.id}`);
	}
	if (mode === "local") {
		// Local builds validate custom roles too (roles.js already asserts
		// each definition; the merge is exercised end to end here).
		loadCustomRoles(ROOT);
	}
	mkdirSync(PRESET_DIR, { recursive: true });
	const compositionPath = join(PRESET_DIR, "agent.cordis.yml");
	const metadataPath = join(PRESET_DIR, "preset.yml");
	const rowPath = join(PRESET_DIR, "orchestration.mjs");
	const brokerPath = join(PRESET_DIR, "broker.mjs");
	const protocolPath = join(PRESET_DIR, "protocol.mjs");
	const artifactsPath = join(PRESET_DIR, "artifacts.mjs");
	// Dist builds never read model-routing.json/roles.json; local builds do.
	writeFileSync(compositionPath, renderComposition(ROOT, { readRoutes: mode === "local", readRoles: mode === "local" }), "utf8");
	writeFileSync(metadataPath, renderPresetMetadata() + "\n", "utf8");
	copyFileSync(join(ROOT, "src", "orchestration", "orchestration.mjs"), rowPath);
	copyFileSync(join(ROOT, "src", "orchestration", "broker.mjs"), brokerPath);
	copyFileSync(join(ROOT, "src", "orchestration", "protocol.mjs"), protocolPath);
	copyFileSync(join(ROOT, "src", "orchestration", "artifacts.mjs"), artifactsPath);
	return { written: [compositionPath, metadataPath, rowPath, brokerPath, protocolPath, artifactsPath], mode };
}

// Allow both `import { build }` (tests) and `node scripts/build.mjs`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { written, mode } = build();
	console.log(`built ${PRESET_ID} preset in ${mode.toUpperCase()} mode:`);
	for (const path of written) console.log(`  ${path}`);
}
