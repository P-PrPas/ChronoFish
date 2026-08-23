from __future__ import annotations

from ..config import Config


class SQLStore:
    def __init__(self, _config: Config) -> None:
        raise RuntimeError("SQL backend migration is not complete; use DB_DRIVER=memory only during this checkpoint")
