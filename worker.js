// Worker: combined ready-to-paste file
// Bindings required in Cloudflare: AUTOPOST_KV, TELEGRAM_BOT_TOKEN, ADMIN_KEY

const HTML_PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MiniApp</title>
  <style>
    body{font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial; padding:18px; color:#111}
    .card{padding:12px;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,0.06);background:#fff;max-width:720px}
    button{padding:10px 14px;border-radius:8px;border:none;cursor:pointer}
    .muted{color:#666;font-size:13px}
    pre{background:#f6f8fa;padding:8px;border-radius:8px;overflow:auto}
  </style>
</head>
<body>
  <div class="card">
    <h2>Mini App</h2>
    <p class="muted">Buka dari Telegram → tekan Open App. Tekan tombol untuk kirim data ke bot & verifikasi initData.</p>

    <p id="who">Checking...</p>

    <div style="display:flex;gap:8px;margin-top:8px">
      <button id="sendBtn">Kirim ke Bot (sendData)</button>
      <button id="verifyBtn">Verifikasi initData (server)</button>
    </div>

    <h4 style="margin-top:14px">Debug</h4>
    <div><strong>initDataUnsafe (client):</strong></div>
    <pre id="unsafe">-</pre>

    <div style="margin-top:10px">
      <strong>Server verify result:</strong>
      <pre id="verifyRes">-</pre>
    </div>
  </div>

  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();

    // show incoming unsafe data
    document.getElementById('unsafe').textContent = JSON.stringify(tg.initDataUnsafe, null, 2);

    const u = (tg.initDataUnsafe && tg.initDataUnsafe.user) ? tg.initDataUnsafe.user : null;
    document.getElementById('who').textContent = u ? ('Halo ' + (u.first_name||'') + ' (id:' + u.id + ')') : 'Tidak ada user data';

    document.getElementById('sendBtn').onclick = async () => {
      // Mengirim data ke Bot (bot menerima update web_app_data)
      tg.sendData(JSON.stringify({ action: 'open_app', at: new Date().toISOString(), user: tg.initDataUnsafe && tg.initDataUnsafe.user }));
      // Optional: juga record ke Worker server-side
      try {
        await fetch('/api/track_open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ initDataUnsafe: tg.initDataUnsafe, ts: new Date().toISOString() })
        });
      } catch (e) {
        console.warn('track_open failed', e);
      }
    };

    document.getElementById('verifyBtn').onclick = async () => {
      // tg.initData is the secure raw string (server must verify)
      // send to server endpoint to verify signature
      const payload = { initData: tg.initData }; // string
      try {
        const r = await fetch('/api/verify_init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const j = await r.json();
        document.getElementById('verifyRes').textContent = JSON.stringify(j, null, 2);
      } catch (err) {
        document.getElementById('verifyRes').textContent = 'Error: ' + String(err);
      }
    };
  </script>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // Bindings (pastikan nama ini sama persis di Dashboard -> Bindings)
    const ADMIN_KEY = env.ADMIN_KEY;
    const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
    const KV = env.AUTOPOST_KV; // KV namespace

    // OPTIONS / CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // HEALTH CHECK
      if (url.pathname === "/health") {
        return json({ ok: true, msg: "worker alive" });
      }

      // Serve HTML miniapp
      if ((url.pathname === "/" || url.pathname === "/index.html") && method === "GET") {
        return new Response(HTML_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", ...corsHeaders() }
        });
      }

      // HISTORY (GET)
      if (url.pathname === "/api/history" && method === "GET") {
        if (!KV) return json({ ok: false, error: "kv_binding_missing" }, 500);
        const data = (await KV.get("history", { type: "json" })) || [];
        return json({ ok: true, history: data });
      }

      // ADD TARGET
      if (url.pathname === "/api/add_target" && method === "POST") {
        const key = request.headers.get("x-admin-key");
        if (!ADMIN_KEY || key !== ADMIN_KEY) return json({ ok: false, error: "invalid_admin_key" }, 403);
        if (!KV) return json({ ok: false, error: "kv_binding_missing" }, 500);

        const body = await request.json().catch(() => ({}));
        const id = body.id;
        if (!id) return json({ ok: false, error: "missing id" }, 400);

        let list = (await KV.get("targets", { type: "json" })) || [];
        if (!Array.isArray(list)) list = [];
        if (!list.includes(id)) list.push(id);

        await KV.put("targets", JSON.stringify(list));
        return json({ ok: true, targets: list });
      }

      // BROADCAST / POST
      if (url.pathname === "/api/post" && method === "POST") {
        if (!BOT_TOKEN) return json({ ok: false, error: "telegram_token_missing" }, 500);
        if (!KV) return json({ ok: false, error: "kv_binding_missing" }, 500);

        const body = await request.json().catch(() => ({}));
        const msg = body.message || "";
        const delay = Number(body.delay || 0);

        let targets = body.targets;
        if (!Array.isArray(targets) || targets.length === 0) {
          targets = (await KV.get("targets", { type: "json" })) || [];
        }

        const results = [];
        for (const id of targets) {
          try {
            const r = await sendMessage(BOT_TOKEN, id, msg);
            results.push({ target: id, ok: !!r.ok, result: r });
          } catch (e) {
            results.push({ target: id, ok: false, error: String(e) });
          }
          if (delay > 0) await sleep(delay);
        }

        // Save history (limit last 20)
        let old = (await KV.get("history", { type: "json" })) || [];
        if (!Array.isArray(old)) old = [];
        old.push({
          at: new Date().toISOString(),
          message: msg,
          targets,
          results,
        });
        await KV.put("history", JSON.stringify(old.slice(-20)));

        return json({ ok: true, results });
      }

      // API: track open from client (store small log to KV)
      if (url.pathname === "/api/track_open" && method === "POST") {
        if (!KV) return json({ ok: false, error: "kv_binding_missing" }, 500);
        const body = await request.json().catch(()=>({}));
        let opens = (await KV.get("opens", { type: "json" })) || [];
        if (!Array.isArray(opens)) opens = [];
        opens.push({ at: new Date().toISOString(), data: body });
        await KV.put("opens", JSON.stringify(opens.slice(-200)));
        return json({ ok: true });
      }

      // API: verify initData (Telegram WebApp) — expects { initData: "<raw initData string>" }
      if (url.pathname === "/api/verify_init" && method === "POST") {
        if (!BOT_TOKEN) return json({ ok: false, error: "telegram_token_missing" }, 500);
        const body = await request.json().catch(()=>({}));
        const initData = body && body.initData;
        if (!initData) return json({ ok: false, error: "missing initData" }, 400);

        const valid = await verifyInitData(initData, BOT_TOKEN);
        return json({ ok: true, valid });
      }

      // NOT FOUND
      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      console.error("Unhandled error in worker:", err);
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};

// ----------------- UTIL -----------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  // For production, consider restricting origin instead of "*"
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-key",
  };
}

