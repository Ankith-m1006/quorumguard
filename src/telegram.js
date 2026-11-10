// Telegram alerts for DAO councils. Set TELEGRAM_BOT_TOKEN (from @BotFather). Chats subscribe with
// "/watch <dao>" and unsubscribe with "/stop <dao>"; "/list" shows their DAOs. Optional TELEGRAM_FEED_CHAT gets
// every non-CLEAN proposal across NEAR. Subscriptions live in results/subscriptions.json.
import fs from "node:fs";

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const API = (m) => `https://api.telegram.org/bot${TOKEN()}/${m}`;
const SUBS = "results/subscriptions.json";
const ACCOUNT_RE = /^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+(?:near|testnet)$/;
let subs = {}; // chatId -> [dao]
try { subs = JSON.parse(fs.readFileSync(SUBS, "utf-8")); } catch {}
// On Cloud Run the disk is wiped when the instance stops, so with SUBS_BUCKET set the subscriptions are
// also kept in gs://<bucket>/subscriptions.json (service-account token from the metadata server).
const BUCKET = () => process.env.SUBS_BUCKET;
async function gcsToken() {
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  return (await r.json()).access_token;
}
let loaded = !BUCKET();
async function loadSubs() {
  if (loaded) return;
  try {
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET()}/o/subscriptions.json?alt=media`, { headers: { Authorization: `Bearer ${await gcsToken()}` }, signal: AbortSignal.timeout(10000) });
    if (r.ok) subs = { ...(await r.json()), ...subs };
    if (r.ok || r.status === 404) loaded = true;
  } catch {}
}
const save = async () => {
  try { fs.writeFileSync(SUBS, JSON.stringify(subs, null, 1)); } catch {}
  if (!BUCKET()) return;
  try {
    await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET()}/o?uploadType=media&name=subscriptions.json`, { method: "POST", headers: { Authorization: `Bearer ${await gcsToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(subs), signal: AbortSignal.timeout(10000) });
  } catch {}
};
let offset = 0;

export const telegramConfigured = () => Boolean(TOKEN());

async function call(method, body) {
  const r = await fetch(API(method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return r.json();
}
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function message(item, base = process.env.PUBLIC_URL || "") {
  const icon = { BLOCK: "🛑", WARN: "⚠️", CLEAN: "✅" }[item.verdict];
  const link = base ? `\n<a href="${base}/?dao=${item.dao}&id=${item.id}">Full check</a>` : "";
  return `${icon} <b>${item.verdict}</b> ${esc(item.dao)} #${item.id}\n<b>Does:</b> ${esc(item.does)}\n<b>Says:</b> ${esc(item.says.slice(0, 220))}${item.why.length ? "\n<b>Why:</b> " + esc(item.why.slice(0, 3).join("; ")) : ""}${link}`;
}

/** Send an alert to every chat watching this DAO (any verdict), and non-CLEAN ones to the feed chat. */
export async function notify(item) {
  if (!telegramConfigured()) return;
  await loadSubs();
  const chats = Object.entries(subs).filter(([, daos]) => daos.includes(item.dao)).map(([c]) => c);
  if (process.env.TELEGRAM_FEED_CHAT && item.verdict !== "CLEAN") chats.push(process.env.TELEGRAM_FEED_CHAT);
  for (const chat_id of new Set(chats)) await call("sendMessage", { chat_id, text: message(item), parse_mode: "HTML", disable_web_page_preview: true });
}

/** Handle /watch, /stop, /list, /start commands (long polling, called on each tick). */
export async function pollCommands() {
  if (!telegramConfigured()) return;
  await loadSubs();
  const r = await call("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
  for (const u of r.result || []) {
    offset = u.update_id + 1;
    const chat = String(u.message?.chat?.id || "");
    const [cmd, arg] = String(u.message?.text || "").trim().split(/\s+/);
    if (!chat || !cmd) continue;
    const dao = (arg || "").toLowerCase();
    let reply;
    if (cmd === "/watch" && ACCOUNT_RE.test(dao)) { subs[chat] = [...new Set([...(subs[chat] || []), dao])].slice(0, 20); await save(); reply = `Watching ${dao}. You'll get every new proposal with QuorumGuard's verdict.`; }
    else if (cmd === "/stop" && dao) { subs[chat] = (subs[chat] || []).filter((d) => d !== dao); await save(); reply = `Stopped watching ${dao}.`; }
    else if (cmd === "/list") reply = (subs[chat] || []).length ? `Watching: ${subs[chat].join(", ")}` : "Not watching any DAO yet. Send /watch yourdao.sputnik-dao.near";
    else reply = "QuorumGuard checks what a NEAR DAO proposal really does before anyone votes.\n/watch yourdao.sputnik-dao.near\n/stop yourdao.sputnik-dao.near\n/list";
    await call("sendMessage", { chat_id: chat, text: reply });
  }
}
