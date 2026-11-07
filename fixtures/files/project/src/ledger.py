"""The ledger: append-only, one row per payment id."""
import sqlite3


def open_ledger(path):
    db = sqlite3.connect(path)
    db.execute("create table if not exists payments (id text primary key, merchant text, cents integer)")
    return db


def record(db, payment_id, merchant, cents):
    # The primary key makes a repeated request a no-op: writes are idempotent.
    db.execute("insert or ignore into payments values (?, ?, ?)", (payment_id, merchant, cents))
    db.commit()
