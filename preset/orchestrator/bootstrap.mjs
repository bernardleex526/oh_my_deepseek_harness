/**
 * Anchored orchestrator bootstrap — a native fusion of the
 * `dsh-anchored-standard` mechanism (github.com/xiaobright/dsh-anchored-standard)
 * into the multi-agent orchestration preset.
 *
 * The idea, adapted from that project's measurements: the FIRST model request's
 * visible tool schema shapes the session's trajectory. For the Orchestrator we
 * anchor request #1 on a small CONTROL-PLANE tool set (cheap reads, the user
 * channel, task tracking, and the two broker advisory tools — no delegation,
 * no web) so the first response is a clean "understand the task" turn. The
 * FIRST durable signal (the first tool call or the first assistant message —
 * i.e. the second `agent/pre-step`) promotes the session to the FULL
 * Orchestrator allow-list, which the model keeps for the rest of the session.
 *
 * Deliberate differences from the upstream preset:
 * - Upstream anchors on the Minimal tool PAIR (`bash` + `str_replace_editor`);
 *   we anchor on the control-plane set because the Orchestrator's first turn
 *   must stay non-executing (it has no shell by design) and cheap.
 * - Upstream narrows the post-promotion catalog to a resident set (discovery
 *   tools + unlocked tools) because the Standard catalog is huge; our full
 *   orchestrator surface is 16 tools, so post-promotion = the full list.
 * - Upstream strips `skill-catalog` + `agent-instructions` injections on the
 *   first request; we strip `agent-instructions` (our preset mounts no skill
 *   catalog). Both are automatic `agent/pre-step` injections, so the same
 *   message-filter mechanism applies.
 * - Upstream derives the phase from durable session events; we use the same
 *   durable check for RESUME (a session that already produced a signal gets
 *   the full catalog immediately) and the pre-step count for LIVE promotion
 *   (the second pre-step is exactly "the first request completed", whatever
 *   it produced — the `either` semantics).
 * - One-shot specialist CHILDREN are never bootstrapped: they get their full
 *   role filter on their single request, exactly like upstream promotes
 *   subagents unconditionally.
 *
 * Robustness (mirrors upstream): a bootstrap restriction failure degrades to
 * the full catalog with a warning — a composition drift can never brick the
 * session; the pre-step message filter degrades to "keep everything" on
 * failure — a filter bug must never eat the user's context.
 *
 * IMPORT-FREE: copied into the preset directory (no node_modules).
 *
 * @module multi-agent-orchestrator/orchestration/bootstrap
 */

/** Env var controlling the bootstrap phase. */
export const BOOTSTRAP_ENV = "DSH_ORCHESTRATION_BOOTSTRAP";

/**
 * The default first-request catalog: cheap control-plane tools only. No
 * delegation tools, no web_search, no list_agents — the first turn is a
 * planning turn.
 */
export const DEFAULT_BOOTSTRAP_ALLOW = [
	"read",
	"read_image",
	"grep",
	"glob",
	"ask_user_question",
	"todo_write",
	"broker_status",
	"broker_route"
];

/**
 * Automatic pre-step injection sources stripped during bootstrap (upstream
 * lever 3). Our preset mounts no skill catalog, so only agent-instructions
 * (AGENTS.md-style digests) applies.
 */
export const BOOTSTRAP_SUPPRESSED_SOURCES = ["agent-instructions", "skill-catalog"];

/**
 * Parse the `$DSH_ORCHESTRATION_BOOTSTRAP` value:
 * - absent / "1" / "on" / "true" / unparseable  → DEFAULT_BOOTSTRAP_ALLOW
 * - "0" / "off" / "false" / "none"              → null (bootstrap disabled)
 * - a JSON array of non-empty strings           → that custom tool list
 * @param {string} [raw] - the env value (default: process.env).
 * @returns {string[] | null} the bootstrap allow list, or null when disabled.
 */
export function parseBootstrapEnv(raw = process.env[BOOTSTRAP_ENV]) {
	if (raw === void 0 || raw.trim() === "") return [...DEFAULT_BOOTSTRAP_ALLOW];
	const t = raw.trim().toLowerCase();
	if (t === "0" || t === "off" || t === "false" || t === "none") return null;
	if (t === "1" || t === "on" || t === "true") return [...DEFAULT_BOOTSTRAP_ALLOW];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n) => typeof n === "string" && n.length > 0)) {
			return [...new Set(parsed)];
		}
	} catch {
		// fall through to the safe default
	}
	return [...DEFAULT_BOOTSTRAP_ALLOW];
}

/**
 * Whether a session has already produced a durable promotion signal
 * (`tool/call` or `assistant/message` in its event log).
 * @param {object} agent - an agent payload (session.events is the durable log).
 * @returns {boolean}
 */
export function sessionHasDurableSignal(agent) {
	const events = agent?.session?.events;
	return Array.isArray(events) && events.some((e) => e?.type === "tool/call" || e?.type === "assistant/message");
}

/**
 * Whether an agent should start in the bootstrap phase:
 * ROOT sessions only (children are one-shot specialists needing their full
 * role filter on their single request) and only FRESH sessions (a resumed
 * session already has durable signals and must keep the full catalog).
 * @param {object} agent - an agent payload.
 * @returns {boolean}
 */
export function shouldBootstrapAgent(agent) {
	if (agent?.session?.header?.parentSession !== void 0) return false;
	return !sessionHasDurableSignal(agent);
}

/**
 * Filter automatic injected context (AGENTS.md digests) out of a pre-step
 * decision's messages during bootstrap. Degrades to keeping everything.
 * @param {object} decision - the pre-step decision ({ kind, messages }).
 * @param {Set<string>} suppressed - source.kind values to strip.
 * @returns {object} the (possibly narrowed) decision.
 */
export function stripSuppressedContext(decision, suppressed = new Set(BOOTSTRAP_SUPPRESSED_SOURCES)) {
	try {
		if (decision?.kind === "reject" || suppressed.size === 0) return decision;
		if (!Array.isArray(decision.messages)) return decision;
		const kept = decision.messages.filter((message) => {
			const kind = message?.source?.kind;
			return typeof kind !== "string" || !suppressed.has(kind);
		});
		return kept.length === decision.messages.length ? decision : { ...decision, messages: kept };
	} catch {
		return decision; // a filter bug must never eat context
	}
}
