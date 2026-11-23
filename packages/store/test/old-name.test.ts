import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultProjectsRoot, readOldSettings } from "../src/index.js";

it("settings under the old name work, and the new name wins", () => {
  const env: NodeJS.ProcessEnv = { KARIGOR_TOKEN: "old", KARIGOR_URL: "old", NIRMITO_URL: "new", KARIGOR_TIER: "cheap", NIRMITO_TIER: "", KARIGOR_EDITOR_ORIGIN: "o" };
  readOldSettings(env);
  expect(env).toMatchObject({ NIRMITO_TOKEN: "old", NIRMITO_URL: "new", NIRMITO_TIER: "cheap" });
  expect(env["NIRMITO_EDITOR_ORIGIN"]).toBeUndefined();
});

it("projects made under the old name stay where they are found", async () => {
  const home = await mkdtemp(join(tmpdir(), "nirmito-home-"));
  expect(defaultProjectsRoot(home)).toBe(join(home, ".nirmito", "projects"));
  await mkdir(join(home, ".karigor", "projects"), { recursive: true });
  expect(defaultProjectsRoot(home)).toBe(join(home, ".karigor", "projects"));
});
