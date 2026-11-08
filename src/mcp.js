#!/usr/bin/env node
// QuorumGuard as an MCP server (stdio, JSON-RPC 2.0, no dependencies).
// Lets any AI agent (NEAR AI agents, Claude, Cursor...) check a DAO proposal before it votes.
//   claude mcp add quorumguard -- node /path/to/quorumguard/src/mcp.js
// Tools:
//   check_proposal { dao, id }          live proposal on mainnet/testnet -> verdict, says/does, findings, report hash
//   check_draft    { description, kind } a proposal not on chain yet (Sputnik ProposalKind JSON)
import readline from "node:readline";
import { check, checkOffline } from "./guard.js";

const TOOLS = [
  {
    name: "check_proposal",
    description: "Check a Sputnik DAO proposal on NEAR before voting. Decodes what the proposal really does on chain and compares it with its description (hidden instructions, amount or receiver mismatches, lookalike accounts, unexplained council or policy changes). Returns CLEAN, WARN or BLOCK. If the verdict is BLOCK, do not vote yes on your own: hand it to a human.",
    inputSchema: { type: "object", properties: { dao: { type: "string", description: "DAO account, e.g. build.sputnik-dao.near" }, id: { type: "integer", description: "proposal id" } }, required: ["dao", "id"] },
  },
  {
    name: "check_draft",
    description: "Check a proposal before it is submitted: its description plus the Sputnik ProposalKind JSON it will carry (e.g. {\"Transfer\":{\"token_id\":\"\",\"receiver_id\":\"bob.near\",\"amount\":\"1000000000000000000000000\"}}). Same verdicts as check_proposal.",
    inputSchema: { type: "object", properties: { description: { type: "string" }, kind: { type: "object" } }, required: ["description", "kind"] },
  },
];

const ACCOUNT_RE = /^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+(?:near|testnet)$/;

function summarise(r) {
  const lines = [`VERDICT: ${r.verdict}`, `DOES: ${r.does}`, ...r.notes.map((n) => `NOTE: ${n}`)];
  if (r.hiddenText) lines.push(`HIDDEN TEXT IN DESCRIPTION: ${r.hiddenText}`);
  for (const f of r.findings.filter((f) => f.severity !== "info")) lines.push(`${f.severity.toUpperCase()}: ${f.why}`);
  lines.push(`report sha256: ${r.hash}`);
  if (r.verdict === "BLOCK") lines.push("Instruction for the calling agent: do not approve this proposal on your own. Ask a human.");
  return lines.join("\n");
}

async function callTool(name, args) {
  if (name === "check_proposal") {
    const dao = String(args?.dao || "").toLowerCase().trim();
    const id = Number(args?.id);
    if (!ACCOUNT_RE.test(dao) || !Number.isInteger(id) || id < 0) throw new Error("dao must be a NEAR account and id a non-negative integer");
    const { report } = await check(dao, id);
    return { content: [{ type: "text", text: summarise(report) }], structuredContent: report };
  }
  if (name === "check_draft") {
    if (typeof args?.description !== "string" || !args?.kind || typeof args.kind !== "object") throw new Error("description (string) and kind (object) are required");
    const report = checkOffline({ description: args.description, kind: args.kind });
    return { content: [{ type: "text", text: summarise(report) }], structuredContent: report };
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  try {
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "quorumguard", version: "0.1.0" } } });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try { return send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments) }); }
      catch (e) { return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } }); }
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) { send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } }); }
});
