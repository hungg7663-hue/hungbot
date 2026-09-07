const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3700;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'hungbot_verify_2024';
const DATA_DIR = path.join(__dirname, 'data');
const MIME = { '.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml' };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- "Ban duoi khach" (follow-up) state ----
// conversations[senderId] = { pageId, pageToken, lastBotReply, followUpCount, humanTookOver, timer }
var conversations = {};

var FOLLOWUP_MESSAGES = [
  "Koj nyob, koj puas tseem xav yuav yam khoom no? ❤️",
  "Koj puas xav xaj hnub no kom kuv npaj khoom rau koj? 😊",
  "Koj tseem muaj yam twg tsis paub meej lossis tseem txhawj xeeb txog? Nug kuv tau nhé, kuv mam li pab qhia ntxiv rau koj ❤️",
  "Koj xav yuav 1 lossis 2 yam khoom kom kuv sau npe xaj rau koj?",
  "Kuv tos koj qhov kev lees paub kom kuv npaj xaj khoom rau koj nha 😍 Yog koj tseem xav yuav ces qhia kuv nhé!"
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
      appendLog({ dir: 'out', to: senderId, page: c.pageId, text: msg, src: 'followup:' + c.followUpCount, time: new Date().toISOString() });
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

// ---- AI fallback ----

async function callAI(message, config) {
  if (!config.aiApiKey) return null;
  var sys = config.aiSystemPrompt || 'Koj yog ib tug neeg pab muag khoom ntawm HMONG4S. Teb ua lus Hmoob Dawb, luv luv, sib raug zoo, thiab txawj muag khoom. Yog tus neeg yuav khoom nug txog khoom, qhia tus nqi thiab txhib kom lawv xaj khoom. Yog lawv tsis teb, nug lawv ib lo lus txhib kom lawv xav yuav.';

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

  // Customer replied -> reset follow-up timer, clear humanTookOver if customer re-engages
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
    appendLog({ dir: 'out', to: senderId, page: pageId, text: reply, src: src, time: new Date().toISOString() });
    console.log('[' + src.toUpperCase() + '] -> ' + senderId);

    // Start follow-up tracking
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

// ---- Detect human employee reply (echo message from Page) ----

function handleEcho(senderId, pageId) {
  // When a human employee sends a message via Page, Facebook sends an echo event
  // with sender.id = pageId. We mark the conversation as human-handled.
  // senderId here is the RECIPIENT (customer), detected from the echo event.
  if (conversations[senderId]) {
    cancelFollowUp(senderId);
    conversations[senderId].humanTookOver = true;
    console.log('[HUMAN TAKEOVER] Employee replied to ' + senderId + ' — bot paused');
  }
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
          if (!pageToken) return;

          // Detect echo = human employee replied from Page
          if (evt.message && evt.message.is_echo) {
            var recipientId = evt.recipient && evt.recipient.id;
            if (recipientId && recipientId !== pageId) {
              handleEcho(recipientId, pageId);
            }
            return;
          }

          // Normal customer message
          if (evt.message && evt.message.text) {
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

  // ======== API: Send message (manual = human employee) ========
  if (p === '/api/send' && req.method === 'POST') {
    var s = await parseBody(req);
    var cfg2 = loadJSON('config.json', {});
    var tok = (cfg2.pageTokens || {})[s.pageId];
    if (!tok) return json(res, { error: 'No page token' }, 400);
    var result = await fbSend(tok, s.recipientId, s.message);
    appendLog({ dir: 'out', to: s.recipientId, page: s.pageId, text: s.message, src: 'manual', time: new Date().toISOString() });
    // Manual send = human employee took over
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
