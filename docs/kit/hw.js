/* Homework kit for the student app (docs/kit/hw.js).
   A homework page at docs/p/<student>/<hwId>/index.html includes this file and calls HW.start({...}).
   The kit loads the student's saved answers, saves every change to the server (key "hw:<id>"),
   handles "send to Stacy", and gives Stacy a read-only preview. See HOMEWORK.md in the repo root. */
(function(){
  var API = "https://nrnjubhnpaicuokidnjl.supabase.co/functions/v1/app";
  var AUTH = null, h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
  var init = h.get("tgWebAppData"), k = h.get("k") || q.get("k"), preview = /[?&]preview=1/.test(location.search);
  if (init){ try{ sessionStorage.setItem("tgInit", init); }catch(e){} AUTH = "tg " + init; }
  else if (!(preview && k)) { try{ var si = sessionStorage.getItem("tgInit"); if (si) AUTH = "tg " + si; }catch(e){} }
  if (!AUTH && k) AUTH = "key " + k;
  if (!AUTH){ try{ var sk = localStorage.getItem("myKey"); if (sk) AUTH = "key " + sk; }catch(e){} }

  var cfg = null, KEY = "", LS = "", loaded = false, pending = null, timer = null;
  var HW = window.HW = { submitted: false, preview: preview, ready: false };
  function local(){ try{ return JSON.parse(localStorage.getItem(LS) || "null"); }catch(e){ return null; } }
  function flush(){
    if (pending == null || !AUTH || preview) return; var body = pending;
    fetch(API + "/state", { method: "POST", keepalive: body.length < 60000, headers: { "x-auth": AUTH, "content-type": "application/json" }, body: body })
      .then(function(r){ if (r.ok && pending === body) pending = null; }).catch(function(){});
  }
  /* Call after every change (end of render(), on every text input). Cheap: it waits 0.8 s and sends once. */
  HW.save = function(){
    if (!loaded || !cfg) return;
    var data; try{ data = { title: cfg.title, submitted: !!HW.submitted, summary: String(cfg.summary() || ""), s: cfg.get(), at: Date.now() }; }catch(e){ return; }
    try{ localStorage.setItem(LS, JSON.stringify(data)); }catch(e){}
    pending = JSON.stringify({ key: KEY, data: data }); clearTimeout(timer);
    timer = setTimeout(flush, HW.submitted ? 0 : 800);
  };
  /* "Send to Stacy": marks the homework finished (server ticks it done on the student's page and messages Stacy). */
  HW.submit = function(){ HW.submitted = true; HW.save(); if (cfg && cfg.render) cfg.render(); };
  /* Ready-made block for the last step: a button, or the confirmation once sent. opts.lang: "ru" (default) | "en". */
  HW.sendBlock = function(opts){
    var en = opts && opts.lang === "en", box = document.createElement("div");
    if (HW.submitted){ box.className = "hw-sent"; box.textContent = en ? "Sent ✓ Stacy can see your answers." : "Отправлено ✓ Stacy видит твои ответы."; return box; }
    var b = document.createElement("button"); b.type = "button"; b.className = (opts && opts.className) || "btn primary";
    b.textContent = (opts && opts.label) || (en ? "Done — send to Stacy" : "Готово — отправить Stacy");
    b.onclick = function(){ HW.submit(); }; box.appendChild(b); return box;
  };
  /* opts: { id, title, get(), set(savedState), summary(), render() }.
     get() returns plain JSON-safe state; set() restores it (validate lengths!); summary() is the text Stacy reads;
     render() draws the page. The kit calls set() (if there is saved state) and then render() once. */
  HW.start = function(opts){
    cfg = opts; KEY = "hw:" + opts.id; LS = "hw:" + location.pathname;
    var done = false, fin = function(d){
      if (done) return; done = true;
      try{ if (d && d.s){ cfg.set(d.s); HW.submitted = !!d.submitted; } }catch(e){}
      loaded = true; HW.ready = true; cfg.render();
      if (preview){ var n = document.createElement("div"); n.textContent = "Preview for Stacy: the student's answers. Nothing you tap here is saved.";
        n.style.cssText = "position:sticky;top:0;z-index:99;background:#fbe6d8;color:#1b2624;padding:8px 14px;font:600 14px system-ui,sans-serif"; document.body.insertBefore(n, document.body.firstChild);
        document.querySelectorAll("[data-hw-back]").forEach(function(a){ a.remove(); }); }
    };
    if (!AUTH){ fin(local()); return; }
    setTimeout(function(){ fin(local()); }, 7000);
    fetch(API + "/state", { headers: { "x-auth": AUTH } }).then(function(r){ if (!r.ok) throw 0; return r.json(); })
      .then(function(j){ var sv = (j.state || {})[KEY] || null, lc = preview ? null : local(); fin(sv && lc && (lc.at || 0) > (sv.at || 0) ? lc : (sv || lc)); })
      .catch(function(){ fin(local()); });
  };
  document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "hidden") flush(); });
  setInterval(flush, 30000);
})();
