// Real proposals from mainnet DAOs worth a human question. Neutral notes only: a mismatch is a question, not an accusation.
import fs from "node:fs";
import { checkProposal, loadDao } from "../src/guard.js";
import { view } from "../src/near.js";

const PICKS = [
  ["build.sputnik-dao.near", 286, "The description credits starchu.near; the transfer went to strachu.near. Two letters swapped. Either is a typo, and a voter cannot tell which from the text."],
  ["marketing.sputnik-dao.near", 73, "Pays turkey.sputnik-dao.near; the DAO had been paying turkey.sputnikdao.near. Same name under a different parent account."],
  ["nearweek-news-contribution.sputnik-dao.near", 13189, "Adds a council member. The whole description is \"Yett\". It passed."],
  ["nearweek-news-contribution.sputnik-dao.near", 13338, "Removes nearweek.near from the council. The whole description is \"gh\". It passed."],
  ["marketing.sputnik-dao.near", 1021, "The description says 2234.3 NEAR; the transfer is 234.3 NEAR. The DAO paid less than the text says, but a reader of the text alone would expect ten times more."],
  ["marketing.sputnik-dao.near", 869, "The description says 1668 NEAR; the transfer is 1268 NEAR."],
  ["marketing.sputnik-dao.near", 858, "The transfer is 2728 NEAR; the largest amount in the description is 2679 NEAR."],
  ["build.sputnik-dao.near", 28, "Changes the voting period from 7 to 37 days and lowers bonds, described as \"update settings\". Settings only, so QuorumGuard passes it but shows exactly what changed."],
];
const out = [];
const ctxs = {};
for (const [dao, id, note] of PICKS) {
  ctxs[dao] ||= await loadDao(dao, { history: 100000 });
  const p = await view(dao, "get_proposal", { id });
  const r = await checkProposal(p, ctxs[dao]);
  out.push({ dao, id, status: p.status, note, says: p.description.slice(0, 400), does: r.does, verdict: r.verdict, why: r.findings.filter((f) => f.severity !== "info").map((f) => f.why) });
  console.error(dao, id, r.verdict);
}
fs.writeFileSync("results/wild-cases.json", JSON.stringify(out, null, 2));
