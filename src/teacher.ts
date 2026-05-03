import express from 'express';
import cookieParser from 'cookie-parser';
import QRCode from 'qrcode';
import multer from 'multer';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDb, getAllHubs, getFormByHubId, getFormWithFields,
  createForm, updateForm, deleteForm, deleteHub,
  getFormResponsesWithAnswers, getResponseCount,
  addFile, getFilesByHubId, getFileById, getFileByStoredName, deleteFile,
  getHubAccessStats, getLinkClickStats, getFormSubmissionRate,
  getHubAccessByDay, getSchoolWideStats,
  getUsersBySchool, updateUserRole, deleteUser, createUser,
  getSchoolById, updateSchoolProfile, updateSchoolBroadcast, setHubStatus, getRecentActivity,
} from './db';
import type { Hub, FormField, FieldType, NewFormField, HubFile, UserRole, School, ActivityItem } from './db';
import authRouter from './auth';
import { attachUser, requireTeacher, requireAdmin } from './middleware/auth';

const TEACHER_PORT = process.env.TEACHER_PORT
  ? parseInt(process.env.TEACHER_PORT, 10)
  : 3001;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachUser);
app.use(authRouter);

// ─── helpers ────────────────────────────────────────────────────────────────

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

const VALID_TYPES = new Set<string>([
  'short_text', 'long_text', 'multiple_choice', 'checkbox',
  'dropdown', 'date', 'name', 'email', 'number', 'phone',
]);

function parseFields(raw: unknown): NewFormField[] {
  if (!raw || typeof raw !== 'object') return [];
  const rec = raw as Record<
    string,
    { label?: string; type?: string; required?: string; options?: string }
  >;
  return Object.values(rec)
    .filter((f) => f.label && f.label.trim())
    .map((f, idx) => {
      const type = (VALID_TYPES.has(f.type ?? '') ? f.type : 'short_text') as FieldType;
      const hasOptions = type === 'multiple_choice' || type === 'checkbox' || type === 'dropdown';
      return {
        label: (f.label ?? '').trim(),
        type,
        required: f.required === '1',
        options:
          hasOptions && f.options
            ? f.options.split('\n').map((o) => o.trim()).filter(Boolean)
            : null,
        order_index: idx,
      };
    });
}

// ─── file upload setup ───────────────────────────────────────────────────────

