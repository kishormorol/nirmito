import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { noopCommitter } from "@karigor/store";
import { FakeSandbox } from "@karigor/gates";
import type { ModelAdapter, ModelRequest } from "@karigor/runtime";
import { createProject, pausedForCredit, runProject } from "../src/index.js";
import { scriptedAdapter } from "../src/demo.js";

/** The scripted answers, billed as a paid model. */
function paid(): ModelAdapter {
  const inner = scriptedAdapter();
  const model = "claude-sonnet-5-5";
  return { name: "claude", modelFor: () => model, complete: async <T>(req: ModelRequest<T>) => ({ ...(await inner.complete(req)), model }) };
}

it("pauses before a call the person cannot pay for, spends nothing more, and carries on once credit is added", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "karigor-credit-run-"));
  const projectId = await createProject(root, "A site where neighbours lend tools", { committer: noopCommitter, projectId: "p1" });
  let left = 0.3;
  let calls = 0;
  const credit = { left: () => left, used: (usd: number) => { left -= usd; calls++; } };
  const opts = { root, projectId, adapter: paid(), sandbox: new FakeSandbox(), committer: noopCommitter, tier: "best" as const, credit };
  const paused = await runProject(opts);
  expect(pausedForCredit(paused)).toBe(true);
  expect(left).toBeGreaterThanOrEqual(0);
  expect(paused.failures).toBe(0);
  const before = calls;
  // trying again without credit spends nothing
  expect(pausedForCredit(await runProject({ ...opts, credit: { ...credit, left: () => 0 } }))).toBe(true);
  expect(calls).toBe(before);
  left = 50;
  // Everything gets built; the release itself needs a deploy target, which this run has none of.
  const done = await runProject(opts);
  expect(done.phase).toBe("release");
  expect(["b1", "b2", "b3"].map((i) => done.items[i]?.status)).toEqual(["done", "done", "done"]);
  expect(calls).toBeGreaterThan(before);
});
