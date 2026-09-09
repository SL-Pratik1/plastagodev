import { createDocument, type ZodOpenApiObject } from 'zod-openapi';
import * as z from 'zod';
import { API_PREFIX, API_VERSION } from '../constants.js';
import { LivenessSchema, ReadinessSchema } from '../schemas/health.js';
import {
  OtpChallengeSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  SessionSchema,
} from '../schemas/identity.js';
import { IsoDateSchema, ObjectIdSchema } from '../schemas/primitives.js';
import {
  CompletionSchema,
  ContaminationReportSchema,
  DefectReportSchema,
  DriverJobSchema,
  DriverMessageSchema,
  FutileReportSchema,
  PhotoUploadTicketSchema,
  PresignDocketPhotoSchema,
  PresignPhotoSchema,
  PreStartSubmissionSchema,
  PreviewTipOffSchema,
  RunSheetDaySchema,
  SiteRiskAssessmentSchema,
  StatusUpdateSchema,
  TipOffEntrySchema,
  TipOffReconciliationSchema,
  WeightCaptureSchema,
} from '../schemas/driver.js';
import { errorResponses, jsonResponse } from './helpers.js';

/** Shorthand for a required JSON request body, mirroring `jsonResponse`. */
function jsonBody(schema: z.ZodType) {
  return { content: { 'application/json': { schema } }, required: true };
}

/**
 * The resend body.
 *
 * ⚠️ Declared here rather than in `schemas/identity.ts` only because the
 * contract was frozen before a resend shape was needed — the web app's
 * `resendCode(challengeId)` takes a bare string, so none was ever written. The
 * VALUE is contract-governed (`ObjectIdSchema`); only this one-key envelope is
 * local. `apps/api/src/domains/auth/auth.schemas.ts` carries the same
 * declaration for validation; when the contract next opens, both move into
 * `schemas/identity.ts` as `OtpResendSchema` and this disappears.
 */
const OtpResendSchema = z
  .object({ challengeId: ObjectIdSchema })
  .meta({ id: 'OtpResend' });

/* ── Driver route plumbing ────────────────────────────────────────────────── */

/*
 * Path and query parameters. Declared here rather than imported from
 * `apps/api/src/domains/driver/driver.schemas.ts` because this package cannot
 * depend on an app — and unlike a request body, a path segment is never a shape
 * a generated client models, so there is nothing to keep in step beyond the id
 * format itself, which comes from `ObjectIdSchema` either way.
 */
const RunSheetQuerySchema = z.object({ date: IsoDateSchema });
const JobIdPathSchema = z.object({ jobId: ObjectIdSchema });
const PhotoPathSchema = z.object({ jobId: ObjectIdSchema, photoId: ObjectIdSchema });
const RunIdPathSchema = z.object({ runId: ObjectIdSchema });

/** Every authenticated route carries the same session cookie requirement. */
const signedIn = [{ sessionCookie: [] }];

/**
 * A driver mutation: authenticated, job-scoped, and answering 204.
 *
 * Almost every write in this domain has the same shape — the driver is
 * recording something that happened, and there is nothing to hand back that the
 * phone does not already hold. Returning the mutated job instead would be a
 * round trip the app cannot rely on anyway, because the write may well have
 * been queued offline and replayed hours later.
 */
function driverAction(input: {
  operationId: string;
  summary: string;
  description: string;
  body: z.ZodType;
  path?: z.ZodObject;
  success: string;
}) {
  return {
    post: {
      tags: ['Driver'],
      operationId: input.operationId,
      summary: input.summary,
      description: input.description,
      security: signedIn,
      ...(input.path ? { requestParams: { path: input.path } } : {}),
      requestBody: jsonBody(input.body),
      responses: {
        '204': { description: input.success },
        ...errorResponses('400', '422', '401', '403', '404', '409'),
      },
    },
  };
}

