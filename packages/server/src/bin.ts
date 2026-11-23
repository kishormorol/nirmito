#!/usr/bin/env node
import { defaultProjectsRoot, readOldSettings } from "@karigor/store";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { logMailer, resendMailer } from "./mail.js";
import { PaddleProvider, SslCommerzProvider, type PaymentProvider } from "./billing.js";

// Docker Compose passes a setting nobody gave as an empty string; that means not set.
for (const [k, v] of Object.entries(process.env)) if (v === "" && /^(NIRMITO_|PADDLE_|SSLCOMMERZ_|RESEND_|ANTHROPIC_|VERCEL_TOKEN|PORT$)/.test(k)) delete process.env[k];

/** The payment providers whose settings are present. */
function billingFromEnv(publicUrl: string): { billing?: { providers: PaymentProvider[]; packs: number[] } } {
  const e = process.env;
  const sandbox = e["NIRMITO_PAYMENTS_SANDBOX"] === "1";
  const providers: PaymentProvider[] = [];
  if (e["PADDLE_API_KEY"] && e["PADDLE_PRODUCT_ID"] && e["PADDLE_WEBHOOK_SECRET"]) providers.push(new PaddleProvider({ apiKey: e["PADDLE_API_KEY"], productId: e["PADDLE_PRODUCT_ID"], webhookSecret: e["PADDLE_WEBHOOK_SECRET"], sandbox }));
  if (e["SSLCOMMERZ_STORE_ID"] && e["SSLCOMMERZ_STORE_PASSWORD"]) providers.push(new SslCommerzProvider({ storeId: e["SSLCOMMERZ_STORE_ID"], storePassword: e["SSLCOMMERZ_STORE_PASSWORD"], bdtPerUsd: Number(e["NIRMITO_BDT_PER_USD"] ?? 122), publicUrl, sandbox }));
  if (!providers.length) return {};
  const packs = (e["NIRMITO_CREDIT_PACKS"] ?? "5,10,25").split(",").map(Number).filter((n) => n > 0);
  return { billing: { providers, packs } };
}
import { People } from "./people.js";
import { createNirmitoServer } from "./server.js";

readOldSettings();

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: process.env["NIRMITO_ROOT"] ?? defaultProjectsRoot() },
    port: { type: "string", default: process.env["PORT"] ?? "4321" },
    host: { type: "string", default: process.env["NIRMITO_HOST"] ?? "127.0.0.1" },
    adapter: { type: "string", default: process.env["NIRMITO_ADAPTER"] ?? "claude-code" },
    deploy: { type: "string", default: process.env["NIRMITO_DEPLOY"] ?? "local" },
    profile: { type: "string", default: "web-app" },
    "app-port": { type: "string", default: process.env["NIRMITO_APP_PORT"] ?? "3000" },
    help: { type: "boolean", default: false },
  },
});

if (v.help) {
  console.log(`nirmito-server: the chat UI over Nirmito

  --root <dir>       where projects live (NIRMITO_ROOT)
  --port <n>         port for the UI (PORT, default 4321)
  --host <addr>      address to listen on (NIRMITO_HOST, default 127.0.0.1)
  --adapter <name>   claude-code, claude, ollama or demo (NIRMITO_ADAPTER)
  --deploy <target>  local, vercel, netlify, cloudflare or none (NIRMITO_DEPLOY)
  --app-port <n>     port of the live app on the local target (NIRMITO_APP_PORT)

Set NIRMITO_TOKEN to require an access link (/?token=...). Required when the host is not 127.0.0.1.
That link sees every project. To give someone their own sign-in, which sees only their projects:

  nirmito-server add-person "<name>"   prints their link (NIRMITO_URL sets its address)
  NIRMITO_SIGNUP=open                  anyone who opens the page signs up with a name

To host everyone's apps from here, each on its own port and kept running:
  NIRMITO_APPS_URL=https://a{port}.example.com   the address people use for each app
  NIRMITO_SERVE_APPS=1                           the same, at http://localhost:<port>

To run it as a service for many people (sign-in by email, credit for builds):
  NIRMITO_URL=https://karigor.example.com   this Nirmito's public address (needed for the emailed links)
  NIRMITO_EMAIL_SIGNIN=1                    people sign in with a one-time link sent to their email
  RESEND_API_KEY, NIRMITO_MAIL_FROM         send those emails through Resend (without them, links go to this log)
  NIRMITO_TRUST_PROXY=1                     a web server in front names callers (X-Forwarded-For); sign-in emails are limited per caller
  NIRMITO_WELCOME_CREDIT=1                  USD of credit for each new sign-up (with NIRMITO_SIGNUP=open)
  NIRMITO_METERED=20                        charge builds on this Nirmito's model key: cost plus this % margin
  NIRMITO_TIER=cheap                        which models build: cheap or best (default cheap when builds are charged for)
  NIRMITO_CREDIT_PACKS=5,10,25              the amounts (USD) people may buy
  PADDLE_API_KEY, PADDLE_PRODUCT_ID, PADDLE_WEBHOOK_SECRET   pay by card worldwide (webhook: <NIRMITO_URL>/api/billing/notice/paddle)
  SSLCOMMERZ_STORE_ID, SSLCOMMERZ_STORE_PASSWORD, NIRMITO_BDT_PER_USD   pay by bKash, Nagad or a Bangladeshi card
  NIRMITO_PAYMENTS_SANDBOX=1                use the providers' test systems`);
  process.exit(0);
}

