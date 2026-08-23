from __future__ import annotations

from sqlalchemy import Engine, create_engine

from ..config import Config


def sqlalchemy_url(driver: str, value: str) -> str:
    if value.startswith("postgres://"):
        return "postgresql+psycopg://" + value.removeprefix("postgres://")
    if value.startswith("postgresql://"):
        return "postgresql+psycopg://" + value.removeprefix("postgresql://")
    if value.startswith("mysql://"):
        return "mysql+pymysql://" + value.removeprefix("mysql://")
    return value


def create_database_engine(config: Config) -> Engine:
    connect_args = {}
    if config.db_driver == "mysql":
        from pymysql.constants import CLIENT

        connect_args["client_flag"] = CLIENT.MULTI_STATEMENTS
    return create_engine(
        sqlalchemy_url(config.db_driver, config.database_url),
        pool_pre_ping=True,
        pool_size=config.db_pool_size,
        max_overflow=config.db_max_overflow,
        connect_args=connect_args,
    )
