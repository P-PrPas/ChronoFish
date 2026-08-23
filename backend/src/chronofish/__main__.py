from __future__ import annotations

import sys
import urllib.request

import uvicorn

from .config import load_config


def main() -> None:
    config = load_config()
    if len(sys.argv) > 1 and sys.argv[1] == "healthcheck":
        with urllib.request.urlopen(f"http://127.0.0.1:{config.port}/api/v1/health", timeout=2) as response:
            if response.status != 200:
                raise SystemExit(1)
        return
    if len(sys.argv) > 1 and sys.argv[1] == "migrate":
        from .store.migrations import migrate

        migrate(config)
        return
    uvicorn.run("chronofish.app:create_app", factory=True, host="0.0.0.0", port=config.port)


if __name__ == "__main__":
    main()
