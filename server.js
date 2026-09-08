const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3700;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'hungbot_verify_2024';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.HmongxChatbot || 'hmong4s2024';
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';
const PAGE_ID = process.env.PAGE_ID || '';
const PAGE_TOKEN = process.env.PAGE_TOKEN || '';
const PAGE_NAME = process.env.PAGE_NAME || '';
const DATA_DIR = path.join(__dirname, 'data');
const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.ico':'image/x-icon' };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ======== AUTH: Session management ========
var sessions = {};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSessionToken(req) {
  var cookie = req.headers.cookie || '';
  var match = cookie.match(/hb_session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

function isAuthenticated(req) {
  var token = getSessionToken(req);
  return token && sessions[token] && sessions[token].expires > Date.now();
}

// ======== RATE LIMITING ========
var rateLimits = {};

function rateLimit(key, maxRequests, windowMs) {
  var now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = { count: 0, resetAt: now + windowMs };
  if (now > rateLimits[key].resetAt) {
    rateLimits[key] = { count: 0, resetAt: now + windowMs };
  }
  rateLimits[key].count++;
  return rateLimits[key].count <= maxRequests;
}

// Clean up expired rate limits every 5 minutes
setInterval(function() {
  var now = Date.now();
  for (var k in rateLimits) {
    if (rateLimits[k].resetAt < now) delete rateLimits[k];
  }
  for (var s in sessions) {
    if (sessions[s].expires < now) delete sessions[s];
  }
}, 5 * 60 * 1000);

// ======== SSE: Real-time events ========
var sseClients = [];

function broadcastSSE(event, data) {
  var msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  sseClients = sseClients.filter(function(client) {
    try { client.write(msg); return true; }
    catch { return false; }
  });
}

// ======== Follow-up state ========
var conversations = {};

var FOLLOWUP_MESSAGES = [
  "Koj nyob, koj puas tseem xav yuav MOB TXHA os? ❤️",
  "Koj puas xav xaj MOB TXHA hnub no kom kuv npaj rau koj? 😊 1 lub 350k free ship xwb!",
  "Koj tseem muaj yam twg tsis paub meej txog MOB TXHA lossis tseem txhawj xeeb txog? Nug kuv tau nhé, kuv mam li pab qhia ntxiv rau koj ❤️",
  "Koj xav yuav 1 lossis 2 lub MOB TXHA kom kuv sau npe xaj rau koj? 2 lub 600k free ship txuag tau 100k os!",
  "Kuv tos koj qhov kev lees paub kom kuv npaj xaj MOB TXHA rau koj nha 😍 Yog koj tseem xav yuav ces qhia kuv nhé! Hu tau: 0357.283.332"
];
var FOLLOWUP_DELAYS = [10*60*1000, 10*60*1000, 10*60*1000, 10*60*1000, 10*60*1000];

function scheduleFollowUp(senderId) {
  var conv = conversations[senderId];
  if (!conv || conv.humanTookOver) return;
  if (conv.followUpCount >= FOLLOWUP_DELAYS.length) return;

  var delay = FOLLOWUP_DELAYS[conv.followUpCount];
  conv.timer = setTimeout(async function() {
    var c = conversations[senderId];
    if (!c || c.humanTookOver) return;
    var msg = FOLLOWUP_MESSAGES[c.followUpCount] || FOLLOWUP_MESSAGES[FOLLOWUP_MESSAGES.length - 1];
    try {
      await fbSend(c.pageToken, senderId, msg);
      var logEntry = { dir: 'out', to: senderId, page: c.pageId, text: msg, src: 'followup:' + c.followUpCount, time: new Date().toISOString() };
      appendLog(logEntry);
      broadcastSSE('message', logEntry);
      console.log('[FOLLOWUP ' + c.followUpCount + '] -> ' + senderId);
    } catch (e) { console.error('[FOLLOWUP ERROR]', e.message); }
    c.followUpCount++;
    c.lastBotReply = Date.now();
    scheduleFollowUp(senderId);
  }, delay);
}

function cancelFollowUp(senderId) {
  var conv = conversations[senderId];
  if (conv && conv.timer) {
    clearTimeout(conv.timer);
    conv.timer = null;
  }
}

// ======== Data helpers ========

function loadJSON(name, fallback) {
  try { var data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { var data = fallback; }
  if (name === 'config.json' && PAGE_ID && PAGE_TOKEN) {
    if (!data.pageTokens) data.pageTokens = {};
    if (!data.pageNames) data.pageNames = {};
    data.pageTokens[PAGE_ID] = PAGE_TOKEN;
    if (PAGE_NAME) data.pageNames[PAGE_ID] = PAGE_NAME;
  }
  return data;
}
function saveJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}
function appendLog(entry) {
  fs.appendFileSync(path.join(DATA_DIR, 'messages.jsonl'), JSON.stringify(entry) + '\n');
}

// ======== Rule matching ========

function removeDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function matchRule(text, rules) {
  var msg = removeDiacritics(text.toLowerCase().trim());
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (!r.active) continue;
    var keywords = r.keywords || [];
    for (var k = 0; k < keywords.length; k++) {
      var kw = removeDiacritics(keywords[k].toLowerCase());
      if (r.match === 'exact' && msg === kw) return r;
      if (r.match === 'contains' && msg.indexOf(kw) !== -1) return r;
      if (r.match === 'startsWith' && msg.indexOf(kw) === 0) return r;
      if (r.match === 'regex') { try { if (new RegExp(keywords[k], 'i').test(text)) return r; } catch {} }
    }
  }
  return null;
}

// ======== AI fallback ========

async function callAI(message, config) {
  if (!config.aiApiKey) return null;
  var sys = config.aiSystemPrompt || 'Koj yog ib tug neeg pab muag khoom ntawm HMONG4S. TSEEM CEEB: Koj YUAV TSUM teb ua lus Hmoob Dawb XWB — txhob teb ua lus Nyab Laj lossis lus Askiv. Teb luv luv, sib raug zoo, txawj muag khoom. Yog tus neeg yuav khoom nug txog khoom, qhia tus nqi thiab txhib kom lawv xaj khoom. Yog lawv tsis teb, nug lawv ib lo lus txhib kom lawv xav yuav.';

  if (config.aiProvider === 'openai' || (!config.aiProvider && config.aiApiKey.startsWith('sk-'))) {
    var r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.aiApiKey },
      body: JSON.stringify({ model: config.aiModel || 'gpt-4o-mini', messages: [{ role: 'system', content: sys }, { role: 'user', content: message }], max_tokens: 500 })
    });
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content : null;
  }

  if (config.aiProvider === 'anthropic') {
    var r2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.aiApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.aiModel || 'claude-sonnet-4-20250514', max_tokens: 500, system: sys, messages: [{ role: 'user', content: message }] })
    });
    var d2 = await r2.json();
    return (d2.content && d2.content[0]) ? d2.content[0].text : null;
  }
  return null;
}

