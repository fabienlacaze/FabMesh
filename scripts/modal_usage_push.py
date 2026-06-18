#!/usr/bin/env python3
"""Push the REAL Modal workspace usage to the MyFabmesh cloud admin.

The Cloudflare Worker can't run the Modal CLI, so this small poller runs
`modal billing report --for "this month" --json`, sums the per-app/day cost
(= the real workspace usage that counts toward your Modal budget), and POSTs it
to <WORKER_URL>/api/admin/modal-usage. The admin then shows the REAL number and
the budget alert fires on real usage vs your Modal limit (instead of the worker's
rough estimate).

Env vars:
  MODAL_USAGE_SECRET   shared secret == the Worker's MODAL_USAGE_SECRET (required)
  FABMESH_WORKER_URL   default https://myfabmesh-cloud.fabien65400.workers.dev
  MODAL_BILLING_FOR    default "this month"  (Modal billing cycle window)

Schedule it ~hourly: Windows Task Scheduler, cron, or a GitHub Action.
Requires the `modal` CLI to be installed + authenticated on the host that runs it.
"""
import json
import os
import subprocess
import sys
import urllib.request

WORKER = os.environ.get("FABMESH_WORKER_URL", "https://myfabmesh-cloud.fabien65400.workers.dev").rstrip("/")
SECRET = os.environ.get("MODAL_USAGE_SECRET", "")
PERIOD = os.environ.get("MODAL_BILLING_FOR", "this month")


def modal_usage_usd() -> float:
    """Sum the Cost column of `modal billing report --json` for the cycle."""
    proc = subprocess.run(
        [sys.executable, "-m", "modal", "billing", "report", "--for", PERIOD, "--json"],
        capture_output=True, text=True, timeout=180,
    )
    if proc.returncode != 0:
        raise SystemExit(f"`modal billing report` failed: {proc.stderr.strip()[:400]}")
    rows = json.loads(proc.stdout)
    total = sum(float(r.get("Cost", 0) or 0) for r in rows)
    return round(total, 6)


def main() -> None:
    if not SECRET:
        raise SystemExit("Set MODAL_USAGE_SECRET (must match the Worker's MODAL_USAGE_SECRET).")
    usage = modal_usage_usd()
    payload = json.dumps({"usage": usage, "cycle": PERIOD}).encode("utf-8")
    req = urllib.request.Request(
        f"{WORKER}/api/admin/modal-usage", data=payload, method="POST",
        headers={"content-type": "application/json", "x-ingest-secret": SECRET.strip(),
                 "user-agent": "MyFabmesh-ModalPoller/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"pushed Modal usage ${usage:.4f} ({PERIOD}) -> HTTP {resp.status}: {resp.read(200).decode()}")


if __name__ == "__main__":
    main()
