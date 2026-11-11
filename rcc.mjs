#!/usr/bin/env node
// review-code-in-context helper. No dependencies. Needs Node 18+ and git; gh is optional.
// Commands: skeleton [base] | build | start [--no-open] | wait [seconds] | reply <id> | sessions | resume [id] | config | status | stop
// Sessions are saved under ~/.review-code-in-context/sessions/<id>/ (override with RCC_HOME).
import { execFileSync, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const HOME_DIR = process.env.RCC_HOME || path.join(os.homedir(), '.review-code-in-context');
const ARGV = process.argv.slice(2);
function takeFlag(name) { const i = ARGV.indexOf(name); if (i < 0) return null; const v = ARGV[i + 1]; ARGV.splice(i, 2); return v || ''; }
const SESSION_ARG = takeFlag('--session');
let OUT = '';
const P = (n) => path.join(OUT, n);
const MAX_ROWS = 8000;
const SKIP = [
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$/, 'lock file'],
  [/\.lock\.hcl$/, 'lock file'],
  [/\.(min\.js|min\.css|map|snap)$/, 'generated file'],
  [/(^|\/)(dist|build|node_modules|vendor|\.next|coverage)\//, 'generated or vendored folder'],
  [/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp4|mov)$/i, 'binary file'],
];

function run(cmd, args, input) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, input, stdio: ['pipe', 'pipe', 'pipe'] });
}
const git = (...a) => run('git', a);
function attempt(fn, dflt) { try { return fn(); } catch { return dflt; } }
function readJSON(file, dflt) { return attempt(() => JSON.parse(fs.readFileSync(file, 'utf8')), dflt); }
function writeJSON(file, v) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); }
function die(msg) { console.error('review-code-in-context: ' + msg); process.exit(1); }
function repoRoot() { return attempt(() => run('git', ['rev-parse', '--show-toplevel']).trim(), ''); }
function pointerFile(root) { return path.join(HOME_DIR, 'current', crypto.createHash('sha1').update(root).digest('hex').slice(0, 12)); }
function setPointer(root, id) { fs.mkdirSync(path.join(HOME_DIR, 'current'), { recursive: true }); fs.writeFileSync(pointerFile(root), id); }
function useSession(id) { OUT = path.join(HOME_DIR, 'sessions', id); if (!fs.existsSync(OUT)) die('no such session: ' + id + '. Run: sessions'); return id; }
function currentSession() {
  if (SESSION_ARG) return useSession(SESSION_ARG);
  const root = repoRoot();
  const id = root ? attempt(() => fs.readFileSync(pointerFile(root), 'utf8').trim(), '') : '';
  if (!id) die('no review session for this repository yet. Run skeleton to start one, or sessions to list them all.');
  return useSession(id);
}
function touchMeta(patch) { const m = Object.assign(readJSON(P('meta.json'), {}), patch || {}, { updatedAt: Date.now() }); writeJSON(P('meta.json'), m); return m; }
function listSessions() {
  const dir = path.join(HOME_DIR, 'sessions');
  return attempt(() => fs.readdirSync(dir), []).map((id) => readJSON(path.join(dir, id, 'meta.json'), null)).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - (t || 0)) / 1000));
  if (s < 60) return s + ' second' + (s === 1 ? '' : 's') + ' ago';
  const m = Math.round(s / 60); if (m < 60) return m + ' minute' + (m === 1 ? '' : 's') + ' ago';
  const h = Math.round(m / 60); if (h < 48) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  return Math.round(h / 24) + ' days ago';
}
function splitLines(text) { const a = text.split('\n'); if (a.length && a[a.length - 1] === '') a.pop(); return a.map((l) => l.replace(/\r$/, '')); }

function detectPr() {
  const j = attempt(() => JSON.parse(run('gh', ['pr', 'view', '--json', 'number,url,title,body,baseRefName,headRefName,headRefOid'])), null);
  if (!j) return null;
  j.repo = attempt(() => run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim(), '');
  return j;
}

