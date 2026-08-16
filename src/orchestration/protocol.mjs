/**
 * Delegation protocol: the specialist return envelope and the TASK_ID
 * discipline shared by the prompt templates, the build script, and the
 * runtime broker.
 *
 * This module is the SINGLE source of truth for the protocol:
 * - `renderEnvelope()` / `renderDelegationPrompt()` render the shapes the
 *   Orchestrator prompt and the delegation prompts mandate.
 * - `parseEnvelope()` mechanically validates a specialist's raw return text
 *   (multi-line sections included) and is wired into the real execution path
 *   by `broker.mjs` (via `tools/post-execute`), so malformed results are
 *   BLOCKED instead of being handed to the model as success.
 * - `extractTaskId()` finds the task id a delegation prompt declares, which
 *   is how the broker keys budgets and links envelopes back to tasks.
 *
 * IMPORT-FREE: this file is copied into the preset directory (a
 * user-writable location with no node_modules), so it may only use globals.
 *
 * @module multi-agent-orchestrator/orchestration/protocol
 */

/** The four canonical status values. */
export const KNOWN_STATUSES = ["SUCCESS", "PARTIAL", "BLOCKED", "NOT_APPLICABLE"];

/**
 * Generic optional envelope sections: never required, but a missing one adds
 * a warning (they are meaningful for EVERY specialist).
 */
export const OPTIONAL_ENVELOPE_SECTIONS = [
	"FINDINGS",
	"EVIDENCE",
	"UNCERTAINTIES",
	"RECOMMENDED_NEXT_STEP"
];

/**
 * Role-specific envelope sections: parsed (multi-line, duplicate-checked)
 * but NOT warned about when missing — they are only meaningful for specific
 * roles, and the broker enforces the relevant ones on SUCCESS via
 * {@link ROLE_REQUIRED_ON_SUCCESS}. (`REASON` — free text under BLOCKED — is
 * deliberately absent from both lists: only meaningful for BLOCKED results.)
 */
export const ROLE_ENVELOPE_SECTIONS = [
	"CHANGES",
	"VERIFICATION",
	"OBSERVED",
	"EXPECTED",
	"DIFFERENCE",
	"SPECIFICATION",
	"REPRODUCTION"
];

/** Every canonical envelope section, in the order renderEnvelope emits them. */
export const CANONICAL_ENVELOPE_SECTIONS = [
	"TASK_ID",
	"STATUS",
	"SUMMARY",
	...OPTIONAL_ENVELOPE_SECTIONS,
	...ROLE_ENVELOPE_SECTIONS
];

/**
 * Per-role sections that a SUCCESS envelope MUST carry (enforced by the
 * broker at settle time). A Fixer that reports SUCCESS without listing what
 * it changed, or an Observer without what it observed, is exactly the
 * "no evidence" failure mode the mechanical gate exists to reject.
 */
export const ROLE_REQUIRED_ON_SUCCESS = {
	fixer: ["CHANGES", "VERIFICATION"],
	observer: ["OBSERVED"],
	designer: ["SPECIFICATION"]
};

/** A task id is a short, stable, URL-safe identifier. */
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Test whether a string is one of the four canonical status values.
 * @param {string} value - the candidate status.
 * @returns {boolean} true when `value` is a known status.
 */
export function isKnownStatus(value) {
	return KNOWN_STATUSES.includes(value);
}

/**
 * Test whether a string is a valid task id.
 * @param {unknown} value - the candidate task id.
 * @returns {boolean} true when `value` matches TASK_ID_RE.
 */
export function isValidTaskId(value) {
	return typeof value === "string" && TASK_ID_RE.test(value);
}

/**
 * Extract the TASK_ID a delegation prompt declares.
 *
 * The Orchestrator prompt template and `renderDelegationPrompt()` always put
 * `TASK_ID: <id>` alone on its own line, so a FULL-LINE match is the
 * authoritative id — quoted prose inside the task text cannot shadow it, and
 * an id with trailing junk (`TASK_ID: t1 extra`) is rejected.
 * @param {string} text - the delegation prompt text.
 * @returns {string | null} the declared task id, or null when absent/invalid.
 */
export function extractTaskId(text) {
	const match = String(text).match(/^TASK_ID\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/m);
	return match === null ? null : match[1];
}

/**
 * The standard return envelope every specialist must produce.
 * @returns {string} the envelope template as markdown.
 */
export function renderEnvelope() {
	return [
		"```",
		"TASK_ID: <the task id from your delegation prompt, echoed exactly>",
		"STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE",
		"SUMMARY: <one short paragraph>",
		"FINDINGS: <facts, each with a reference>",
		"EVIDENCE: <file:line | URL | log excerpt | screenshot reference>",
		"UNCERTAINTIES: <what is unknown or inferred, never invented>",
		"RECOMMENDED_NEXT_STEP: <suggested follow-up, if any>",
		"```"
	].join("\n");
}

