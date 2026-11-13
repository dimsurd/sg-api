import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export type Role = 'admin' | 'tutor' | 'student';
export type Client = 'app' | 'backoffice';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
  fullName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Two frontends share the same host in development (localhost:3000 / :3001),
 * and browsers scope cookies by host, not port. Each client therefore gets its
 * own cookie name, so an admin session in the back office and a student
 * session in the PWA can coexist in one browser.
 */
export const CLIENT_ROLES: Record<Client, Role[]> = {
  app: ['tutor', 'student'],
  backoffice: ['admin'],
};

export function cookieName(client: Client): string {
  return client === 'backoffice' ? 'sg_bo_session' : 'sg_app_session';
}

export function resolveClient(req: Request): Client {
  return req.get('x-sg-client') === 'backoffice' ? 'backoffice' : 'app';
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email, name: user.fullName }, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
  });
}

function readToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.cookies?.[cookieName(resolveClient(req))];
}

/** Attaches req.user when a valid token is present. Never rejects. */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      req.user = {
        id: String(payload.sub),
        role: payload.role as Role,
        email: String(payload.email),
        fullName: String(payload.name),
      };
    } catch {
      // invalid/expired token -> treated as anonymous
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Use inside handlers after requireRole — narrows req.user to non-null. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
