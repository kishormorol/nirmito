import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Nirmito was called Karigor. Settings under the old name keep working: each KARIGOR_X stands in for
 * NIRMITO_X where that is not given. Programs call this before they read any setting.
 */
export function readOldSettings(env: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (!v || !k.startsWith("KARIGOR_") || k === "KARIGOR_EDITOR_ORIGIN") continue;
    const now = `NIRMITO_${k.slice("KARIGOR_".length)}`;
    if (!env[now]) env[now] = v;
  }
}

/** Where projects live: the old folder for someone who already has one, so their projects stay in view. */
export function defaultProjectsRoot(home = homedir()): string {
  const old = join(home, ".karigor", "projects");
  return existsSync(old) ? old : join(home, ".nirmito", "projects");
}
