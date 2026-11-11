"""Turn a student's existing page into an app page whose progress saves to the database.
Usage: python3 build_page.py <source.html> <out.html>"""
import sys
src, out = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f"patch point found {n}x (expected {count}): {old[:70]!r}")
    s = s.replace(old, new)

# 1) profile comes from the database (Stacy/Claude edit it there, no redeploy)
rep("  homework: []\n};", "  homework: []\n};\ntry{ Object.assign(PROFILE, window.__PROFILE || {}); }catch(e){}")
# 2) card progress: server first, then this phone; every save also goes to the server
rep('try{ const raw = JSON.parse(localStorage.getItem(KEY)||"null"); if(raw && raw.s) store = Object.assign(store, raw); }catch(e){}',
    'try{ const raw = (window.__STATE && window.__STATE.cards) || JSON.parse(localStorage.getItem(KEY)||"null"); if(raw && raw.s) store = Object.assign(store, raw); }catch(e){}')
rep('const save = () => { try{ localStorage.setItem(KEY, JSON.stringify(store)); }catch(e){} };',
    'const save = () => { try{ localStorage.setItem(KEY, JSON.stringify(store)); }catch(e){} try{ window.__sync && __sync("cards", store); }catch(e){} };')
# 3) diary: same
rep('try{ var r = JSON.parse(localStorage.getItem(DK)||"null"); if(r && r.e) D = {e:r.e||{}, sent:r.sent||{}}; }catch(e){}',
    'try{ var r = (window.__STATE && window.__STATE.diary) || JSON.parse(localStorage.getItem(DK)||"null"); if(r && r.e) D = {e:r.e||{}, sent:r.sent||{}}; }catch(e){}')
rep('function dsave(){ try{ localStorage.setItem(DK, JSON.stringify(D)); }catch(e){} }',
    'function dsave(){ try{ localStorage.setItem(DK, JSON.stringify(D)); }catch(e){} try{ window.__sync && __sync("diary", D); }catch(e){} }')
# 4) "I've paid" button after the payment/package blocks render
rep('  $("schedPh").hidden = true; $("zoomLink2").href = P.zoom || "#"; $("zoomLink2").hidden = !P.zoom;',
    '  $("schedPh").hidden = true; $("zoomLink2").href = P.zoom || "#"; $("zoomLink2").hidden = !P.zoom;\n  try{ window.__payUI && __payUI(P); }catch(e){}')
# 4b) only call the package "paid" when it is
rep("<b>Оплачен пакет: '+K.size+' уроков</b>'", "<b>'+(K.paid ? 'Оплачен пакет: ' : 'Пакет: ')+K.size+' уроков</b>'")
# 5) page scripts wait for the saved progress to load
n = s.count("<script>")
s = s.replace("<script>", '<script type="text/plain" data-boot>')
if n != 3: raise SystemExit(f"expected 3 page scripts, found {n}")

