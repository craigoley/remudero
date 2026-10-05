import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readModelSwitchesPath } from "../../src/lib/read-model-worker.js";

/**
 * W1-T5896: the read-model worker builds no view whose switch is absent unless a declared reader
 * needs it, so a suite that builds a view writes its switch first, as an operator would.
 */
export function switchViewsOn(stateDir: string, views: Iterable<string>, mode: "serve" | "shadow" | "auto" = "serve"): void {
  mkdirSync(dirname(readModelSwitchesPath(stateDir)), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: Object.fromEntries([...views].map((view) => [view, mode])) }));
}
