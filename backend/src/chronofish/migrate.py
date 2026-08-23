from __future__ import annotations

import re

from sqlalchemy import text

from .config import Config
from .database import create_database_engine

MIGRATION = re.compile(r"^(\d+)_.*\.up\.sql$")


def migration_files(config: Config) -> list[tuple[int, str]]:
    if not config.migrations_dir.is_dir():
        raise RuntimeError(f"migration directory does not exist: {config.migrations_dir}")
    result = []
    for path in config.migrations_dir.iterdir():
        if match := MIGRATION.match(path.name):
            result.append((int(match.group(1)), path.read_text(encoding="utf-8")))
    result.sort(key=lambda item: item[0])
    if not result:
        raise RuntimeError(f"no up migrations found in {config.migrations_dir}")
    return result


def _execute_script(connection, script: str) -> None:
    cursor = connection.connection.cursor()
    try:
        cursor.execute(script)
        while cursor.nextset():
            pass
    finally:
        cursor.close()


def migrate(config: Config) -> None:
    engine = create_database_engine(config)
    lock = (
        "SELECT pg_advisory_lock(1128813138)"
        if config.db_driver == "postgres"
        else "SELECT GET_LOCK('chronofish_migrations', 60)"
    )
    unlock = (
        "SELECT pg_advisory_unlock(1128813138)"
        if config.db_driver == "postgres"
        else "SELECT RELEASE_LOCK('chronofish_migrations')"
    )
    with engine.connect() as connection:
        acquired = connection.execute(text(lock)).scalar()
        if config.db_driver == "mysql" and acquired != 1:
            raise RuntimeError("could not acquire the MySQL migration lock")
        try:
            connection.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS schema_migrations "
                "(version BIGINT NOT NULL PRIMARY KEY, dirty BOOLEAN NOT NULL)"
            )
            connection.commit()
            row = connection.execute(text("SELECT version, dirty FROM schema_migrations LIMIT 1")).mappings().first()
            current = int(row["version"]) if row else 0
            if row and row["dirty"]:
                raise RuntimeError(f"database migration {current} is dirty; restore or repair it before startup")
            for version, script in migration_files(config):
                if version <= current:
                    continue
                connection.exec_driver_sql("DELETE FROM schema_migrations")
                connection.execute(
                    text("INSERT INTO schema_migrations(version, dirty) VALUES (:version, TRUE)"), {"version": version}
                )
                connection.commit()
                try:
                    _execute_script(connection, script)
                    connection.exec_driver_sql("UPDATE schema_migrations SET dirty = FALSE")
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                current = version
        finally:
            connection.execute(text(unlock))
            connection.commit()
    engine.dispose()
