from __future__ import annotations

import sys

import uvicorn

from .config import load_config


def main() -> None:
    config = load_config()
    if len(sys.argv) > 1 and sys.argv[1] == "migrate":
        from .migrate import migrate

        migrate(config)
        return
    uvicorn.run("chronofish.app:create_app", factory=True, host="0.0.0.0", port=config.port)


if __name__ == "__main__":
    main()
