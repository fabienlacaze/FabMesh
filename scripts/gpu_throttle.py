"""
GPU throttle helper — used by local_*_bridge.py scripts to respect
user-defined GPU usage / temperature / VRAM / RAM limits during generation.

Activation:
    Reads environment variables set by Electron main process:
      FABMESH_GPU_LIMIT   — max GPU utilization % (0-100). Default: no limit.
      FABMESH_TEMP_LIMIT  — max GPU temperature °C. Default: no limit.
      FABMESH_VRAM_FRACTION — already applied via torch.cuda.set_per_process_memory_fraction.
      FABMESH_RAM_LIMIT_MB  — RAM cap (enforced by caller).

How it works:
    Inject `throttle_step()` as a callback into any diffusion pipeline.
    On each step, it polls nvidia-smi (or pynvml if available) and sleeps
    in small increments until GPU usage drops under the limit.

    Throttle is cooperative: it does NOT kill the job, it just slows down
    the CPU-side loop so the GPU catches up. This is transparent to the
    user and only adds latency when the machine is actually stressed.

Usage in a bridge:
    from gpu_throttle import make_throttle_callback
    callback = make_throttle_callback()  # no-op if no limits set
    pipe(prompt, callback_on_step_end=callback, ...)

If the diffusers pipeline doesn't expose a step callback, call
`throttle_sync()` directly between steps or before heavy ops.
"""
import os
import sys
import time
import json


# Try pynvml first (faster and doesn't spawn a process)
try:
    import pynvml
    pynvml.nvmlInit()
    _NVML_HANDLE = pynvml.nvmlDeviceGetHandleByIndex(0)
    _NVML_OK = True
except Exception:
    _NVML_OK = False
    _NVML_HANDLE = None


def _get_gpu_stats():
    """Return (gpu_util %, temp °C) or (None, None) if unavailable."""
    if _NVML_OK:
        try:
            util = pynvml.nvmlDeviceGetUtilizationRates(_NVML_HANDLE).gpu
            temp = pynvml.nvmlDeviceGetTemperature(_NVML_HANDLE, pynvml.NVML_TEMPERATURE_GPU)
            return int(util), int(temp)
        except Exception:
            return None, None
    # Fallback: nvidia-smi (slower — spawns a process)
    try:
        import subprocess
        out = subprocess.check_output(
            ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu',
             '--format=csv,noheader,nounits'],
            stderr=subprocess.DEVNULL, timeout=2,
        ).decode().strip()
        util_s, temp_s = out.split(',')
        return int(util_s.strip()), int(temp_s.strip())
    except Exception:
        return None, None


def _get_limits():
    """Read limits from env vars. Returns (gpu_limit, temp_limit) or (None, None)."""
    gpu = os.environ.get('FABMESH_GPU_LIMIT')
    temp = os.environ.get('FABMESH_TEMP_LIMIT')
    try:
        gpu = int(float(gpu)) if gpu not in (None, '') else None
    except Exception:
        gpu = None
    try:
        temp = int(float(temp)) if temp not in (None, '') else None
    except Exception:
        temp = None
    return gpu, temp


# Live limits: main writes scripts/.gpu_limit.json when the user drags a
# slider; we reread it (with a small cache) so throttle reacts in real time
# instead of being frozen to the values at subprocess start.
_LIMITS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.gpu_limit.json')
_LIMITS_CACHE = {'ts': 0.0, 'gpu': None, 'temp': None}
_LIMITS_CACHE_TTL = 0.5  # seconds between file rereads


def _get_live_limits():
    """Return (gpu_limit, temp_limit) from the live file if present, else env."""
    now = time.time()
    if now - _LIMITS_CACHE['ts'] < _LIMITS_CACHE_TTL:
        return _LIMITS_CACHE['gpu'], _LIMITS_CACHE['temp']
    gpu, temp = None, None
    try:
        if os.path.exists(_LIMITS_FILE):
            with open(_LIMITS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f) or {}
            g = data.get('gpu')
            t = data.get('temp')
            if g is not None:
                gpu = int(float(g))
            if t is not None:
                temp = int(float(t))
    except Exception:
        pass
    # Fallback to env if file missing / unparseable
    if gpu is None and temp is None:
        gpu, temp = _get_limits()
    _LIMITS_CACHE['ts'] = now
    _LIMITS_CACHE['gpu'] = gpu
    _LIMITS_CACHE['temp'] = temp
    return gpu, temp


