from __future__ import annotations

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