/**
 * The published API contract (§6A.9).
 *
 * Declared HERE, in `@plastago/shared`, rather than inside the Express app — so
 * the spec is an artefact of the contract, not of one server implementation.
 * `apps/api` only writes it to disk; CI publishes it; the Flutter repo pins a
 * version of it and codegens its Dart client from it.
 *
 * Adding an endpoint:
 *   1. Define request/response schemas under `src/schemas/<domain>.ts`.
 *   2. Add the path below.
 *   3. `npm run openapi` — the spec regenerates.
 *   4. After the day-3 freeze, bump API_VERSION on any breaking change.
 */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  const spec: ZodOpenApiObject = {
    openapi: '3.1.0',
    info: {
      title: 'PlastaGo API',
      version: API_VERSION,
      description:
        'Contract shared by the admin console, customer portal, driver PWA and the Flutter ' +
        'driver app. Generated from Zod schemas — do not hand-edit.',
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Local development' },
      { url: 'https://api.plastago.com.au', description: 'Production (placeholder)' },
    ],
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      {
        name: 'Authentication',
        description:
          'Email and SMS one-time codes (§9 A1/A2). No passwords exist in this product. ' +
          'Sign-in is a two-step challenge: request a code, then verify it. The identifier ' +
          'is held server-side against the returned challengeId and is never sent again.',
      },
      {
        name: 'Driver',
        description:
          "The driver's own day (M4). Every route is scoped to the signed-in driver by the " +
          'session alone — no path or query anywhere under /driver identifies a driver, so ' +
          "there is no parameter to change to read someone else's run.\n\n" +
          'Two things apply to the whole tag:\n\n' +
          '1. **Every mutation carries `occurredAt` and `position`.** The app is built to work ' +
          'with no signal, so a payload must say when the DRIVER acted rather than when the ' +
          'server heard about it. A run that syncs at 17:00 otherwise collapses into one ' +
          'timestamp and the on-site durations — which an Extra Load Time charge is computed ' +
          'from — become fiction. `position` is nullable: a driver in a basement car park must ' +
          'still be able to complete a job.\n\n' +
          '2. **Send an `idempotency-key` header on every mutation** (UUID v4, one per queued ' +
          'operation, kept across retries). A phone replaying its outbox must not raise a ' +
          'second $120 futile charge. This IS enforced: a repeat of a key already seen replays ' +
          'the original response verbatim, carrying `idempotent-replay: true`, without running ' +
          'the handler again. A key reused with a DIFFERENT body is refused with 409 — so ' +
          'generate one key per queued operation and keep it across that operation’s retries. ' +
          'Keys are scoped per driver and kept for 7 days, so a phone out of coverage for a ' +
          'weekend is still protected.',
      },
    ],
    components: {
      securitySchemes: {
        /**
         * ⚠️ A COOKIE, not a bearer token. This scheme previously declared
         * `bearerAuth: "Short-lived access token issued after OTP verification"`,
         * which no code has ever issued — `verifyOtp` sets an httpOnly session
         * cookie and `requireAuth` reads it back off the request headers. A
         * generated client that attached an Authorization header would have
         * failed every authenticated call, so the declaration is corrected here
         * rather than left as an aspiration.
         *
         * Consequences for a native client, which has no cookie store of its own:
         * it must persist this cookie across launches (Dart: `dio` +
         * `cookie_jar`), because there is no token to keep instead. If a token
         * is wanted later, Better Auth's `bearer` plugin is the supported route
         * — and this scheme changes with it, in the same commit.
         */
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description:
            'httpOnly session cookie, set by POST /auth/otp/verify and cleared by ' +
            'POST /auth/sign-out. Browsers send it automatically with ' +
            '`credentials: "include"`. A native client must persist it in a cookie jar.',
        },
      },
    },
    paths: {
      '/healthz': {
        get: {
          tags: ['Health'],
          operationId: 'getLiveness',
          summary: 'Liveness probe',
          description: 'Cheap, dependency-free. Used by the platform to decide on a restart.',
          responses: {
            '200': jsonResponse('Process is alive', LivenessSchema),
          },
        },
      },
      '/readyz': {
        get: {
          tags: ['Health'],
          operationId: 'getReadiness',
          summary: 'Readiness probe',
          description: 'Checks Mongo and Redis. Returns 503 while any required dependency is down.',
          responses: {
            '200': jsonResponse('Ready to serve traffic', ReadinessSchema),
            '503': jsonResponse('One or more dependencies unavailable', ReadinessSchema),
          },
        },
      },

      // ── Authentication (§9, M1.5) ───────────────────────────────────────────

      [`${API_PREFIX}/auth/otp/request`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'requestOtp',
          summary: 'Send a one-time sign-in code',
          description:
            'Accepts an email address OR an Australian mobile in one field, and routes to the ' +
            'matching channel. The response never reveals whether the identifier exists: an ' +
            'unrecognised one receives an identically shaped challenge and no message is sent. ' +
            '`sentTo` is masked.',
          requestBody: jsonBody(OtpRequestSchema),
          responses: {
            '201': jsonResponse('A code has been issued', OtpChallengeSchema),
            ...errorResponses('400', '422', '429'),
          },
        },
      },

      [`${API_PREFIX}/auth/otp/resend`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'resendOtp',
          summary: 'Re-send the code for an existing challenge',
          description:
            'Refuses until `resendAvailableAt` has passed, and refills the attempt counter. ' +
            'Subject to the same per-identifier ceiling as the initial send.',
          requestBody: jsonBody(OtpResendSchema),
          responses: {
            '201': jsonResponse('A new code has been issued', OtpChallengeSchema),
            ...errorResponses('400', '422', '404', '429'),
          },
        },
      },

      [`${API_PREFIX}/auth/otp/verify`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'verifyOtp',
          summary: 'Verify a code and open a session',
          description:
            'On success sets the session cookie and returns the session. On failure the exact ' +
            'reason travels as a field issue at path `authReason` — one of CODE_INCORRECT, ' +
            'CODE_EXPIRED, CODE_ATTEMPTS_EXCEEDED or CHALLENGE_NOT_FOUND — because the closed ' +
            '`ErrorCode` union cannot express them and the sign-in screen needs different copy ' +
            'for each. `CODE_INCORRECT` also carries `attemptsRemaining`.',
          requestBody: jsonBody(OtpVerifySchema),
          responses: {
            '200': jsonResponse('Signed in', SessionSchema),
            ...errorResponses('400', '422', '401', '403', '404', '429'),
          },
        },
      },

      [`${API_PREFIX}/auth/session`]: {
        get: {
          tags: ['Authentication'],
          operationId: 'getCurrentSession',
          summary: 'The current session, or null',
          description:
            'Answers 200 with `null` when nobody is signed in — not 401. Every surface calls ' +
            'this on load, and "no session yet" is the most ordinary state the app has, not an ' +
            'error. The user record is re-read on each call, so a suspended account loses ' +
            'access on its next request rather than at its next sign-in.',
          security: [{ sessionCookie: [] }, {}],
          responses: {
            '200': jsonResponse('The signed-in session, or null', SessionSchema.nullable()),
          },
        },
      },

      [`${API_PREFIX}/auth/sign-out`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'signOut',
          summary: 'End the current session',
          description:
            'Idempotent: succeeds with 204 whether or not a session existed, because the ' +
            'caller has already got what they asked for either way.',
          security: [{ sessionCookie: [] }, {}],
          responses: {
            '204': { description: 'Session ended and the cookie cleared' },
          },
        },
      },

      // ── Driver (M4) ─────────────────────────────────────────────────────────

      [`${API_PREFIX}/driver/run-sheet`]: {
        get: {
          tags: ['Driver'],
          operationId: 'getRunSheet',
          summary: "The signed-in driver's day",
          description:
            'Takes a date rather than a cursor, because a driver needs *today* — and ' +
            'yesterday, for the tip-off they forgot to record.\n\n' +
            '⚠️ **A day can hold more than one run.** `runs[]` is the real structure: a ' +
            'driver commonly does a morning trip and an afternoon one, and each ends at the ' +
            'weighbridge with its own docket, so `tipOffRecordedAt` sits on the RUN and not ' +
            'on the day. `stops[]` is the same stops flattened, kept because most screens ' +
            'want "the next job" without caring which run it came from; every stop carries ' +
            'its `runId`, so nothing has to infer the grouping.\n\n' +
            '`preStartCompletedAt` is the exception that stays on the day: it is a check on ' +
            'the vehicle, and the vehicle does not change between the two trips.',
          security: signedIn,
          requestParams: { query: RunSheetQuerySchema },
          responses: {
            '200': jsonResponse("The driver's runs and stops for that date", RunSheetDaySchema),
            ...errorResponses('400', '422', '401', '403'),
          },
        },
      },

      [`${API_PREFIX}/driver/jobs/{jobId}`]: {
        get: {
          tags: ['Driver'],
          operationId: 'getDriverJob',
          summary: 'One job, in full',
          description:
            'Everything the driver reads before getting out of the truck — access notes, gate ' +
            'hours, site contact — plus what has been captured so far, the photos and their ' +
            'required slots, the risk assessment and its PDF state, and the office thread.\n\n' +
            '`requiredPhotos[]` arrives as DATA rather than being fixed in the app: the ' +
            'prompts are configurable per site and per job, so a client that hard-codes the ' +
            'five standard slots will be wrong on the first site that differs.\n\n' +
            '404 rather than 403 for a job on another driver\'s run: whether it exists is not ' +
            "this driver's business either.",
          security: signedIn,
          requestParams: { path: JobIdPathSchema },
          responses: {
            '200': jsonResponse('The job', DriverJobSchema),
            ...errorResponses('400', '422', '401', '403', '404'),
          },
        },
      },

      [`${API_PREFIX}/driver/jobs/{jobId}/status`]: driverAction({
        operationId: 'updateJobStatus',
        summary: 'Move the job forward',
        description:
          'Three transitions only — `in-transit`, `arrived`, `completed`. `admin-complete` is ' +
          'absent because it is an office act, and there is no "accept job" step: the first ' +
          'thing a driver does on a stop is `in-transit`.\n\n' +
          '`arrived` is the load-bearing one: it starts the on-site clock that Extra Load ' +
          'Time is computed from, and on a site whose builder requires it, the risk ' +
          'assessment form opens on the back of it.',
        body: StatusUpdateSchema,
        path: JobIdPathSchema,
        success: 'Status recorded',
      }),

      [`${API_PREFIX}/driver/jobs/{jobId}/complete`]: driverAction({
        operationId: 'completeJob',
        summary: 'Finish the job',
        description:
          'Carries the optional "anything worth recording?" note. The client should keep the ' +
          'button disabled until the weights, the required photos and any mandatory risk ' +
          'assessment are done — but the server enforces it too, and answers 409 when ' +
          'something is missing.',
        body: CompletionSchema,
        path: JobIdPathSchema,
        success: 'Job completed',
      }),

      [`${API_PREFIX}/driver/jobs/{jobId}/weights`]: driverAction({
        operationId: 'captureWeights',
        summary: 'What was collected',
        description:
          '⚠️ There is deliberately **no `areaM2` field**. The square metres are what the job ' +
          'is priced on, they come off the builder\'s order, and the office sets them before ' +
          'the truck leaves. A driver looking at a pile cannot tell its area, and a guess ' +
          'typed to get past a field would be a guess that got invoiced.\n\n' +
          '`craneScaleKg` must be **null** on a hand load, never 0. There is no bag to lift, ' +
          'so no measurement exists — and a zero enters the tip-off reconciliation as "we ' +
          'collected nothing", skewing every imputed weight on the run.',
        body: WeightCaptureSchema,
        path: JobIdPathSchema,
        success: 'Weights recorded',
      }),

      [`${API_PREFIX}/driver/jobs/{jobId}/photos`]: {
        post: {
          tags: ['Driver'],
          operationId: 'registerJobPhoto',
          summary: 'Register a photo and get somewhere to put it',
          description:
            '**The image bytes never travel through this API.** This call creates the photo ' +
            'RECORD and returns a presigned URL; the phone then PUTs the bytes straight to ' +
            'object storage, sending exactly the headers in `upload.headers` — they are signed ' +
            'into the URL, so an altered or missing one fails at the bucket.\n\n' +
            'The record is written before the bytes arrive on purpose: it is what lets the ' +
            'photos screen show a pending shot with the cloud-arrow badge. `DriverPhoto.' +
            'uploaded` stays false until the PUT lands.\n\n' +
            '`contentLength` is declared up front and signed in, so a phone that asks for a ' +
            '4 MB slot cannot then push 2 GB. `slot` matches a `RequiredPhoto.key`, or is ' +
            'null for a free-form extra.',
          security: signedIn,
          requestParams: { path: JobIdPathSchema },
          requestBody: jsonBody(PresignPhotoSchema),
          responses: {
            '201': jsonResponse('Photo registered; PUT the bytes to `upload.uploadUrl`', PhotoUploadTicketSchema),
            ...errorResponses('400', '422', '401', '403', '404'),
          },
        },
      },

      [`${API_PREFIX}/driver/jobs/{jobId}/photos/{photoId}`]: {
        delete: {
          tags: ['Driver'],
          operationId: 'removeJobPhoto',
          summary: 'Remove a photo',
          description:
            "Deletes the record and the stored object. Idempotent from the caller's side.",
          security: signedIn,
          requestParams: { path: PhotoPathSchema },
          responses: {
            '204': { description: 'Photo removed' },
            ...errorResponses('400', '422', '401', '403', '404'),
          },
        },
      },

      [`${API_PREFIX}/driver/jobs/{jobId}/futile`]: driverAction({
        operationId: 'reportFutile',
        summary: 'Could not collect',
        description:
          'Ends the job and raises the futile charge. At least one photo is REQUIRED and the ' +
          'reason is structured rather than free text, because the customer certified at ' +
          'booking that the job was ready and accessible — photo plus GPS plus timestamp at ' +
          'the point of failure is what turns a disputed phone call into an invoice line that ' +
          'survives challenge.\n\n' +
          '⚠️ The reason enum accepts **eight** values (`weather`, `customer-request` and ' +
          '`other` beyond the five on the original screens). Confirm with the office which ' +
          'the app should offer before trimming the list client-side.',
        body: FutileReportSchema,
        path: JobIdPathSchema,
        success: 'Recorded as futile',
      }),

      [`${API_PREFIX}/driver/jobs/{jobId}/contamination`]: driverAction({
        operationId: 'reportContamination',
        summary: 'Contaminated load',
        description:
          '**Does not stop the job** — the driver takes the load anyway and carries on. A ' +
          'photo is required because the office approves the charge by looking at it.',
        body: ContaminationReportSchema,
        path: JobIdPathSchema,
        success: 'Contamination recorded',
      }),

      [`${API_PREFIX}/driver/pre-start`]: driverAction({
        operationId: 'submitPreStart',
        summary: 'Daily vehicle check',
        description:
          'Ten checks, the odometer and a signed declaration. Under Chain of Responsibility ' +
          'this is an operator obligation as much as a driver one, so it is a record kept ' +
          'against the vehicle rather than a box ticked for the driver\'s benefit — which is ' +
          'why any item marked `fail` becomes a defect report (see `/driver/defects`) and ' +
          'carries a required note.\n\n' +
          'Scoped to the DAY, not the run: the vehicle does not change between the morning ' +
          'and afternoon trips.',
        body: PreStartSubmissionSchema,
        success: 'Pre-start recorded',
      }),

      [`${API_PREFIX}/driver/risk-assessment`]: driverAction({
        operationId: 'submitRiskAssessment',
        summary: 'Site risk assessment',
        description:
          'Available on EVERY job, not only the flagged ones — `riskAssessmentRequired` gates ' +
          'the automatic prompt on arrival and the completion blocker, never access to the ' +
          'form.\n\n' +
          '`hazardKeys` and `controlKeys` each need at least one entry. "No significant ' +
          'hazards identified" is mutually exclusive with every other hazard — enforce that ' +
          'in the UI, both directions.\n\n' +
          'When `safeToProceed` is false the office is alerted immediately and the driver must ' +
          'not start; the note becomes mandatory in that case.\n\n' +
          'PDF generation and the upload to the builder\'s portal happen server-side ' +
          'afterwards, and surface as `riskAssessment.uploadState` on the job — they are not ' +
          'prerequisites for saving, because this has to work at a fence with no signal.',
        body: SiteRiskAssessmentSchema,
        success: 'Assessment recorded',
      }),

      [`${API_PREFIX}/driver/runs/{runId}/docket-photo`]: {
        post: {
          tags: ['Driver'],
          operationId: 'registerDocketPhoto',
          summary: 'Somewhere to put the weighbridge docket photo',
          description:
            'Run-scoped, not job-scoped: the docket evidences the WHOLE load, so there is no ' +
            'stop it honestly belongs to, and filing it against an arbitrary one would ' +
            'misattribute the evidence the monthly tipping bill is audited against.\n\n' +
            'Same two-step shape as a job photo — this returns a presigned URL and the bytes go ' +
            'straight to storage — with one difference: there is no photo RECORD to create, so ' +
            'the `photoId` returned **is** the storage key. Send it straight back as ' +
            '`docketPhotoId` on `POST /driver/tip-off`.\n\n' +
            'The tip-off accepts a null `docketPhotoId`, so a driver is never stuck at the ' +
            'weighbridge behind a failed upload — but this photo is what the monthly tipping ' +
            'bill is audited against, so take it.',
          security: signedIn,
          requestParams: { path: RunIdPathSchema },
          requestBody: jsonBody(PresignDocketPhotoSchema),
          responses: {
            '201': jsonResponse(
              'Registered; PUT the bytes to `upload.uploadUrl`',
              PhotoUploadTicketSchema,
            ),
            ...errorResponses('400', '422', '401', '403', '404'),
          },
        },
      },

      [`${API_PREFIX}/driver/runs/{runId}/tip-off/preview`]: {
        post: {
          tags: ['Driver'],
          operationId: 'previewTipOff',
          summary: 'How the weighbridge figure splits across the run',
          description:
            '**A read, served over POST.** The weighbridge figure is an input to a ' +
            'calculation, not a filter — and putting a number the driver is about to commit ' +
            'into a query string would land it in access logs and browser history on a device ' +
            'we do not control. Nothing is written.\n\n' +
            'The split: measured crane weights come off the total first, and the remainder is ' +
            'shared between the hand-load jobs **in proportion to their square metres**, not ' +
            'per head — an equal split would put the same tonnage on a garage and a two-storey ' +
            'house, and that tonnage is printed on a diversion certificate.\n\n' +
            'Shown to the driver rather than computed silently because a wildly wrong imputed ' +
            'figure usually means a mistyped crane weight, and the driver is still standing at ' +
            'the weighbridge. Check `looksWrong` — it is true when the measured weights exceed ' +
            'the total, and committing that would corrupt a certificate.',
          security: signedIn,
          requestParams: { path: RunIdPathSchema },
          requestBody: jsonBody(PreviewTipOffSchema),
          responses: {
            '200': jsonResponse('The reconciliation, as the driver should see it', TipOffReconciliationSchema),
            ...errorResponses('400', '422', '401', '403', '404'),
          },
        },
      },

      [`${API_PREFIX}/driver/tip-off`]: driverAction({
        operationId: 'recordTipOff',
        summary: 'Commit the weighbridge docket',
        description:
          '⚠️ **Keyed by `runId`, not by date.** A driver with a morning trip and an ' +
          'afternoon one produces two dockets on one date; keyed by date the second would ' +
          'overwrite the first or the two would be summed, and either way the remainder could ' +
          'no longer be apportioned because the jobs it belongs to are no longer ' +
          'identifiable. `date` is carried as a denormalised convenience for the day\'s ' +
          'reports — the run is the key.\n\n' +
          'So the Tip-off screen is per run: a second run on the same day gets its own empty ' +
          'form, and "already recorded" is a property of the run, not the day.',
        body: TipOffEntrySchema,
        success: 'Tip-off recorded and the run reconciled',
      }),

      [`${API_PREFIX}/driver/defects`]: driverAction({
        operationId: 'reportDefect',
        summary: 'Report a vehicle fault',
        description:
          'Available at any time from the Report tab, and also raised automatically by a ' +
          'failed pre-start item.\n\n' +
          'On `unroadworthy` the client must show the office number and tell the driver to ' +
          'ring it: this request may be sitting in an offline queue, and a queued report is ' +
          'not good enough when the answer is stop driving.',
        body: DefectReportSchema,
        success: 'Defect reported',
      }),

      [`${API_PREFIX}/driver/jobs/{jobId}/messages`]: driverAction({
        operationId: 'sendJobMessage',
        summary: 'Message the office about this job',
        description:
          'Posts into the job\'s thread, so whoever picks it up has the context. Read the ' +
          'thread back from `messages[]` on the job.',
        body: DriverMessageSchema,
        path: JobIdPathSchema,
        success: 'Message sent',
      }),
    },
  };

  return createDocument(spec);
}
