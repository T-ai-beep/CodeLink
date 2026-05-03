import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

const DB_DIR = path.join(os.homedir(), '.educode');
const DB_PATH = path.join(DB_DIR, 'educode.db');

export interface School {
  id: number;
  name: string;
  domain: string | null;
  branding_logo: string | null;
  branding_color: string;
  created_at: string;
  broadcast_msg: string | null;
}

export type UserRole = 'admin' | 'teacher' | 'officer';

export interface User {
  id: number;
  school_id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  name: string;
  created_at: string;
  last_active: string | null;
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
  school_id: number | null;
  user_id: number | null;
  status: string;
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

export interface NewHub {
  code: string;
  label: string;
}

export interface NewLink {
  title: string;
  url: string;
}

export type FieldType = 'short_text' | 'long_text' | 'multiple_choice' | 'checkbox' | 'dropdown' | 'date' | 'name' | 'email' | 'number' | 'phone';

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

function openDb(): Database.Database {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS schools (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      domain          TEXT    NULL,
      branding_logo   TEXT    NULL,
      branding_color  TEXT    NOT NULL DEFAULT '#000000',
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_active   TEXT    NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_id      INTEGER NOT NULL REFERENCES hubs(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      filename    TEXT    NOT NULL,
      stored_name TEXT    NOT NULL,
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
  `);
}

function migrateSchema(db: Database.Database): void {
  const cols = db.pragma('table_info(hubs)') as Array<{ name: string }>;
  const colNames = cols.map((c) => c.name);
  if (!colNames.includes('expires_at')) {
    db.exec('ALTER TABLE hubs ADD COLUMN expires_at INTEGER');
  }
  if (!colNames.includes('fallback_msg')) {
    db.exec('ALTER TABLE hubs ADD COLUMN fallback_msg TEXT');
  }
  if (!colNames.includes('school_id')) {
    db.exec('ALTER TABLE hubs ADD COLUMN school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE');
  }
  if (!colNames.includes('user_id')) {
    db.exec('ALTER TABLE hubs ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!colNames.includes('status')) {
    db.exec("ALTER TABLE hubs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!colNames.includes('category')) {
    db.exec('ALTER TABLE hubs ADD COLUMN category TEXT');
  }
  if (!colNames.includes('notes')) {
    db.exec('ALTER TABLE hubs ADD COLUMN notes TEXT');
  }
  const schoolCols = db.pragma('table_info(schools)') as Array<{ name: string }>;
  const schoolColNames = schoolCols.map(c => c.name);
  if (!schoolColNames.includes('broadcast_msg')) {
    db.exec('ALTER TABLE schools ADD COLUMN broadcast_msg TEXT');
  }
}

export function getDb(): Database.Database {
  const db = openDb();
  initSchema(db);
  migrateSchema(db);
  return db;
}

export function hubExists(db: Database.Database, code: string): boolean {
  const row = db.prepare('SELECT id FROM hubs WHERE code = ?').get(code.toUpperCase());
  return row !== undefined;
}

export function createHub(db: Database.Database, hub: NewHub, links: NewLink[]): Hub {
  const insertHub = db.prepare(`
    INSERT INTO hubs (code, label, created_at, updated_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `);

  const insertLink = db.prepare(`
    INSERT INTO links (hub_id, title, url, order_index)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    const result = insertHub.run(hub.code.toUpperCase(), hub.label);
    const hubId = result.lastInsertRowid as number;

    links.forEach((link, index) => {
      insertLink.run(hubId, link.title, link.url, index);
    });

    return db.prepare('SELECT * FROM hubs WHERE id = ?').get(hubId) as Hub;
  });

  return transaction();
}

export function getAllHubs(db: Database.Database): Hub[] {
  return db.prepare('SELECT * FROM hubs ORDER BY updated_at DESC').all() as Hub[];
}

export function getHubByCode(db: Database.Database, code: string): Hub | undefined {
  return db.prepare('SELECT * FROM hubs WHERE code = ?').get(code.toUpperCase()) as Hub | undefined;
}

export function getLinksByHubId(db: Database.Database, hubId: number): Link[] {
  return db
    .prepare('SELECT * FROM links WHERE hub_id = ? ORDER BY order_index ASC')
    .all(hubId) as Link[];
}

export function getHubWithLinks(db: Database.Database, code: string): HubWithLinks | undefined {
  const hub = getHubByCode(db, code);
  if (!hub) {
    return undefined;
  }
  const links = getLinksByHubId(db, hub.id);
  return { ...hub, links };
}

export function updateHub(
  db: Database.Database,
  hubId: number,
  label: string,
  links: NewLink[]
): void {
  const updateHubStmt = db.prepare(`
    UPDATE hubs SET label = ?, updated_at = datetime('now') WHERE id = ?
  `);

  const deleteLinks = db.prepare('DELETE FROM links WHERE hub_id = ?');

  const insertLink = db.prepare(`
    INSERT INTO links (hub_id, title, url, order_index)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    updateHubStmt.run(label, hubId);
    deleteLinks.run(hubId);
    links.forEach((link, index) => {
      insertLink.run(hubId, link.title, link.url, index);
    });
  });

  transaction();
}

export function updateHubExpiry(
  db: Database.Database,
  hubId: number,
  expiresAt: number,
  fallbackMsg: string
): void {
  db.prepare('UPDATE hubs SET expires_at = ?, fallback_msg = ? WHERE id = ?')
    .run(expiresAt, fallbackMsg, hubId);
}

export function clearHubExpiry(db: Database.Database, hubId: number): void {
  db.prepare('UPDATE hubs SET expires_at = NULL, fallback_msg = NULL WHERE id = ?')
    .run(hubId);
}

export function isHubExpired(hub: Hub): boolean {
  if (hub.expires_at === null) return false;
  return Math.floor(Date.now() / 1000) > hub.expires_at;
}

export function deleteHub(db: Database.Database, hubId: number): void {
  db.prepare('DELETE FROM hubs WHERE id = ?').run(hubId);
}

export function createForm(
  db: Database.Database,
  hubId: number,
  title: string,
  description: string | null,
  fields: NewFormField[]
): Form {
  const insertForm = db.prepare(`
    INSERT INTO forms (hub_id, title, description, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `);
  const insertField = db.prepare(`
    INSERT INTO form_fields (form_id, label, type, required, options, order_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    const result = insertForm.run(hubId, title, description);
    const formId = result.lastInsertRowid as number;
    fields.forEach((f, idx) => {
      insertField.run(
        formId, f.label, f.type, f.required ? 1 : 0,
        f.options ? JSON.stringify(f.options) : null,
        idx
      );
    });
    return db.prepare('SELECT * FROM forms WHERE id = ?').get(formId) as Form;
  });
  return tx();
}

export function getFormByHubId(db: Database.Database, hubId: number): Form | undefined {
  return db.prepare('SELECT * FROM forms WHERE hub_id = ?').get(hubId) as Form | undefined;
}

export function getFormWithFields(db: Database.Database, formId: number): FormWithFields | undefined {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(formId) as Form | undefined;
  if (!form) return undefined;
  const fields = db
    .prepare('SELECT * FROM form_fields WHERE form_id = ? ORDER BY order_index ASC')
    .all(formId) as FormField[];
  return { ...form, fields };
}

export function updateForm(
  db: Database.Database,
  formId: number,
  title: string,
  description: string | null,
  fields: NewFormField[]
): void {
  const updateFormStmt = db.prepare(
    `UPDATE forms SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const deleteFields = db.prepare('DELETE FROM form_fields WHERE form_id = ?');
  const insertField = db.prepare(`
    INSERT INTO form_fields (form_id, label, type, required, options, order_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    updateFormStmt.run(title, description, formId);
    deleteFields.run(formId);
    fields.forEach((f, idx) => {
      insertField.run(
        formId, f.label, f.type, f.required ? 1 : 0,
        f.options ? JSON.stringify(f.options) : null,
        idx
      );
    });
  });
  tx();
}

export function deleteForm(db: Database.Database, formId: number): void {
  db.prepare('DELETE FROM forms WHERE id = ?').run(formId);
}

export function deleteFormFields(db: Database.Database, formId: number): void {
  db.prepare('DELETE FROM form_fields WHERE form_id = ?').run(formId);
}

export function saveFormResponse(
  db: Database.Database,
  formId: number,
  answers: Array<{ fieldId: number; value: string }>
): void {
  const insertResp = db.prepare(
    `INSERT INTO form_responses (form_id, submitted_at) VALUES (?, datetime('now'))`
  );
  const insertAnswer = db.prepare(
    `INSERT INTO form_answers (response_id, field_id, value) VALUES (?, ?, ?)`
  );
  const tx = db.transaction(() => {
    const result = insertResp.run(formId);
    const responseId = result.lastInsertRowid as number;
    answers.forEach((a) => insertAnswer.run(responseId, a.fieldId, a.value));
  });
  tx();
}

export function getFormResponses(db: Database.Database, formId: number): FormResponse[] {
  return db
    .prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY submitted_at ASC')
    .all(formId) as FormResponse[];
}

export function getFormResponsesWithAnswers(
  db: Database.Database,
  formId: number
): FormResponseWithAnswers[] {
  const responses = getFormResponses(db, formId);
  return responses.map((r) => {
    const answers = db
      .prepare('SELECT * FROM form_answers WHERE response_id = ?')
      .all(r.id) as FormAnswer[];
    return { ...r, answers };
  });
}

export function getResponseCount(db: Database.Database, formId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM form_responses WHERE form_id = ?')
    .get(formId) as { count: number };
  return row.count;
}

export function addFormField(db: Database.Database, formId: number, field: NewFormField): void {
  db.prepare(`
    INSERT INTO form_fields (form_id, label, type, required, options, order_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    formId, field.label, field.type, field.required ? 1 : 0,
    field.options ? JSON.stringify(field.options) : null,
    field.order_index
  );
}

// ─── schools ─────────────────────────────────────────────────────────────────

export function createSchool(db: Database.Database, name: string, domain: string | null): School {
  const result = db.prepare(
    `INSERT INTO schools (name, domain) VALUES (?, ?)`
  ).run(name, domain);
  return db.prepare('SELECT * FROM schools WHERE id = ?').get(result.lastInsertRowid) as School;
}

export function getSchoolById(db: Database.Database, id: number): School | undefined {
  return db.prepare('SELECT * FROM schools WHERE id = ?').get(id) as School | undefined;
}

export function updateSchoolProfile(db: Database.Database, schoolId: number, name: string, color: string): void {
  db.prepare('UPDATE schools SET name = ?, branding_color = ? WHERE id = ?').run(name, color, schoolId);
}

export function updateSchoolBroadcast(db: Database.Database, schoolId: number, msg: string | null): void {
  db.prepare('UPDATE schools SET broadcast_msg = ? WHERE id = ?').run(msg, schoolId);
}

export function getSchoolByHubId(db: Database.Database, hubId: number): School | undefined {
  return db.prepare(`
    SELECT s.* FROM schools s
    JOIN hubs h ON h.school_id = s.id
    WHERE h.id = ?
  `).get(hubId) as School | undefined;
}

export function setHubStatus(db: Database.Database, hubId: number, status: string): void {
  db.prepare('UPDATE hubs SET status = ? WHERE id = ?').run(status, hubId);
}

export function getRecentActivity(db: Database.Database, schoolId: number): ActivityItem[] {
  const accesses = db.prepare(`
    SELECT 'access' as type, h.code as hub_code, h.label as hub_label, hal.accessed_at as occurred_at
    FROM hub_access_log hal
    JOIN hubs h ON h.id = hal.hub_id
    WHERE h.school_id = ?
    ORDER BY hal.accessed_at DESC
    LIMIT 20
  `).all(schoolId) as ActivityItem[];
  const submissions = db.prepare(`
    SELECT 'form_submission' as type, h.code as hub_code, h.label as hub_label, fr.submitted_at as occurred_at
    FROM form_responses fr
    JOIN forms f ON f.id = fr.form_id
    JOIN hubs h ON h.id = f.hub_id
    WHERE h.school_id = ?
    ORDER BY fr.submitted_at DESC
    LIMIT 20
  `).all(schoolId) as ActivityItem[];
  return [...accesses, ...submissions]
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, 20);
}

export function updateSchoolBranding(
  db: Database.Database,
  schoolId: number,
  logo: string | null,
  color: string
): void {
  db.prepare('UPDATE schools SET branding_logo = ?, branding_color = ? WHERE id = ?')
    .run(logo, color, schoolId);
}

export function schoolExists(db: Database.Database): boolean {
  return db.prepare('SELECT id FROM schools LIMIT 1').get() !== undefined;
}

// ─── users ────────────────────────────────────────────────────────────────────

export function createUser(
  db: Database.Database,
  schoolId: number,
  email: string,
  passwordHash: string,
  role: UserRole,
  name: string
): User {
  const result = db.prepare(
    `INSERT INTO users (school_id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)`
  ).run(schoolId, email, passwordHash, role, name);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as User;
}

export function getUserByEmail(db: Database.Database, email: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
}

export function getUserById(db: Database.Database, id: number): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUsersBySchool(db: Database.Database, schoolId: number): User[] {
  return db.prepare('SELECT * FROM users WHERE school_id = ? ORDER BY name ASC').all(schoolId) as User[];
}

export function updateUserRole(db: Database.Database, userId: number, role: UserRole): void {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function deleteUser(db: Database.Database, userId: number): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

export function updateLastActive(db: Database.Database, userId: number): void {
  db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(userId);
}

// ─── sessions ─────────────────────────────────────────────────────────────────

export function createSession(db: Database.Database, userId: number): string {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(id, userId, expiresAt);
  return id;
}

export function getSession(db: Database.Database, sessionId: string): User | undefined {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as Session | undefined;
  if (!session) return undefined;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return undefined;
  }
  return getUserById(db, session.user_id);
}

export function deleteSession(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
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
  const result = db.prepare(
    `INSERT INTO files (hub_id, user_id, filename, stored_name, mimetype, size) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hubId, userId, filename, storedName, mimetype, size);
  return db.prepare('SELECT * FROM files WHERE id = ?').get(result.lastInsertRowid) as HubFile;
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

// ─── analytics tables (added to initSchema via migrateSchema-style check) ────
// Tables created in initSchema above; functions here.

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

export interface ActivityItem {
  type: string;
  hub_code: string;
  hub_label: string;
  occurred_at: string;
}

export function logHubAccess(db: Database.Database, hubId: number, deviceHint: string | null): void {
  db.prepare(`INSERT INTO hub_access_log (hub_id, device_hint) VALUES (?, ?)`).run(hubId, deviceHint);
}

export function logLinkClick(db: Database.Database, hubId: number, linkUrl: string): void {
  db.prepare(`INSERT INTO link_click_log (hub_id, link_url) VALUES (?, ?)`).run(hubId, linkUrl);
}

export function getHubAccessStats(db: Database.Database, hubId: number): AccessStats {
  const total = (db.prepare('SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ?').get(hubId) as { count: number }).count;
  const today = (db.prepare("SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ? AND date(accessed_at) = date('now')").get(hubId) as { count: number }).count;
  const last10 = (db.prepare("SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ? AND accessed_at >= datetime('now', '-10 minutes')").get(hubId) as { count: number }).count;
  const thisWeek = (db.prepare("SELECT COUNT(*) as count FROM hub_access_log WHERE hub_id = ? AND accessed_at >= datetime('now', '-7 days')").get(hubId) as { count: number }).count;
  const peakRow = db.prepare("SELECT strftime('%H', accessed_at) as hour, COUNT(*) as count FROM hub_access_log WHERE hub_id = ? GROUP BY hour ORDER BY count DESC LIMIT 1").get(hubId) as { hour: string; count: number } | undefined;
  const peakHour = peakRow ? parseInt(peakRow.hour, 10) : 0;
  const deviceRows = db.prepare("SELECT device_hint, COUNT(*) as count FROM hub_access_log WHERE hub_id = ? GROUP BY device_hint").all(hubId) as Array<{ device_hint: string | null; count: number }>;
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
    GROUP BY lcl.link_url
    ORDER BY clicks DESC
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

export function getHubAccessByDay(db: Database.Database, hubId: number): Array<{ date: string; count: number }> {
  return db.prepare(`
    SELECT date(accessed_at) as date, COUNT(*) as count
    FROM hub_access_log
    WHERE hub_id = ? AND accessed_at >= date('now', '-6 days')
    GROUP BY date(accessed_at)
  `).all(hubId) as Array<{ date: string; count: number }>;
}

export function getSchoolWideStats(db: Database.Database, schoolId: number): SchoolWideStats {
  const total_hubs = (db.prepare("SELECT COUNT(*) as count FROM hubs WHERE school_id = ?").get(schoolId) as { count: number }).count;
  const accesses_today = (db.prepare(`
    SELECT COUNT(*) as count FROM hub_access_log hal
    JOIN hubs h ON h.id = hal.hub_id
    WHERE h.school_id = ? AND date(hal.accessed_at) = date('now')
  `).get(schoolId) as { count: number }).count;
  const form_submissions_today = (db.prepare(`
    SELECT COUNT(*) as count FROM form_responses fr
    JOIN forms f ON f.id = fr.form_id
    JOIN hubs h ON h.id = f.hub_id
    WHERE h.school_id = ? AND date(fr.submitted_at) = date('now')
  `).get(schoolId) as { count: number }).count;
  const most_accessed_hub_today = db.prepare(`
    SELECT h.code, h.label, COUNT(hal.id) as count
    FROM hub_access_log hal
    JOIN hubs h ON h.id = hal.hub_id
    WHERE h.school_id = ? AND date(hal.accessed_at) = date('now')
    GROUP BY h.id ORDER BY count DESC LIMIT 1
  `).get(schoolId) as { code: string; label: string; count: number } | null ?? null;
  const hub_table = db.prepare(`
    SELECT h.code, h.label,
      SUM(CASE WHEN date(hal.accessed_at) = date('now') THEN 1 ELSE 0 END) as accesses_today,
      COUNT(hal.id) as total_accesses
    FROM hubs h
    LEFT JOIN hub_access_log hal ON hal.hub_id = h.id
    WHERE h.school_id = ?
    GROUP BY h.id ORDER BY accesses_today DESC, total_accesses DESC
  `).all(schoolId) as SchoolWideStats['hub_table'];
  const teacher_leaderboard = db.prepare(`
    SELECT u.name, COUNT(hal.id) as accesses_today
    FROM hub_access_log hal
    JOIN hubs h ON h.id = hal.hub_id
    JOIN users u ON u.id = h.user_id
    WHERE h.school_id = ? AND date(hal.accessed_at) = date('now')
    GROUP BY u.id ORDER BY accesses_today DESC LIMIT 5
  `).all(schoolId) as SchoolWideStats['teacher_leaderboard'];
  return { total_hubs, accesses_today, form_submissions_today, most_accessed_hub_today, hub_table, teacher_leaderboard };
}
