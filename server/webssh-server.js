const https = require('https');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const crypto = require('crypto');

const app = express();
const PORT = 4000;
const CHAT_DATA_DIR = path.join(__dirname, 'data');
const CHAT_DATA_FILE = path.join(CHAT_DATA_DIR, 'chats.json');
const CHAT_MODELS = new Set(['sonnet', 'opus', 'haiku']);
const CHAT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const PROJECTS = {
  epikur: {
    id: 'epikur',
    label: 'Epikur',
    repo: '/home/ole/epikur-preview',
    service: 'epikur-preview.service',
    previewUrl: 'https://dashboard.praxis-sorgenfrey.de:8443',
  },
  'epikur-patient': {
    id: 'epikur-patient',
    label: 'Epikur Patient',
    repo: '/home/ole/epikur-patient-preview',
    service: 'epikur-patient-preview.service',
    previewUrl: 'https://dashboard.praxis-sorgenfrey.de:8444',
  },
};

function getProject(id) {
  return PROJECTS[id] || PROJECTS.epikur;
}

function getUsageSummary(result) {
  const modelUsage = Object.values(result.modelUsage || {});
  const contextWindow = Math.max(0, ...modelUsage.map((entry) => entry.contextWindow || 0));
  const inputTokens = modelUsage.reduce(
    (sum, entry) => sum + (entry.inputTokens || 0) + (entry.cacheReadInputTokens || 0) + (entry.cacheCreationInputTokens || 0),
    0
  );
  return {
    inputTokens,
    outputTokens: modelUsage.reduce((sum, entry) => sum + (entry.outputTokens || 0), 0),
    contextWindow,
    contextPercent: contextWindow ? Math.min(100, Math.round((inputTokens / contextWindow) * 100)) : null,
    costUsd: Number(result.total_cost_usd || 0),
    autoCompact: true,
  };
}

