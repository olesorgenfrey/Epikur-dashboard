const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RESOURCE_TABLES = new Set([
  'projects',
  'masterplans',
  'milestones',
  'tasks',
  'task_comments',
  'task_checklist_items',
  'github_links',
  'ai_reviews',
  'team_members',
  'activity_log',
]);

const ALLOWED_FIELDS = {
  projects: ['id', 'slug', 'name', 'description', 'repository', 'active', 'created_at', 'updated_at'],
  masterplans: ['id', 'project_id', 'product_goal', 'mvp_goal', 'modules', 'risks', 'open_questions', 'version', 'created_at', 'updated_at'],
  milestones: ['id', 'project_id', 'label', 'description', 'target_date', 'done', 'progress', 'color', 'sort_order', 'created_at', 'updated_at'],
  tasks: [
    'id', 'project_id', 'milestone_id', 'title', 'text', 'description', 'acceptance_criteria',
    'priority', 'module', 'effort', 'team_member_id', 'assignee_id', 'dependencies',
    'definition_of_done', 'status', 'done', 'sort_order', 'created_at', 'updated_at',
  ],
  task_comments: ['id', 'task_id', 'author', 'body', 'created_at', 'updated_at'],
  task_checklist_items: ['id', 'task_id', 'label', 'done', 'sort_order', 'created_at', 'updated_at'],
  github_links: [
    'id', 'task_id', 'repository', 'branch_name', 'commit_hash', 'pr_url', 'branch_exists',
    'pr_open', 'checks_passed', 'review_needed', 'merge_ready', 'last_synced_at', 'created_at', 'updated_at',
  ],
  ai_reviews: [
    'id', 'task_id', 'commit_hash', 'pr_url', 'result', 'summary', 'findings',
    'suggestions', 'next_task', 'provider', 'raw_excerpt', 'created_at',
  ],
  team_members: ['id', 'project_id', 'name', 'role', 'responsibilities', 'color', 'active', 'created_at', 'updated_at'],
  activity_log: ['id', 'project_id', 'task_id', 'actor', 'action', 'source', 'details', 'created_at'],
};

const IDS = {
  project: '10000000-0000-4000-8000-000000000001',
  masterplan: '10000000-0000-4000-8000-000000000002',
  ole: '10000000-0000-4000-8000-000000000003',
  henry: '10000000-0000-4000-8000-000000000004',
  milestoneMvp: '10000000-0000-4000-8000-000000000005',
  milestoneLaunch: '10000000-0000-4000-8000-000000000006',
  milestoneCustomers: '10000000-0000-4000-8000-000000000007',
  milestoneMrr: '10000000-0000-4000-8000-000000000008',
  milestoneBreakEven: '10000000-0000-4000-8000-000000000009',
  milestoneScale: '10000000-0000-4000-8000-000000000010',
};

function now() {
  return new Date().toISOString();
}

