import { Request, Response, NextFunction } from 'express';
import { getDb, getSession, updateLastActive } from '../db';
import type { User } from '../db';

export const SESSION_COOKIE = 'lode_session';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const sessionId = req.cookies[SESSION_COOKIE] as string | undefined;
  if (!sessionId) { next(); return; }
  let db;
  try {
    db = getDb();
    const user = getSession(db, sessionId);
    if (user) {
      req.user = user;
      updateLastActive(db, user.id);
    }
  } catch { /* ignore session errors */ } finally {
    if (db) db.close();
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.redirect(302, '/login'); return; }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') { res.redirect(302, '/login'); return; }
  next();
}

export function requireTeacher(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'teacher')) {
    res.redirect(302, '/login');
    return;
  }
  next();
}
