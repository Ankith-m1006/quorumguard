// Text scan of a proposal description for content aimed at an AI reader instead of a human one.
// Every finding has a family, a severity ("block" | "warn") and the evidence it matched.

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­]/g;
const BIDI = /[‪-‮]/g;            // embeddings and overrides: reorder what you see
const ISOLATES = /[⁦-⁩]/g;        // isolates: X/Twitter wraps copied @handles in these, harmless
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
const DEVANAGARI = /[ऀ-ॿ]/;
const KANNADA = /[ಀ-೿]/;
// Cyrillic letters that look Latin. A word mixing these with Latin letters is a lookalike spelling;
// a stray non-lookalike letter (a keyboard-layout slip like "Passedю") is not.
const CONFUSABLE_CYRILLIC = "аеорсухіјѕԁԛԝАВЕКМНОРСТХІЈЅ";
const lookalikeWord = (w) => /[a-zA-Z]/.test(w) && [...w].some((c) => CONFUSABLE_CYRILLIC.includes(c));

// Unicode tag characters carry invisible ASCII: U+E0041 is a hidden "A".
export const decodeTags = (s) => [...s].filter((c) => /[\u{E0000}-\u{E007F}]/u.test(c)).map((c) => String.fromCharCode(c.codePointAt(0) - 0xE0000)).join("");

const AI_DIRECTED = [
  [/\bignore (all |any )?(the )?(previous|prior|above|earlier|other) (instructions|rules|guidelines|checks)/i, "tells the reader to ignore its instructions"],
  [/\b(you are|act as|as) (an? |the )?(ai|assistant|screener|delegate|reviewer|model|llm|agent)\b/i, "speaks to an AI reader directly"],
  [/\b(note|message|instruction)s? (to|for) (the )?(ai|assistant|screener|delegate|reviewer|model|llm|agent|bot)s?\b/i, "addresses an AI reader"],
  [/(^|\n)\s*(system|assistant|developer)\s*:/i, "fake chat role marker"],
  [/<\/?(system|instructions?|assistant|im_start|im_end)\b[^>]*>|\[\/?INST\]|<\|im_(start|end)\|>/i, "fake prompt-format tags"],
  [/\b(vote|votes|voting) (yes|approve|for)\b|\bmust (be )?(approve|approved|pass)\b|\b(approve|pass) (this|immediately|without)\b/i, "tells the reader how to vote"],
  [/\b(mark|classify|rate|label|treat|score)( this| it)? (as )?(safe|clean|approved|compliant|low[- ]risk|routine|benign)\b/i, "tells the reader what verdict to give"],
  [/\b(do not|don't|never) (flag|mention|report|warn|escalate|summari[sz]e|check|decode|look at)\b/i, "tells the reader to hide something"],
];

const FAKE_AUTHORITY = [
  [/\b(pre-?approved|already approved|has been approved|was approved) (by|from)\b/i, "claims prior approval"],
  [/\b(security council|foundation|core team|auditors?|house of stake|near foundation|admins?) (has |have )?(approved|verified|signed off|cleared|audited)\b/i, "claims sign-off by an authority"],
  [/\b(audited|verified|whitelisted|allowlisted) by\b/i, "claims an audit or allowlist"],
  [/\b(emergency|urgent|time[- ]sensitive|within the hour|before (the )?deadline)\b/i, "creates urgency"],
];

const VOTE = "tells the reader how to vote";

function add(findings, family, severity, why, evidence) {
  findings.push({ family, severity, why, evidence: String(evidence).slice(0, 160) });
}

/** Scan one description. Returns { findings, visibleText, hiddenText }. */
export function scan(description = "") {
  const findings = [];
  const raw = String(description);

  const zw = raw.match(ZERO_WIDTH) || [];
  if (zw.length) add(findings, "hidden-unicode", zw.length >= 3 ? "block" : "warn", `${zw.length} zero-width character(s) hide text boundaries`, zw.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()).slice(0, 6).join(" "));
  if (BIDI.test(raw)) add(findings, "hidden-unicode", "block", "bidirectional override characters can make text display differently from what it says", "bidi controls present");
  if (ISOLATES.test(raw)) add(findings, "hidden-unicode", "info", "bidi isolate marks (common in text copied from X)", "U+2066..2069");
  const hidden = decodeTags(raw);
  if (hidden) add(findings, "hidden-unicode", "block", "invisible Unicode tag characters carry hidden text", hidden);

  // Comments and invisible markup: rendered UIs hide these, an AI reading the raw text sees them.
  const comments = [...raw.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1].trim()).filter(Boolean);
  const mdComments = [...raw.matchAll(/^\s*\[(?:\/\/|comment|_)\]:\s*#\s*\(?([^\n)]*)\)?/gim)].map((m) => m[1].trim());
  const invisible = [...raw.matchAll(/<(span|div|p)[^>]*style=["'][^"']*(display:\s*none|visibility:\s*hidden|font-size:\s*0|color:\s*(white|#fff\b|#ffffff|transparent))[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[4].trim());
  for (const c of [...comments, ...mdComments, ...invisible]) add(findings, "hidden-markup", "block", "text hidden from human readers by markup", c);

  // Encoded payloads: decode and look inside.
  const noUrls = raw.replace(/\bhttps?:\/\/\S+/gi, " ");
  for (const m of noUrls.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    const txt = Buffer.from(m[0], "base64").toString("utf-8");
    if (/^[\x20-\x7E\s]{20,}$/.test(txt)) add(findings, "encoded", "block", "base64 text in a description decodes to readable words", txt);
  }

  // Hidden text gets scanned as if visible, so a hidden "vote yes" is caught twice: once for hiding, once for what it says.
  const visible = raw.replace(ZERO_WIDTH, "").replace(BIDI, "").replace(ISOLATES, "").replace(TAGS, "");
  const everything = [visible, hidden].join("\n");
  // "Please vote yes" is normal between humans; it only blocks when the text also talks to an AI or hides itself.
  for (const [re, why] of AI_DIRECTED) { const m = everything.match(re); if (m) add(findings, "ai-directed", why === VOTE ? "warn" : "block", why, m[0]); }
  const escalate = hidden || findings.some((f) => (f.severity === "block" && f.family !== "ai-directed") || (f.family === "ai-directed" && f.why !== VOTE));
  if (escalate) for (const f of findings) if (f.why === VOTE) f.severity = "block";
  for (const [re, why] of FAKE_AUTHORITY) { const m = everything.match(re); if (m) add(findings, "fake-authority", why === "creates urgency" ? "warn" : "block", why, m[0]); }

  // Another script inside an English proposal: humans skim past it, models read it.
  const latin = (visible.match(/[a-zA-Z]/g) || []).length;
  for (const [re, lang] of [[DEVANAGARI, "Hindi (Devanagari)"], [KANNADA, "Kannada"]]) {
    if (re.test(visible) && latin > 40) {
      const seg = visible.split(/\n/).find((l) => re.test(l)) || "";
      add(findings, "mixed-script", "warn", `a ${lang} line inside an English proposal; checked after translation`, seg.trim());
    }
  }
  const cy = visible.split(/[^\p{L}]+/u).find(lookalikeWord);
  if (cy) add(findings, "mixed-script", "block", "a word mixes Latin letters with Cyrillic lookalikes", cy);

  return { findings, visibleText: visible, hiddenText: hidden };
}
