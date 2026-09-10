import type mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { UserModel } from '../domains/auth/auth.model.js';
import { RunModel } from '../domains/dispatch/run.model.js';
import { JobCommentModel, JobModel } from '../domains/jobs/job.model.js';
import { todayInSydney } from '../lib/business-day.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'seed-driver-demo' });

/**
 * Makes the driver surface renderable end to end against a shared environment.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Copying the local database gives real, connected rows, but two things stop a
 * client developer seeing the app work:
 *
 *   1. Every run is dated whenever it happened to be created. A driver opening
 *      the app *today* gets an empty day, which looks like a broken API rather
 *      than an empty schedule.
 *   2. The optional site fields are all unset, so the whole job-detail card —
 *      site contact, gate hours, induction, crane, risk assessment — renders as
 *      blank space. A screen that is never exercised is a screen nobody notices
 *      is wrong.
 *
 * So this re-dates the driver's runs onto today and the days after it, and
 * fills the first day's stops with contrasting values: one ordinary stop, one
 * urgent stop that demands a risk assessment and a site induction. Between them
 * every branch on the job-detail screen has something to draw.
 *
 * Dates are computed in SYDNEY, not UTC. A run sheet is a working day, and for
 * ten hours of every UTC day those two disagree about which day it is.
 *
 * Re-runnable: it retargets and overwrites rather than inserting, so running it
 * again tomorrow simply moves the schedule forward.
 *
 * ⚠️ Refuses to run against production. It rewrites real job dates, which on a
 * live system would silently reschedule work that drivers are relying on.
 *
 *   npm --workspace @plastago/api run seed:driver-demo
 */

/** Sydney-local ISO date, `offset` days after today. */
function dayFromToday(offset: number): string {
  const [y, m, d] = todayInSydney().split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-driver-demo refuses to run with NODE_ENV=production');
  }

  await connectMongo();
  if (!isMongoConnected()) throw new Error('no database connection');

  const driver = await UserModel.findOne({ role: 'driver', status: 'active' }).lean();
  if (!driver) throw new Error('no active driver — run seed:auth first');

  const driverId = driver._id;

  /*
   * Oldest first, so the run the allocator built first becomes today's. That
   * keeps `sequenceForDay` meaningful instead of shuffling the day's order.
   */
  const runs = await RunModel.find({ driverId }).sort({ date: 1, sequenceForDay: 1 }).lean();
  if (runs.length === 0) throw new Error(`no runs assigned to ${driver.name}`);

  // Group by their existing date so a day with two runs stays a day with two.
  const byOriginalDate = new Map<string, typeof runs>();
  for (const run of runs) {
    const bucket = byOriginalDate.get(run.date) ?? [];
    bucket.push(run);
    byOriginalDate.set(run.date, bucket);
  }

  const originalDates = [...byOriginalDate.keys()].sort();
  let movedRuns = 0;
  let movedJobs = 0;
  let todaysJobIds: mongoose.Types.ObjectId[] = [];

  for (const [index, originalDate] of originalDates.entries()) {
    const target = dayFromToday(index);
    const dayRuns = byOriginalDate.get(originalDate) ?? [];

    for (const run of dayRuns) {
      await RunModel.updateOne({ _id: run._id }, { $set: { date: target } });
      movedRuns += 1;

      const result = await JobModel.updateMany(
        { runId: run._id },
        { $set: { readyDate: target } },
      );
      movedJobs += result.modifiedCount;

      if (index === 0) {
        const jobs = await JobModel.find({ runId: run._id }, { _id: 1 }).lean();
        todaysJobIds = [...todaysJobIds, ...jobs.map((job) => job._id)];
      }
    }
  }

  /*
   * The contrast is the point. An "everything false, everything null" stop and
   * an "everything on" stop next to each other means a client developer can see
   * both states without editing the database themselves.
   */
  const [ordinaryId, demandingId] = todaysJobIds;

  if (ordinaryId) {
    await JobModel.updateOne(
      { _id: ordinaryId },
      {
        $set: {
          serviceLevel: 'standard',
          riskAssessmentRequired: false,
          inductionRequired: false,
          craneAvailable: false,
          accessNotes: 'Driveway is steep — reverse in from the western end.',
          gateHours: '6:30am – 4:00pm',
          siteContactName: 'Dave Nguyen',
          siteContactMobile: '0466778899',
          notes: 'Bags stacked behind the garage slab.',
        },
      },
    );
  }

  if (demandingId) {
    await JobModel.updateOne(
      { _id: demandingId },
      {
        $set: {
          serviceLevel: 'urgent',
          riskAssessmentRequired: true,
          inductionRequired: true,
          craneAvailable: true,
          accessNotes: 'Shared access with the lot next door. Do not block the crane pad.',
          gateHours: '7:00am – 3:30pm, site closes for smoko 10:00–10:30',
          siteContactName: 'Sam Farrar',
          siteContactMobile: '0400777666',
          notes: 'Overhead powerlines on the street frontage — assess before lifting.',
        },
      },
    );
  }

  /*
   * `driver` visibility only. The other two audiences are the office talking
   * about the customer and the customer portal thread; neither belongs on a
   * phone, and the driver query filters on this field.
   */
  let messages = 0;
  if (ordinaryId) {
    await JobCommentModel.deleteMany({ jobId: ordinaryId, visibility: 'driver' });
    await JobCommentModel.create([
      {
        jobId: ordinaryId,
        body: 'Builder rang — gate code changed to 1974.',
        author: 'Dean Kelly',
        at: new Date(),
        visibility: 'driver',
        fromDriver: false,
      },
      {
        jobId: ordinaryId,
        body: 'Got it, thanks.',
        author: driver.name,
        at: new Date(),
        visibility: 'driver',
        fromDriver: true,
      },
    ]);
    messages += 2;
  }

  log.info({ movedRuns, movedJobs, messages }, 'driver demo data seeded');

  console.log(`
Driver demo data seeded for "${driver.name}".

  runs re-dated        : ${String(movedRuns)}
  jobs re-dated        : ${String(movedJobs)}
  driver messages      : ${String(messages)}
  today (Sydney)       : ${todayInSydney()}
  stops on today       : ${String(todaysJobIds.length)}

Re-run this whenever the schedule goes stale — it moves the days forward.
`);
}

try {
  await seed();
} finally {
  await disconnectMongo();
}
