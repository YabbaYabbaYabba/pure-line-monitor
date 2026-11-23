"""Talks to the Pure Telecom Sagemcom modem and turns its replies into line stats.

The modem speaks Sagemcom's JSON-req API (/cgi/json-req), the same API its own
web page at /2.0/gui/ uses. Values follow the TR-181 data model:
attenuation and noise margin are usually in tenths of a dB, rates in kbps.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp
from sagemcom_api.client import SagemcomClient
from sagemcom_api.enums import ApiMode, EncryptionMethod
from sagemcom_api.exceptions import (
    AuthenticationException,
    InvalidSessionException,
    UnauthorizedException,
    UnknownException,
)

log = logging.getLogger("router")

DEFAULT_DSL_XPATH = "Device/DSL"


@dataclass
class LineSample:
    ts: float
    status: str | None = None
    ds_rate: float | None = None  # Mbps, current sync
    us_rate: float | None = None
    ds_max: float | None = None  # Mbps, attainable line maximum
    us_max: float | None = None
    ds_att: float | None = None  # dB
    us_att: float | None = None
    ds_nm: float | None = None  # dB, noise margin (SNR margin)
    us_nm: float | None = None
    uptime_s: int | None = None  # seconds since the line last synced
    reset_ts: float | None = None  # epoch when the line last synced
    standard: str | None = None
    profile: str | None = None
    raw_keys: list[str] = field(default_factory=list)

    @property
    def is_up(self) -> bool:
        return (self.status or "").lower() in ("up", "showtime", "connected")


# ---------------------------------------------------------------- parsing


def _norm(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _walk(obj: Any, path: str = ""):
    """Yield (path, key, value, parent) for every scalar in a nested structure."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}/{k}"
            if isinstance(v, (dict, list)):
                yield from _walk(v, p)
            else:
                yield p, k, v, obj
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk(v, f"{path}[{i}]")


def _find(obj: Any, *names: str, prefer: str | None = None) -> Any:
    """First value whose key matches one of names (case/underscore-insensitive).

    If prefer is given, a match whose path contains it wins.
    """
    wanted = [_norm(n) for n in names]
    hits = []
    for p, k, v, _ in _walk(obj):
        nk = _norm(k)
        if nk in wanted and v not in (None, ""):
            hits.append((wanted.index(nk), p, v))
    if not hits:
        return None
    if prefer:
        pref = [h for h in hits if prefer.lower() in h[1].lower()]
        if pref:
            hits = pref
    hits.sort(key=lambda h: h[0])
    return hits[0][2]


