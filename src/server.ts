import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDb, getHubWithLinks, isHubExpired,
  getFormByHubId, getFormWithFields, saveFormResponse,
  getFilesByHubId, getFileByStoredName,
} from './db';
import type { HubWithLinks, FormWithFields, HubFile } from './db';

const UPLOAD_DIR = path.join(os.homedir(), '.lode', 'uploads');

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

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();
app.use(express.urlencoded({ extended: false }));

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
`;

function renderFormSection(
  hub: HubWithLinks,
  form: FormWithFields,
  errors: Map<number, string>
): string {
  const fields = form.fields.map((field) => {
    const err = errors.get(field.id);
    const errHtml = err
      ? `<div class="f-error">${esc(err)}</div>`
      : '';
    const req = field.required ? ' <span class="f-req">*</span>' : '';
    const reqAttr = field.required ? ' required' : '';
    const errCls = err ? ' inp-err' : '';
    let input = '';
    if (field.type === 'short_text') {
      input = `<input type="text" name="f_${field.id}"${reqAttr} class="${errCls.trim()}">`;
    } else if (field.type === 'long_text') {
      input = `<textarea name="f_${field.id}" rows="4"${reqAttr} class="${errCls.trim()}"></textarea>`;
    } else if (field.type === 'dropdown') {
      const opts: string[] = field.options ? (JSON.parse(field.options) as string[]) : [];
      const optHtml = opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      input = `<select name="f_${field.id}"${reqAttr} class="${errCls.trim()}"><option value="">— select —</option>${optHtml}</select>`;
    } else if (field.type === 'date') {
      input = `<input type="date" name="f_${field.id}"${reqAttr} class="${errCls.trim()}">`;
    } else if (field.type === 'name') {
      input = `<div class="name-pair"><input type="text" name="f_${field.id}_first" placeholder="First Name"${reqAttr} class="${errCls.trim()}"><input type="text" name="f_${field.id}_last" placeholder="Last Name"${reqAttr} class="${errCls.trim()}"></div>`;
    } else if (field.type === 'email') {
      input = `<input type="email" name="f_${field.id}"${reqAttr} class="${errCls.trim()}">`;
    } else if (field.type === 'number') {
      input = `<input type="number" name="f_${field.id}"${reqAttr} class="${errCls.trim()}">`;
    } else if (field.type === 'phone') {
      input = `<input type="tel" name="f_${field.id}"${reqAttr} class="${errCls.trim()}">`;
    } else {
      const opts: string[] = field.options ? (JSON.parse(field.options) as string[]) : [];
      const itype = field.type === 'multiple_choice' ? 'radio' : 'checkbox';
      input = opts
        .map((o) => `<label class="opt-label"><input type="${itype}" name="f_${field.id}" value="${esc(o)}"> ${esc(o)}</label>`)
        .join('\n');
    }
    return `<div class="f-group">\n  <label class="f-label">${esc(field.label)}${req}</label>\n  ${errHtml}${input}\n</div>`;
  }).join('\n');

  return `
<div class="form-wrap">
  <h2 class="form-title">${esc(form.title)}</h2>
  ${form.description ? `<p class="form-desc">${esc(form.description)}</p>` : ''}
  <form method="POST" action="/c/${esc(hub.code)}/submit">
    ${fields}
    <button type="submit" class="submit-btn">Submit</button>
  </form>