/**
 * Parse a specialist return envelope into a structured result.
 *
 * v2 protocol (multi-line aware):
 * - `TASK_ID`, `STATUS`, `SUMMARY` are REQUIRED canonical sections; any
 *   missing one is an error, and a `TASK_ID` that is not a valid identifier
 *   is an error.
 * - Canonical sections may span multiple lines: every non-section line that
 *   follows a section header is appended to that section's value (code-fence
 *   lines are skipped). This is how `CHANGES`, `VERIFICATION`, `OBSERVED`
 *   and `SPECIFICATION` bodies survive parsing.
 * - A canonical section defined more than once is an error.
 * - Unknown `UPPER_SNAKE: value` headers (e.g. `REASON:` under BLOCKED) are
 *   collected into `sections` without error, but never into `fields`.
 * - Missing optional sections produce warnings, not errors.
 *
 * @param {string} text - the raw envelope text.
 * @returns {{ok: boolean, status: string|null, summary: string|null,
 *   taskId: string|null, fields: Record<string,string>,
 *   sections: Record<string,string>, errors: string[], warnings: string[]}}
 */
export function parseEnvelope(text) {
	const errors = [];
	const warnings = [];
	const fields = {};
	const sections = {};
	let status = null;
	let summary = null;
	let taskId = null;
	const lines = String(text).split(/\r?\n/);

	const SectionRe = /^([A-Z][A-Z_ ]+):\s*(.*)$/;
	let statusFound = false;
	const seen = new Set();
	let current = null; // section key currently accumulating multi-line content
	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		const match = line.match(SectionRe);
		if (match !== null) {
			const key = match[1].trim();
			const value = match[2].trim();
			if (CANONICAL_ENVELOPE_SECTIONS.includes(key)) {
				if (seen.has(key)) {
					// a canonical field defined twice is ambiguous; reject it
					errors.push(`duplicate ${key} field`);
					current = null;
					continue;
				}
				seen.add(key);
				current = key;
				sections[key] = value;
				if (key === "STATUS") {
					statusFound = true;
					if (isKnownStatus(value)) {
						status = value;
					} else {
						errors.push(`unknown STATUS value ${JSON.stringify(value)}`);
					}
				} else if (key === "SUMMARY") {
					summary = value;
				} else if (key === "TASK_ID") {
					if (isValidTaskId(value)) {
						taskId = value;
					} else {
						errors.push(`invalid TASK_ID value ${JSON.stringify(value)}`);
					}
				}
			} else {
				// Free-ish extension headers (REASON, …) start a section of
				// their own: visible in `sections`, never in `fields`, and
				// never an error. Repeated extra headers append.
				current = key;
				sections[key] = sections[key] === void 0
					? value
					: `${sections[key]}\n${value}`;
			}
		} else if (current !== null && !/^```/.test(line.trim())) {
			// Multi-line body of the current section (fence lines skipped).
			const body = sections[current] ?? "";
			sections[current] = body === "" ? line : `${body}\n${line}`;
		}
		// any other free text outside a section is ignored
	}

	if (!statusFound) errors.push("missing STATUS section");
	if (summary === null) errors.push("missing SUMMARY section");
	if (summary !== null && summary.trim() === "") errors.push("empty SUMMARY");
	if (taskId === null && !seen.has("TASK_ID")) errors.push("missing TASK_ID section");

	// `fields` keeps the FIRST LINE of each canonical section (backward
	// compatible single-line view); `sections` carries the full bodies.
	for (const key of CANONICAL_ENVELOPE_SECTIONS) {
		if (sections[key] !== void 0) fields[key] = sections[key].split("\n")[0].trim();
	}

	for (const section of OPTIONAL_ENVELOPE_SECTIONS) {
		if (!(section in sections)) warnings.push(`missing optional section: ${section}`);
	}

	return {
		ok: errors.length === 0,
		status: statusFound ? status : null,
		summary: summary !== null && summary.trim() === "" ? "" : summary,
		taskId,
		fields,
		sections,
		errors,
		warnings
	};
}

/**
 * Render the delegation prompt template the Orchestrator uses for one task.
 * @param {object} opts - delegation fields.
 * @param {string} opts.agent - specialist id (e.g. "explorer").
 * @param {string} opts.task - the concrete task.
 * @param {string} opts.taskId - the task id this delegation belongs to.
 * @param {string} [opts.context] - relevant facts already known.
 * @param {string} [opts.constraints] - constraints/acceptance criteria.
 * @returns {string} the handoff prompt text.
 */
export function renderDelegationPrompt({ agent, task, taskId, context, constraints }) {
	if (!isValidTaskId(taskId)) {
		throw new TypeError(`renderDelegationPrompt: taskId must match ${String(TASK_ID_RE)}`);
	}
	const lines = [
		`TASK_ID: ${taskId}`,
		"",
		`You are the ${agent} specialist.`,
		"",
		`TASK: ${task}`
	];
	if (context) lines.push("", `KNOWN CONTEXT: ${context}`);
	if (constraints) lines.push("", `CONSTRAINTS: ${constraints}`);
	lines.push(
		"",
		agent === "fixer"
			? "You MAY modify files to complete the task. Return the standard envelope with STATUS, CHANGES, and VERIFICATION."
			: "Do not modify any files.",
		"",
		"Return your result as the standard envelope below. The FIRST line must be",
		"`TASK_ID: <this task's id>` echoed EXACTLY as given above, then STATUS,",
		"SUMMARY, and the sections below:",
		"",
		renderEnvelope()
	);
	return lines.join("\n");
}
