import express from 'express';
import bcrypt from 'bcrypt';
import {
  getDb, getUserByEmail, createSession, deleteSession,
  createSchool, createUser, schoolExists,
} from './db';
import { SESSION_COOKIE } from './middleware/auth';

const router = express.Router();

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const AUTH_STYLES = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f9fafb; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 32px 20px;
  }
  .card {
    background: #fff; border-radius: 10px; padding: 32px;
    box-shadow: 0 1px 4px rgba(0,0,0,.08); width: 100%; max-width: 400px;
  }
  h1 { font-size: 1.4rem; font-weight: 800; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: .88rem; margin-bottom: 22px; }
  label { display: block; font-size: .84rem; font-weight: 500; margin-bottom: 5px; color: #374151; }
  input[type="text"], input[type="email"], input[type="password"] {
    display: block; width: 100%; padding: 10px 12px;
    border: 1px solid #d1d5db; border-radius: 6px;
    font-size: .9rem; font-family: inherit; color: #111; margin-bottom: 14px;
  }
  input:focus { outline: none; border-color: #111; }
  button[type="submit"] {
    display: block; width: 100%; padding: 11px;
    background: #111; color: #fff; border: none;
    border-radius: 8px; font-size: .95rem; font-family: inherit;
    font-weight: 600; cursor: pointer; margin-top: 4px;
  }
  .err { background: #fee2e2; color: #b91c1c; border-radius: 6px; padding: 8px 12px; font-size: .84rem; margin-bottom: 14px; }
  .footer-link { margin-top: 16px; text-align: center; font-size: .82rem; color: #9ca3af; }
  .footer-link a { color: #6b7280; }
  h2 { font-size: .9rem; font-weight: 600; color: #374151; margin: 18px 0 12px; border-top: 1px solid #f3f4f6; padding-top: 16px; }
`;

function renderLogin(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Lode</title>
  <style>${AUTH_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Lode</h1>
    <p class="sub">Sign in to your teacher dashboard</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="POST" action="/login">
      <label>Email</label>
      <input type="email" name="email" required autocomplete="email">
      <label>Password</label>
      <input type="password" name="password" required autocomplete="current-password">
      <button type="submit">Sign In</button>
    </form>
    <p class="footer-link"><a href="/setup">First time setup</a></p>
  </div>
</body>
</html>`;
}

function renderSetup(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Setup — Lode</title>
  <style>${AUTH_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Lode Setup</h1>
    <p class="sub">Create your school and first admin account</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="POST" action="/setup">
      <label>School Name</label>
      <input type="text" name="schoolName" required placeholder="e.g. Springfield High">
      <h2>Admin Account</h2>
      <label>Your Name</label>
      <input type="text" name="name" required placeholder="e.g. Jane Smith">
      <label>Email</label>
      <input type="email" name="email" required autocomplete="email">
      <label>Password</label>
      <input type="password" name="password" required autocomplete="new-password" minlength="8">
      <button type="submit">Create Account</button>
    </form>
  </div>
</body>
</html>`;
}

router.get('/login', (req, res) => {
  if (req.user) { res.redirect(302, '/'); return; }
  res.send(renderLogin());
});

router.post('/login', async (req, res) => {
  let db;
  try {
    db = getDb();
    const email = (req.body.email as string || '').trim().toLowerCase();
    const password = (req.body.password as string || '');
    if (!email || !password) {
      res.send(renderLogin('Email and password are required.'));
      return;
    }
    const user = getUserByEmail(db, email);
    if (!user) {
      res.send(renderLogin('Invalid email or password.'));
      return;
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.send(renderLogin('Invalid email or password.'));
      return;
    }
    const sessionId = createSession(db, user.id);
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect(302, '/');
  } catch {
    res.send(renderLogin('An error occurred. Please try again.'));
  } finally {
    if (db) db.close();
  }
});

router.get('/logout', (req, res) => {
  const sessionId = req.cookies[SESSION_COOKIE] as string | undefined;
  if (sessionId) {
    let db;
    try {
      db = getDb();
      deleteSession(db, sessionId);
    } catch { /* ignore */ } finally {
      if (db) db.close();
    }
  }
  res.clearCookie(SESSION_COOKIE);
  res.redirect(302, '/login');
});

router.get('/setup', (req, res) => {
  let db;
  try {
    db = getDb();
    if (schoolExists(db)) { res.redirect(302, '/'); return; }
    res.send(renderSetup());
  } catch {
    res.send(renderSetup('An error occurred.'));
  } finally {
    if (db) db.close();
  }
});

router.post('/setup', async (req, res) => {
  let db;
  try {
    db = getDb();
    if (schoolExists(db)) { res.redirect(302, '/'); return; }
    const schoolName = (req.body.schoolName as string || '').trim();
    const name = (req.body.name as string || '').trim();
    const email = (req.body.email as string || '').trim().toLowerCase();
    const password = (req.body.password as string || '');
    if (!schoolName || !name || !email || !password) {
      res.send(renderSetup('All fields are required.'));
      return;
    }
    if (password.length < 8) {
      res.send(renderSetup('Password must be at least 8 characters.'));
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const school = createSchool(db, schoolName, null);
    createUser(db, school.id, email, hash, 'admin', name);
    res.redirect(302, '/login');
  } catch (err) {
    res.send(renderSetup('An error occurred: ' + esc(String(err))));
  } finally {
    if (db) db.close();
  }
});

export default router;
