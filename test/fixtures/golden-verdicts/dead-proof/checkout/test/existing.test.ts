import { test } from "node:test";

test("an existing, unrelated behavior stays covered", () => {
  if (1 + 1 !== 2) throw new Error("arithmetic broke");
});
