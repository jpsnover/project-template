// Correlation ID middleware: per-request context via AsyncLocalStorage.
//
// Usage:
//   import { runWithRequestContext, getRequestId, generateRequestId } from './correlationId.js';
//
//   // In your HTTP handler:
//   const requestId = (req.headers['x-request-id'] as string) || generateRequestId();
//   res.setHeader('X-Request-Id', requestId);
//   return runWithRequestContext(
//     { requestId, method: req.method, path: req.url },
//     () => handleRequest(req, res),
//   );

import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
  userId?: string;
}

const requestAls = new AsyncLocalStorage<RequestContext>();

/** Run a callback with a request-scoped correlation ID. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestAls.run(ctx, fn);
}

/** Get the current request's correlation ID, or undefined outside a request. */
export function getRequestId(): string | undefined {
  return requestAls.getStore()?.requestId;
}

/** Get the full request context, or undefined outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return requestAls.getStore();
}

/** Generate a unique request ID (UUID-based, prefixed for easy grep; no PII). */
export function generateRequestId(): string {
  return `req-${crypto.randomUUID()}`;
}
