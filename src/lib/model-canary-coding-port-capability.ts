/** Process-local branding for the app-owned coding executor port. Never deserialize this authority. */
const qualifiedPorts = new WeakSet<Function>();

/** Only the native owner adapter registers its closure after binding the owner CAS and backend profile. */
export function registerQualifiedCodingExecutionPort<T extends Function>(port: T): T {
  qualifiedPorts.add(port);
  return port;
}

/** Schedule and runner gate: JSON-shaped flags and arbitrary callbacks are never qualified. */
export function isQualifiedCodingExecutionPort<T>(value: T): value is T & Function {
  return typeof value === "function" && qualifiedPorts.has(value);
}
