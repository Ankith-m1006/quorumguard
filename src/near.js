// Read-only NEAR RPC: view calls and account lookups. No keys needed.
// Public endpoints, tried round-robin so no single free endpoint takes all the load (FastNEAR rate-limits bursts;
// rpc.mainnet.near.org and Lava are discontinued).
const ENDPOINTS = {
  mainnet: [process.env.NEAR_RPC_MAINNET, "https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://rpc.shitzuapes.xyz", "https://free.rpc.fastnear.com", "https://rpc.intea.rs"].filter(Boolean),
  testnet: [process.env.NEAR_RPC_TESTNET, "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"].filter(Boolean),
};

export const networkOf = (accountId) => (/\.testnet$/.test(accountId) ? "testnet" : "mainnet");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (msg) => /rate limit|too many|timeout|429|50[234]|ECONNRESET|fetch failed/i.test(String(msg));
const turn = { mainnet: 0, testnet: 0 };

async function rpc(network, method, params) {
  const list = ENDPOINTS[network];
  let last;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < list.length; i++) {
      const url = list[turn[network]++ % list.length];
      try {
        return await rpcOnce(url, method, params);
      } catch (e) {
        last = e;
        if (e.rpc && !isTransient(e.message)) throw e; // a real answer from the chain (e.g. unknown account)
      }
    }
    await sleep(2000 * 2 ** round);
  }
  throw last;
}

async function rpcOnce(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "qg", method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (!text.trim().startsWith("{")) throw new Error(`HTTP ${r.status} ${text.slice(0, 80)}`);
  const j = JSON.parse(text);
  if (j.error && !j.error.cause?.name) {
    const msg = typeof j.error === "string" ? j.error : j.error.data || j.error.message || JSON.stringify(j.error);
    throw new Error(`endpoint error (${url}): ${String(msg).slice(0, 100)}`);
  }
  if (j.error) throw Object.assign(new Error(j.error.cause.name), { rpc: j.error });
  if (j.result === undefined) throw new Error(`endpoint error (${url}): empty result`);
  return j.result;
}

export async function view(accountId, method, args = {}, network = networkOf(accountId)) {
  const res = await rpc(network, "query", {
    request_type: "call_function", finality: "final", account_id: accountId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  // A contract panic (e.g. "ERR_NO_PROPOSAL") comes back inside the result, not as an RPC error.
  if (res.error || !res.result) throw Object.assign(new Error(`contract panicked: ${String(res.error || "no result").slice(0, 160)}`), { panic: true });
  return JSON.parse(Buffer.from(res.result).toString("utf-8"));
}

const accCache = new Map();
export function account(accountId, network = networkOf(accountId)) {
  const k = `${network}:${accountId}`;
  if (!accCache.has(k)) accCache.set(k, fetchAccount(accountId, network));
  return accCache.get(k);
}
async function fetchAccount(accountId, network) {
  try {
    const a = await rpc(network, "query", { request_type: "view_account", finality: "final", account_id: accountId });
    return { exists: true, amount: a.amount, hasContract: a.code_hash !== "11111111111111111111111111111111" };
  } catch (e) {
    if (e.rpc && /UNKNOWN_ACCOUNT/.test(e.message)) return { exists: false };
    throw e;
  }
}

const ftCache = new Map();
export async function ftMetadata(tokenId, network) {
  const k = `${network}:${tokenId}`;
  if (!ftCache.has(k)) ftCache.set(k, view(tokenId, "ft_metadata", {}, network).catch(() => null));
  return ftCache.get(k);
}
