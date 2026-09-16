#!/usr/bin/env node
// Runs every case with Jev (jev-browse) and with Claude Code driving agent-browser, then prints a comparison table.
// Usage: node --env-file-if-exists=.env eval.mjs [runs-per-case] [--model sonnet] [--only jev|claude]
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string", default: "sonnet" }, only: { type: "string" } },
});
const RUNS = Number(positionals[0] ?? 1);
// TypeSafe input price; output tokens are free.
const JEV_USD_PER_TOKEN = 0.042 / 1e6;

// exit 0 = goal reached, 3 = agent reports it's blocked by something it can't do.
const CASES = [
  { goal: "reach the Wikipedia article about Jim Henson", start: "https://en.wikipedia.org/wiki/Rubber_duck", exit: 0, url: "/wiki/Jim_Henson" },
  { goal: "reach the Wikipedia article about Sesame Street", start: "https://en.wikipedia.org/wiki/Rubber_duck", exit: 0, url: "/wiki/Sesame_Street" },
  { goal: "open the IANA page that explains example domains", start: "https://example.com", exit: 0, url: "iana.org" },
  { goal: "open the Hacker News FAQ", start: "https://news.ycombinator.com", exit: 0, url: "newsfaq" },
  { goal: "open the documentation page for the Noul question type", start: "https://docs.typesafe.ai/introduction", exit: 0, url: "/primitives/noul" },
  { goal: "search Wikipedia for the exact phrase 'zebra crossing statistics 1987'", start: "https://en.wikipedia.org/wiki/Rubber_duck", exit: 3 },
  { goal: "log in to Hacker News and upvote the top story", start: "https://news.ycombinator.com", exit: 3 },
  { goal: "open the Wikipedia article about Kermit the Frog", start: "https://en.wikipedia.org/wiki/Rubber_duck", text: ["query=Kermit the Frog"], exit: 0, url: "/wiki/Kermit_the_Frog" },
  { goal: "search Wikipedia for the exact phrase in `texts.query` and open the search results page", start: "https://en.wikipedia.org/wiki/Rubber_duck", text: ["query=\"zebra crossing statistics 1987\""], exit: 0, url: "search=" },
  { goal: "log in, add the Sauce Labs Backpack and the Sauce Labs Bike Light to the cart, check out with the given name and postal code, and stop on the checkout overview page without clicking Finish", start: "https://www.saucedemo.com", text: ["username=standard_user", "password=secret_sauce", "first_name=Ada", "last_name=Lovelace", "postal_code=10115"], exit: 0, url: "checkout-step-two", expect: ["Sauce Labs Backpack", "Sauce Labs Bike Light"], steps: 20 },
];

const ab = (...args) => execFileSync("agent-browser", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const currentUrl = () => ab("get", "url").trim();

// Sites such as the demo shop keep the cart and login in the browser, so every run starts from empty storage.
function resetSite(c) {
  ab("open", c.start);
  ab("cookies", "clear");
  ab("storage", "local", "clear");
  ab("storage", "session", "clear");
}

function runJev(c) {
  const t0 = Date.now();
  const r = spawnSync("node", ["jev-browse.mjs", "--steps", String(c.steps ?? 10), ...(c.text ?? []).flatMap((t) => ["--text", t]), "--", c.goal, c.start], { encoding: "utf8" });
  const tokens = [...r.stdout.matchAll(/tokens=(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  return { exit: r.status, ms: Date.now() - t0, usd: tokens * JEV_USD_PER_TOKEN, log: r.stdout + r.stderr };
}

// Claude Code gets the same limits as Jev: agent-browser only, no entering URLs, only the given texts.
function runClaude(c) {
  ab("open", c.start);
  const texts = Object.fromEntries((c.text ?? []).map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]));
  const prompt = [
    `Goal: ${c.goal}`,
    `The browser is already open at ${c.start}. Control it only with agent-browser commands through Bash, for example \`agent-browser snapshot -i\`, \`agent-browser click @e1\`, \`agent-browser fill @e2 "text"\`, \`agent-browser press Enter\`, and \`agent-browser back\`.`,
    "Don't open URLs, run JavaScript, or change tabs.",
    Object.keys(texts).length
      ? `You may type only these texts: ${JSON.stringify(texts)}.`
      : "You may not type any text.",
    "Success means ending on the page the goal names. Don't write answers or summaries.",
    "When you are on that page, stop and reply with exactly RESULT: reached",
    "If the goal needs something you can't do, such as logging in or typing text you weren't given, stop and reply with exactly RESULT: blocked",
  ].join("\n");
  const t0 = Date.now();
  const r = spawnSync("claude", [
    "-p", prompt, "--model", values.model, "--output-format", "json",
    "--tools", "Bash", "--allowedTools", "Bash(agent-browser *)",
    "--disallowedTools", "Bash(agent-browser open *)", "Bash(agent-browser eval *)", "Bash(agent-browser tab *)",
    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--max-budget-usd", "2",
  ], { encoding: "utf8", cwd: "/tmp", timeout: 600_000 });
  let out = {};
  try {
    out = JSON.parse(r.stdout);
  } catch {}
  const reply = String(out.result ?? "");
  const exit = /RESULT: reached/.test(reply) ? 0 : /RESULT: blocked/.test(reply) ? 3 : 1;
  return { exit, ms: Date.now() - t0, usd: out.total_cost_usd ?? 0, log: reply || r.stdout + r.stderr };
}

const agents = { jev: runJev, claude: runClaude };
const rows = [];
for (const [name, run] of Object.entries(agents)) {
  if (values.only && values.only !== name) continue;
  for (const c of CASES) {
    for (let i = 1; i <= RUNS; i++) {
      resetSite(c);
      const res = run(c);
      const url = currentUrl();
      const page = c.expect ? ab("snapshot", "-c") : "";
      const ok = res.exit === c.exit && (!c.url || url.includes(c.url)) && (c.expect ?? []).every((t) => page.includes(t));
      rows.push({ agent: name, ok, ...res });
      console.log(`${ok ? "PASS" : "FAIL"} ${name} exit=${res.exit} ${(res.ms / 1000).toFixed(1)}s $${res.usd.toFixed(5)} ${c.goal} -> ${url}`);
      if (!ok) console.log(res.log.trimEnd().replace(/^/gm, "    "));
    }
  }
}

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
console.log(`\n| Agent | Passed | Median time per task | Total cost | Cost per task |\n| --- | --- | --- | --- | --- |`);
for (const name of Object.keys(agents)) {
  const r = rows.filter((x) => x.agent === name);
  if (!r.length) continue;
  const usd = r.reduce((s, x) => s + x.usd, 0);
  const label = name === "jev" ? "Jev + agent-browser" : `Claude Code (${values.model}) + agent-browser`;
  console.log(`| ${label} | ${r.filter((x) => x.ok).length}/${r.length} | ${(median(r.map((x) => x.ms)) / 1000).toFixed(1)} s | $${usd.toFixed(4)} | $${(usd / r.length).toFixed(5)} |`);
}
process.exit(rows.every((x) => x.ok) ? 0 : 1);
