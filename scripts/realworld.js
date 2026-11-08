// False-alarm study: run QuorumGuard over every proposal of real mainnet DAOs and count verdicts.
// Usage: node scripts/realworld.js dao1.sputnik-dao.near dao2... > results/realworld.json
import { checkProposal, loadDao } from "../src/guard.js";
const daos = process.argv.slice(2);
const out = { when: new Date().toISOString(), daos: {} };
// "dao.sputnik-dao.near:1500" studies only the latest 1500 proposals.
for (const spec of daos) {
  const [dao, n] = spec.split(":");
  let ctx;
  try { ctx = await loadDao(dao, { history: Number(n) || 100000 }); } catch (e) { console.error(dao, "skipped:", e.message); continue; }
  const tally = { CLEAN: 0, WARN: 0, BLOCK: 0 }, byFamily = {}, blocks = [];
  for (const p of ctx.proposals) {
    let r;
    try { r = await checkProposal(p, ctx); } catch (e) { continue; }
    tally[r.verdict]++;
    for (const f of r.findings) byFamily[`${f.severity}:${f.family}`] = (byFamily[`${f.severity}:${f.family}`] || 0) + 1;
    if (r.verdict === "BLOCK") blocks.push({ id: p.id, status: p.status, says: p.description.slice(0, 160), does: r.does, why: r.findings.filter((f) => f.severity === "block").map((f) => f.why) });
  }
  out.daos[dao] = { proposals: ctx.proposals.length, tally, byFamily, blocks };
  console.error(dao, ctx.proposals.length, tally);
}
console.log(JSON.stringify(out, null, 2));
