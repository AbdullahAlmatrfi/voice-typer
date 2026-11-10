// Voice Typer — correction worker.
// Sends one short dictated sentence to the free LanguageTool API and
// applies its grammar / punctuation fixes. Any failure returns ok:false,
// and the content script then types the text exactly as spoken.

const LT_URL = "https://api.languagetool.org/v2/check";
const MAX_CHARS = 3000;
// Dictation already produces real words, so "misspelling" hits are almost
// always names or brands. Skip them (and pure style tips) to avoid damage.
const SKIP_TYPES = new Set(["misspelling", "style"]);

function applyMatches(text, matches) {
  const usable = (matches || [])
    .filter((m) => {
      const type = m.rule && m.rule.issueType;
      return !SKIP_TYPES.has(type) && m.replacements && m.replacements.length;
    })
    .sort((a, b) => a.offset - b.offset);

  let out = "";
  let cursor = 0;
  for (const m of usable) {
    if (m.offset < cursor) continue; // overlapping match, keep the first
    out += text.slice(cursor, m.offset) + m.replacements[0].value;
    cursor = m.offset + m.length;
  }
  return out + text.slice(cursor);
}

async function correct(text, lang) {
  if (!text || text.length > MAX_CHARS) return { ok: false, error: "size" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(LT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text, language: lang }),
      signal: ctl.signal,
    });
    if (res.status === 429) return { ok: false, error: "rate" };
    if (!res.ok) return { ok: false, error: "http" };
    const data = await res.json();
    return { ok: true, text: applyMatches(text, data.matches) };
  } catch (_) {
    return { ok: false, error: "network" };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "correct") return;
  correct(msg.text, msg.lang).then(sendResponse);
  return true; // keep the channel open for the async reply
});