# Initial read at import (so [gpu_throttle] active line below is accurate)
_GPU_LIMIT, _TEMP_LIMIT = _get_live_limits()
_ENABLED = (_GPU_LIMIT is not None or _TEMP_LIMIT is not None)

# Print once so logs show the throttle state.
if _ENABLED:
    print(
        f"[gpu_throttle] active — gpu_limit={_GPU_LIMIT}% temp_limit={_TEMP_LIMIT}°C "
        f"nvml={'yes' if _NVML_OK else 'no'}",
        flush=True,
    )
else:
    print("[gpu_throttle] disabled — no FABMESH_GPU_LIMIT / FABMESH_TEMP_LIMIT set", flush=True)


# Throttle tunables
_MAX_WAIT           = 5.0    # never block more than this per call
_PROACTIVE_SLEEP    = 0.25   # base pause forced on each step when over the limit
_PROACTIVE_GAIN     = 0.05   # extra seconds per % over the limit (e.g. 10% over → +0.5s)
_POLL_INTERVAL      = 0.10   # seconds between measurements in the idle-wait loop


def _compute_sleep(util, temp, gpu_limit, temp_limit):
    """Return how long to sleep on this call, based on how far we are over."""
    pause = 0.0
    if gpu_limit is not None and util is not None and util > gpu_limit:
        over = util - gpu_limit
        pause = max(pause, _PROACTIVE_SLEEP + over * _PROACTIVE_GAIN)
    if temp_limit is not None and temp is not None and temp > temp_limit:
        over = temp - temp_limit
        pause = max(pause, _PROACTIVE_SLEEP + over * _PROACTIVE_GAIN * 2)
    return min(pause, _MAX_WAIT)


def throttle_sync():
    """Proactively pause to keep GPU usage under the live limits.

    Why proactive, not just "wait until under": SDXL / TripoSR keep the GPU
    at ~97-100% for the entire duration of a step, so a passive "wait until
    util<limit" loop would just spin 5s and time out. Instead, when we
    detect we are over the configured limit, we force a fixed idle window
    between steps proportional to the overshoot. A limit of 90% with
    observed 97% means a ~0.6s pause at each diffusion step; total extra
    time for a 25-step image is ~15s (acceptable).

    Limits are re-read from scripts/.gpu_limit.json on each call (with a
    0.5s cache) so the user can drag the slider live and the throttle
    reacts within 1-2 steps.
    """
    gpu_limit, temp_limit = _get_live_limits()
    if gpu_limit is None and temp_limit is None:
        return  # disabled / no limits configured
    util, temp = _get_gpu_stats()
    if util is None and temp is None:
        return  # can't measure, give up rather than loop
    pause = _compute_sleep(util, temp, gpu_limit, temp_limit)
    if pause <= 0:
        return  # under limits, nothing to do
    # First, force the proactive idle window (GPU will drop during this sleep
    # because SDXL's next step has not started yet).
    time.sleep(pause)
    # Then, if still over after the forced idle, passively wait a bit more
    # (bounded). This handles cases where the GPU simply does not cool down.
    deadline = time.time() + _MAX_WAIT - pause
    while time.time() < deadline:
        u2, t2 = _get_gpu_stats()
        if u2 is None and t2 is None:
            return
        over_gpu  = (gpu_limit  is not None and u2 is not None and u2 > gpu_limit)
        over_temp = (temp_limit is not None and t2 is not None and t2 > temp_limit)
        if not over_gpu and not over_temp:
            return
        time.sleep(_POLL_INTERVAL)


def make_throttle_callback():
    """Return a diffusers-style step callback that throttles on each step.

    Always returns a callable — even if no limits are set at import time —
    because limits can be added live via scripts/.gpu_limit.json while the
    subprocess is running. throttle_sync() re-reads the file each call.

    Signature matches both the old `callback(step, timestep, latents)` form
    and the new `callback_on_step_end(pipe, step_index, timestep, callback_kwargs)`
    form. We accept *args/**kwargs and just return the kwargs unchanged for
    the modern form.
    """
    def _cb(*args, **kwargs):
        throttle_sync()
        # New diffusers API expects callback_on_step_end to return a dict of
        # (possibly) updated callback_kwargs. Return whatever was passed in.
        if len(args) >= 4 and isinstance(args[3], dict):
            return args[3]
        if 'callback_kwargs' in kwargs:
            return kwargs['callback_kwargs']
        return {}

    return _cb
