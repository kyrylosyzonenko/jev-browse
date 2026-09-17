#!/usr/bin/env node
// Jev picks which element to click or which given text to type, code runs agent-browser. Usage:
//   node --env-file-if-exists=.env jev-browse.mjs "<goal>" [start-url] [--text name=value]... [--steps N] [--done 0.8] [--no-network-wait]
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { TypeSafeClient } from "@typesafe-ai/sdk";

// Exit code 4 separates crashes, such as a missing API key, from a normal stop.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(4);
});

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    steps: { type: "string", default: "15" },
    done: { type: "string", default: "0.8" },
    text: { type: "string", multiple: true, default: [] },
    "no-network-wait": { type: "boolean", default: false },
  },
});
const [goal, startUrl] = positionals;
const texts = Object.fromEntries(values.text.map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]));
if (!goal || values.text.some((t) => !(t.indexOf("=") > 0))) {
  console.error('usage: jev-browse "<goal>" [start-url] [--text name=value]... [--steps N] [--done 0.8] [--no-network-wait]');
  process.exit(2);
}

// Jev's Choice accepts at most 255 options; one slot per chunk is reserved for "none".
const CHUNK = 254;
const CLICKABLE = new Set(["link", "button", "tab", "menuitem", "checkbox", "radio", "switch", "option"]);
const TYPEABLE = new Set(["textbox", "searchbox", "combobox"]);
const typing = Object.keys(texts).length > 0;
const ab = (...args) => execFileSync("agent-browser", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const client = new TypeSafeClient();

// Facts about the driver, sent as state so every question judges against the same limits.
const AGENT = {
  can: [
    "Click one link, button, tab, menu item, checkbox, radio button, switch, or list option per step",
    "Go back to the previous page",
    "See every element on the page through the accessibility snapshot, so scrolling is never needed",
    ...(typing ? ["Type any value from `texts` into a text box, then press Enter"] : []),
  ],
  cannot: [
    typing
      ? "Type anything that isn't in `texts`, or enter URLs"
      : "Type text, so it can't use search boxes, fill forms, or enter URLs",
    typing
      ? "Log in without a username and password in `texts`, create accounts, or solve CAPTCHAs"
      : "Log in, create accounts, or solve CAPTCHAs",
    "Hover, drag, upload, or download files",
    "Write answers or summaries; it only navigates, and success means ending on the right page",
  ],
};

const pickQuestion = (criteria) => ({
  type: "choice",
  instructions: {
    task: "Pick the element to click next that makes the most progress toward `goal`.",
    rules: [
      "Only pick actions allowed by `agent.can`. Elements that lead to something in `agent.cannot`, such as a search button, don't help.",
      "Prefer a link whose target is the goal itself over links that only relate to it.",
      "`history` lists actions already made. Don't repeat an action that didn't get closer.",
      "Type a value from `texts` only into the box it belongs in. After typing, press Enter or click the submit button.",
      "If typing opened a list of suggestions, click the option that matches the typed value before moving to another box. Otherwise the site discards the value.",
      "A form field that already shows the right value is done. Don't type into it again.",
      "If a field shows a different value than the `texts` value typed into it earlier, the site reset it. Type the value again.",
    ],
  },
  criteria,
});

if (startUrl) ab("open", startUrl);
const history = [];

for (let step = 1; step <= Number(values.steps); step++) {
  const title = ab("get", "title").trim();
  const { origin: url, snapshot, refs } = JSON.parse(ab("snapshot", "-c", "--json")).data;
  const page = snapshot.slice(0, 20000);

  const candidates = Object.entries(refs)
    .filter(([, r]) => CLICKABLE.has(r.role) && r.name?.trim())
    .map(([ref, r]) => [ref, `${r.role}: ${r.name.trim().slice(0, 200)}`])
    .filter(([, label]) => !history.some((h) => h.url === url && h.action === label && !h.failed))
    // Same-label duplicates would split probability between identical options.
    .filter(([, label], i, all) => all.findIndex(([, l]) => l === label) === i);
  for (const [ref, r] of Object.entries(refs)) {
    if (!TYPEABLE.has(r.role)) continue;
    for (const name of Object.keys(texts)) {
      candidates.push([`type:${ref}:${name}`, `type \`texts.${name}\` into ${r.role}: ${r.name?.trim().slice(0, 200) ?? ""}`]);
    }
  }
  // Typing into a plain textbox already ends with Tab, so Enter would hit the next element.
  if (history.at(-1)?.url === url && history.at(-1).action.startsWith("type ") && !history.at(-1).action.includes(" into textbox:")) {
    candidates.push(["enter", "Press Enter to submit the text just typed"]);
  }
  candidates.push(["back", "Go back to the previous page"]);

  const state = { goal, agent: AGENT, texts, current_page: { url, title, snapshot: page }, history };
  const chunks = [];
  for (let i = 0; i < candidates.length; i += CHUNK) chunks.push(candidates.slice(i, i + CHUNK));

  // The done check, the blocked check, and every chunk run in parallel in one request.
  const questions = {
    done: {
      type: "noul",
      instructions: "Is `current_page` the page that `goal` asks to reach?",
      criteria: {
        true: "The page itself is the target, for example the article or section the goal names, and every value the goal names, such as a place, date, count, or sort order, shows on the page",
        false: "The page only mentions or links to the target, is a different page, or shows a value that differs from one the goal names",
      },
    },
    blocked: {
      type: "noul",
      instructions: "Does reaching `goal` from `current_page` require an action listed in `agent.cannot`?",
      criteria: {
        true: "Every route needs typing, logging in, or another action the agent cannot do",
        false: "A route of clicks and back steps could plausibly reach the goal",
      },
    },
  };
  chunks.forEach((c, i) => {
    questions[`pick${i}`] = pickQuestion({
      ...Object.fromEntries(c),
      none: "None of these elements makes progress toward the goal",
    });
  });
  const t0 = performance.now();
  const first = await client.systemOne({ state, questions });
  let jevMs = performance.now() - t0;
  let tokens = first.usage.input_tokens;

  const doneP = first.answers.done.noul;
  const blockedP = first.answers.blocked.noul;
  console.log(`[${step}] ${title} <${url}> done=${doneP.toFixed(2)} blocked=${blockedP.toFixed(2)} tokens=${first.usage.input_tokens}`);
  if (doneP >= Number(values.done)) {
    console.log("goal reached");
    process.exit(0);
  }
  if (blockedP >= Number(values.done)) {
    console.log("goal needs an action this agent can't do, stopping");
    process.exit(3);
  }

  let pick = first.answers.pick0;
  if (chunks.length > 1) {
    const finalists = chunks
      .map((_, i) => first.answers[`pick${i}`].choice)
      .filter((k) => k !== "none");
    const labels = Object.fromEntries(candidates);
    if (finalists.length < 2) {
      pick = { choice: finalists[0] ?? "none", confidence: 1 };
    } else {
      const second = await client.systemOne({
        state,
        questions: { pick: pickQuestion(Object.fromEntries(finalists.map((k) => [k, labels[k]]))) },
      });
      pick = second.answers.pick;
      jevMs = performance.now() - t0;
      tokens += second.usage.input_tokens;
    }
  }

  const label = Object.fromEntries(candidates)[pick.choice] ?? "none";
  console.log(`    -> ${pick.choice} (${label}) confidence=${pick.confidence.toFixed(2)} jev=${Math.round(jevMs)}ms extra_tokens=${tokens - first.usage.input_tokens}`);
  if (pick.choice === "none") {
    console.log("no useful action on this page, stopping");
    process.exit(1);
  }

  history.push({ url, action: label });
  try {
    if (pick.choice === "back") {
      ab("back");
    } else if (pick.choice === "enter") {
      ab("press", "Enter");
    } else if (pick.choice.startsWith("type:")) {
      const [ref, name] = [pick.choice.slice(5, pick.choice.indexOf(":", 5)), pick.choice.slice(pick.choice.indexOf(":", 5) + 1)];
      ab("fill", `@${ref}`, texts[name]);
      // Date pickers and similar fields commit a typed value only on blur. Tab blurs without submitting the form.
      if (refs[ref].role === "textbox") ab("press", "Tab");
    } else if (refs[pick.choice].role === "link") {
      // agent-browser clicks the center of the bounding box, which misses links that wrap onto two lines.
      const href = ab("get", "attr", `@${pick.choice}`, "href").trim();
      const target = URL.canParse(href, url) ? new URL(href, url) : null;
      target?.protocol.startsWith("http") ? ab("open", target.href) : ab("click", `@${pick.choice}`);
    } else {
      ab("click", `@${pick.choice}`);
    }
  } catch (err) {
    // The page can change between the snapshot and the action, so a stale element is retried on a fresh snapshot.
    console.log(`    action failed: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
    history.at(-1).failed = true;
  }
  ab("wait", "--load", "load");
  // Single-page apps change routes without a new page load, so give the DOM a moment to settle.
  ab("wait", "250");
  // Background reloads after a click or a committed value overwrite fields typed before they end.
  if (!values["no-network-wait"]) {
    try {
      ab("wait", "--load", "networkidle");
    } catch {}
  }
}

console.log("step limit reached");
process.exit(1);
