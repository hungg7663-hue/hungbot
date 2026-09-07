const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3700;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'hungbot_verify_2024';
const DATA_DIR = path.join(__dirname, 'data');
const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml' };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Data helpers ----

function loadJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}
function saveJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}
function appendLog(entry) {
  fs.appendFileSync(path.join(DATA_DIR, 'messages.jsonl'), JSON.stringify(entry) + '\n');
}

// ---- Rule matching ----

function matchRule(text, rules) {
  var msg = text.toLowerCase().trim();
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (!r.active) continue;
    var keywords = r.keywords || [];
    for (var k = 0; k < keywords.length; k++) {
      var kw = keywords[k].toLowerCase();
      if (r.match === 'exact' && msg === kw) return r;
      if (r.match === 'contains' && msg.indexOf(kw) !== -1) return r;
      if (r.match === 'startsWith' && msg.indexOf(kw) === 0) return r;
      if (r.match === 'regex') { try { if (new RegExp(keywords[k], 'i').test(msg)) return r; } catch {} }
    }
  }
  return null;
}

// ---- AI fallback ----

async function callAI(message, config) {
  if (!config.aiApiKey) return null;
  var sys = config.aiSystemPrompt || 'Ban la tro ly ban hang. Tra loi ngan gon, than thien, chuyen nghiep.';

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

// ---- Facebook Graph API ----

async function fbSend(pageToken, recipientId, text) {
  var r = await fetch('https://graph.facebook.com/v21.0/me/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text }, access_token: pageToken })
  });
  return r.json();
}

// ---- Process incoming message ----

async function processMessage(senderId, pageId, text, pageToken) {
  var rules = loadJSON('rules.json', []);
  var config = loadJSON('config.json', {});

  appendLog({ dir: 'in', from: senderId, page: pageId, text: text, time: new Date().toISOString() });

  var rule = matchRule(text, rules);
  if (rule) {
    var reply = rule.reply;
    if (rule.replies && rule.replies.length > 0) {
      reply = rule.replies[Math.floor(Math.random() * rule.replies.length)];
    }
    await fbSend(pageToken, senderId, reply);
    appendLog({ dir: 'out', to: senderId, page: pageId, text: reply, src: 'rule:' + rule.name, time: new Date().toISOString() });
    console.log('[RULE] ' + rule.name + ' -> ' + senderId);
    return;
  }

  if (config.aiEnabled && config.aiApiKey) {
    try {
      var aiReply = await callAI(text, config);
      if (aiReply) {
        await fbSend(pageToken, senderId, aiReply);
        appendLog({ dir: 'out', to: senderId, page: pageId, text: aiReply, src: 'ai', time: new Date().toISOString() });
        console.log('[AI] -> ' + senderId);
        return;
      }
    } catch (e) { console.error('[AI ERROR]', e.message); }
  }

  console.log('[NO REPLY] ' + senderId + ': ' + text);
}

// ---- HTTP helpers ----

function parseBody(req) {
  return new Promise(function(resolve) {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function json(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---- SERVER ----

http.createServer(async function(req, res) {
  var u = new URL(req.url, 'http://localhost');
  var p = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ======== WEBHOOK ========
  if (p === '/webhook' && req.method === 'GET') {
    if (u.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(u.searchParams.get('hub.challenge'));
    } else { res.writeHead(403); res.end('Bad token'); }
    return;
  }

  if (p === '/webhook' && req.method === 'POST') {
    var body = await parseBody(req);
    res.writeHead(200); res.end('EVENT_RECEIVED');
    if (body.object === 'page') {
      var config = loadJSON('config.json', {});
      (body.entry || []).forEach(function(entry) {
        var pageId = entry.id;
        var pageToken = (config.pageTokens || {})[pageId];
        (entry.messaging || []).forEach(function(evt) {
          if (evt.message && evt.message.text && pageToken) {
            processMessage(evt.sender.id, pageId, evt.message.text, pageToken);
          }
        });
      });
    }
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

  // ======== API: Save page token ========
  if (p === '/api/page-token' && req.method === 'POST') {
    var pt = await parseBody(req);
    var c = loadJSON('config.json', {});
    if (!c.pageTokens) c.pageTokens = {};
    c.pageTokens[pt.pageId] = pt.pageToken;
    if (!c.pageNames) c.pageNames = {};
    c.pageNames[pt.pageId] = pt.pageName;
    saveJSON('config.json', c);
    console.log('[PAGE TOKEN] Saved for ' + pt.pageName);
    return json(res, { ok: true });
  }

  // ======== API: Send message ========
  if (p === '/api/send' && req.method === 'POST') {
    var s = await parseBody(req);
    var cfg2 = loadJSON('config.json', {});
    var tok = (cfg2.pageTokens || {})[s.pageId];
    if (!tok) return json(res, { error: 'No page token' }, 400);
    var result = await fbSend(tok, s.recipientId, s.message);
    appendLog({ dir: 'out', to: s.recipientId, page: s.pageId, text: s.message, src: 'manual', time: new Date().toISOString() });
    return json(res, result);
  }

  // ======== API: Test AI / Rules ========
  if (p === '/api/test-ai' && req.method === 'POST') {
    var t = await parseBody(req);
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
        return json(res, { source: 'ai', reply: aiR || 'AI khong tra loi duoc.' });
      } catch (e) { return json(res, { source: 'error', reply: 'Loi AI: ' + e.message }, 500); }
    }
    return json(res, { source: 'none', reply: 'Khong co rule match. AI chua cau hinh.' });
  }

  // ======== API: Message log ========
  if (p === '/api/messages' && req.method === 'GET') {
    try {
      var lines = fs.readFileSync(path.join(DATA_DIR, 'messages.jsonl'), 'utf8').trim().split('\n');
      var msgs = lines.map(function(l) { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-200);
      return json(res, msgs);
    } catch { return json(res, []); }
  }

  // ======== STATIC FILES ========
  var file = p === '/' ? '/index.html' : p;
  var filePath = path.join(__dirname, file);
  var ext = path.extname(filePath);
  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, function() { console.log('HungBot running at http://localhost:' + PORT); });