function skeleton(baseArg) {
  attempt(() => git('rev-parse', '--git-dir'), null) || die('run this inside a git repository.');
  const root = repoRoot();
  const earlier = listSessions().filter((m) => m.repoPath === root && !m.submitted);
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + '-' + crypto.randomBytes(2).toString('hex');
  OUT = path.join(HOME_DIR, 'sessions', id);
  fs.mkdirSync(OUT, { recursive: true });
  const pr = detectPr();
  const candidates = [baseArg, pr && 'origin/' + pr.baseRefName, pr && pr.baseRefName,
    attempt(() => git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim(), null), 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean);
  const base = candidates.find((b) => attempt(() => git('rev-parse', '--verify', '--quiet', b + '^{commit}'), null));
  if (!base) die('could not find a base branch. Pass one, for example: skeleton origin/main');
  const mb = git('merge-base', base, 'HEAD').trim();
  const sha = git('rev-parse', 'HEAD').trim();
  const head = attempt(() => git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  const parts = git('diff', '-M', '--name-status', '-z', mb, 'HEAD').split('\0').filter((s) => s !== '');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    let oldPath = null, p;
    if (/^[RC]/.test(st)) { oldPath = parts[i++]; p = parts[i++]; } else { p = parts[i++]; }
    const status = st[0] === 'A' ? 'added' : st[0] === 'D' ? 'deleted' : st[0] === 'R' ? 'renamed' : 'modified';
    const f = { path: p, status, lines: [], changes: [], adds: 0, dels: 0 };
    if (oldPath && oldPath !== p) f.oldPath = oldPath;
    const skip = SKIP.find(([re]) => re.test(p));
    if (skip) { f.skipped = skip[1]; files.push(f); continue; }
    let rows = [];
    if (status === 'added') {
      rows = splitLines(git('show', 'HEAD:' + p)).map((t, k) => ({ n: k + 1, k: '+', t }));
    } else if (status === 'deleted') {
      rows = splitLines(git('show', mb + ':' + p)).map((t, k) => ({ n: null, o: k + 1, k: '-', t }));
    } else {
      const d = git('diff', '-M', '-U1000000', mb, 'HEAD', '--', ...(oldPath ? [oldPath, p] : [p]));
      const at = d.indexOf('\n@@');
      if (at < 0) {
        rows = splitLines(git('show', 'HEAD:' + p)).map((t, k) => ({ n: k + 1, o: k + 1, k: ' ', t }));
      } else {
        let n = 0, o = 0;
        for (const raw of splitLines(d.slice(at + 1))) {
          const c = raw[0], t = raw.slice(1);
          if (c === '@' || c === '\\') continue;
          if (c === '+') rows.push({ n: ++n, k: '+', t });
          else if (c === '-') rows.push({ n: null, o: ++o, k: '-', t });
          else rows.push({ n: ++n, o: ++o, k: ' ', t });
        }
      }
    }
    if (rows.some((r) => r.t.includes('\0'))) { f.skipped = 'binary file'; files.push(f); continue; }
    if (rows.length > MAX_ROWS) { f.skipped = 'very large file (' + rows.length + ' lines)'; files.push(f); continue; }
    let cur = null;
    rows.forEach((r, k) => {
      if (r.k === ' ') return;
      if (r.k === '+') f.adds++; else f.dels++;
      if (cur && k - cur.endRow <= 3) cur.endRow = k; else { cur = { startRow: k, endRow: k }; f.changes.push(cur); }
    });
    // rows GitHub lets you attach a line comment to: changed lines and 3 lines of context either side
    for (const c of f.changes) for (let k = Math.max(0, c.startRow - 3); k <= Math.min(rows.length - 1, c.endRow + 3); k++) rows[k].c = 1;
    f.lines = rows;
    files.push(f);
  }
  files.sort((x, y) => (x.skipped ? 1 : 0) - (y.skipped ? 1 : 0));
  const out = { pr: { repo: pr ? pr.repo : '', number: pr ? pr.number : null, url: pr ? pr.url : '', title: pr ? pr.title : '', body: pr ? pr.body : '', base, head, sha, mergeBase: mb, prHeadSha: pr ? pr.headRefOid : '' }, files };
  writeJSON(P('skeleton.json'), out);
  touchMeta({ id, repoPath: root, repoName: path.basename(root), branch: head, base, sha, prNumber: pr ? pr.number : null, prTitle: pr ? pr.title : '', createdAt: Date.now(), files: files.length, analysed: false });
  setPointer(root, id);
  console.log('SESSION ' + id + '  (saved under ' + OUT + ')');
  if (earlier.length) console.log('NOTE: ' + earlier.length + ' earlier unfinished session(s) exist for this repository; the newest was last used ' + ago(earlier[0].updatedAt) + '. To pick one up instead, run: resume ' + earlier[0].id);
  console.log((pr ? 'PR #' + pr.number + ': ' + pr.title : 'No GitHub PR found for this branch (gh missing, not signed in, or no PR). Comments will be saved to a file.') + '\n' + base + ' … ' + head + ' @ ' + sha.slice(0, 7) + '\n');
  if (pr && pr.headRefOid && pr.headRefOid !== sha) console.log('WARNING: local HEAD differs from the PR head on GitHub (' + pr.headRefOid.slice(0, 7) + '). Pull or push before posting comments.\n');
  files.forEach((f, i) => {
    console.log((i + 1) + '. [' + f.status + '] ' + f.path + (f.oldPath ? ' (was ' + f.oldPath + ')' : '') + (f.skipped ? '  -- not shown: ' + f.skipped : '  +' + f.adds + ' -' + f.dels));
    f.changes.forEach((c, k) => {
      const rs = f.lines.slice(c.startRow, c.endRow + 1), ns = rs.filter((r) => r.n != null).map((r) => r.n), os = rs.filter((r) => r.k === '-').map((r) => r.o);
      console.log('     change ' + (k + 1) + ': ' + (ns.length ? 'new lines ' + ns[0] + '-' + ns[ns.length - 1] : 'old lines ' + os[0] + '-' + os[os.length - 1] + ' (removed only)'));
    });
  });
  console.log('\nWrote ' + P('skeleton.json') + '. Next: write ' + P('annotations.json') + ', then run: build');
}

