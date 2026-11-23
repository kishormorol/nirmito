import type { JourneyCounts } from "./types.js";

interface PwError {
  message?: string;
  location?: { file?: string; line?: number };
}
interface PwResult {
  status?: string;
  error?: PwError;
  errors?: PwError[];
}
interface PwSpec {
  title: string;
  file?: string;
  ok?: boolean;
  tests?: { status?: string; projectName?: string; results?: PwResult[] }[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

// Playwright colours its messages; the person and the planner read plain text.
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/**
 * Where a failed journey got stuck: the test line and what it was waiting for. A timeout's first line says only
 * "Test timeout of 30000ms exceeded"; the step it hung on is in the call log of a later error.
 */
function stuckAt(errors: PwError[]): string {
  const line = errors.find((e) => e.location?.line)?.location?.line;
  const waiting = errors.flatMap((e) => plain(e.message ?? "").split("\n")).map((l) => l.trim()).find((l) => /^- waiting for /.test(l));
  if (!line && !waiting) return "";
  return ` Stuck${line ? ` at line ${line}` : ""}${waiting ? `, ${waiting.slice(2)}` : ""}.`;
}

/** Playwright's JSON reporter output: a journey passes when every retry of it ended expected. */
export function parsePlaywrightJson(report: string): JourneyCounts {
  let j: { suites?: PwSuite[]; errors?: { message?: string }[] };
  try {
    j = JSON.parse(report);
  } catch {
    return { passed: 0, failed: 0, failures: [] };
  }
  const out: JourneyCounts = { passed: 0, failed: 0, failures: [] };
  const walk = (suite: PwSuite, trail: string[]) => {
    const here = suite.title && !suite.title.endsWith(".ts") ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      // One journey is listed once with a test per screen size (older versions list it once per size); each is a run.
      const runs = (spec.tests ?? []).filter((t) => t.status !== "skipped");
      const bad = runs.filter((t) => t.status !== "expected" && t.status !== "flaky");
      out.passed += runs.length - bad.length;
      out.failed += bad.length;
      if (!bad.length) continue;
      const result = bad.flatMap((t) => t.results ?? []).find((r) => r.status !== "passed" && r.status !== "skipped");
      // Which size failed matters when the other one passed.
      const sizes = bad.length < runs.length ? bad.map((t) => t.projectName).filter(Boolean).join(", ") : "";
      const message = plain(result?.error?.message ?? result?.errors?.[0]?.message ?? result?.status ?? "failed").split("\n").find((l) => l.trim()) ?? "failed";
      const where = stuckAt([...(result?.error ? [result.error] : []), ...(result?.errors ?? [])]);
      out.failures.push(`${spec.file ?? suite.file ?? ""} › ${[...here, spec.title].join(" › ")}${sizes ? ` (${sizes} only)` : ""}: ${message.trim().slice(0, 300)}${where.slice(0, 200)}`);
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of j.suites ?? []) walk(s, []);
  // A config or compile error stops every journey before it starts.
  if (out.passed + out.failed === 0 && j.errors?.length) {
    out.failed = 1;
    out.failures.push(`the journeys could not start: ${plain(j.errors[0]?.message ?? "").split("\n")[0]?.slice(0, 300)}`);
  }
  return out;
}
