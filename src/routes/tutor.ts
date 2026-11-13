import { Router } from 'express';
import { z } from 'zod';
import { idParams, monthParam, uuid } from '../lib/validation.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import * as classes from '../services/classes.js';
import * as lessons from '../services/lessons.js';
import * as logbooks from '../services/logbooks.js';
import * as reports from '../services/reports.js';

export const tutorRouter = Router();
tutorRouter.use(requireRole('tutor'));

// Classes (assigned only; no student rates) ----------------------------------
tutorRouter.get('/classes', async (req, res) => {
  res.json({ classes: await classes.tutorListClasses(currentUser(req).id) });
});
tutorRouter.get('/classes/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ class: await classes.tutorGetClass(currentUser(req).id, id) });
});

// Lessons --------------------------------------------------------------------
tutorRouter.get('/lessons', async (req, res) => {
  res.json({ lessons: await lessons.tutorLessons(currentUser(req).id, lessons.lessonQuerySchema.parse(req.query)) });
});
tutorRouter.post('/lessons', async (req, res) => {
  const input = lessons.createLessonSchema.parse(req.body);
  res.status(201).json(await lessons.scheduleLesson(currentUser(req), input));
});
tutorRouter.patch('/lessons/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await lessons.rescheduleLesson(currentUser(req), id, lessons.lessonTimesSchema.parse(req.body)));
});
tutorRouter.post('/lessons/:id/cancel', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { reason } = lessons.cancelLessonSchema.parse(req.body);
  res.json(await lessons.cancelLesson(currentUser(req), id, reason));
});

// Logbooks -------------------------------------------------------------------
const monthRoute = z.object({ classId: uuid, month: monthParam });

tutorRouter.get('/logbooks', async (req, res) => {
  res.json({ logbooks: await logbooks.tutorLogbookList(currentUser(req).id) });
});
tutorRouter.get('/classes/:classId/logbooks/:month', async (req, res) => {
  const { classId, month } = monthRoute.parse(req.params);
  res.json({ logbook: await logbooks.tutorLogbookMonth(currentUser(req).id, classId, month) });
});
tutorRouter.put('/classes/:classId/logbooks/:month/entries/:lessonId', async (req, res) => {
  const { classId, month, lessonId } = monthRoute.extend({ lessonId: uuid }).parse(req.params);
  const input = logbooks.entrySchema.parse(req.body);
  res.json({ entry: await logbooks.upsertEntry(currentUser(req), classId, month, lessonId, input) });
});
tutorRouter.post('/classes/:classId/logbooks/:month/submit', async (req, res) => {
  const { classId, month } = monthRoute.parse(req.params);
  res.json(await logbooks.submitLogbook(currentUser(req), classId, month));
});

// Earnings (own only) --------------------------------------------------------
tutorRouter.get('/earnings', async (req, res) => {
  res.json(await reports.earnings({ tutorId: currentUser(req).id }));
});