function merge() {
  const sk = readJSON(P('skeleton.json'), null) || die('no skeleton.json. Run: skeleton');
  const an = readJSON(P('annotations.json'), {});
  const warn = [];
  const ents = an.entities || {}, afiles = an.files || {};
  Object.keys(afiles).forEach((p) => { if (!sk.files.some((f) => f.path === p)) warn.push('annotations name a file that is not in the diff: ' + p); });
  const files = sk.files.map((f) => {
    const a = afiles[f.path] || {};
    if (!afiles[f.path] && !f.skipped) warn.push('no annotations for ' + f.path);
    if (a.changes && a.changes.length !== f.changes.length) warn.push(f.path + ': annotations have ' + a.changes.length + ' changes, the diff has ' + f.changes.length);
    const changes = f.changes.map((c, k) => Object.assign({}, c, (a.changes || [])[k] || {}));
    changes.forEach((c, k) => ['starts', 'uses'].forEach((s) => (c[s] || []).forEach((id) => { if (!ents[id]) warn.push(f.path + ' change ' + (k + 1) + ': unknown entity id "' + id + '"'); })));
    (a.refs || []).forEach((r) => {
      const row = f.lines.find((l) => (f.status === 'deleted' ? l.o : l.n) === r.line && (f.status === 'deleted' || l.k !== '-'));
      if (!row) warn.push(f.path + ': ref on line ' + r.line + ' but that line does not exist');
      else if (!row.t.includes(r.text)) warn.push(f.path + ' line ' + r.line + ': ref text "' + r.text + '" is not on that line');
      if (!r.types && !ents[r.id]) warn.push(f.path + ' line ' + r.line + ': ref to unknown entity id "' + r.id + '"');
    });
    return Object.assign({}, f, { summary: a.summary || '', before: a.before || '', after: a.after || '', flow: a.flow || [], types: a.types || [], refs: a.refs || [], changes });
  });
  Object.values(ents).forEach((e) => { if (e.file && !sk.files.some((f) => f.path === e.file)) delete e.file; });
  const data = { pr: Object.assign({}, sk.pr, an.pr || {}), entities: ents, files };
  writeJSON(P('data.json'), data);
  return { data, warn };
}

function build() {
  const { data, warn } = merge();
  touchMeta({ analysed: true, files: data.files.length });
  console.log('Built ' + P('data.json') + ': ' + data.files.length + ' files, ' + Object.keys(data.entities).length + ' entities.');
  if (warn.length) { console.log('\nFix these in annotations.json, then run build again:'); warn.forEach((w) => console.log(' - ' + w)); process.exitCode = 2; }
}

function serverInfo() {
  const info = readJSON(P('server.json'), null);
  if (!info) return null;
  try { process.kill(info.pid, 0); return info; } catch { return null; }
}
async function api(info, method, route, body, timeoutMs) {
  const res = await fetch('http://127.0.0.1:' + info.port + route, { method, headers: { 'content-type': 'application/json', 'x-rcc-token': info.token }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs || 15000) });
  return res.json();
}

async function start(open) {
  if (!fs.existsSync(P('data.json'))) build();
  let info = serverInfo();
  if (info) { await api(info, 'POST', '/api/reload'); }
  else {
    attempt(() => fs.unlinkSync(P('server.json')));
    const logFd = fs.openSync(P('server.log'), 'a');
    const meta = readJSON(P('meta.json'), {});
    const child = spawn(process.execPath, [SELF, 'serve', '--session', path.basename(OUT)], { detached: true, stdio: ['ignore', logFd, logFd], cwd: meta.repoPath && fs.existsSync(meta.repoPath) ? meta.repoPath : process.cwd() });
    child.unref();
    for (let k = 0; k < 50 && !(info = serverInfo()); k++) await new Promise((r) => setTimeout(r, 100));
    if (!info) die('the review server did not start.');
  }
  const url = 'http://127.0.0.1:' + info.port + '/';
  if (open) attempt(() => {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  });
  console.log('Review is open at ' + url);
}

