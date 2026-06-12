const https = require('https');
const http = require('http');
const { exec, execFile, spawn } = require('child_process');
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
const { createProjectControlService } = require('./project-control-service');

const app = express();
const PORT = 4000;
const SERVER_STARTED_AT = new Date().toISOString();
const CHAT_DATA_DIR = path.join(__dirname, 'data');
const CHAT_DATA_FILE = path.join(CHAT_DATA_DIR, 'chats.json');
const USERS_FILE = path.join(CHAT_DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(CHAT_DATA_DIR, 'sessions.json');
const GBRAIN_BIN = '/root/.bun/bin/gbrain';
const GBRAIN_ENV = { ...process.env, HOME: '/root', PATH: '/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
const CODEX_BIN = '/usr/bin/codex';
const CODEX_HOME_ROOT = path.join(CHAT_DATA_DIR, 'codex-users');
const CODEX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const projectControl = createProjectControlService({ dataDir: CHAT_DATA_DIR });
const CHAT_MODELS = new Set(['sonnet', 'opus', 'haiku']);
const CHAT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const SERVER_SYSTEM_PROMPT = [
  'Du arbeitest direkt auf dem Ubuntu-Server des Benutzers.',
  'Dein Prozess läuft als Benutzer ole. Für notwendige administrative Aufgaben darfst du sudo -n verwenden;',
  'ole besitzt dafür passwortlose Root-Rechte. Du darfst den gesamten Server verwalten, einschließlich',
  '/home, /etc, /var/www, systemd, nginx, Docker, Datenbanken, Paketen und Firewall.',
  'Behandle Produktionsdaten vorsichtig, prüfe vor Änderungen den Ist-Zustand und führe keine destruktiven',
  'Aktionen ohne eindeutigen Auftrag aus. Gib niemals Passwörter, Tokens, private Schlüssel oder .env-Inhalte aus.',
  'Das ausgewählte Repository ist dein Arbeitsverzeichnis. Vor Git-Änderungen prüfst du git status und',
  'überschreibst keine fremden uncommittierten Änderungen.',
  'Du hast Zugriff auf gbrain (Langzeit-Gedächtnis). Nutze das gbrain MCP-Tool um vergangene Gespräche,',
  'Entscheidungen und Kontext zu durchsuchen wenn relevant.',
  'Du hast Zugriff auf GitHub via MCP (github-Tool). GitHub-Username: olesorgenfrey.',
  'Repos: Epikur-dashboard, epikur-produkt, epikur-werbung, epikur, epikur-patient.',
  'Nutze das github-MCP-Tool um Issues, PRs, Commits, Branches und Dateiinhalte direkt von GitHub abzurufen.',
  'Du darfst niemals automatisch nach main mergen oder direkt nach main pushen. Arbeite immer auf einem Feature-Branch,',
  'erstelle einen Pull Request und warte auf Checks sowie eine ausdrückliche manuelle Freigabe.',
  'Du kannst Tasks im Practio-Dashboard verwalten. Wenn du einen Task erstellen oder ändern möchtest,',
  'füge am Ende deiner Antwort <practio_action>-Blöcke im JSON-Format ein:',
  'Neuen Task erstellen: <practio_action>{"action":"create_task","text":"Task-Text","assignee_id":"PERSON_ID"}</practio_action>',
  'Task als erledigt markieren: <practio_action>{"action":"toggle_task","id":"TASK_ID","done":true}</practio_action>',
  'Task wieder öffnen: <practio_action>{"action":"toggle_task","id":"TASK_ID","done":false}</practio_action>',
  'Task löschen: <practio_action>{"action":"delete_task","id":"TASK_ID"}</practio_action>',
  'Die aktuellen Personen-IDs und Task-IDs werden dir vom Nutzer im Kontext mitgeteilt.',
  'Füge die <practio_action>-Blöcke nur ein wenn du aktiv Tasks verwalten sollst – nicht bei normalen Antworten.',
].join(' ');
const PROJECTS = {
  epikur: {
    id: 'epikur',
    label: 'Epikur',
    repo: '/home/ole/epikur-preview',
    service: 'epikur-preview.service',
    previewUrl: 'https://dashboard.praxis-sorgenfrey.de:8443',
    healthUrl: 'http://127.0.0.1:3010/',
    liveUrl: 'https://epikur.praxis-sorgenfrey.de',
    liveHealthUrl: 'http://127.0.0.1:3000/',
    deployCommand: '/home/ole/bin/epikur-auto-deploy',
  },
  'epikur-patient': {
    id: 'epikur-patient',
    label: 'Epikur Patient',
    repo: '/home/ole/epikur-patient-preview',
    service: 'epikur-patient-preview.service',
    previewUrl: 'https://dashboard.praxis-sorgenfrey.de:8444',
    healthUrl: 'http://127.0.0.1:3011/',
    liveUrl: 'https://patienten.praxis-sorgenfrey.de',
    liveHealthUrl: 'http://127.0.0.1:3001/',
    deployCommand: '/home/ole/bin/epikur-patient-auto-deploy',
  },
  'epikur-dashboard': {
    id: 'epikur-dashboard',
    label: 'Epikur Dashboard',
    repo: '/home/ole/epikur-workspaces/epikur-dashboard',
    previewUrl: 'https://dashboard.praxis-sorgenfrey.de',
    liveUrl: 'https://dashboard.praxis-sorgenfrey.de',
    liveHealthUrl: 'https://dashboard.praxis-sorgenfrey.de/',
    deployType: 'dashboard',
  },
  'epikur-produkt': {
    id: 'epikur-produkt',
    label: 'Epikur Produkt',
    repo: '/home/ole/epikur-workspaces/epikur-produkt',
  },
  'epikur-werbung': {
    id: 'epikur-werbung',
    label: 'Epikur Werbung',
    repo: '/home/ole/epikur-workspaces/epikur-werbung',
  },
};

function getProject(id) {
  return PROJECTS[id] || PROJECTS.epikur;
}

function runShell(command, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout, shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function checkHttp(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const options = url.startsWith('https:') ? { timeout: 5_000, rejectUnauthorized: false } : { timeout: 5_000 };
    const request = client.get(url, options, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function runGit(repo, args, timeout = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/git',
      args,
      {
        cwd: repo,
        env: { ...process.env, HOME: '/home/ole' },
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function hasStagedChanges(repo) {
  try {
    await runGit(repo, ['diff', '--cached', '--quiet'], 20_000);
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

async function publishReviewBranch(project, commitMessage) {
  const branch = await runGit(project.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'main' || branch === 'master') {
    const error = new Error('Direkte Updates des Hauptbranches sind deaktiviert. Bitte zuerst einen Feature-Branch aktivieren.');
    error.code = 'MAIN_PUSH_BLOCKED';
    throw error;
  }
  await runGit(project.repo, ['add', '-A']);
  const committed = await hasStagedChanges(project.repo);
  if (committed) await runGit(project.repo, ['commit', '-m', commitMessage]);

  await runGit(project.repo, ['fetch', 'origin', 'main']);
  try {
    await runGit(project.repo, ['rebase', 'origin/main']);
  } catch (error) {
    try { await runGit(project.repo, ['rebase', '--abort'], 20_000); } catch {}
    throw error;
  }

  const filesOutput = await runGit(project.repo, ['diff', '--name-only', 'origin/main...HEAD']);
  const ahead = Number(await runGit(project.repo, ['rev-list', '--count', 'origin/main..HEAD'])) || 0;
  if (ahead > 0) await runGit(project.repo, ['push', '--set-upstream', 'origin', `HEAD:${branch}`]);

  return {
    branch,
    commit: await runGit(project.repo, ['rev-parse', '--short', 'HEAD']),
    fullCommit: await runGit(project.repo, ['rev-parse', 'HEAD']),
    committed,
    pushedCommits: ahead,
    files: filesOutput ? filesOutput.split('\n').filter(Boolean) : [],
    noChanges: !committed && ahead === 0,
  };
}

function filesDiffer(first, second) {
  try {
    return !fs.existsSync(second) || !fs.readFileSync(first).equals(fs.readFileSync(second));
  } catch {
    return true;
  }
}

async function deployProject(project) {
  if (!project.liveUrl) return { deployed: false, live: false };

  let restartRequired = false;
  if (project.deployCommand) {
    await runShell(project.deployCommand, 15 * 60 * 1000);
  } else if (project.deployType === 'dashboard') {
    const sourceServer = path.join(project.repo, 'server/webssh-server.js');
    const sourceProjectControl = path.join(project.repo, 'server/project-control-service.js');
    const activeServer = '/home/ole/webssh/server.js';
    const activeProjectControl = '/home/ole/webssh/project-control-service.js';
    restartRequired = filesDiffer(sourceServer, activeServer) || filesDiffer(sourceProjectControl, activeProjectControl);
    const command = [
      'set -e',
      `sudo /usr/bin/install -o www-data -g www-data -m 644 ${JSON.stringify(path.join(project.repo, 'index.html'))} /var/www/epikur-dashboard/index.html`,
      `sudo /usr/bin/install -o www-data -g www-data -m 644 ${JSON.stringify(path.join(project.repo, 'landing.html'))} /var/www/epikur-dashboard/landing.html`,
      `sudo /usr/bin/rsync -a --delete ${JSON.stringify(path.join(project.repo, 'assets/'))} /var/www/epikur-dashboard/assets/`,
      `sudo /usr/bin/rsync -a --delete ${JSON.stringify(path.join(project.repo, 'images/'))} /var/www/epikur-dashboard/images/`,
      `/usr/bin/install -o ole -g ole -m 644 ${JSON.stringify(path.join(project.repo, 'server/chat.html'))} /home/ole/webssh/public/chat.html`,
      `/usr/bin/install -o ole -g ole -m 644 ${JSON.stringify(sourceServer)} ${JSON.stringify(activeServer)}`,
      `/usr/bin/install -o ole -g ole -m 644 ${JSON.stringify(sourceProjectControl)} ${JSON.stringify(activeProjectControl)}`,
    ].join(' && ');
    await runShell(command, 2 * 60 * 1000);
  }

  await waitForPreview(project.liveHealthUrl || project.liveUrl, 3 * 60 * 1000);
  return { deployed: true, live: true, liveUrl: project.liveUrl, restartRequired };
}

async function waitForPreview(url, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await checkHttp(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Preview wurde nicht rechtzeitig bereit.');
}

let projectActivationQueue = Promise.resolve();
let publishQueue = Promise.resolve();
let deployQueue = Promise.resolve();

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

function chatTitleFromMessage(message) {
  const normalized = String(message || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\s]+/, '')
    .trim();
  if (!normalized) return 'Neuer Chat';
  return normalized.length > 52 ? `${normalized.slice(0, 51).trimEnd()}…` : normalized;
}

function pendingChatTitle(projectId, createdAt = new Date().toISOString()) {
  const projectLabel = PROJECTS[projectId]?.label || 'Code';
  const timestamp = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(createdAt));
  return `${projectLabel} · ${timestamp}`;
}

function nameChatFromMessage(chat, message) {
  if (!chat.titlePending && chat.title && chat.title !== 'Neuer Chat') return;
  chat.title = chatTitleFromMessage(message);
  chat.titlePending = false;
}

function migrateChatTitles() {
  const chats = readChats();
  let changed = false;
  for (const chat of chats) {
    if (chat.title && chat.title !== 'Neuer Chat') continue;
    const firstUserMessage = (chat.messages || []).find((entry) => entry.role === 'user')?.content;
    chat.title = firstUserMessage
      ? chatTitleFromMessage(firstUserMessage)
      : pendingChatTitle(chat.project, chat.createdAt);
    chat.titlePending = !firstUserMessage;
    changed = true;
  }
  if (changed) writeChats(chats);
}

migrateChatTitles();

function findChat(chats, id) {
  return chats.find((chat) => chat.id === id);
}

function findUserChat(chats, id, userId) {
  return chats.find((chat) => chat.id === id && chat.userId === userId);
}

const activeClaudeChats = new Map();
const activeCodexChats = new Map();
const codexLoginProcesses = new Map();

function claudeSessionExists(project, conversationId) {
  const projectKey = project.repo.replace(/[^a-zA-Z0-9-]/g, '-');
  const sessionFile = path.join(
    '/home/ole/.claude/projects',
    projectKey,
    `${conversationId}.jsonl`
  );
  return fs.existsSync(sessionFile);
}

function claudeChatBusy(res, conversationId) {
  if (!activeClaudeChats.has(conversationId)) return false;
  res.status(409).json({ error: 'Claude arbeitet bereits in diesem Chat.' });
  return true;
}

function claudeSystemPrompt(req) {
  const username = req.session?.username || 'unbekannt';
  return [
    SERVER_SYSTEM_PROMPT,
    `Der aktuell angemeldete Practio-Nutzer ist "${username}".`,
    'Beziehe dich standardmäßig nur auf diesen Nutzer und seine eigenen Tasks.',
    'Analysiere, erwähne oder ändere Tasks anderer Personen nur, wenn die aktuelle Nutzernachricht',
    'ausdrücklich nach einer anderen Person, dem Team oder allen Tasks fragt.',
    'Ohne eine solche ausdrückliche Aufforderung darfst du den Fokus nicht auf fremde Tasks verlagern.',
  ].join(' ');
}

function parseChatInput(body = {}) {
  let message = typeof body.message === 'string' ? body.message.trim() : '';
  let context = typeof body.context === 'string' ? body.context.trim() : '';
  const legacyContext = message.match(/^(\[Practio Kontext\][\s\S]*?\[\/Practio Kontext\])\s*/);
  if (legacyContext) {
    if (!context) context = legacyContext[1];
    message = message.slice(legacyContext[0].length).trim();
  }
  return {
    message,
    context,
    prompt: context ? `${context}\n\n${message}` : message,
  };
}

function codexHomeForUser(userId) {
  const dir = path.join(CODEX_HOME_ROOT, userId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function codexEnv(req) {
  return {
    ...process.env,
    HOME: '/home/ole',
    CODEX_HOME: codexHomeForUser(req.session.userId),
    PATH: CODEX_PATH,
    NO_COLOR: '1',
  };
}

function codexLoginStatus(req, callback) {
  execFile(
    CODEX_BIN,
    ['login', 'status'],
    { env: codexEnv(req), timeout: 20_000, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      callback(null, {
        loggedIn: !error && /logged in/i.test(stdout),
        method: !error ? stdout.trim() : null,
        error: error ? (stderr || stdout || error.message).trim() : null,
      });
    }
  );
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function finishCodexLoginWaiters(state, error) {
  const waiters = state.waiters.splice(0);
  waiters.forEach((waiter) => waiter(error, state));
}

function startCodexDeviceLogin(req, callback) {
  const userId = req.session.userId;
  const existing = codexLoginProcesses.get(userId);
  if (existing?.url && existing?.code) return callback(null, existing);
  if (existing) {
    existing.waiters.push(callback);
    return;
  }

  const state = {
    child: null,
    output: '',
    url: null,
    code: null,
    waiters: [callback],
  };
  const child = spawn(CODEX_BIN, ['login', '--device-auth'], {
    env: codexEnv(req),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.child = child;
  codexLoginProcesses.set(userId, state);

  const consume = (chunk) => {
    state.output += stripAnsi(chunk.toString());
    if (state.output.length > 30_000) state.output = state.output.slice(-30_000);
    state.url ||= state.output.match(/https:\/\/auth\.openai\.com\/codex\/device/)?.[0] || null;
    state.code ||= state.output.match(/\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/)?.[0] || null;
    if (state.url && state.code && state.waiters.length) finishCodexLoginWaiters(state, null);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', (error) => {
    if (state.waiters.length) finishCodexLoginWaiters(state, error);
    codexLoginProcesses.delete(userId);
  });
  child.on('close', (code) => {
    state.child = null;
    if (state.waiters.length) {
      finishCodexLoginWaiters(state, new Error(code === 0 ? 'Login beendet' : 'Login fehlgeschlagen'));
    }
    setTimeout(() => {
      if (codexLoginProcesses.get(userId) === state) codexLoginProcesses.delete(userId);
    }, 60_000);
  });

  setTimeout(() => {
    if (!state.url || !state.code) {
      try { child.kill('SIGTERM'); } catch {}
      if (state.waiters.length) finishCodexLoginWaiters(state, new Error('Device-Code nicht verfügbar'));
      codexLoginProcesses.delete(userId);
    }
  }, 20_000);
}

function parseCodexModels(stdout) {
  const catalog = JSON.parse(stdout);
  return (catalog.models || [])
    .filter((model) => model.visibility === 'list' && !model.upgrade)
    .map((model) => ({
      id: model.slug,
      label: model.display_name || model.slug,
      description: model.description || '',
      defaultEffort: model.default_reasoning_level || 'medium',
      efforts: (model.supported_reasoning_levels || []).map((entry) => entry.effort),
    }));
}

function loadCodexModels(req, callback, bundled = false) {
  const args = ['debug', 'models'];
  if (bundled) args.push('--bundled');
  execFile(
    CODEX_BIN,
    args,
    { env: codexEnv(req), timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    (error, stdout) => {
      if (error && !bundled) return loadCodexModels(req, callback, true);
      if (error) return callback(error);
      try { callback(null, parseCodexModels(stdout)); }
      catch (parseError) { callback(parseError); }
    }
  );
}

function parseCodexResult(stdout) {
  let threadId = null;
  let response = '';
  let usage = null;
  let failure = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      response = event.item.text || response;
    }
    if (event.type === 'turn.completed') usage = event.usage || null;
    if (event.type === 'turn.failed' || event.type === 'error') {
      failure = event.error?.message || event.message || 'Codex-Ausführung fehlgeschlagen.';
    }
  }
  return { threadId, response, usage, failure };
}

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

function writeUsers(users) {
  fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function gbrainCapture(username, project, chatTitle, chatId, message, response) {
  const tmpFile = `/tmp/gbrain-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.md`;
  const content = [
    `# ${chatTitle}`,
    '',
    `**Benutzer:** ${username}`,
    `**Projekt:** ${project}`,
    `**Datum:** ${new Date().toISOString()}`,
    `**Chat-ID:** ${chatId}`,
    '',
    '## Prompt',
    '',
    message,
    '',
    '## Antwort',
    '',
    response,
  ].join('\n');
  fs.writeFileSync(tmpFile, content, { mode: 0o600 });
  exec(`${GBRAIN_BIN} capture --file ${tmpFile}`, { env: GBRAIN_ENV, timeout: 30_000 }, (err) => {
    fs.unlink(tmpFile, () => {});
    if (err) console.error('gbrain capture failed:', err.message);
  });
}

const PASSWORD_HASH = bcrypt.hashSync(process.env.WEBSSH_PASSWORD || 'ChangeMe123!', 10);

const SSL_OPTIONS = {
  key: fs.readFileSync(path.join(__dirname, 'ssl/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl/cert.pem')),
};

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

class JsonSessionStore extends session.Store {
  read() {
    try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
  }

  write(sessions) {
    fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });
    const temporaryFile = `${SESSIONS_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(sessions), { mode: 0o600 });
    fs.renameSync(temporaryFile, SESSIONS_FILE);
  }

  get(sid, callback) {
    try {
      const sessions = this.read();
      const entry = sessions[sid];
      if (!entry) return callback(null, null);
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        delete sessions[sid];
        this.write(sessions);
        return callback(null, null);
      }
      callback(null, entry.session);
    } catch (error) { callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      const sessions = this.read();
      sessions[sid] = {
        expiresAt: value.cookie?.expires ? new Date(value.cookie.expires).getTime() : null,
        session: value,
      };
      this.write(sessions);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try {
      const sessions = this.read();
      delete sessions[sid];
      this.write(sessions);
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) {
    this.set(sid, value, callback);
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  store: new JsonSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000 },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Versuche. Bitte 15 Minuten warten.' },
});

function requireAuth(req, res, next) {
  if (req.session) req.session.authenticated = true;
  next();
}

function requireApiAuth(req, res, next) {
  if (!req.session?.userId || !req.session.username) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  const user = readUsers().find((entry) => entry.id === req.session.userId);
  if (!user || user.status !== 'approved') {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  next();
}

app.get('/', (req, res) => {
  res.redirect('/terminal');
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

// ─── User-System ─────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet.' });
  const user = readUsers().find((u) => u.id === req.session.userId);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Keine Admin-Rechte.' });
  next();
}

app.get('/api/users/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = readUsers().find((u) => u.id === req.session.userId);
  res.json({ loggedIn: true, userId: req.session.userId, username: req.session.username, isAdmin: user?.isAdmin || false });
});

app.post('/api/users/register', loginLimiter, async (req, res) => {
  const username = (typeof req.body.username === 'string' ? req.body.username : '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (username.length < 2) return res.status(400).json({ error: 'Benutzername zu kurz (min. 2 Zeichen).' });
  if (username.length > 30) return res.status(400).json({ error: 'Benutzername zu lang (max. 30 Zeichen).' });
  if (password.length < 4) return res.status(400).json({ error: 'Passwort zu kurz (min. 4 Zeichen).' });
  const users = readUsers();
  if (users.find((u) => u.username === username)) return res.status(409).json({ error: 'Benutzername bereits vergeben.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: crypto.randomUUID(), username, passwordHash, isAdmin: false, status: 'pending', createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);
  res.status(201).json({ ok: true, pending: true, message: 'Dein Account wurde erstellt und wartet auf Genehmigung durch den Admin.' });
});

app.post('/api/users/login', loginLimiter, async (req, res) => {
  const username = (typeof req.body.username === 'string' ? req.body.username : '').trim().toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const users = readUsers();
  const user = users.find((u) => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort.' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Dein Account wartet noch auf Genehmigung durch den Admin.' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username, isAdmin: user.isAdmin || false });
});

app.post('/api/users/logout', (req, res) => {
  req.session.userId = null;
  req.session.username = null;
  res.json({ ok: true });
});

// ─── Admin-API ────────────────────────────────────────────────────────────────
app.get('/api/admin/users/pending', requireAdmin, (req, res) => {
  const pending = readUsers()
    .filter((u) => u.status === 'pending')
    .map(({ id, username, createdAt }) => ({ id, username, createdAt }));
  res.json(pending);
});

app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  const users = readUsers();
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User nicht gefunden.' });
  user.status = 'approved';
  writeUsers(users);
  res.json({ ok: true, username: user.username });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const users = readUsers();
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User nicht gefunden.' });
  if (user.isAdmin) return res.status(400).json({ error: 'Admin-Account kann nicht gelöscht werden.' });
  writeUsers(users.filter((u) => u.id !== req.params.id));
  res.json({ ok: true });
});

// --- Practio Projektsteuerung ---
const projectControlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Zu viele Projektsteuerungs-Anfragen. Bitte kurz warten.' },
});

app.get('/api/project-control/workspace', requireApiAuth, async (req, res) => {
  try {
    res.json(await projectControl.getWorkspace());
  } catch (error) {
    console.error('Project Control workspace failed:', error.message);
    res.status(500).json({ error: 'Projekt-Daten konnten nicht geladen werden.' });
  }
});

app.post('/api/project-control/resources/:table', requireApiAuth, projectControlLimiter, async (req, res) => {
  const table = req.params.table;
  if (!projectControl.allowedTables.has(table) || table === 'activity_log') {
    return res.status(404).json({ error: 'Ressource nicht gefunden.' });
  }
  try {
    const resource = await projectControl.saveResource(table, req.body || {});
    await projectControl.logActivity({
      projectId: resource.project_id || projectControl.projectId,
      taskId: resource.task_id || (table === 'tasks' ? resource.id : null),
      actor: req.session.username,
      action: `${table}.saved`,
      source: 'dashboard',
      details: { resourceId: resource.id },
    });
    res.json(resource);
  } catch (error) {
    console.error(`Project Control ${table} save failed:`, error.message);
    res.status(400).json({ error: error.message || 'Speichern fehlgeschlagen.' });
  }
});

app.delete('/api/project-control/resources/:table/:id', requireApiAuth, projectControlLimiter, async (req, res) => {
  const table = req.params.table;
  if (!projectControl.allowedTables.has(table) || table === 'activity_log') {
    return res.status(404).json({ error: 'Ressource nicht gefunden.' });
  }
  try {
    await projectControl.deleteResource(table, req.params.id);
    await projectControl.logActivity({
      actor: req.session.username,
      action: `${table}.deleted`,
      source: 'dashboard',
      details: { resourceId: req.params.id },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error(`Project Control ${table} delete failed:`, error.message);
    res.status(400).json({ error: error.message || 'Löschen fehlgeschlagen.' });
  }
});

app.post('/api/project-control/tasks/:id/github/sync', requireApiAuth, projectControlLimiter, async (req, res) => {
  try {
    const status = await projectControl.syncGithub(req.body || {});
    const link = await projectControl.saveResource('github_links', {
      ...(req.body.link || {}),
      task_id: req.params.id,
      ...status,
    });
    await projectControl.logActivity({
      taskId: req.params.id,
      actor: req.session.username,
      action: 'github.status_synced',
      source: 'github',
      details: { mode: status.mode, repository: status.repository, prUrl: status.pr_url || null },
    });
    res.json(link);
  } catch (error) {
    console.error('Project Control GitHub sync failed:', error.message);
    res.status(400).json({ error: error.message || 'GitHub-Status konnte nicht geladen werden.' });
  }
});

app.post('/api/project-control/tasks/:id/review', requireApiAuth, projectControlLimiter, async (req, res) => {
  try {
    const workspace = await projectControl.getWorkspace();
    const task = workspace.tasks.find((entry) => entry.id === req.params.id) || req.body.task;
    if (!task) return res.status(404).json({ error: 'Task nicht gefunden.' });
    const review = await projectControl.reviewTask(task, req.body || {});
    const stored = await projectControl.saveResource('ai_reviews', {
      task_id: req.params.id,
      commit_hash: req.body.commit_hash || '',
      pr_url: req.body.pr_url || '',
      ...review,
    });
    await projectControl.logActivity({
      taskId: req.params.id,
      actor: req.session.username,
      action: 'ai.review_completed',
      source: 'ai',
      details: { provider: review.provider, result: review.result },
    });
    res.json(stored);
  } catch (error) {
    console.error('Project Control AI review failed:', error.message);
    res.status(500).json({ error: 'AI-Review konnte nicht abgeschlossen werden.' });
  }
});

// --- Preview-Einstellungen (per User) ---
const PREVIEW_SETTINGS_FILE = path.join(CHAT_DATA_DIR, 'preview-settings.json');
function readPreviewSettings() {
  try { return JSON.parse(fs.readFileSync(PREVIEW_SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function writePreviewSettings(s) {
  fs.mkdirSync(CHAT_DATA_DIR, { recursive: true });
  fs.writeFileSync(PREVIEW_SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function getActivePreviewSettings(project) {
  try {
    const c = fs.readFileSync(`/etc/systemd/system/${project.service}`, 'utf8');
    return {
      devMode: /^Environment=DEV_MODE=true$/m.test(c),
      publicDevMode: /^Environment=NEXT_PUBLIC_DEV_MODE=true$/m.test(c),
    };
  } catch { return { devMode: false, publicDevMode: false }; }
}

app.get('/api/preview/settings', requireApiAuth, (req, res) => {
  const project = PROJECTS['epikur'];
  if (!project?.service) return res.status(404).json({ error: 'Kein Preview-Service.' });
  const username = req.session.username;
  const all = readPreviewSettings();
  const active = getActivePreviewSettings(project);
  const userSettings = all[username] || active;
  res.json({
    devMode: userSettings.devMode,
    publicDevMode: userSettings.publicDevMode,
    active,
    appliedBy: all._appliedBy || null,
    appliedAt: all._appliedAt || null,
  });
});

app.post('/api/preview/settings', requireApiAuth, async (req, res) => {
  const project = PROJECTS['epikur'];
  if (!project?.service) return res.status(404).json({ error: 'Kein Preview-Service.' });
  const { devMode, publicDevMode } = req.body;
  if (typeof devMode !== 'boolean' || typeof publicDevMode !== 'boolean') {
    return res.status(400).json({ error: 'Ungültige Parameter.' });
  }
  const username = req.session.username;
  const now = new Date().toISOString();
  const all = readPreviewSettings();
  all[username] = { devMode, publicDevMode };
  all._appliedBy = username;
  all._appliedAt = now;
  writePreviewSettings(all);
  const serviceFile = `/etc/systemd/system/${project.service}`;
  try {
    let content = fs.readFileSync(serviceFile, 'utf8');
    content = content.replace(/^Environment=DEV_MODE=.*$/m, `Environment=DEV_MODE=${devMode}`);
    content = content.replace(/^Environment=NEXT_PUBLIC_DEV_MODE=.*$/m, `Environment=NEXT_PUBLIC_DEV_MODE=${publicDevMode}`);
    const tmpFile = `/tmp/prev-svc-${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, content, 'utf8');
    await runShell(`sudo cp ${tmpFile} ${serviceFile} && rm -f ${tmpFile}`);
    await runShell('sudo systemctl daemon-reload && sudo systemctl restart epikur-preview.service');
    if (project.healthUrl) await waitForPreview(project.healthUrl, 90_000);
    res.json({ ok: true, appliedBy: username, appliedAt: now });
  } catch (e) {
    console.error('Preview settings update failed:', e);
    res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden.' });
  }
});

app.get('/terminal', requireAuth, (req, res) => {
  res.redirect('/chat');
});

app.get('/claude-login', (req, res) => res.redirect('/claude-auth'));

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
        const status = JSON.parse(stdout);
        const credentials = JSON.parse(
          fs.readFileSync('/home/ole/.claude/.credentials.json', 'utf8')
        ).claudeAiOauth;
        if (credentials?.expiresAt && credentials.expiresAt <= Date.now()) {
          return res.json({
            loggedIn: false,
            error: 'Claude-Anmeldung ist abgelaufen.',
            loginUrl: '/claude-login',
          });
        }
        res.json(status);
      } catch {
        res.status(503).json({ loggedIn: false, error: 'Ungültige Claude-Antwort' });
      }
    }
  );
});

app.get('/api/codex/status', requireApiAuth, (req, res) => {
  codexLoginStatus(req, (_error, status) => {
    res.json({
      loggedIn: status.loggedIn,
      method: status.method,
      loginProvider: status.loggedIn ? null : 'codex',
    });
  });
});

app.get('/api/codex/models', requireApiAuth, (req, res) => {
  loadCodexModels(req, (error, models) => {
    if (error) return res.status(503).json({ error: 'Codex-Modellliste nicht verfügbar.' });
    res.json({ models });
  });
});

app.post('/api/codex/login/start', requireApiAuth, (req, res) => {
  codexLoginStatus(req, (_statusError, status) => {
    if (status.loggedIn) return res.json({ loggedIn: true });
    startCodexDeviceLogin(req, (error, state) => {
      if (error) return res.status(503).json({ error: 'Codex-Login konnte nicht gestartet werden.' });
      res.json({
        loggedIn: false,
        url: state.url,
        code: state.code,
        expiresInSeconds: 15 * 60,
      });
    });
  });
});

app.post('/api/codex/logout', requireApiAuth, (req, res) => {
  const state = codexLoginProcesses.get(req.session.userId);
  if (state?.child) {
    try { state.child.kill('SIGTERM'); } catch {}
  }
  codexLoginProcesses.delete(req.session.userId);
  execFile(CODEX_BIN, ['logout'], { env: codexEnv(req), timeout: 20_000 }, (error) => {
    if (error) return res.status(500).json({ error: 'Codex-Abmeldung fehlgeschlagen.' });
    res.json({ ok: true });
  });
});

app.get('/api/claude/projects', requireApiAuth, (req, res) => {
  res.json(Object.values(PROJECTS).map(({ id, label, previewUrl, liveUrl }) => ({
    id,
    label,
    previewUrl: previewUrl || null,
    hasPreview: Boolean(previewUrl),
    liveUrl: liveUrl || null,
    canDeploy: Boolean(liveUrl),
  })));
});

app.get('/api/claude/server-health', (req, res) => {
  res.json({ ok: true, startedAt: SERVER_STARTED_AT });
});

app.post('/api/claude/projects/:id/activate', requireApiAuth, (req, res) => {
  const project = PROJECTS[req.params.id];
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.' });
  const services = Object.values(PROJECTS).map((entry) => entry.service).filter(Boolean);
  const command = [
    ...services.filter((service) => service !== project.service).map((service) => `sudo systemctl stop ${service} || true`),
    ...(project.service ? [`sudo systemctl start ${project.service}`] : []),
  ].join(' && ');
  const activate = async () => {
    await runShell(command || 'true');
    return {
      ok: true,
      project: {
        id: project.id,
        label: project.label,
        previewUrl: project.previewUrl || null,
        hasPreview: Boolean(project.previewUrl),
      },
    };
  };

  const activation = projectActivationQueue.catch(() => {}).then(activate);
  projectActivationQueue = activation;
  activation
    .then((result) => res.json(result))
    .catch((error) => {
      console.error('Preview activation failed:', error.stderr || error.message);
      res.status(500).json({ error: 'Preview konnte nicht vollständig gestartet werden.' });
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

app.post('/api/claude/publish', requireApiAuth, (req, res) => {
  const project = PROJECTS[req.body?.project];
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.', stage: 'push' });
  const requestedMessage = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const commitMessage = (requestedMessage || 'feat: update from dashboard preview')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 120);

  const publish = publishQueue.catch(() => {}).then(() => publishReviewBranch(project, commitMessage));
  publishQueue = publish;
  publish
    .then((result) => res.json({ ok: true, project: project.id, ...result }))
    .catch((error) => {
      console.error('Review branch publish failed:', error.stderr || error.message);
      res.status(error.code === 'MAIN_PUSH_BLOCKED' ? 409 : 500).json({
        error: error.code === 'MAIN_PUSH_BLOCKED'
          ? error.message
          : 'Review-Branch konnte nicht gepusht werden. Details stehen im Server-Log.',
        stage: 'push',
      });
    });
});

app.post('/api/claude/deploy', requireApiAuth, (req, res) => {
  const project = PROJECTS[req.body?.project];
  if (!project) return res.status(404).json({ error: 'Projekt nicht gefunden.', stage: 'deploy' });
  const deploy = deployQueue.catch(() => {}).then(() => deployProject(project));
  deployQueue = deploy;
  deploy
    .then((result) => {
      res.json({ ok: true, project: project.id, serverStartedAt: SERVER_STARTED_AT, ...result });
      if (result.restartRequired) {
        setTimeout(() => {
          exec('sudo /usr/bin/systemctl restart webssh.service', (error, stdout, stderr) => {
            if (error) console.error('WebSSH restart failed:', stderr || error.message);
          });
        }, 750);
      }
    })
    .catch((error) => {
      console.error('Production deploy failed:', error.stderr || error.message);
      res.status(500).json({
        error: 'Deployment fehlgeschlagen. Es wurde kein automatischer Merge oder Main-Push ausgeführt.',
        stage: 'deploy',
      });
    });
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Zu viele Nachrichten. Bitte kurz warten.' },
});

app.get('/api/claude/chats', requireApiAuth, (req, res) => {
  const userId = req.session.userId || null;
  const chats = readChats()
    .filter((chat) => chat.userId === userId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(({ id, title, provider, model, effort, project, username, createdAt, updatedAt, messages, usage }) => ({
      id,
      title,
      provider: provider || 'claude',
      model,
      effort: effort || 'medium',
      project: project || 'epikur',
      username: username || null,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      usage: usage || null,
    }));
  res.json(chats);
});

app.post('/api/claude/chats', requireApiAuth, (req, res) => {
  const now = new Date().toISOString();
  const provider = req.body.provider === 'codex' ? 'codex' : 'claude';
  const codexModel = typeof req.body.model === 'string' && /^[a-z0-9.-]{2,80}$/i.test(req.body.model)
    ? req.body.model
    : 'gpt-5.5';
  const model = provider === 'codex'
    ? codexModel
    : (CHAT_MODELS.has(req.body.model) ? req.body.model : 'sonnet');
  const effort = CHAT_EFFORTS.has(req.body.effort) ? req.body.effort : 'medium';
  const project = PROJECTS[req.body.project] ? req.body.project : 'epikur';
  const chat = {
    id: crypto.randomUUID(),
    userId: req.session.userId || null,
    username: req.session.username || null,
    title: pendingChatTitle(project, now),
    titlePending: true,
    provider,
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
  const chat = findUserChat(readChats(), req.params.id, req.session.userId);
  if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  res.json(chat);
});

app.delete('/api/claude/chats/:id', requireApiAuth, (req, res) => {
  const chats = readChats();
  const chat = findUserChat(chats, req.params.id, req.session.userId);
  if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  const remaining = chats.filter((entry) => entry.id !== chat.id);
  writeChats(remaining);
  res.json({ ok: true });
});

app.post('/api/claude/chat', requireApiAuth, chatLimiter, (req, res) => {
  const { message, context, prompt } = parseChatInput(req.body);
  const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : '';
  const model = CHAT_MODELS.has(req.body.model) ? req.body.model : 'sonnet';
  const effort = CHAT_EFFORTS.has(req.body.effort) ? req.body.effort : 'medium';

  if (!message || message.length > 20_000) {
    return res.status(400).json({ error: 'Nachricht fehlt oder ist zu lang.' });
  }
  if (context.length > 40_000 || prompt.length > 50_000) {
    return res.status(400).json({ error: 'Interner Kontext ist zu lang.' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    return res.status(400).json({ error: 'Ungültige Chat-ID.' });
  }
  if (!hasCurrentClaudeCredentials()) {
    return res.status(401).json({
      error: 'Claude-Anmeldung ist abgelaufen.',
      loginUrl: '/claude-auth',
    });
  }

  const chats = readChats();
  const chat = findUserChat(chats, conversationId, req.session.userId);
  if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  if (claudeChatBusy(res, conversationId)) return;
  const project = getProject(chat.project);

  const resume = claudeSessionExists(project, conversationId);
  const now = new Date().toISOString();
  chat.model = model;
  chat.effort = effort;
  chat.project = project.id;
  chat.updatedAt = now;
  chat.messages.push({ role: 'user', content: message, createdAt: now });
  nameChatFromMessage(chat, message);
  writeChats(chats);

  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--append-system-prompt',
    claudeSystemPrompt(req),
    '--model',
    model,
    '--effort',
    effort,
  ];
  if (resume) args.push('--resume', conversationId);
  else args.push('--session-id', conversationId);

  const child = execFile(
    '/usr/bin/claude',
    args,
    {
      cwd: project.repo,
      env: { ...process.env, HOME: '/home/ole' },
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (activeClaudeChats.get(conversationId) === child) {
        activeClaudeChats.delete(conversationId);
      }
      if (error) {
        let result = null;
        try { result = JSON.parse(stdout); } catch {}
        const failure = claudeStreamError(result, stderr || error.message, false);
        console.error('Claude chat failed:', result?.result || stderr || error.message);
        return res.status(failure.loginUrl ? 401 : 500).json({
          error: failure.message,
          ...(failure.loginUrl ? { loginUrl: failure.loginUrl } : {}),
        });
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
        // gbrain: Gespräch asynchron im Langzeit-Gedächtnis speichern
        gbrainCapture(
          req.session.username || 'anonym',
          project.id,
          currentChat?.title || chat.title,
          conversationId,
          message,
          responseText
        );
      } catch {
        res.status(500).json({ error: 'Claude hat eine ungültige Antwort geliefert.' });
      }
    }
  );
  activeClaudeChats.set(conversationId, child);
  child.stdin.end();
});

app.post('/api/codex/chat', requireApiAuth, chatLimiter, (req, res) => {
  const { message, context, prompt: promptMessage } = parseChatInput(req.body);
  const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : '';
  const model = typeof req.body.model === 'string' && /^[a-z0-9.-]{2,80}$/i.test(req.body.model)
    ? req.body.model
    : 'gpt-5.5';
  const effort = CHAT_EFFORTS.has(req.body.effort) ? req.body.effort : 'medium';

  if (!message || message.length > 20_000) {
    return res.status(400).json({ error: 'Nachricht fehlt oder ist zu lang.' });
  }
  if (context.length > 40_000 || promptMessage.length > 50_000) {
    return res.status(400).json({ error: 'Interner Kontext ist zu lang.' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    return res.status(400).json({ error: 'Ungültige Chat-ID.' });
  }

  codexLoginStatus(req, (_statusError, status) => {
    if (!status.loggedIn) {
      return res.status(401).json({
        error: 'Codex ist nicht angemeldet.',
        loginProvider: 'codex',
      });
    }

    const chats = readChats();
    const chat = findUserChat(chats, conversationId, req.session.userId);
    if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
    if (activeCodexChats.has(conversationId)) {
      return res.status(409).json({ error: 'Codex arbeitet bereits in diesem Chat.' });
    }
    const project = getProject(chat.project);
    const now = new Date().toISOString();
    chat.provider = 'codex';
    chat.model = model;
    chat.effort = effort;
    chat.project = project.id;
    chat.updatedAt = now;
    chat.messages.push({ role: 'user', content: message, createdAt: now, provider: 'codex' });
    nameChatFromMessage(chat, message);
    writeChats(chats);

    const prompt = [
      '[Verbindliche Server-Anweisung]',
      claudeSystemPrompt(req),
      '[/Verbindliche Server-Anweisung]',
      '',
      promptMessage,
    ].join('\n');
    const commonArgs = [
      '-a', 'never',
      '-s', 'danger-full-access',
      'exec',
    ];
    const runArgs = chat.codexThreadId
      ? [
          ...commonArgs,
          'resume',
          '--json',
          '--skip-git-repo-check',
          '--model', model,
          '-c', `model_reasoning_effort="${effort}"`,
          chat.codexThreadId,
          prompt,
        ]
      : [
          ...commonArgs,
          '--json',
          '--color', 'never',
          '--skip-git-repo-check',
          '--model', model,
          '-c', `model_reasoning_effort="${effort}"`,
          '-C', project.repo,
          prompt,
        ];

    const child = execFile(
      CODEX_BIN,
      runArgs,
      {
        cwd: project.repo,
        env: codexEnv(req),
        timeout: 10 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (activeCodexChats.get(conversationId) === child) activeCodexChats.delete(conversationId);
        const result = parseCodexResult(stdout || '');
        if (error || result.failure || !result.response) {
          const details = [result.failure, stderr, error?.message].filter(Boolean).join('\n');
          console.error('Codex chat failed:', details);
          if (/not logged|log in|login|authentication|unauthorized|401/i.test(details)) {
            return res.status(401).json({ error: 'Codex ist nicht angemeldet.', loginProvider: 'codex' });
          }
          return res.status(500).json({ error: 'Codex konnte die Anfrage nicht ausführen.' });
        }

        const currentChats = readChats();
        const currentChat = findUserChat(currentChats, conversationId, req.session.userId);
        if (currentChat) {
          currentChat.updatedAt = new Date().toISOString();
          currentChat.provider = 'codex';
          currentChat.model = model;
          currentChat.effort = effort;
          currentChat.project = project.id;
          currentChat.codexThreadId = result.threadId || currentChat.codexThreadId || null;
          currentChat.usage = result.usage ? {
            inputTokens: result.usage.input_tokens || 0,
            cachedInputTokens: result.usage.cached_input_tokens || 0,
            outputTokens: result.usage.output_tokens || 0,
            reasoningOutputTokens: result.usage.reasoning_output_tokens || 0,
          } : null;
          currentChat.messages.push({
            role: 'assistant',
            content: result.response,
            createdAt: currentChat.updatedAt,
            provider: 'codex',
          });
          writeChats(currentChats);
        }
        res.json({ response: result.response, chat: currentChat, usage: currentChat?.usage || null });
        gbrainCapture(
          req.session.username,
          project.id,
          currentChat?.title || chat.title,
          conversationId,
          message,
          result.response
        );
      }
    );
    activeCodexChats.set(conversationId, child);
    child.stdin.end();
  });
});

function claudeStreamError(result, stderr, timedOut) {
  if (timedOut) return {
    message: 'Claude hat nach 10 Minuten nicht geantwortet.',
  };

  const details = [result?.result, stderr].filter(Boolean).join('\n');
  if (result?.api_error_status === 401 || /authenticat|credentials|oauth|401/i.test(details)) {
    return {
      message: 'Claude ist nicht angemeldet oder die Anmeldung ist abgelaufen.',
      loginUrl: '/claude-login',
    };
  }
  if (result?.api_error_status === 429 || /rate.?limit|too many requests|429/i.test(details)) {
    return {
      message: 'Claude hat das aktuelle Nutzungslimit erreicht. Bitte später erneut versuchen.',
    };
  }
  return {
    message: 'Claude konnte die Anfrage nicht ausführen. Details stehen im Server-Log.',
  };
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (typeof entry?.text === 'string') return entry.text;
    if (typeof entry?.content === 'string') return entry.content;
    return JSON.stringify(entry);
  }).join('\n');
}

// Streaming chat endpoint. Fetch consumes the SSE response while Claude is working.
app.post('/api/claude/chat/stream', requireApiAuth, chatLimiter, (req, res) => {
  const { message, context, prompt } = parseChatInput(req.body);
  const conversationId = typeof req.body.conversationId === 'string' ? req.body.conversationId : '';
  const model = CHAT_MODELS.has(req.body.model) ? req.body.model : 'sonnet';
  const effort = CHAT_EFFORTS.has(req.body.effort) ? req.body.effort : 'medium';

  if (!message || message.length > 20_000) {
    return res.status(400).json({ error: 'Nachricht fehlt oder ist zu lang.' });
  }
  if (context.length > 40_000 || prompt.length > 50_000) {
    return res.status(400).json({ error: 'Interner Kontext ist zu lang.' });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    return res.status(400).json({ error: 'Ungültige Chat-ID.' });
  }

  const chats = readChats();
  const chat = findUserChat(chats, conversationId, req.session.userId);
  if (!chat) return res.status(404).json({ error: 'Chat nicht gefunden.' });
  if (claudeChatBusy(res, conversationId)) return;
  const project = getProject(chat.project);
  const resume = claudeSessionExists(project, conversationId);
  const now = new Date().toISOString();

  chat.model = model;
  chat.effort = effort;
  chat.project = project.id;
  chat.updatedAt = now;
  chat.messages.push({ role: 'user', content: message, createdAt: now });
  nameChatFromMessage(chat, message);
  writeChats(chats);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (event) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  emit({ type: 'chat_title', title: chat.title, updatedAt: chat.updatedAt });

  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    '--append-system-prompt',
    claudeSystemPrompt(req),
    '--model',
    model,
    '--effort',
    effort,
  ];
  if (resume) args.push('--resume', conversationId);
  else args.push('--session-id', conversationId);

  const child = spawn('/usr/bin/claude', args, {
    cwd: project.repo,
    env: { ...process.env, HOME: '/home/ole' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeClaudeChats.set(conversationId, child);

  let buffer = '';
  let streamedText = '';
  let finalizedText = '';
  let finalResult = null;
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const emittedTools = new Set();

  const processEvent = (event) => {
    if (event.type === 'stream_event') {
      const delta = event.event?.delta;
      if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        streamedText += delta.text;
        emit({ type: 'text', text: delta.text });
      }
      return;
    }

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      if (event.error || event.message?.model === '<synthetic>') return;
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          finalizedText += block.text;
        } else if (block.type === 'tool_use' && !emittedTools.has(block.id)) {
          emittedTools.add(block.id);
          emit({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input || {},
          });
        }
      }
      return;
    }

    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          emit({
            type: 'tool_result',
            id: block.tool_use_id,
            content: toolResultText(block.content).slice(0, 12_000),
            isError: Boolean(block.is_error),
          });
        }
      }
      return;
    }

    if (event.type === 'system' && event.subtype === 'api_retry') {
      emit({
        type: 'status',
        message: event.error_status === 401
          ? 'Claude-Anmeldung wird geprüft...'
          : `Claude verbindet erneut (Versuch ${event.attempt})...`,
      });
      return;
    }

    if (event.type === 'result') finalResult = event;
  };

  const processLine = (line) => {
    if (!line.trim()) return;
    try {
      processEvent(JSON.parse(line));
    } catch {
      console.error('Invalid Claude stream line:', line.slice(0, 300));
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(processLine);
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 15_000);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, 10 * 60 * 1000);

  const finish = (code) => {
    if (settled) return;
    settled = true;
    if (activeClaudeChats.get(conversationId) === child) {
      activeClaudeChats.delete(conversationId);
    }
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (buffer.trim()) processLine(buffer);

    if (finalResult?.is_error || code !== 0 || timedOut) {
      const failure = claudeStreamError(finalResult, stderr, timedOut);
      console.error('Claude stream failed:', finalResult?.result || stderr || `exit ${code}`);
      emit({ type: 'error', ...failure });
      res.end();
      return;
    }

    const responseText = streamedText || finalizedText || finalResult?.result || 'Keine Antwort erhalten.';
    const currentChats = readChats();
    const currentChat = findChat(currentChats, conversationId);
    if (currentChat) {
      currentChat.updatedAt = new Date().toISOString();
      currentChat.model = model;
      currentChat.effort = effort;
      currentChat.project = project.id;
      if (finalResult) currentChat.usage = getUsageSummary(finalResult);
      currentChat.messages.push({
        role: 'assistant',
        content: responseText,
        createdAt: currentChat.updatedAt,
      });
      writeChats(currentChats);
    }

    emit({
      type: 'done',
      sessionId: finalResult?.session_id || conversationId,
      response: responseText,
      chat: currentChat,
      usage: currentChat?.usage || null,
    });
    res.end();
    gbrainCapture(
      req.session.username || 'anonym',
      project.id,
      currentChat?.title || chat.title,
      conversationId,
      message,
      responseText
    );
  };

  child.on('close', finish);
  child.on('error', (error) => {
    stderr += `\n${error.message}`;
    finish(1);
  });
  res.on('close', () => {
    if (!settled && !res.writableEnded) child.kill('SIGTERM');
  });
});



// ─── Claude Auth (stabil, kein Neustart beim Reload) ─────────────────────────
let _claudeAuthUrl = null;
let _claudeAuthProcess = null;
let _claudeAuthOutput = '';
let _claudeAuthWaiters = [];

function hasCurrentClaudeCredentials() {
  try {
    const credentials = JSON.parse(
      fs.readFileSync('/home/ole/.claude/.credentials.json', 'utf8')
    ).claudeAiOauth;
    return Boolean(credentials?.accessToken && credentials?.expiresAt > Date.now());
  } catch {
    return false;
  }
}

function finishClaudeAuthStart(error, url) {
  const waiters = _claudeAuthWaiters;
  _claudeAuthWaiters = [];
  waiters.forEach((waiter) => waiter(error, url));
}

function stopClaudeAuth() {
  const child = _claudeAuthProcess;
  _claudeAuthProcess = null;
  _claudeAuthUrl = null;
  _claudeAuthOutput = '';
  if (_claudeAuthWaiters.length) {
    finishClaudeAuthStart(new Error('Login wurde neu gestartet'));
  }
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

function startClaudeAuth(cb) {
  if (_claudeAuthUrl) return cb(null, _claudeAuthUrl);
  _claudeAuthWaiters.push(cb);
  if (_claudeAuthProcess) return;

  _claudeAuthOutput = '';
  const child = spawn('/usr/bin/claude', ['auth', 'login'], {
    cwd: PROJECTS.epikur.repo,
    env: { ...process.env, HOME: '/home/ole', BROWSER: 'echo', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  _claudeAuthProcess = child;

  const consume = (chunk) => {
    if (_claudeAuthProcess !== child) return;
    _claudeAuthOutput += chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
    if (_claudeAuthOutput.length > 30_000) _claudeAuthOutput = _claudeAuthOutput.slice(-30_000);
    if (_claudeAuthUrl) return;
    const match = _claudeAuthOutput.match(/https:\/\/[^\s]+/);
    if (match) {
      _claudeAuthUrl = match[0];
      finishClaudeAuthStart(null, _claudeAuthUrl);
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', (error) => {
    if (_claudeAuthProcess !== child) return;
    _claudeAuthProcess = null;
    finishClaudeAuthStart(error);
  });
  child.on('close', () => {
    if (_claudeAuthProcess !== child) return;
    _claudeAuthProcess = null;
    if (!_claudeAuthUrl) finishClaudeAuthStart(new Error('URL nicht gefunden'));
  });

  setTimeout(() => {
    if (!_claudeAuthUrl && _claudeAuthProcess === child) {
      child.kill('SIGTERM');
      finishClaudeAuthStart(new Error('URL nicht gefunden'));
    }
  }, 20_000);
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
  stopClaudeAuth();
  res.redirect('/claude-auth');
});

app.post('/claude-auth/submit', requireAuth, (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const child = _claudeAuthProcess;
  if (!code) return res.json({ success: false, error: 'Kein Code' });
  if (code.length > 4096 || /[\r\n]/.test(code)) {
    return res.json({ success: false, error: 'Ungültiger Code' });
  }
  if (!child?.stdin?.writable) {
    return res.json({ success: false, error: 'Login-Sitzung abgelaufen — bitte neuen Link generieren.' });
  }

  child.stdin.write(`${code}\n`);
  const deadline = Date.now() + 15_000;
  const verify = () => {
    if (hasCurrentClaudeCredentials()) {
      _claudeAuthUrl = null;
      return res.json({ success: true });
    }
    if (Date.now() >= deadline || (_claudeAuthProcess !== child && !child.stdin.writable)) {
      _claudeAuthUrl = null;
      return res.json({
        success: false,
        error: 'Code wurde nicht akzeptiert — bitte neuen Link generieren.',
      });
    }
    setTimeout(verify, 500);
  };
  setTimeout(verify, 500);
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
  console.log('WebSSH laeuft auf https://212.227.167.218:' + PORT);
});
