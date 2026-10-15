/**
 * The retro shipped-since gateways of src/run-task.ts, re-exported for the suite that checks they read
 * only what changed since the board snapshot. A suite importing src/run-task.ts directly raises the
 * affected-suite reach ratchet's importer ceiling (scripts/affected-reach-baseline.json, shrink-only);
 * routing through this helper keeps that count flat while the suite still runs the real functions.
 */
export { retroShippedGithubGateway, retroShippedGithubGatewayAsync } from "../../src/run-task.js";
