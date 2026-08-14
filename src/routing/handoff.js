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
		"Return your result in the standard envelope below. Do not modify any files.",
		"",
		renderEnvelope()
	);
	return lines.join("\n");
}
