import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { balanceOf, createNirmitoServer, People, type NirmitoServer, type Mailer } from "../src/index.js";

const open: NirmitoServer[] = [];
afterEach(async () => {
  for (const k of open.splice(0)) {
    await k.idle();
    await new Promise((r) => k.server.close(r));
  }
}, 120_000);

async function start(o: { signup?: boolean; metered?: boolean; welcome?: number; trustProxy?: boolean; adapter?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "karigor-accounts-"));
  const sent: { to: string; link: string }[] = [];
  const mailer: Mailer = async (to, link) => (sent.push({ to, link }), { ok: true, output: "sent" });
  const k = createNirmitoServer({
    root,
    adapter: o.adapter ?? "demo",
    token: "admin-token",
    ...(o.signup ? { signup: true } : {}),
    ...(o.trustProxy ? { trustProxy: true } : {}),
    emailSignIn: { url: "https://karigor.example.com", mailer },
    ...(o.welcome !== undefined ? { welcomeCreditUsd: o.welcome } : {}),
    ...(o.metered ? { metered: { marginPct: 20 } } : {}),
  });
  open.push(k);
  await new Promise<void>((r) => k.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(k.server.address() as AddressInfo).port}`;
  const call = async (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const res = await fetch(base + path, { ...init, redirect: "manual", headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown>, res };
  };
  /** Ask for a link, open it, and return the cookie this device got. */
  const signIn = async (email: string) => {
    expect((await call("/api/signin/email", { method: "POST", body: JSON.stringify({ email }) })).json).toEqual({ sent: true });
    const link = sent.at(-1)!.link;
    const r = await call(new URL(link).pathname + new URL(link).search);
    expect(r.status).toBe(302);
    return r.res.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { root, k, call, sent, signIn };
}

describe("sign-in by email", { timeout: 120_000 }, () => {
  it("sends a one-time link that signs this device in, makes the account with the welcome credit, and works once", async () => {
    const { call, sent, signIn } = await start({ signup: true, welcome: 1, metered: true });
    expect((await call("/api/config")).json).toMatchObject({ email: true, signup: true });
    const cookie = await signIn("Rina@Example.com");
    expect(sent[0]!.to).toBe("rina@example.com");
    expect(sent[0]!.link).toMatch(/^https:\/\/karigor\.example\.com\/\?login=[0-9a-f]{48}$/);
    const me = (await call("/api/config", { cookie })).json["me"];
    expect(me).toMatchObject({ admin: false, email: "rina@example.com", creditUsd: 1 });
    // the same link again does nothing
    const again = await call(new URL(sent[0]!.link).pathname + new URL(sent[0]!.link).search);
    expect(again.res.headers.get("location")).toBe("/?expired=1");
    // a second device gets its own sign-in; the first keeps working
    const other = await signIn("rina@example.com");
    expect(other).not.toBe(cookie);
    expect((await call("/api/config", { cookie })).status).toBe(200);
  });

  it("sends at most five links to one address in a while, answers the same after that, and limits one caller", async () => {
    const { call, sent } = await start({ signup: true, trustProxy: true });
    const ask = (email: string, from: string) => call("/api/signin/email", { method: "POST", body: JSON.stringify({ email }), headers: { "x-forwarded-for": from } });
    for (let i = 0; i < 7; i++) expect((await ask(i % 2 ? "rina@example.com" : "Rina@Example.com", "203.0.113.1")).json).toEqual({ sent: true });
    expect(sent.length).toBe(5);
    for (let i = 0; i < 13; i++) expect((await ask(`p${i}@example.com`, "203.0.113.1")).status).toBe(200);
    expect((await ask("one-more@example.com", "203.0.113.1")).status).toBe(429);
    // an address the caller made up does not help, since only the last one was added by the server in front
    expect((await ask("one-more@example.com", "198.51.100.9, 203.0.113.1")).status).toBe(429);
    expect((await ask("one-more@example.com", "203.0.113.2")).status).toBe(200);
  });

  it("does not let a made-up key build without credit where keys are not used", async () => {
    const { call, signIn } = await start({ signup: true, welcome: 0, metered: true, adapter: "ollama" });
    const cookie = await signIn("rina@example.com");
    const r = await call("/api/projects", { method: "POST", cookie, body: JSON.stringify({ idea: "A page for my shop", apiKey: "anything" }) });
    expect(r.status).toBe(402);
  });

  it("answers the same whether or not an address has an account, and makes none when sign-ups are closed", async () => {
    const { call, sent } = await start();
    expect((await call("/api/signin/email", { method: "POST", body: JSON.stringify({ email: "nobody@example.com" }) })).json).toEqual({ sent: true });
    expect(sent).toEqual([]);
    expect((await call("/api/signin/email", { method: "POST", body: JSON.stringify({ email: "not an email" }) })).status).toBe(400);
  });
});

describe("credit", { timeout: 120_000 }, () => {
  it("lets a build start only with credit left, unless the person brings their own key", async () => {
    const { call, signIn, root, k } = await start({ signup: true, welcome: 0, metered: true });
    const cookie = await signIn("sam@example.com");
    const none = await call("/api/projects", { method: "POST", cookie, body: JSON.stringify({ idea: "A tool library" }) });
    expect(none.status).toBe(402);
    expect(none.json["error"]).toMatch(/credit has run out/);
    // with their own key it starts
    const own = await call("/api/projects", { method: "POST", cookie, body: JSON.stringify({ idea: "A tool library", apiKey: "sk-ant-test-not-real" }) });
    expect(own.status).toBe(201);
    await k.idle();
    // after buying credit it starts on this Nirmito's key
    const people = new People(root);
    const p = (await people.all()).find((x) => x.email === "sam@example.com")!;
    expect(await people.addCredit(p.id, 5, "pay_1")).toBe(true);
    expect(await people.addCredit(p.id, 5, "pay_1")).toBe(false);
    expect((await call("/api/config", { cookie })).json["me"]).toMatchObject({ creditUsd: 5 });
    expect((await call("/api/projects", { method: "POST", cookie, body: JSON.stringify({ idea: "A tool library" }) })).status).toBe(201);
  });

  it("counts what builds used, with the margin, against what was bought", async () => {
    const root = await mkdtemp(join(tmpdir(), "karigor-credit-"));
    const people = new People(root);
    const { person } = await people.add("Sam", { email: "sam@example.com", creditUsd: 2 });
    await people.charge(person.id, 0.75);
    await people.charge(person.id, -1);
    const now = (await people.byId(person.id))!;
    expect(balanceOf(now)).toBe(1.25);
    await expect(people.addCredit(person.id, 0, "x")).rejects.toThrow(/more than zero/);
  });
});