def _num(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(str(v).strip().split()[0])
    except (ValueError, IndexError):
        return None


def _db(v: Any, scale: str) -> float | None:
    """Router reports dB as tenths (237 = 23.7 dB) on most firmware."""
    n = _num(v)
    if n is None:
        return None
    if scale == "tenths" or (scale == "auto" and float(n).is_integer() and abs(n) > 70):
        n = n / 10
    return round(n, 1)


def _mbps(v: Any) -> float | None:
    n = _num(v)
    if n is None:
        return None
    # TR-181 rates are kbps. Anything > 100000 that is clearly bps gets scaled twice.
    if n > 5_000_000:
        n = n / 1000
    return round(n / 1000, 1)


def parse_dsl(tree: Any, db_scale: str = "auto", now: float | None = None) -> LineSample:
    now = now or time.time()
    lines = _find_container(tree, "lines") or tree
    channels = _find_container(tree, "channels") or tree
    line = _first_item(lines)
    chan = _first_item(channels)

    s = LineSample(ts=now)
    s.status = _find(line, "status", "link_status")
    s.status = str(s.status) if s.status is not None else None
    s.ds_rate = _mbps(_find(chan, "downstream_curr_rate", "downstream_current_rate", "ds_curr_rate"))
    s.us_rate = _mbps(_find(chan, "upstream_curr_rate", "upstream_current_rate", "us_curr_rate"))
    if s.ds_rate is None:
        s.ds_rate = _mbps(_find(line, "downstream_curr_rate", "downstream_current_rate"))
        s.us_rate = _mbps(_find(line, "upstream_curr_rate", "upstream_current_rate"))
    s.ds_max = _mbps(_find(line, "downstream_max_bit_rate", "downstream_max_rate", "downstream_attainable_rate"))
    s.us_max = _mbps(_find(line, "upstream_max_bit_rate", "upstream_max_rate", "upstream_attainable_rate"))
    s.ds_att = _db(_find(line, "downstream_attenuation", "downstream_line_attenuation"), db_scale)
    s.us_att = _db(_find(line, "upstream_attenuation", "upstream_line_attenuation"), db_scale)
    s.ds_nm = _db(_find(line, "downstream_noise_margin", "downstream_snr_margin"), db_scale)
    s.us_nm = _db(_find(line, "upstream_noise_margin", "upstream_snr_margin"), db_scale)
    s.standard = _find(line, "standard_used", "modulation_type", "standard")
    s.profile = _find(line, "current_profile", "allowed_profiles")

    up = _num(_find(line, "showtime_start", prefer="stats"))
    if up is None:
        up = _num(_find(line, "last_change", "uptime"))
    if up is not None and up >= 0:
        s.uptime_s = int(up)
        s.reset_ts = round(now - up)
    s.raw_keys = sorted({k for _, k, _, _ in _walk(line)})[:200]
    return s


def _find_container(tree: Any, name: str) -> Any:
    if isinstance(tree, dict):
        for k, v in tree.items():
            if _norm(k) == name:
                return v
        for v in tree.values():
            r = _find_container(v, name)
            if r is not None:
                return r
    elif isinstance(tree, list):
        for v in tree:
            r = _find_container(v, name)
            if r is not None:
                return r
    return None


def _first_item(obj: Any) -> Any:
    if isinstance(obj, list):
        return obj[0] if obj else {}
    if isinstance(obj, dict):
        # {"line": [...]} or {"1": {...}}
        if len(obj) == 1:
            only = next(iter(obj.values()))
            if isinstance(only, (list, dict)):
                return _first_item(only)
    return obj


# ---------------------------------------------------------------- log parsing

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

_PATTERNS = [
    re.compile(r"(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})[T ](?P<H>\d{2}):(?P<M>\d{2}):(?P<S>\d{2})"),
    re.compile(r"(?P<d>\d{1,2})/(?P<m>\d{1,2})/(?P<y>\d{4})[ ,T]+(?P<H>\d{1,2}):(?P<M>\d{2}):(?P<S>\d{2})"),
    re.compile(r"(?P<mon>[A-Za-z]{3})\s+(?P<d>\d{1,2})\s+(?:(?P<y>\d{4})\s+)?(?P<H>\d{2}):(?P<M>\d{2}):(?P<S>\d{2})"),
    re.compile(r"(?P<d>\d{1,2})\s+(?P<mon>[A-Za-z]{3})\s+(?P<y>\d{4})\s+(?P<H>\d{2}):(?P<M>\d{2}):(?P<S>\d{2})"),
]


def parse_log_time(line: str, tz: ZoneInfo, now: float | None = None) -> float | None:
    now = now or time.time()
    for pat in _PATTERNS:
        m = pat.search(line)
        if not m:
            continue
        g = m.groupdict()
        try:
            month = int(g["m"]) if g.get("m") else _MONTHS[g["mon"].lower()]
            year = int(g["y"]) if g.get("y") else datetime.fromtimestamp(now, tz).year
            dt = datetime(year, month, int(g["d"]), int(g["H"]), int(g["M"]), int(g["S"]), tzinfo=tz)
        except (KeyError, ValueError):
            continue
        ts = dt.timestamp()
        if not g.get("y") and ts > now + 86400:  # syslog without year, across New Year
            ts = dt.replace(year=year - 1).timestamp()
        return ts
    return None


def parse_drop_lines(text: str, match: str, tz: ZoneInfo) -> list[tuple[float, str]]:
    rx = re.compile(match, re.I)
    out = []
    for line in text.splitlines():
        if rx.search(line):
            ts = parse_log_time(line, tz)
            if ts:
                out.append((ts, line.strip()[:300]))
    return out


# ---------------------------------------------------------------- client


class PureRouter:
    """Keeps ONE logged-in session to the box and reuses it.

    The Pure box's web interface is fragile: many logins, or the log download,
    can make it return HTTP 500 and lock out its own admin page for a while.
    So: one login, reused; re-login only when the box says the session expired;
    no log download unless explicitly enabled.
    """

    def __init__(self, host: str, username: str, password: str, auth_method: str = "auto",
                 dsl_xpath: str = DEFAULT_DSL_XPATH, db_scale: str = "auto", use_ssl: bool = False):
        self.host = host
        self.username = username
        self.password = password
        self.auth_method = None if auth_method.lower() == "auto" else EncryptionMethod(auth_method.upper())
        self.dsl_xpath = dsl_xpath
        self.db_scale = db_scale
        self.use_ssl = use_ssl
        self.device_info: dict[str, Any] = {}
        self._info_tried = False
        self._session: aiohttp.ClientSession | None = None
        self._client: SagemcomClient | None = None
        self.logins = 0

    async def _connect(self) -> SagemcomClient:
        if self._client is not None:
            return self._client
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20),
            cookie_jar=aiohttp.CookieJar(unsafe=True),
            connector=aiohttp.TCPConnector(ssl=False, limit=1),
        )
        def make(method):
            return SagemcomClient(self.host, self.username, self.password,
                                  authentication_method=method, session=self._session,
                                  ssl=self.use_ssl, verify_ssl=False, api_mode=ApiMode.LEGACY)

        try:
            if self.auth_method is not None:
                client = make(self.auth_method)
                await client.login()
            else:
                # Try each hash method with a real login and keep the session that works:
                # one successful login, no orphaned sessions left on the box.
                client = None
                for method in (EncryptionMethod.MD5, EncryptionMethod.SHA512, EncryptionMethod.MD5_NONCE):
                    candidate = make(method)
                    try:
                        await candidate.login()
                    except (AuthenticationException, UnauthorizedException):
                        continue
                    client = candidate
                    self.auth_method = method
                    log.info("Router login method detected: %s", method)
                    break
                if client is None:
                    raise PermissionError("Login failed: check the username and password")
        except BaseException:
            await self._drop(logout=False)
            raise
        self.logins += 1
        log.info("Logged in to the Pure box (login #%d since start)", self.logins)
        self._client = client
        return client

    async def _drop(self, logout: bool = True) -> None:
        client, session = self._client, self._session
        self._client, self._session = None, None
        if client is not None and logout:
            try:
                await client.logout()
            except Exception:  # noqa: BLE001
                pass
        if session is not None:
            await session.close()

    async def _call(self, fn):
        """Run fn(client) on the shared session; re-login once if the session expired."""
        client = await self._connect()
        try:
            return await fn(client)
        except (InvalidSessionException, AuthenticationException, UnauthorizedException):
            await self._drop(logout=False)
            client = await self._connect()
            return await fn(client)
        except UnknownException:
            # HTTP 500 from the box: let go of the session; the caller backs off before trying again
            await self._drop(logout=True)
            raise

    async def fetch(self, with_logs: bool, log_match: str, tz: ZoneInfo):
        """Returns (sample, drops, log_error)."""
        if not self._info_tried:
            self._info_tried = True
            try:
                di = await self._call(lambda c: c.get_device_info())
                self.device_info = {k: v for k, v in vars(di).items()
                                    if k in ("model_name", "software_version", "serial_number",
                                             "manufacturer", "product_class")}
            except UnknownException:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("Device info not available: %s", e)

        tree = await self._call(lambda c: c.get_value_by_xpath(self.dsl_xpath))
        sample = parse_dsl(tree, self.db_scale)

        drops, log_err = [], None
        if with_logs:
            try:
                text = await self._call(lambda c: c.get_logs())
                drops = parse_drop_lines(text, log_match, tz)
            except Exception as e:  # noqa: BLE001
                log_err = "Could not read the router log."
                log.warning("Router log read failed: %s", str(e)[:120])
        return sample, drops, log_err

    async def raw(self, xpath: str) -> Any:
        return await self._call(lambda c: c.get_value_by_xpath(xpath))

    async def raw_log(self) -> str:
        return await self._call(lambda c: c.get_logs())

    async def close(self) -> None:
        await self._drop(logout=True)
