export interface OverlayHome {
  repo: string;
  paths: readonly string[];
}

function isRelativeRepoPath(value: unknown): value is string {
  return typeof value === "string" && !/[:\\\x00-\x1f]/.test(value)
    && value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function parseOverlayHome(text: string): OverlayHome {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an overlay home record");
  }
  const { repo, paths } = value as { repo?: unknown; paths?: unknown };
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)
    || !Array.isArray(paths) || !paths.every(isRelativeRepoPath)) {
    throw new TypeError("expected an overlay repository and relative paths");
  }
  return { repo, paths };
}
