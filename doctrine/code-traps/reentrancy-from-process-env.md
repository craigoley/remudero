- **Read re-entrancy from `process.env`, not an injected `env` argument — a spawn writes a child's
  environment and cannot reach a parameter.** A caller passing `{}` saw no loop guard; `isCiEnv({})`
  is false for the same reason. *(#2248)*