function readChats() {
  try {
    return JSON.parse(fs.readFileSync(CHAT_DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeChats(chats) {
  fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });
  const temporaryFile = `${CHAT_DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(chats, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, CHAT_DATA_FILE);
}

function findChat(chats, id) {
  return chats.find((chat) => chat.id === id);
}

const PASSWORD_HASH = bcrypt.hashSync(process.env.WEBSSH_PASSWORD || 'ChangeMe123!', 10);

const SSL_OPTIONS = {
  key: fs.readFileSync(path.join(__dirname, 'ssl/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl/cert.pem')),
};

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(helmet({ contentSecurityPolicy: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Versuche. Bitte 15 Minuten warten.' },
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/terminal-login');
}

function requireApiAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'WebSSH-Sitzung abgelaufen.' });
}

app.get('/', (req, res) => {
  if (req.query.reauth === '1' && req.session) {
    return req.session.destroy(() => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(__dirname, 'public/login.html'));
    });
  }
  if (req.session && req.session.authenticated) return res.redirect('/terminal');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && bcrypt.compareSync(password, PASSWORD_HASH)) {
    req.session.authenticated = true;
    req.session.loginTime = Date.now();
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Falsches Passwort' });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/terminal', requireAuth, (req, res) => {
  res.redirect('/chat');
});

app.get('/claude-login', (req, res) => res.sendFile(path.join(__dirname, 'public/claude-login.html')));

app.get('/chat', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public/chat.html'));
});

app.get('/api/claude/status', requireApiAuth, (req, res) => {
  execFile(
    '/usr/bin/claude',
    ['auth', 'status'],
    { cwd: PROJECTS.epikur.repo, env: { ...process.env, HOME: '/home/ole' }, timeout: 20_000 },
    (error, stdout) => {
      if (error) return res.status(503).json({ loggedIn: false, error: 'Claude-Status nicht verfügbar' });
      try {
        res.json(JSON.parse(stdout));
      } catch {
        res.status(503).json({ loggedIn: false, error: 'Ungültige Claude-Antwort' });
      }
    }
  );
});

app.get('/api/claude/projects', requireApiAuth, (req, res) => {
  res.json(Object.values(PROJECTS).map(({ id, label, previewUrl }) => ({ id, label, previewUrl })));
});

app.post('/api/claude/projects/:id/activate', requireApiAuth, (req, res) => {
  const project = PROJECTS[req.params.id];
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  const services = Object.values(PROJECTS).map((entry) => entry.service);
  const command = [
    ...services.filter((service) => service !== project.service).map((service) => `sudo systemctl stop ${service} || true`),
    `sudo systemctl start ${project.service}`,
  ].join(' && ');
  exec(command, { timeout: 90_000, shell: '/bin/bash' }, (error) => {
    if (error) return res.status(500).json({ error: 'Preview konnte nicht gestartet werden.' });
    res.json({ ok: true, project: { id: project.id, label: project.label, previewUrl: project.previewUrl } });
  });
});

app.get('/api/claude/git-status', requireApiAuth, (req, res) => {
  const project = getProject(req.query.project);
  execFile(
    '/usr/bin/git',
    ['status', '--short'],
    { cwd: project.repo, env: { ...process.env, HOME: '/home/ole' }, timeout: 20_000 },
    (error, stdout) => {
      if (error) return res.status(500).json({ error: 'Git-Status konnte nicht geladen werden.' });
      const files = stdout.trim() ? stdout.trim().split('\n') : [];
      res.json({ dirty: files.length > 0, files });
    }
  );
});

app.post('/api/claude/push-main', requireApiAuth, (req, res) => {
  const project = getProject(req.body.project);
  const requestedMessage = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const commitMessage = (requestedMessage || 'feat: update from dashboard preview')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 120);
  const command = [
    'set -e',
    'git add -A',
    'if git diff --cached --quiet; then echo "__NO_CHANGES__"; exit 0; fi',
    `git commit -m ${JSON.stringify(commitMessage)}`,
    'git fetch origin main',
    'git rebase origin/main',
    'git push origin HEAD:main',
  ].join(' && ');

  exec(
    command,
    {
      cwd: project.repo,
      env: { ...process.env, HOME: '/home/ole' },
      timeout: 5 * 60 * 1000,
      maxBuffer: 5 * 1024 * 1024,
      shell: '/bin/bash',
    },
    (error, stdout, stderr) => {
      if (error) {
        exec('git rebase --abort >/dev/null 2>&1 || true', { cwd: project.repo });
        console.error('Push to main failed:', stderr || error.message);
        return res.status(500).json({ error: 'Push nach main fehlgeschlagen. Details stehen im Server-Log.' });
      }
      if (stdout.includes('__NO_CHANGES__')) return res.json({ ok: true, noChanges: true });
      const match = stdout.match(/\[[^\]]+ ([0-9a-f]+)\]/);
      res.json({ ok: true, commit: match?.[1] || null });
    }
  );
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Zu viele Nachrichten. Bitte kurz warten.' },
});

app.get('/api/claude/chats', requireApiAuth, (req, res) => {
  const chats = readChats()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(({ id, title, model, effort, project, createdAt, updatedAt, messages, usage }) => ({
      id,
      title,
      model,
      effort: effort || 'medium',
      project: project || 'epikur',
      createdAt,
      updatedAt,
      messageCount: messages.length,
      usage: usage || null,
    }));
  res.json(chats);
});

app.post('/api/claude/chats', requireApiAuth, (req, res) => {
  const now = new Date().toISOString();
  const model = CHAT_MODELS.has(req.body.model) ? req.body.model : 'sonnet';
  const effort = CHAT_EFFORTS.has(req.body.effort) ? req.body.effort : 'medium';
  const project = PROJECTS[req.body.project] ? req.body.project : 'epikur';
  const chat = {
    id: crypto.randomUUID(),
    title: 'Neuer Chat',
    model,
    effort,
    project,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const chats = readChats();
  chats.push(chat);
  writeChats(chats);
  res.status(201).json(chat);
});

app.get('/api/claude/chats/:id', requireApiAuth, (req, res) => {
  const chat = findChat(readChats(), req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  res.json(chat);
});

app.delete('/api/claude/chats/:id', requireApiAuth, (req, res) => {
  const chats = readChats();
  const remaining = chats.filter((chat) => chat.id !== req.params.id);
  if (remaining.length === chats.length) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  writeChats(remaining);
  res.json({ ok: true });
});

app.post('/api/claude/chat', requireApiAuth, chatLimiter, (req, res) => {
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : '';
  const model = CHAT_MODELS.has(req.body.model) ? req.body.model : 'sonnet';
  const effort = CHAT_EFFORTS.has(req.body.effort) ? req.body.effort : 'medium';

  if (!message || message.length > 20_000) {
    return res.status(400).json({ error: 'Nachricht fehlt oder ist zu lang.' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    return res.status(400).json({ error: 'Ungültige Chat-ID.' });
  }

  const chats = readChats();
  const chat = findChat(chats, conversationId);
  if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  const project = getProject(chat.project);

  const resume = chat.messages.some((entry) => entry.role === 'assistant');
  const now = new Date().toISOString();
  chat.model = model;
  chat.effort = effort;
  chat.project = project.id;
  chat.updatedAt = now;
  chat.messages.push({ role: 'user', content: message, createdAt: now });
  if (chat.title === 'Neuer Chat') {
    chat.title = message.replace(/\s+/g, ' ').slice(0, 52);
  }
  writeChats(chats);

  const args = [
    '-p',
    message,
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--model',
    model,
    '--effort',
    effort,
  ];
  if (resume) args.push('--resume', conversationId);
  else args.push('--session-id', conversationId);

  execFile(
    '/usr/bin/claude',
    args,
    {
      cwd: project.repo,
      env: { ...process.env, HOME: '/home/ole' },
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (error) {
        console.error('Claude chat failed:', stderr || error.message);
        return res.status(500).json({ error: 'Claude konnte die Anfrage nicht ausführen.' });
      }
      try {
        const result = JSON.parse(stdout);
        const responseText = result.result || 'Keine Antwort erhalten.';
        const currentChats = readChats();
        const currentChat = findChat(currentChats, conversationId);
        if (currentChat) {
          currentChat.updatedAt = new Date().toISOString();
          currentChat.model = model;
          currentChat.effort = effort;
          currentChat.project = project.id;
          currentChat.usage = getUsageSummary(result);
          currentChat.messages.push({
            role: 'assistant',
            content: responseText,
            createdAt: currentChat.updatedAt,
          });
          writeChats(currentChats);
        }
        res.json({
          response: responseText,
          sessionId: result.session_id || conversationId,
          chat: currentChat,
          usage: currentChat?.usage || null,
        });
      } catch {
        res.status(500).json({ error: 'Claude hat eine ungültige Antwort geliefert.' });
      }
    }
  );
});



// ─── Claude Auth (stabil, kein Neustart beim Reload) ─────────────────────────
let _claudeAuthUrl = null;

function startClaudeAuth(cb) {
  const { exec } = require('child_process');
  exec('tmux kill-session -t cauth 2>/dev/null; true', () => {
    exec('rm -f /tmp/cauth.log && tmux new-session -d -s cauth "BROWSER=echo claude auth login 2>&1 | tee /tmp/cauth.log; bash"', () => {
      const wait = (n) => {
        setTimeout(() => {
          exec("grep -o 'https://[^[:space:]]*' /tmp/cauth.log", (e, out) => {
            const url = (out || '').trim();
            if (url) { _claudeAuthUrl = url; cb(null, url); }
            else if (n < 15) { wait(n + 1); }
            else { cb(new Error('URL nicht gefunden')); }
          });
        }, 1000);
      };
      wait(0);
    });
  });
}

app.get('/claude-auth', requireAuth, (req, res) => {
  const send = (url) => {
    const page = "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1\">\n<title>Claude Login</title>\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{background:#0d1117;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif}\n.box{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:32px;width:100%;max-width:420px}\nh2{color:#e6edf3;font-size:20px;margin-bottom:8px;text-align:center}\n.sub{color:#7d8590;font-size:13px;text-align:center;margin-bottom:24px}\n.step{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}\n.num{background:#21262d;color:#58a6ff;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;margin-top:2px}\n.step p{color:#e6edf3;font-size:14px;line-height:1.5}\n.btn{display:block;width:100%;padding:14px;background:#238636;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;margin-top:8px;-webkit-appearance:none}\n.btn-reset{width:100%;padding:10px;background:transparent;border:1px solid #30363d;color:#7d8590;border-radius:8px;font-size:13px;cursor:pointer;margin-top:12px;-webkit-appearance:none}\ninput{width:100%;padding:14px;background:#0d1117;border:1px solid #30363d;border-radius:10px;color:#e6edf3;font-size:16px;outline:none;margin-top:12px;-webkit-appearance:none}\ninput:focus{border-color:#388bfd}\n.msg{display:none;margin-top:12px;padding:12px;border-radius:8px;font-size:14px;text-align:center}\n.ok{background:rgba(63,185,80,.15);border:1px solid rgba(63,185,80,.4);color:#3fb950}\n.err{background:rgba(248,81,73,.15);border:1px solid rgba(248,81,73,.4);color:#f85149}\n</style>\n</head>\n<body>\n<div class=\"box\">\n  <h2>Claude Login</h2>\n  <p class=\"sub\">URL bleibt gültig — kein Zeitdruck beim Code-Eingeben</p>\n  <div class=\"step\"><div class=\"num\">1</div><p>Tippe auf den Button und logge dich bei Claude an</p></div>\n  <a class=\"btn\" href=\"OAUTH_URL\" target=\"_blank\">Bei Claude anmelden &rarr;</a>\n  <div class=\"step\" style=\"margin-top:18px\"><div class=\"num\">2</div><p>Den Code von der Claude-Seite hier einfügen</p></div>\n  <input type=\"text\" id=\"code\" placeholder=\"Code einfügen...\" autocomplete=\"off\" autocorrect=\"off\" autocapitalize=\"none\" spellcheck=\"false\">\n  <button class=\"btn\" onclick=\"submitCode()\" id=\"sb\" style=\"margin-top:12px\">Code bestätigen</button>\n  <button class=\"btn-reset\" onclick=\"location.href='/claude-auth/reset'\">Neuen Link generieren</button>\n  <div class=\"msg\" id=\"msg\"></div>\n</div>\n<script>\nasync function submitCode() {\n  const code = document.getElementById('code').value.trim();\n  if (!code) return;\n  const btn = document.getElementById('sb'), msg = document.getElementById('msg');\n  btn.textContent = '...'; btn.disabled = true; msg.style.display = 'none';\n  try {\n    const r = await fetch('/claude-auth/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code})});\n    const d = await r.json();\n    msg.style.display = 'block';\n    if (d.success) { msg.className='msg ok'; msg.textContent='Erfolgreich! Du kannst claude jetzt in Terminus nutzen.'; }\n    else { msg.className='msg err'; msg.textContent=(d.error||'Fehler'); btn.textContent='Code bestätigen'; btn.disabled=false; }\n  } catch(e) { msg.style.display='block'; msg.className='msg err'; msg.textContent='Verbindungsfehler'; btn.textContent='Code bestätigen'; btn.disabled=false; }\n}\n</script>\n</body></html>".replace('OAUTH_URL', url.replace(/&/g, '&amp;'));
    res.send(page);
  };
  if (_claudeAuthUrl) { send(_claudeAuthUrl); return; }
  startClaudeAuth((err, url) => {
    if (err) { res.send('<p style="color:white;padding:20px">Fehler beim Starten. <a href="/claude-auth/reset" style="color:#58a6ff">Neu versuchen</a></p>'); return; }
    send(url);
  });
});

app.get('/claude-auth/reset', requireAuth, (req, res) => {
  _claudeAuthUrl = null;
  res.redirect('/claude-auth');
});

app.post('/claude-auth/submit', requireAuth, (req, res) => {
  const { exec } = require('child_process');
  const { code } = req.body;
  if (!code) return res.json({ success: false, error: 'Kein Code' });
  const safe = code.replace(/['"\\]/g, '').trim();
  exec('tmux send-keys -t cauth "' + safe + '" Enter', () => {
    setTimeout(() => {
      exec('tmux capture-pane -t cauth -p 2>/dev/null', (e, out) => {
        const o = (out || '').toLowerCase();
        if (o.includes('400') || o.includes('oauth error') || o.includes('request failed')) {
          _claudeAuthUrl = null;
          res.json({ success: false, error: 'Code abgelaufen — tippe auf "Neuen Link generieren"' });
        } else {
          _claudeAuthUrl = null;
          res.json({ success: true });
        }
      });
    }, 5000);
  });
});


// ─── MCP Info ─────────────────────────────────────────────────────────────────
app.get('/mcp-info', requireAuth, (req, res) => {
  let url = '';
  try { url = require('fs').readFileSync('/home/ole/mcp-server/tunnel-url.txt', 'utf8').trim(); } catch(e) {}
  const sseUrl = url ? url + '/sse' : '';
  const tok = process.env.MCP_TOKEN || '';
  const fields = url
    ? `<div class="field"><div class="label">SSE-URL &mdash; tippe zum Kopieren</div><div class="val" onclick="copy('${sseUrl}')">${sseUrl}</div></div><div class="field"><div class="label">Token &mdash; tippe zum Kopieren</div><div class="val" onclick="copy('${tok}')">${tok}</div></div><p class="ok" id="ok">Kopiert!</p>`
    : '<p style="color:#f85149;text-align:center">Tunnel nicht aktiv &mdash; warte kurz oder starte mcp-tunnel neu</p>';
  res.send(`<!DOCTYPE html><html><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>MCP</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1117;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.box{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:32px;width:100%;max-width:500px}h2{color:#e6edf3;font-size:18px;margin-bottom:20px;text-align:center}.field{margin-bottom:16px}.label{color:#7d8590;font-size:12px;margin-bottom:6px}.val{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:12px;color:#58a6ff;font-family:monospace;font-size:14px;word-break:break-all;cursor:pointer;-webkit-user-select:all}.val:active{background:#21262d}.ok{color:#3fb950;font-size:13px;text-align:center;margin-top:12px;display:none}a.back{display:block;margin-top:24px;color:#7d8590;text-align:center;font-size:13px}</style></head><body><div class="box"><h2>MCP Server</h2>${fields}<a class="back" href="/terminal">&larr; Zum Terminal</a></div><script>function copy(t){navigator.clipboard.writeText(t).then(()=>{var e=document.getElementById('ok');if(e){e.style.display='block';setTimeout(()=>e.style.display='none',2000)}}).catch(()=>{})}</script></body></html>`);
});

const server = https.createServer(SSL_OPTIONS, app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const ssh = new Client();
  let stream = null;
  let authenticated = false;
  let termRows = 24;
  let termCols = 80;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'auth') {
        if (!bcrypt.compareSync(msg.token || '', PASSWORD_HASH)) {
          ws.send(JSON.stringify({ type: 'error', data: 'Nicht autorisiert' }));
          ws.close();
          return;
        }
        authenticated = true;
        // Echte Terminalgroesse vom Client uebernehmen
        termRows = msg.rows || 24;
        termCols = msg.cols || 80;

        ssh.connect({
          host: '127.0.0.1',
          port: 22,
          username: 'ole',
          privateKey: fs.readFileSync('/home/ole/.ssh/webssh_key'),
          readyTimeout: 10000,
        });
        return;
      }

      if (!authenticated) return;

      if (msg.type === 'data' && stream) {
        stream.write(msg.data);
      }

      if (msg.type === 'resize' && stream) {
        termRows = msg.rows;
        termCols = msg.cols;
        stream.setWindow(msg.rows, msg.cols, 0, 0);
      }
    } catch (e) { /* ignore */ }
  });

  ssh.on('ready', () => {
    ws.send(JSON.stringify({ type: 'status', data: 'connected' }));
    // Korrekte Groesse + Umgebungsvariablen setzen
    ssh.shell(
      { term: 'xterm-256color', rows: termRows, cols: termCols },
      { env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } },
      (err, s) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', data: err.message }));
          return;
        }
        stream = s;
        stream.on('data', (data) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }));
          }
        });
        stream.on('close', () => {
          ws.send(JSON.stringify({ type: 'status', data: 'disconnected' }));
          ws.close();
          ssh.end();
        });
        stream.write(
          "export HOME=/home/ole; cd /home/ole/epikur && " +
          "tmux new-session -A -s epikur-claude -c /home/ole/epikur claude\r"
        );
      }
    );
  });

  ssh.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'error', data: 'SSH Fehler: ' + err.message }));
    ws.close();
  });

  ws.on('close', () => {
    if (stream) stream.close();
    ssh.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('WebSSH laeuft auf https://217.160.212.154:' + PORT);
});
