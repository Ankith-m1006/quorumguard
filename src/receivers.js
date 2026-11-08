// Who gets the money or the power: does the account exist, has this DAO dealt with it before,
// and does it imitate an account the DAO already knows?

export function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const skeleton = (s) => s.toLowerCase().replace(/rn/g, "m").replace(/vv/g, "w").replace(/[0]/g, "o").replace(/[1l|]/g, "i").replace(/[-_.]/g, "");
const label = (s) => s.split(".")[0];
const parent = (s) => s.split(".").slice(1).join(".");

/** Pure: compare one receiver with the DAO's known accounts. */
export function lookalike(receiver, known) {
  const r = receiver.toLowerCase();
  for (const k of known) {
    const kk = k.toLowerCase();
    if (kk === r) return null;
  }
  for (const k of known) {
    const kk = k.toLowerCase();
    const sameSkeleton = skeleton(kk) === skeleton(r);
    // Same name under a different parent: turkey.sputnikdao.near vs turkey.sputnik-dao.near.
    // Only when the parents themselves look alike, so marketing.paras.near and marketing.v1.potfactory.potlock.near stay apart.
    const sameLabelOtherParent = label(kk) === label(r) && parent(kk) !== parent(r) && label(r).length >= 4 &&
      (skeleton(parent(kk)) === skeleton(parent(r)) || levenshtein(parent(kk), parent(r)) <= 2);
    // One edit away under the same parent, or two letters swapped: starchu.near vs strachu.near.
    const d = parent(kk) === parent(r) ? levenshtein(label(kk), label(r)) : 99;
    const swapped = d === 2 && label(kk).length === label(r).length && [...label(kk)].sort().join("") === [...label(r)].sort().join("");
    const near = Math.min(label(kk).length, label(r).length) >= 5 && (d === 1 || swapped);
    if (sameSkeleton || sameLabelOtherParent || near) return k;
  }
  return null;
}

/**
 * known: { members: Set, pastReceivers: Map<account, count> }. accountInfo(id) -> {exists, hasContract}.
 */
export async function checkReceivers(decoded, known, accountInfo) {
  const findings = [];
  const add = (severity, why, evidence) => findings.push({ family: "receiver", severity, why, evidence });
  const all = [...known.members, ...known.pastReceivers.keys()];
  for (const r of new Set(decoded.facts.receivers)) {
    const twin = lookalike(r, all);
    if (twin) add("block", `${r} looks like ${twin}, an account this DAO already knows`, `${r} ~ ${twin}`);
    const info = await accountInfo(r).catch(() => null);
    if (info && !info.exists && !/^[0-9a-f]{64}$/.test(r)) add("block", `${r} does not exist on chain: funds or rights would go nowhere, or to whoever registers it first`, r);
    if (decoded.power === "money" && !known.members.has(r) && !known.pastReceivers.has(r) && !twin) add("info", `first payment from this DAO to ${r}`, r);
  }
  return findings;
}

/** Build the DAO's known accounts from its policy and its recent proposals. */
export function knownAccounts(policy, proposals) {
  const members = new Set();
  for (const role of policy?.roles || []) for (const m of role.kind?.Group || []) members.add(m);
  const pastReceivers = new Map();
  for (const p of proposals) {
    if (p.status !== "Approved") continue;
    const k = p.kind || {};
    const r = k.Transfer?.receiver_id || k.FunctionCall?.receiver_id || k.BountyDone?.receiver_id || k.AddMemberToRole?.member_id;
    if (r) pastReceivers.set(r, (pastReceivers.get(r) || 0) + 1);
  }
  return { members, pastReceivers };
}
