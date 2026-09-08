// `ledger-union.js` is the one module that owns the ledger union reader; this file is kept only
// so `rmd ledger-grep`'s existing import path (`./ledger-grep.js`, dozens of call sites) keeps
// resolving. `export *` (not a named list) re-exports every value AND type from ledger-union.js in
// ONE statement that survives to real JS at transpile time -- unlike a named `export type { ... }`
// block, which erases to zero runtime code and so cannot ever carry a coverage hit (every member
// line reads DA:<line>,0 forever, a false debt this file must not carry). Falsifier:
// test/ledger-union.test.ts imports straight from ledger-union.js; this file has no test of its
// own because it re-exports, verbatim, a surface that module already covers.
export * from "./ledger-union.js";