function ghLines(args) {
  return new Promise((resolve) => execFile('gh', args, { maxBuffer: 1 << 27 }, (err, out, errOut) => {
    if (err) return resolve({ error: String(errOut || err.message).trim().slice(0, 400) });
    try { resolve({ rows: String(out).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) }); } catch { resolve({ error: 'could not read the reply from GitHub' }); }
  }));
}
async function fetchPrComments(pr) {
  const out = { fetchedAt: Date.now(), error: '', line: [], general: [] };
  if (!pr.number || !pr.repo) { out.error = 'No GitHub PR is linked to this session.'; return out; }
  const base = 'repos/' + pr.repo;
  const [a, b, c] = await Promise.all([
    ghLines(['api', '--paginate', base + '/pulls/' + pr.number + '/comments?per_page=100', '--jq', '.[] | {id, path, line, original_line, side, body, user: .user.login, at: .created_at, reply: .in_reply_to_id, url: .html_url} | tojson']),
    ghLines(['api', '--paginate', base + '/issues/' + pr.number + '/comments?per_page=100', '--jq', '.[] | {id, body, user: .user.login, at: .created_at, url: .html_url} | tojson']),
    ghLines(['api', '--paginate', base + '/pulls/' + pr.number + '/reviews?per_page=100', '--jq', '.[] | {id, body, state, user: .user.login, at: .submitted_at, url: .html_url} | tojson']),
  ]);
  out.error = a.error || b.error || c.error || '';
  out.line = (a.rows || []).map((x) => Object.assign(x, { outdated: x.line == null, line: x.line != null ? x.line : x.original_line, side: x.side || 'RIGHT' }));
  out.general = (b.rows || []).map((x) => Object.assign(x, { kind: 'comment' }))
    .concat((c.rows || []).filter((x) => (x.body && x.body.trim()) || (x.state && x.state !== 'COMMENTED' && x.state !== 'PENDING')).map((x) => Object.assign(x, { kind: 'review' })))
    .sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return out;
}
async function commentsCmd() {
  const data = readJSON(P('data.json'), null) || readJSON(P('skeleton.json'), null) || die('no session data yet. Run: skeleton');
  const c = await fetchPrComments(data.pr);
  writeJSON(P('pr-comments.json'), c);
  if (c.error) console.log('NOTE: ' + c.error);
  console.log('Conversation and reviews on the PR (' + c.general.length + '):');
  c.general.forEach((x) => console.log(' - ' + x.user + (x.kind === 'review' ? ' [review: ' + x.state + ']' : '') + ' (' + ago(Date.parse(x.at)) + '): ' + String(x.body || '').replace(/\s+/g, ' ').slice(0, 600)));
  console.log('Comments on lines (' + c.line.length + '):');
  c.line.forEach((x) => console.log(' - ' + x.path + ':' + x.line + (x.side === 'LEFT' ? ' (removed line)' : '') + (x.outdated ? ' [older version of the code]' : '') + ' ' + x.user + ' (' + ago(Date.parse(x.at)) + '): ' + String(x.body || '').replace(/\s+/g, ' ').slice(0, 600)));
}
const ticketDir = (key) => path.join(HOME_DIR, 'tickets', String(key).replace(/[^A-Za-z0-9_.-]/g, '_'));
const STALE_MS = 30 * 60 * 1000;
function loadTickets() {
  const m = readJSON(P('meta.json'), {});
  return { tickets: (m.tickets || []).map((k) => {
    const file = path.join(ticketDir(k), 'ticket.json'), t = readJSON(file, null);
    if (t) t.fetchedAt = attempt(() => fs.statSync(file).mtimeMs, t.fetchedAt || 0);
    return t;
  }).filter(Boolean) };
}
function related(meta) {
  if (!meta.tickets || !meta.tickets.length) return [];
  return listSessions().filter((m) => m.id !== meta.id && (m.tickets || []).some((k) => meta.tickets.includes(k)))
    .map((m) => ({ id: m.id, label: m.repoName + ' · ' + (m.prNumber ? 'PR #' + m.prNumber : m.branch), shared: (m.tickets || []).filter((k) => meta.tickets.includes(k)) }));
}
function adf(n) {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(adf).join('');
  const kids = adf(n.content || []);
  switch (n.type) {
    case 'text': return n.text || '';
    case 'hardBreak': return '\n';
    case 'mention': return (n.attrs && n.attrs.text) || '@someone';
    case 'emoji': return (n.attrs && (n.attrs.text || n.attrs.shortName)) || '';
    case 'inlineCard': return (n.attrs && n.attrs.url) || '';
    case 'media': case 'mediaSingle': case 'mediaGroup': return kids || '[attachment]\n';
    case 'listItem': return '- ' + kids.trim() + '\n';
    case 'paragraph': case 'heading': case 'codeBlock': case 'blockquote': case 'tableRow': return kids + '\n';
    case 'tableCell': case 'tableHeader': return kids.trim() + ' | ';
    default: return kids;
  }
}
async function jiraCmd(key) {
  if (!key) die('usage: jira <ISSUE-KEY>');
  const baseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/$/, ''), email = process.env.JIRA_EMAIL, tok = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !tok) {
    console.log('NO_JIRA_ENV: JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set in this shell, so this command cannot read Jira itself.\nIf you have another way to read Jira (an MCP server or a signed-in CLI), fetch each ticket yourself and save it as described in SKILL.md under "Tickets", then run: tickets set <epic> <story> <task>');
    process.exitCode = 3; return;
  }
  const auth = 'Basic ' + Buffer.from(email + ':' + tok).toString('base64');
  const chain = [];
  for (let k = key; k && chain.length < 6;) {
    const r = await fetch(baseUrl + '/rest/api/3/issue/' + encodeURIComponent(k) + '?fields=summary,description,status,issuetype,parent,comment,attachment', { headers: { authorization: auth, accept: 'application/json' } });
    if (!r.ok) die('Jira answered ' + r.status + ' for ' + k + '. Check the key and the three JIRA_ variables.');
    const j = await r.json(), f = j.fields || {};
    const dir = ticketDir(j.key);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    const t = { key: j.key, type: (f.issuetype && f.issuetype.name) || '', summary: f.summary || '', status: (f.status && f.status.name) || '', url: baseUrl + '/browse/' + j.key, description: adf(f.description).trim(), parent: (f.parent && f.parent.key) || null,
      comments: ((f.comment && f.comment.comments) || []).map((c) => ({ author: (c.author && c.author.displayName) || '', at: c.created, body: adf(c.body).trim() })), attachments: [], fetchedAt: Date.now() };
    for (const a of f.attachment || []) {
      let file = null;
      if (a.size <= 20 * 1024 * 1024) {
        try {
          const res = await fetch(a.content, { headers: { authorization: auth }, redirect: 'follow' });
          if (res.ok) { file = String(a.id || '') + '-' + path.basename(a.filename).replace(/[^A-Za-z0-9_.-]/g, '_'); fs.writeFileSync(path.join(dir, 'files', file), Buffer.from(await res.arrayBuffer())); }
        } catch { file = null; }
      }
      t.attachments.push({ name: a.filename, mime: a.mimeType || '', file });
    }
    writeJSON(path.join(dir, 'ticket.json'), t);
    chain.unshift(t); k = t.parent;
  }
  touchMeta({ tickets: chain.map((t) => t.key) });
  ticketsCmd();
}
function ticketsCmd(sub, keys) {
  if (sub === 'path') { const d = ticketDir(keys[0] || die('usage: tickets path <KEY>')); fs.mkdirSync(path.join(d, 'files'), { recursive: true }); return console.log(d); }
  if (sub === 'set') touchMeta({ tickets: keys });
  const meta = readJSON(P('meta.json'), {}), list = loadTickets().tickets;
  if (!(meta.tickets || []).length) return console.log('No tickets are linked to this session.');
  console.log('Tickets linked to this session, outermost first: ' + meta.tickets.join(' > '));
  const missing = meta.tickets.filter((k) => !list.some((t) => t.key === k));
  if (missing.length) console.log('NOT FETCHED YET: ' + missing.join(', '));
  list.forEach((t) => {
    console.log('\n' + (t.type || 'Ticket') + ' ' + t.key + ' [' + (t.status || '?') + '] ' + t.summary + '  (shared copy, fetched ' + ago(t.fetchedAt) + (Date.now() - t.fetchedAt > STALE_MS ? ' -- STALE, fetch it again before relying on it' : '') + ')\n' + (t.description ? t.description.slice(0, 1500) + '\n' : '') + (t.comments || []).map((c) => '  comment by ' + c.author + ' (' + ago(Date.parse(c.at)) + '): ' + String(c.body).replace(/\s+/g, ' ').slice(0, 500)).join('\n'));
    (t.attachments || []).forEach((a) => console.log('  attachment: ' + a.name + (a.file ? ' -> ' + path.join(ticketDir(t.key), 'files', a.file) : ' (not downloaded)')));
  });
  const rel = related(meta);
  if (rel.length) console.log('\nOther review sessions that share a ticket with this one:\n' + rel.map((r) => ' - ' + r.id + ' (' + r.label + ', shares ' + r.shared.join(', ') + ')').join('\n'));
}

