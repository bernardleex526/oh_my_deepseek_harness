/**
 * Validation script: proves the generated preset is loadable by the harness.
 *
 * What it checks:
 *  1. The composition parses as YAML with the loader's own dialect
 *     (JSON_SCHEMA extended with the `!!js` expression type) — the same
 *     dialect `dsh-agent-presets` discovery health-checks with.
 *  2. Every row is a named plugin row.
 *  3. Every package name resolves from the harness installation
 *     (`@deepseek-ai/*` packages under the DSH checkout) or is a `cordis:`
 *     builtin or a relative path inside the preset dir. Package metadata and
 *     every `@deepseek-ai/*` row's exported Cordis plugin are DEEP-checked.
 *  4. Every `toolFilter` name is a tool this preset actually registers
 *     (cross-checked against the row names + known tool packages).
 *  5. The preset metadata parses.
 *
 * This script FAILS (non-zero exit) when the DSH checkout is unavailable:
 * the deep package checks are essential, not optional. Run `npm install`
 * (installs @deepseek-ai/* as devDependencies under node_modules/@deepseek-ai)
 * and/or point DSH_CHECKOUT at an installed harness.
 *
 * Run: node scripts/validate.mjs [path-to-dsh-checkout]
 * The checkout path defaults to `node_modules/@deepseek-ai` next to the repo
 * root (i.e. the devDependency install); override it via the DSH_CHECKOUT
 * environment variable or a positional argument.
 *
 * @module multi-agent-orchestrator/scripts/validate
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { SPECIALISTS } from "../src/agents/catalog.js";
import { PRESET_ID } from "../src/config/defaults.js";
import { JOB_TOOLS, LIST_AGENTS_TOOL, ORCHESTRATOR_ALLOW, SHELL_TOOLS, SUBAGENT_TOOLS, TODO_TOOL, WEB_SEARCH_TOOL } from "../src/permissions/agent-permissions.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRESET_DIR = join(ROOT, "preset", PRESET_ID);
const COMPOSITION = join(PRESET_DIR, "agent.cordis.yml");
const METADATA = join(PRESET_DIR, "preset.yml");

/**
 * Default harness checkout: `node_modules/@deepseek-ai` in the repo root,
 * i.e. the location the devDependency install places the packages. Resolved
 * cross-platform via node:path so it works on both CI runners.
 */
const DEFAULT_CHECKOUT = join(resolve(ROOT), "node_modules", "@deepseek-ai");
const CHECKOUT = process.argv[2] ?? process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT;
const CHECKOUT_AVAILABLE = existsSync(join(CHECKOUT, "dsh-base"));

/** Load js-yaml from the harness checkout (the loader dialect lives there). */
function loadYaml() {
	const require = createRequire(import.meta.url);
	const candidates = [];
	if (CHECKOUT_AVAILABLE) candidates.push(join(CHECKOUT, "..", "js-yaml"));
	candidates.push("js-yaml"); // devDependency fallback (CI / npm consumers)
	for (const specifier of candidates) {
		try {
			const jsYaml = require(specifier);
			if (jsYaml !== void 0 && jsYaml.load !== void 0) return jsYaml;
		} catch {
			// try next candidate
		}
	}
	throw new Error("js-yaml not found (pass a DSH checkout path or install js-yaml as a devDependency)");
}

/** The loader's entry-list schema: JSON_SCHEMA + the `!!js` expression type. */
function entryListSchema(yaml) {
	const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
		kind: "scalar",
		resolve: (data) => typeof data === "string",
		construct: (data) => ({ __jsExpr: data })
	});
	return yaml.JSON_SCHEMA.extend(JsExpr);
}

/** Errors collected during validation. */
const errors = [];

function check(condition, message) {
	if (!condition) errors.push(message);
}

/** Package names that are not `@deepseek-ai/*` but are valid row names. */
const CORDIS_BUILTINS = new Set(["cordis:group", "cordis:include"]);

/** Known tool packages → tool names they register (subset used by filters). */
const TOOL_REGISTRY = {
	"@deepseek-ai/dsh-tool-fs": ["read", "read_image", "write", "edit"],
	"@deepseek-ai/dsh-tool-fs-search": ["grep", "glob"],
	"@deepseek-ai/dsh-tool-bash": ["bash"],
	"@deepseek-ai/dsh-tool-pwsh": ["pwsh"],
	"@deepseek-ai/dsh-tool-web": ["web_search", "web_fetch"],
	"@deepseek-ai/dsh-tool-ask-user": ["ask_user_question"],
	"@deepseek-ai/dsh-tool-todo": ["todo_write"],
	"@deepseek-ai/dsh-tool-jobs": JOB_TOOLS,
	"@deepseek-ai/dsh-tool-subagent-control/list-agents": [LIST_AGENTS_TOOL],
	"@deepseek-ai/dsh-tool-subagent": SUBAGENT_TOOLS
};

/**
 * Main validation.
 * @returns {Promise<number>} process exit code (0 = valid).
 */
