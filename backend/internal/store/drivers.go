package store

// Keep the repository package self-contained for database integration tests;
// the API composition root also imports these drivers through this package.
import (
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
)
