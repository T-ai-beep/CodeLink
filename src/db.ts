import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.educode');
const DB_PATH = path.join(DB_DIR, 'educode.db');

export interface Hub {
  id: number;
  code: string;
  label: string;
  created_at: string;
  updated_at: string;
  expires_at: number | null;
  fallback_msg: string | null;
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

export type FieldType = 'short_text' | 'long_text' | 'multiple_choice' | 'checkbox';

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
