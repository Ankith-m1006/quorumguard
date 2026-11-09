// Re-score every DAO from the cached raw proposals (results/raw/*.json.gz) with the current rules. No proposal fetching.
// Usage: node scripts/rescore.js   -> results/scan-summary.json + results/rescore-blocks.json (approved BLOCKs, compact)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { checkAll } from "../src/guard.js";
const RAW = "results/raw";
const sum = { when: new Date().toISOString(), daos: 0, daosWithProposals: 0, proposals: 0, tally: { CLEAN: 0, WARN: 0, BLOCK: 0 }, families: {}, approvedBlocked: 0 };
const approvedBlocks = [];
for (const f of fs.readdirSync(RAW).filter((x) => x.endsWith(".json.gz"))) {
  const ctx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, f))).toString("utf-8"));
  sum.daos++; if (ctx.proposals.length) sum.daosWithProposals++;
  for await (const { proposal: p, report: r } of checkAll(ctx)) {
    if (!r) continue;
    sum.proposals++; sum.tally[r.verdict]++;
    for (const x of r.findings) if (x.severity !== "info") sum.families[`${x.severity}:${x.family}`] = (sum.families[`${x.severity}:${x.family}`] || 0) + 1;
    if (r.verdict === "BLOCK" && p.status === "Approved") {
      sum.approvedBlocked++;
      approvedBlocks.push({ dao: ctx.dao, id: p.id, type: r.type, says: String(p.description).slice(0, 200), does: r.does, why: r.findings.filter((x) => x.severity === "block").map((x) => x.why) });
    }
  }
}
fs.writeFileSync("results/scan-summary.json", JSON.stringify(sum, null, 2));
fs.writeFileSync("results/rescore-blocks.json", JSON.stringify(approvedBlocks));
console.log(JSON.stringify(sum));
