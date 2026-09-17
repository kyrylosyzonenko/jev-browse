#!/usr/bin/env node
// MCP server over stdio that exposes jev-browse as one tool.
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const STATUS = { 0: "reached", 1: "stopped", 2: "bad input", 3: "blocked" };

const server = new McpServer({ name: "jev-browse", version: "0.1.0" });

server.registerTool(
  "browse",
  {
    description: [
      "Reach a page in a real browser. Jev picks each click, which given text to type into which box, and when to stop.",
      "Jev never writes text: put every search query or form value in `texts`. The texts are sent to TypeSafe.",
      "Success means ending on the page the goal names. Status: reached, stopped (no useful action or step limit), or blocked (the goal needs something the agent can't do, such as logging in).",
      "The browser stays open afterward, so agent-browser commands can read the final page.",
    ].join(" "),
    inputSchema: {
      goal: z.string().describe("The page to reach, for example 'open the Wikipedia article about Kermit the Frog'"),
      url: z.string().url().optional().describe("Page to open first; omit to continue from the current page"),
      texts: z.record(z.string().regex(/^[\w-]+$/), z.string()).optional().describe('Texts the agent may type, by name, for example {"query": "Kermit the Frog"}'),
      steps: z.number().int().min(1).max(50).optional().describe("Step limit, default 15"),
      networkWait: z.boolean().optional().describe("Wait for network activity to end after every action, default true. Turn off for speed on static sites."),
    },
  },
  async ({ goal, url, texts = {}, steps = 15, networkWait = true }) => {
    const args = [`--env-file-if-exists=${here(".env")}`, here("jev-browse.mjs"), "--steps", String(steps)];
    if (!networkWait) args.push("--no-network-wait");
    args.push(...Object.entries(texts).flatMap(([k, v]) => ["--text", `${k}=${v}`]));
    // "--" keeps a goal that starts with a dash from being read as an option.
    args.push("--", goal, ...(url ? [url] : []));
    const { code, stdout, stderr } = await new Promise((resolve) =>
      execFile(process.execPath, args, { maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr }),
      ),
    );
    let finalUrl = "unknown";
    try {
      if (code in STATUS) finalUrl = execFileSync("agent-browser", ["get", "url"], { encoding: "utf8" }).trim();
    } catch {}
    const text = `status: ${STATUS[code] ?? "error"}\nfinal url: ${finalUrl}\n\n${stdout}${stderr ? `\n${stderr}` : ""}`;
    return { content: [{ type: "text", text }], isError: !(code in STATUS) || code === 2 };
  },
);

await server.connect(new StdioServerTransport());
