/**
 * Routing policy: backward-compatible re-export shim.
 *
 * The policy implementation moved to `src/orchestration/policy.mjs` so the
 * preset can copy it as `policy.mjs` and use it at runtime (`broker_route`).
 * This shim keeps every existing import (`loader.js`, tests) working against
 * the single source of truth.
 *
 * @module multi-agent-orchestrator/routing/policy
 */

export * from "../orchestration/policy.mjs";
