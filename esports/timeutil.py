"""时间与时钟抽象:正式环境用真实时钟, 测试/演示注入 ManualClock。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

ISO_FMT = "%Y-%m-%dT%H:%M:%S"


def to_iso(dt: datetime) -> str:
    """datetime -> UTC ISO 字符串(秒级, 带 Z)。"""
    return dt.astimezone(timezone.utc).strftime(ISO_FMT) + "Z"


def parse(s: str) -> datetime:
    """ISO 字符串 -> 带时区的 datetime(UTC)。容忍毫秒与 Z 后缀。"""
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1]
    if "." in s:
        s = s.split(".")[0]
    return datetime.strptime(s, ISO_FMT).replace(tzinfo=timezone.utc)


def minutes_between(a: str, b: str) -> int:
    """两个 ISO 时间之间的整分钟数(b - a)。"""
    return int((parse(b) - parse(a)).total_seconds() // 60)


def overlap_minutes(a_start: str, a_end: str, b_start: str, b_end: str) -> int:
    """区间 [a_start,a_end] 与 [b_start,b_end] 的重叠分钟数。"""
    start = max(parse(a_start), parse(b_start))
    end = min(parse(a_end), parse(b_end))
    return max(0, int((end - start).total_seconds() // 60))


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}¥{abs(cents) / 100:.2f}"


class Clock:
    """真实时钟。"""

    def now(self) -> datetime:
        return datetime.now(timezone.utc).replace(microsecond=0)

    def now_iso(self) -> str:
        return to_iso(self.now())


class ManualClock(Clock):
    """可手动推进的时钟, 供测试与演示数据生成使用。"""

    def __init__(self, start: datetime):
        self._t = start.astimezone(timezone.utc).replace(microsecond=0)

    def now(self) -> datetime:
        return self._t

    def set(self, dt: datetime) -> None:
        self._t = dt.astimezone(timezone.utc).replace(microsecond=0)

    def advance(self, **kwargs) -> None:
        self._t = self._t + timedelta(**kwargs)
