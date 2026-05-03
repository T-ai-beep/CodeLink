#!/usr/bin/env node
import bcrypt from 'bcrypt';
import {
  getDb, schoolExists, createSchool, createUser,
  createForm, saveFormResponse, logLinkClick,
} from './db';
import type { NewFormField } from './db';
import Database from 'better-sqlite3';

function insertHub(
  db: Database.Database,
  schoolId: number,
  userId: number,
  code: string,
  label: string,
  category: string,
  daysOld: number,
  expiresAt?: number,
  fallbackMsg?: string
): number {
  const extra = expiresAt
    ? `, ${expiresAt}, '${fallbackMsg?.replace(/'/g, "''") ?? ''}'`
    : ', NULL, NULL';
  const row = db.prepare(`
    INSERT INTO hubs (code, label, school_id, user_id, status, category, expires_at, fallback_msg, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ${expiresAt ?? 'NULL'}, ?, datetime('now',?), datetime('now',?))
    RETURNING id
  `).get(code, label, schoolId, userId, category, fallbackMsg ?? null, `-${daysOld} days`, `-${Math.floor(daysOld / 2)} days`) as { id: number };
  return row.id;
}

function addAccesses(db: Database.Database, hubId: number, daysAgo: number, count: number): void {
  const stmt = db.prepare(
    `INSERT INTO hub_access_log (hub_id, device_hint, accessed_at)
     VALUES (?, ?, datetime('now', ?))`
  );
  const hints = ['mobile', 'desktop', 'mobile', 'mobile', 'desktop', 'unknown', 'mobile'];
  for (let i = 0; i < count; i++) {
    stmt.run(hubId, hints[i % hints.length], `-${daysAgo} days`);
  }
}

async function seed(): Promise<void> {
  const db = getDb();
  try {
    if (schoolExists(db)) {
      console.log('Seed data already exists — skipping.');
      return;
    }

    // School
    const school = createSchool(db, 'Demo High School', 'demo.edu');
    db.prepare("UPDATE schools SET branding_color = '#1d4ed8' WHERE id = ?").run(school.id);

    // Users
    const adminHash = await bcrypt.hash('demo1234', 10);
    createUser(db, school.id, 'admin@demo.edu', adminHash, 'admin', 'Demo Admin');

    const t1Hash = await bcrypt.hash('teacher1', 10);
    const teacher1 = createUser(db, school.id, 'bio@demo.edu', t1Hash, 'teacher', 'Ms. Chen');

    const t2Hash = await bcrypt.hash('teacher2', 10);
    const teacher2 = createUser(db, school.id, 'coding@demo.edu', t2Hash, 'teacher', 'Mr. Okafor');

    // BIO101 hub
    const bioId = insertHub(db, school.id, teacher1.id, 'BIO101', 'Biology 101', 'Science', 30);
    db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?,?,?,?)').run(bioId, 'Khan Academy — Cell Biology', 'https://www.khanacademy.org/science/biology/cell-biology', 0);
    db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?,?,?,?)').run(bioId, 'Lab Report Template', 'https://docs.google.com/document/d/demo', 1);
    db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?,?,?,?)').run(bioId, 'Unit 3 Slides', 'https://slides.google.com/demo', 2);

    // SKN hub
    const sknId = insertHub(db, school.id, teacher2.id, 'SKN', 'Coding Club Signup', 'Clubs', 14);
    db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?,?,?,?)').run(sknId, 'Coding Club — About', 'https://example.com/coding-club', 0);
    db.prepare('INSERT INTO links (hub_id, title, url, order_index) VALUES (?,?,?,?)').run(sknId, 'Scratch Projects Gallery', 'https://scratch.mit.edu', 1);

    const sknFields: NewFormField[] = [
      { label: 'Your Name', type: 'name', required: true, options: null, order_index: 0 },
      { label: 'Year Group', type: 'dropdown', required: true, options: ['Year 9', 'Year 10', 'Year 11', 'Year 12'], order_index: 1 },
      { label: 'Coding experience?', type: 'multiple_choice', required: false, options: ['Yes', 'No', 'A little'], order_index: 2 },
    ];
    const sknForm = createForm(db, sknId, 'Coding Club Interest Form', "Let us know you're interested!", sknFields);
    const sknFf = db.prepare('SELECT id FROM form_fields WHERE form_id=? ORDER BY order_index').all(sknForm.id) as Array<{id: number}>;
    saveFormResponse(db, sknForm.id, [
      { fieldId: sknFf[0].id, value: 'Jamie|Smith' },
      { fieldId: sknFf[1].id, value: 'Year 10' },
      { fieldId: sknFf[2].id, value: 'A little' },
    ]);

    // DANCE hub — expires next Friday
    const nextFriday = new Date();
    nextFriday.setDate(nextFriday.getDate() + ((5 - nextFriday.getDay() + 7) % 7 || 7));
    const danceExpiresAt = Math.floor(nextFriday.getTime() / 1000);
    const danceId = insertHub(db, school.id, teacher2.id, 'DANCE', 'School Dance RSVP', 'Events', 7, danceExpiresAt, 'RSVP is now closed. See you on the dance floor!');

    const danceFields: NewFormField[] = [
      { label: 'Your Name', type: 'name', required: true, options: null, order_index: 0 },
      { label: 'Are you coming?', type: 'multiple_choice', required: true, options: ['Yes!', "No, can't make it", 'Maybe'], order_index: 1 },
      { label: 'Dietary Requirements', type: 'short_text', required: false, options: null, order_index: 2 },
    ];
    const danceForm = createForm(db, danceId, 'Dance RSVP', 'RSVP for the end-of-year school dance!', danceFields);
    const danceFf = db.prepare('SELECT id FROM form_fields WHERE form_id=? ORDER BY order_index').all(danceForm.id) as Array<{id: number}>;
    saveFormResponse(db, danceForm.id, [
      { fieldId: danceFf[0].id, value: 'Alex|Johnson' },
      { fieldId: danceFf[1].id, value: 'Yes!' },
      { fieldId: danceFf[2].id, value: 'Vegetarian' },
    ]);

    // Analytics — ~50 accesses per hub over 7 days
    for (let day = 6; day >= 0; day--) {
      const n = 40 + Math.floor(Math.random() * 20);
      addAccesses(db, bioId, day, n);
      addAccesses(db, sknId, day, Math.floor(n * 0.6));
      addAccesses(db, danceId, day, Math.floor(n * 0.8));
    }

    // Link clicks
    for (let i = 0; i < 30; i++) logLinkClick(db, bioId, 'https://www.khanacademy.org/science/biology/cell-biology');
    for (let i = 0; i < 18; i++) logLinkClick(db, bioId, 'https://docs.google.com/document/d/demo');
    for (let i = 0; i < 22; i++) logLinkClick(db, sknId, 'https://scratch.mit.edu');

    console.log('');
    console.log('Seed complete.');
    console.log('');
    console.log('  School : Demo High School');
    console.log('  Admin  : admin@demo.edu  /  demo1234');
    console.log('  Teacher: bio@demo.edu    /  teacher1  (BIO101)');
    console.log('  Teacher: coding@demo.edu /  teacher2  (SKN, DANCE)');
    console.log('');
    console.log('  Hubs: BIO101 · SKN · DANCE');
    console.log('');
  } finally {
    db.close();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