export async function validate() {
	const yaml = loadYaml();
	const schema = entryListSchema(yaml);

	// 1. Composition parses in the loader dialect and is a row list.
	let rows;
	try {
		rows = yaml.load(readFileSync(COMPOSITION, "utf8"), { schema });
	} catch (error) {
		check(false, `agent.cordis.yml does not parse in the loader dialect: ${String(error)}`);
		return 1;
	}
	check(Array.isArray(rows), "agent.cordis.yml must be a top-level list of rows");

	// Collect every registered tool name from the composition.
	const registeredTools = new Set();
	const rowNames = new Map(); // id -> { name, config }
	if (Array.isArray(rows)) {
		for (const row of rows) {
			if (typeof row !== "object" || row === null || typeof row.name !== "string") {
				check(false, `row without a name: ${JSON.stringify(row)}`);
				continue;
			}
			if (typeof row.id !== "string") {
				check(false, `row without an id: ${JSON.stringify(row)}`);
				continue;
			}
			rowNames.set(row.id, row);
			const tools = TOOL_REGISTRY[row.name];
			if (tools !== void 0) for (const tool of tools) registeredTools.add(tool);
			// The custom orchestration row registers the broker_status tool.
			if (row.name === "./orchestration.mjs") registeredTools.add("broker_status");
			// Nested group rows also register tools.
			if (Array.isArray(row.config)) {
				for (const child of row.config) {
					if (typeof child !== "object" || child === null || typeof child.name !== "string") continue;
					const childTools = TOOL_REGISTRY[child.name];
					if (childTools !== void 0) for (const tool of childTools) registeredTools.add(tool);
				}
			}
		}
	}

	// 2. Every row name resolves (package exists in checkout, cordis builtin,
	//    or relative file inside the preset dir), and every package row's
	//    module actually exports a Cordis plugin (`apply`). When no DSH
	//    checkout is available (e.g. CI), the @deepseek-ai rows are checked
	//    structurally only: they must be scoped names under the harness scope.
	const moduleCache = new Map();
	const importModule = async (name) => {
		if (moduleCache.has(name)) return moduleCache.get(name);
		const promise = import(pathToFileURL(join(CHECKOUT, name, "lib/index.js")).href)
			.then((mod) => mod)
			.catch(() => void 0);
		moduleCache.set(name, promise);
		return promise;
	};
	let packageChecks = 0;
	for (const [id, row] of rowNames) {
		const { name } = row;
		if (CORDIS_BUILTINS.has(name)) continue;
		if (name.startsWith(".")) {
			const resolved = join(PRESET_DIR, name);
			check(existsSync(resolved), `row "${id}": relative module "${name}" not found at ${resolved}`);
			continue;
		}
		if (name.startsWith("@deepseek-ai/")) {
			if (!CHECKOUT_AVAILABLE) {
				// The deep package checks are essential, not optional: fail
				// loudly so CI cannot silently ship an unvalidated preset.
				check(false, `DSH checkout unavailable at "${CHECKOUT}" — run \`npm install\` (installs @deepseek-ai/* under node_modules/@deepseek-ai) or set DSH_CHECKOUT` );
				continue;
			}
			const packageName = name.slice("@deepseek-ai/".length).split("/")[0];
			const dir = join(CHECKOUT, packageName);
			check(existsSync(dir), `row "${id}": package "${name}" not found in checkout`);
			if (existsSync(dir)) {
				const mod = await importModule(packageName);
				check(mod !== void 0 && typeof mod.apply === "function",
					`row "${id}": package "${name}" does not export a Cordis plugin (apply)`);
				packageChecks += 1;
			}
			continue;
		}
		check(false, `row "${id}": unresolvable name "${name}"`);
	}

	// 3. Required rows exist.
	const requiredRows = [
		"persona",
		"agent-instructions",
		"tool-bash",
		"tool-pwsh",
		"tool-fs",
		"tool-fs-search",
		"tool-jobs",
		"tool-ask-user",
		"tool-todo",
		"tool-web",
		"tool-subagent-list-agents",
		"orchestration",
		"compaction",
		...SPECIALISTS.map((s) => `tool-subagent-${s.id}`)
	];
	for (const id of requiredRows) check(rowNames.has(id), `missing row "${id}"`);

	// 4. Every specialist row has a non-empty persona, a toolFilter whose
	//    names are all registered, and maxDepth 1.
	for (const specialist of SPECIALISTS) {
		const row = rowNames.get(`tool-subagent-${specialist.id}`);
		if (row === void 0) continue;
		const config = row.config ?? {};
		check(typeof config.persona === "string" && config.persona.length > 100,
			`${specialist.id}: persona missing or too short`);
		check(config.maxDepth === 1, `${specialist.id}: maxDepth must be 1 (got ${String(config.maxDepth)})`);
		check(config.provider === "spawn", `${specialist.id}: provider must be "spawn"`);
		check(config.enableRunInBackground === false, `${specialist.id}: enableRunInBackground must be false`);
		check(config.backgroundMode === "one-shot", `${specialist.id}: backgroundMode must be one-shot`);
		check(config.toolName === specialist.toolName, `${specialist.id}: toolName mismatch`);
		// Optional per-specialist model route: when present, all three fields
		// are required by the harness schema.
		if (config.agentOptions !== void 0) {
			check(typeof config.agentOptions.provider === "string" && config.agentOptions.provider.length > 0,
				`${specialist.id}: agentOptions.provider required`);
			check(typeof config.agentOptions.model === "string" && config.agentOptions.model.length > 0,
				`${specialist.id}: agentOptions.model required`);
			check(Number.isSafeInteger(config.agentOptions.maxTokens) && config.agentOptions.maxTokens >= 1,
				`${specialist.id}: agentOptions.maxTokens must be a positive integer`);
		}
		// toolFilter may be a quoted `!!js` expression node — extract tool
		// names from the expression source and from plain arrays.
		const filter = config.toolFilter;
		check(filter !== void 0 && filter !== null, `${specialist.id}: toolFilter missing`);
		if (filter !== void 0 && filter !== null) {
			const names = [];
			const collect = (value) => {
				if (typeof value === "string") names.push(value);
				else if (Array.isArray(value)) value.forEach(collect);
				else if (value !== null && typeof value === "object" && typeof value.__jsExpr === "string") {
					// The expression is `process.platform === 'win32' ? A : B`;
					// collect only the quoted array contents, not the literal.
					for (const token of value.__jsExpr.matchAll(/"([a-z_0-9]+)"/g)) names.push(token[1]);
				}
			};
			collect(filter.allow);
			for (const name of names) {
				check(registeredTools.has(name) || SHELL_TOOLS.includes(name),
					`${specialist.id}: toolFilter names unregistered tool "${name}"`);
			}
			check(!names.includes("write") || specialist.id === "fixer",
				`${specialist.id}: unexpected write access`);
			check(!names.includes("edit") || specialist.id === "fixer",
				`${specialist.id}: unexpected edit access`);
			check(!SUBAGENT_TOOLS.some((t) => names.includes(t)),
				`${specialist.id}: must not see delegation tools`);
		}
	}

	// 5. Orchestrator boundary: the allow list references only registered tools.
	for (const tool of ORCHESTRATOR_ALLOW) {
		check(registeredTools.has(tool) || TOOL_REGISTRY["@deepseek-ai/dsh-tool-subagent"].includes(tool),
			`orchestrator allow list names unregistered tool "${tool}"`);
	}

	// 6. Metadata parses.
	try {
		const meta = yaml.load(readFileSync(METADATA, "utf8"));
		check(typeof meta.name === "string" && meta.name.length > 0, "preset.yml: name missing");
		check(typeof meta.description === "string" && meta.description.length > 0, "preset.yml: description missing");
	} catch (error) {
		check(false, `preset.yml does not parse: ${String(error)}`);
	}

	// 7. orchestration.mjs exists in the preset dir, and the preset ships the
	//    sibling runtime modules it imports (broker + protocol). The preset
	//    directory has no node_modules, so these modules must only import
	//    siblings — never bare specifiers.
	check(existsSync(join(PRESET_DIR, "orchestration.mjs")), "preset dir missing orchestration.mjs");
	check(existsSync(join(PRESET_DIR, "broker.mjs")), "preset dir missing broker.mjs");
	check(existsSync(join(PRESET_DIR, "protocol.mjs")), "preset dir missing protocol.mjs");
	const rowSource = existsSync(join(PRESET_DIR, "orchestration.mjs"))
		? readFileSync(join(PRESET_DIR, "orchestration.mjs"), "utf8")
		: "";
	check(rowSource.includes('from "./broker.mjs"'), "orchestration.mjs must import ./broker.mjs");
	const brokerSource = existsSync(join(PRESET_DIR, "broker.mjs"))
		? readFileSync(join(PRESET_DIR, "broker.mjs"), "utf8")
		: "";
	check(brokerSource.includes('from "./protocol.mjs"'), "broker.mjs must import ./protocol.mjs");
	for (const [file, source] of [["orchestration.mjs", rowSource], ["broker.mjs", brokerSource], ["protocol.mjs", existsSync(join(PRESET_DIR, "protocol.mjs")) ? readFileSync(join(PRESET_DIR, "protocol.mjs"), "utf8") : ""]]) {
		check(!/^\s*import\s+.*\s+from\s+["'][^.]/m.test(source), `${file} must not import bare specifiers (preset dir has no node_modules)`);
	}

	if (errors.length > 0) {
		console.error(`validate: ${errors.length} problem(s) found:`);
		for (const error of errors) console.error(`  ✗ ${error}`);
		return 1;
	}
	console.log(`validate: OK — ${rowNames.size} rows, ${SPECIALISTS.length} specialists, all filters reference registered tools, ${packageChecks} packages deep-checked`);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	validate().then((code) => process.exit(code));
}
