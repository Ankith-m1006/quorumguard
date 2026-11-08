#!/usr/bin/env node
// quorumguard check <dao> <proposal-id>   e.g. node src/cli.js check marketing.sputnik-dao.near 275
import { check } from "./guard.js";
const [cmd, dao, id] = process.argv.slice(2);
if (cmd !== "check" || !dao || id == null) { console.error("usage: node src/cli.js check <dao-account> <proposal-id> [--json]"); process.exit(2); }
const { report, proposal } = await check(dao, id);
if (process.argv.includes("--json")) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
console.log(`\n${dao} #${id}  (${report.network})`);
console.log(`SAYS : ${proposal.description.replace(/\s+/g, " ").slice(0, 200)}`);
console.log(`DOES : ${report.does}`);
for (const n of report.notes) console.log(`       ${n}`);
if (report.hiddenText) console.log(`HIDDEN: ${report.hiddenText}`);
console.log(`VERDICT: ${report.verdict}`);
for (const f of report.findings) console.log(`  [${f.severity}] ${f.family}: ${f.why}`);
console.log(`report sha256 ${report.hash}\n`);
