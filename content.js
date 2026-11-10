(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  // [speech locale, label, LanguageTool code]
  const LANGS = [
    ["ar-SA", "AR", "ar"],
    ["en-US", "EN", "en-US"],
  ];
  let langIdx = 0;
  let autoFix = true;
  let pos = null; // {x, y} saved panel position (viewport px)
  let target = null;
  let rec = null;
  let listening = false;
  let pending = 0;
  let queue = Promise.resolve(); // keeps chunks in the order they were spoken
  let msgTimer = 0;

  const store = {
    get(keys, cb) {
      try { chrome.storage.local.get(keys, cb); } catch (_) {}
    },
    set(obj) {
      try { chrome.storage.local.set(obj); } catch (_) {}
    },
  };

  // ---------- UI (shadow DOM so page CSS can't break it) ----------
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;top:0;left:0;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box}
      .panel{position:relative;display:flex;align-items:center;gap:7px;height:48px;padding:0 10px 0 4px;
        background:#1B2540;border-radius:24px;color:#EAF0FF;direction:ltr;
        font:600 12px/1 Tajawal,"Segoe UI",system-ui,sans-serif;
        box-shadow:0 8px 28px rgba(12,18,40,.4),inset 0 0 0 1px rgba(255,255,255,.08);
        user-select:none;-webkit-user-select:none}
      .panel.drag,.panel.drag .grip{cursor:grabbing}
      .grip{width:20px;height:36px;display:grid;grid-template-columns:repeat(2,3px);grid-auto-rows:3px;
        gap:3px;align-content:center;justify-content:center;cursor:grab}
      .grip i{background:#7F8CB5;border-radius:50%}
      button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center}
      #mic{width:36px;height:36px;border-radius:50%;background:#EEF2FF;color:#1B2540;transition:background .15s}
      #mic:hover{background:#fff}
      #mic.on{background:#E5484D;color:#fff;animation:ring 1.3s infinite}
      @keyframes ring{0%{box-shadow:0 0 0 0 rgba(229,72,77,.55)}100%{box-shadow:0 0 0 11px rgba(229,72,77,0)}}
      #lang{height:30px;padding:3px;border-radius:15px;background:rgba(255,255,255,.08)}
      #lang span{min-width:28px;height:24px;display:flex;align-items:center;justify-content:center;
        border-radius:12px;color:#9AA6CC;font-size:12px;letter-spacing:.02em}
      #lang span.sel{background:#EAF0FF;color:#1B2540}
      #fix{height:30px;padding:0 10px 0 8px;border-radius:15px;gap:5px;color:#8F9BC2;background:rgba(255,255,255,.06)}
      #fix.on{color:#7DE2B0;background:rgba(61,214,140,.15)}
      .msg{position:absolute;width:max-content;max-width:280px;padding:7px 11px;border-radius:11px;
        background:#EAF0FF;color:#1B2540;font:500 13px/1.45 Tajawal,"Segoe UI",system-ui,sans-serif;
        unicode-bidi:plaintext;text-align:start;display:none;box-shadow:0 4px 16px rgba(12,18,40,.25)}
      .panel.up .msg{bottom:calc(100% + 8px)}
      .panel.down .msg{top:calc(100% + 8px)}
      .panel.r .msg{right:0}
      .panel.l .msg{left:0}
      @media (prefers-reduced-motion:reduce){#mic.on{animation:none}}
    </style>
    <div class="panel down l" id="panel">
      <div class="grip" id="grip" title="Drag to move (double-click to reset)"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <button id="mic" aria-label="Start or stop dictation">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
      </button>
      <button id="lang" aria-label="Switch language (Alt+L)" title="Switch language (Alt+L)"></button>
      <button id="fix" aria-pressed="true" title="Auto-correct grammar. Sends the spoken text to languagetool.org.">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        Fix
      </button>
      <div class="msg" id="msg"></div>
    </div>`;
  const $panel = root.getElementById("panel");
  const $grip = root.getElementById("grip");
  const $mic = root.getElementById("mic");
  const $lang = root.getElementById("lang");
  const $fix = root.getElementById("fix");
  const $msg = root.getElementById("msg");
  const langSpans = LANGS.map(([, label]) => {
    const s = document.createElement("span");
    s.textContent = label;
    $lang.appendChild(s);
    return s;
  });
  document.documentElement.appendChild(host);

  function ui() {
    langSpans.forEach((s, i) => s.classList.toggle("sel", i === langIdx));
    $mic.classList.toggle("on", listening);
    $fix.classList.toggle("on", autoFix);
    $fix.setAttribute("aria-pressed", String(autoFix));
  }

  function showMsg(text) {
    $msg.textContent = text || "";
    $msg.style.display = text ? "block" : "none";
  }

  function flash(text, ms = 3000) {
    showMsg(text);
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      if ($msg.textContent === text) showMsg("");
    }, ms);
  }

  // ---------- draggable position ----------
  function clampPos(p) {
    const w = host.offsetWidth || 220;
    const h = host.offsetHeight || 48;
    return {
      x: Math.round(Math.max(4, Math.min(p.x, window.innerWidth - w - 4))),
      y: Math.round(Math.max(4, Math.min(p.y, window.innerHeight - h - 4))),
    };
  }

  function applyPos() {
    if (host.style.display === "none") return;
    const w = host.offsetWidth || 220;
    const h = host.offsetHeight || 48;
    const p = clampPos(pos || { x: window.innerWidth - w - 24, y: window.innerHeight - h - 24 });
    host.style.left = p.x + "px";
    host.style.top = p.y + "px";
    const up = p.y > window.innerHeight / 2;
    const right = p.x + w / 2 > window.innerWidth / 2;
    $panel.classList.toggle("up", up);
    $panel.classList.toggle("down", !up);
    $panel.classList.toggle("r", right);
    $panel.classList.toggle("l", !right);
  }

  let drag = null;
  // mousedown + preventDefault keeps the cursor in the page's text field
  $panel.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (e.button !== 0 || e.target.closest("button")) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    $panel.classList.add("drag");
  });
  window.addEventListener(
    "mousemove",
    (e) => {
      if (!drag) return;
      pos = clampPos({ x: e.clientX - drag.dx, y: e.clientY - drag.dy });
      applyPos();
    },
    true
  );
  function endDrag() {
    if (!drag) return;
    drag = null;
    $panel.classList.remove("drag");
    if (pos) store.set({ pos });
  }
  window.addEventListener("mouseup", endDrag, true);
  window.addEventListener("blur", endDrag); // mouse released outside the window
  $grip.addEventListener("dblclick", () => {
    pos = null;
    store.set({ pos: null });
    applyPos();
  });
  window.addEventListener("resize", applyPos);

  function show() {
    host.style.display = "block";
    applyPos();
  }
  function hide() {
    host.style.display = "none";
    showMsg("");
  }

  store.get(["langIdx", "autoFix", "pos"], (r) => {
    if (!r) return;
    if (typeof r.langIdx === "number" && LANGS[r.langIdx]) langIdx = r.langIdx;
    if (typeof r.autoFix === "boolean") autoFix = r.autoFix;
    if (r.pos && Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y)) pos = r.pos;
    ui();
    applyPos();
  });

  // ---------- which elements count as "typeable" ----------
  const TEXT_TYPES = ["text", "search", "email", "url", "tel", ""];
  function isEditable(el) {
    if (!el || el === host) return false;
    if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (el.tagName === "INPUT")
      return (
        TEXT_TYPES.includes((el.type || "").toLowerCase()) &&
        !el.readOnly &&
        !el.disabled
      );
    return !!el.isContentEditable;
  }

  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.composedPath()[0];
      if (isEditable(el)) {
        if (listening && el !== target) stop();
        target = el;
        show();
      }
    },
    true
  );

  document.addEventListener(
    "focusout",
    () => {
      setTimeout(() => {
        if (drag) return;
        const a = document.activeElement;
        if (!isEditable(a)) {
          stop();
          target = null;
          hide();
        }
      }, 150);
    },
    true
  );

  // ---------- inserting text ----------
  function insert(el, text) {
    if (!el || !el.isConnected || el !== target) return;
    el.focus();
    const ok = document.execCommand("insertText", false, text);
    if (!ok && "value" in el) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      el.setRangeText(text, s, e, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ---------- recheck / correct (free: LanguageTool via background.js) ----------
  async function fix(text, lang) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "correct", text, lang });
      if (r && r.ok && typeof r.text === "string" && r.text.trim()) return r.text.trim();
      if (r && r.error === "rate") flash("Correction limit reached for now. Typing as spoken.");
    } catch (_) {
      // extension reloaded or worker asleep: fall back to the spoken text
    }
    return text;
  }

  function commit(raw) {
    if (!raw) return;
    const el = target;
    const li = langIdx;
    pending++;
    if (autoFix) showMsg("Checking…");
    queue = queue
      .then(async () => {
        const text = autoFix ? await fix(raw, LANGS[li][2]) : raw;
        insert(el, text + " ");
      })
      .catch(() => {})
      .finally(() => {
        pending--;
        if (pending === 0 && $msg.textContent === "Checking…") showMsg("");
      });
  }

  // ---------- speech ----------
  function start() {
    if (!target) return;
    rec = new SR();
    rec.lang = LANGS[langIdx][0];
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) commit(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      if (interim) showMsg(interim);
      else if (!pending) showMsg("");
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        listening = false;
        flash("Mic blocked. Allow the microphone for this site (lock icon in the address bar).", 6000);
        ui();
      } else if (e.error === "network") {
        listening = false;
        flash("No internet. Speech recognition needs a connection.", 5000);
        ui();
      }
    };

    // Chrome stops after silence; restart while the user still wants it on
    rec.onend = () => {
      if (listening) {
        try { rec.start(); } catch (_) {}
      } else {
        if (!pending) showMsg("");
        ui();
      }
    };

    listening = true;
    try { rec.start(); } catch (_) {}
    ui();
  }

  function stop() {
    listening = false;
    if (rec) {
      try { rec.stop(); } catch (_) {}
    }
    ui();
  }

  $mic.addEventListener("click", () => (listening ? stop() : start()));

  function toggleLang() {
    langIdx = (langIdx + 1) % LANGS.length;
    store.set({ langIdx });
    const wasOn = listening;
    if (wasOn) stop();
    ui();
    if (wasOn) setTimeout(start, 300);
  }
  $lang.addEventListener("click", toggleLang);

  $fix.addEventListener("click", () => {
    autoFix = !autoFix;
    store.set({ autoFix });
    ui();
    flash(autoFix ? "Auto-correct on" : "Auto-correct off", 1500);
  });

  // Alt+L switches language from the keyboard while a field is focused
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && e.code === "KeyL" && target) {
        e.preventDefault();
        toggleLang();
      }
    },
    true
  );

  ui();
})();
