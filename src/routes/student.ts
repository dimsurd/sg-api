import { Router } from 'express';
import { z } from 'zod';
import { idParams, packageHours, uuid } from '../lib/validation.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import * as assistant from '../services/assistant.js';
import * as billing from '../services/billing.js';
import * as classes from '../services/classes.js';
import * as lessons from '../services/lessons.js';
import * as logbooks from '../services/logbooks.js';

export const studentRouter = Router();
studentRouter.use(requireRole('student'));

// Catalogue & enrollment -----------------------------------------------------
studentRouter.get('/classes/available', async (req, res) => {
  res.json(await classes.studentCatalogue(currentUser(req).id, classes.catalogueQuerySchema.parse(req.query)));
});
studentRouter.post('/enrollments', async (req, res) => {
  const { classId, hours } = z.object({ classId: uuid, hours: packageHours.optional() }).parse(req.body);
  res.status(201).json(await billing.enroll(currentUser(req).id, classId, hours));
});
studentRouter.post('/enrollments/:id/packages', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { hours } = billing.packageSchema.parse(req.body ?? {});
  res.status(201).json({ invoice: await billing.buyPackage(currentUser(req), id, hours) });
});

// AI class advisor (optional; enabled when an LLM key is configured) ----------
studentRouter.get('/assistant', (_req, res) => {
  res.json(assistant.assistantStatus());
});
studentRouter.post('/assistant', async (req, res) => {
  res.json(await assistant.advise(currentUser(req), assistant.assistantRequestSchema.parse(req.body)));
});

// Invoices -------------------------------------------------------------------
studentRouter.get('/invoices', async (req, res) => {
  res.json({ invoices: await billing.studentInvoices(currentUser(req).id) });
});
/** Simulated payment — no gateway. Recorded with a SIMULATED reference. */
studentRouter.post('/invoices/:id/pay', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const reference = `SIMULATED-${Date.now()}`;
  res.json(await billing.markPaid(currentUser(req), id, reference));
});

// Paid classes only ----------------------------------------------------------
studentRouter.get('/classes', async (req, res) => {
  res.json({ classes: await classes.studentMyClasses(currentUser(req).id) });
});
studentRouter.get('/classes/:id/schedule', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const enrollmentId = await classes.assertStudentPaidClass(currentUser(req).id, id);
  res.json({ lessons: await lessons.studentSchedule(enrollmentId, id) });
});
studentRouter.get('/classes/:id/logbooks', async (req, res) => {
  const { id } = idParams.parse(req.params);
  await classes.assertStudentPaidClass(currentUser(req).id, id);
  res.json({ logbooks: await logbooks.studentLogbooks(id) });
});
