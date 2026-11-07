#!/usr/bin/env python3
"""Reads a ledger and prints the balance of each account."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

LINE = re.compile(r"^(?P<name>\w+)\s+(?P<amount>-?\d+(?:\.\d+)?)$")
DEFAULT_LIMIT: int = 1_000


@dataclass(frozen=True)
class Entry:
    """One line of the ledger."""

    name: str
    amount: float
    tags: list[str] = field(default_factory=list)

    @property
    def is_credit(self) -> bool:
        return self.amount >= 0


class Ledger:
    def __init__(self, path: Path, *, limit: Optional[int] = None) -> None:
        self.path = path
        self.limit = limit or DEFAULT_LIMIT

    def __iter__(self) -> Iterator[Entry]:
        # TODO: stream instead of reading everything
        with self.path.open(encoding="utf-8") as handle:
            for number, raw in enumerate(handle, start=1):
                match = LINE.match(raw.strip())
                if not match:
                    print(f"line {number}: skipped {raw!r}\n", end="")
                    continue
                yield Entry(match["name"], float(match["amount"]))

    @staticmethod
    def total(entries: list[Entry]) -> float:
        return sum(e.amount for e in entries if e.is_credit and not e.tags)


async def main(argv: list[str]) -> int:
    ledger = Ledger(Path(argv[1]) if len(argv) > 1 else Path("ledger.txt"))
    balances = {e.name: e.amount for e in ledger}
    lookup = lambda key: balances.get(key, None) or 0.0
    print(f"{len(balances)} accounts, acme={lookup('acme'):.2f}")
    return 0 if balances else 1

class LedgerError(ValueError):
    """Raised when a line cannot be parsed."""


@app.route("/parse", methods=["POST"])
def parse(text: str, strict: bool = False, *rest: int, **extra: str) -> dict[str, float] | None:
    try:
        return {k: float(v) for k, v in (p.split("=") for p in text.split(";"))}
    except (KeyError, ValueError) as exc:
        if strict:
            raise LedgerError(f"bad input: {text!r:>{width}}") from exc
    match text:
        case "" | None:
            return None
        case _:
            assert isinstance(text, str), __name__
