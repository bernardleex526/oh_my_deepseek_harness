/**
 * Delegation handoff helpers: how the Orchestrator frames a specialist task.
 *
 * The Orchestrator prompt uses these rules (rendered into the prompt by the
 * build script); the functions here are the testable core.
 *
 * @module multi-agent-orchestrator/routing/handoff
 */

/**
 * The standard return envelope every specialist must produce (§24).
 * @returns {string} the envelope template as markdown.
 */
export function renderEnvelope() {
	return [
		"```",
		"STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE",
		"SUMMARY: <one short paragraph>",
		"FINDINGS: <facts, each with a reference>",
		"EVIDENCE: <file:line | URL | log excerpt | screenshot reference>",
		"UNCERTAINTIES: <what is unknown or inferred, never invented>",
		"RECOMMENDED_NEXT_STEP: <suggested follow-up, if any>",
		"```"
	].join("\n");
}

/** The four canonical status values. */
export const KNOWN_STATUSES = ["SUCCESS", "PARTIAL", "BLOCKED", "NOT_APPLICABLE"];

/** Optional envelope sections recognized by parseEnvelope. */
export const OPTIONAL_ENVELOPE_SECTIONS = [
	"FINDINGS",
	"EVIDENCE",
	"UNCERTAINTIES",
	"RECOMMENDED_NEXT_STEP"
];

/** Every canonical envelope section, in the order renderEnvelope emits them. */
export const CANONICAL_ENVELOPE_SECTIONS = [
	"STATUS",
	"SUMMARY",
	...OPTIONAL_ENVELOPE_SECTIONS
];

/**
 * Test whether a string is one of the four canonical status values.
 * Case-sensitive: only SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE.
 * @param {string} value - the candidate status.
 * @returns {boolean} true when `value` is a known status.
 */
export function isKnownStatus(value) {
	return KNOWN_STATUSES.includes(value);
}

/**
 * Parse a specialist return envelope into a structured result.
 *
 * Contract (mirrors renderEnvelope): a valid envelope MUST have a STATUS line
 * matching `STATUS: <SUCCESS|PARTIAL|BLOCKED|NOT_APPLICABLE>` and a non-empty
 * SUMMARY. FINDINGS/EVIDENCE/UNCERTAINTIES/RECOMMENDED_NEXT_STEP are optional;
 * each missing one adds a warning (not an error). A canonical section
 * (STATUS/SUMMARY/FINDINGS/EVIDENCE/UNCERTAINTIES/RECOMMENDED_NEXT_STEP)
 * DEFINED MORE THAN ONCE is an error (`duplicate <SECTION> field`), because a
 * duplicated field is ambiguous. Extra lines and extra free text (e.g. a
 * `REASON:` line under BLOCKED) are ignored, not errors.
 *
 * @param {string} text - the raw envelope text.
 * @returns {{ok: boolean, status: string|null, summary: string|null,
 *   fields: Record<string,string>, errors: string[], warnings: string[]}}
 *   parsed result.
 */
export function parseEnvelope(text) {
	const errors = [];
	const warnings = [];
	const fields = {};
	let status = null;
	let summary = null;
	const lines = String(text).split(/\r?\n/);

	const SectionRe = /^([A-Z][A-Z_ ]+):\s*(.*)$/;
	let statusFound = false;
	const seen = new Set();
	for (const raw of lines) {
		const match = raw.match(SectionRe);
		if (match === null) continue; // headings, fences, prose — ignore
		const key = match[1];
		const value = match[2].trim(); // trim surrounding whitespace (e.g. "SUCCESS ")
		if (CANONICAL_ENVELOPE_SECTIONS.includes(key)) {
			if (seen.has(key)) {
				// a canonical field defined twice is ambiguous; reject it
				errors.push(`duplicate ${key} field`);
				continue;
			}
			seen.add(key);
		}
		if (key === "STATUS") {
			statusFound = true;
			if (isKnownStatus(value)) {
				status = value;
			} else {
				errors.push(`unknown STATUS value ${JSON.stringify(value)}`);
			}
		} else if (key === "SUMMARY") {
			if (value.trim().length > 0) {
				summary = value.trim();
				fields[key] = summary;
			} else {
				summary = "";
				fields[key] = "";
				// non-empty check applied below once
			}
		} else if (OPTIONAL_ENVELOPE_SECTIONS.includes(key)) {
			fields[key] = value;
		}
		// any other matching header line is treated as free-ish content and ignored
	}

	if (!statusFound) {
		errors.push("missing STATUS section");
	}
	if (summary === null) {
		errors.push("missing SUMMARY section");
	}
	if (summary !== null && summary === "") {
		errors.push("empty SUMMARY");
	}

	for (const section of OPTIONAL_ENVELOPE_SECTIONS) {
		if (!(section in fields)) warnings.push(`missing optional section: ${section}`);
	}

	return {
		ok: errors.length === 0,
		status: statusFound ? status : null,
		summary,
		fields,
		errors,
		warnings
	};
}

/**
 * Render the delegation prompt template the Orchestrator uses for one task.
 * @param {object} opts - delegation fields.
 * @param {string} opts.agent - specialist id (e.g. "explorer").
 * @param {string} opts.task - the concrete task.
 * @param {string} [opts.context] - relevant facts already known.
 * @param {string} [opts.constraints] - constraints/acceptance criteria.
 * @returns {string} the handoff prompt text.
 */
export function renderDelegationPrompt({ agent, task, context, constraints }) {
	const lines = [
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
		renderEnvelope()
	);
	return lines.join("\n");
}
