// Compares what the description SAYS with what the decoded proposal DOES. Hard facts are compared in code.

const ACCOUNT = /\b(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+(?:near|testnet)\b|\b[0-9a-f]{64}\b/g;
// A number: 8 928 / 8,928 / 8.928,50 / 647,25 / 1500.5
const NUM = String.raw`\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d[\d,.]*`;
const AMOUNT = new RegExp(String.raw`(?:\$\s?(${NUM})\s*(k|m)?\b)|(?:\b(${NUM})\s*(k|m)?\s*(NEAR|wNEAR|USDC|USDT|USD|DAI|N|\$)(?![A-Za-z]))`, "gi");

// "647,25" and "5 530,97" use a decimal comma; "8,928" and "1,818" use a thousands comma.
export const parseNum = (s) => {
  let t = String(s).replace(/[ \u00A0\u202F]/g, "").replace(/[.,]$/, "");
  if (/,\d{1,2}$/.test(t) && !/\.\d/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  return Number(t);
};
const num = (s, mult) => {
  const n = parseNum(s);
  return mult?.toLowerCase() === "k" ? n * 1e3 : mult?.toLowerCase() === "m" ? n * 1e6 : n;
};
const unitOf = (u) => {
  const x = (u || "$").toUpperCase();
  return x === "$" || x === "USD" ? "USD" : x === "WNEAR" || x === "N" ? "NEAR" : x;
};
const sameUnit = (claimUnit, symbol) => {
  const s = String(symbol || "").toUpperCase();
  if (claimUnit === "USD") return /^(USDC|USDT|USDC\.E|DAI|USD)/.test(s);
  return s.includes(claimUnit);
};

// Links are not claims: gov.near.org/t/... must not read as the account "gov.near".
const stripUrls = (t) => t
  .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
  .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:org|com|io|xyz|app|page|me|so|gg|link|net|social)(?:\/\S*)?/gi, " ");

export function extractClaims(text = "") {
  const clean = stripUrls(String(text));
  const accounts = [...new Set(clean.toLowerCase().match(ACCOUNT) || [])];
  const amounts = [];
  for (const m of clean.matchAll(AMOUNT)) {
    const value = m[1] ? num(m[1], m[2]) : num(m[3], m[4]);
    if (!Number.isFinite(value) || value <= 0) continue;
    // "N" means NEAR only as a capital N right after the number ("400N", "1,818 N"), never with k/m ("16Mn").
    if (!m[1] && m[5].toUpperCase() === "N" && (m[5] !== "N" || m[4])) continue;
    const before = clean.slice(Math.max(0, m.index - 4), m.index);
    const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 12);
    // Exchange rates ("1 NEAR = $3.4", "$3.4 per NEAR") and rates per period ("400N per month") are prices, not the payment.
    if (value === 1 && (/^\s*=/.test(after) || /=\s*$/.test(before))) continue;
    if (/^\s*(per\b|\/|each\b|a month|monthly|a week|weekly)/i.test(after) || /@\s*$/.test(before)) continue;
    if (/^\s*=\s*1\s*(near|n\b|usd|\$)/i.test(after)) continue;
    amounts.push({ value, unit: m[1] ? "USD" : unitOf(m[5]), text: m[0].trim() });
  }
  return { accounts, amounts };
}

// Words a description should use when the action is high power. Silence about it is the lie.
const POWER_WORDS = {
  ChangePolicy: /\b(polic(y|ies)|role|council|member|permission|quorum|threshold|vote polic|group|admin|setting|bond|period)/i,
  ChangePolicyAddOrUpdateRole: /\b(role|council|member|permission)/i,
  ChangePolicyRemoveRole: /\b(role|council|member|permission)/i,
  ChangePolicyUpdateDefaultVotePolicy: /\b(vote|voting|quorum|threshold)/i,
  ChangePolicyUpdateParameters: /\b(bond|period|parameter)/i,
  AddMemberToRole: /\b(add|onboard|welcome|join|member|council|role)/i,
  RemoveMemberFromRole: /\b(remove|offboard|member|council|role)/i,
  UpgradeSelf: /\b(upgrade|contract|code|migrat|version)/i,
  UpgradeRemote: /\b(upgrade|contract|code|migrat|version)/i,
};

