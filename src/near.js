// Read-only NEAR RPC: view calls and account lookups. No keys needed.
const ENDPOINTS = {
  mainnet: [process.env.NEAR_RPC_MAINNET, "https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com", "https://near.lava.build", "https://rpc.mainnet.near.org"].filter(Boolean),
  testnet: [process.env.NEAR_RPC_TESTNET, "https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com", "https://neart.lava.build", "https://rpc.testnet.near.org"].filter(Boolean),
};

export const networkOf = (accountId) => (/\.testnet$/.test(accountId) ? "testnet" : "mainnet");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (msg) => /rate limit|too many|timeout|429|50[234]|ECONNRESET|fetch failed/i.test(String(msg));

async function rpc(network, method, params) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of ENDPOINTS[network]) {
      try {
        return await rpcOnce(url, method, params);
      } catch (e) {
        last = e;
        if (e.rpc && !isTransient(e.message)) throw e; // a real answer from the chain (e.g. unknown account)
      }
    }
    await sleep(1500 * (round + 1));
  }
  throw last;
}

async function rpcOnce(url, method, params) {
  {
    {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "qg", method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      if (!r.ok && !text.startsWith("{")) throw new Error(`HTTP ${r.status} ${text.slice(0, 80)}`);
      const j = JSON.parse(text);
      if (j.error) throw Object.assign(new Error(j.error.cause?.name || j.error.data || j.error.message || "rpc error"), { rpc: j.error });
      return j.result;
    }
  }
}

export async function view(accountId, method, args = {}, network = networkOf(accountId)) {
  const res = await rpc(network, "query", {
    request_type: "call_function", finality: "final", account_id: accountId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
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
