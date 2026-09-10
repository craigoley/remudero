- **(e) A CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS IS THE RIGHT ONE
  — AND RE-RUNNING THE SAME WAY IS NOT A SECOND OPINION.** (a)-(d) are all ZEROS; THIS ONE IS A
  CONFIDENT NON-ZERO, which is why the section's own framing does not catch it. MEASURED 2026-08-13:
  `tsc` reported four `api-client` errors in a container; re-running on a CLEAN TREE got the IDENTICAL
  FOUR, read as pre-existing. **THAT CONTROLLED FOR THE TREE AND NOT FOR THE ENVIRONMENT** — a RELATIVE
  `node_modules` symlink resolved outside that container's mount set, and CI was green throughout.
  AN ENVIRONMENTAL DEFECT REPRODUCES EXACTLY, so agreement between two readings
  taken the same way is one measurement performed twice, and the confidence it buys is counterfeit.
  THE CHECK: when a result surprises you, RE-RUN IT SOMEWHERE ELSE before believing it — a second
  host, CI's own logs, or a differently-provisioned container. Vary the ENVIRONMENT, not just the
  input. CHEAPEST INSTANCE: `readlink -f <workspace-symlink>` prints EMPTY when the target sits
  outside the mount set, which would have settled it in seconds. *(2026-08-13)*