/**
 * decoded: output of decodeKind. Returns findings in the same shape as scan().
 * Amounts: a claimed amount in the same unit must match an actual amount within 1%.
 */
export function compareClaims(description, decoded) {
  const findings = [];
  const said = extractClaims(description);
  const add = (severity, why, evidence) => findings.push({ family: "says-vs-does", severity, why, evidence: String(evidence).slice(0, 200) });

  if (decoded.power === "money") {
    // Receivers: if the description names accounts, the money must go to one of them.
    for (const r of decoded.facts.receivers) {
      const payTalk = /\b(pay|paid|payment|payout|recipient|receiver|receiving|wallet|send|transfer|remuneration|compensation|invoice|reimburse|grant|fund(s|ing)?|address)\b/i.test(description);
      if (said.accounts.length && !said.accounts.includes(r.toLowerCase())) add(payTalk ? "block" : "warn", `pays ${r}, but the description names ${said.accounts.join(", ")}`, `receiver ${r}`);
      else if (!said.accounts.length) add("info", `the description never names who gets paid (${r})`, `receiver ${r}`);
    }
    // Amounts: compare claims and facts that share a unit; a match anywhere clears it.
    for (const a of decoded.facts.amounts) {
      if (a.value == null) continue;
      const claims = said.amounts.filter((c) => sameUnit(c.unit, a.symbol));
      if (!claims.length) continue;
      const ok = claims.some((c) => Math.abs(c.value - a.value) <= Math.max(0.01 * a.value, 1e-9));
      if (ok) continue;
      const most = Math.max(...claims.map((c) => c.value));
      const listed = claims.map((c) => c.text).join(" / ");
      // Paying MORE than any amount the text mentions is the attack; paying less than stated is a mismatch to ask about.
      if (a.value > most * 1.01) {
        const ratio = a.value / most;
        add("block", `moves ${a.value} ${a.symbol}, more than any amount the description gives (${listed})${ratio >= 2 ? `: ${ratio.toFixed(ratio >= 10 ? 0 : 1)}x more` : ""}`, `${a.value} ${a.symbol}`);
      } else add("warn", `moves ${a.value} ${a.symbol}; the description gives ${listed}`, `${a.value} ${a.symbol}`);
    }
  }

  // High-power actions must be named in the description.
  const re = decoded.facts.settingsOnly ? /\b(bond|period|setting|config|parameter|duration|deposit)/i : POWER_WORDS[decoded.type];
  if (re && !re.test(description)) add(decoded.facts.settingsOnly ? "warn" : "block", `${decoded.type} ${decoded.facts.settingsOnly ? "changes DAO settings" : "changes control of the DAO"}, but the description never mentions it`, decoded.summary);
  for (const x of decoded.facts.policyDiff?.added || []) {
    if (description.toLowerCase().includes(x.member.toLowerCase())) continue;
    // "Keypom DAO bot" for dao-bot.keypom.near: every word of the account appears, so it is named loosely, not hidden.
    const words = x.member.toLowerCase().split(/[.\-_]/).filter((w) => w.length >= 3 && !["near", "testnet", "sputnik"].includes(w));
    const loose = words.length && words.every((w) => description.toLowerCase().includes(w));
    add(loose ? "warn" : "block", `gives ${x.member} a place in "${x.role}" ${loose ? "naming them only loosely" : "without naming them in the description"}`, x.member);
  }
  if (decoded.type === "AddMemberToRole" && decoded.facts.receivers[0] && !description.toLowerCase().includes(decoded.facts.receivers[0].toLowerCase()))
    add("warn", `adds ${decoded.facts.receivers[0]} without naming them in the description`, decoded.facts.receivers[0]);
  const methodWords = (decoded.facts.methods || []).flatMap((m) => m.split("_")).filter((w) => w.length >= 4);
  const disclosed = /\b(transfer|withdraw|owner|admin|upgrade|migrat|pay|send)/i.test(description) || methodWords.some((w) => description.toLowerCase().includes(w.toLowerCase()));
  if (decoded.type === "FunctionCall" && decoded.lines.some((l) => /can move funds or change control|Sets (owner|admin)/i.test(l)) && !disclosed)
    add("block", "the call can move funds or change control, but the description does not say so", decoded.summary);
  return { findings, said };
}
