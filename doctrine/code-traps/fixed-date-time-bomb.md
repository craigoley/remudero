- **A fixed date constant compared against rows stamped at REAL time is a time bomb; the signature
  is a red beginning at a clock boundary with no diff involved.** Compare the last green run's
  timestamp against the first red one before blaming a change. Stamp through the injected clock at
  the write seam; moving the constant only re-arms it. *(#2250)*
