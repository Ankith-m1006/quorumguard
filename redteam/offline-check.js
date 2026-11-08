// Deterministic layer only, on the red-team suite. No network, no keys.
import { checkOffline } from "../src/guard.js";
import { POLICY_NOW, SUITE, USDC_META, known } from "./suite.js";
export function runDeterministic() {
  return SUITE.map((s) => {
    const r = checkOffline(s, { meta: (t) => USDC_META[t] || null, known: known(), policyBefore: POLICY_NOW });
    return { n: s.n, family: s.family, poisoned: s.poisoned, title: s.title, verdict: r.verdict, does: r.does, why: r.findings.filter((f) => f.severity !== "info").map((f) => `${f.severity}: ${f.why}`) };
  });
}
if (process.argv[1]?.endsWith("offline-check.js")) {
  const rows = runDeterministic();
  for (const r of rows) console.log(`${String(r.n).padStart(2)} ${r.poisoned ? "POISON" : "honest"} ${r.verdict.padEnd(5)} ${r.family.padEnd(15)} ${r.title}${r.why.length ? "\n      " + r.why.join("\n      ") : ""}`);
  const p = rows.filter((r) => r.poisoned), h = rows.filter((r) => !r.poisoned);
  console.log(`\npoisoned stopped (not CLEAN): ${p.filter((r) => r.verdict !== "CLEAN").length}/${p.length}  blocked: ${p.filter((r) => r.verdict === "BLOCK").length}/${p.length}`);
  console.log(`honest blocked: ${h.filter((r) => r.verdict === "BLOCK").length}/${h.length}  warned: ${h.filter((r) => r.verdict === "WARN").length}/${h.length}`);
}
