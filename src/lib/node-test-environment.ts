/** Clear native-test recursion state without erasing declared V8 heap limits. */
export function resourceOnlyNodeOptions(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const flag = /^--max[-_](?:old|semi)[-_]space[-_]size(?:=(.+))?$/.exec(tokens[index]!);
    const amount = flag?.[1] ?? (flag ? tokens[++index] : undefined);
    if (!flag || !/^[1-9][0-9]*$/.test(amount ?? "") || !Number.isSafeInteger(Number(amount))) {
      if (/--(?:max[-_](?:old|semi)[-_]space[-_]size|max[-_]heap[-_]size)/.test(value))
        throw new Error("cannot clear native test context with mixed or unmodelled heap options");
      return undefined;
    }
  }
  return value;
}

export function withoutNodeTestContext<T>(run: () => T): T {
  const context = process.env.NODE_TEST_CONTEXT;
  const options = process.env.NODE_OPTIONS;
  const retained = resourceOnlyNodeOptions(options);
  delete process.env.NODE_TEST_CONTEXT;
  if (retained === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = retained;
  try { return run(); }
  finally {
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
    if (options === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = options;
  }
}