</div>`;
}

function renderActive(
  hub: HubWithLinks,
  form: FormWithFields | null = null,
  errors: Map<number, string> = new Map(),
  files: HubFile[] = []
): string {
  const linkItems = hub.links
    .map(
      (l) =>
        `    <a class="link-btn" href="/leave?url=${encodeURIComponent(l.url)}">${esc(l.title)}</a>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(hub.label)}</title>
  <style>
    ${BASE_STYLES}
    body {
      background: #ffffff;
      color: #111111;
      padding: 32px 20px;
      max-width: 600px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 28px;
      line-height: 1.2;
    }
    .links {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    a.link-btn {
      display: block;
      background: #111111;
      color: #ffffff;
      text-decoration: none;
      padding: 20px 24px;
      border-radius: 10px;
      font-size: 1.05rem;
      font-weight: 500;
    }
    .no-links { color: #888; font-size: 1rem; }
    .form-wrap {
      margin-top: 36px;
      padding-top: 28px;
      border-top: 2px solid #e5e7eb;
    }
    h2.form-title { font-size: 1.2rem; font-weight: 700; margin-bottom: 8px; }
    .form-desc { color: #666; font-size: 0.9rem; margin-bottom: 20px; }
    .f-group { margin-bottom: 20px; }
    .f-label { display: block; font-size: 0.9rem; font-weight: 500; margin-bottom: 6px; }
    .f-req { color: #dc2626; }
    .f-error { color: #dc2626; font-size: 0.82rem; margin-bottom: 4px; }
    input[type="text"], input[type="date"], input[type="email"],
    input[type="number"], input[type="tel"], select, textarea {
      display: block; width: 100%;
      padding: 12px 14px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 0.95rem;
      font-family: inherit;
      color: #111;
    }
    .name-pair { display: flex; gap: 12px; }
    .name-pair input { flex: 1; }
    .inp-err { border-color: #dc2626; }
    .opt-label {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 8px; font-size: 0.9rem; cursor: pointer;
    }
    .submit-btn {
      display: block; width: 100%;
      background: #111; color: #fff; border: none;
      border-radius: 10px; padding: 18px 20px;
      font-size: 1rem; font-family: inherit;
      font-weight: 600; margin-top: 24px; cursor: pointer;
    }
    .files-wrap {
      margin-top: 36px; padding-top: 28px;
      border-top: 2px solid #e5e7eb;
    }
    h2.files-title { font-size: 1.2rem; font-weight: 700; margin-bottom: 16px; }
    a.file-btn {
      display: flex; align-items: center; gap: 12px;
      background: #f3f4f6; color: #111; text-decoration: none;
      padding: 14px 18px; border-radius: 8px; margin-bottom: 10px;
      font-size: 0.9rem;
    }
    .file-type-badge {
      font-size: 0.72rem; font-weight: 700; font-family: monospace;
      background: #e5e7eb; padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
    }
    .file-name { flex: 1; font-weight: 500; }
    .file-size { font-size: 0.8rem; color: #888; flex-shrink: 0; }
  </style>
</head>
<body>
  <h1>${esc(hub.label)}</h1>
  <div class="links">
${hub.links.length > 0 ? linkItems : '    <p class="no-links">No links have been added to this hub yet.</p>'}
  </div>
  ${files.length > 0 ? `
  <div class="files-wrap">
    <h2 class="files-title">Files</h2>
    ${files.map((f) => `<a class="file-btn" href="/files/${f.stored_name}">
      <span class="file-type-badge">${fileTypeLabel(f.mimetype)}</span>
      <span class="file-name">${esc(f.filename)}</span>
      <span class="file-size">${formatSize(f.size)}</span>
    </a>`).join('')}
  </div>` : ''}
  ${form ? renderFormSection(hub, form, errors) : ''}
</body>
</html>`;
}

function renderExpired(hub: HubWithLinks): string {
  const message = hub.fallback_msg ?? 'This content is no longer available.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(hub.label)}</title>
  <style>
    ${BASE_STYLES}
    body {
      background: #fef9c3;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 20px;
    }
    .box {
      text-align: center;
      max-width: 480px;
    }
    .hub-label {
      font-size: 1rem;
      font-weight: 600;
      color: #555;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .message {
      font-size: 1.5rem;
      font-weight: 700;
      color: #111;
      line-height: 1.3;
    }
  </style>
</head>
<body>
  <div class="box">
    <div class="hub-label">${esc(hub.label)}</div>
    <div class="message">${esc(message)}</div>
  </div>
</body>
</html>`;
}

function renderNotFound(code: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hub Not Found</title>
  <style>
    ${BASE_STYLES}
    body {
      background: #ffffff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 20px;
    }
    .box {
      text-align: center;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      color: #111;
      margin-bottom: 10px;
    }
    p {
      color: #666;
      font-size: 1rem;
    }
    code {
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>Hub Not Found</h1>
    <p>No hub exists with the code <code>${esc(code.toUpperCase())}</code>.</p>
  </div>
</body>
</html>`;
}

function renderHomepage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lode</title>
  <style>
    ${BASE_STYLES}
    body {
      background: #ffffff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 20px;
    }
    .container {
      width: 100%;
      max-width: 600px;
    }
    .brand {
      font-size: 2.2rem;
      font-weight: 800;
      color: #111;
      letter-spacing: -0.03em;
      margin-bottom: 6px;
    }
    .tagline {
      font-size: 1rem;
      color: #666;
      margin-bottom: 36px;
    }
    input[type="text"] {
      display: block;
      width: 100%;
      padding: 18px 20px;
      font-size: 1.1rem;
      font-family: inherit;
      border: 2px solid #e5e7eb;
      border-radius: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      outline: none;
      margin-bottom: 12px;
      color: #111;
    }
    input[type="text"]:focus {
      border-color: #111;
    }
    button[type="submit"] {
      display: block;
      width: 100%;
      padding: 18px 20px;
      font-size: 1.1rem;
      font-family: inherit;
      font-weight: 700;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">Lode</div>
    <div class="tagline">Enter your class code to access your hub.</div>
    <form action="/go" method="GET">
      <input
        type="text"
        name="code"
        placeholder="Enter your code (e.g. SKN)"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
      />
      <button type="submit">Go</button>
    </form>
  </div>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  res.status(200).send(renderHomepage());
});

app.get('/go', (req, res) => {
  const raw = typeof req.query.code === 'string' ? req.query.code : '';
  const code = raw.trim().toUpperCase();
  if (!code) {
    res.redirect(302, '/');
    return;
  }
  res.redirect(302, `/c/${encodeURIComponent(code)}`);
});

app.get('/c/:code', (req, res) => {
  let db;
  try {
    db = getDb();
    const hub = getHubWithLinks(db, req.params.code);

    if (!hub) {
      res.status(404).send(renderNotFound(req.params.code));
      return;
    }

    if (isHubExpired(hub)) {
      res.status(200).send(renderExpired(hub));
      return;
    }

    const form = getFormByHubId(db, hub.id);
    const fw = form ? (getFormWithFields(db, form.id) ?? null) : null;
    const files = getFilesByHubId(db, hub.id);
    res.status(200).send(renderActive(hub, fw, new Map(), files));
  } catch (err) {
    res.status(500).send(renderNotFound('error'));
  } finally {
    if (db) db.close();
  }
});

function renderThanks(code: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Response Submitted</title>
  <style>
    ${BASE_STYLES}
    body {
      background: #fff; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 32px 20px;
    }
    .box { text-align: center; max-width: 480px; }
    h1 { font-size: 1.5rem; font-weight: 700; color: #111; margin-bottom: 16px; }
    a { color: #111; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Your response was submitted.</h1>
    <a href="/c/${esc(code)}">Go back</a>
  </div>
</body>
</html>`;
}

function renderLeave(url: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're leaving Lode</title>
  <style>
    ${BASE_STYLES}
    body {
      background: #fff; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 32px 20px;
    }
    .box { max-width: 600px; width: 100%; }
    h1 { font-size: 1.4rem; font-weight: 700; color: #111; margin-bottom: 10px; }
    .sub { color: #555; font-size: 0.95rem; line-height: 1.5; margin-bottom: 24px; }
    .url-box {
      background: #f3f4f6; border-radius: 8px;
      padding: 14px 16px; font-family: monospace;
      font-size: 0.85rem; color: #333;
      word-break: break-all; margin-bottom: 28px;
    }
    .actions { display: flex; gap: 12px; }
    a.btn-go {
      flex: 1; display: block; background: #111; color: #fff;
      text-decoration: none; padding: 16px 20px; border-radius: 10px;
      font-size: 1rem; font-weight: 600; text-align: center;
    }
    a.btn-back {
      flex: 1; display: block; background: #f3f4f6; color: #111;
      text-decoration: none; padding: 16px 20px; border-radius: 10px;
      font-size: 1rem; font-weight: 600; text-align: center;
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>You're leaving Lode</h1>
    <p class="sub">We don't control this destination and cannot verify its content. Proceed with caution.</p>
    <div class="url-box">${esc(url)}</div>
    <div class="actions">
      <a class="btn-go" href="${esc(url)}">Continue</a>
      <a class="btn-back" href="/">Go Back</a>
    </div>
  </div>
</body>
</html>`;
}

app.post('/c/:code/submit', (req, res) => {
  let db;
  try {
    db = getDb();
    const hub = getHubWithLinks(db, req.params.code);
    if (!hub || isHubExpired(hub)) {
      res.redirect(302, `/c/${req.params.code}`);
      return;
    }
    const form = getFormByHubId(db, hub.id);
    if (!form) {
      res.redirect(302, `/c/${req.params.code}`);
      return;
    }
    const fw = getFormWithFields(db, form.id);
    if (!fw) {
      res.redirect(302, `/c/${req.params.code}`);
      return;
    }

    const body = req.body as Record<string, string | string[]>;
    const errors = new Map<number, string>();

    for (const field of fw.fields) {
      if (field.required) {
        if (field.type === 'name') {
          const first = ((body[`f_${field.id}_first`] as string) || '').trim();
          const last = ((body[`f_${field.id}_last`] as string) || '').trim();
          if (!first || !last) errors.set(field.id, 'This field is required.');
        } else {
          const val = body[`f_${field.id}`];
          const missing =
            !val || (Array.isArray(val) ? val.length === 0 : val.trim() === '');
          if (missing) errors.set(field.id, 'This field is required.');
        }
      }
    }

    if (errors.size > 0) {
      res.status(200).send(renderActive(hub, fw, errors));
      return;
    }

    const answers = fw.fields.map((field) => {
      let value = '';
      if (field.type === 'name') {
        const first = ((body[`f_${field.id}_first`] as string) || '').trim();
        const last = ((body[`f_${field.id}_last`] as string) || '').trim();
        value = `${first}|${last}`;
      } else {
        const val = body[`f_${field.id}`];
        if (Array.isArray(val)) value = val.join(', ');
        else if (val) value = val.trim();
      }
      return { fieldId: field.id, value };
    });

    saveFormResponse(db, form.id, answers);
    res.redirect(302, `/c/${req.params.code}/thanks`);
  } catch {
    res.redirect(302, `/c/${req.params.code}`);
  } finally {
    if (db) db.close();
  }
});

app.get('/c/:code/thanks', (req, res) => {
  res.status(200).send(renderThanks(req.params.code));
});

app.get('/leave', (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  let valid = false;
  try { new URL(rawUrl); valid = true; } catch { valid = false; }
  if (!valid || !rawUrl) {
    res.redirect(302, '/');
    return;
  }
  res.status(200).send(renderLeave(rawUrl));
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

app.listen(PORT, () => {
  console.log(`Lode server running at http://localhost:${PORT}`);
  console.log(`Student hubs available at http://localhost:${PORT}/c/<CODE>`);
});
