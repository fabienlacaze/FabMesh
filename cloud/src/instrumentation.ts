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
  if (!dsn) return; // dev box without DSN — silent no-op

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.0,
      environment: process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_BUILD_ID || undefined,
      beforeSend(event) {
        // Don't ship user-identifying noise.
        if (event.user) delete event.user.username;
        if (event.server_name) delete event.server_name;
        return event;
      },
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.0,
      environment: process.env.NODE_ENV,
    });
  }
}

// Uncaught request errors → Sentry (Next.js 15+ hook).
export const onRequestError = Sentry.captureRequestError;
