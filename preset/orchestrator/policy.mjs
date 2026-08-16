/**
 * Routing policy for the Orchestrator (§17 of the design doc).
 *
 * A pure, testable model of when to delegate to which specialist. The same
 * table is rendered into the Orchestrator's system prompt by the build script
 * (`renderRoutingTable()`), so the code, the prompt, and the tests share one
 * source of truth.
 *
 * This module lives under `src/orchestration/` (not `src/routing/`) because
 * it is COPIED into the preset directory as `policy.mjs` and used at runtime
 * by the `broker_route` tool: the Orchestrator can query the same routing
 * model its prompt embeds. `src/routing/policy.js` is a backward-compatible
 * re-export shim.
 *
 * IMPORT-FREE: copied into the preset directory (no node_modules).
 *
 * @module multi-agent-orchestrator/orchestration/policy
 */

/**
 * One routing rule: a specialist plus the trigger phrases that route to it.
 * `priority` breaks ties (higher first); rules are evaluated in order.
 *
 * `triggers` holds ASCII/English phrase patterns; `triggersZh` holds CJK
 * substrings matched literally (no word boundaries — CJK has no word breaks).
 *
 * @type {Array<{agent: string, triggers: string[], triggersZh?: string[], priority?: number, note?: string}>}
 */
export const ROUTING_RULES = [
	{
		agent: "explorer",
		priority: 40,
		triggers: [
			"where is",
			"which file",
			"find",
			"locate",
			"implemented",
			"implementation",
			"call chain",
			"call graph",
			"callers",
			"repository structure",
			"project structure",
			"existing pattern",
			"current configuration",
			"config file",
			"how does .* work",
			"what files",
			"symbol",
			"function signature",
			"dependency usage",
			"module relationship",
			"code search",
			"investigate"
		],
		triggersZh: [
			"查找",
			"定位",
			"哪个文件",
			"在哪个文件",
			"实现",
			"调用链",
			"仓库结构",
			"代码结构",
			"现有模式"
		],
		note: "内部事实：文件、符号、调用关系、结构、已有模式"
	},
	{
		agent: "librarian",
		priority: 40,
		triggers: [
			"documentation",
			"official docs",
			"third-party",
			"library",
			"framework behavior",
			"framework",
			"upstream",
			"api",
			"version compatibility",
			"compatible",
			"release notes",
			"changelog",
			"standards",
			"recommended usage",
			"how to use",
			"latest version",
			"deprecated"
		],
		triggersZh: [
			"文档",
			"官方",
			"第三方库",
			"API",
			"版本",
			"上游",
			"标准"
		],
		note: "外部知识：官方文档、第三方库、API、版本、标准"
	},
	{
		agent: "observer",
		priority: 40,
		triggers: [
			"screenshot",
			"runtime behavior",
			"at runtime",
			"ui rendering",
			"renders",
			"test output",
			"test result",
			"console",
			"network behavior",
			"logs",
			"log file",
			"reproduce",
			"reproduction",
			"run the app",
			"run the tests",
			"browser",
			"error message",
			"crash",
			"stack trace",
			"verify"
		],
		triggersZh: [
			"运行时",
			"截图",
			"日志",
			"测试输出",
			"控制台",
			"渲染",
			"UI 渲染",
			"界面"
		],
		note: "运行事实：程序、UI、日志、截图、测试输出"
	},
	{
		agent: "oracle",
		priority: 60,
		triggers: [
			"root cause",
			"multiple solutions",
			"which approach",
			"which is better",
			"better approach",
			"plausible",
			"tradeoffs?",
			"trade-offs",
			"architecture",
			"concurrency",
			"race condition",
			"deadlock",
			"consistency",
			"distributed",
			"database design",
			"security",
			"performance",
			"migration strategy",
			"complex",
			"high-risk",
			"reasoning",
			"design decision",
			"deep analysis"
		],
		triggersZh: [
			"根因",
			"权衡",
			"架构",
			"并发",
			"安全",
			"性能",
			"迁移",
			"风险",
			"哪个方案",
			"哪个更好",
			"取舍"
		],
		note: "深度推理：根因、架构、并发、安全、性能、权衡"
	},
	{
		agent: "designer",
		priority: 50,
		triggers: [
			"ui",
			"ux",
			"layout",
			"spacing",
			"typography",
			"responsive",
			"interaction",
			"accessibility",
			"visual",
			"design",
			"component consistency",
			"information architecture",
			"usability",
			"looks",
			"look like",
			"style",
			"styling",
			"page"
		],
		triggersZh: [
			"布局",
			"间距",
			"排版",
			"响应式",
			"交互",
			"可访问性"
		],
		note: "视觉/交互判断：UI、UX、布局、可访问性"
	},
	{
		agent: "fixer",
		priority: 20,
		triggers: [
			"fix",
			"implement",
			"refactor",
			"change",
			"update",
			"add",
			"remove",
			"rewrite",
			"write tests",
			"patch",
			"repair",
			"correct",
			"make it work",
			"migrate"
		],
		triggersZh: [
			"修复",
			"实现",
			"重构",
			"修改",
			"添加",
			"删除",
			"更新",
			"编写"
		],
		note: "执行修改：目标与验收标准已明确时"
	}
];

