import express from 'express';
import { getDb, getHubWithLinks, isHubExpired } from './db';
import type { HubWithLinks } from './db';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();

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

function renderActive(hub: HubWithLinks): string {
  const linkItems = hub.links
    .map((l) => `    <a class="link-btn" href="${esc(l.url)}">${esc(l.title)}</a>`)
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
    .no-links {
      color: #888;
      font-size: 1rem;
    }
  </style>
</head>
<body>
  <h1>${esc(hub.label)}</h1>
  <div class="links">
${hub.links.length > 0 ? linkItems : '    <p class="no-links">No links have been added to this hub yet.</p>'}
  </div>
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
  <title>EduCode</title>
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
    <div class="brand">EduCode</div>
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

    res.status(200).send(renderActive(hub));
  } catch (err) {
    res.status(500).send(renderNotFound('error'));
  } finally {
    if (db) db.close();
  }
});

app.listen(PORT, () => {
  console.log(`EduCode server running at http://localhost:${PORT}`);
  console.log(`Student hubs available at http://localhost:${PORT}/c/<CODE>`);
});
