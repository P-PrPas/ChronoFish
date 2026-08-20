package store

import "testing"

func TestSplitSQLStatementsPreservesQuotedSemicolons(t *testing.T) {
	statements := splitSQLStatements("INSERT INTO t VALUES ('a;b'); CREATE TABLE t (v TEXT);")
	if len(statements) != 2 {
		t.Fatalf("statements = %#v", statements)
	}
	if statements[0] != "INSERT INTO t VALUES ('a;b')" {
		t.Fatalf("first statement = %q", statements[0])
	}
}
