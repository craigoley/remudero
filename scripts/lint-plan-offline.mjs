/**
 * Checkout-local plan lint for latency-sensitive callers such as git hooks.
 *
 * Do not route this through bin/rmd: the general CLI owns token refresh and checkout freshness,
 * both of which can use the network before command dispatch. `lintPlanCommand` owns the actual
 * lint logic and prints the checks its offline dependency boundary cannot run.
 */
import { lintPlanCommand } from "../src/run-task.js";

process.exitCode = await lintPlanCommand(process.argv.slice(2), { offline: true });
