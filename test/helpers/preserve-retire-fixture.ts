/** Test-only account substitution in an imported module; production has no HOME/config override. */
export function preserveRetireFixtureArgs(home: string, helper: string, args: string[]): string[] {
  const probe = `import importlib.util, sys
helper, account = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("pr", helper); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.account_home = lambda: account
sys.argv = [helper, *sys.argv[3:]]
raise SystemExit(m.main())`;
  return ["-I", "-B", "-c", probe, helper, home, ...args];
}
