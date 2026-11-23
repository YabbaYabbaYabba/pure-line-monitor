"""SQLite history of line samples and drop events."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  ts REAL PRIMARY KEY, status TEXT,
  ds_rate REAL, us_rate REAL, ds_max REAL, us_max REAL,
  ds_att REAL, us_att REAL, ds_nm REAL, us_nm REAL,
  uptime_s INTEGER, reset_ts REAL
);
CREATE TABLE IF NOT EXISTS events (
  ts REAL NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, text TEXT,
  PRIMARY KEY (ts, kind)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""

COLS = ["ts", "status", "ds_rate", "us_rate", "ds_max", "us_max",
        "ds_att", "us_att", "ds_nm", "us_nm", "uptime_s", "reset_ts"]


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript(SCHEMA)

    # samples
    def add_sample(self, s) -> None:
        with self.lock, self.db:
            self.db.execute(
                f"INSERT OR REPLACE INTO samples ({','.join(COLS)}) VALUES ({','.join('?' * len(COLS))})",
                [getattr(s, c) for c in COLS])

    def last_sample(self) -> dict | None:
        r = self.db.execute("SELECT * FROM samples ORDER BY ts DESC LIMIT 1").fetchone()
        return dict(r) if r else None

    def samples_since(self, since: float, max_points: int = 400) -> list[dict]:
        rows = [dict(r) for r in self.db.execute(
            "SELECT * FROM samples WHERE ts >= ? ORDER BY ts", (since,))]
        if len(rows) <= max_points:
            return rows
        step = len(rows) / max_points
        return [rows[int(i * step)] for i in range(max_points)] + [rows[-1]]

    # events
    def add_event(self, ts: float, kind: str, source: str, text: str = "") -> bool:
        ts = round(ts)
        with self.lock, self.db:
            # Same event seen twice (log re-read, or poll and log a few seconds apart)
            near = self.db.execute(
                "SELECT 1 FROM events WHERE kind=? AND ABS(ts-?) <= 20", (kind, ts)).fetchone()
            if near:
                return False
            self.db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?)", (ts, kind, source, text))
            return True

    def events_since(self, since: float) -> list[dict]:
        return [dict(r) for r in self.db.execute(
            "SELECT * FROM events WHERE ts >= ? ORDER BY ts", (since,))]

    # meta
    def get_meta(self, k: str) -> str | None:
        r = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r[0] if r else None

    def set_meta(self, k: str, v: str) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, v))

    def prune(self, keep_days: int) -> None:
        cutoff = time.time() - keep_days * 86400
        with self.lock, self.db:
            self.db.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
