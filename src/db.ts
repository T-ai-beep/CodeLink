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

function openDb(): Database.Database {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
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
