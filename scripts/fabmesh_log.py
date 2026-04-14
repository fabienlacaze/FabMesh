"""
FabMesh structured logger — shared by all Python scripts.

Emits one line per event in a format that's trivial to grep, parse, or
stream via the Control API /logs/stream endpoint:

    [2026-04-14T22:10:31.842Z] level=INFO component=multiview event=upscale_done jobId=1776... project=man view=0 size=1024x1024 ms=3421

Design goals:
  - Zero external deps.
  - No sync flush inside hot loops (stdout is line-buffered by default
    when attached to a TTY and fully buffered when piped, so we force
    line-buffering and let the OS handle the rest).
  - Legacy '[component] msg' prints still work — the logger wraps but
    doesn't remove them. Scripts can migrate incrementally.
  - Safe shlex-like escaping for values that contain spaces/=/newlines.

Usage:
    from fabmesh_log import Logger
    log = Logger('multiview', job_id=job_id, project='man')
    log.info('pipeline_loaded', size=image.size, elapsed_ms=int(dt*1000))
    log.warn('upscale_skipped', reason=str(e))
    log.error('generation_failed', error=type(e).__name__, msg=str(e))

    # Timing helper:
    with log.timed('generate_views'):
        run_inference(...)
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone
from contextlib import contextmanager
from typing import Any


def _iso_now() -> str:
    # 'Z' suffix matches the Electron main log format
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + \
           f'{datetime.now(timezone.utc).microsecond // 1000:03d}Z'


def _esc(v: Any) -> str:
    """Escape a value for key=value pairs. Quoted only when needed."""
    s = str(v) if v is not None else ''
    # Strip newlines — they'd break line-per-event parsing.
    s = s.replace('\r', ' ').replace('\n', '\\n')
    if any(c in s for c in ' \t"='):
        s = '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return s


class Logger:
    def __init__(self, component: str, **context: Any):
        self.component = component
        self.context = {k: v for k, v in context.items() if v is not None}
        # Ensure stdout is line-buffered so tail -f / SSE streams see
        # events the instant they happen. In Python 3.7+ sys.stdout.reconfigure
        # is the canonical way; older fall-backs to os.fdopen.
        try:
            sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Core
    # ------------------------------------------------------------------
    def log(self, level: str, event: str, **fields: Any) -> None:
        parts = [f'[{_iso_now()}]',
                 f'level={level}',
                 f'component={self.component}',
                 f'event={event}']
        for k, v in self.context.items():
            parts.append(f'{k}={_esc(v)}')
        for k, v in fields.items():
            if v is None:
                continue
            parts.append(f'{k}={_esc(v)}')
        line = ' '.join(parts)
        # Also keep the legacy '[component] human message' prefix so
        # existing log tailers/greps don't stop working mid-migration.
        human = f'[{self.component}] {event}'
        if fields:
            human += ' ' + ' '.join(f'{k}={_esc(v)}' for k, v in fields.items()
                                    if v is not None)
        print(human, flush=True)
        print(line, flush=True)

    def info(self, event: str, **fields: Any) -> None:
        self.log('INFO', event, **fields)

    def warn(self, event: str, **fields: Any) -> None:
        self.log('WARN', event, **fields)

    def error(self, event: str, **fields: Any) -> None:
        self.log('ERROR', event, **fields)

    def debug(self, event: str, **fields: Any) -> None:
        # Gated on env so we can leave debug calls in hot paths without
        # paying the I/O cost in production.
        if os.environ.get('FABMESH_DEBUG') == '1':
            self.log('DEBUG', event, **fields)

    # ------------------------------------------------------------------
    # Timing
    # ------------------------------------------------------------------
    @contextmanager
    def timed(self, event: str, **fields: Any):
        """Log <event>_start and <event>_done with ms duration."""
        self.info(event + '_start', **fields)
        t0 = time.time()
        try:
            yield
        except Exception as e:
            self.error(event + '_failed',
                       ms=int((time.time() - t0) * 1000),
                       error=type(e).__name__,
                       msg=str(e)[:300],
                       **fields)
            raise
        self.info(event + '_done',
                  ms=int((time.time() - t0) * 1000),
                  **fields)

    def progress(self, pct: int, label: str = '', **fields: Any) -> None:
        # Keep the MULTIVIEW_PROGRESS/LOCAL_REALVIS_PROGRESS conventions so
        # existing renderers that scrape stdout keep getting their signal.
        legacy = f'{self.component.upper()}_PROGRESS: {pct}'
        if label:
            legacy += f' {label}'
        print(legacy, flush=True)
        self.info('progress', pct=pct, label=label or None, **fields)

    def child(self, component: str | None = None, **context: Any) -> 'Logger':
        """Return a new Logger inheriting context, optionally renamed."""
        merged = {**self.context, **context}
        return Logger(component or self.component, **merged)
