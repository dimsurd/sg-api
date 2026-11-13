import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool } from '../db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import {
  CLIENT_ROLES,
  cookieName,
  currentUser,
  requireAuth,
  resolveClient,
  signToken,
  type Role,
} from '../middleware/auth.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const client = resolveClient(req);

  const user = await one<{
    id: string;
    email: string;
    full_name: string;
    role: Role;
    password_hash: string;
    is_active: boolean;
  }>(pool, 'SELECT id, email, full_name, role, password_hash, is_active FROM users WHERE email = $1', [email]);

  // Same message for unknown email and wrong password (no account enumeration).
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    throw unauthorized('Incorrect email or password');
  }
  if (!CLIENT_ROLES[client].includes(user.role)) {
    throw forbidden(
      client === 'backoffice'
        ? 'The back office is for admins only. Tutors and students use the Star Generation app.'
        : 'Admins sign in through the back office.',
    );
  }

  const authUser = { id: user.id, role: user.role, email: user.email, fullName: user.full_name };
  // The session lives only in an httpOnly cookie; the token is never exposed to JS.
  res.cookie(cookieName(client), signToken(authUser), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.jwtTtlSeconds * 1000,
    path: '/',
  });
  res.json({ user: authUser });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie(cookieName(resolveClient(req)), { path: '/' });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: currentUser(req) });
});
