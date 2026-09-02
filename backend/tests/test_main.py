from __future__ import annotations

import sys
from pathlib import Path

from chronofish import __main__
from chronofish.config import Config


def config(driver: str = "memory", port: int = 8080) -> Config:
    return Config(port, "test", driver, "postgresql://db" if driver != "memory" else "", (), (), Path("."), 10, 5)


def test_main_runs_migrations_before_serving_for_sql_drivers(monkeypatch):
    events = []
    monkeypatch.setattr(__main__, "load_config", lambda: config("postgres"))
    monkeypatch.setattr(
        "chronofish.store.migrations.migrate", lambda value: events.append(("migrate", value.db_driver))
    )
    monkeypatch.setattr(__main__.uvicorn, "run", lambda *args, **kwargs: events.append(("serve", kwargs["port"])))
    monkeypatch.setattr(sys, "argv", ["chronofish"])

    __main__.main()

    assert events == [("migrate", "postgres"), ("serve", 8080)]


def test_main_skips_migrations_for_memory_driver(monkeypatch):
    monkeypatch.setattr(__main__, "load_config", lambda: config())
    monkeypatch.setattr("chronofish.store.migrations.migrate", lambda _value: (_ for _ in ()).throw(AssertionError()))
    monkeypatch.setattr(__main__.uvicorn, "run", lambda *args, **kwargs: None)
    monkeypatch.setattr(sys, "argv", ["chronofish"])

    __main__.main()


def test_main_binds_configured_port(monkeypatch):
    captured = {}
    monkeypatch.setattr(__main__, "load_config", lambda: config(port=9090))
    monkeypatch.setattr(__main__.uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))
    monkeypatch.setattr(sys, "argv", ["chronofish"])

    __main__.main()

    assert captured["port"] == 9090
