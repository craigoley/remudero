- **(i) A POSITIVE CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS COVERS THE
  WINDOW.** The (a)-(f) family above all catch a query that cannot read. This one reads perfectly and
  still answers about the wrong period: `"step":"risk_judge.decision"` read 87 rows across the union
  (gz 64 / plain 23 / live 0) — control fires — while `rate_limited_rest_merge` read 0 because the
  corpus's newest row is 2026-08-12 and the feature merged 2026-08-23. Before acting on a ledger
  zero, print the corpus's NEWEST ts beside the event's own date; a control says nothing about that
  gap. *(W1-T1280/#2651)*
