import type { CodeHealthProjectionInput, CodeHealthScan } from "./code-health-projection.js";

export interface CodeHealthCollection {
  repository: string;
  currentSha: string;
  observedAt: string;
  scans: CodeHealthScan[];
  previous: CodeHealthProjectionInput | null;
}

/** Assembly has no network, model, filing, or dispatch effects. */
export function prepareCodeHealthCollection(_input: CodeHealthCollection): CodeHealthProjectionInput {
  throw new Error("Code health collection has not been assembled.");
}
