"""Quick checks for the parsing logic.  Run:  python -m pytest -q  (or python tests/test_parsing.py)"""

import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.router import parse_drop_lines, parse_dsl, parse_log_time  # noqa: E402

TZ = ZoneInfo("Europe/Dublin")


def test_parse_dsl_tenths_and_kbps():
    tree = {"dsl": {"lines": [{"status": "Up", "downstream_attenuation": 237, "upstream_attenuation": 0,
                               "downstream_noise_margin": 91, "upstream_noise_margin": 99,
                               "downstream_max_bit_rate": 88900, "upstream_max_bit_rate": 19500,
                               "last_change": 3600, "stats": {"showtime_start": 3600}}],
                    "channels": [{"downstream_curr_rate": 83900, "upstream_curr_rate": 19500}]}}
    s = parse_dsl(tree, now=1_000_000)
    assert s.ds_att == 23.7 and s.ds_nm == 9.1 and s.us_nm == 9.9
    assert s.ds_rate == 83.9 and s.us_rate == 19.5 and s.ds_max == 88.9
    assert s.uptime_s == 3600 and s.reset_ts == 1_000_000 - 3600
    assert s.is_up


def test_parse_dsl_already_db():
    tree = {"lines": {"line": [{"status": "Up", "downstream_attenuation": "11.7 dB", "downstream_noise_margin": 11.1}]}}
    s = parse_dsl(tree)
    assert s.ds_att == 11.7 and s.ds_nm == 11.1


def test_log_times():
    assert parse_log_time("2026-11-21T11:19:03 VDSL connectivity is down port 1", TZ)
    assert parse_log_time("21/11/2026 11:19:03 VDSL connectivity is down port 1", TZ)
    assert parse_log_time("Nov 21 11:19:03 kernel: VDSL connectivity is down port 1", TZ)
    assert parse_log_time("no time here", TZ) is None


def test_drop_lines():
    text = "2026-11-21 11:19:03 VDSL connectivity is down port 1\n2026-11-21 11:20:50 VDSL connectivity is up port 1\n"
    drops = parse_drop_lines(text, "VDSL connectivity is down", TZ)
    assert len(drops) == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
