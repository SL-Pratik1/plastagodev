/**
 * @plastago/shared — the single source of truth for the API contract.
 *
 * Rules (§6A.9):
 *  1. Every request/response shape lives here as a Zod schema.
 *  2. The API validates with these schemas; the web + driver apps infer types from them.
 *  3. The OpenAPI document is GENERATED from these schemas — never hand-written.
 *  4. The contract freezes at day 3. Changes after that need a version bump, because
 *     the Flutter app codegens its Dart client from the published spec.
 */

export * from './constants.js';
export * from './schemas/primitives.js';
export * from './schemas/envelope.js';
export * from './schemas/pagination.js';
export * from './schemas/health.js';
export * from './schemas/identity.js';
export * from './schemas/party.js';
export * from './schemas/jobs.js';
export * from './schemas/driver.js';
export * from './schemas/portal.js';
export * from './schemas/queues.js';
export * from './schemas/users.js';
export * from './schemas/dispatch.js';
export * from './schemas/invoices.js';
export * from './schemas/dashboard.js';
export * from './schemas/fleet.js';
export * from './schemas/notifications.js';
export * from './schemas/audit.js';
export * from './schemas/reports.js';
export * from './schemas/settings.js';
export * from './openapi/index.js';
