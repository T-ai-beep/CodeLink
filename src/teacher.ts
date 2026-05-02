import crypto from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import QRCode from 'qrcode';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDb, getAllHubs, getFormByHubId, getFormWithFields,
  createForm, updateForm, deleteForm,
  getFormResponsesWithAnswers, getResponseCount,
  addFile, getFilesByHubId, getFileById, getFileByStoredName, deleteFile,
  getHubAccessStats, getLinkClickStats, getFormSubmissionRate,
  getHubAccessByDay, getSchoolWideStats, getTodayAccessCountByHub,
  getSchool, updateSchoolBranding, setSchoolBroadcast, clearSchoolBroadcast,
  getUserByEmail, getAllUsers, createUser, deleteUser,
  updateUserRole, touchUserLastActive, userExists,
  getHubCountByOwner, getAllHubsAdmin, getTodayAccessCount,
  logActivity, getRecentActivity,
  archiveHub, unarchiveHub, deleteHub,
} from './db';
import type { Hub, FormField, FieldType, NewFormField, HubFile, UserRole } from './db';

const TEACHER_PORT = process.env.TEACHER_PORT ? parseInt(process.env.TEACHER_PORT, 10) : 3001;
const UPLOAD_DIR = path.join(os.homedir(), '.lode', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── auth ─────────────────────────────────────────────────────────────────────

function hashPw(pw: string): string {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function genToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function genTempPw(): string {
  return crypto.randomBytes(6).toString('hex');
}

interface Session {
  userId: number;
  role: UserRole;
  name: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function createSession(userId: number, role: UserRole, name: string): string {
  const token = genToken();
  sessions.set(token, { userId, role, name, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}

function getSessionFromReq(req: express.Request): Session | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map((p) => p.trim()).find((p) => p.startsWith('session='));
  if (!match) return null;
  const token = decodeURIComponent(match.slice('session='.length));
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return s;
}

function setCookie(res: express.Response, token: string): void {
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
}

function clearCookie(res: express.Response): void {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  let db;
  try {
    db = getDb();
    if (!userExists(db)) { res.redirect(302, '/setup'); return; }
  } catch { /* fall through */ } finally { if (db) db.close(); }
  const s = getSessionFromReq(req);
  if (!s) { res.redirect(302, '/login'); return; }
  (req as any).sess = s;
  try {
    const d = getDb();
    touchUserLastActive(d, s.userId);
    d.close();
  } catch { /* non-critical */ }
  next();
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  let db;
  try {
    db = getDb();
    if (!userExists(db)) { res.redirect(302, '/setup'); return; }
  } catch { /* fall through */ } finally { if (db) db.close(); }
  const s = getSessionFromReq(req);
  if (!s) { res.redirect(302, '/login'); return; }
  if (s.role !== 'admin') { res.status(403).send(layout('Forbidden', '<p>Admin access required.</p>', s.role)); return; }
  (req as any).sess = s;
  next();
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toCsv(headers: string[], rows: string[][]): string {
  function escField(s: string): string {
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  return [headers, ...rows].map((r) => r.map(escField).join(',')).join('\r\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(mimetype: string): string {
  if (mimetype === 'application/pdf') return '[PDF]';
  if (mimetype.startsWith('image/')) return '[IMG]';
  if (mimetype.includes('word')) return '[DOC]';
  if (mimetype.includes('excel') || mimetype.includes('spreadsheet')) return '[XLS]';
  if (mimetype.includes('powerpoint') || mimetype.includes('presentation')) return '[PPT]';
  return '[FILE]';
}

const VALID_TYPES = new Set<string>([
  'short_text', 'long_text', 'multiple_choice', 'checkbox',
  'dropdown', 'date', 'name', 'email', 'number', 'phone',
]);

function parseFields(raw: unknown): NewFormField[] {
  if (!raw || typeof raw !== 'object') return [];
  const rec = raw as Record<string, { label?: string; type?: string; required?: string; options?: string }>;
  return Object.values(rec)
    .filter((f) => f.label && f.label.trim())
    .map((f, idx) => {
      const type = (VALID_TYPES.has(f.type ?? '') ? f.type : 'short_text') as FieldType;
      const hasOptions = type === 'multiple_choice' || type === 'checkbox' || type === 'dropdown';
      return {
        label: (f.label ?? '').trim(),
        type,
        required: f.required === '1',
        options: hasOptions && f.options ? f.options.split('\n').map((o) => o.trim()).filter(Boolean) : null,
        order_index: idx,
      };
    });
}

// ─── file upload ──────────────────────────────────────────────────────────────

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIMETYPES.has(file.mimetype) ? cb(null, true) : cb(new Error('File type not allowed'));
  },
});

// ─── layout & CSS ─────────────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; color: #111; display: flex; min-height: 100vh; }
  .sidebar { width: 220px; min-height: 100vh; background: #111; position: fixed; left: 0; top: 0; display: flex; flex-direction: column; }
  .sidebar-brand { padding: 20px; font-size: 1.05rem; font-weight: 800; color: #fff; border-bottom: 1px solid #2a2a2a; line-height: 1.3; }
  .sidebar-brand span { display: block; font-size: 0.72rem; font-weight: 400; color: #9ca3af; margin-top: 3px; }
  .sidebar-nav a { display: block; padding: 10px 20px; color: #d1d5db; text-decoration: none; font-size: 0.87rem; }
  .sidebar-nav a:hover, .sidebar-nav a.active { color: #fff; background: #1f1f1f; }
  .main { margin-left: 220px; padding: 32px; flex: 1; max-width: 1000px; }
  h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 22px; }
  h2 { font-size: 1.05rem; font-weight: 600; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
  th { background: #f3f4f6; text-align: left; padding: 10px 16px; font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  td { padding: 11px 16px; border-top: 1px solid #f3f4f6; font-size: .88rem; }
  tr:hover td { background: #fafafa; }
  .btn { display: inline-block; padding: 7px 13px; border-radius: 6px; font-size: .84rem; font-weight: 500; text-decoration: none; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
  .btn-primary { background: #111; color: #fff; }
  .btn-secondary { background: #f3f4f6; color: #111; border-color: #e5e7eb; }
  .btn-danger { background: #fee2e2; color: #b91c1c; }
  .btn + .btn { margin-left: 6px; }
  .card { background: #fff; border-radius: 8px; padding: 22px; box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: 20px; }
  label.lbl { display: block; font-size: .84rem; font-weight: 500; margin-bottom: 5px; color: #374151; }
  input[type="text"], textarea, select { display: block; width: 100%; padding: 9px 11px; border: 1px solid #d1d5db; border-radius: 6px; font-size: .9rem; font-family: inherit; color: #111; margin-bottom: 14px; }
  input[type="text"]:focus, textarea:focus, select:focus { outline: none; border-color: #111; }
  textarea { resize: vertical; }
  .field-row { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; margin-bottom: 10px; background: #fff; }
  .frow-header { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
  .frow-header input[type="text"] { margin-bottom: 0; flex: 1; min-width: 120px; }
  .frow-header select { margin-bottom: 0; width: auto; }
  .chk-lbl { display: flex; align-items: center; gap: 4px; white-space: nowrap; font-size: .84rem; margin: 0; padding-top: 9px; }
  .opts-area { margin-top: 10px; }
  .opts-area label { display: block; font-size: .8rem; font-weight: 500; margin-bottom: 4px; color: #374151; }
  .opts-area textarea { margin-bottom: 0; font-size: .84rem; }
  .back-link { color: #6b7280; text-decoration: none; font-size: .84rem; display: inline-block; margin-bottom: 16px; }
  .back-link:hover { color: #111; }
  .abar { display: flex; gap: 8px; align-items: center; margin-bottom: 18px; }
  .spacer { flex: 1; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: .74rem; font-weight: 500; }
  .badge-green { background: #d1fae5; color: #065f46; }
  .badge-grey { background: #f3f4f6; color: #6b7280; }
  .muted { color: #9ca3af; font-size: .85rem; }
  .mt2 { margin-top: 8px; }
  .mt3 { margin-top: 12px; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: .84rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; margin-bottom: 20px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: #fff; border-radius: 8px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,.07); }
  .stat-val { font-size: 2rem; font-weight: 800; color: #111; line-height: 1; margin-bottom: 6px; }
  .stat-lbl { font-size: .78rem; color: #9ca3af; text-transform: uppercase; letter-spacing: .04em; }
  .chart-outer { height: 140px; display: flex; align-items: flex-end; gap: 6px; padding: 8px 0 0; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; }
  .bar-track { flex: 1; width: 100%; background: #f3f4f6; border-radius: 4px 4px 0 0; display: flex; align-items: flex-end; }
  .bar-fill { width: 100%; background: #111; border-radius: 4px 4px 0 0; min-height: 2px; }
  .bar-n { font-size: .68rem; color: #6b7280; }
  .bar-lbl { font-size: .7rem; color: #9ca3af; }
  .dev-row { display: flex; gap: 20px; flex-wrap: wrap; }
  .dev-item { text-align: center; }
  .dev-val { font-size: 1.4rem; font-weight: 700; color: #111; }
  .dev-lbl { font-size: .78rem; color: #9ca3af; margin-top: 2px; }
  .activity-item { padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: .86rem; display: flex; justify-content: space-between; gap: 8px; }
  .activity-item:last-child { border-bottom: none; }
  .ts { color: #9ca3af; font-size: .78rem; white-space: nowrap; }
  .alert { padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; font-size: .88rem; }
  .alert-success { background: #d1fae5; color: #065f46; }
  .alert-error { background: #fee2e2; color: #b91c1c; }
  .pw-box { background: #f3f4f6; border-radius: 6px; padding: 12px 16px; font-family: monospace; font-size: 1rem; letter-spacing: .06em; margin: 12px 0; }
  input[type="color"] { padding: 2px 4px; height: 36px; width: 60px; border-radius: 6px; border: 1px solid #d1d5db; cursor: pointer; vertical-align: middle; }
  .color-row { display: flex; align-items: center; gap: 10px; }
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f9fafb; width: 100%; }
  .login-box { background: #fff; border-radius: 10px; padding: 36px; width: 100%; max-width: 380px; box-shadow: 0 2px 12px rgba(0,0,0,.1); }
  .login-box h1 { margin-bottom: 24px; }
`;

function layout(title: string, content: string, role?: string): string {
  const isAdmin = role === 'admin';
  const nav = [
    `<a href="/" ${title === 'Hubs' ? 'class="active"' : ''}>My Hubs</a>`,
    `<a href="/analytics" ${title === 'Analytics' ? 'class="active"' : ''}>School Analytics</a>`,
    isAdmin ? `<a href="/admin" ${title.startsWith('Admin') ? 'class="active"' : ''}>Admin</a>` : '',
    `<a href="/account" ${title === 'Account' ? 'class="active"' : ''}>Account</a>`,
    `<a href="/logout">Logout</a>`,
  ].filter(Boolean).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Lode</title>
  <style>${CSS}</style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-brand">Lode<span>Teacher Dashboard</span></div>
    <nav class="sidebar-nav">
      ${nav}
    </nav>
  </aside>
  <main class="main">${content}</main>
</body>
</html>`;
}

function loginPage(errorMsg = ''): string {
  const errHtml = errorMsg ? `<div class="alert alert-error">${esc(errorMsg)}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Login — Lode</title><style>${CSS}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}</style></head>
    <body><div class="login-wrap"><div class="login-box">
      <h1>Lode</h1>${errHtml}
      <form method="POST" action="/login">
        <label class="lbl">Email</label>
        <input type="text" name="email" required autocomplete="username">
        <label class="lbl">Password</label>
        <input type="password" name="password" required autocomplete="current-password">
        <button type="submit" class="btn btn-primary" style="width:100%;padding:10px;margin-top:8px">Sign In</button>
      </form>
    </div></div></body></html>`;
}

// ─── field preview ────────────────────────────────────────────────────────────

function renderFieldPreview(fields: FormField[]): string {
  const icons: Record<string, string> = {
    short_text: '—', long_text: '≡', multiple_choice: '◉', checkbox: '☑',
    dropdown: '▾', date: '◻', name: 'Aa', email: '@', number: '#', phone: '℡',
  };
  return fields.map((f) => {
    const opts = f.options ? (JSON.parse(f.options) as string[]) : [];
    return `<div class="field-row" style="padding:10px 14px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="color:#9ca3af">${icons[f.type] ?? '?'}</span>
        <span style="font-size:.88rem;font-weight:500">${esc(f.label)}</span>
        ${f.required ? '<span class="badge badge-green">Required</span>' : ''}
        <span class="badge badge-grey" style="margin-left:auto">${f.type.replace(/_/g, ' ')}</span>
      </div>
      ${opts.length > 0
        ? `<div style="margin-top:5px;padding-left:20px;font-size:.78rem;color:#6b7280">${opts.map(esc).join(' &nbsp;·&nbsp; ')}</div>`
        : ''}
    </div>`;
  }).join('\n');
}

// ─── form builder ─────────────────────────────────────────────────────────────

function formBuilderPage(
  hubId: number,
  hubLabel: string,
  action: string,
  pageTitle: string,
  initTitle = '',
  initDesc = '',
  initFields: FormField[] = [],
  role?: string
): string {
  const allTypes = ['short_text', 'long_text', 'multiple_choice', 'checkbox', 'dropdown', 'date', 'name', 'email', 'number', 'phone'];

  const fieldRows = initFields.map((f, idx) => {
    const opts = f.options ? (JSON.parse(f.options) as string[]).join('\n') : '';
    const showOpts = f.type === 'multiple_choice' || f.type === 'checkbox' || f.type === 'dropdown' ? '' : 'display:none';
    const typeOpts = allTypes.map((t) => `<option value="${t}"${t === f.type ? ' selected' : ''}>${t.replace(/_/g, ' ')}</option>`).join('');
    return `<div class="field-row" id="field-${idx}" data-idx="${idx}">
      <div class="frow-header">
        <input type="text" name="fields[${idx}][label]" placeholder="Field label" value="${esc(f.label)}" required>
        <select name="fields[${idx}][type]" onchange="onTypeChange(this,${idx})">${typeOpts}</select>
        <label class="chk-lbl"><input type="checkbox" name="fields[${idx}][required]" value="1"${f.required ? ' checked' : ''}> Required</label>
        <button type="button" class="btn btn-danger" onclick="removeField(${idx})">&#x2715;</button>
        <button type="button" class="btn btn-secondary" onclick="moveUp(${idx})">&#x2191;</button>
        <button type="button" class="btn btn-secondary" onclick="moveDown(${idx})">&#x2193;</button>
      </div>
      <div class="opts-area" id="opts-${idx}" style="${showOpts}">
        <label>Options (one per line)</label>
        <textarea name="fields[${idx}][options]" rows="4">${esc(opts)}</textarea>
      </div>
    </div>`;
  }).join('\n');

  const content = `
    <a href="/hubs/${hubId}/forms" class="back-link">&#x2190; Back</a>
    <h1>${esc(pageTitle)} &mdash; ${esc(hubLabel)}</h1>
    <form id="form-builder" method="POST" action="${esc(action)}">
      <div class="card">
        <h2>Details</h2>
        <label class="lbl">Title *</label>
        <input type="text" name="title" value="${esc(initTitle)}" required>
        <label class="lbl">Description</label>
        <textarea name="description" rows="3">${esc(initDesc)}</textarea>
      </div>
      <div class="card">
        <h2>Fields</h2>
        <div id="fields-container">${fieldRows}</div>
        <button type="button" class="btn btn-secondary mt3" onclick="addField()">+ Add Field</button>
      </div>
      <button type="submit" class="btn btn-primary">Save Form</button>
    </form>
    <script>
    var fieldCount = ${initFields.length};
    var allTypes = ${JSON.stringify(allTypes)};

    function buildFieldRow(idx, label, type, required, options) {
      var typeOpts = allTypes.map(function(t) {
        return '<option value="' + t + '"' + (t === type ? ' selected' : '') + '>' + t.replace(/_/g,' ') + '</option>';
      }).join('');
      var showOpts = (type === 'multiple_choice' || type === 'checkbox' || type === 'dropdown') ? '' : 'display:none';
      return '<div class="frow-header">' +
        '<input type="text" name="fields[' + idx + '][label]" placeholder="Field label" value="' + label + '" required>' +
        '<select name="fields[' + idx + '][type]" onchange="onTypeChange(this,' + idx + ')">' + typeOpts + '</select>' +
        '<label class="chk-lbl"><input type="checkbox" name="fields[' + idx + '][required]" value="1"' + (required ? ' checked' : '') + '> Required</label>' +
        '<button type="button" class="btn btn-danger" onclick="removeField(' + idx + ')">&#x2715;</button>' +
        '<button type="button" class="btn btn-secondary" onclick="moveUp(' + idx + ')">&#x2191;</button>' +
        '<button type="button" class="btn btn-secondary" onclick="moveDown(' + idx + ')">&#x2193;</button>' +
        '</div>' +
        '<div class="opts-area" id="opts-' + idx + '" style="' + showOpts + '">' +
        '<label>Options (one per line)</label>' +
        '<textarea name="fields[' + idx + '][options]" rows="4">' + options + '</textarea>' +
        '</div>';
    }

    function addField() {
      var container = document.getElementById('fields-container');
      var idx = fieldCount++;
      var div = document.createElement('div');
      div.className = 'field-row';
      div.id = 'field-' + idx;
      div.dataset.idx = String(idx);
      div.innerHTML = buildFieldRow(idx, '', 'short_text', false, '');
      container.appendChild(div);
    }

    function removeField(idx) { var el = document.getElementById('field-' + idx); if (el) el.remove(); }
    function moveUp(idx) { var el = document.getElementById('field-' + idx); if (el && el.previousElementSibling) el.parentNode.insertBefore(el, el.previousElementSibling); }
    function moveDown(idx) { var el = document.getElementById('field-' + idx); if (el && el.nextElementSibling) el.parentNode.insertBefore(el.nextElementSibling, el); }

    function onTypeChange(sel, idx) {
      var d = document.getElementById('opts-' + idx);
      d.style.display = (sel.value === 'multiple_choice' || sel.value === 'checkbox' || sel.value === 'dropdown') ? '' : 'none';
    }

    document.getElementById('form-builder').addEventListener('submit', function() {
      var rows = document.getElementById('fields-container').querySelectorAll('.field-row');
      rows.forEach(function(row, newIdx) {
        var oldIdx = row.dataset.idx;
        row.querySelectorAll('[name]').forEach(function(el) {
          el.name = el.name.replace('fields[' + oldIdx + ']', 'fields[' + newIdx + ']');
        });
        var optsEl = document.getElementById('opts-' + oldIdx);
        if (optsEl) optsEl.id = 'opts-' + newIdx;
        row.id = 'field-' + newIdx;
        row.dataset.idx = String(newIdx);
      });
    });
    </script>`;

  return layout(pageTitle, content, role);
}

// ─── QR helpers ───────────────────────────────────────────────────────────────

function renderPrintSheet(hub: Hub, svgString: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(hub.code)} — Lode QR</title>
  <style>
    @page { margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 48px; text-align: center; }
    .qr-wrap { width: 280px; margin-bottom: 28px; }
    .qr-wrap svg { width: 100%; height: auto; display: block; }
    .hub-label { font-size: 1.5rem; font-weight: 700; color: #111; margin-bottom: 8px; }
    .domain { font-size: 1rem; color: #888; margin-bottom: 14px; }
    .hub-code { font-size: 3rem; font-weight: 800; letter-spacing: 0.12em; color: #111; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="qr-wrap">${svgString}</div>
  <div class="hub-label">${esc(hub.label)}</div>
  <div class="domain">getlode.xyz</div>
  <div class="hub-code">${esc(hub.code)}</div>
</body>
</html>`;
}

// ─── setup / login / logout ───────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  let db;
  try {
    db = getDb();
    if (userExists(db)) { res.redirect(302, '/login'); return; }
    const school = getSchool(db);
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Lode Setup</title><style>${CSS}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}</style></head>
      <body><div class="login-wrap"><div class="login-box" style="max-width:420px">
        <h1 style="margin-bottom:6px">Lode Setup</h1>
        <p style="color:#6b7280;font-size:.88rem;margin-bottom:24px">Create the first admin account.</p>
        <form method="POST" action="/setup">
          <label class="lbl">School Name</label>
          <input type="text" name="school_name" value="${esc(school?.name ?? 'My School')}" required>
          <label class="lbl">Admin Name</label>
          <input type="text" name="name" required>
          <label class="lbl">Admin Email</label>
          <input type="text" name="email" required>
          <label class="lbl">Password</label>
          <input type="text" name="password" required>
          <button type="submit" class="btn btn-primary" style="width:100%;padding:10px;margin-top:8px">Create Admin &amp; Continue</button>
        </form>
      </div></div></body></html>`);
  } catch (err) {
    res.status(500).send(String(err));
  } finally {
    if (db) db.close();
  }
});

app.post('/setup', (req, res) => {
  let db;
  try {
    db = getDb();
    if (userExists(db)) { res.redirect(302, '/login'); return; }
    const schoolName = (req.body.school_name as string || '').trim() || 'My School';
    const name = (req.body.name as string || '').trim();
    const email = (req.body.email as string || '').trim();
    const password = (req.body.password as string || '').trim();
    if (!name || !email || !password) { res.redirect(302, '/setup'); return; }
    updateSchoolBranding(db, schoolName, '#111111');
    const school = getSchool(db);
    const user = createUser(db, school.id, name, email, hashPw(password), 'admin');
    const token = createSession(user.id, 'admin', user.name);
    setCookie(res, token);
    res.redirect(302, '/');
  } catch (err) {
    res.status(500).send(String(err));
  } finally {
    if (db) db.close();
  }
});

app.get('/login', (req, res) => {
  const s = getSessionFromReq(req);
  if (s) { res.redirect(302, '/'); return; }
  const err = req.query.error === '1' ? 'Invalid email or password.' : '';
  res.send(loginPage(err));
});

app.post('/login', (req, res) => {
  let db;
  try {
    db = getDb();
    const email = (req.body.email as string || '').trim();
    const password = (req.body.password as string || '').trim();
    const user = getUserByEmail(db, email);
    if (!user || user.password !== hashPw(password)) { res.redirect(302, '/login?error=1'); return; }
    const token = createSession(user.id, user.role as UserRole, user.name);
    setCookie(res, token);
    res.redirect(302, '/');
  } catch (err) {
    res.status(500).send(String(err));
  } finally {
    if (db) db.close();
  }
});

app.get('/logout', (_req, res) => { clearCookie(res); res.redirect(302, '/login'); });

// ─── hubs list ────────────────────────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubs = getAllHubs(db);
    const rows = hubs.map((hub) => {
      const form = getFormByHubId(db!, hub.id);
      const count = form ? getResponseCount(db!, form.id) : 0;
      const badge = form
        ? `<span class="badge badge-green">Form &nbsp; ${count} resp.</span>`
        : '<span class="badge badge-grey">No form</span>';
      const archivedBadge = hub.archived ? ' <span class="badge badge-grey">Archived</span>' : '';
      return `<tr>
        <td><code>${esc(hub.code)}</code></td>
        <td>${esc(hub.label)}${archivedBadge}</td>
        <td>${badge}</td>
        <td>
          <a href="/hubs/${hub.id}/forms" class="btn btn-secondary">Manage</a>
          <a href="/hubs/${hub.id}/analytics" class="btn btn-secondary">Analytics</a>
        </td>
      </tr>`;
    }).join('');
    const empty = '<tr><td colspan="4" style="text-align:center;padding:28px;color:#9ca3af">No hubs yet. Use the CLI to create one.</td></tr>';
    res.send(layout('Hubs', `<h1>Hubs</h1>
      <table>
        <thead><tr><th>Code</th><th>Label</th><th>Form</th><th>Actions</th></tr></thead>
        <tbody>${rows || empty}</tbody>
      </table>`, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

// ─── hub manage (forms + files + QR) ─────────────────────────────────────────

app.get('/hubs/:hubId/forms', requireAuth, async (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', role)); return; }

    const form = getFormByHubId(db, hubId);
    const files = getFilesByHubId(db, hubId);
    const qrUrl = `https://getlode.xyz/c/${hub.code}`;
    const qrSvg = await QRCode.toString(qrUrl, { type: 'svg' });

    let body = `<a href="/" class="back-link">&#x2190; Back to Hubs</a>
      <h1>${esc(hub.code)} &mdash; ${esc(hub.label)}</h1>
      <div class="card">
        <h2>QR Code</h2>
        <p class="muted" style="margin-bottom:16px">Scans to <code>https://getlode.xyz/c/${esc(hub.code)}</code></p>
        <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
          <div style="width:180px;flex-shrink:0">${qrSvg}</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <a href="/hubs/${hubId}/qr/download" class="btn btn-secondary">Download QR</a>
            <a href="/hubs/${hubId}/qr/print" class="btn btn-secondary" target="_blank">Print Sheet</a>
          </div>
        </div>
      </div>`;

    if (!form) {
      body += `<div class="card">
        <h2>Form</h2>
        <p class="muted" style="margin-bottom:14px">No form attached to this hub.</p>
        <a href="/hubs/${hubId}/forms/new" class="btn btn-primary">+ Create Form</a>
      </div>`;
    } else {
      const fw = getFormWithFields(db, form.id);
      const count = getResponseCount(db, form.id);
      body += `<div class="card">
        <div class="abar">
          <div>
            <strong>${esc(form.title)}</strong>
            ${form.description ? `<p class="muted mt2">${esc(form.description)}</p>` : ''}
          </div>
          <div class="spacer"></div>
          <a href="/hubs/${hubId}/forms/${form.id}/edit" class="btn btn-secondary">Edit</a>
          <a href="/hubs/${hubId}/forms/${form.id}/responses" class="btn btn-secondary">Responses (${count})</a>
          <form method="POST" action="/hubs/${hubId}/forms/${form.id}/delete" style="display:inline" onsubmit="return confirm('Delete this form and all responses?')">
            <button type="submit" class="btn btn-danger">Delete</button>
          </form>
        </div>
        ${fw && fw.fields.length > 0
          ? `<h2 style="margin-top:14px">Fields (${fw.fields.length})</h2>${renderFieldPreview(fw.fields)}`
          : '<p class="muted">No fields defined.</p>'}
      </div>`;
    }

    const fileRows = files.map((f: HubFile) => `<tr>
      <td>${esc(f.filename)}</td>
      <td>${formatSize(f.size)}</td>
      <td style="font-family:monospace;font-size:.78rem">${esc(f.mimetype)}</td>
      <td class="muted">${esc(f.created_at)}</td>
      <td>
        <a href="/files/${esc(f.stored_name)}" class="btn btn-secondary">Download</a>
        <form method="POST" action="/hubs/${hubId}/files/${f.id}/delete" style="display:inline">
          <button type="submit" class="btn btn-danger">Delete</button>
        </form>
      </td>
    </tr>`).join('');

    body += `<div class="card">
      <div class="abar" style="margin-bottom:12px">
        <h2 style="margin:0">Files (${files.length})</h2>
      </div>
      ${files.length > 0
        ? `<table><thead><tr><th>Name</th><th>Size</th><th>Type</th><th>Uploaded</th><th></th></tr></thead><tbody>${fileRows}</tbody></table>`
        : '<p class="muted" style="margin-bottom:12px">No files uploaded.</p>'}
      <form method="POST" action="/hubs/${hubId}/files" enctype="multipart/form-data" style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx" style="font-size:.84rem;flex:1;min-width:200px">
        <button type="submit" class="btn btn-primary">Upload File</button>
      </form>
    </div>`;

    res.send(layout('Hub', body, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

// ─── form CRUD ────────────────────────────────────────────────────────────────

app.get('/hubs/:hubId/forms/new', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', role)); return; }
    res.send(formBuilderPage(hubId, hub.label, `/hubs/${hubId}/forms`, 'Create Form', '', '', [], role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.post('/hubs/:hubId/forms', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const title = (req.body.title as string || '').trim();
    if (!title) { res.redirect(302, `/hubs/${hubId}/forms/new`); return; }
    const description = (req.body.description as string || '').trim() || null;
    createForm(db, hubId, title, description, parseFields(req.body.fields));
    res.redirect(302, `/hubs/${hubId}/forms`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/:id/edit', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', role)); return; }
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send(layout('Not Found', '<p>Form not found.</p>', role)); return; }
    res.send(formBuilderPage(hubId, hub.label, `/hubs/${hubId}/forms/${formId}`, 'Edit Form', fw.title, fw.description ?? '', fw.fields, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.post('/hubs/:hubId/forms/:id', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const title = (req.body.title as string || '').trim();
    if (!title) { res.redirect(302, `/hubs/${hubId}/forms/${formId}/edit`); return; }
    const description = (req.body.description as string || '').trim() || null;
    updateForm(db, formId, title, description, parseFields(req.body.fields));
    res.redirect(302, `/hubs/${hubId}/forms`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.post('/hubs/:hubId/forms/:id/delete', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    deleteForm(db, parseInt(req.params.id, 10));
    res.redirect(302, `/hubs/${req.params.hubId}/forms`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/:id/responses', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send(layout('Not Found', '<p>Form not found.</p>', role)); return; }
    const responses = getFormResponsesWithAnswers(db, formId);
    const thCols = fw.fields.map((f) => `<th>${esc(f.label)}</th>`).join('');
    const bodyRows = responses.map((r, idx) => {
      const am = new Map(r.answers.map((a) => [a.field_id, a.value]));
      const cells = fw.fields.map((f) => `<td>${esc(am.get(f.id) ?? '')}</td>`).join('');
      return `<tr><td>${idx + 1}</td><td>${esc(r.submitted_at)}</td>${cells}</tr>`;
    }).join('');
    const body = `
      <a href="/hubs/${hubId}/forms" class="back-link">&#x2190; Back to Form</a>
      <div class="abar">
        <h1 style="margin:0">${esc(fw.title)} &mdash; Responses</h1>
        <div class="spacer"></div>
        <a href="/hubs/${hubId}/forms/${formId}/responses/export" class="btn btn-secondary">Export CSV</a>
      </div>
      ${responses.length === 0
        ? '<p class="muted">No responses yet.</p>'
        : `<table><thead><tr><th>#</th><th>Submitted At</th>${thCols}</tr></thead><tbody>${bodyRows}</tbody></table>`}`;
    res.send(layout('Responses', body, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/:id/responses/export', requireAuth, (req, res) => {
  let db;
  try {
    db = getDb();
    const formId = parseInt(req.params.id, 10);
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send('Form not found'); return; }
    const responses = getFormResponsesWithAnswers(db, formId);
    const headers = ['Response #', 'Submitted At', ...fw.fields.map((f) => f.label)];
    const rows = responses.map((r, idx) => {
      const am = new Map(r.answers.map((a) => [a.field_id, a.value]));
      return [String(idx + 1), r.submitted_at, ...fw.fields.map((f) => am.get(f.id) ?? '')];
    });
    const slug = fw.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-responses.csv"`);
    res.send(toCsv(headers, rows));
  } catch (err) {
    res.status(500).send('Error: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

// ─── per-hub analytics ────────────────────────────────────────────────────────

app.get('/hubs/:hubId/analytics', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', role)); return; }

    const stats = getHubAccessStats(db, hubId);
    const clickStats = getLinkClickStats(db, hubId);
    const submissionRate = getFormSubmissionRate(db, hubId);
    const byDay = getHubAccessByDay(db, hubId);

    const days: Array<{ label: string; date: string; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const label = d.toLocaleDateString('en-US', { weekday: 'short' });
      days.push({ label, date: dateStr, count: 0 });
    }
    for (const row of byDay) {
      const d = days.find((x) => x.date === row.date);
      if (d) d.count = row.count;
    }
    const maxCount = Math.max(...days.map((d) => d.count), 1);

    const bars = days.map((d) => {
      const pct = Math.round((d.count / maxCount) * 100);
      return `<div class="bar-col">
        <div class="bar-n">${d.count || ''}</div>
        <div class="bar-track"><div class="bar-fill" style="height:${pct}%"></div></div>
        <div class="bar-lbl">${d.label}</div>
      </div>`;
    }).join('');

    const total = stats.total_accesses || 1;
    const clickRows = clickStats.map((c) => {
      const rate = Math.round((c.clicks / total) * 100);
      return `<tr>
        <td>${esc(c.title)}</td>
        <td style="font-size:.78rem;color:#6b7280;max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(c.url)}</td>
        <td><strong>${c.clicks}</strong></td>
        <td>${rate}%</td>
      </tr>`;
    }).join('');

    const dev = stats.device_breakdown;
    const devTotal = dev.mobile + dev.desktop + dev.unknown || 1;
    const peakLabel = `${stats.peak_hour}:00–${stats.peak_hour + 1}:00`;

    const body = `
      <a href="/hubs/${hubId}/forms" class="back-link">&#x2190; Back to Hub</a>
      <h1>Analytics &mdash; ${esc(hub.code)}</h1>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${stats.accesses_today}</div><div class="stat-lbl">Today</div></div>
        <div class="stat-card"><div class="stat-val">${stats.accesses_last_10_min}</div><div class="stat-lbl">Last 10 Min</div></div>
        <div class="stat-card"><div class="stat-val">${stats.total_accesses}</div><div class="stat-lbl">All Time</div></div>
        <div class="stat-card"><div class="stat-val">${submissionRate}%</div><div class="stat-lbl">Submission Rate</div></div>
      </div>
      <div class="card">
        <h2>Link Performance</h2>
        ${clickStats.length > 0
          ? `<table><thead><tr><th>Link</th><th>URL</th><th>Clicks</th><th>Rate</th></tr></thead><tbody>${clickRows}</tbody></table>`
          : '<p class="muted">No link clicks recorded yet.</p>'}
      </div>
      <div class="card">
        <h2>Accesses — Last 7 Days</h2>
        <div class="chart-outer">${bars}</div>
      </div>
      <div class="card">
        <h2>Device Breakdown</h2>
        <div class="dev-row">
          <div class="dev-item"><div class="dev-val">${dev.mobile} <span style="font-size:1rem;color:#9ca3af">(${Math.round(dev.mobile/devTotal*100)}%)</span></div><div class="dev-lbl">Mobile</div></div>
          <div class="dev-item"><div class="dev-val">${dev.desktop} <span style="font-size:1rem;color:#9ca3af">(${Math.round(dev.desktop/devTotal*100)}%)</span></div><div class="dev-lbl">Desktop</div></div>
          <div class="dev-item"><div class="dev-val">${dev.unknown} <span style="font-size:1rem;color:#9ca3af">(${Math.round(dev.unknown/devTotal*100)}%)</span></div><div class="dev-lbl">Unknown</div></div>
          <div class="dev-item" style="margin-left:auto"><div class="dev-val">${peakLabel}</div><div class="dev-lbl">Peak Hour</div></div>
        </div>
      </div>`;

    res.send(layout('Analytics', body, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

// ─── school analytics ─────────────────────────────────────────────────────────

app.get('/analytics', requireAuth, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const s = getSchoolWideStats(db);

    const hubRows = s.hub_table.map((h, i) => `<tr>
      <td>${i + 1}</td>
      <td><code>${esc(h.code)}</code></td>
      <td>${esc(h.label)}</td>
      <td><strong>${h.accesses_today}</strong></td>
      <td>${h.total_accesses}</td>
    </tr>`).join('');

    const teacherRows = s.teacher_leaderboard.map((t, i) => `<tr>
      <td>${i + 1}</td>
      <td>${esc(t.name)}</td>
      <td><strong>${t.accesses_today}</strong></td>
    </tr>`).join('');

    const body = `
      <h1>School Analytics</h1>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${s.total_hubs}</div><div class="stat-lbl">Total Hubs</div></div>
        <div class="stat-card"><div class="stat-val">${s.accesses_today}</div><div class="stat-lbl">Accesses Today</div></div>
        <div class="stat-card"><div class="stat-val">${s.form_submissions_today}</div><div class="stat-lbl">Submissions Today</div></div>
        ${s.most_accessed_hub_today
          ? `<div class="stat-card"><div class="stat-val">${esc(s.most_accessed_hub_today.code)}</div><div class="stat-lbl">Top Hub Today (${s.most_accessed_hub_today.count} visits)</div></div>`
          : '<div class="stat-card"><div class="stat-val muted">—</div><div class="stat-lbl">Top Hub Today</div></div>'}
      </div>
      <div class="card">
        <h2>All Hubs</h2>
        ${s.hub_table.length > 0
          ? `<table><thead><tr><th>#</th><th>Code</th><th>Label</th><th>Today</th><th>All Time</th></tr></thead><tbody>${hubRows}</tbody></table>`
          : '<p class="muted">No hub data yet.</p>'}
      </div>
      <div class="card">
        <h2>Teacher Leaderboard — Today</h2>
        ${s.teacher_leaderboard.length > 0
          ? `<table><thead><tr><th>#</th><th>Teacher</th><th>Hub Accesses Today</th></tr></thead><tbody>${teacherRows}</tbody></table>`
          : '<p class="muted">No data yet.</p>'}
      </div>`;

    res.send(layout('Analytics', body, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

// ─── QR routes ────────────────────────────────────────────────────────────────

app.get('/hubs/:hubId/qr/download', requireAuth, async (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send('Hub not found.'); return; }
    const buf = await QRCode.toBuffer(`https://getlode.xyz/c/${hub.code}`, { type: 'png', width: 600 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="lode-${hub.code.toLowerCase()}-qr.png"`);
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error generating QR code: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/qr/print', requireAuth, async (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send('Hub not found.'); return; }
    const svg = await QRCode.toString(`https://getlode.xyz/c/${hub.code}`, { type: 'svg' });
    res.send(renderPrintSheet(hub, svg));
  } catch (err) {
    res.status(500).send('Error generating print sheet: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

// ─── file routes ──────────────────────────────────────────────────────────────

app.post('/hubs/:hubId/files', requireAuth, (req, res) => {
  const sess = (req as any).sess as Session;
  const hubId = parseInt(req.params.hubId, 10);
  upload.single('file')(req, res, (err) => {
    if (err || !req.file) { res.redirect(302, `/hubs/${hubId}/forms`); return; }
    let db;
    try {
      db = getDb();
      addFile(db, hubId, sess.userId, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);
      res.redirect(302, `/hubs/${hubId}/forms`);
    } catch {
      fs.unlink(req.file!.path, () => {});
      res.redirect(302, `/hubs/${hubId}/forms`);
    } finally {
      if (db) db.close();
    }
  });
});

app.post('/hubs/:hubId/files/:fileId/delete', requireAuth, (req, res) => {
  const hubId = parseInt(req.params.hubId, 10);
  const fileId = parseInt(req.params.fileId, 10);
  let db;
  try {
    db = getDb();
    const file = getFileById(db, fileId);
    if (file) {
      fs.unlink(path.join(UPLOAD_DIR, file.stored_name), () => {});
      deleteFile(db, fileId);
    }
    res.redirect(302, `/hubs/${hubId}/forms`);
  } catch {
    res.redirect(302, `/hubs/${hubId}/forms`);
  } finally {
    if (db) db.close();
  }
});

app.get('/files/:storedName', requireAuth, (req, res) => {
  let db;
  try {
    db = getDb();
    const file = getFileByStoredName(db, req.params.storedName);
    if (!file) { res.status(404).send('File not found.'); return; }
    const filePath = path.join(UPLOAD_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) { res.status(404).send('File not found.'); return; }
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '_')}"`);
    res.sendFile(filePath);
  } catch {
    res.status(500).send('Error serving file.');
  } finally {
    if (db) db.close();
  }
});

// ─── account ──────────────────────────────────────────────────────────────────

app.get('/account', requireAuth, (req, res) => {
  const sess = (req as any).sess as Session;
  res.send(layout('Account', `
    <h1>Account</h1>
    <div class="card" style="max-width:400px">
      <p class="muted" style="margin-bottom:6px">Signed in as</p>
      <p style="font-weight:600;font-size:1.05rem">${esc(sess.name)}</p>
      <p class="muted" style="margin-top:4px;text-transform:uppercase;font-size:.78rem;letter-spacing:.04em">${esc(sess.role)}</p>
      <div style="margin-top:20px">
        <a href="/logout" class="btn btn-secondary">Sign Out</a>
      </div>
    </div>`, sess.role));
});

// ─── admin: dashboard ─────────────────────────────────────────────────────────

app.get('/admin', requireAdmin, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const school = getSchool(db);
    const users = getAllUsers(db);
    const hubs = getAllHubs(db);
    const totalAccesses = getTodayAccessCount(db);
    const activity = getRecentActivity(db, 10);

    const activityHtml = activity.length === 0
      ? '<p class="muted">No activity yet.</p>'
      : activity.map((a) => `
        <div class="activity-item">
          <span>${esc(a.user_name ?? 'System')}: ${esc(a.action)}${a.detail ? ` — ${esc(a.detail)}` : ''}</span>
          <span class="ts">${esc(a.created_at)}</span>
        </div>`).join('');

    const adminNav = `
      <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">
        <a href="/admin/teachers" class="btn btn-secondary">Teachers</a>
        <a href="/admin/hubs" class="btn btn-secondary">All Hubs</a>
        <a href="/admin/broadcast" class="btn btn-secondary">Broadcast</a>
        <a href="/admin/branding" class="btn btn-secondary">Branding</a>
      </div>`;

    res.send(layout('Admin Dashboard', `
      <h1>${esc(school.name)} — Admin</h1>
      ${adminNav}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-val">${users.length}</div><div class="stat-lbl">Teachers</div></div>
        <div class="stat-card"><div class="stat-val">${hubs.length}</div><div class="stat-lbl">Hubs</div></div>
        <div class="stat-card"><div class="stat-val">${totalAccesses}</div><div class="stat-lbl">Accesses Today</div></div>
      </div>
      <div class="card">
        <h2>Recent Activity</h2>
        ${activityHtml}
      </div>`, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

// ─── admin: teachers ──────────────────────────────────────────────────────────

app.get('/admin/teachers', requireAdmin, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const users = getAllUsers(db);
    const flash = req.query.flash as string | undefined;
    const flashHtml = flash ? `<div class="alert alert-success">${esc(decodeURIComponent(flash))}</div>` : '';
    const rows = users.map((u) => {
      const hubCount = getHubCountByOwner(db!, u.id);
      return `<tr>
        <td>${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-green' : 'badge-grey'}">${esc(u.role)}</span></td>
        <td>${hubCount}</td>
        <td>${esc(u.last_active ?? '—')}</td>
        <td>
          <form method="POST" action="/admin/teachers/${u.id}/role" style="display:inline">
            <select name="role" onchange="this.form.submit()" style="font-size:.82rem;padding:3px 6px;border-radius:4px;border:1px solid #d1d5db">
              ${(['teacher', 'officer', 'admin'] as const).map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${r}</option>`).join('')}
            </select>
          </form>
          <form method="POST" action="/admin/teachers/${u.id}/delete" style="display:inline" onsubmit="return confirm('Delete ${esc(u.name)}?')">
            <button type="submit" class="btn btn-danger" style="margin-left:6px">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');
    const empty = '<tr><td colspan="6" style="text-align:center;padding:28px;color:#9ca3af">No teachers yet.</td></tr>';
    res.send(layout('Admin Teachers', `
      ${flashHtml}
      <div class="abar">
        <h1 style="margin:0">Teachers</h1>
        <div class="spacer"></div>
        <a href="/admin/teachers/invite" class="btn btn-primary">+ Invite Teacher</a>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Hubs</th><th>Last Active</th><th></th></tr></thead>
        <tbody>${rows || empty}</tbody>
      </table>`, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.get('/admin/teachers/invite', requireAdmin, (req, res) => {
  const role = (req as any).sess.role as string;
  res.send(layout('Admin Invite Teacher', `
    <a href="/admin/teachers" class="back-link">&#x2190; Back to Teachers</a>
    <h1>Invite Teacher</h1>
    <div class="card" style="max-width:420px">
      <form method="POST" action="/admin/teachers/invite">
        <label class="lbl">Name *</label>
        <input type="text" name="name" required>
        <label class="lbl">Email *</label>
        <input type="text" name="email" required>
        <label class="lbl">Role</label>
        <select name="role">
          <option value="teacher">teacher</option>
          <option value="officer">officer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" class="btn btn-primary">Create Account</button>
      </form>
    </div>`, role));
});

app.post('/admin/teachers/invite', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    const name = (req.body.name as string || '').trim();
    const email = (req.body.email as string || '').trim();
    const invRole = (['teacher', 'officer', 'admin'].includes(req.body.role) ? req.body.role : 'teacher') as UserRole;
    if (!name || !email) { res.redirect(302, '/admin/teachers/invite'); return; }
    const school = getSchool(db);
    const tempPw = genTempPw();
    createUser(db, school.id, name, email, hashPw(tempPw), invRole);
    logActivity(db, sess.userId, 'Invited teacher', `${name} <${email}> as ${invRole}`);
    res.send(layout('Admin Invite Teacher', `
      <a href="/admin/teachers" class="back-link">&#x2190; Back to Teachers</a>
      <h1>Account Created</h1>
      <div class="card" style="max-width:420px">
        <p>Account created for <strong>${esc(name)}</strong> (${esc(email)}).</p>
        <p style="margin-top:12px">Temporary password:</p>
        <div class="pw-box">${esc(tempPw)}</div>
        <p class="muted" style="font-size:.82rem">Share this with the teacher. They should change it after first login.</p>
        <a href="/admin/teachers" class="btn btn-primary" style="margin-top:16px">Back to Teachers</a>
      </div>`, sess.role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/teachers/:id/role', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    const userId = parseInt(req.params.id, 10);
    const newRole = (['teacher', 'officer', 'admin'].includes(req.body.role) ? req.body.role : 'teacher') as UserRole;
    updateUserRole(db, userId, newRole);
    logActivity(db, sess.userId, 'Changed role', `user #${userId} → ${newRole}`);
    res.redirect(302, '/admin/teachers');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/teachers/:id/delete', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    const userId = parseInt(req.params.id, 10);
    const user = getAllUsers(db).find((u) => u.id === userId);
    if (user) {
      logActivity(db, sess.userId, 'Deleted teacher', `${user.name} <${user.email}>`);
      deleteUser(db, userId);
    }
    res.redirect(302, '/admin/teachers');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

// ─── admin: hubs ──────────────────────────────────────────────────────────────

app.get('/admin/hubs', requireAdmin, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const hubs = getAllHubsAdmin(db);
    const todayMap = getTodayAccessCountByHub(db);
    const users = getAllUsers(db);
    const filterTeacher = req.query.teacher as string | undefined;
    const filterStatus = req.query.status as string | undefined;

    const filtered = hubs.filter((h) => {
      if (filterTeacher && String(h.owner_id) !== filterTeacher) return false;
      if (filterStatus === 'active' && (h.archived || (h.expires_at && h.expires_at < Math.floor(Date.now() / 1000)))) return false;
      if (filterStatus === 'expired' && !(h.expires_at && h.expires_at < Math.floor(Date.now() / 1000))) return false;
      if (filterStatus === 'archived' && !h.archived) return false;
      return true;
    });

    const teacherOptions = users.map((u) => `<option value="${u.id}"${filterTeacher === String(u.id) ? ' selected' : ''}>${esc(u.name)}</option>`).join('');

    const rows = filtered.map((h) => {
      const accesses = todayMap.get(h.id) ?? 0;
      let status = 'Active';
      if (h.archived) status = 'Archived';
      else if (h.expires_at && h.expires_at < Math.floor(Date.now() / 1000)) status = 'Expired';
      const statusBadge = status === 'Active'
        ? '<span class="badge badge-green">Active</span>'
        : `<span class="badge badge-grey">${status}</span>`;
      const archiveBtn = h.archived
        ? `<form method="POST" action="/admin/hubs/${h.id}/unarchive" style="display:inline"><button type="submit" class="btn btn-secondary">Unarchive</button></form>`
        : `<form method="POST" action="/admin/hubs/${h.id}/archive" style="display:inline"><button type="submit" class="btn btn-secondary">Archive</button></form>`;
      return `<tr>
        <td><code>${esc(h.code)}</code></td>
        <td>${esc(h.label)}</td>
        <td>${esc(h.owner_name ?? '—')}</td>
        <td>${accesses}</td>
        <td>${statusBadge}</td>
        <td>${h.expires_at ? new Date(h.expires_at * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
        <td>
          ${archiveBtn}
          <form method="POST" action="/admin/hubs/${h.id}/delete" style="display:inline" onsubmit="return confirm('Permanently delete hub ${esc(h.code)}?')">
            <button type="submit" class="btn btn-danger" style="margin-left:4px">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');
    const empty = '<tr><td colspan="7" style="text-align:center;padding:28px;color:#9ca3af">No hubs found.</td></tr>';

    res.send(layout('Admin Hubs', `
      <h1>All Hubs</h1>
      <form method="GET" action="/admin/hubs" style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
        <select name="teacher" style="padding:7px 10px;border-radius:6px;border:1px solid #d1d5db;font-size:.85rem">
          <option value="">All Teachers</option>${teacherOptions}
        </select>
        <select name="status" style="padding:7px 10px;border-radius:6px;border:1px solid #d1d5db;font-size:.85rem">
          <option value="">All Statuses</option>
          <option value="active"${filterStatus === 'active' ? ' selected' : ''}>Active</option>
          <option value="expired"${filterStatus === 'expired' ? ' selected' : ''}>Expired</option>
          <option value="archived"${filterStatus === 'archived' ? ' selected' : ''}>Archived</option>
        </select>
        <button type="submit" class="btn btn-secondary">Filter</button>
        <a href="/admin/hubs" class="btn btn-secondary">Clear</a>
      </form>
      <table>
        <thead><tr><th>Code</th><th>Label</th><th>Teacher</th><th>Accesses Today</th><th>Status</th><th>Expiry</th><th></th></tr></thead>
        <tbody>${rows || empty}</tbody>
      </table>`, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/hubs/:id/archive', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    archiveHub(db, parseInt(req.params.id, 10));
    logActivity(db, sess.userId, 'Archived hub', `#${req.params.id}`);
    res.redirect(302, '/admin/hubs');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/hubs/:id/unarchive', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    unarchiveHub(db, parseInt(req.params.id, 10));
    logActivity(db, sess.userId, 'Unarchived hub', `#${req.params.id}`);
    res.redirect(302, '/admin/hubs');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/hubs/:id/delete', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    logActivity(db, sess.userId, 'Deleted hub', `#${req.params.id}`);
    deleteHub(db, parseInt(req.params.id, 10));
    res.redirect(302, '/admin/hubs');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

// ─── admin: broadcast ─────────────────────────────────────────────────────────

app.get('/admin/broadcast', requireAdmin, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const school = getSchool(db);
    const current = school.broadcast_msg ?? '';
    res.send(layout('Admin Broadcast', `
      <h1>Broadcast Announcement</h1>
      <div class="card" style="max-width:560px">
        <form method="POST" action="/admin/broadcast">
          <label class="lbl">Message</label>
          <textarea name="message" rows="4" placeholder="Enter announcement…">${esc(current)}</textarea>
          <p class="muted" style="margin-bottom:12px;font-size:.82rem">Appears as a red banner on every hub page.</p>
          ${current ? `<div style="background:#dc2626;color:#fff;padding:10px 16px;border-radius:6px;font-size:.9rem;font-weight:600;margin-bottom:14px">${esc(current)}</div>` : ''}
          <div style="display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Broadcast</button>
            ${current ? `<form method="POST" action="/admin/broadcast/clear" style="display:inline"><button type="submit" class="btn btn-danger">Clear</button></form>` : ''}
          </div>
        </form>
      </div>`, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/broadcast', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    const message = (req.body.message as string || '').trim();
    if (message) {
      setSchoolBroadcast(db, message);
      logActivity(db, sess.userId, 'Set broadcast', message.slice(0, 60));
    }
    res.redirect(302, '/admin/broadcast');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/broadcast/clear', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    clearSchoolBroadcast(db);
    logActivity(db, sess.userId, 'Cleared broadcast', null);
    res.redirect(302, '/admin/broadcast');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

// ─── admin: branding ──────────────────────────────────────────────────────────

app.get('/admin/branding', requireAdmin, (req, res) => {
  const role = (req as any).sess.role as string;
  let db;
  try {
    db = getDb();
    const school = getSchool(db);
    res.send(layout('Admin Branding', `
      <h1>School Branding</h1>
      <div class="card" style="max-width:480px">
        <form method="POST" action="/admin/branding">
          <label class="lbl">School Name</label>
          <input type="text" name="name" value="${esc(school.name)}" required>
          <label class="lbl">Primary Color</label>
          <div class="color-row" style="margin-bottom:14px">
            <input type="color" name="color" value="${esc(school.primary_color)}">
            <input type="text" name="color_hex" value="${esc(school.primary_color)}" placeholder="#111111" style="width:120px;margin-bottom:0">
            <span class="muted" style="font-size:.82rem">Used on student buttons &amp; links.</span>
          </div>
          <h2 style="margin-bottom:10px">Preview</h2>
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:14px">
            <div style="font-weight:700;font-size:1.1rem;margin-bottom:10px">Sample Hub</div>
            <div style="background:${esc(school.primary_color)};color:#fff;padding:12px 16px;border-radius:8px;font-size:.9rem;font-weight:500;text-align:center;margin-bottom:8px">Sample Link</div>
            <button type="button" style="display:block;width:100%;background:${esc(school.primary_color)};color:#fff;border:none;border-radius:8px;padding:12px;font-size:.9rem;font-weight:600">Submit Form</button>
          </div>
          <button type="submit" class="btn btn-primary">Save Branding</button>
        </form>
      </div>`, role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, role));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/branding', requireAdmin, (req, res) => {
  const sess = (req as any).sess as Session;
  let db;
  try {
    db = getDb();
    const name = (req.body.name as string || '').trim() || 'My School';
    const hexField = (req.body.color_hex as string || '').trim();
    const colorPicker = (req.body.color as string || '').trim();
    const color = /^#[0-9a-fA-F]{6}$/.test(hexField) ? hexField : (/^#[0-9a-fA-F]{6}$/.test(colorPicker) ? colorPicker : '#111111');
    updateSchoolBranding(db, name, color);
    logActivity(db, sess.userId, 'Updated branding', `name="${name}" color=${color}`);
    res.redirect(302, '/admin/branding');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, sess.role));
  } finally {
    if (db) db.close();
  }
});

// ─── start ────────────────────────────────────────────────────────────────────

app.listen(TEACHER_PORT, () => {
  console.log(`Lode teacher dashboard at http://localhost:${TEACHER_PORT}`);
});