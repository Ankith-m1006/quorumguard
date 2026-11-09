// Turns a Sputnik DAO v2 proposal's `kind` into facts and plain English. Deterministic: no AI here.
// The facts are what the proposal DOES if it passes; the description is only what the proposer SAYS.

export const NEAR_DECIMALS = 24;

/** "1500000000000000000000000", 24 -> "1.5" */
export function formatUnits(raw, decimals) {
  const v = BigInt(raw || "0");
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 6)}` : `${whole}`;
}

const HIGH_POWER = {
  ChangePolicy: "rewrites who can vote and how votes pass",
  ChangePolicyAddOrUpdateRole: "adds or changes a voting role",
  ChangePolicyRemoveRole: "removes a voting role",
  ChangePolicyUpdateDefaultVotePolicy: "changes how votes pass",
  ChangePolicyUpdateParameters: "changes proposal bond and voting period",
  AddMemberToRole: "gives an account voting power",
  RemoveMemberFromRole: "takes voting power away",
  UpgradeSelf: "replaces the DAO's own contract code",
  UpgradeRemote: "replaces another contract's code",
  SetStakingContract: "sets the staking contract",
  ChangeConfig: "changes the DAO's name, purpose or metadata",
};

// Methods that move money or control when called by the DAO.
// Methods that move the DAO's money or hand over control (block if undisclosed) vs ones worth a look (warn).
const RISKY_METHOD = /(^|_)(transfer|withdraw|unstake|delete|upgrade|migrate|set_owner|owner|add_key|add_full_access|set_admin)(_|$)/i;
const NOTABLE_METHOD = /(^|_)(send|pay|grant|approve|mint|burn|claim)(_|$)/i;

// What a role can do. "high": it can approve money or control moves and is small enough that one more member matters.
const POWER_ACTIONS = /^(\*|transfer|call|policy|upgrade_self|upgrade_remote|add_member_to_role|remove_member_from_role|config|set_vote_token|bounty_done|add_bounty):(VoteApprove|\*)$/;
export function rolePower(policy, roleName) {
  const role = (policy?.roles || []).find((r) => r.name === roleName);
  if (!role) return { level: "unknown" };
  const size = role.kind === "Everyone" ? Infinity : (role.kind?.Group || []).length;
  const approves = (role.permissions || []).some((p) => POWER_ACTIONS.test(p));
  const level = !approves ? "low" : size <= 10 ? "high" : "medium";
  return { level, size, approves };
}

function tryJson(b64) {
  try {
    const text = Buffer.from(b64 || "", "base64").toString("utf-8");
    try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
  } catch { return { text: "", json: null }; }
}

/**
 * Pure decode. `meta(tokenId)` returns {symbol, decimals} or null for a fungible token.
 * Returns { type, summary, power: "money"|"control"|"call"|"vote"|"other", highPower, facts: {...}, lines: [] }.
 */
const membersOf = (role) => (role?.kind === "Everyone" ? ["<everyone>"] : role?.kind?.Group || []);
const yoctoNear = (v) => formatUnits(v || "0", NEAR_DECIMALS);
const days = (ns) => (Number(BigInt(ns || "0") / 1000000000n) / 86400).toFixed(1);

/** What a new policy changes compared with the policy in force. controlChanges counts changes to who decides. */
export function diffPolicy(before, after) {
  const changes = [], added = [], removed = [];
  let controlChanges = 0;
  const b = new Map((before?.roles || []).map((r) => [r.name, r]));
  const a = new Map((after?.roles || []).map((r) => [r.name, r]));
  for (const [name, r] of a) {
    if (!b.has(name)) { changes.push(`new role "${name}" (${membersOf(r).join(", ") || "no members"}) with permissions ${(r.permissions || []).join(", ")}`); controlChanges++; added.push(...membersOf(r).filter((m) => m !== "<everyone>").map((member) => ({ member, role: name }))); continue; }
    const old = b.get(name);
    const om = new Set(membersOf(old)), nm = new Set(membersOf(r));
    for (const m of nm) if (!om.has(m)) { added.push({ member: m, role: name }); changes.push(`add ${m} to "${name}"`); controlChanges++; }
    for (const m of om) if (!nm.has(m)) { removed.push({ member: m, role: name }); changes.push(`remove ${m} from "${name}"`); controlChanges++; }
    const op = [...(old.permissions || [])].sort().join(","), np = [...(r.permissions || [])].sort().join(",");
    if (op !== np) { changes.push(`"${name}" permissions change`); controlChanges++; }
    if (JSON.stringify(old.vote_policy || {}) !== JSON.stringify(r.vote_policy || {})) { changes.push(`"${name}" vote rule changes`); controlChanges++; }
  }
  for (const name of b.keys()) if (!a.has(name)) { changes.push(`remove role "${name}"`); controlChanges++; removed.push(...membersOf(b.get(name)).map((member) => ({ member, role: name }))); }
  if (JSON.stringify(before?.default_vote_policy) !== JSON.stringify(after?.default_vote_policy)) { changes.push("default vote rule changes"); controlChanges++; }
  if (before?.proposal_bond !== after?.proposal_bond) changes.push(`proposal bond ${yoctoNear(before?.proposal_bond)} -> ${yoctoNear(after?.proposal_bond)} NEAR`);
  if (before?.proposal_period !== after?.proposal_period) changes.push(`voting period ${days(before?.proposal_period)} -> ${days(after?.proposal_period)} days`);
  if (before?.bounty_bond !== after?.bounty_bond) changes.push(`bounty bond ${yoctoNear(before?.bounty_bond)} -> ${yoctoNear(after?.bounty_bond)} NEAR`);
  if (before?.bounty_forgiveness_period !== after?.bounty_forgiveness_period) changes.push("bounty forgiveness period changes");
  return { changes, added, removed, controlChanges };
}

export function decodeKind(kind, { meta = () => null, policyBefore = null, rolePolicy = null } = {}) {
  const type = typeof kind === "string" ? kind : Object.keys(kind)[0];
  const body = typeof kind === "string" ? {} : kind[type];
  const out = { type, highPower: Boolean(HIGH_POWER[type]), facts: { receivers: [], amounts: [] }, lines: [] };

  if (type === "Transfer") {
    const token = body.token_id || "";
    const m = token ? meta(token) : { symbol: "NEAR", decimals: NEAR_DECIMALS };
    const symbol = m?.symbol || token || "NEAR";
    const human = m ? formatUnits(body.amount, m.decimals) : `${body.amount} (raw units of ${token})`;
    out.power = "money";
    out.facts.receivers.push(body.receiver_id);
    out.facts.amounts.push({ raw: body.amount, value: m ? Number(formatUnits(body.amount, m.decimals)) : null, symbol, token: token || "NEAR" });
    out.summary = `Transfer ${human} ${symbol} to ${body.receiver_id}`;
    if (body.msg) out.lines.push(`Calls ft_transfer_call with msg ${JSON.stringify(body.msg).slice(0, 120)}: the receiver contract runs code on arrival.`);
  } else if (type === "FunctionCall") {
    out.power = "call";
    out.facts.receivers.push(body.receiver_id);
    out.facts.methods = (body.actions || []).map((a) => a.method_name);
    const parts = [];
    for (const a of body.actions || []) {
      const { text, json } = tryJson(a.args);
      const deposit = BigInt(a.deposit || "0");
      if (deposit > 0n) out.facts.amounts.push({ raw: a.deposit, value: Number(formatUnits(a.deposit, NEAR_DECIMALS)), symbol: "NEAR", token: "NEAR", attached: true });
      let detail = "";
      // Token moves hidden inside a function call (ft_transfer on a token contract).
      if (json && /^(ft_transfer|ft_transfer_call|transfer)$/.test(a.method_name) && json.receiver_id && json.amount) {
        const m = meta(body.receiver_id);
        out.power = "money";
        out.facts.receivers.push(json.receiver_id);
        (out.facts.payees ||= []).push(json.receiver_id);
        out.facts.amounts.push({ raw: json.amount, value: m ? Number(formatUnits(json.amount, m.decimals)) : null, symbol: m?.symbol || body.receiver_id, token: body.receiver_id });
        detail = ` sending ${m ? formatUnits(json.amount, m.decimals) : json.amount} ${m?.symbol || "tokens"} to ${json.receiver_id}`;
      }
      if (RISKY_METHOD.test(a.method_name)) out.lines.push(`Method ${a.method_name} can move funds or change control.`);
      else if (NOTABLE_METHOD.test(a.method_name)) out.lines.push(`Method ${a.method_name} may create, move or authorise assets.`);
      if (json) for (const [k, v] of Object.entries(json)) {
        if (typeof v === "string" && /^[a-z0-9_.-]+\.(near|testnet)$|^[0-9a-f]{64}$/.test(v) && !out.facts.receivers.includes(v)) out.facts.receivers.push(v);
        // owner_id in nft_mint/ft_transfer is a recipient; only setter-style methods change who controls a contract.
        if (/owner|admin/i.test(k) && /owner|admin|config|init|migrate|^set_|update/i.test(a.method_name)) out.lines.push(`Sets ${k} = ${JSON.stringify(v)}.`);
      }
      if (!json && text) out.lines.push(`Arguments of ${a.method_name} are not JSON (${text.length} bytes).`);
      parts.push(`${a.method_name}(${json ? JSON.stringify(json).slice(0, 160) : "…"})${deposit > 0n ? ` with ${formatUnits(a.deposit, NEAR_DECIMALS)} NEAR attached` : ""}${detail}`);
    }
    out.summary = `Call ${body.receiver_id}: ${parts.join("; ")}`;
  } else if (type === "AddMemberToRole" || type === "RemoveMemberFromRole") {
    out.power = "control";
    out.facts.receivers.push(body.member_id);
    out.facts.role = body.role;
    out.facts.rolePower = rolePower(policyBefore || rolePolicy, body.role);
    out.summary = `${type === "AddMemberToRole" ? "Add" : "Remove"} ${body.member_id} ${type === "AddMemberToRole" ? "to" : "from"} role "${body.role}"`;
    const rp = out.facts.rolePower;
    if (rp.level !== "unknown") out.lines.push(rp.level === "high" ? `Role "${body.role}" (${rp.size} members) can approve transfers, calls or policy changes.` : rp.level === "medium" ? `Role "${body.role}" can approve, but has ${rp.size === Infinity ? "everyone" : rp.size + " members"}.` : `Role "${body.role}" cannot approve money or control moves.`);
    if (rp.level === "low" || rp.level === "medium") out.highPower = false;
  } else if (type === "ChangePolicy") {
    out.power = "control";
    out.facts.policy = body.policy;
    if (policyBefore) {
      const d = diffPolicy(policyBefore, body.policy);
      out.facts.policyDiff = d;
      out.facts.receivers.push(...d.added.map((x) => x.member));
      out.summary = d.changes.length ? `Change the DAO policy: ${d.changes.join("; ")}` : "Re-submit the current DAO policy unchanged";
      // Only bonds or periods changed: real, but not a change of who controls the DAO.
      if (d.controlChanges === 0) { out.highPower = false; out.facts.settingsOnly = true; }
    } else {
      const roles = (body.policy?.roles || []).map((r) => ({ name: r.name, members: r.kind?.Group || (r.kind === "Everyone" ? ["<everyone>"] : r.kind) }));
      for (const r of roles) if (Array.isArray(r.members)) out.facts.receivers.push(...r.members.filter((x) => x !== "<everyone>"));
      out.summary = `Replace the whole DAO policy (${roles.length} roles: ${roles.map((r) => `${r.name}=${Array.isArray(r.members) ? r.members.length : JSON.stringify(r.members)}`).join(", ")})`;
    }
  } else if (type === "UpgradeSelf") {
    out.power = "control";
    out.summary = `Replace this DAO's contract code with blob ${body.hash}`;
  } else if (type === "UpgradeRemote") {
    out.power = "control";
    out.facts.receivers.push(body.receiver_id);
    out.summary = `Upgrade ${body.receiver_id} by calling ${body.method_name} with blob ${body.hash}`;
  } else if (type === "AddBounty") {
    out.power = "money";
    const b = body.bounty || {};
    const m = b.token ? meta(b.token) : { symbol: "NEAR", decimals: NEAR_DECIMALS };
    out.facts.amounts.push({ raw: b.amount, value: m ? Number(formatUnits(b.amount, m.decimals)) : null, symbol: m?.symbol || b.token, token: b.token || "NEAR", times: b.times });
    out.summary = `Bounty: ${m ? formatUnits(b.amount, m.decimals) : b.amount} ${m?.symbol || b.token} x ${b.times} claims`;
  } else if (type === "BountyDone") {
    out.power = "money";
    out.facts.receivers.push(body.receiver_id);
    out.summary = `Pay bounty #${body.bounty_id} to ${body.receiver_id}`;
  } else if (type === "Vote") {
    out.power = "vote";
    out.summary = "Signalling vote only: nothing happens on chain if it passes";
  } else {
    out.power = out.highPower ? "control" : "other";
    out.summary = `${type}${body && Object.keys(body).length ? " " + JSON.stringify(body).slice(0, 200) : ""}`;
  }
  if (out.highPower) out.lines.unshift(`High power: ${HIGH_POWER[type]}.`);
  return out;
}

/** Fetch token metadata for every token a kind touches, then decode. */
export async function decodeProposal(proposal, { network, ftMetadata, policyBefore = null, rolePolicy = null }) {
  const tokens = new Set();
  const k = proposal.kind;
  if (k?.Transfer?.token_id) tokens.add(k.Transfer.token_id);
  if (k?.FunctionCall) tokens.add(k.FunctionCall.receiver_id);
  if (k?.AddBounty?.bounty?.token) tokens.add(k.AddBounty.bounty.token);
  const metas = {};
  await Promise.all([...tokens].map(async (t) => { metas[t] = await ftMetadata(t, network); }));
  return decodeKind(k, { meta: (t) => metas[t] || null, policyBefore, rolePolicy });
}
