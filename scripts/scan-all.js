// Scan every proposal of every Sputnik DAO on mainnet (2,098 DAOs). Read-only, public RPC, throttled, resumable.
// Usage: node scripts/scan-all.js [concurrency=2]
// Writes results/scan/<dao>.json per DAO and results/scan-summary.json at the end.
import fs from "node:fs";
import path from "node:path";
import { checkAll, loadDao } from "../src/guard.js";
import { view } from "../src/near.js";

import zlib from "node:zlib";
const OUT = process.env.SCAN_OUT || "results/scan";
const RAW = "results/raw"; // gzipped proposals + policy per DAO, so rules can be re-scored offline (scripts/rescore.js)
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });
const CONC = Number(process.argv[2] || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const daos = await view("sputnik-dao.near", "get_dao_list", {});
console.error(`DAOs: ${daos.length}`);
let next = 0, done = 0, failed = 0;

async function scanDao(dao) {
  const file = path.join(OUT, `${dao}.json`);
  if (fs.existsSync(file)) return "skip";
  const rawFile = path.join(RAW, `${dao}.json.gz`);
  const ctx = fs.existsSync(rawFile) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile)).toString("utf-8")) : await loadDao(dao, { history: 100000 });
  if (!fs.existsSync(rawFile)) fs.writeFileSync(rawFile, zlib.gzipSync(JSON.stringify(ctx)));
  const tally = { CLEAN: 0, WARN: 0, BLOCK: 0 }, families = {}, flagged = [];
  for await (const { proposal: p, report: r } of checkAll(ctx)) {
    if (!r) continue;
    tally[r.verdict]++;
    for (const f of r.findings) if (f.severity !== "info") families[`${f.severity}:${f.family}`] = (families[`${f.severity}:${f.family}`] || 0) + 1;
    if (r.verdict !== "CLEAN") flagged.push({
      id: p.id, status: p.status, verdict: r.verdict, type: r.type, does: r.does,
      says: String(p.description).slice(0, 300), time: p.submission_time,
      why: r.findings.filter((f) => f.severity !== "info").map((f) => `${f.severity}: ${f.why}`),
    });
  }
  fs.writeFileSync(file, JSON.stringify({ dao, proposals: ctx.proposals.length, lastId: ctx.last, tally, families, flagged }));
  return ctx.proposals.length;
}

async function worker() {
  while (next < daos.length) {
    const dao = daos[next++];
    try {
      const n = await scanDao(dao);
      done++;
      if (n !== "skip" && done % 10 === 0) console.error(`${done}/${daos.length} done (${failed} failed) last ${dao}: ${n}`);
    } catch (e) {
      failed++;
      fs.appendFileSync(path.join(OUT, "_errors.log"), `${dao}\t${String(e.message).slice(0, 160)}\n`);
    }
    await sleep(150);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// Summary across all scanned DAOs.
const all = fs.readdirSync(OUT).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf-8")));
const sum = { when: new Date().toISOString(), daos: all.length, daosWithProposals: all.filter((d) => d.proposals).length, proposals: 0, tally: { CLEAN: 0, WARN: 0, BLOCK: 0 }, families: {}, approvedBlocked: 0 };
for (const d of all) {
  sum.proposals += d.proposals;
  for (const k in d.tally) sum.tally[k] += d.tally[k];
  for (const k in d.families) sum.families[k] = (sum.families[k] || 0) + d.families[k];
  sum.approvedBlocked += d.flagged.filter((f) => f.verdict === "BLOCK" && f.status === "Approved").length;
}
fs.writeFileSync(process.env.SCAN_SUMMARY || "results/scan-summary.json", JSON.stringify(sum, null, 2));
console.error("SUMMARY", JSON.stringify(sum));