BOOT = r'''
<style>
.bootmsg{position:fixed;inset:0;display:grid;place-items:center;background:#F6F1E7;z-index:99;font:500 16px/1.5 Raleway,system-ui,sans-serif;color:#231815;text-align:center;padding:24px}
.syncnote{position:fixed;left:50%;transform:translateX(-50%);top:max(8px,env(safe-area-inset-top));background:#231815;color:#F6F1E7;font:600 13px Raleway,system-ui,sans-serif;padding:6px 12px;border-radius:99px;z-index:98}
html,body{overflow-x:clip}
.paybar{flex-wrap:wrap}
.payrow{flex-basis:100%;display:flex;gap:10px;margin-top:12px}
.payrow > a,.payrow > button{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;text-align:center;border-radius:999px;padding:12px 10px;font-family:var(--caps);font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700;text-decoration:none;border:1.5px solid var(--brown);cursor:pointer;line-height:1.2;width:auto}
.payrow .pr-pay{background:var(--brown);color:var(--on-brown)}
.payrow .pr-paid{background:transparent;color:var(--brown)}
.payrow .paydone{font-weight:600;font-size:.9rem;color:var(--muted)}
</style>
<div class="bootmsg" id="bootmsg">Загружаю…</div>
<script>
(function(){
  var API = "https://nrnjubhnpaicuokidnjl.supabase.co/functions/v1/app";
  function tgPost(type){ try{ if (window.TelegramWebviewProxy) TelegramWebviewProxy.postEvent(type, "{}"); else if (window.parent !== window) window.parent.postMessage(JSON.stringify({eventType:type, eventData:{}}), "*"); }catch(e){} }
  tgPost("web_app_ready"); tgPost("web_app_expand");

  var preview = /[?&]preview=1/.test(location.search), AUTH = null;
  var h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search), init = h.get("tgWebAppData"), k = h.get("k") || q.get("k");
  if (preview && k) init = null; // teacher preview: always show the student in the link
  if (init){ try{ sessionStorage.setItem("tgInit", init); }catch(e){} AUTH = "tg " + init; }
  else if (!(preview && k)) { try{ var si = sessionStorage.getItem("tgInit"); if (si) AUTH = "tg " + si; }catch(e){} }
  if (!AUTH && k){ if (!preview){ try{ localStorage.setItem("myKey", k); }catch(e){} } AUTH = "key " + k; }
  if (!AUTH){ try{ var sk = localStorage.getItem("myKey"); if (sk) AUTH = "key " + sk; }catch(e){} }

  // ---- saving to the server (debounced; retried on hide and every 30 s) ----
  var pending = {}, timers = {};
  function flush(key){
    var body = pending[key]; if (body == null || !AUTH || preview) return;
    fetch(API + "/state", { method: "POST", keepalive: body.length < 60000,
      headers: { "x-auth": AUTH, "content-type": "application/json" },
      body: '{"key":' + JSON.stringify(key) + ',"data":' + body + '}' })
      .then(function(r){ if (r.ok && pending[key] === body) delete pending[key]; }).catch(function(){});
  }
  window.__sync = function(key, data){
    if (preview || !AUTH) return;
    pending[key] = JSON.stringify(data); clearTimeout(timers[key]);
    timers[key] = setTimeout(function(){ flush(key); }, 800);
  };
  document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "hidden") Object.keys(pending).forEach(flush); });
  setInterval(function(){ Object.keys(pending).forEach(flush); }, 30000);

  // ---- payment row: [Оплатить] [Я оплатила] under the payment text ----
  function todayIn(tz){ try{ return new Intl.DateTimeFormat("en-CA",{timeZone:tz||"Europe/Moscow"}).format(new Date()); }catch(e){ return new Date().toISOString().slice(0,10); } }
  window.__payUI = function(P){
    var paidNow = P.paidClaimed && P.paidClaimed === todayIn(P.tzName);
    [["payBar", true], ["planPay", false]].forEach(function(x){
      var el = document.getElementById(x[0]); if (!el || el.hidden) return;
      if (x[1] && el.classList.contains("pkgbar")) return;
      var old = el.querySelector(".payrow"); if (old) old.remove();
      if (!P.nextPayment && !paidNow) return;
      if (x[1] && P.package){
        // bold line = the package, small line = the payment date
        var tb = el.querySelector(".t b"), ts = el.querySelector(".t span");
        if (tb && ts){ var dateLine = tb.textContent; tb.textContent = P.package; ts.textContent = dateLine; }
      }
      var link = x[1] ? el.querySelector(":scope > a") : el.querySelector("a.btn");
      var row = document.createElement("div"); row.className = "payrow";
      if (paidNow){
        if (link) link.remove();
        row.innerHTML = '<span class="paydone">Оплата отмечена ✓ Stacy проверит.</span>'; el.appendChild(row); return;
      }
      if (link){ link.textContent = "Оплатить"; link.className = "pr-pay"; row.appendChild(link); }
      var b = document.createElement("button"); b.type = "button"; b.className = "pr-paid"; b.textContent = "Я оплатила";
      var armed = false;
      b.onclick = function(){
        if (preview){ b.textContent = "Предпросмотр"; return; }
        if (!armed){ armed = true; b.textContent = "Подтвердить?"; setTimeout(function(){ armed = false; b.textContent = "Я оплатила"; }, 4000); return; }
        b.disabled = true; b.textContent = "…";
        fetch(API + "/paid", { method: "POST", headers: { "x-auth": AUTH } }).then(function(r){ if (!r.ok) throw 0; return r.json(); })
          .then(function(j){ Object.assign(PROFILE, j.profile || {}); try{ renderProfile(); }catch(e){} })
          .catch(function(){ b.disabled = false; b.textContent = "Ещё раз"; });
      };
      row.appendChild(b); el.appendChild(row);
    });
  };

  function note(t){ var n = document.createElement("div"); n.className = "syncnote"; n.textContent = t; document.body.appendChild(n); }
  function run(hadServerCards){
    document.querySelectorAll('script[type="text/plain"][data-boot]').forEach(function(sc){
      var n = document.createElement("script"); n.text = sc.textContent; document.body.appendChild(n);
    });
    var m = document.getElementById("bootmsg"); if (m) m.remove();
    if (preview) note("Предпросмотр: изменения не сохраняются");
    try{
      if (!preview && AUTH){
        __sync("cards_meta", { cap: typeof DAILY_CAP !== "undefined" ? DAILY_CAP : 12, words: ALL,
          topics: TOPICS.map(function(t){ return { name: t.name, words: t.words }; }) });
        if (!hadServerCards && store && store.s && Object.keys(store.s).length) __sync("cards", store);
      }
    }catch(e){}
  }

  if (!AUTH){ document.getElementById("bootmsg").textContent = "Открой эту страницу по личной ссылке от Stacy 🙂"; return; }
  var done = false, timer = setTimeout(function(){ if (!done){ done = true; run(false); note("Нет связи — прогресс сохранится, когда интернет вернётся"); } }, 9000);
  fetch(API + "/state", { headers: { "x-auth": AUTH } })
    .then(function(r){ if (r.status === 401) throw "auth"; if (!r.ok) throw "net"; return r.json(); })
    .then(function(j){
      if (done) return; done = true; clearTimeout(timer);
      window.__STATE = j.state || {}; window.__PROFILE = j.profile || {};
      run(!!(j.state && j.state.cards));
    })
    .catch(function(e){
      if (done) return; done = true; clearTimeout(timer);
      if (e === "auth"){ document.getElementById("bootmsg").textContent = "Не узнаю эту ссылку. Попроси у Stacy личную ссылку 🙂"; return; }
      run(false); note("Нет связи — прогресс сохранится, когда интернет вернётся");
    });
})();
</script>
'''
i = s.index('<script type="text/plain" data-boot>')
s = s[:i] + BOOT + s[i:]
open(out, "w", encoding="utf-8").write(s)
print("ok", len(s))
