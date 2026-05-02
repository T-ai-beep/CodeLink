import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

const DB_DIR = path.join(os.homedir(), '.lode');
const DB_PATH = path.join(DB_DIR, 'lode.db');

// ─── interfaces ───────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'teacher' | 'officer';

export interface School {
  id: number;
  name: string;
  primary_color: string;
  broadcast_msg: string | null;
  domain: string | null;
  branding_logo: string | null;
  created_at: string;
}

export interface User {
  id: number;
  school_id: number;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  last_active: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export interface Hub {
  id: number;
  code: string;
  label: string;
  created_at: string;
  updated_at: string;
  expires_at: number | null;
  fallback_msg: string | null;
  owner_id: number | null;
  archived: number;
  category: string | null;
  notes: string | null;
}

export interface Link {
  id: number;
  hub_id: number;
  title: string;
  url: string;
  order_index: number;
}

export interface HubWithLinks extends Hub {
  links: Link[];
}

export interface HubWithOwnerName extends Hub {
  owner_name: string | null;
}

export interface NewHub {
  code: string;
  label: string;
}

export interface NewLink {
  title: string;
  url: string;
}

export type FieldType =
  | 'short_text' | 'long_text' | 'multiple_choice' | 'checkbox'
  | 'dropdown' | 'date' | 'name' | 'email' | 'number' | 'phone';

export interface Form {
  id: number;
  hub_id: number;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface FormField {
  id: number;
  form_id: number;
  label: string;
  type: FieldType;
  required: number;
  options: string | null;
  order_index: number;
}

export interface FormWithFields extends Form {
  fields: FormField[];
}

export interface FormResponse {
  id: number;
  form_id: number;
  submitted_at: string;
}

export interface FormAnswer {
  id: number;
  response_id: number;
  field_id: number;
  value: string;
}

export interface FormResponseWithAnswers extends FormResponse {
  answers: FormAnswer[];
}

export interface NewFormField {
  label: string;
  type: FieldType;
  required: boolean;
  options: string[] | null;
  order_index: number;
}

export interface HubFile {
  id: number;
  hub_id: number;
  user_id: number | null;
  filename: string;
  stored_name: string;
  mimetype: string;
  size: number;
  created_at: string;
}

export interface ActivityLog {
  id: number;
  user_id: number | null;
  action: string;
  detail: string | null;
  created_at: string;
}

export interface AccessStats {
  total_accesses: number;
  accesses_today: number;
  accesses_last_10_min: number;
  accesses_this_week: number;
  peak_hour: number;
  device_breakdown: { mobile: number; desktop: number; unknown: number };
}

export interface LinkClickStat {
  url: string;
  title: string;
  clicks: number;
}

export interface SchoolWideStats {
  total_hubs: number;
  accesses_today: number;
  form_submissions_today: number;
  most_accessed_hub_today: { code: string; label: string; count: number } | null;
  hub_table: Array<{ code: string; label: string; accesses_today: number; total_accesses: number }>;
  teacher_leaderboard: Array<{ name: string; accesses_today: number }>;
}

// ─── db init ──────────────────────────────────────────────────────────────────

function openDb(): Database.Database {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schools (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL DEFAULT 'My School',
      primary_color TEXT    NOT NULL DEFAULT '#111111',
      broadcast_msg TEXT    NULL,
      domain        TEXT    NULL,
      branding_logo TEXT    NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      email       TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'teacher',
      last_active TEXT    NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hubs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT    NOT NULL UNIQUE,
      label      TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS links (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      title       TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS forms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      title       TEXT    NOT NULL,
      description TEXT    NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS form_fields (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id     INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      label       TEXT    NOT NULL,
      type        TEXT    NOT NULL,
      required    INTEGER NOT NULL DEFAULT 0,
      options     TEXT    NULL,
      order_index INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS form_responses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id      INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      submitted_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS form_answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      response_id INTEGER NOT NULL REFERENCES form_responses(id) ON DELETE CASCADE,
      field_id    INTEGER NOT NULL REFERENCES form_fields(id) ON DELETE CASCADE,
      value       TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      filename    TEXT    NOT NULL,
      stored_name TEXT    NOT NULL UNIQUE,
      mimetype    TEXT    NOT NULL,
      size        INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hub_access_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      accessed_at TEXT    NOT NULL DEFAULT (datetime('now')),
      device_hint TEXT    NULL
    );

    CREATE TABLE IF NOT EXISTS link_click_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id     INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      link_url   TEXT    NOT NULL,
      clicked_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT    NOT NULL,
      detail      TEXT    NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function migrateSchema(db: Database.Database): void {
  // hubs columns
  const hubCols = (db.pragma('table_info(hubs)') as Array<{ name: string }>).map((c) => c.name);
  if (!hubCols.includes('expires_at'))
    db.exec('ALTER TABLE hubs ADD COLUMN expires_at INTEGER');
  if (!hubCols.includes('fallback_msg'))
    db.exec('ALTER TABLE hubs ADD COLUMN fallback_msg TEXT');
  if (!hubCols.includes('owner_id'))
    db.exec('ALTER TABLE hubs ADD COLUMN owner_id INTEGER NULL');
  if (!hubCols.includes('archived'))
    db.exec('ALTER TABLE hubs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!hubCols.includes('category'))
    db.exec('ALTER TABLE hubs ADD COLUMN category TEXT');
  if (!hubCols.includes('notes'))
    db.exec('ALTER TABLE hubs ADD COLUMN notes TEXT');
  // migrate legacy user_id -> owner_id
  if (hubCols.includes('user_id'))
    db.exec('UPDATE hubs SET owner_id = user_id WHERE owner_id IS NULL AND user_id IS NOT NULL');

  // schools columns
  const schoolCols = (db.pragma('table_info(schools)') as Array<{ name: string }>).map((c) => c.name);
  if (!schoolCols.includes('primary_color'))
    db.exec("ALTER TABLE schools ADD COLUMN primary_color TEXT NOT NULL DEFAULT '#111111'");
  if (!schoolCols.includes('broadcast_msg'))
    db.exec('ALTER TABLE schools ADD COLUMN broadcast_msg TEXT');
  if (!schoolCols.includes('domain'))
    db.exec('ALTER TABLE schools ADD COLUMN domain TEXT');
  if (!schoolCols.includes('branding_logo'))
    db.exec('ALTER TABLE schools ADD COLUMN branding_logo TEXT');
}

function seedDefaults(db: Database.Database): void {
  const { c } = db.prepare('SELECT COUNT(*) as c FROM schools').get() as { c: number };
  if (c === 0) {
    db.prepare(
      `INSERT INTO schools (name, primary_color) VALUES ('My School', '#111111')`
    ).run();
  }
}

export function getDb(): Database.Database {
  const db = openDb();
  initSchema(db);
  migrateSchema(db);
  seedDefaults(db);
  return db;
}

// ─── schools ──────────────────────────────────────────────────────────────────

export function getSchool(db: Database.Database): School {
  return db.prepare('SELECT * FROM schools LIMIT 1').get() as School;
}

export function updateSchoolBranding(
  db: Database.Database,
  name: string,
  color: string,
  logo: string | null = null
): void {
  db.prepare('UPDATE schools SET name = ?, primary_color = ?, branding_logo = ?').run(name, color, logo);
}

export function setSchoolBroadcast(db: Database.Database, msg: string): void {
  db.prepare('UPDATE schools SET broadcast_msg = ?').run(msg);
}

export function clearSchoolBroadcast(db: Database.Database): void {
  db.prepare('UPDATE schools SET broadcast_msg = NULL').run();
}

// ─── users ────────────────────────────────────────────────────────────────────

export function userExists(db: Database.Database): boolean {
  return (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c > 0;
}

export function getUserByEmail(db: Database.Database, email: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as User | undefined;
}

export function getUserById(db: Database.Database, id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getAllUsers(db: Database.Database): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as User[];
}

export function createUser(
  db: Database.Database,
  schoolId: number,
  name: string,
  email: string,
  password: string,
  role: UserRole
): User {
  const r = db.prepare(
    `INSERT INTO users (school_id, name, email, password, role, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(schoolId, name, email.toLowerCase(), password, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid as number) as User;
}

export function deleteUser(db: Database.Database, id: number): void {
  db.transaction(() => {
    db.prepare('UPDATE hubs SET owner_id = NULL WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
}

export function updateUserRole(db: Database.Database, id: number, role: UserRole): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function touchUserLastActive(db: Database.Database, id: number): void {
  db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(id);
}

export function getHubCountByOwner(db: Database.Database, userId: number): number {
  return (db.prepare('SELECT COUNT(*) as c FROM hubs WHERE owner_id = ?').get(userId) as { c: number }).c;
}

// ─── hubs ─────────────────────────────────────────────────────────────────────

export function hubExists(db: Database.Database, code: string): boolean {
  return db.prepare('SELECT id FROM hubs WHERE code = ?').get(code.toUpperCase()) !== undefined;
}

export function createHub(db: Database.Database, hub: NewHub, links: NewLink[]): Hub {
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO hubs (code, label, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`
    ).run(hub.code.toUpperCase(), hub.label);
    const hubId = r.lastInsertRowid as number;
    links.forEach((link, i) =>
      db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?, ?, ?, ?)').run(hubId, link.title, link.url, i)
    );
    return db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub;
  })();
}

export function getAllHubs(db: Database.Database): Hub[] {
  return db.prepare('SELECT * FROM hubs ORDER BY updated_at DESC').all() as Hub[];
}

export function getAllHubsAdmin(db: Database.Database): HubWithOwnerName[] {
  return db.prepare(`
    SELECT h.*, u.name as owner_name
    FROM hubs h LEFT JOIN users u ON h.owner_id = u.id
    ORDER BY h.updated_at DESC
  `).all() as HubWithOwnerName[];
}

export function getHubByCode(db: Database.Database, code: string): Hub | undefined {
  return db.prepare('SELECT * FROM hubs WHERE code = ?').get(code.toUpperCase()) as Hub | undefined;
}

export function getLinksByHubId(db: Database.Database, hubId: number): Link[] {
  return db.prepare('SELECT * FROM links WHERE hub_id = ? ORDER BY order_index ASC').all(hubId) as Link[];
}

export function getHubWithLinks(db: Database.Database, code: string): HubWithLinks | undefined {
  const hub = getHubByCode(db, code);
  if (!hub) return undefined;
  return { ...hub, links: getLinksByHubId(db, hub.id) };
}

export function updateHub(db: Database.Database, hubId: number, label: string, links: NewLink[]): void {
  db.transaction(() => {
    db.prepare(`UPDATE hubs SET label = ?, updated_at = datetime('now') WHERE id = ?`).run(label, hubId);
    db.prepare('DELETE FROM links WHERE hub_id = ?').run(hubId);
    links.forEach((link, i) =>
      db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?, ?, ?, ?)').run(hubId, link.title, link.url, i)
    );
  })();
}

export function updateHubExpiry(
  db: Database.Database,
  hubId: number,
  expiresAt: number,
  fallbackMsg: string
): void {
  db.prepare('UPDATE hubs SET expires_at = ?, fallback_msg = ? WHERE id = ?').run(expiresAt, fallbackMsg, hubId);
}

export function clearHubExpiry(db: Database.Database, hubId: number): void {
  db.prepare('UPDATE hubs SET expires_at = NULL, fallback_msg = NULL WHERE id = ?').run(hubId);
}

export function isHubExpired(hub: Hub): boolean {
  if (hub.expires_at === null) return false;
  return Math.floor(Date.now() / 1000) > hub.expires_at;
}

export function archiveHub(db: Database.Database, hubId: number): void {
  db.prepare('UPDATE hubs SET archived = 1 WHERE id = ?').run(hubId);
}

export function unarchiveHub(db: Database.Database, hubId: number): void {
  db.prepare('UPDATE hubs SET archived = 0 WHERE id = ?').run(hubId);
}

export function deleteHub(db: Database.Database, hubId: number): void {
  db.prepare('DELETE FROM hubs WHERE id = ?').run(hubId);
}

// ─── forms ────────────────────────────────────────────────────────────────────

export function createForm(
  db: Database.Database,
  hubId: number,
  title: string,
  description: string | null,
  fields: NewFormField[]
): Form {
  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO forms (hub_id, title, description, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
    ).run(hubId, title, description);
    const formId = r.lastInsertRowid as number;
    fields.forEach((f, i) =>
      db.prepare(
        `INSERT INTO form_fields (form_id, label, type, required, options, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(formId, f.label, f.type, f.required ? 1 : 0, f.options ? JSON.stringify(f.options) : null, i)
    );
    return db.prepare('SELECT * FROM forms WHERE id = ?').get(formId) as Form;
  })();
}

export function getFormByHubId(db: Database.Database, hubId: number): Form | undefined {
  return db.prepare('SELECT * FROM forms WHERE hub_id = ?').get(hubId) as Form | undefined;
}

export function getFormWithFields(db: Database.Database, formId: number): FormWithFields | undefined {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(formId) as Form | undefined;
  if (!form) return undefined;
  const fields = db.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY order_index ASC'
  ).all(formId) as FormField[];
  return { ...form, fields };
}

export function updateForm(
  db: Database.Database,
  formId: number,
  title: string,
  description: string | null,
  fields: NewFormField[]
): void {
  db.transaction(() => {
    db.prepare(`UPDATE forms SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`).run(title, description, formId);
    db.prepare('DELETE FROM form_fields WHERE form_id = ?').run(formId);
    fields.forEach((f, i) =>
      db.prepare(
        `INSERT INTO form_fields (form_id, label, type, required, options, order_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(formId, f.label, f.type, f.required ? 1 : 0, f.options ? JSON.stringify(f.options) : null, i)
    );
  })();
}

export function deleteForm(db: Database.Database, formId: number): void {
  db.prepare('DELETE FROM forms WHERE id = ?').run(formId);
}

export function saveFormResponse(
  db: Database.Database,
  formId: number,
  answers: Array<{ fieldId: number; value: string }>
): void {
  db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO form_responses (form_id, submitted_at) VALUES (?, datetime('now'))`
    ).run(formId);
    const responseId = r.lastInsertRowid as number;
    answers.forEach((a) =>
      db.prepare('INSERT INTO form_answers (response_id, field_id, value) VALUES (?, ?, ?)').run(responseId, a.fieldId, a.value)
    );
  })();
}

export function getFormResponses(db: Database.Database, formId: number): FormResponse[] {
  return db.prepare(
    'SELECT * FROM form_responses WHERE form_id = ? ORDER BY submitted_at ASC'
  ).all(formId) as FormResponse[];
}

export function getFormResponsesWithAnswers(
  db: Database.Database,
  formId: number
): FormResponseWithAnswers[] {
  return getFormResponses(db, formId).map((r) => ({
    ...r,
    answers: db.prepare('SELECT * FROM form_answers WHERE response_id = ?').all(r.id) as FormAnswer[],
  }));
}

export function getResponseCount(db: Database.Database, formId: number): number {
  return (db.prepare('SELECT COUNT(*) as count FROM form_responses WHERE form_id = ?').get(formId) as { count: number }).count;
}

// ─── files ────────────────────────────────────────────────────────────────────

export function addFile(
  db: Database.Database,
  hubId: number,
  userId: number | null,
  filename: string,
  storedName: string,
  mimetype: string,
  size: number
): HubFile {
  const r = db.prepare(
    `INSERT INTO files (hub_id, user_id, filename, stored_name, mimetype, size) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hubId, userId, filename, storedName, mimetype, size);
  return db.prepare('SELECT * FROM files WHERE id = ?').get(r.lastInsertRowid as number) as HubFile;
}

export function getFilesByHubId(db: Database.Database, hubId: number): HubFile[] {
  return db.prepare('SELECT * FROM files WHERE hub_id = ? ORDER BY created_at ASC').all(hubId) as HubFile[];
}

export function getFileById(db: Database.Database, id: number): HubFile | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as HubFile | undefined;
}

export function getFileByStoredName(db: Database.Database, storedName: string): HubFile | undefined {
  return db.prepare('SELECT * FROM files WHERE stored_name = ?').get(storedName) as HubFile | undefined;
}

export function deleteFile(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
}

// ─── analytics ────────────────────────────────────────────────────────────────

export function logHubAccess(
  db: Database.Database,
  hubId: number,
  deviceHint: string | null = null
): void {
  try {
    db.prepare(`INSERT INTO hub_access_log (hub_id, device_hint) VALUES (?, ?)`).run(hubId, deviceHint);
  } catch { /* non-critical */ }
}

export function logLinkClick(db: Database.Database, hubId: number, linkUrl: string): void {
  try {
    db.prepare(`INSERT INTO link_click_log (hub_id, link_url) VALUES (?, ?)`).run(hubId, linkUrl);
  } catch { /* non-critical */ }
}

export function getHubAccessStats(db: Database.Database, hubId: number): AccessStats {
  const total = (db.prepare('SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ?').get(hubId) as { count: number }).count;
  const today = (db.prepare(`SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ? AND date(accessed_at) = date('now')`).get(hubId) as { count: number }).count;
  const last10 = (db.prepare(`SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ? AND accessed_at >= datetime('now', '-10 minutes')`).get(hubId) as { count: number }).count;
  const thisWeek = (db.prepare(`SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ? AND accessed_at >= datetime('now', '-7 days')`).get(hubId) as { count: number }).count;
  const peakRow = db.prepare(
    `SELECT strftime('%H', accessed_at) as hour, COUNT(*) as count FROM hub_access_log WHERE hub_id = ? GROUP BY hour ORDER BY count DESC LIMIT 1`
  ).get(hubId) as { hour: string; count: number } | undefined;
  const peakHour = peakRow ? parseInt(peakRow.hour, 10) : 0;
  const deviceRows = db.prepare(
    `SELECT device_hint, COUNT(*) as count FROM hub_access_log WHERE hub_id = ? GROUP BY device_hint`
  ).all(hubId) as Array<{ device_hint: string | null; count: number }>;
  const device_breakdown = { mobile: 0, desktop: 0, unknown: 0 };
  for (const row of deviceRows) {
    if (row.device_hint === 'mobile') device_breakdown.mobile = row.count;
    else if (row.device_hint === 'desktop') device_breakdown.desktop = row.count;
    else device_breakdown.unknown += row.count;
  }
  return { total_accesses: total, accesses_today: today, accesses_last_10_min: last10, accesses_this_week: thisWeek, peak_hour: peakHour, device_breakdown };
}

export function getLinkClickStats(db: Database.Database, hubId: number): LinkClickStat[] {
  return db.prepare(`
    SELECT lcl.link_url as url,
           COALESCE(l.title, lcl.link_url) as title,
           COUNT(*) as clicks
    FROM link_click_log lcl
    LEFT JOIN links l ON l.hub_id = lcl.hub_id AND l.url = lcl.link_url
    WHERE lcl.hub_id = ?
    GROUP BY lcl.link_url ORDER BY clicks DESC
  `).all(hubId) as LinkClickStat[];
}

export function getFormSubmissionRate(db: Database.Database, hubId: number): number {
  const accesses = (db.prepare('SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ?').get(hubId) as { count: number }).count;
  if (accesses === 0) return 0;
  const form = db.prepare('SELECT id FROM forms WHERE hub_id = ?').get(hubId) as { id: number } | undefined;
  if (!form) return 0;
  const submissions = (db.prepare('SELECT COUNT(*) as count FROM form_responses WHERE form_id = ?').get(form.id) as { count: number }).count;
  return Math.round((submissions / accesses) * 100);
}

export function getHubAccessByDay(
  db: Database.Database,
  hubId: number
): Array<{ date: string; count: number }> {
  return db.prepare(`
    SELECT date(accessed_at) as date, COUNT(*) as count
    FROM hub_access_log
    WHERE hub_id = ? AND accessed_at >= date('now', '-6 days')
    GROUP BY date(accessed_at)
  `).all(hubId) as Array<{ date: string; count: number }>;
}

export function getTodayAccessCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) as c FROM hub_access_log WHERE date(accessed_at) = date('now')`).get() as { c: number }).c;
}

export function getTodayAccessCountByHub(db: Database.Database): Map<number, number> {
  const rows = db.prepare(
    `SELECT hub_id, COUNT(*) as c FROM hub_access_log WHERE date(accessed_at) = date('now') GROUP BY hub_id`
  ).all() as Array<{ hub_id: number; c: number }>;
  return new Map(rows.map((r) => [r.hub_id, r.c]));
}

export function getSchoolWideStats(db: Database.Database): SchoolWideStats {
  const total_hubs = (db.prepare('SELECT COUNT(*) as count FROM hubs').get() as { count: number }).count;
  const accesses_today = (db.prepare(`SELECT COUNT(*) as count FROM hub_access_log WHERE date(accessed_at) = date('now')`).get() as { count: number }).count;
  const form_submissions_today = (db.prepare(`SELECT COUNT(*) as count FROM form_responses WHERE date(submitted_at) = date('now')`).get() as { count: number }).count;
  const most_accessed_hub_today = db.prepare(`
    SELECT h.code, h.label, COUNT(hal.id) as count
    FROM hub_access_log hal JOIN hubs h ON h.id = hal.hub_id
    WHERE date(hal.accessed_at) = date('now')
    GROUP BY h.id ORDER BY count DESC LIMIT 1
  `).get() as { code: string; label: string; count: number } | null ?? null;
  const hub_table = db.prepare(`
    SELECT h.code, h.label,
      SUM(CASE WHEN date(hal.accessed_at) = date('now') THEN 1 ELSE 0 END) as accesses_today,
      COUNT(hal.id) as total_accesses
    FROM hubs h LEFT JOIN hub_access_log hal ON hal.hub_id = h.id
    GROUP BY h.id ORDER BY accesses_today DESC, total_accesses DESC
  `).all() as SchoolWideStats['hub_table'];
  const teacher_leaderboard = db.prepare(`
    SELECT u.name, COUNT(hal.id) as accesses_today
    FROM hub_access_log hal
    JOIN hubs h ON h.id = hal.hub_id
    JOIN users u ON u.id = h.owner_id
    WHERE date(hal.accessed_at) = date('now')
    GROUP BY u.id ORDER BY accesses_today DESC LIMIT 5
  `).all() as SchoolWideStats['teacher_leaderboard'];
  return { total_hubs, accesses_today, form_submissions_today, most_accessed_hub_today, hub_table, teacher_leaderboard };
}

// ─── activity ─────────────────────────────────────────────────────────────────

export function logActivity(
  db: Database.Database,
  userId: number | null,
  action: string,
  detail: string | null = null
): void {
  try {
    db.prepare(
      `INSERT INTO activity_log (user_id, action, detail, created_at) VALUES (?, ?, ?, datetime('now'))`
    ).run(userId, action, detail);
  } catch { /* non-critical */ }
}

export function getRecentActivity(
  db: Database.Database,
  limit = 10
): Array<ActivityLog & { user_name: string | null }> {
  return db.prepare(`
    SELECT a.*, u.name as user_name FROM activity_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC LIMIT ?
  `).all(limit) as Array<ActivityLog & { user_name: string | null }>;
}