import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = __dirname;

/** Resolve a path relative to the repo root. */
export function repoPath(relativePath) {
  return path.resolve(REPO_ROOT, relativePath);
}