function excerpt(data, a) {
  const f = data.files.find((x) => x.path === a.path);
  if (!f || !f.lines.length) return '';
  let lo, hi;
  if (a.row != null) { lo = a.row - 6; hi = a.row + 6; }
  else if (a.change != null && f.changes[a.change]) { lo = f.changes[a.change].startRow - 3; hi = f.changes[a.change].endRow + 3; }
  else return '';
  lo = Math.max(0, lo); hi = Math.min(f.lines.length - 1, hi);
  return f.lines.slice(lo, hi + 1).map((l, k) => (lo + k === a.row ? '>' : ' ') + String(l.n != null ? l.n : l.o).padStart(5) + ' ' + l.k + ' ' + l.t).join('\n');
}

function serve() {
  let data = readJSON(P('data.json'), null) || die('no data.json. Run: build');
  const token = crypto.randomBytes(16).toString('hex');
  const state = Object.assign({ reviewed: {}, comments: [], chat: [], seq: 0, submitted: null, finished: false, paused: false }, readJSON(P('state.json'), {}));
  if (state.sha && state.sha !== data.pr.sha) { state.reviewed = {}; state.submitted = null; }
  state.sha = data.pr.sha; state.finished = false; state.paused = false; state.pausedReason = '';
  const persist = () => { writeJSON(P('state.json'), state); touchMeta({ reviewed: Object.values(state.reviewed).filter(Boolean).length, comments: state.comments.length, messages: state.chat.length, submitted: state.submitted ? state.submitted.event : '' }); };
  let prc = readJSON(P('pr-comments.json'), null);
  const refreshPr = async () => { prc = await fetchPrComments(data.pr); writeJSON(P('pr-comments.json'), prc); return prc; };
  refreshPr();
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'application/json' };
  let waiters = [], lastWait = 0, lastActive = Date.now(), lastHuman = Date.now();
  const repoCfg = (() => { const c = readJSON(path.join(HOME_DIR, 'config.json'), { repos: {} }).repos || {}; return Object.assign({}, c.global, c[repoRoot() || 'global']); })();
  const idleMin = Math.max(0, parseFloat(process.env.RCC_IDLE_MINUTES || repoCfg.idleMinutes || '30') || 0); // 0 switches the idle check off
  const idleMs = idleMin * 60000, graceMs = Math.max(5, parseFloat(process.env.RCC_IDLE_GRACE_SECONDS || '120') || 120) * 1000;
  const idleLeft = () => (!idleMs || state.paused || state.submitted) ? null : (Date.now() - lastHuman > idleMs ? Math.max(0, lastHuman + idleMs + graceMs - Date.now()) : null);
  const pending = () => state.chat.find((m) => m.role === 'user' && !m.answered);
  const describe = (m) => (m.deliveredAt = Date.now(), { question: { id: m.id, text: m.text, anchor: m.anchor || { kind: 'general' }, code: m.anchor ? excerpt(data, m.anchor) : '', entity: m.anchor && m.anchor.entity ? data.entities[m.anchor.entity] || null : null, changeNote: m.anchor && m.anchor.change != null ? ((data.files.find((x) => x.path === m.anchor.path) || {}).changes || [])[m.anchor.change] || null : null, existing: prc && m.anchor && m.anchor.line != null ? prc.line.filter((c) => c.path === m.anchor.path && c.line === m.anchor.line).map((c) => c.user + ': ' + c.body) : [] } });
  const flush = () => { if (!waiters.length) return; const m = pending(); const out = state.finished ? { finished: true, paused: !!state.paused, submitted: state.submitted, comments: state.comments } : m ? describe(m) : null; if (!out) return; waiters.forEach((w) => { clearTimeout(w.t); w.send(out); }); waiters = []; lastWait = Date.now(); };
  function reviewPayload(event, body) {
    const inline = [], loose = [];
    state.comments.forEach((c) => (c.commentable ? inline : loose).push(c));
    let text = body || '';
    if (loose.length) text += (text ? '\n\n' : '') + loose.map((c) => '**' + c.path + (c.line ? ':' + c.line : '') + '**\n' + c.body).join('\n\n');
    return { commit_id: data.pr.sha, event, body: text, comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side || 'RIGHT', body: c.body })) };
  }
  function submit(event, body) {
    const payload = reviewPayload(event, body);
    if (!data.pr.number || !data.pr.repo) {
      const md = '# Review notes (' + event + ')\n\n' + (payload.body ? payload.body + '\n\n' : '') + payload.comments.map((c) => '## ' + c.path + ':' + c.line + '\n\n' + c.body).join('\n\n') + '\n';
      fs.writeFileSync(P('review-comments.md'), md);
      return { ok: true, file: P('review-comments.md'), note: 'No GitHub PR was found, so the review was saved to a file.' };
    }
    writeJSON(P('last-review-payload.json'), payload);
    if (process.env.RCC_DRY_RUN) return { ok: true, note: 'Dry run: nothing was posted.', file: P('last-review-payload.json') };
    try {
      const out = JSON.parse(run('gh', ['api', '--method', 'POST', 'repos/' + data.pr.repo + '/pulls/' + data.pr.number + '/reviews', '--input', '-'], JSON.stringify(payload)));
      return { ok: true, url: out.html_url || data.pr.url };
    } catch (e) {
      return { ok: false, error: String((e.stderr || e.message || e)).trim().slice(0, 1200) };
    }
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj, type) => { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' }); res.end(type ? obj : JSON.stringify(obj)); };
    lastActive = Date.now();
    if (req.method === 'GET' && url.pathname === '/') {
      const tpl = fs.readFileSync(path.join(HERE, 'viewer.html'), 'utf8');
      const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
      return send(200, tpl.replace('/*__REVIEW_DATA__*/null', () => json + ';window.RCC=' + JSON.stringify({ token })), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const seg = url.pathname.split('/').map(decodeURIComponent);
      const file = path.join(ticketDir(seg[2] || ''), 'files', path.basename(seg[3] || ''));
      if (url.searchParams.get('t') !== token || !seg[3] || !fs.existsSync(file)) return send(404, { error: 'not found' });
      const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff', 'content-disposition': (/^(image|application\/pdf|text)/.test(type) && type !== 'image/svg+xml' ? 'inline' : 'attachment') + '; filename="' + path.basename(file).replace(/"/g, '') + '"' });
      return res.end(fs.readFileSync(file));
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
    if (req.headers['x-rcc-token'] !== token) return send(403, { error: 'bad token' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      const b = attempt(() => JSON.parse(raw || '{}'), {});
      const r = url.pathname.slice(5);
      if (['reviewed', 'comment', 'ask', 'submit', 'refresh-pr', 'touch'].includes(r)) lastHuman = Date.now();
      if (r === 'touch') return send(200, { ok: true });
      if (r === 'state') return send(200, { prComments: prc, reviewed: state.reviewed, comments: state.comments, chat: state.chat, submitted: state.submitted, finished: state.finished, paused: !!state.paused, pausedReason: state.pausedReason || '', idleMinutes: idleMin, idleLeft: idleLeft(), listening: waiters.length > 0 || Date.now() - lastWait < 30000 || state.chat.some((m) => m.role === 'user' && !m.answered && m.deliveredAt && Date.now() - m.deliveredAt < 600000), canPost: !!(data.pr.number && data.pr.repo), pr: { number: data.pr.number, url: data.pr.url } });
      if (r === 'reviewed') { state.reviewed[b.path] = !!b.value; persist(); return send(200, { ok: true }); }
      if (r === 'comment') {
        if (b.delete) state.comments = state.comments.filter((c) => c.id !== b.id);
        else if (b.id && state.comments.some((c) => c.id === b.id)) state.comments.find((c) => c.id === b.id).body = String(b.body || '');
        else state.comments.push({ id: 'c' + (++state.seq), path: b.path, line: b.line, side: b.side || 'RIGHT', row: b.row, commentable: !!b.commentable, body: String(b.body || '') });
        persist(); return send(200, { ok: true, comments: state.comments });
      }
      if (r === 'ask') { state.finished = false; state.paused = false; state.chat.push({ id: 'q' + (++state.seq), role: 'user', text: String(b.text || ''), anchor: b.anchor || null, at: Date.now(), answered: false }); persist(); flush(); return send(200, { ok: true }); }
      if (r === 'reply') { const m = state.chat.find((x) => x.id === b.id); if (m) m.answered = true; state.chat.push({ id: 'a' + (++state.seq), role: 'claude', text: String(b.text || ''), anchor: m ? m.anchor : null, replyTo: b.id, at: Date.now() }); persist(); lastWait = Date.now(); return send(200, { ok: true }); }
      if (r === 'submit') { const out = submit(b.event || 'COMMENT', b.body || ''); if (out.ok) { if (out.url) refreshPr(); state.submitted = { event: b.event || 'COMMENT', url: out.url || '', file: out.file || '', note: out.note || '', at: Date.now() }; state.finished = true; persist(); flush(); } return send(200, out); }
      if (r === 'finish') { state.finished = true; state.paused = !!b.paused; state.pausedReason = ''; persist(); flush(); return send(200, { ok: true }); }
      if (r === 'refresh-pr') return void refreshPr().then(() => send(200, { ok: true }));
      if (r === 'tickets') return send(200, loadTickets());
      if (r === 'reload') { data = readJSON(P('data.json'), data); return send(200, { ok: true }); }
      if (r === 'inbox') {
        const m = pending();
        if (state.finished) { state.finished = false; persist(); return send(200, { finished: true, paused: !!state.paused, submitted: state.submitted, comments: state.comments }); }
        if (m) { lastWait = Date.now(); return send(200, describe(m)); }
        const secs = Math.min(590, Math.max(1, +url.searchParams.get('timeout') || 540));
        const w = { send: (o) => { if (o.finished) { state.finished = false; persist(); } send(200, o); } };
        w.t = setTimeout(() => { waiters = waiters.filter((x) => x !== w); lastWait = Date.now(); send(200, { idle: true }); }, secs * 1000);
        res.on('close', () => { if (res.writableEnded) return; clearTimeout(w.t); waiters = waiters.filter((x) => x !== w); });
        waiters.push(w); return;
      }
      if (r === 'stop') { send(200, { ok: true }); return setTimeout(() => process.exit(0), 50); }
      send(404, { error: 'unknown route' });
    });
  });
  server.listen(0, '127.0.0.1', () => { writeJSON(P('server.json'), { pid: process.pid, port: server.address().port, token }); });
  setInterval(() => { if (Date.now() - lastActive > 8 * 3600 * 1000) process.exit(0); }, 60000).unref();
  setInterval(() => { if (idleLeft() === 0) { state.finished = true; state.paused = true; state.pausedReason = 'idle'; persist(); flush(); } }, 2000).unref();
  process.on('exit', () => attempt(() => fs.unlinkSync(P('server.json'))));
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => process.exit(0)));
}