/**
 * Compile one ASCII/English trigger into a RegExp. Triggers containing spaces
 * or regex metacharacters are used as-is; plain words get word boundaries.
 * CJK triggers are handled separately (see {@link matchTrigger}).
 * @param {string} trigger - the trigger phrase.
 * @returns {RegExp} the compiled pattern.
 */
function compileTrigger(trigger) {
	if (/[\s.*+?()[\]{}|^$\\]/.test(trigger)) return new RegExp(trigger, "i");
	return new RegExp(`\\b${trigger}\\b`, "i");
}

/**
 * Does a trigger apply to the scored task text? ASCII/English triggers use the
 * word-boundary regex; CJK triggers match as a literal substring because CJK
 * text has no word boundaries.
 * @param {string} trigger - the trigger phrase.
 * @param {string} text - the padded, lowercased task text.
 * @returns {boolean} whether the trigger matched.
 */
function matchTrigger(trigger, text) {
	return /[\u3040-\u30ff\u3400-\u9fff]/.test(trigger)
		? text.includes(trigger)
		: compileTrigger(trigger).test(text);
}

/**
 * Score a task text against the routing rules.
 * @param {string} task - the user task or subproblem text.
 * @returns {Array<{agent: string, score: number, matched: string[], note?: string, priority?: number}>}
 *   agents sorted by score desc, then priority desc.
 */
export function scoreTask(task) {
	const text = ` ${String(task).toLowerCase()} `;
	const scores = [];
	for (const rule of ROUTING_RULES) {
		const matched = [];
		for (const trigger of rule.triggers) {
			if (matchTrigger(trigger, text)) matched.push(trigger);
		}
		for (const trigger of rule.triggersZh ?? []) {
			if (matchTrigger(trigger, text)) matched.push(trigger);
		}
		if (matched.length > 0) {
			scores.push({
				agent: rule.agent,
				score: matched.length,
				matched,
				priority: rule.priority,
				note: rule.note
			});
		}
	}
	scores.sort((a, b) => b.score - a.score || (b.priority ?? 0) - (a.priority ?? 0));
	return scores;
}

/**
 * Source/config file extensions that mark a bare basename as an explicit
 * file-like target (case-insensitive). A token whose basename ends with one
 * of these — OR that contains a path separator — qualifies as file-like.
 */
export const KNOWN_SOURCE_EXTENSIONS = new Set([
	"js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
	"py", "go", "rs", "c", "h", "cpp", "hpp", "java", "kt",
	"rb", "php", "swift", "scala", "sh", "bat", "ps1", "sql",
	"css", "scss", "html", "json", "yml", "yaml", "toml", "xml",
	"md", "csv"
]);

/**
 * Is a candidate token a real explicit file reference?
 *
 * A token is file-like when its basename ends in a known source/config
 * extension (see {@link KNOWN_SOURCE_EXTENSIONS}) OR it contains a path
 * separator (`/` or `\`). URLs are rejected (a `://` scheme, or an
 * `http:`/`https:` prefix), and version-like dotted tokens that have neither a
 * separator nor a known extension (e.g. `v1.2`, `example.com`) do not qualify.
 * @param {string} token - a contiguous run of `[a-z0-9_/.-]` from the text.
 * @returns {boolean} whether the token is an explicit, non-URL file reference.
 */