function defaultWorkspace() {
  const createdAt = now();
  return {
    projects: [{
      id: IDS.project,
      slug: 'practio',
      name: 'Practio',
      description: 'Produktentwicklung und Markteinführung von Practio.',
      repository: 'olesorgenfrey/epikur',
      active: true,
      created_at: createdAt,
      updated_at: createdAt,
    }],
    masterplans: [{
      id: IDS.masterplan,
      project_id: IDS.project,
      product_goal: 'Practio wird die verlässliche digitale Arbeitsumgebung für psychotherapeutische Praxen.',
      mvp_goal: 'Ein sicherer, verständlicher Kernworkflow, der im Praxisalltag ohne Schulungsaufwand nutzbar ist.',
      modules: ['Praxisverwaltung', 'Patientenportal', 'Dokumentation', 'Abrechnung', 'Betrieb & Sicherheit'],
      risks: ['Datenschutz und Schweigepflicht', 'Zu großer MVP-Umfang', 'Fehlende echte Praxis-Tests'],
      open_questions: ['Welche drei Workflows sparen Praxen zuerst messbar Zeit?', 'Welche Daten müssen zum MVP exportierbar sein?'],
      version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    }],
    milestones: [
      {
        id: IDS.milestoneMvp,
        project_id: IDS.project,
        label: 'MVP produktionsbereit',
        description: 'Kernabläufe, Datenschutzprüfung und Betriebsdokumentation abgeschlossen.',
        target_date: '2026-07-31',
        done: false,
        progress: 60,
        color: '#6EA8FF',
        sort_order: 1,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: IDS.milestoneLaunch,
        project_id: IDS.project,
        label: 'Erster zahlender Kunde',
        description: 'Onboarding und begleiteter Praxistest mit echtem Feedback.',
        target_date: '2026-08-31',
        done: false,
        progress: 0,
        color: '#4ADE80',
        sort_order: 2,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: IDS.milestoneCustomers,
        project_id: IDS.project,
        label: '10 zahlende Kunden',
        target_date: '2026-10-31',
        done: false,
        progress: 0,
        color: '#C084FC',
        sort_order: 3,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: IDS.milestoneMrr,
        project_id: IDS.project,
        label: '1.000 € MRR',
        target_date: '2026-11-30',
        done: false,
        progress: 0,
        color: '#FBBF24',
        sort_order: 4,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: IDS.milestoneBreakEven,
        project_id: IDS.project,
        label: 'Break-even erreicht',
        target_date: '2027-01-31',
        done: false,
        progress: 0,
        color: '#F97316',
        sort_order: 5,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: IDS.milestoneScale,
        project_id: IDS.project,
        label: '5.000 € MRR',
        target_date: '2027-06-30',
        done: false,
        progress: 0,
        color: '#F472B6',
        sort_order: 6,
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    tasks: [],
    task_comments: [],
    task_checklist_items: [],
    github_links: [],
    ai_reviews: [],
    team_members: [
      {
        id: IDS.ole,
        project_id: IDS.project,
        name: 'Ole',
        role: 'Product & Tech Lead',
        responsibilities: ['Produktentscheidungen', 'Technische Hauptaufgaben', 'Reviews', 'Feature-Priorisierung'],
        color: 'blue',
        active: true,
        created_at: createdAt,
        updated_at: createdAt,
      },
      {
        id: IDS.henry,
        project_id: IDS.project,
        name: 'Henry',
        role: 'Research & Operations',
        responsibilities: ['Recherche', 'Dokumentation', 'Tests', 'Einfache UI- und Content-Aufgaben', 'Praxislisten', 'Wettbewerbsanalyse', 'Marketing-Vorbereitung'],
        color: 'purple',
        active: true,
        created_at: createdAt,
        updated_at: createdAt,
      },
    ],
    activity_log: [],
  };
}

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`HTTP ${response.statusCode}: ${text.slice(0, 500)}`);
          error.statusCode = response.statusCode;
          return reject(error);
        }
        if (options.raw) return resolve(text);
        if (!text) return resolve(null);
        try { resolve(JSON.parse(text)); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(20_000, () => request.destroy(new Error('Request timeout')));
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function createProjectControlService({ dataDir, logger = console }) {
  const storeFile = path.join(dataDir, 'project-control.json');
  const auditFile = path.join(dataDir, 'project-control-activity.jsonl');
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const hasSupabase = Boolean(supabaseUrl && supabaseKey);

  function readStore() {
    try {
      const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      const defaults = defaultWorkspace();
      for (const table of RESOURCE_TABLES) {
        if (!Array.isArray(stored[table])) stored[table] = defaults[table] || [];
      }
      return stored;
    } catch {
      const seeded = defaultWorkspace();
      writeStore(seeded);
      return seeded;
    }
  }

  function writeStore(store) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = `${storeFile}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryFile, storeFile);
  }

  function sanitize(table, value) {
    const clean = {};
    for (const field of ALLOWED_FIELDS[table] || []) {
      if (value[field] !== undefined) clean[field] = value[field];
    }
    clean.id ||= crypto.randomUUID();
    if (table === 'tasks') {
      clean.title = String(clean.title || clean.text || '').trim();
      clean.text = clean.title;
      clean.status ||= clean.done ? 'done' : 'backlog';
      clean.done = clean.status === 'done';
    }
    if (table === 'activity_log' || table === 'ai_reviews') clean.created_at ||= now();
    else {
      clean.created_at ||= value.created_at || now();
      clean.updated_at = now();
    }
    return clean;
  }

  async function supabase(table, query = '', method = 'GET', body = null) {
    const separator = query ? `?${query}` : '';
    return requestJson(`${supabaseUrl}/rest/v1/${table}${separator}`, {
      method,
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
      },
    }, body);
  }

  async function seedSupabase() {
    const seed = defaultWorkspace();
    for (const table of ['projects', 'masterplans', 'milestones', 'team_members']) {
      for (const row of seed[table]) await supabase(table, 'on_conflict=id', 'POST', row);
    }
  }

  async function loadSupabaseWorkspace() {
    let projects = await supabase('projects', 'slug=eq.practio&limit=1');
    if (!projects.length) {
      await seedSupabase();
      projects = await supabase('projects', 'slug=eq.practio&limit=1');
    }
    const project = projects[0];
    const projectQuery = `project_id=eq.${encodeURIComponent(project.id)}&order=created_at.asc`;
    const [masterplans, milestones, tasks, teamMembers, activityLog] = await Promise.all([
      supabase('masterplans', projectQuery),
      supabase('milestones', `project_id=eq.${encodeURIComponent(project.id)}&order=sort_order.asc`),
      supabase('tasks', `project_id=eq.${encodeURIComponent(project.id)}&order=sort_order.asc,created_at.asc`),
      supabase('team_members', projectQuery),
      supabase('activity_log', `project_id=eq.${encodeURIComponent(project.id)}&order=created_at.desc&limit=100`),
    ]);
    const taskIds = tasks.map((task) => task.id);
    const taskQuery = taskIds.length
      ? `task_id=in.(${taskIds.map(encodeURIComponent).join(',')})&order=created_at.asc`
      : 'task_id=eq.00000000-0000-0000-0000-000000000000';
    const [comments, checklist, githubLinks, aiReviews] = await Promise.all([
      supabase('task_comments', taskQuery),
      supabase('task_checklist_items', taskQuery),
      supabase('github_links', taskQuery),
      supabase('ai_reviews', taskQuery),
    ]);
    return {
      projects,
      masterplans,
      milestones,
      tasks,
      task_comments: comments,
      task_checklist_items: checklist,
      github_links: githubLinks,
      ai_reviews: aiReviews,
      team_members: teamMembers,
      activity_log: activityLog,
      mode: 'supabase',
    };
  }

  async function getWorkspace() {
    if (hasSupabase) {
      try { return await loadSupabaseWorkspace(); }
      catch (error) {
        logger.error('Project Control Supabase fallback:', error.message);
        return { ...readStore(), mode: 'fallback', warning: 'Supabase nicht erreichbar; Server-Fallback aktiv.' };
      }
    }
    return { ...readStore(), mode: 'fallback', warning: 'SUPABASE_SERVICE_ROLE_KEY fehlt; Server-Fallback aktiv.' };
  }

  async function saveResource(table, value) {
    if (!RESOURCE_TABLES.has(table)) throw new Error('Unbekannte Ressource.');
    const clean = sanitize(table, value || {});
    if (hasSupabase) {
      try {
        const rows = await supabase(table, 'on_conflict=id', 'POST', clean);
        return rows?.[0] || clean;
      } catch (error) {
        logger.error(`Project Control ${table} Supabase write fallback:`, error.message);
      }
    }
    const store = readStore();
    const index = store[table].findIndex((row) => row.id === clean.id);
    if (index >= 0) store[table][index] = { ...store[table][index], ...clean };
    else store[table].push(clean);
    writeStore(store);
    return clean;
  }

  async function deleteResource(table, id) {
    if (!RESOURCE_TABLES.has(table) || table === 'activity_log') throw new Error('Unbekannte oder geschützte Ressource.');
    if (hasSupabase) {
      try {
        await supabase(table, `id=eq.${encodeURIComponent(id)}`, 'DELETE');
        return;
      } catch (error) {
        logger.error(`Project Control ${table} Supabase delete fallback:`, error.message);
      }
    }
    const store = readStore();
    store[table] = store[table].filter((row) => row.id !== id);
    writeStore(store);
  }

  async function logActivity({ projectId = IDS.project, taskId = null, actor = 'system', action, source, details = {} }) {
    const entry = sanitize('activity_log', {
      project_id: projectId,
      task_id: taskId,
      actor,
      action,
      source,
      details,
    });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await saveResource('activity_log', entry);
    return entry;
  }

  function githubHeaders(accept = 'application/vnd.github+json') {
    const headers = {
      Accept: accept,
      'User-Agent': 'Practio-Project-Control',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    return headers;
  }

  async function github(pathname, accept, raw = false) {
    return requestJson(`https://api.github.com${pathname}`, {
      method: 'GET',
      headers: githubHeaders(accept),
      raw,
    });
  }

  function parsePullRequest(prUrl) {
    const match = String(prUrl || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
    return match ? { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
  }

  function assertRepository(repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
      throw new Error('Ungültiges GitHub-Repository.');
    }
  }

  async function syncGithub(input) {
    const prRef = parsePullRequest(input.pr_url);
    const repository = prRef?.repository || input.repository;
    assertRepository(repository);
    const result = {
      repository,
      branch_name: input.branch_name || '',
      commit_hash: input.commit_hash || '',
      pr_url: input.pr_url || '',
      branch_exists: false,
      pr_open: false,
      checks_passed: false,
      review_needed: true,
      merge_ready: false,
      last_synced_at: now(),
      mode: process.env.GITHUB_TOKEN ? 'authenticated' : 'anonymous',
    };
    try {
      if (result.branch_name) {
        await github(`/repos/${repository}/branches/${encodeURIComponent(result.branch_name)}`);
        result.branch_exists = true;
      }
      let sha = result.commit_hash;
      if (prRef) {
        const pull = await github(`/repos/${repository}/pulls/${prRef.number}`);
        result.pr_open = pull.state === 'open';
        result.branch_exists = true;
        result.branch_name ||= pull.head?.ref || '';
        sha ||= pull.head?.sha || '';
        result.commit_hash ||= sha;
        const reviews = await github(`/repos/${repository}/pulls/${prRef.number}/reviews`);
        const latestByUser = new Map();
        for (const review of reviews || []) latestByUser.set(review.user?.login, review.state);
        result.review_needed = ![...latestByUser.values()].some((state) => state === 'APPROVED');
        result.merge_ready = Boolean(result.pr_open && pull.mergeable === true);
      }
      if (sha) {
        const checks = await github(`/repos/${repository}/commits/${encodeURIComponent(sha)}/check-runs`);
        const runs = checks.check_runs || [];
        result.checks_passed = runs.length > 0 && runs.every((run) =>
          run.status === 'completed' && ['success', 'neutral', 'skipped'].includes(run.conclusion)
        );
      }
      result.merge_ready = Boolean(result.merge_ready && result.checks_passed && !result.review_needed);
      return result;
    } catch (error) {
      return {
        ...result,
        mode: 'fallback',
        warning: `GitHub-Status nicht vollständig verfügbar: ${error.message}`,
      };
    }
  }

  async function loadDiff(input) {
    const prRef = parsePullRequest(input.pr_url);
    const repository = prRef?.repository || input.repository;
    assertRepository(repository);
    if (prRef) {
      return github(`/repos/${repository}/pulls/${prRef.number}`, 'application/vnd.github.v3.diff', true);
    }
    if (input.commit_hash) {
      const commit = await github(`/repos/${repository}/commits/${encodeURIComponent(input.commit_hash)}`);
      return safeArray(commit.files)
        .map((file) => `--- ${file.filename}\n${file.patch || '[Binärdatei oder Patch nicht verfügbar]'}`)
        .join('\n\n');
    }
    throw new Error('Commit-Hash oder Pull-Request-Link fehlt.');
  }

  function extractJson(value) {
    const text = String(value || '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(candidate);
  }

  function runClaudeReview(prompt) {
    return new Promise((resolve, reject) => {
      if (process.env.PRACTIO_AI_REVIEW_MODE === 'mock' || !fs.existsSync('/usr/bin/claude')) {
        return reject(new Error('Claude Review nicht konfiguriert.'));
      }
      execFile(
        '/usr/bin/claude',
        ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', process.env.CLAUDE_REVIEW_MODEL || 'sonnet'],
        {
          cwd: process.env.PRACTIO_REVIEW_REPO || '/home/ole',
          env: { ...process.env, HOME: '/home/ole' },
          timeout: 5 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr || error.message));
          try {
            const outer = JSON.parse(stdout);
            resolve(extractJson(outer.result));
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    });
  }

  function fallbackReview(task, diff, reason) {
    const criteria = safeArray(task.acceptance_criteria);
    const hasDiff = Boolean(diff && diff.trim());
    return {
      result: hasDiff && criteria.length ? 'changes_needed' : 'reject',
      summary: hasDiff
        ? 'Automatischer Fallback-Check abgeschlossen. Für eine belastbare Bewertung ist der AI-Reviewer derzeit nicht verfügbar.'
        : 'Es konnte kein Diff geladen werden.',
      findings: [
        ...(criteria.length ? [] : ['Für den Task fehlen prüfbare Akzeptanzkriterien.']),
        ...(hasDiff ? [] : ['Commit oder Pull Request liefert keinen analysierbaren Diff.']),
        `Fallback-Grund: ${reason}`,
      ],
      suggestions: [
        'Akzeptanzkriterien einzeln im Pull Request nachweisen.',
        'Tests und relevante manuelle Prüfschritte im PR beschreiben.',
        'Review erneut starten, sobald der AI-Provider verfügbar ist.',
      ],
      next_task: 'Offene Review-Findings beheben und anschließend Checks erneut ausführen.',
      provider: 'fallback',
    };
  }

  async function reviewTask(task, input) {
    let diff = '';
    try { diff = await loadDiff(input); }
    catch (error) { return fallbackReview(task, '', error.message); }
    const prompt = [
      'Du bist ein strenger Senior-Code-Reviewer für Practio.',
      'Bewerte den Diff gegen die Task-Daten. Prüfe Akzeptanzkriterien, Codequalität, Bugs, Sicherheit und UX.',
      'Antworte ausschließlich als JSON mit diesen Feldern:',
      '{"result":"ready|changes_needed|reject","summary":"...","findings":["..."],"suggestions":["..."],"next_task":"..."}',
      'ready nur wenn alle Akzeptanzkriterien nachvollziehbar erfüllt sind. Merge niemals selbst.',
      '',
      `TASK:\n${JSON.stringify(task, null, 2)}`,
      '',
      `DIFF:\n${diff.slice(0, 60_000)}`,
    ].join('\n');
    try {
      const review = await runClaudeReview(prompt);
      return {
        result: ['ready', 'changes_needed', 'reject'].includes(review.result) ? review.result : 'changes_needed',
        summary: String(review.summary || ''),
        findings: safeArray(review.findings).map(String),
        suggestions: safeArray(review.suggestions).map(String),
        next_task: String(review.next_task || ''),
        provider: 'claude',
        raw_excerpt: diff.slice(0, 1000),
      };
    } catch (error) {
      return fallbackReview(task, diff, error.message);
    }
  }

  return {
    getWorkspace,
    saveResource,
    deleteResource,
    logActivity,
    syncGithub,
    reviewTask,
    projectId: IDS.project,
    allowedTables: RESOURCE_TABLES,
  };
}

module.exports = { createProjectControlService };
