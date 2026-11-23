"""Pure Line Monitor: small web app that polls the Pure Telecom modem and shows line health.

Run:  python -m app.server   (settings come from environment variables / .env)
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import logging
import os
import time
from dataclasses import asdict
from pathlib import Path
from zoneinfo import ZoneInfo

from aiohttp import web

from .router import PureRouter
from .store import Store

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(BASE.parent / ".env")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


CFG = {
    "host": env("ROUTER_HOST", "192.168.1.254"),
    "user": env("ROUTER_USER", "admin"),
    "password": env("ROUTER_PASSWORD"),
    "auth_method": env("ROUTER_AUTH_METHOD", "auto"),
    "dsl_xpath": env("DSL_XPATH", "Device/DSL"),
    "db_scale": env("DB_SCALE", "auto"),
    "poll": max(60, int(env("POLL_SECONDS", "300"))),
    "router_log": env("ROUTER_LOG", "0") == "1",
    "log_every": max(1, int(env("LOG_EVERY_POLLS", "6"))),
    "min_refresh": max(30, int(env("MIN_REFRESH_SECONDS", "60"))),
    "max_backoff": int(env("MAX_BACKOFF_SECONDS", "1800")),
    "log_match": env("LOG_MATCH", r"VDSL connectivity is down"),
    "tz": env("TZ", "Europe/Dublin"),
    "port": int(env("PORT", "8080")),
    "data": Path(env("DATA_DIR", str(BASE.parent / "data"))),
    "keep_days": int(env("KEEP_DAYS", "90")),
    "app_password": env("APP_PASSWORD"),
    "debug": env("DEBUG_ENDPOINTS", "0") == "1",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("server")
TZ = ZoneInfo(CFG["tz"])
RESYNC_GAP = 90  # seconds: a new sync time this much later than the last one = the line re-synced


class Monitor:
    def __init__(self):
        self.store = Store(CFG["data"] / "line.db")
        saved = self.store.get_meta("auth_method")
        method = CFG["auth_method"] if CFG["auth_method"].lower() != "auto" else (saved or "auto")
        self.router = PureRouter(CFG["host"], CFG["user"], CFG["password"], method,
                                 CFG["dsl_xpath"], CFG["db_scale"])
        self.lock = asyncio.Lock()
        self.polls = 0
        self.fails = 0
        self.state = {"ok": None, "error": None, "log_error": None, "retry_in": None,
                      "last_ok_ts": None, "last_try_ts": None, "last_log_ts": None}

    async def poll(self, with_logs: bool, manual: bool = False) -> None:
        async with self.lock:
            last = self.state["last_try_ts"]
            if manual and last and time.time() - last < CFG["min_refresh"]:
                return  # be gentle with the box: a Refresh within a minute shows the last reading
            if manual and self.fails and last and time.time() - last < self._delay():
                return  # backing off after errors; don't let Refresh hammer the box
            self.state["last_try_ts"] = time.time()
            with_logs = with_logs and CFG["router_log"]
            try:
                sample, drops, log_err = await self.router.fetch(with_logs, CFG["log_match"], TZ)
            except Exception as e:  # noqa: BLE001
                self.fails += 1
                self.state.update(ok=False, error=_friendly(e), retry_in=self._delay())
                log.warning("Poll failed (%d in a row, next try in %ds): %s",
                            self.fails, self._delay(), str(e).splitlines()[0][:120])
                return
            self.fails = 0
            self.state["retry_in"] = None
            if self.router.auth_method and not self.store.get_meta("auth_method"):
                self.store.set_meta("auth_method", str(self.router.auth_method))
            self.state.update(ok=True, error=None, last_ok_ts=sample.ts)
            if with_logs:
                self.state["log_error"] = log_err
                if not log_err:
                    self.state["last_log_ts"] = sample.ts
            self._record(sample, drops)

    def _record(self, s, drops) -> None:
        prev_reset = self.store.get_meta("last_reset_ts")
        if s.reset_ts:
            if prev_reset and s.reset_ts - float(prev_reset) > RESYNC_GAP:
                self.store.add_event(s.reset_ts, "resync", "poll", "Line re-synced (seen by the monitor)")
            self.store.set_meta("last_reset_ts", str(s.reset_ts))
        was_up = self.store.get_meta("was_up")
        if not s.is_up and was_up != "0":
            self.store.add_event(s.ts, "down", "poll", f"Line status: {s.status}")
        self.store.set_meta("was_up", "1" if s.is_up else "0")
        for ts, text in drops:
            self.store.add_event(ts, "down", "log", text)
        self.store.add_sample(s)

    def _delay(self) -> int:
        if not self.fails:
            return CFG["poll"]
        return min(CFG["poll"] * 2 ** self.fails, CFG["max_backoff"])

    async def loop(self) -> None:
        while True:
            self.polls += 1
            await self.poll(with_logs=((self.polls - 1) % CFG["log_every"] == 0))
            if self.polls % 500 == 0:
                self.store.prune(CFG["keep_days"])
            await asyncio.sleep(self._delay())

    # ------------------------------------------------------------ views
    def drops(self, since: float) -> list[dict]:
        ev = self.store.events_since(since - 900)
        downs = [e for e in ev if e["kind"] == "down"]
        resyncs = [e for e in ev if e["kind"] == "resync"]
        used = set()
        out = []
        for d in downs:
            match = next((r for r in resyncs if id(r) not in used and d["ts"] < r["ts"] <= d["ts"] + 600), None)
            if match:
                used.add(id(match))
            out.append({"down_ts": d["ts"], "up_ts": match["ts"] if match else None,
                        "duration_s": (match["ts"] - d["ts"]) if match else None,
                        "source": d["source"], "text": d["text"]})
        for r in resyncs:
            if id(r) not in used:
                out.append({"down_ts": None, "up_ts": r["ts"], "duration_s": None,
                            "source": r["source"], "text": r["text"]})
        out = [o for o in out if (o["down_ts"] or o["up_ts"]) >= since]
        out.sort(key=lambda o: o["down_ts"] or o["up_ts"], reverse=True)
        return out

    def status(self, range_key: str) -> dict:
        now = time.time()
        span = {"24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}.get(range_key, 86400)
        all_drops = self.drops(now - 30 * 86400)
        t = lambda o: o["down_ts"] or o["up_ts"]  # noqa: E731
        midnight = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
        return {
            "now": now,
            "tz": CFG["tz"],
            "poll_seconds": CFG["poll"],
            "router": {"host": CFG["host"], "info": self.router.device_info, **self.state},
            "current": self.store.last_sample(),
            "history": self.store.samples_since(now - span),
            "drops": [o for o in all_drops if t(o) >= now - span],
            "counts": {
                "h24": sum(1 for o in all_drops if t(o) >= now - 86400),
                "d7": sum(1 for o in all_drops if t(o) >= now - 7 * 86400),
                "d30": len(all_drops),
            },
            "range": range_key,
        }


def _friendly(e: Exception) -> str:
    name = type(e).__name__
    msg = str(e) or name
    if "Authentication" in name or "Unauthorized" in name or isinstance(e, PermissionError):
        return "Login to the Pure box failed. Check ROUTER_USER and ROUTER_PASSWORD."
    if "LoginRetry" in name:
        return "The Pure box has locked logins after too many attempts. Wait a few minutes."
    if "MaximumSession" in name:
        return "The Pure box has too many open sessions. Log out of its web page and try again."
    if "Connect" in name or "Timeout" in name or "OSError" in name:
        return f"Can't reach the Pure box at {CFG['host']}. ({msg[:120]})"
    if "UnknownException" in name or "<html" in msg.lower() or "500" in msg:
        return "The Pure box's web interface returned an error (HTTP 500). The monitor is backing off to let it recover."
    if "UnknownPath" in name:
        return f"The router doesn't know the path {CFG['dsl_xpath']}. Use the debug page to find it."
    return f"{name}: {msg[:200]}"


# ---------------------------------------------------------------- web


PUBLIC = {"/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/healthz"}


@web.middleware
async def security(request: web.Request, handler):
    pw = CFG["app_password"]
    if pw and request.path not in PUBLIC:
        ok = False
        h = request.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                _, given = base64.b64decode(h[6:]).decode().split(":", 1)
                ok = hmac.compare_digest(given, pw)
            except Exception:  # noqa: BLE001
                ok = False
        if not ok:
            return web.Response(status=401, headers={"WWW-Authenticate": 'Basic realm="Line Monitor"'})
    resp = await handler(request)
    resp.headers.update({
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; "
                                   "script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    })
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


async def h_status(request: web.Request):
    mon: Monitor = request.app["mon"]
    return web.json_response(mon.status(request.query.get("range", "24h")))


async def h_refresh(request: web.Request):
    mon: Monitor = request.app["mon"]
    await mon.poll(with_logs=True, manual=True)
    return web.json_response(mon.status(request.query.get("range", "24h")))


async def h_debug_xpath(request: web.Request):
    if not CFG["debug"]:
        raise web.HTTPNotFound()
    mon: Monitor = request.app["mon"]
    xpath = request.query.get("x", CFG["dsl_xpath"])
    try:
        async with mon.lock:
            data = await mon.router.raw(xpath)
        return web.json_response({"xpath": xpath, "value": data}, dumps=_dumps)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"xpath": xpath, "error": _friendly(e)}, status=502)


async def h_debug_log(request: web.Request):
    if not CFG["debug"]:
        raise web.HTTPNotFound()
    mon: Monitor = request.app["mon"]
    try:
        async with mon.lock:
            text = await mon.router.raw_log()
        return web.Response(text=text, content_type="text/plain")
    except Exception as e:  # noqa: BLE001
        return web.Response(text=_friendly(e), status=502)


async def h_debug_parse(request: web.Request):
    """Parse the current DSL tree and show what the app understood."""
    if not CFG["debug"]:
        raise web.HTTPNotFound()
    mon: Monitor = request.app["mon"]
    from .router import parse_dsl
    try:
        async with mon.lock:
            tree = await mon.router.raw(CFG["dsl_xpath"])
        return web.json_response(asdict(parse_dsl(tree, CFG["db_scale"])))
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": _friendly(e)}, status=502)


def _dumps(obj):
    import json
    return json.dumps(obj, indent=2, default=str)


async def h_index(_):
    return web.FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


async def h_health(_):
    return web.Response(text="ok")


async def on_start(app: web.Application):
    app["task"] = asyncio.create_task(app["mon"].loop())


async def on_stop(app: web.Application):
    app["task"].cancel()
    await app["mon"].router.close()  # log out so the session doesn't linger on the box


def make_app() -> web.Application:
    if not CFG["password"]:
        log.warning("ROUTER_PASSWORD is not set; logins to the Pure box will fail.")
    app = web.Application(middlewares=[security])
    app["mon"] = Monitor()
    app.router.add_get("/", h_index)
    app.router.add_get("/healthz", h_health)
    app.router.add_get("/api/status", h_status)
    app.router.add_post("/api/refresh", h_refresh)
    app.router.add_get("/api/debug/xpath", h_debug_xpath)
    app.router.add_get("/api/debug/log", h_debug_log)
    app.router.add_get("/api/debug/parse", h_debug_parse)
    app.router.add_static("/", STATIC, show_index=False, append_version=False)
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


if __name__ == "__main__":
    log.info("Line Monitor on port %s, router %s, polling every %ss", CFG["port"], CFG["host"], CFG["poll"])
    web.run_app(make_app(), port=CFG["port"], access_log=None)
