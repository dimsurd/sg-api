import { Router } from 'express';
import { z } from 'zod';
import { idParams, monthParam, uuid } from '../lib/validation.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import * as billing from '../services/billing.js';
import * as classes from '../services/classes.js';
import * as lessons from '../services/lessons.js';
import * as logbooks from '../services/logbooks.js';
import * as reports from '../services/reports.js';

export const adminRouter = Router();
adminRouter.use(requireRole('admin'));

// Classes ------------------------------------------------------------------
adminRouter.get('/classes', async (_req, res) => {
  res.json({ classes: await classes.adminListClasses() });
});
adminRouter.get('/classes/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ class: await classes.adminGetClass(id) });
});
adminRouter.post('/classes', async (req, res) => {
  const input = classes.createClassSchema.parse(req.body);
  res.status(201).json({ class: await classes.adminCreateClass(currentUser(req).id, input) });
});
adminRouter.patch('/classes/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const input = classes.updateClassSchema.parse(req.body);
  res.json({ class: await classes.adminUpdateClass(currentUser(req).id, id, input) });
});
adminRouter.get('/tutors', async (_req, res) => {
  res.json({ tutors: await classes.adminListTutors() });
});

// Students & invoices --------------------------------------------------------
adminRouter.get('/students', async (_req, res) => {
  res.json({ students: await billing.adminStudents() });
});

const invoiceQuery = z.object({
  status: z.enum(['unpaid', 'paid', 'void']).optional(),
  classId: uuid.optional(),
  studentId: uuid.optional(),
});
adminRouter.get('/invoices', async (req, res) => {
  res.json({ invoices: await billing.adminInvoices(invoiceQuery.parse(req.query)) });
});
adminRouter.get('/invoices/:id/history', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ history: await billing.invoiceHistory(id) });
});
adminRouter.post('/invoices/:id/mark-paid', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { paymentReference } = billing.markPaidSchema.parse(req.body);
  res.json(await billing.markPaid(currentUser(req), id, paymentReference));
});
adminRouter.post('/invoices/:id/undo-paid', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { reason } = billing.reasonSchema.parse(req.body);
  res.json(await billing.undoPaid(currentUser(req).id, id, reason));
});
adminRouter.post('/invoices/:id/void', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { reason } = billing.reasonSchema.parse(req.body);
  res.json(await billing.voidInvoice(currentUser(req).id, id, reason));
});
adminRouter.post('/enrollments/:id/packages', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { hours } = billing.packageSchema.parse(req.body ?? {});
  res.status(201).json({ invoice: await billing.buyPackage(currentUser(req), id, hours) });
});

// Lessons --------------------------------------------------------------------
adminRouter.get('/lessons', async (req, res) => {
  const q = lessons.lessonQuerySchema.extend({ tutorId: uuid.optional() }).parse(req.query);
  res.json({ lessons: await lessons.adminLessons(q) });
});
adminRouter.post('/lessons/:id/cancel', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { reason } = lessons.cancelLessonSchema.parse(req.body);
  res.json(await lessons.cancelLesson(currentUser(req), id, reason));
});

// Logbooks -------------------------------------------------------------------
const logbookQuery = z.object({ status: z.enum(['draft', 'submitted', 'changes_requested', 'approved']).optional() });
adminRouter.get('/logbooks', async (req, res) => {
  res.json({ logbooks: await logbooks.adminLogbookList(logbookQuery.parse(req.query).status) });
});
adminRouter.get('/logbooks/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ logbook: await logbooks.adminLogbookDetail(id) });
});
adminRouter.post('/logbooks/:id/request-changes', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { comment } = logbooks.requestChangesSchema.parse(req.body);
  res.json(await logbooks.requestChanges(currentUser(req).id, id, comment));
});
adminRouter.post('/logbooks/:id/approve', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { comment } = logbooks.approveSchema.parse(req.body ?? {});
  res.json(await logbooks.approveLogbook(currentUser(req).id, id, comment));
});

// Earnings & reports ---------------------------------------------------------
adminRouter.get('/earnings', async (req, res) => {
  const { tutorId } = z.object({ tutorId: uuid.optional() }).parse(req.query);
  res.json(await reports.earnings({ tutorId }));
});
const overviewQuery = z.object({ month: monthParam.optional(), classId: uuid.optional() });
adminRouter.get('/reports/overview', async (req, res) => {
  res.json(await reports.overview(overviewQuery.parse(req.query)));
});