async function waitCmd(secs) {
  const info = serverInfo() || die('the review server is not running. Run: start');
  const t = Math.min(590, Math.max(1, +secs || 540));
  const out = await api(info, 'GET', '/api/inbox?timeout=' + t, null, (t + 20) * 1000);
  if (out.idle) return console.log('IDLE: no question arrived. Run wait again to keep listening.');
  if (out.finished && out.paused) return console.log('PAUSED: the session was paused from the page (by the reviewer, or automatically after a period with no activity). Everything is saved. Run stop, stop looping, and tell them to run /review-code-in-context --resume when they are back.');
  if (out.finished) return console.log('FINISHED\n' + JSON.stringify(out, null, 2));
  const q = out.question, a = q.anchor || {};
  console.log('QUESTION ' + q.id + '\nAsked about: ' + (a.label || a.kind || 'the review in general') + (a.path ? '\nFile: ' + a.path + (a.line ? ' line ' + a.line + (a.side === 'LEFT' ? ' (removed line, old numbering)' : '') : '') : ''));
  if (q.changeNote) console.log('Change: ' + (q.changeNote.title || '') + (q.changeNote.note ? ' -- ' + q.changeNote.note : ''));
  if (q.entity) console.log('About: ' + JSON.stringify(q.entity));
  if (q.code) console.log('\nCode around it (> marks the line):\n' + q.code);
  if (q.existing && q.existing.length) console.log('\nAlready said on this line in the PR:\n' + q.existing.map((x) => ' - ' + x).join('\n'));
  console.log('\nThe reviewer wrote:\n' + q.text + '\n\nAnswer with: reply ' + q.id + '  (answer text on stdin), then run wait again.');
}
async function replyCmd(id) {
  const info = serverInfo() || die('the review server is not running.');
  const text = fs.readFileSync(0, 'utf8').trim();
  if (!id || !text) die('usage: reply <question id>  with the answer on stdin');
  await api(info, 'POST', '/api/reply', { id, text });
  console.log('Sent.');
}

