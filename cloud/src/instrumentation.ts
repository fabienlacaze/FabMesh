/**
 * Next.js 15 instrumentation hook — fires on cold start of any runtime.
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 *
 * We branch by runtime to keep the Sentry config minimal per surface.
 * DSN is loaded once at module init from env or a sidecar file.
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
  // NOTE: error monitoring is OFF unless a DSN is set. If you enable a DSN in
  // production, you MUST list Sentry (error monitoring; no IP via
  // sendDefaultPii:false) in the privacy-policy sub-processors section.
  if (!dsn) return; // no DSN — silent no-op (no third-party processing happens)

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn,
      sendDefaultPii: false, // never attach IP / cookies / headers (GDPR data-minimisation)
      tracesSampleRate: 0.0,
      environment: process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_BUILD_ID || undefined,
      beforeSend(event) {
        // Don't ship user-identifying noise.
        if (event.user) { delete event.user.username; delete event.user.ip_address; }
        if (event.server_name) delete event.server_name;
        return event;
      },
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn,
      sendDefaultPii: false,
      tracesSampleRate: 0.0,
      environment: process.env.NODE_ENV,
      beforeSend(event) {
        if (event.user) delete event.user.ip_address;
        return event;
      },
    });
  }
}

// Uncaught request errors → Sentry (Next.js 15+ hook).
export const onRequestError = Sentry.captureRequestError;
