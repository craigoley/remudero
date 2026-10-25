import { createHash } from "node:crypto";
import { join } from "node:path";

export function productStatePaths(root: string, actor: string) {
  const ownerKey = createHash("sha256").update(actor).digest("hex");
  const directory = join(root, "state", "products", "v1");
  return { directory, state: join(directory, `${ownerKey}.json`), locks: join(directory, "locks"), ownerKey };
}

export class ProductIntentStore {
  constructor(_options: { root?: string; sync?: (fd: number) => void; limits?: { maxProducts?: number; maxRequests?: number; maxStateBytes?: number } }) {}
  write(_actor: string, _command: unknown): never { throw new Error("product store not implemented"); }
  read(_actor: string, _id: string): never { throw new Error("product store not implemented"); }
  list(_actor: string): never { throw new Error("product store not implemented"); }
  receipt(_actor: string, _requestId: string): never { throw new Error("product store not implemented"); }
}