// ======== Facebook Graph API ========

async function fbSend(pageToken, recipientId, text) {
  var r = await fetch('https://graph.facebook.com/v21.0/me/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text }, access_token: pageToken })
  });
  return r.json();
}

// ======== Process incoming message ========

async function processMessage(senderId, pageId, text, pageToken) {
  var rules = loadJSON('rules.json', []);
  var config = loadJSON('config.json', {});

  var inLog = { dir: 'in', from: senderId, page: pageId, text: text, time: new Date().toISOString() };
  appendLog(inLog);
  broadcastSSE('message', inLog);

  cancelFollowUp(senderId);
  if (conversations[senderId] && conversations[senderId].humanTookOver) {
    console.log('[HUMAN HANDOFF ACTIVE] Skipping bot reply for ' + senderId);
    return;
  }

  var reply = null;
  var src = '';

  var rule = matchRule(text, rules);
  if (rule) {
    reply = rule.reply;
    if (rule.replies && rule.replies.length > 0) {
      reply = rule.replies[Math.floor(Math.random() * rule.replies.length)];
    }
    src = 'rule:' + rule.name;
  } else if (config.aiEnabled && config.aiApiKey) {
    try {
      reply = await callAI(text, config);
      src = 'ai';
    } catch (e) { console.error('[AI ERROR]', e.message); }
  }

  if (reply) {
    await fbSend(pageToken, senderId, reply);
    var outLog = { dir: 'out', to: senderId, page: pageId, text: reply, src: src, time: new Date().toISOString() };
    appendLog(outLog);
    broadcastSSE('message', outLog);
    console.log('[' + src.toUpperCase() + '] -> ' + senderId);

    conversations[senderId] = {
      pageId: pageId,
      pageToken: pageToken,
      lastBotReply: Date.now(),
      followUpCount: 0,
      humanTookOver: false,
      timer: null
    };
    scheduleFollowUp(senderId);
  } else {
    console.log('[NO REPLY] ' + senderId + ': ' + text);
  }
}

