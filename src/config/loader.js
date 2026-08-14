/**
 * Composition loader: turns the catalog + prompt files into the exact rows of
 * the generated `agent.cordis.yml`.
 *
 * @module multi-agent-orchestrator/config/loader
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPECIALISTS } from "../agents/catalog.js";
import { AGENT_INSTRUCTIONS_MAX_BYTES, PRESET_ID, PRESET_METADATA } from "./defaults.js";
import { ORCHESTRATOR_ALLOW, SHELL_TOOLS, WEB_SEARCH_TOOL } from "../permissions/agent-permissions.js";
import { renderRoutingTable } from "../routing/policy.js";
import { renderEnvelope } from "../routing/handoff.js";

/** Prompt files the Orchestrator persona is assembled from. */
const ORCHESTRATOR_PROMPT_FILES = ["prompts/orchestrator.md"];

/** Marker replaced with the rendered routing table inside orchestrator.md. */
const ROUTING_TABLE_MARKER = "{{ROUTING_TABLE}}";
/** Marker replaced with the envelope template inside orchestrator.md. */
const ENVELOPE_MARKER = "{{ENVELOPE}}";
/** Marker replaced with the delegation-tool reference inside orchestrator.md. */
const TOOLS_MARKER = "{{DELEGATION_TOOLS}}";

/** Marker replaced with the agent roster inside orchestrator.md. */
const ROSTER_MARKER = "{{AGENT_ROSTER}}";

/**
 * Render the delegation-tools reference block for the Orchestrator prompt.
 * @returns {string} markdown listing each tool name and its role.
 */
export function renderDelegationTools() {
	return SPECIALISTS.map((s) => `- \`${s.toolName}\` — ${s.description}`).join("\n");
}

/**
 * Render the agent roster block for the Orchestrator prompt.
 *
 * The shell tool name is platform-dependent, and this text is baked into the
 * prompt at build time, so render it platform-neutrally as `bash|pwsh`.
 * @returns {string} markdown table of the six specialists.
 */
export function renderRoster() {
	const rows = SPECIALISTS.map((s) => {
		const allowed = s.filterFor("posix").allow
			.map((name) => (name === "bash" ? "bash|pwsh" : name))
			.join(", ");
		return `| ${s.id} | ${s.description} | \`${s.toolName}\` | ${allowed} |`;
	}).join("\n");
	return [
		"| Agent | Mission | Tool | Permission surface (allow) |",
		"| --- | --- | --- | --- |",
		rows
	].join("\n");
}

/**
 * Read one prompt file as text.
 * @param {string} root - project root directory.
 * @param {string} file - prompt-relative path.
 * @returns {string} the prompt text.
 */
export function readPrompt(root, file) {
	return readFileSync(join(root, file), "utf8");
}

/**
 * Load the Orchestrator persona text (markers resolved).
 * @param {string} root - project root directory.
 * @returns {string} the assembled orchestrator system prompt.
 */
export function loadOrchestratorPersona(root) {
	const text = ORCHESTRATOR_PROMPT_FILES.map((f) => readPrompt(root, f)).join("\n\n");
	return text
		.replace(ROUTING_TABLE_MARKER, renderRoutingTable())
		.replace(ENVELOPE_MARKER, renderEnvelope())
		.replace(TOOLS_MARKER, renderDelegationTools())
		.replace(ROSTER_MARKER, renderRoster());
}

/**
 * Load one specialist's persona text.
 * @param {string} root - project root directory.
 * @param {object} specialist - the specialist definition.
 * @returns {string} the specialist system prompt.
 */
export function loadSpecialistPersona(root, specialist) {
	return readPrompt(root, specialist.personaFile);
}

export { ORCHESTRATOR_ALLOW, PRESET_ID, PRESET_METADATA, SHELL_TOOLS, WEB_SEARCH_TOOL };
