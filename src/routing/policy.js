/**
 * Routing policy for the Orchestrator (§17 of the design doc).
 *
 * A pure, testable model of when to delegate to which specialist. The same
 * table is rendered into the Orchestrator's system prompt by the build script
 * (`renderRoutingTable()`), so the code, the prompt, and the tests share one
 * source of truth.
 *
 * @module multi-agent-orchestrator/routing/policy
 */

/**
 * One routing rule: a specialist plus the trigger phrases that route to it.
 * `priority` breaks ties (higher first); rules are evaluated in order.
 *
 * @type {Array<{agent: string, triggers: string[], priority?: number, note?: string}>}
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
		note: "执行修改：目标与验收标准已明确时"
	}
];

/**
 * Compile one trigger into a RegExp. Triggers containing spaces or regex
 * metacharacters are used as-is; plain words get word boundaries.
 * @param {string} trigger - the trigger phrase.
 * @returns {RegExp} the compiled pattern.
 */
function compileTrigger(trigger) {
	if (/[\s.*+?()[\]{}|^$\\]/.test(trigger)) return new RegExp(trigger, "i");
	return new RegExp(`\\b${trigger}\\b`, "i");
}

/**
 * Score a task text against the routing rules.
 * @param {string} task - the user task or subproblem text.
 * @returns {Array<{agent: string, score: number, matched: string[], note?: string}>}
 *   agents sorted by score desc, then priority desc.
 */
export function scoreTask(task) {
	const text = ` ${String(task).toLowerCase()} `;
	const scores = [];
	for (const rule of ROUTING_RULES) {
		const matched = [];
		for (const trigger of rule.triggers) {
			if (compileTrigger(trigger).test(text)) matched.push(trigger);
		}
		if (matched.length > 0) {
			scores.push({
				agent: rule.agent,
				score: matched.length,
				matched,
				note: rule.note
			});
		}
	}
	scores.sort((a, b) => b.score - a.score || (b.priority ?? 0) - (a.priority ?? 0));
	return scores;
}

/**
 * Does the task name an explicit modification target?
 *
 * §13: Fixer may only be routed to when the target/root cause/acceptance
 * criteria are explicit. A bare "fix it" or "handle this bug" is NOT a
 * target — it is a vague report that needs investigation first.
 * @param {string} task - the task text.
 * @returns {boolean} whether an explicit target is present.
 */
export function hasExplicitTarget(task) {
	const text = task.toLowerCase();
	const fileRef = /\b[a-z0-9_/.-]+\.[a-z0-9]{1,6}\b/i.test(text);
	const located = /(?:bug|issue|error|problem|logic|handling|support|feature|function|component|page|screen|config|schema|test|tests|code)\s+(?:in|of|for)\s+[a-z0-9_/.-]+/i.test(text);
	const criteria = /\broot cause\b|\bas specified\b|\bacceptance criteria\b|\bper the agreed design\b|\btests included\b|\bso that\b/i.test(text);
	return fileRef || located || criteria;
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
		const triggers = rule.triggers.slice(0, 8).map((t) => `\`${t}\``).join(" ");
		return `| ${rule.agent} | ${rule.note} | ${triggers} |`;
	}).join("\n");
	return [
		"| Specialist | When | Trigger examples |",
		"| --- | --- | --- |",
		rows
	].join("\n");
}
