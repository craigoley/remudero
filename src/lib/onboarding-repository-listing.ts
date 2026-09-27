/** Shared, bounded parser for `gh api --paginate --jq` repository listings. */
const MAX_REPOSITORIES = 10_000;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function lines(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function slugs(values: readonly string[]): string[] | null {
  if (values.length > MAX_REPOSITORIES || values.some((value) => !REPO_NAME.test(value))) return null;
  const byName = new Map<string, string>();
  for (const value of values) byName.set(value.toLowerCase(), value);
  return [...byName.values()].sort((a, b) => a.localeCompare(b));
}

export function parseInstallationRepositoryListing(raw: string): string[] | null {
  const values = lines(raw);
  if (values.length === 0) return null; // a valid installation always reports total_count
  const total = Number(values[0]);
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_REPOSITORIES) return null;
  const names = values.filter((value) => !/^\d+$/.test(value));
  const repositories = slugs(names);
  if (!repositories || repositories.length !== total) return null;
  // --paginate repeats total_count once per page. Every such value must agree with the first.
  if (values.some((value) => /^\d+$/.test(value) && Number(value) !== total)) return null;
  return repositories;
}

export function parseUserRepositoryListing(raw: string): string[] | null {
  return slugs(lines(raw));
}
