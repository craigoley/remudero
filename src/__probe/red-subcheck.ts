// W1-T24b live proof (acceptance criterion 3): a deliberately RED sub-check
// must HOLD the merge closed. This file is a planted typecheck failure — it
// makes the required `ci` job (in ci-gate.yml's REQUIRED list) fail on
// purpose, so ci-gate concludes failure and branch protection blocks the
// merge. Proof captured, then this probe PR is closed WITHOUT merging (never
// reverted-on-main — it never lands).
const deliberateTypeError: number = "this is a string, not a number";
export default deliberateTypeError;
