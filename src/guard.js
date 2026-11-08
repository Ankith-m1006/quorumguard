// One entry point: proposal in, verdict out. CLEAN / WARN / BLOCK with every reason and a report hash.
import crypto from "node:crypto";
import { compareClaims } from "./claims.js";
import { decodeKind, decodeProposal } from "./decode.js";
import { account, ftMetadata, networkOf, view } from "./near.js";
import { checkReceivers, knownAccounts, lookalike } from "./receivers.js";
import { scan } from "./scan.js";

export const VERSION = "quorumguard/0.1";

export function verdictOf(findings) {
  if (findings.some((f) => f.severity === "block")) return "BLOCK";
  if (findings.some((f) => f.severity === "warn")) return "WARN";
  return "CLEAN";
}

// Stable JSON so the same report always hashes the same.
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}` : JSON.stringify(v);
export const reportHash = (report) => crypto.createHash("sha256").update(stable({ ...report, hash: undefined, ai: undefined })).digest("hex");

/** Pure check for proposals that are not on chain yet (red-team suite, drafts, tests). */
export function checkOffline({ description, kind }, { meta, known, accounts = {}, policyBefore = null } = {}) {
  const decoded = decodeKind(kind, { meta, policyBefore });
  const s = scan(description);
  const c = compareClaims(s.visibleText + "\n" + s.hiddenText, decoded);
  const findings = [...s.findings, ...c.findings];
  if (known) {
    // Synchronous receiver check with a static account table.
    const all = [...known.members, ...known.pastReceivers.keys()];
    for (const r of new Set(decoded.facts.receivers)) {
      const twin = lookalike(r, all);
      if (twin) findings.push({ family: "receiver", severity: "block", why: `${r} looks like ${twin}, an account this DAO already knows`, evidence: `${r} ~ ${twin}` });
      if (decoded.power === "money" && !twin && !known.members.has(r) && !known.pastReceivers.has(r)) findings.push({ family: "receiver", severity: "info", why: `first payment from this DAO to ${r}`, evidence: r });
      if (accounts[r] === false) findings.push({ family: "receiver", severity: "block", why: `${r} does not exist on chain`, evidence: r });
    }
  }
  return finish({ decoded, findings, hiddenText: s.hiddenText });
}

function finish({ decoded, findings, hiddenText, dao, id, network }) {
  const report = {
    version: VERSION, dao, id, network,
    does: decoded.summary, type: decoded.type, power: decoded.power, highPower: decoded.highPower, notes: decoded.lines,
    hiddenText: hiddenText || "", verdict: verdictOf(findings), findings,
  };
  report.hash = reportHash(report);
  return report;
}

// The policy a voter saw: the newest approved ChangePolicy before this proposal, or the current policy.
export function policyAt(current, proposals, id) {
  const prior = proposals.filter((p) => p.id < id && p.status === "Approved" && p.kind?.ChangePolicy).sort((a, b) => b.id - a.id)[0];
  if (prior) return prior.kind.ChangePolicy.policy;
  const anyLater = proposals.some((p) => p.id >= id && p.status === "Approved" && p.kind?.ChangePolicy);
  return anyLater ? null : current;
}

/** Check a proposal object against a DAO context (policy + other proposals). */
export async function checkProposal(proposal, { dao, network, policy, proposals }) {
  const decoded = await decodeProposal(proposal, { network, ftMetadata, policyBefore: policyAt(policy, proposals, proposal.id) });
  const s = scan(proposal.description);
  const c = compareClaims(`${s.visibleText}\n${s.hiddenText}`, decoded);
  // Known accounts are built only from proposals BEFORE this one, as a voter at the time would see them.
  const known = knownAccounts(policy, proposals.filter((p) => p.id < proposal.id));
  const r = await checkReceivers(decoded, known, (a) => account(a, network));
  return finish({ decoded, findings: [...s.findings, ...c.findings, ...r], hiddenText: s.hiddenText, dao, id: proposal.id, network });
}

export async function loadDao(dao, { history = 200, upTo } = {}) {
  const network = networkOf(dao);
  const [policy, last] = await Promise.all([view(dao, "get_policy"), view(dao, "get_last_proposal_id")]);
  const end = upTo ?? last;
  const proposals = [];
  for (let from = Math.max(0, end - history); from < end; from += 100)
    proposals.push(...await view(dao, "get_proposals", { from_index: from, limit: Math.min(100, end - from) }).catch(() => []));
  return { dao, network, policy, proposals, last };
}

/** Live check of one proposal on chain. */
export async function check(dao, id, { history = 200 } = {}) {
  const proposal = await view(dao, "get_proposal", { id: Number(id) });
  const ctx = await loadDao(dao, { history, upTo: Number(id) + 1 });
  return { report: await checkProposal(proposal, ctx), proposal };
}
