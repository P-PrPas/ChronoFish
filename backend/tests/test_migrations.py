from __future__ import annotations

import re
import shutil
from pathlib import Path
from uuid import uuid4

import pytest

from chronofish.config import Config
from chronofish.store.database import create_database_engine, sqlalchemy_url
from chronofish.store.migrations import migration_files


def config(migrations_dir: Path, driver: str = "postgres") -> Config:
    return Config(8080, "test", driver, f"{driver}://db", (), (), migrations_dir, 10, 5)


@pytest.fixture
def migration_dir():
    path = Path.cwd() / ".pytest-migrations" / uuid4().hex
    path.mkdir(parents=True)
    try:
        yield path
    finally:
        shutil.rmtree(path)


def test_migration_files_are_sorted_numerically_not_lexically(migration_dir):
    (migration_dir / "10_second.up.sql").write_text("ten")
    (migration_dir / "2_first.up.sql").write_text("two")

    assert migration_files(config(migration_dir)) == [(2, "two"), (10, "ten")]


def test_missing_migration_directory_raises_clearly(migration_dir):
    missing = migration_dir / "missing"
    with pytest.raises(RuntimeError, match=re.escape(str(missing))):
        migration_files(config(missing))


@pytest.mark.parametrize("files", ((), ("000001_init.down.sql",)))
def test_empty_migration_directory_raises_clearly(migration_dir, files):
    for name in files:
        (migration_dir / name).write_text("down")
    with pytest.raises(RuntimeError, match="no up migrations found"):
        migration_files(config(migration_dir))


def test_only_up_migrations_are_collected(migration_dir):
    (migration_dir / "000001_init.up.sql").write_text("up")
    (migration_dir / "000001_init.down.sql").write_text("down")
    assert migration_files(config(migration_dir)) == [(1, "up")]


@pytest.mark.parametrize(
    ("driver", "value", "expected"),
    (
        ("postgres", "postgres://db", "postgresql+psycopg://db"),
        ("postgres", "postgresql://db", "postgresql+psycopg://db"),
        ("mysql", "mysql://db", "mysql+pymysql://db"),
        ("postgres", "postgresql+psycopg://db", "postgresql+psycopg://db"),
    ),
)
def test_sqlalchemy_url_rewrites_driver_schemes(driver, value, expected):
    assert sqlalchemy_url(driver, value) == expected


def test_mysql_engine_enables_multi_statements(monkeypatch, migration_dir):
    captured = {}

    def create_engine(*args, **kwargs):
        captured["args"], captured["kwargs"] = args, kwargs
        return object()

    monkeypatch.setattr("chronofish.store.database.create_engine", create_engine)
    assert create_database_engine(config(migration_dir, "mysql"))
    assert captured["kwargs"]["connect_args"]["client_flag"]
