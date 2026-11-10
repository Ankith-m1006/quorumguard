// NEAR AI Cloud: OpenAI-compatible chat completions run inside a TEE, plus the evidence that they did.
// For each answer we keep the exact request and response bytes, fetch the TEE's ed25519 signature over
// "<model>:<sha256(request)>:<sha256(response)>", and check it against the signing key from the model's
// attestation report. The signature can be re-checked later offline, and on chain by the QuorumGuard contract.
import crypto from "node:crypto";

const BASE = process.env.NEAR_AI_BASE || "https://cloud-api.near.ai/v1";
export const MODEL = process.env.NEAR_AI_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";
const ALGO = "ed25519";
export const aiConfigured = () => Boolean(process.env.NEAR_AI_API_KEY);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const auth = () => ({ Authorization: `Bearer ${process.env.NEAR_AI_API_KEY}` });

/** Raw ed25519 public key (32 bytes hex) -> KeyObject. */
function ed25519Key(hex) {
  const raw = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (raw.length !== 32) throw new Error("ed25519 key must be 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

export function verifyEd25519(text, signatureHex, publicKeyHex) {
  return crypto.verify(null, Buffer.from(text, "utf-8"), ed25519Key(publicKeyHex), Buffer.from(signatureHex.replace(/^0x/, ""), "hex"));
}

/** Preflight: the model's attestation report (signing key + Intel TDX quote). Public, no key needed. */
let attested = null;
export async function attestation(model = MODEL) {
  if (attested?.model === model) return attested;
  const nonce = crypto.randomBytes(32).toString("hex");
  const url = `${BASE}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=${ALGO}&nonce=${nonce}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`attestation ${r.status}`);
  const j = await r.json();
  const reports = (j.model_attestations || j.all_attestations || []).filter((a) => a.signing_algo === ALGO || !a.signing_algo);
  attested = {
    model, nonce, fetchedAt: new Date().toISOString(),
    gateway: j.gateway_attestation ? { signing_address: j.gateway_attestation.signing_address, signing_algo: j.gateway_attestation.signing_algo } : null,
    signers: reports.map((a) => a.signing_address).filter(Boolean),
    quoteSha256: reports[0]?.intel_quote ? sha256(Buffer.from(reports[0].intel_quote, "hex")) : null,
    verifyAt: "https://docs.near.ai/cloud/verification/verification-center",
  };
  return attested;
}

/**
 * One chat completion with proof. Returns { content, chatId, proof: { requestSha256, responseSha256, text, signature, signer, verified } }.
 * The request body is built once and hashed as sent; the response is hashed before parsing.
 */
export async function complete(messages, { model = MODEL, temperature = 0, json = true, maxTokens = 3000, think = false } = {}) {
  if (!aiConfigured()) throw new Error("NEAR_AI_API_KEY is not set");
  const att = await attestation(model);
  const body = Buffer.from(JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...(think ? {} : { chat_template_kwargs: { enable_thinking: false } }), ...(json ? { response_format: { type: "json_object" } } : {}) }), "utf-8");
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json", "Accept-Encoding": "identity", "x-no-aliasing": "true" },
    body, signal: AbortSignal.timeout(120000),
  });
  const raw = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${raw.toString("utf-8").slice(0, 200)}`);
  const parsed = JSON.parse(raw.toString("utf-8"));
  const content = parsed.choices?.[0]?.message?.content || "";
  const proof = await signatureFor(parsed.id, body, raw, model, att);
  return { content, chatId: parsed.id, model, proof, requestBody: body.toString("utf-8"), responseBody: raw.toString("utf-8") };
}

async function signatureFor(chatId, body, raw, model, att) {
  const requestSha256 = sha256(body), responseSha256 = sha256(raw);
  const expected = { provider_tee: `${model}:${requestSha256}:${responseSha256}`, gateway: `${requestSha256}:${responseSha256}` };
  let sig = null;
  for (let i = 0; i < 5 && !sig; i++) {
    const r = await fetch(`${BASE}/signature/${encodeURIComponent(chatId)}?signing_algo=${ALGO}&model=${encodeURIComponent(model)}`, { headers: { ...auth(), Accept: "application/json" } });
    if (r.ok) { const j = await r.json(); if (j.signature) sig = j; }
    if (!sig) await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  if (!sig) return { requestSha256, responseSha256, verified: false, reason: "signature unavailable" };
  const kind = sig.signature_kind || "provider_tee";
  const textOk = sig.text === expected[kind];
  const sigOk = textOk && verifyEd25519(sig.text, sig.signature, sig.signing_address);
  const signerOk = kind === "provider_tee" ? att.signers.includes(sig.signing_address) : att.gateway?.signing_address === sig.signing_address;
  return {
    requestSha256, responseSha256, kind, text: sig.text, signature: sig.signature, signer: sig.signing_address,
    verified: Boolean(textOk && sigOk && signerOk),
    checks: { textMatchesBytes: textOk, signatureValid: sigOk, signerMatchesAttestation: signerOk },
  };
}

/** Re-check a stored proof with no network: hashes, then the signature, then the signer. */
export function recheck({ requestBody, responseBody, model, proof, signers }) {
  const req = sha256(Buffer.from(requestBody, "utf-8")), res = sha256(Buffer.from(responseBody, "utf-8"));
  const text = proof.kind === "gateway" ? `${req}:${res}` : `${model}:${req}:${res}`;
  return text === proof.text && verifyEd25519(proof.text, proof.signature, proof.signer) && (!signers || signers.includes(proof.signer));
}
