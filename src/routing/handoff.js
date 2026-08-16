/**
 * Delegation handoff helpers: how the Orchestrator frames a specialist task.
 *
 * The protocol core (envelope template, multi-line parser, TASK_ID
 * extraction, delegation prompt rendering) now lives in
 * `src/orchestration/protocol.mjs` — the single source of truth shared by
 * the prompt builders, the tests, AND the runtime broker. This module is a
 * backward-compatible re-export shim so existing imports keep working.
 *
 * @module multi-agent-orchestrator/routing/handoff
 */

export * from "../orchestration/protocol.mjs";