function sessionsCmd() {
  const all = listSessions(), root = repoRoot();
  if (!all.length) return console.log('No review sessions yet.');
  all.forEach((m, i) => console.log((i + 1) + '. ' + m.id + '  started ' + ago(m.createdAt) + ', last used ' + ago(m.updatedAt) + (m.repoPath === root ? '  [this repository]' : '') +
    '\n   ' + m.repoName + ' · ' + m.branch + (m.prNumber ? ' · PR #' + m.prNumber : '') + (m.prTitle ? ' · ' + m.prTitle : '') +
    '\n   ' + (m.analysed ? (m.reviewed || 0) + ' of ' + m.files + ' files reviewed, ' + (m.comments || 0) + ' comments, ' + (m.messages || 0) + ' chat messages' : 'analysis not finished') + (m.submitted ? ' · review submitted (' + m.submitted + ')' : '') + (m.tickets && m.tickets.length ? '\n   tickets: ' + m.tickets.join(' > ') : '')));
}
async function resumeCmd(idArg, open) {
  const root = repoRoot();
  let id = idArg || SESSION_ARG;
  if (!id) { const mine = listSessions().filter((m) => m.repoPath === root); if (!mine.length) die('no sessions for this repository. Run: sessions'); id = mine[0].id; }
  useSession(id);
  const m = readJSON(P('meta.json'), {});
  if (m.repoPath) setPointer(m.repoPath, id);
  console.log('Resuming session ' + id + ': ' + m.repoName + ' · ' + m.branch + (m.prNumber ? ' · PR #' + m.prNumber : '') + ', started ' + ago(m.createdAt) + '.');
  if (m.repoPath && root !== m.repoPath) console.log('NOTE: this session belongs to ' + m.repoPath + '. Work from that folder when you answer questions about the code.');
  const sha = root === m.repoPath ? attempt(() => git('rev-parse', 'HEAD').trim(), '') : '';
  if (sha && m.sha && sha !== m.sha) console.log('WARNING: the branch has moved since this session started (' + m.sha.slice(0, 7) + ' -> ' + sha.slice(0, 7) + '). The review still shows the old commit. Start a new session to review the new commits.');
  if (!fs.existsSync(P('annotations.json'))) return console.log('The analysis was not finished. Read ' + P('skeleton.json') + ' (or run skeleton again for a fresh session), write ' + P('annotations.json') + ', then run build and start.');
  if (!fs.existsSync(P('data.json'))) build();
  await start(open);
  const st = readJSON(P('state.json'), {});
  const open2 = (st.chat || []).filter((x) => x.role === 'user' && !x.answered).length;
  console.log('State: ' + (m.reviewed || 0) + ' of ' + m.files + ' files reviewed, ' + (m.comments || 0) + ' draft comments, ' + (m.messages || 0) + ' chat messages' + (open2 ? ', ' + open2 + ' question(s) still unanswered' : '') + (m.submitted ? ', review already submitted (' + m.submitted + ')' : '') + '.');
  const rel = related(m);
  if (rel.length) console.log('Related sessions (they share a ticket): ' + rel.map((r) => r.id + ' (' + r.label + ', ' + r.shared.join(', ') + ')').join('; '));
  console.log('Your earlier analysis is in ' + P('annotations.json') + '. Read it before answering questions, then run wait.');
}
function historyCmd() {
  const st = readJSON(P('state.json'), {}), chat = st.chat || [], comments = st.comments || [];
  const where = (a) => !a ? 'the review in general' : (a.label || a.kind || '') + (a.path ? ' [' + a.path + (a.line ? ':' + a.line : '') + ']' : '');
  console.log('CONVERSATION SO FAR (' + chat.length + ' messages)');
  chat.forEach((m) => console.log('\n' + (m.role === 'user' ? 'REVIEWER' + (m.answered ? '' : ' (not answered yet)') + ', about ' + where(m.anchor) : 'CLAUDE') + ' · ' + ago(m.at) + '\n' + m.text));
  console.log('\nDRAFT REVIEW COMMENTS (' + comments.length + ')');
  comments.forEach((c) => console.log('- ' + c.path + ':' + c.line + (c.side === 'LEFT' ? ' (removed line)' : '') + ' · ' + c.body));
  const done = Object.keys(st.reviewed || {}).filter((k) => st.reviewed[k]);
  console.log('\nFILES MARKED REVIEWED (' + done.length + ')' + (done.length ? '\n- ' + done.join('\n- ') : ''));
}