if (positionals[0] === "add-person") {
  const name = positionals.slice(1).join(" ").trim();
  if (!name) {
    console.error('nirmito-server: add-person needs a name, as in add-person "Rahima"');
    process.exit(1);
  }
  const { token } = await new People(v.root!).add(name);
  const base = process.env["NIRMITO_URL"] ?? `http://localhost:${v.port}`;
  console.log(`Send ${name} this link. It is shown only once, and it opens only their own projects:\n${base.replace(/\/$/, "")}/?token=${token}`);
  process.exit(0);
}

const token = process.env["NIRMITO_TOKEN"];
const host = v.host!;
if (!token && host !== "127.0.0.1" && host !== "localhost" && process.env["NIRMITO_ALLOW_OPEN"] !== "1") {
  console.error("nirmito-server: listening beyond this computer needs NIRMITO_TOKEN (or NIRMITO_ALLOW_OPEN=1 if something else protects it)");
  process.exit(1);
}

// Apps let this page show them in its preview (their frame-ancestors); deploy targets pass this on.
process.env["KARIGOR_EDITOR_ORIGIN"] ??= new URL(process.env["NIRMITO_URL"] ?? `http://localhost:${v.port}`).origin;

const { server } = createNirmitoServer({
  root: v.root!,
  adapter: v.adapter!,
  deploy: v.deploy!,
  profile: v.profile!,
  appPort: Number(v["app-port"]),
  ...(token ? { token } : {}),
  signup: process.env["NIRMITO_SIGNUP"] === "open",
  trustProxy: process.env["NIRMITO_TRUST_PROXY"] === "1",
  ...(process.env["NIRMITO_EMAIL_SIGNIN"] === "1"
    ? {
        emailSignIn: {
          url: process.env["NIRMITO_URL"] ?? `http://localhost:${v.port}`,
          mailer: process.env["RESEND_API_KEY"] && process.env["NIRMITO_MAIL_FROM"] ? resendMailer({ apiKey: process.env["RESEND_API_KEY"], from: process.env["NIRMITO_MAIL_FROM"] }) : logMailer((l) => console.log(l)),
        },
      }
    : {}),
  ...billingFromEnv(process.env["NIRMITO_URL"] ?? `http://localhost:${v.port}`),
  ...(process.env["NIRMITO_WELCOME_CREDIT"] ? { welcomeCreditUsd: Number(process.env["NIRMITO_WELCOME_CREDIT"]) } : {}),
  ...(process.env["NIRMITO_TIER"] ? { tier: process.env["NIRMITO_TIER"] } : {}),
  ...(process.env["NIRMITO_METERED"] !== undefined ? { metered: { marginPct: Number(process.env["NIRMITO_METERED"]) || 0 } } : {}),
  ...(process.env["NIRMITO_APPS_URL"] || process.env["NIRMITO_SERVE_APPS"] === "1" ? { apps: process.env["NIRMITO_APPS_URL"] ? { url: process.env["NIRMITO_APPS_URL"] } : {} } : {}),
  log: (l) => console.log(l),
});
server.listen(Number(v.port), host, () => {
  const where = `http://${host === "0.0.0.0" ? "localhost" : host}:${v.port}`;
  console.log(`Nirmito is ready at ${where}${token ? "/?token=<your NIRMITO_TOKEN>" : ""} (${v.adapter} adapter, ${v.deploy} deploy)`);
});