const UPLOAD_DIR = path.join(os.homedir(), '.lode', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

function renderPrintSheet(hub: Hub, svgString: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(hub.code)} — Lode QR</title>
  <style>
    @page { margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; padding: 48px; text-align: center;
    }
    .qr-wrap { width: 280px; margin-bottom: 28px; }
    .qr-wrap svg { width: 100%; height: auto; display: block; }
    .hub-label { font-size: 1.5rem; font-weight: 700; color: #111; margin-bottom: 8px; }
    .domain { font-size: 1rem; color: #888; margin-bottom: 14px; }
    .hub-code { font-size: 3rem; font-weight: 800; letter-spacing: 0.12em; color: #111; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
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

// ─── layout & shared CSS ─────────────────────────────────────────────────────

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f9fafb; color: #111; display: flex; min-height: 100vh;
  }
  .sidebar {
    width: 220px; min-height: 100vh; background: #111;
    position: fixed; left: 0; top: 0;
    display: flex; flex-direction: column;
  }
  .sidebar-brand {
    padding: 20px; font-size: 1.05rem; font-weight: 800; color: #fff;
    border-bottom: 1px solid #2a2a2a; line-height: 1.3;
  }
  .sidebar-brand span {
    display: block; font-size: 0.72rem; font-weight: 400;
    color: #9ca3af; margin-top: 3px;
  }
  .sidebar-nav a {
    display: block; padding: 10px 20px; color: #d1d5db;
    text-decoration: none; font-size: 0.87rem;
  }
  .sidebar-nav a:hover, .sidebar-nav a.active { color: #fff; background: #1f1f1f; }
  .main { margin-left: 220px; padding: 32px; flex: 1; max-width: 1000px; }
  h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 22px; }
  h2 { font-size: 1.05rem; font-weight: 600; margin-bottom: 12px; }
  table {
    width: 100%; border-collapse: collapse; background: #fff;
    border-radius: 8px; overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,.07);
  }
  th {
    background: #f3f4f6; text-align: left; padding: 10px 16px;
    font-size: .76rem; text-transform: uppercase;
    letter-spacing: .04em; color: #666;
  }
  td { padding: 11px 16px; border-top: 1px solid #f3f4f6; font-size: .88rem; }
  tr:hover td { background: #fafafa; }
  .btn {
    display: inline-block; padding: 7px 13px; border-radius: 6px;
    font-size: .84rem; font-weight: 500; text-decoration: none;
    cursor: pointer; border: 1px solid transparent; font-family: inherit;
  }
  .btn-primary  { background: #111; color: #fff; }
  .btn-secondary { background: #f3f4f6; color: #111; border-color: #e5e7eb; }
  .btn-danger   { background: #fee2e2; color: #b91c1c; }
  .btn + .btn   { margin-left: 6px; }
  .card {
    background: #fff; border-radius: 8px; padding: 22px;
    box-shadow: 0 1px 3px rgba(0,0,0,.07); margin-bottom: 20px;
  }
  label.lbl { display: block; font-size: .84rem; font-weight: 500; margin-bottom: 5px; color: #374151; }
  input[type="text"], textarea, select {
    display: block; width: 100%; padding: 9px 11px;
    border: 1px solid #d1d5db; border-radius: 6px;
    font-size: .9rem; font-family: inherit; color: #111; margin-bottom: 14px;
  }
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
  .badge-grey  { background: #f3f4f6; color: #6b7280; }
  .muted { color: #9ca3af; font-size: .85rem; }
  .mt2 { margin-top: 8px; }
  .mt3 { margin-top: 12px; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-family: monospace; font-size: .84rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; margin-bottom: 20px; }
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
`;

function layout(title: string, content: string, headExtra = '', role = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Lode</title>
  ${headExtra}
  <style>${CSS}</style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-brand">Lode<span>Teacher Dashboard</span></div>
    <nav class="sidebar-nav">
      <a href="/">My Hubs</a>
      <a href="/analytics">Analytics</a>
      ${role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
      <a href="/account">Account</a>
      <a href="/logout">Logout</a>
    </nav>
  </aside>
  <main class="main">${content}</main>
</body>
</html>`;
}

// ─── field preview (read-only, for forms page) ───────────────────────────────

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

// ─── form builder page (create + edit) ──────────────────────────────────────

function formBuilderPage(
  hubId: number,
  hubLabel: string,
  action: string,
  pageTitle: string,
  initTitle = '',
  initDesc = '',
  initFields: FormField[] = [],
  role = ''
): string {
  const fieldRows = initFields.map((f, idx) => {
    const opts = f.options ? (JSON.parse(f.options) as string[]).join('\n') : '';
    const showOpts =
      f.type === 'multiple_choice' || f.type === 'checkbox' || f.type === 'dropdown' ? '' : 'display:none';
    const allTypes = ['short_text', 'long_text', 'multiple_choice', 'checkbox', 'dropdown', 'date', 'name', 'email', 'number', 'phone'];
    const typeOpts = allTypes
      .map(
        (t) =>
          `<option value="${t}"${t === f.type ? ' selected' : ''}>${t.replace(/_/g, ' ')}</option>`
      )
      .join('');
    return `<div class="field-row" id="field-${idx}" data-idx="${idx}">
      <div class="frow-header">
        <input type="text" name="fields[${idx}][label]" placeholder="Field label" value="${esc(f.label)}" required>
        <select name="fields[${idx}][type]" onchange="onTypeChange(this,${idx})">${typeOpts}</select>
        <label class="chk-lbl">
          <input type="checkbox" name="fields[${idx}][required]" value="1"${f.required ? ' checked' : ''}> Required
        </label>
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

  const startCount = initFields.length;

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
    var fieldCount = ${startCount};

    function buildFieldRow(idx, label, type, required, options) {
      var types = ['short_text','long_text','multiple_choice','checkbox','dropdown','date','name','email','number','phone'];
      var typeOpts = types.map(function(t) {
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

    function removeField(idx) {
      var el = document.getElementById('field-' + idx);
      if (el) el.remove();
    }

    function moveUp(idx) {
      var el = document.getElementById('field-' + idx);
      if (el && el.previousElementSibling) el.parentNode.insertBefore(el, el.previousElementSibling);
    }

    function moveDown(idx) {
      var el = document.getElementById('field-' + idx);
      if (el && el.nextElementSibling) el.parentNode.insertBefore(el.nextElementSibling, el);
    }

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

  return layout(pageTitle, content, '', role);
}

// ─── routes ──────────────────────────────────────────────────────────────────

app.use(requireTeacher);

app.get('/', (req, res) => {
  const role = req.user?.role ?? '';
  let db;
  try {
    db = getDb();
    const hubs = getAllHubs(db);
    const rows = hubs
      .map((hub) => {
        const form = getFormByHubId(db!, hub.id);
        const count = form ? getResponseCount(db!, form.id) : 0;
        const badge = form
          ? `<span class="badge badge-green">Form &nbsp; ${count} resp.</span>`
          : '<span class="badge badge-grey">No form</span>';
        return `<tr>
          <td><code>${esc(hub.code)}</code></td>
          <td>${esc(hub.label)}</td>
          <td>${badge}</td>
          <td>
            <a href="/hubs/${hub.id}/forms" class="btn btn-secondary">Manage</a>
            <a href="/hubs/${hub.id}/analytics" class="btn btn-secondary">Analytics</a>
            <a href="/hubs/${hub.id}/print" class="btn btn-secondary" target="_blank">Print Sheet</a>
          </td>
        </tr>`;
      })
      .join('');

    const empty =
      '<tr><td colspan="4" style="text-align:center;padding:28px;color:#9ca3af">No hubs yet. Use the CLI to create one.</td></tr>';

    res.send(
      layout(
        'My Hubs',
        `<h1>My Hubs</h1>
        <table>
          <thead><tr><th>Code</th><th>Label</th><th>Form</th><th>Actions</th></tr></thead>
          <tbody>${rows || empty}</tbody>
        </table>`,
        '',
        role
      )
    );
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', role));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms', async (req, res) => {
  const role = req.user?.role ?? '';
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) {
      res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', '', role));
      return;
    }
    const form = getFormByHubId(db, hubId);
    const files = getFilesByHubId(db, hubId);
    const qrUrl = `https://glode.xyz/c/${hub.code}`;
    const qrSvg = await QRCode.toString(qrUrl, { type: 'svg' });

    let body = `<a href="/" class="back-link">&#x2190; Back to Hubs</a>
      <h1>${esc(hub.code)} &mdash; ${esc(hub.label)}</h1>
      <div class="card">
        <h2>QR Code</h2>
        <p class="muted" style="margin-bottom:16px">Scans to <code>https://glode.xyz/c/${esc(hub.code)}</code></p>
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
          <form method="POST" action="/hubs/${hubId}/forms/${form.id}/delete" style="display:inline"
            onsubmit="return confirm('Delete this form and all responses?')">
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
      <form method="POST" action="/hubs/${hubId}/files" enctype="multipart/form-data"
        style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" name="file"
          accept=".pdf,.png,.jpg,.jpeg,.gif,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          style="font-size:.84rem;flex:1;min-width:200px">
        <button type="submit" class="btn btn-primary">Upload File</button>
      </form>
    </div>`;

    res.send(layout('Hub', body, '', role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', role));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/new', (req, res) => {
  const role = req.user?.role ?? '';
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) {
      res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', '', role));
      return;
    }
    res.send(formBuilderPage(hubId, hub.label, `/hubs/${hubId}/forms`, 'Create Form', '', '', [], role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', role));
  } finally {
    if (db) db.close();
  }
});

app.post('/hubs/:hubId/forms', (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const title = (req.body.title as string || '').trim();
    if (!title) { res.redirect(302, `/hubs/${hubId}/forms/new`); return; }
    const description = (req.body.description as string || '').trim() || null;
    const fields = parseFields(req.body.fields);
    createForm(db, hubId, title, description, fields);
    res.redirect(302, `/hubs/${hubId}/forms`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/:id/edit', (req, res) => {
  const role = req.user?.role ?? '';
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', '', role)); return; }
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send(layout('Not Found', '<p>Form not found.</p>', '', role)); return; }
    res.send(
      formBuilderPage(
        hubId, hub.label,
        `/hubs/${hubId}/forms/${formId}`,
        'Edit Form',
        fw.title, fw.description ?? '', fw.fields, role
      )
    );
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', role));
  } finally {
    if (db) db.close();
  }
});

app.post('/hubs/:hubId/forms/:id', (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const title = (req.body.title as string || '').trim();
    if (!title) { res.redirect(302, `/hubs/${hubId}/forms/${formId}/edit`); return; }
    const description = (req.body.description as string || '').trim() || null;
    const fields = parseFields(req.body.fields);
    updateForm(db, formId, title, description, fields);
    res.redirect(302, `/hubs/${hubId}/forms`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
  } finally {
    if (db) db.close();
  }
});

app.post('/hubs/:hubId/forms/:id/delete', (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    deleteForm(db, formId);
    res.redirect(302, `/hubs/${hubId}/forms`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/:id/responses', (req, res) => {
  const role = req.user?.role ?? '';
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send(layout('Not Found', '<p>Form not found.</p>', '', role)); return; }
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
        : `<table>
            <thead><tr><th>#</th><th>Submitted At</th>${thCols}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>`}`;

    res.send(layout('Responses', body, '', role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', role));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/:id/responses/export', (req, res) => {
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
    const csv = toCsv(headers, rows);
    const slug = fw.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-responses.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send('Error: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

// ─── analytics routes ────────────────────────────────────────────────────────

app.get('/hubs/:hubId/analytics', (req, res) => {
  const role = req.user?.role ?? '';
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>', '', role)); return; }

    const stats = getHubAccessStats(db, hubId);
    const clickStats = getLinkClickStats(db, hubId);
    const submissionRate = getFormSubmissionRate(db, hubId);
    const byDay = getHubAccessByDay(db, hubId);

    // Build 7-day labels + counts
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
        <div class="stat-card"><div class="stat-val">${stats.accesses_today}</div><div class="stat-lbl">Accessed Today</div></div>
        <div class="stat-card"><div class="stat-val">${stats.accesses_last_10_min}</div><div class="stat-lbl">Last 10 Min</div></div>
        <div class="stat-card"><div class="stat-val">${stats.total_accesses}</div><div class="stat-lbl">Total All Time</div></div>
        <div class="stat-card"><div class="stat-val">${submissionRate}%</div><div class="stat-lbl">Form Submission Rate</div></div>
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

    res.send(layout('Analytics', body, '<meta http-equiv="refresh" content="60">', role));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', role));
  } finally {
    if (db) db.close();
  }
});

app.get('/analytics', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const schoolId = req.user!.school_id;
    const s = getSchoolWideStats(db, schoolId);

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
          : '<p class="muted">No hubs with school assigned.</p>'}
      </div>

      <div class="card">
        <h2>Teacher Leaderboard — Today</h2>
        ${s.teacher_leaderboard.length > 0
          ? `<table><thead><tr><th>#</th><th>Teacher</th><th>Hub Accesses Today</th></tr></thead><tbody>${teacherRows}</tbody></table>`
          : '<p class="muted">No data yet.</p>'}
      </div>`;

    res.send(layout('School Analytics', body, '<meta http-equiv="refresh" content="60">', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

// ─── qr routes ───────────────────────────────────────────────────────────────

app.get('/hubs/:hubId/qr/download', async (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send('Hub not found.'); return; }
    const buf = await QRCode.toBuffer(`https://glode.xyz/c/${hub.code}`, { type: 'png', width: 600 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="lode-${hub.code.toLowerCase()}-qr.png"`);
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error generating QR code: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/qr/print', async (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send('Hub not found.'); return; }
    const svg = await QRCode.toString(`https://glode.xyz/c/${hub.code}`, { type: 'svg' });
    res.send(renderPrintSheet(hub, svg));
  } catch (err) {
    res.status(500).send('Error generating print sheet: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

// ─── file routes ─────────────────────────────────────────────────────────────

app.post('/hubs/:hubId/files', (req, res) => {
  const hubId = parseInt(req.params.hubId, 10);
  upload.single('file')(req, res, (err) => {
    if (err || !req.file) {
      res.redirect(302, `/hubs/${hubId}/forms`);
      return;
    }
    let db;
    try {
      db = getDb();
      addFile(db, hubId, req.user?.id ?? null, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size);
      res.redirect(302, `/hubs/${hubId}/forms`);
    } catch {
      fs.unlink(req.file!.path, () => {});
      res.redirect(302, `/hubs/${hubId}/forms`);
    } finally {
      if (db) db.close();
    }
  });
});

app.post('/hubs/:hubId/files/:fileId/delete', (req, res) => {
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

app.get('/files/:storedName', (req, res) => {
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

// ─── print route ─────────────────────────────────────────────────────────────

app.get('/hubs/:hubId/print', async (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send('Hub not found.'); return; }
    const school = hub.school_id ? getSchoolById(db, hub.school_id) : undefined;
    const qrUrl = `https://getlode.xyz/c/${hub.code}`;
    const qrSvg = await QRCode.toString(qrUrl, { type: 'svg' });
    const logoHtml = school?.branding_logo
      ? `<img src="/files/${esc(school.branding_logo)}" alt="School logo" style="height:60px;object-fit:contain;margin-bottom:24px">`
      : '';
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(hub.code)} — Lode Print Sheet</title>
  <style>
    @page { margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; padding: 48px; text-align: center;
      background: #fff; color: #111;
    }
    .logo-wrap { margin-bottom: 8px; }
    .qr-wrap { width: 240px; margin: 24px auto; }
    .qr-wrap svg { width: 100%; height: auto; display: block; }
    .hub-code { font-size: 4rem; font-weight: 900; letter-spacing: 0.14em; color: #111; margin-bottom: 10px; }
    .hub-label { font-size: 1.3rem; font-weight: 600; color: #333; margin-bottom: 16px; }
    .tagline { font-size: 0.95rem; color: #888; margin-bottom: 6px; }
    .domain { font-size: 1rem; font-weight: 600; color: #555; }
    .print-btn {
      margin-top: 32px; padding: 12px 28px; background: #111; color: #fff;
      border: none; border-radius: 8px; font-size: 1rem; font-weight: 600;
      cursor: pointer; font-family: inherit;
    }
    @media print {
      .print-btn { display: none; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="logo-wrap">${logoHtml}</div>
  <div class="hub-code">${esc(hub.code)}</div>
  <div class="qr-wrap">${qrSvg}</div>
  <div class="hub-label">${esc(hub.label)}</div>
  <div class="tagline">Type this code at</div>
  <div class="domain">getlode.xyz</div>
  <button class="print-btn" onclick="window.print()">Print</button>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error generating print sheet: ' + String(err));
  } finally {
    if (db) db.close();
  }
});

// ─── admin helpers ────────────────────────────────────────────────────────────

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── admin routes ─────────────────────────────────────────────────────────────

app.get('/admin', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const schoolId = req.user!.school_id;
    const school = getSchoolById(db, schoolId);
    const stats = getSchoolWideStats(db, schoolId);
    const activity = getRecentActivity(db, schoolId);

    const activityRows = activity.map((a: ActivityItem) => `<tr>
      <td>${esc(a.type.replace('_', ' '))}</td>
      <td><code>${esc(a.hub_code)}</code> ${esc(a.hub_label)}</td>
      <td class="muted">${esc(a.occurred_at)}</td>
    </tr>`).join('');

    const body = `
      <h1>Admin Overview</h1>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${stats.total_hubs}</div><div class="stat-lbl">Total Hubs</div></div>
        <div class="stat-card"><div class="stat-val">${stats.accesses_today}</div><div class="stat-lbl">Accesses Today</div></div>
        <div class="stat-card"><div class="stat-val">${stats.form_submissions_today}</div><div class="stat-lbl">Submissions Today</div></div>
        <div class="stat-card"><div class="stat-val" style="font-size:1.1rem">${esc(school?.name ?? '—')}</div><div class="stat-lbl">School</div></div>
      </div>
      <div class="card">
        <h2 style="margin-bottom:12px">Quick Links</h2>
        <a href="/admin/teachers" class="btn btn-secondary">Manage Teachers</a>
        <a href="/admin/hubs" class="btn btn-secondary">All Hubs</a>
        <a href="/admin/broadcast" class="btn btn-secondary">Broadcast</a>
        <a href="/admin/branding" class="btn btn-secondary">Branding</a>
      </div>
      <div class="card">
        <h2>Recent Activity</h2>
        ${activity.length > 0
          ? `<table><thead><tr><th>Event</th><th>Hub</th><th>Time</th></tr></thead><tbody>${activityRows}</tbody></table>`
          : '<p class="muted">No recent activity.</p>'}
      </div>`;
    res.send(layout('Admin', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.get('/admin/teachers', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const schoolId = req.user!.school_id;
    const teachers = getUsersBySchool(db, schoolId);

    const rows = teachers.map((t) => `<tr>
      <td>${esc(t.name)}</td>
      <td>${esc(t.email)}</td>
      <td><span class="badge ${t.role === 'admin' ? 'badge-green' : 'badge-grey'}">${esc(t.role)}</span></td>
      <td class="muted">${esc(t.last_active ?? 'Never')}</td>
      <td>
        <form method="POST" action="/admin/teachers/${t.id}/role" style="display:inline">
          <select name="role" onchange="this.form.submit()"
            style="padding:4px 8px;font-size:.84rem;border:1px solid #d1d5db;border-radius:4px;font-family:inherit">
            <option value="teacher"${t.role === 'teacher' ? ' selected' : ''}>teacher</option>
            <option value="admin"${t.role === 'admin' ? ' selected' : ''}>admin</option>
            <option value="officer"${t.role === 'officer' ? ' selected' : ''}>officer</option>
          </select>
        </form>
        ${t.id !== req.user!.id ? `
        <form method="POST" action="/admin/teachers/${t.id}/delete" style="display:inline"
          onsubmit="return confirm('Delete ${esc(t.name)}?')">
          <button type="submit" class="btn btn-danger">Delete</button>
        </form>` : '<span class="muted" style="font-size:.8rem;margin-left:8px">(you)</span>'}
      </td>
    </tr>`).join('');

    const body = `
      <h1>Manage Teachers</h1>
      <div class="card" style="margin-bottom:20px">
        <h2 style="margin-bottom:14px">Invite New Teacher</h2>
        <form method="POST" action="/admin/teachers/invite">
          <label class="lbl">Name *</label>
          <input type="text" name="name" required>
          <label class="lbl">Email *</label>
          <input type="text" name="email" required>
          <label class="lbl">Role</label>
          <select name="role">
            <option value="teacher">teacher</option>
            <option value="admin">admin</option>
            <option value="officer">officer</option>
          </select>
          <button type="submit" class="btn btn-primary">Create Account</button>
        </form>
      </div>
      <div class="card">
        <h2>All Teachers (${teachers.length})</h2>
        ${teachers.length > 0
          ? `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Active</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="muted">No teachers yet.</p>'}
      </div>`;
    res.send(layout('Teachers', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/teachers/invite', requireAdmin, async (req, res) => {
  let db;
  try {
    db = getDb();
    const schoolId = req.user!.school_id;
    const name = (req.body.name as string || '').trim();
    const email = (req.body.email as string || '').trim().toLowerCase();
    const role = (['admin', 'teacher', 'officer'].includes(req.body.role) ? req.body.role : 'teacher') as UserRole;
    if (!name || !email) { res.redirect(302, '/admin/teachers'); return; }
    const tempPassword = generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, 10);
    createUser(db, schoolId, email, hash, role, name);
    const body = `
      <h1>Account Created</h1>
      <div class="card">
        <p style="margin-bottom:12px">Account created for <strong>${esc(name)}</strong> (<code>${esc(email)}</code>).</p>
        <label class="lbl">Temporary Password — share this securely, it will not be shown again:</label>
        <div style="font-family:monospace;font-size:1.3rem;font-weight:700;background:#f3f4f6;padding:16px 20px;border-radius:8px;letter-spacing:.08em;margin-top:8px">${esc(tempPassword)}</div>
        <p class="muted" style="margin-top:12px">The teacher should log in and change this password.</p>
        <a href="/admin/teachers" class="btn btn-primary" style="margin-top:16px;display:inline-block">Back to Teachers</a>
      </div>`;
    res.send(layout('Account Created', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/teachers/:id/delete', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const userId = parseInt(req.params.id, 10);
    if (userId !== req.user!.id) deleteUser(db, userId);
    res.redirect(302, '/admin/teachers');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/teachers/:id/role', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const userId = parseInt(req.params.id, 10);
    const role = (['admin', 'teacher', 'officer'].includes(req.body.role) ? req.body.role : 'teacher') as UserRole;
    updateUserRole(db, userId, role);
    res.redirect(302, '/admin/teachers');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.get('/admin/hubs', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const schoolId = req.user!.school_id;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : '';
    const categoryFilter = typeof req.query.category === 'string' ? req.query.category : '';

    let query = 'SELECT h.*, u.name as teacher_name FROM hubs h LEFT JOIN users u ON u.id = h.user_id WHERE h.school_id = ?';
    const params: unknown[] = [schoolId];
    if (statusFilter) { query += ' AND h.status = ?'; params.push(statusFilter); }
    if (categoryFilter) { query += ' AND h.category = ?'; params.push(categoryFilter); }
    query += ' ORDER BY h.updated_at DESC';

    const hubs = db.prepare(query).all(params) as Array<Hub & { teacher_name: string | null }>;

    const statusBadge = (s: string) => s === 'active'
      ? '<span class="badge badge-green">active</span>'
      : `<span class="badge badge-grey">${esc(s)}</span>`;

    const rows = hubs.map((h) => `<tr>
      <td><code>${esc(h.code)}</code></td>
      <td>${esc(h.label)}</td>
      <td>${esc(h.teacher_name ?? '—')}</td>
      <td>${statusBadge(h.status)}</td>
      <td>${esc(h.category ?? '—')}</td>
      <td>
        <form method="POST" action="/admin/hubs/${h.id}/archive" style="display:inline">
          <button type="submit" class="btn btn-secondary">${h.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
        </form>
        <form method="POST" action="/admin/hubs/${h.id}/delete" style="display:inline"
          onsubmit="return confirm('Permanently delete hub ${esc(h.code)}?')">
          <button type="submit" class="btn btn-danger">Delete</button>
        </form>
      </td>
    </tr>`).join('');

    const filterBar = `
      <form method="GET" action="/admin/hubs" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
        <select name="status" style="padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;font-size:.87rem">
          <option value="">All statuses</option>
          <option value="active"${statusFilter === 'active' ? ' selected' : ''}>Active</option>
          <option value="archived"${statusFilter === 'archived' ? ' selected' : ''}>Archived</option>
        </select>
        <input type="text" name="category" value="${esc(categoryFilter)}" placeholder="Filter category…"
          style="padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;font-size:.87rem;width:180px;margin-bottom:0">
        <button type="submit" class="btn btn-secondary">Filter</button>
        ${statusFilter || categoryFilter ? '<a href="/admin/hubs" class="btn btn-secondary">Clear</a>' : ''}
      </form>`;

    const body = `
      <h1>All Hubs (${hubs.length})</h1>
      ${filterBar}
      ${hubs.length > 0
        ? `<table><thead><tr><th>Code</th><th>Label</th><th>Teacher</th><th>Status</th><th>Category</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">No hubs found.</p>'}`;
    res.send(layout('All Hubs', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/hubs/:id/archive', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.id, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (hub) setHubStatus(db, hubId, hub.status === 'archived' ? 'active' : 'archived');
    res.redirect(302, '/admin/hubs');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/hubs/:id/delete', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    deleteHub(db, parseInt(req.params.id, 10));
    res.redirect(302, '/admin/hubs');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.get('/admin/broadcast', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const school = getSchoolById(db, req.user!.school_id);
    const current = school?.broadcast_msg ?? '';
    const body = `
      <h1>Broadcast Message</h1>
      <div class="card">
        <p class="muted" style="margin-bottom:16px">If set, this appears as a red banner on all student hub pages.</p>
        <form method="POST" action="/admin/broadcast">
          <label class="lbl">Message (leave blank to clear)</label>
          <textarea name="msg" rows="3" placeholder="e.g. School closed tomorrow — no classes">${esc(current)}</textarea>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
        ${current ? `<form method="POST" action="/admin/broadcast" style="margin-top:8px">
          <input type="hidden" name="msg" value="">
          <button type="submit" class="btn btn-danger">Clear Banner</button>
        </form>` : ''}
      </div>`;
    res.send(layout('Broadcast', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/broadcast', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const msg = (req.body.msg as string || '').trim() || null;
    updateSchoolBroadcast(db, req.user!.school_id, msg);
    res.redirect(302, '/admin/broadcast');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.get('/admin/branding', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const school = getSchoolById(db, req.user!.school_id);
    const body = `
      <h1>School Branding</h1>
      <div class="card">
        <form method="POST" action="/admin/branding">
          <label class="lbl">School Name *</label>
          <input type="text" name="name" value="${esc(school?.name ?? '')}" required>
          <label class="lbl">Primary Color</label>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
            <input type="color" name="color" value="${esc(school?.branding_color ?? '#000000')}"
              style="width:48px;height:38px;padding:2px;border:1px solid #d1d5db;border-radius:6px;cursor:pointer">
            <span class="muted" style="font-size:.84rem">Applied to link buttons and submit buttons on student hub pages</span>
          </div>
          <button type="submit" class="btn btn-primary">Save Branding</button>
        </form>
      </div>`;
    res.send(layout('Branding', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/admin/branding', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const name = (req.body.name as string || '').trim();
    const color = (req.body.color as string || '#000000').trim();
    if (!name) { res.redirect(302, '/admin/branding'); return; }
    updateSchoolProfile(db, req.user!.school_id, name, color);
    res.redirect(302, '/admin/branding');
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

// ─── onboarding ───────────────────────────────────────────────────────────────

app.get('/onboarding', requireAdmin, async (req, res) => {
  const step = typeof req.query.step === 'string' ? parseInt(req.query.step, 10) : 1;
  const hubIdParam = typeof req.query.hub === 'string' ? req.query.hub : '';
  let db;
  try {
    db = getDb();
    const school = getSchoolById(db, req.user!.school_id);

    if (step === 3 && hubIdParam) {
      const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(parseInt(hubIdParam, 10)) as Hub | undefined;
      if (hub) {
        const qrUrl = `https://getlode.xyz/c/${hub.code}`;
        const svg = await QRCode.toString(qrUrl, { type: 'svg' });
        const body = `
          <div style="max-width:560px">
            <div class="muted" style="margin-bottom:8px">Step 3 of 4</div>
            <h1>Share your hub</h1>
            <p style="color:#6b7280;margin:12px 0 24px">Your hub is live. Share the URL or print the QR code.</p>
            <div class="card" style="text-align:center">
              <div style="font-size:2.5rem;font-weight:900;letter-spacing:.12em;margin-bottom:16px">${esc(hub.code)}</div>
              <div style="width:180px;margin:0 auto 16px">${svg}</div>
              <code style="font-size:.9rem">https://getlode.xyz/c/${esc(hub.code)}</code>
              <div style="margin-top:16px">
                <a href="/hubs/${hub.id}/print" target="_blank" class="btn btn-secondary">Print Sheet</a>
              </div>
            </div>
            <a href="/onboarding?step=4" class="btn btn-primary" style="margin-top:20px;display:inline-block">Next &rarr;</a>
          </div>`;
        res.send(layout('Onboarding', body, '', 'admin'));
        return;
      }
    }

    if (step === 4) {
      const body = `
        <div style="max-width:480px;text-align:center;padding-top:40px">
          <div style="font-size:3rem;margin-bottom:16px">🎉</div>
          <div class="muted" style="margin-bottom:8px">Step 4 of 4</div>
          <h1>You're all set!</h1>
          <p style="color:#6b7280;margin:12px 0 28px">Lode is ready for your school. Invite your teachers, create more hubs, and watch the analytics roll in.</p>
          <a href="/" class="btn btn-primary">Go to Dashboard</a>
        </div>`;
      res.send(layout('Welcome to Lode', body, '', 'admin'));
      return;
    }

    if (step === 2) {
      const body = `
        <div style="max-width:480px">
          <div class="muted" style="margin-bottom:8px">Step 2 of 4</div>
          <h1>Create your first hub</h1>
          <p style="color:#6b7280;margin:12px 0 20px">A hub is a page students visit. Give it a short code (like <strong>BIO101</strong>) and a label.</p>
          <div class="card">
            <form method="POST" action="/onboarding/hub">
              <label class="lbl">Short Code *</label>
              <input type="text" name="code" placeholder="e.g. BIO101" required
                style="text-transform:uppercase;letter-spacing:.06em">
              <label class="lbl">Label *</label>
              <input type="text" name="label" placeholder="e.g. Biology 101" required>
              <button type="submit" class="btn btn-primary">Create Hub &rarr;</button>
            </form>
          </div>
        </div>`;
      res.send(layout('Onboarding', body, '', 'admin'));
      return;
    }

    // Step 1
    const body = `
      <div style="max-width:480px">
        <div class="muted" style="margin-bottom:8px">Step 1 of 4</div>
        <h1>Welcome to Lode</h1>
        <p style="color:#6b7280;margin:12px 0 20px">Let's get your school set up. First, confirm your school name.</p>
        <div class="card">
          <form method="POST" action="/admin/branding">
            <input type="hidden" name="color" value="${esc(school?.branding_color ?? '#000000')}">
            <label class="lbl">School Name *</label>
            <input type="text" name="name" value="${esc(school?.name ?? '')}" required>
            <button type="submit" class="btn btn-primary">Confirm &rarr;</button>
          </form>
        </div>
        <a href="/onboarding?step=2" class="muted" style="font-size:.84rem;display:inline-block;margin-top:12px">Skip this step</a>
      </div>`;
    res.send(layout('Onboarding', body, '', 'admin'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

app.post('/onboarding/hub', requireAdmin, (req, res) => {
  let db;
  try {
    db = getDb();
    const schoolId = req.user!.school_id;
    const code = (req.body.code as string || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const label = (req.body.label as string || '').trim();
    if (!code || !label) { res.redirect(302, '/onboarding?step=2'); return; }
    const existing = db.prepare('SELECT id FROM hubs WHERE code = ?').get(code);
    if (existing) { res.redirect(302, '/onboarding?step=2'); return; }
    const result = db.prepare(
      `INSERT INTO hubs (code, label, school_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`
    ).run(code, label, schoolId, req.user!.id);
    res.redirect(302, `/onboarding?step=3&hub=${result.lastInsertRowid}`);
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`, '', 'admin'));
  } finally {
    if (db) db.close();
  }
});

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(TEACHER_PORT, () => {
  console.log(`Lode teacher dashboard at http://localhost:${TEACHER_PORT}`);
});
