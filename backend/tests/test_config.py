from __future__ import annotations

from pathlib import Path

import pytest

from chronofish.config import load_config


def test_load_config_normalizes_runtime_values(monkeypatch):
    monkeypatch.setenv("APP_ENV", " TEST ")
    monkeypatch.setenv("DB_DRIVER", " MEMORY ")
    monkeypatch.setenv("PORT", "9000")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", " https://lab.example, https://admin.example ")
    monkeypatch.setenv("IP_ALLOWLIST", "10.0.0.1, 2001:db8::/32")

    config = load_config()

    assert (config.app_env, config.db_driver, config.port) == ("test", "memory", 9000)
    assert config.allowed_origins == ("https://lab.example", "https://admin.example")
    assert tuple(str(network) for network in config.ip_allowlist) == ("10.0.0.1/32", "2001:db8::/32")


def test_load_config_rejects_memory_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DB_DRIVER", "memory")

    with pytest.raises(ValueError, match="only allowed"):
        load_config()


@pytest.mark.parametrize("app_env", ("dev", "development", "test"))
def test_default_driver_is_memory_only_for_dev_and_test(monkeypatch, app_env):
    monkeypatch.setenv("APP_ENV", app_env)
    monkeypatch.delenv("DB_DRIVER", raising=False)

    assert load_config().db_driver == "memory"


def test_default_driver_is_postgres_when_app_env_is_unset(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("DB_DRIVER", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://db")

    assert load_config().db_driver == "postgres"


def test_unknown_driver_is_rejected(monkeypatch):
    monkeypatch.setenv("DB_DRIVER", "sqlite")

    with pytest.raises(ValueError, match="DB_DRIVER must be memory, postgres, or mysql"):
        load_config()


def test_non_memory_driver_requires_database_url(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DB_DRIVER", "postgres")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(ValueError, match="DATABASE_URL is required"):
        load_config()


def test_port_must_be_an_integer(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("PORT", "abc")

    with pytest.raises(ValueError, match="PORT must be an integer"):
        load_config()


def test_port_below_one_is_rejected(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("PORT", "0")

    with pytest.raises(ValueError, match="PORT must be at least 1"):
        load_config()


def test_db_pool_size_and_overflow_bounds(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DB_POOL_SIZE", "0")
    with pytest.raises(ValueError, match="DB_POOL_SIZE must be at least 1"):
        load_config()

    monkeypatch.setenv("DB_POOL_SIZE", "1")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "-1")
    with pytest.raises(ValueError, match="DB_MAX_OVERFLOW must be at least 0"):
        load_config()

    monkeypatch.setenv("DB_MAX_OVERFLOW", "0")
    assert load_config().db_max_overflow == 0


def test_ip_allowlist_accepts_bare_address_and_cidr(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("IP_ALLOWLIST", "10.0.0.5, 192.168.1.0/24")

    assert tuple(str(network) for network in load_config().ip_allowlist) == ("10.0.0.5/32", "192.168.1.0/24")


def test_ip_allowlist_rejects_invalid_entry(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("IP_ALLOWLIST", "not-an-ip")

    with pytest.raises(ValueError, match="not-an-ip"):
        load_config()


def test_empty_allowlist_and_origins_produce_empty_tuples(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("IP_ALLOWLIST", "")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", " , ")

    config = load_config()
    assert (config.ip_allowlist, config.allowed_origins) == ((), ())


def test_cors_origins_are_split_and_trimmed(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://a.example , https://b.example")

    assert load_config().allowed_origins == ("https://a.example", "https://b.example")


def test_migrations_dir_defaults_per_driver_and_honours_override(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("DB_DRIVER", "mysql")
    monkeypatch.setenv("DATABASE_URL", "mysql://db")
    monkeypatch.delenv("MIGRATIONS_DIR", raising=False)
    assert load_config().migrations_dir.name == "mysql"

    custom = Path("custom-migrations")
    monkeypatch.setenv("MIGRATIONS_DIR", str(custom))
    assert load_config().migrations_dir == Path(custom)
