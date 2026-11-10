// QuorumGuard web: one page, three JSON endpoints, no dependencies.
//   GET /api/check?dao=<account>&id=<n>   live check of a real proposal (mainnet or testnet)
//   GET /api/redteam                       the red-team suite through the code layer (+ recorded AI runs if present)
//   GET /api/wild                          the real-DAO study
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiClaimsCheck } from "./aicheck.js";
import { checkProposal, loadDao, verdictOf } from "./guard.js";
import { decodeProposal } from "./decode.js";
import { ftMetadata, view } from "./near.js";
import { aiConfigured, attestation } from "./nearai.js";
import { runDeterministic } from "../redteam/offline-check.js";
import { state as live, tick } from "./watch.js";
import { pollCommands, telegramConfigured, setChecker } from "./telegram.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");
const PORT = Number(process.env.PORT || 8080);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ACCOUNT_RE = /^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+(?:near|testnet)$/;

const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), "utf-8")); } catch { return null; } };

const cache = new Map(); // dao:id -> report (proposals don't change once voting ends; 10 min is plenty)
setChecker((dao, id) => liveCheck(dao, id));
async function liveCheck(dao, id) {
  const key = `${dao}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.value;
  const proposal = await view(dao, "get_proposal", { id });
  const ctx = await loadDao(dao, { history: 300, upTo: id + 1 });
  const report = await checkProposal(proposal, ctx);
  let ai = null;
  if (aiConfigured()) {
    try {
      const decoded = await decodeProposal(proposal, { network: ctx.network, ftMetadata });
      const r = await aiClaimsCheck(proposal.description, decoded);
      ai = r.ai; report.findings.push(...r.findings); report.verdict = verdictOf(report.findings);
    } catch (e) { ai = { error: String(e.message || e) }; }
  }
  const value = { report, proposal: { id: proposal.id, proposer: proposal.proposer, description: proposal.description, status: proposal.status, kind: proposal.kind, submission_time: proposal.submission_time }, ai };
  cache.set(key, { at: Date.now(), value });
  return value;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/check") {
      const dao = String(url.searchParams.get("dao") || "").trim().toLowerCase();
      const id = Number(url.searchParams.get("id"));
      if (!ACCOUNT_RE.test(dao) || !Number.isInteger(id) || id < 0) return send(res, 400, { error: "Give a DAO account (like build.sputnik-dao.near) and a proposal number" });
      return send(res, 200, await liveCheck(dao, id));
    }
    if (url.pathname === "/api/redteam") return send(res, 200, { code: runDeterministic(), ai: readJson("results/redteam-ai.json") });
    if (url.pathname === "/api/wild") return send(res, 200, { study: readJson("results/realworld.json"), cases: readJson("results/wild-cases.json") });
    if (url.pathname === "/api/feed") return send(res, 200, { lastTick: live.lastTick, cursor: live.cursor, blocksRead: live.blocksRead, items: live.feed.slice(0, 100), scan: readJson("results/scan-summary.json") });
    if (url.pathname === "/api/tick") {
      // Called every minute by a scheduler (or by the in-process loop below). Protected by TICK_SECRET when set.
      if (process.env.TICK_SECRET && req.headers["x-tick-secret"] !== process.env.TICK_SECRET) return send(res, 403, { error: "forbidden" });
      const r = await runTick();
      return send(res, 200, r);
    }
    if (url.pathname === "/api/health") return send(res, 200, { ai: aiConfigured(), model: aiConfigured() ? (await attestation().catch(() => null))?.model : null });
    // Static files from public/, never outside it.
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.normalize(path.join(root, "public", rel));
    if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const msg = String(e.message || e);
    send(res, /UNKNOWN_ACCOUNT|doesn't exist|does not exist|No proposal|panicked/i.test(msg) ? 404 : 502, { error: /UNKNOWN_ACCOUNT/.test(msg) ? "That DAO account does not exist" : /panicked|ERR_NO_PROPOSAL|No proposal/i.test(msg) ? "That proposal number does not exist in this DAO" : msg.slice(0, 200) });
  }
});

let ticking = null, tickStarted = 0;
async function runTick() {
  if (ticking && Date.now() - tickStarted < 150000) return ticking; // one tick at a time; a hung tick is dropped after 2.5 min
  tickStarted = Date.now();
  ticking = (async () => {
    await pollCommands().catch(() => {}); // answer the bot first, so /watch never waits behind block reading
    const r = await tick({ max: Number(process.env.TICK_MAX_BLOCKS || 400), budgetMs: Number(process.env.TICK_BUDGET_MS || 40000) });
    await pollCommands().catch(() => {});
    return { head: r.head, cursor: r.cursor, behind: r.behind, found: r.found.length, telegram: telegramConfigured() };
  })().finally(() => { ticking = null; });
  return ticking;
}
// Local / always-on mode: follow the chain in-process. On Cloud Run (min instances 0) a scheduler calls /api/tick.
if (process.env.WATCH === "1") (async function loop() { try { const r = await runTick(); setTimeout(loop, r.behind > 10 ? 500 : 4000); } catch { setTimeout(loop, 8000); } })();

server.listen(PORT, () => console.log(`quorumguard on http://localhost:${PORT}`));
