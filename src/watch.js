// Live watcher: follows NEAR mainnet blocks (neardata.xyz, public) and checks every new Sputnik DAO proposal
// the moment it is created. Each successful add_proposal receipt on a *.sputnik-dao.near account returns the
// new proposal id, so no polling of 2,000 DAOs is needed.
//   node src/watch.js            follow the chain, print each verdict, write results/feed.jsonl
// As a library: tick() processes the blocks since the last cursor (used by the server on a schedule).
import fs from "node:fs";
import { check } from "./guard.js";
import { notify } from "./telegram.js";

const DATA = process.env.NEARDATA_URL || "https://mainnet.neardata.xyz/v0";
const FACTORY_SUFFIX = ".sputnik-dao.near";
const FEED_MAX = 300;

export const state = { cursor: null, feed: [], seen: new Set(), lastTick: null, blocksRead: 0, errors: 0 };

const pause = (ms) => new Promise((res) => setTimeout(res, ms));
async function getJson(url, tries = 5) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (r.status === 429 && tries > 0) { await pause(1500 * (6 - tries)); return getJson(url, tries - 1); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`neardata ${r.status}`);
  const t = await r.text();
  return t === "null" ? null : JSON.parse(t);
}

/** New proposals created in one block: [{ dao, id, proposer, tx }]. */
export function proposalsInBlock(block) {
  const out = [];
  for (const shard of block?.shards || []) {
    for (const o of shard.receipt_execution_outcomes || []) {
      const rc = o.receipt;
      if (!rc?.receiver_id?.endsWith(FACTORY_SUFFIX)) continue;
      const actions = rc.receipt?.Action?.actions || [];
      if (!actions.some((a) => a.FunctionCall?.method_name === "add_proposal")) continue;
      const ok = o.execution_outcome?.outcome?.status?.SuccessValue;
      if (ok === undefined) continue; // failed add_proposal
      let id;
      try { id = JSON.parse(Buffer.from(ok, "base64").toString("utf-8")); } catch { continue; }
      if (!Number.isInteger(id)) continue;
      out.push({ dao: rc.receiver_id, id, proposer: rc.predecessor_id, tx: o.tx_hash || null });
    }
  }
  return out;
}

async function handle(p, height) {
  const key = `${p.dao}#${p.id}`;
  if (state.seen.has(key)) return null;
  state.seen.add(key);
  const { report, proposal } = await check(p.dao, p.id);
  const item = {
    at: new Date().toISOString(), height, dao: p.dao, id: p.id, proposer: p.proposer, tx: p.tx,
    verdict: report.verdict, does: report.does, says: String(proposal.description).slice(0, 400), hash: report.hash,
    why: report.findings.filter((f) => f.severity !== "info").map((f) => f.why),
  };
  state.feed.unshift(item);
  state.feed.length = Math.min(state.feed.length, FEED_MAX);
  try { fs.appendFileSync("results/feed.jsonl", JSON.stringify(item) + "\n"); } catch {}
  await notify(item).catch(() => {});
  return item;
}

/** Process blocks from the cursor up to the latest final block (at most `max` blocks per call). */
export async function tick({ max = 900, startBack = 600, budgetMs = Infinity } = {}) {
  const stopAt = Date.now() + budgetMs;
  const last = await getJson(`${DATA}/last_block/final`);
  const head = last.block.header.height;
  if (state.cursor === null) state.cursor = head - startBack; // first run: look back ~10 minutes
  const to = Math.min(head, state.cursor + max);
  const found = [];
  // Fetch blocks a few at a time (Cloud Run bills the whole request, so waiting one by one costs money),
  // then handle them in order so the cursor never skips a block.
  const par = Number(process.env.BLOCK_PARALLEL || 8);
  let stop = false;
  for (let h = state.cursor + 1; h <= to && !stop; h += par) {
    if (Date.now() > stopAt) break; // the rest waits for the next tick
    const heights = []; for (let x = h; x < h + par && x <= to; x++) heights.push(x);
    const blocks = await Promise.all(heights.map((x) => getJson(`${DATA}/block/${x}`).catch(() => undefined)));
    for (let i = 0; i < heights.length; i++) {
      if (blocks[i] === undefined) { state.errors++; stop = true; break; } // fetch failed: retry from here next tick
      state.cursor = heights[i];
      state.blocksRead++;
      if (!blocks[i]) continue; // skipped height
      for (const p of proposalsInBlock(blocks[i])) {
        try { const item = await handle(p, heights[i]); if (item) found.push(item); } catch { state.errors++; }
      }
    }
    await pause(Number(process.env.BLOCK_PAUSE_MS || 100)); // stay polite to the free API between batches
  }
  state.lastTick = new Date().toISOString();
  return { head, cursor: state.cursor, behind: head - state.cursor, found };
}

// CLI: follow the chain.
if (process.argv[1]?.endsWith("watch.js")) {
  const back = Number(process.argv[2] || 600);
  console.error(`watching NEAR mainnet for new DAO proposals (looking back ${back} blocks first)`);
  for (;;) {
    try {
      const r = await tick({ startBack: back });
      for (const f of r.found) console.log(`${f.verdict.padEnd(5)} ${f.dao} #${f.id}  ${f.does}${f.why.length ? "  | " + f.why[0] : ""}`);
      if (r.behind < 5) await new Promise((res) => setTimeout(res, 3000));
    } catch (e) { console.error("tick failed:", e.message); await new Promise((res) => setTimeout(res, 5000)); }
  }
}
