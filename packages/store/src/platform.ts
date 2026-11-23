import { execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import crossSpawn from "cross-spawn";

const exec = promisify(execFile);
const WINDOWS = process.platform === "win32";
/** Windows' own tools by full path, so a program of the same name earlier on PATH is never run instead. */
const system32 = (exe: string) => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", exe);

/**
 * Starts a program by name. On Windows npm's programs (pnpm, vercel, netlify, wrangler) are `.cmd` files,
 * which Node cannot start by name; this finds them and quotes their arguments.
 */
export function start(cmd: string, args: string[], options: SpawnOptions): ChildProcess {
  return crossSpawn(cmd, args, { windowsHide: true, ...options });
}

/** Stops a process and everything it started. `group`: it was started detached, so on POSIX it leads its own group. */
export function stopTree(child: ChildProcess, signal: NodeJS.Signals, group = true): void {
  if (child.pid === undefined) return;
  if (WINDOWS) {
    // Windows has no polite stop for a process without a window, and no groups: the whole tree is ended.
    execFile(system32("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (e) => {
      if (e) child.kill();
    });
    return;
  }
  try {
    if (group) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

let sid: Promise<string> | undefined;
/** This user's id in Windows. Names are not used: what USERDOMAIN says is not always an account's domain. */
function mySid(): Promise<string> {
  return (sid ??= exec(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true }).then(({ stdout }) => {
    const found = /"(S-[\d-]+)"/.exec(stdout)?.[1];
    if (!found) throw new Error("Windows did not say who this user is");
    return found;
  }));
}

/**
 * Leaves a file readable by this user alone. Windows has no file modes, so there the file's inherited
 * permissions are replaced with one entry for this user.
 */
export async function ownerOnly(file: string): Promise<void> {
  if (!WINDOWS) return chmod(file, 0o600);
  await exec(system32("icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${await mySid()}:F`], { windowsHide: true }).catch((e: Error & { stderr?: string }) => {
    throw new Error(`could not make ${file} private: ${e.stderr?.trim() || e.message}`);
  });
}
