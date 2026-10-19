import { ensureGitRepository } from "./git.mjs";

const CACHE_LIMIT = 500;
const roots = new Map();

// Progress updates resolve the workspace root for every state write. Caching
// keeps the synchronous `git rev-parse` out of that hot path.
export function resolveWorkspaceRoot(cwd) {
  const key = String(cwd ?? ".");
  const cached = roots.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let root = key;
  try {
    root = ensureGitRepository(key);
  } catch {
    root = key;
  }
  if (roots.size >= CACHE_LIMIT) {
    roots.delete(roots.keys().next().value);
  }
  roots.set(key, root);
  return root;
}

export function clearWorkspaceRootCache() {
  roots.clear();
}
