"""A fake Sagemcom modem for trying the app without the real Pure box.

    python tests/fake_router.py            # listens on 127.0.0.1:8099
    ROUTER_HOST=127.0.0.1:8099 ROUTER_PASSWORD=x python -m app.server

The fake line re-syncs every RESYNC_EVERY seconds (default 300) and writes a
"VDSL connectivity is down port 1" entry to its log each time.
"""

import hashlib
import json
import os
import random
import time
from datetime import datetime

from aiohttp import web

START = time.time()
RESYNC_EVERY = int(os.environ.get("RESYNC_EVERY", "300"))
PASSWORD_OK = os.environ.get("FAKE_PASSWORD")  # unset = any password works
STATS = {"logins": 0, "requests": 0, "open_sessions": 0, "auth_failures": 0}
FAKE_USER = os.environ.get("FAKE_USER", "admin")
FAKE_METHOD = os.environ.get("FAKE_METHOD", "MD5")  # how the fake box hashes
SESSIONS = {}  # session id -> server nonce
FAIL_FILE = "/tmp/fake_router_fail"  # touch this file to make the fake box return HTTP 500


def line_state():
    now = time.time()
    cycles = int((now - START) // RESYNC_EVERY)
    last_sync = START + cycles * RESYNC_EVERY
    showtime = int(now - last_sync)
    return cycles, last_sync, showtime


def dsl_tree():
    _, _, showtime = line_state()
    att = 117 + random.randint(-2, 2)
    return {
        "lines": [{
            "uid": 1, "enable": True, "status": "Up", "lastChange": showtime,
            "standardUsed": "G.993.2", "currentProfile": "17a",
            "downstreamAttenuation": att, "upstreamAttenuation": 0,
            "downstreamNoiseMargin": 111 + random.randint(-3, 3), "upstreamNoiseMargin": 174,
            "downstreamMaxBitRate": 132800, "upstreamMaxBitRate": 24800,
            "stats": {"showtimeStart": showtime, "totalStart": int(time.time() - START)},
        }],
        "channels": [{"uid": 1, "status": "Up", "downstreamCurrRate": 102400, "upstreamCurrRate": 20500}],
    }


def log_text():
    cycles, _, _ = line_state()
    out = []
    for i in range(1, cycles + 1):
        t = START + i * RESYNC_EVERY - 105
        out.append(f"{datetime.fromtimestamp(t).strftime('%Y-%m-%dT%H:%M:%S')} [operator] VDSL connectivity is down port 1")
        out.append(f"{datetime.fromtimestamp(t + 105).strftime('%Y-%m-%dT%H:%M:%S')} [operator] VDSL connectivity is up port 1")
    return "\n".join(out) + "\n"


def H(v):
    return (hashlib.sha512 if FAKE_METHOD == "SHA512" else hashlib.md5)(v.encode()).hexdigest()


def auth_ok(req, user, nonce):
    """Check the auth-key exactly like a Sagemcom box (only when FAKE_PASSWORD is set)."""
    if PASSWORD_OK is None:
        return True
    cred = H(f"{user}:{nonce}:{H(PASSWORD_OK)}")
    want = H(f"{cred}:{req['id']}:{req['cnonce']}:JSON:/cgi/json-req")
    return want == req["auth-key"]


def ok(params):
    return {"error": {"description": "XMO_NO_ERR"}, "callbacks": [{"parameters": params}]}


async def json_req(request):
    STATS["requests"] += 1
    if os.path.exists(FAIL_FILE):
        return web.Response(status=500, text="<html><title>500 - Internal Server Error</title></html>")
    form = await request.post()
    req = json.loads(form["req"])["request"]
    sid = req["session-id"]
    first = req["actions"][0]
    if first["method"] == "logIn":
        user, nonce = first["parameters"]["user"], ""
        if user != FAKE_USER or not auth_ok(req, user, nonce):
            STATS["auth_failures"] += 1
            return web.json_response({"reply": {"error": {"description": "XMO_AUTHENTICATION_ERR"}, "actions": []}})
    else:
        if sid not in SESSIONS or not auth_ok(req, FAKE_USER, SESSIONS[sid]):
            return web.json_response({"reply": {"error": {"description": "XMO_INVALID_SESSION_ERR"}, "actions": []}})
    actions = []
    for a in req["actions"]:
        m = a["method"]
        if m == "logIn":
            STATS["logins"] += 1
            new_id = 4000 + STATS["logins"]
            SESSIONS[new_id] = str(random.randint(100000, 999999))
            STATS["open_sessions"] = len(SESSIONS)
            actions.append(ok({"id": new_id, "nonce": SESSIONS[new_id]}))
        elif m == "logOut":
            SESSIONS.pop(sid, None)
            STATS["open_sessions"] = len(SESSIONS)
            actions.append(ok({}))
        elif m == "getValue":
            xp = a["xpath"].replace("%2F", "/")
            if xp.startswith("Device/DSL"):
                actions.append(ok({"value": {"DSL": dsl_tree()} if xp == "Device/DSL" else dsl_tree()}))
            elif xp == "Device/DeviceInfo/ModelName":
                actions.append(ok({"value": "Fast5366SD (fake)"}))
            elif xp == "Device/DeviceInfo":
                actions.append(ok({"value": {"deviceInfo": {"macAddress": "00:11:22:33:44:55",
                    "modelName": "WLB fibre box (fake)", "softwareVersion": "SGDX1WLB0097",
                    "serialNumber": "FAKE0001", "manufacturer": "Sagemcom"}}}))
            else:
                actions.append({"error": {"description": "XMO_UNKNOWN_PATH_ERR"}, "callbacks": []})
        elif m == "getVendorLogDownloadURI":
            actions.append(ok({"uri": "/fake-log.txt"}))
        else:
            actions.append({"error": {"description": "XMO_UNKNOWN_PATH_ERR"}, "callbacks": []})
    errors = [x["error"]["description"] for x in actions]
    top = "XMO_REQUEST_NO_ERR" if all(e == "XMO_NO_ERR" for e in errors) else "XMO_REQUEST_ACTION_ERR"
    return web.json_response({"reply": {"uid": 0, "id": req["id"], "error": {"description": top}, "actions": actions}})


async def fake_log(_):
    return web.Response(text=log_text())


async def stats(_):
    return web.json_response(STATS)


app = web.Application()
app.router.add_get("/stats", stats)
app.router.add_post("/cgi/json-req", json_req)
app.router.add_get("/fake-log.txt", fake_log)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=int(os.environ.get("FAKE_PORT", "8099")))