export function isFileLike(token) {
	if (token === "" || token === "." || token === "..") return false;
	// URLs / schemes are never explicit file targets (kept defensive; the
	// caller strips URL schemes from the text before scanning).
	if (/\:\/\//.test(token)) return false;
	if (/^https?:/.test(token)) return false;
	let base = token.toLowerCase().split(/[\\/]/).pop();
	// A real bare filename may be followed by sentence punctuation, e.g. the
	// period in "in auth.js." — strip trailing dots before the extension test.
	base = base.replace(/\.+$/, "");
	if (token.includes("/") || token.includes("\\")) {
		// A real path must carry at least one non-separator character (so a
		// lone "//" fragment is not treated as a path).
		return /[^/\\]/.test(token);
	}
	for (const ext of KNOWN_SOURCE_EXTENSIONS) {
		if (base.endsWith(`.${ext}`)) return true;
	}
	return false;
}

/**
 * Does the task name an explicit modification target?
 *
 * §13: Fixer may only be routed to when the target/root cause/acceptance
 * criteria are explicit. A bare "fix it" or "handle this bug" is NOT a
 * target — it is a vague report that needs investigation first.
 *
 * An explicit target requires at least one real file-like reference (a path
 * separator or a known source/config extension, per {@link isFileLike}) OR one
 * of the explicitness markers below ("root cause", "as specified", "acceptance
 * criteria", "per the agreed design", "tests included"). Generic phrases such
 * as "bug in production", "issue in the project", "so that", or bare "v1.2"
 * do NOT make a target explicit.
 * @param {string} task - the task text.
 * @returns {boolean} whether an explicit target is present.
 */
export function hasExplicitTarget(task) {
	const text = String(task).toLowerCase();
	// Strip URL schemes (and their host/path) so "https://example.com/docs.js"
	// never yields a file-like token — a URL is not a local explicit target.
	const withoutUrls = text
		.replace(/\bhttps?:\/\/\S+/gi, " ")
		.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
	const fileRef = [...withoutUrls.matchAll(/[a-z0-9_/.\-]+/gi)].some((m) => isFileLike(m[0]));
	const criteria = /\broot cause\b|\bas specified\b|\bacceptance criteria\b|\bper the agreed design\b|\btests included\b/i.test(text);
	return fileRef || criteria;
}

/**
 * The routing decision for one task: primary agent plus alternates.
 *
 * Fixer wins only when it matched AND the target is explicit (§13:
 * 决策不等于执行). Otherwise the top investigation/decision agent wins, and
 * a no-signal task falls back to Explorer (investigate first).
 *
 * @param {string} task - the user task or subproblem text.
 * @returns {{primary: string | null, candidates: Array<{agent: string, score: number}>}}
 */
export function route(task) {
	const scored = scoreTask(task);
	const candidates = scored.map(({ agent, score }) => ({ agent, score }));
	// RISK/UNCERTAINTY GATE FIRST — "facts before decisions, decisions before
	// actions". Any Oracle signal (root cause, tradeoffs, concurrency,
	// security, architecture, migration, performance, risk) gates AHEAD of the
	// Fixer/file-target shortcut: no one makes decisions or edits before the
	// high-stakes reasoning has been given a chance to run.
	const oracle = candidates.find((c) => c.agent === "oracle");
	if (oracle !== void 0 && oracle.score >= 1) {
		return { primary: "oracle", candidates };
	}
	const fixer = candidates.find((c) => c.agent === "fixer");
	if (fixer !== void 0 && hasExplicitTarget(task)) {
		return { primary: "fixer", candidates };
	}
	const top = candidates.find((c) => c.agent !== "fixer");
	return { primary: top?.agent ?? "explorer", candidates };
}

/**
 * Render the routing table as markdown for the Orchestrator prompt.
 * @returns {string} a markdown table of "when to use which specialist".
 */
export function renderRoutingTable() {
	const rows = ROUTING_RULES.map((rule) => {
		const triggers = rule.triggers.slice(0, 6).map((t) => `\`${t}\``).join(" ");
		const zh = (rule.triggersZh ?? []).slice(0, 4).map((t) => `\`${t}\``).join(" ");
		return `| ${rule.agent} | ${rule.note} | ${triggers}${zh ? `\u2002${zh}` : ""} |`;
	}).join("\n");
	return [
		"| Specialist | When | Trigger examples (EN / 中文) |",
		"| --- | --- | --- |",
		rows
	].join("\n");
}
