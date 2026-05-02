import express from 'express';
import cookieParser from 'cookie-parser';
import QRCode from 'qrcode';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDb, getAllHubs, getFormByHubId, getFormWithFields,
  createForm, updateForm, deleteForm,
  getFormResponsesWithAnswers, getResponseCount,
  addFile, getFilesByHubId, getFileById, getFileByStoredName, deleteFile,
} from './db';
import type { Hub, FormField, FieldType, NewFormField, HubFile } from './db';
import authRouter from './auth';
import { attachUser, requireTeacher } from './middleware/auth';

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
`;

function layout(title: string, content: string): string {
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
      <a href="/" class="active">Hubs</a>
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
  initFields: FormField[] = []
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

  return layout(pageTitle, content);
}

// ─── routes ──────────────────────────────────────────────────────────────────

app.use(requireTeacher);

app.get('/', (_req, res) => {
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
          <td><a href="/hubs/${hub.id}/forms" class="btn btn-secondary">View Forms</a></td>
        </tr>`;
      })
      .join('');

    const empty =
      '<tr><td colspan="4" style="text-align:center;padding:28px;color:#9ca3af">No hubs yet. Use the CLI to create one.</td></tr>';

    res.send(
      layout(
        'Hubs',
        `<h1>Hubs</h1>
        <table>
          <thead><tr><th>Code</th><th>Label</th><th>Form</th><th></th></tr></thead>
          <tbody>${rows || empty}</tbody>
        </table>`
      )
    );
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms', async (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) {
      res.status(404).send(layout('Not Found', '<p>Hub not found.</p>'));
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

    res.send(layout('Hub', body));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
  } finally {
    if (db) db.close();
  }
});

app.get('/hubs/:hubId/forms/new', (req, res) => {
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) {
      res.status(404).send(layout('Not Found', '<p>Hub not found.</p>'));
      return;
    }
    res.send(formBuilderPage(hubId, hub.label, `/hubs/${hubId}/forms`, 'Create Form'));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
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
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const hub = db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub | undefined;
    if (!hub) { res.status(404).send(layout('Not Found', '<p>Hub not found.</p>')); return; }
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send(layout('Not Found', '<p>Form not found.</p>')); return; }
    res.send(
      formBuilderPage(
        hubId, hub.label,
        `/hubs/${hubId}/forms/${formId}`,
        'Edit Form',
        fw.title, fw.description ?? '', fw.fields
      )
    );
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
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
  let db;
  try {
    db = getDb();
    const hubId = parseInt(req.params.hubId, 10);
    const formId = parseInt(req.params.id, 10);
    const fw = getFormWithFields(db, formId);
    if (!fw) { res.status(404).send(layout('Not Found', '<p>Form not found.</p>')); return; }
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

    res.send(layout('Responses', body));
  } catch (err) {
    res.status(500).send(layout('Error', `<p style="color:red">${esc(String(err))}</p>`));
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

// ─── start ───────────────────────────────────────────────────────────────────

app.listen(TEACHER_PORT, () => {
  console.log(`Lode teacher dashboard at http://localhost:${TEACHER_PORT}`);
});