function configCmd(sub, key, value) {
  const file = path.join(HOME_DIR, 'config.json'), cfg = readJSON(file, { repos: {} }), root = repoRoot() || 'global';
  cfg.repos = cfg.repos || {};
  if (sub === 'set' && key) { cfg.repos[root] = Object.assign({}, cfg.repos[root], { [key]: value || '' }); writeJSON(file, cfg); }
  console.log(JSON.stringify(cfg.repos[root] || {}, null, 2));
}

const [cmd, ...rest] = ARGV;
if (['build', 'start', 'serve', 'wait', 'reply', 'status', 'stop', 'comments', 'jira', 'tickets', 'history'].includes(cmd)) currentSession();

if (cmd === 'skeleton') skeleton(rest[0]);
else if (cmd === 'build') build();
else if (cmd === 'start') await start(!rest.includes('--no-open'));
else if (cmd === 'serve') serve();
else if (cmd === 'wait') await waitCmd(rest[0]);
else if (cmd === 'reply') await replyCmd(rest[0]);
else if (cmd === 'sessions') sessionsCmd();
else if (cmd === 'history') historyCmd();
else if (cmd === 'comments') await commentsCmd();
else if (cmd === 'jira') await jiraCmd(rest[0]);
else if (cmd === 'tickets') ticketsCmd(rest[0], rest.slice(1));
else if (cmd === 'resume') await resumeCmd(rest.filter((x) => x !== '--no-open')[0], !rest.includes('--no-open'));
else if (cmd === 'config') configCmd(rest[0], rest[1], rest.slice(2).join(' '));
else if (cmd === 'status') { const i = serverInfo(); console.log(i ? 'running at http://127.0.0.1:' + i.port + '/' : 'not running'); }
else if (cmd === 'stop') { const i = serverInfo(); if (i) await attempt(() => api(i, 'POST', '/api/stop'), null); console.log('stopped'); }
else die('commands: skeleton [base] | build | start [--no-open] | wait [seconds] | reply <id> | comments | jira <KEY> | tickets [set <keys...> | path <KEY>] | sessions | resume [id] | config get|set <key> <value> | status | stop   (add --session <id> to target one session)');
