/** Materialize the fix worker's existing test-edit permission as exact observed paths. */
export function admittedFixTestPaths(paths: readonly string[], admitTests: boolean | undefined): string[] {
  return admitTests ? paths.filter((path) => path.startsWith("test/") && !path.split("/").includes("..")) : [];
}