async function sendMessage(token, chat_id, text) {
  if (!token) throw new Error("missing telegram token");
  const api = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = { chat_id, text, parse_mode: "HTML" };

  const r = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => ({ ok: false, error: "invalid_json_response" }));
  if (!r.ok) {
    return { ok: false, status: r.status, body: j };
  }
  return j;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ----------------- TELEGRAM initData VERIFICATION (Web Crypto) -----------------
async function verifyInitData(initDataString, botToken) {
  try {
    const params = new URLSearchParams(initDataString);
    const providedHash = params.get('hash');
    if (!providedHash) return false;

    const entries = [];
    for (const [k,v] of params.entries()) {
      if (k === 'hash') continue;
      entries.push([k, v]);
    }
    entries.sort((a,b)=> a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0));
    const data_check_string = entries.map(e => `${e[0]}=${e[1]}`).join('\n');

    const enc = new TextEncoder();
    const botTokenBytes = enc.encode(botToken);
    const secretBuf = await crypto.subtle.digest('SHA-256', botTokenBytes);

    const key = await crypto.subtle.importKey('raw', secretBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

    const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data_check_string));
    const sigHex = bufferToHex(signature);

    return sigHex === providedHash.toLowerCase();
  } catch (err) {
    console.error('verifyInitData error', err);
    return false;
  }
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    s += (h.length === 1 ? '0' + h : h);
  }
  return s.toLowerCase();
}
