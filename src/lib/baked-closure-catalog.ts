/** Exact closure registries offered to an implement build by its own census refusal. */
export const BAKED_CLOSURE_CATALOG: Readonly<Record<string, readonly { path: string; lists: readonly string[] }[]>> = {
  "test/baked-supervisor-inputs.test.ts": [
    { path: "src/lib/baked-runtime-inputs.ts", lists: ["BAKED_RUNTIME_SOURCE_PATHS"] },
    { path: ".github/workflows/acr-build.yml", lists: ["on.push.paths", "drift loop"] },
  ],
  "test/acr-build-trigger.test.ts": [
    { path: ".github/workflows/acr-build.yml", lists: ["on.push.paths", "drift loop"] },
  ],
  "test/a-busy-primary-reaches-its-image-recycle.test.ts": [
    { path: "deploy/install-host-units.sh", lists: ["DEPLOY_LOGIC_PATHS"] },
  ],
};

export function bakedClosureCatalogFiles(refusalText: string): string[] {
  const files = new Set<string>();
  for (const row of refusalText.split("\n")) {
    const file = row.match(/^\s*census-suite: (\S+) fails(?:\s|$)/)?.[1];
    if (file && Object.hasOwn(BAKED_CLOSURE_CATALOG, file)) {
      for (const entry of BAKED_CLOSURE_CATALOG[file]!) files.add(entry.path);
    }
  }
  return [...files].sort();
}

/** Human context may name a suite outside a refusal row; this never authorizes a file edit. */
export function bakedClosureCatalogDetails(text: string): string {
  return Object.entries(BAKED_CLOSURE_CATALOG).filter(([census]) => text.includes(census))
    .map(([census, entries]) => `${census}: ${entries.map(({ path, lists }) => `${path} (${lists.join(", ")})`).join("; ")}`)
    .join("\n");
}
