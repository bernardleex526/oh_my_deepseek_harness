/**
 * Zero-dependency validation helpers for the multi-agent catalog.
 *
 * These guards run at build time (scripts/build.mjs) and in the test suite.
 * They keep every agent definition, tool filter, and routing rule in a shape
 * the DSH preset loader and the harness tools registry can consume.
 *
 * @module multi-agent-orchestrator/config/schema
 */

/** A delegation tool name must be a lowercase snake identifier. */
export const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/** A preset/agent id must match the harness preset-id rule. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Assert one agent definition object.
 * @param {unknown} value - the candidate agent definition.
 * @param {string} label - diagnostic label for error messages.
 * @returns {void}
 */
export function assertAgentDefinition(value, label = "agent") {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label}: agent definition must be an object`);
	}
	const required = ["id", "toolName", "personaFile", "role", "filter", "maxDepth"];
	for (const key of required) {
		if (!(key in value)) throw new TypeError(`${label}: missing required field "${key}"`);
	}
	if (typeof value.id !== "string" || !AGENT_ID.test(value.id)) {
		throw new TypeError(`${label}: id must match ${String(AGENT_ID)}`);
	}
	if (typeof value.toolName !== "string" || !TOOL_NAME.test(value.toolName)) {
		throw new TypeError(`${label}: toolName must match ${String(TOOL_NAME)}`);
	}
	if (typeof value.personaFile !== "string") throw new TypeError(`${label}: personaFile must be a string`);
	if (typeof value.role !== "string") throw new TypeError(`${label}: role must be a string`);
	assertToolFilter(value.filter, `${label}.filter`);
	if (!Number.isSafeInteger(value.maxDepth) || value.maxDepth < 0) {
		throw new TypeError(`${label}: maxDepth must be a non-negative safe integer`);
	}
}

/**
 * Assert one tool-filter object ({ allow?: string[], deny?: string[] }).
 * At least one of allow/deny must be present; names must be non-empty strings.
 * @param {unknown} value - the candidate tool filter.
 * @param {string} label - diagnostic label for error messages.
 * @returns {void}
 */
export function assertToolFilter(value, label = "toolFilter") {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label}: must be an object with allow and/or deny`);
	}
	const allow = value.allow;
	const deny = value.deny;
	if (allow === void 0 && deny === void 0) {
		throw new TypeError(`${label}: must declare allow and/or deny`);
	}
	for (const [key, list] of [["allow", allow], ["deny", deny]]) {
		if (list === void 0) continue;
		if (!Array.isArray(list)) throw new TypeError(`${label}.${key} must be an array of tool names`);
		for (const name of list) {
			if (typeof name !== "string" || name.length === 0) {
				throw new TypeError(`${label}.${key} contains a non-string tool name`);
			}
		}
	}
}

/**
 * Assert a routing-rule list.
 * @param {unknown} value - the candidate routing rules.
 * @returns {void}
 */
export function assertRoutingRules(value) {
	if (!Array.isArray(value)) throw new TypeError("routing rules must be an array");
	for (const rule of value) {
		if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
			throw new TypeError("routing rule must be an object");
		}
		if (typeof rule.agent !== "string") throw new TypeError("routing rule agent must be a string");
		if (!Array.isArray(rule.triggers) || rule.triggers.some((t) => typeof t !== "string")) {
			throw new TypeError("routing rule triggers must be an array of strings");
		}
		for (const trigger of rule.triggers) {
			const label = `routing rule "${rule.agent}".triggers`;
			if (typeof trigger !== "string" || trigger.length === 0) {
				throw new TypeError(`${label}: English trigger must be a non-empty string`);
			}
			// Compile-check the trigger as a case-insensitive pattern so an
			// invalid regex fails at build time (schema validation) instead of
			// crashing routing at match time.
			try {
				new RegExp(trigger, "i");
			} catch (error) {
				throw new TypeError(`${label}: trigger ${JSON.stringify(trigger)} is not a valid regular expression (${error.message})`);
			}
		}
		if (rule.triggersZh !== void 0 && (
			!Array.isArray(rule.triggersZh) || rule.triggersZh.some((t) => typeof t !== "string")
		)) {
			throw new TypeError("routing rule triggersZh must be an array of strings");
		}
		for (const trigger of rule.triggersZh ?? []) {
			if (typeof trigger !== "string" || trigger.length === 0) {
				throw new TypeError(`routing rule "${rule.agent}".triggersZh: CJK trigger must be a non-empty string`);
			}
		}
		if (rule.priority !== void 0 && (!Number.isFinite(rule.priority))) {
			throw new TypeError("routing rule priority must be a finite number");
		}
	}
}
