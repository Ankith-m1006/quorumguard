// Two structural checks voters cannot do by eye:
// 1. Code upgrades: is the code hash an official Sputnik release from the sputnik-dao.near factory,
//    or a hash that only looks like one (a character dropped or changed)?
// 2. Hidden actions: a FunctionCall can carry several actions; a later one can move money or control
//    while the first one, the one a summary shows, looks harmless.
import { view } from "./near.js";

const FACTORY = { mainnet: "sputnik-dao.near" };
const cache = new Map(); // network -> { at, list }

/** Official releases as [{ hash, version }] or null when the list cannot be loaded. */
export async function officialReleases(network = "mainnet") {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.list;
  const factory = FACTORY[network];
  if (!factory) return null;
  try {
    const raw = await view(factory, "get_contracts_metadata", {}, network);
    const list = raw.map(([hash, m]) => ({ hash, version: (m?.version || []).join(".") }));
    cache.set(network, { at: Date.now(), list });
    return list;
  } catch { return null; }
}

/** Levenshtein distance, capped: we only care whether two hashes are 0, 1, 2 or "far" apart. */
function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Findings for an UpgradeSelf proposal. releases: from officialReleases(), or null if unavailable.
 * Returns { findings, notChecked }.
 */
export function upgradeFindings(decoded, releases) {
  const findings = [], notChecked = [];
  const hash = decoded.facts?.codeHash;
  if (decoded.type !== "UpgradeSelf" || !hash) return { findings, notChecked };
  if (!releases) {
    notChecked.push("the list of official Sputnik releases could not be loaded, so the code hash was not verified");
    return { findings, notChecked };
  }
  const exact = releases.find((r) => r.hash === hash);
  if (exact) {
    findings.push({ family: "upgrade", severity: "info", why: `code hash is the official Sputnik v${exact.version} release`, evidence: hash });
    return { findings, notChecked };
  }
  const near = releases.map((r) => ({ ...r, d: editDistance(hash, r.hash) })).filter((r) => r.d <= 2).sort((a, b) => a.d - b.d)[0];
  if (near) findings.push({ family: "upgrade", severity: "block", why: `code hash only looks like official Sputnik v${near.version}: it differs by ${near.d} character${near.d > 1 ? "s" : ""}`, evidence: `${hash} vs ${near.hash}` });
  else findings.push({ family: "upgrade", severity: "block", why: "replaces the DAO's code with code that is not an official Sputnik release", evidence: hash });
  return { findings, notChecked };
}

/** A later action in a multi-action FunctionCall that moves money or control. */
export function hiddenActionFindings(decoded) {
  // Registration calls (storage_deposit, near_deposit) are setup for a payment, not a second payment:
  // "register the receiver, then ft_transfer" is the normal way to pay a new account.
  const acts = (decoded.facts?.actionEffects || []).filter((a) => !/^(storage_deposit|near_deposit)$/.test(a.method));
  if (acts.length < 2) return [];
  const later = acts.slice(1).filter((a) => a.moves);
  if (!later.length) return [];
  const first = acts[0];
  const list = later.map((a) => `#${a.index + 1} ${a.method}${a.what ? ` (${a.what})` : ""}`).join(", ");
  return [{
    family: "hidden-action",
    // The classic hiding pattern: the first call looks harmless, a later one moves funds or control.
    severity: first.moves ? "warn" : "block",
    why: `${acts.length} calls in one proposal; ${later.length > 1 ? "calls" : "call"} ${list} also ${later.some((a) => a.kind === "control") ? "move funds or change control" : "move funds"}${first.moves ? "" : ", while call #1 looks harmless"}`,
    evidence: acts.map((a) => a.method).join(" + "),
  }];
}