// ======== Echo detection (human employee reply) ========

function handleEcho(senderId, pageId) {
  if (conversations[senderId]) {
    cancelFollowUp(senderId);
    conversations[senderId].humanTookOver = true;
    console.log('[HUMAN TAKEOVER] Employee replied to ' + senderId + ' — bot paused');
  }
}

// ======== Webhook signature validation ========

function verifyWebhookSignature(req, rawBody) {
  if (!FB_APP_SECRET) return true;
  var sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  var expected = 'sha256=' + crypto.createHmac('sha256', FB_APP_SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ======== HTTP helpers ========

function parseBodyRaw(req) {
  return new Promise(function(resolve) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
  });
}

function parseBody(req) {
  return new Promise(function(resolve) {
    var body = '';
    req.on('data', function(c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', function() { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function json(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// ======== LOGIN PAGE HTML ========

var LOGIN_HTML = `<!DOCTYPE html>
<html lang="hmn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — HMONGX ChatBot</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #2D1B69, #1a1a2e); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.login-card { background: #fff; border-radius: 16px; padding: 40px; width: 380px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; }
.logo { font-size: 36px; margin-bottom: 8px; }
h1 { font-size: 22px; color: #2D1B69; margin-bottom: 4px; }
.subtitle { color: #888; font-size: 13px; margin-bottom: 28px; }
.form-group { margin-bottom: 16px; text-align: left; }
.form-group label { font-size: 13px; font-weight: 600; color: #555; display: block; margin-bottom: 6px; }
.form-group input { width: 100%; padding: 12px 14px; border: 2px solid #e0e0e0; border-radius: 10px; font-size: 15px; transition: border-color 0.2s; outline: none; }
.form-group input:focus { border-color: #6C5CE7; }
.btn-login { width: 100%; padding: 14px; background: linear-gradient(135deg, #6C5CE7, #a29bfe); color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
.btn-login:hover { opacity: 0.9; }
.error { color: #e74c3c; font-size: 13px; margin-top: 12px; display: none; }
</style>
</head>
<body>
<div class="login-card">
  <div class="logo">🤖</div>
  <h1>HMONGX ChatBot</h1>
  <p class="subtitle">AI Chatbot Kev Lag Luam</p>
  <form onsubmit="doLogin(event)">
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="pw" placeholder="Ntaus password..." autofocus>
    </div>
    <button type="submit" class="btn-login">Nkag mus</button>
    <div class="error" id="err">Password tsis yog. Thov rov sim dua.</div>
  </form>
</div>
<script>
async function doLogin(e) {
  e.preventDefault();
  var pw = document.getElementById('pw').value;
  var r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: pw}) });
  var d = await r.json();
  if (d.ok) { window.location.href = '/'; }
  else { document.getElementById('err').style.display = 'block'; document.getElementById('pw').value = ''; document.getElementById('pw').focus(); }
}
</script>
</body>
</html>`;

// ======== SERVER ========

http.createServer(async function(req, res) {
  var u = new URL(req.url, 'http://localhost');
  var p = u.pathname;
  var ip = getClientIP(req);

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CORS for API
  if (p.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ======== WEBHOOK (public, no auth) ========
  if (p === '/webhook' && req.method === 'GET') {
    if (u.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(u.searchParams.get('hub.challenge'));
    } else { res.writeHead(403); res.end('Bad token'); }
    return;
  }

  if (p === '/webhook' && req.method === 'POST') {
    if (!rateLimit('webhook:' + ip, 100, 60000)) {
      res.writeHead(429); res.end('Too many requests'); return;
    }
    var rawBody = await parseBodyRaw(req);
    if (!verifyWebhookSignature(req, rawBody)) {
      console.log('[WEBHOOK] Invalid signature from ' + ip);
      res.writeHead(403); res.end('Invalid signature'); return;
    }
    var body;
    try { body = JSON.parse(rawBody.toString()); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
    res.writeHead(200); res.end('EVENT_RECEIVED');
    if (body.object === 'page') {
      var config = loadJSON('config.json', {});
      (body.entry || []).forEach(function(entry) {
        var pageId = entry.id;
        var pageToken = (config.pageTokens || {})[pageId];
        (entry.messaging || []).forEach(function(evt) {
          if (!pageToken) return;
          if (evt.message && evt.message.is_echo) {
            var recipientId = evt.recipient && evt.recipient.id;
            if (recipientId && recipientId !== pageId) {
              handleEcho(recipientId, pageId);
            }
            return;
          }
          if (evt.message && evt.message.text) {
            processMessage(evt.sender.id, pageId, evt.message.text, pageToken);
          }
        });
      });
    }
    return;
  }

  // ======== LOGIN / LOGOUT (public) ========
  if (p === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LOGIN_HTML);
    return;
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (!rateLimit('login:' + ip, 5, 60000)) {
      return json(res, { error: 'Ntau dhau lawm. Tos 1 feeb.' }, 429);
    }
    var loginData = await parseBody(req);
    if (loginData.password === ADMIN_PASSWORD) {
      var token = generateToken();
      sessions[token] = { ip: ip, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'hb_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800'
      });
      res.end(JSON.stringify({ ok: true }));
      console.log('[LOGIN] Success from ' + ip);
    } else {
      console.log('[LOGIN] Failed from ' + ip);
      return json(res, { error: 'Wrong password' }, 401);
    }
    return;
  }

  if (p === '/api/logout' && req.method === 'POST') {
    var sToken = getSessionToken(req);
    if (sToken) delete sessions[sToken];
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'hb_session=; Path=/; HttpOnly; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ======== Privacy/Terms (public) ========
  if (p === '/privacy.html' || p === '/terms.html' || p === '/sw.js' || p === '/manifest.webmanifest' || p === '/favicon.ico') {
    var pubFile = path.join(__dirname, p);
    fs.readFile(pubFile, function(err, data) {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(pubFile)] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  // ======== AUTH CHECK — everything below requires login ========
  if (!isAuthenticated(req)) {
    if (p.startsWith('/api/')) {
      return json(res, { error: 'Unauthorized' }, 401);
    }
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  // Rate limit API calls per session
  if (p.startsWith('/api/') && !rateLimit('api:' + ip, 60, 60000)) {
    return json(res, { error: 'Rate limit exceeded' }, 429);
  }

  // ======== SSE: Real-time events ========
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    req.on('close', function() {
      sseClients = sseClients.filter(function(c) { return c !== res; });
    });
    // Keep alive every 30s
    var keepAlive = setInterval(function() {
      try { res.write(':keepalive\n\n'); } catch { clearInterval(keepAlive); }
    }, 30000);
    req.on('close', function() { clearInterval(keepAlive); });
    return;
  }

  // ======== API: Rules ========
  if (p === '/api/rules') {
    if (req.method === 'GET') return json(res, loadJSON('rules.json', []));
    if (req.method === 'POST') { saveJSON('rules.json', await parseBody(req)); return json(res, { ok: true }); }
  }

  // ======== API: Config ========
  if (p === '/api/config') {
    if (req.method === 'GET') {
      var cfg = loadJSON('config.json', {});
      var safe = Object.assign({}, cfg);
      if (safe.aiApiKey) safe.aiApiKey = safe.aiApiKey.substring(0, 10) + '***';
      delete safe.pageTokens;
      return json(res, safe);
    }
    if (req.method === 'POST') {
      var newCfg = await parseBody(req);
      var old = loadJSON('config.json', {});
      if (newCfg.aiApiKey && newCfg.aiApiKey.indexOf('***') !== -1) delete newCfg.aiApiKey;
      Object.assign(old, newCfg);
      saveJSON('config.json', old);
      return json(res, { ok: true });
    }
  }

  // ======== API: Save/disconnect page token ========
  if (p === '/api/page-token' && req.method === 'POST') {
    var pt = await parseBody(req);
    var c = loadJSON('config.json', {});
    if (!c.pageTokens) c.pageTokens = {};
    if (!c.pageNames) c.pageNames = {};
    if (pt.disconnect) {
      delete c.pageTokens[pt.pageId];
      delete c.pageNames[pt.pageId];
      console.log('[PAGE TOKEN] Disconnected page ' + pt.pageId);
    } else {
      c.pageTokens[pt.pageId] = pt.pageToken;
      c.pageNames[pt.pageId] = pt.pageName;
      console.log('[PAGE TOKEN] Saved for ' + pt.pageName);
    }
    saveJSON('config.json', c);
    return json(res, { ok: true });
  }

  // ======== API: Send message (manual = human employee) ========
  if (p === '/api/send' && req.method === 'POST') {
    var s = await parseBody(req);
    if (!s.recipientId || !s.pageId || !s.message) return json(res, { error: 'Missing fields' }, 400);
    var cfg2 = loadJSON('config.json', {});
    var tok = (cfg2.pageTokens || {})[s.pageId];
    if (!tok) return json(res, { error: 'No page token' }, 400);
    var result = await fbSend(tok, s.recipientId, s.message);
    var sendLog = { dir: 'out', to: s.recipientId, page: s.pageId, text: s.message, src: 'manual', time: new Date().toISOString() };
    appendLog(sendLog);
    broadcastSSE('message', sendLog);
    if (conversations[s.recipientId]) {
      cancelFollowUp(s.recipientId);
      conversations[s.recipientId].humanTookOver = true;
      console.log('[HUMAN TAKEOVER] Manual send to ' + s.recipientId + ' — bot paused');
    }
    return json(res, result);
  }

  // ======== API: Resume bot for a conversation ========
  if (p === '/api/resume-bot' && req.method === 'POST') {
    var rb = await parseBody(req);
    if (conversations[rb.senderId]) {
      conversations[rb.senderId].humanTookOver = false;
      conversations[rb.senderId].followUpCount = 0;
      console.log('[BOT RESUMED] for ' + rb.senderId);
    }
    return json(res, { ok: true });
  }

  // ======== API: Conversation states ========
  if (p === '/api/conversations' && req.method === 'GET') {
    var states = {};
    for (var sid in conversations) {
      states[sid] = {
        pageId: conversations[sid].pageId,
        humanTookOver: conversations[sid].humanTookOver,
        followUpCount: conversations[sid].followUpCount,
        lastBotReply: conversations[sid].lastBotReply
      };
    }
    return json(res, states);
  }

  // ======== API: Test AI / Rules ========
  if (p === '/api/test-ai' && req.method === 'POST') {
    var t = await parseBody(req);
    if (!t.message || typeof t.message !== 'string') return json(res, { error: 'Missing message' }, 400);
    var rules = loadJSON('rules.json', []);
    var rule = matchRule(t.message, rules);
    if (rule) {
      var rply = rule.reply;
      if (rule.replies && rule.replies.length > 0) rply = rule.replies[Math.floor(Math.random() * rule.replies.length)];
      return json(res, { source: 'rule', ruleName: rule.name, reply: rply });
    }
    var cfg3 = loadJSON('config.json', {});
    if (cfg3.aiEnabled && cfg3.aiApiKey) {
      try {
        var aiR = await callAI(t.message, cfg3);
        return json(res, { source: 'ai', reply: aiR || 'AI tsis teb tau.' });
      } catch (e) { return json(res, { source: 'error', reply: 'Yuam kev AI: ' + e.message }, 500); }
    }
    return json(res, { source: 'none', reply: 'Tsis muaj rule match. AI tsis tau teeb tsa.' });
  }

  // ======== API: Message log ========
  if (p === '/api/messages' && req.method === 'GET') {
    try {
      var lines = fs.readFileSync(path.join(DATA_DIR, 'messages.jsonl'), 'utf8').trim().split('\n');
      var msgs = lines.map(function(l) { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-500);
      return json(res, msgs);
    } catch { return json(res, []); }
  }

  // ======== API: Auth status ========
  if (p === '/api/auth-status' && req.method === 'GET') {
    return json(res, { authenticated: true });
  }

  // ======== STATIC FILES (authenticated) ========
  var file = p === '/' ? '/index.html' : p;
  var filePath = path.join(__dirname, file);
  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  var ext = path.extname(filePath);
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, function() { console.log('HMONGX ChatBot running at http://localhost:' + PORT); });
