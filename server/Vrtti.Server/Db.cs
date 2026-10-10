using Microsoft.Data.Sqlite;

namespace Vrtti.Server;

/// <summary>Owns the SQLite file: connection string, schema, connections.</summary>
public sealed class Db
{
    readonly string _connectionString;

    public Db(string path)
    {
        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        _connectionString = new SqliteConnectionStringBuilder { DataSource = full }.ToString();
        CreateSchema();
    }

    /// <summary>Opens a connection for one request. The caller disposes it.</summary>
    public SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        // WAL still allows only one writer at a time. Without a busy timeout a second
        // concurrent push fails immediately with SQLITE_BUSY; with it, the push waits.
        Execute(conn, "PRAGMA busy_timeout = 5000;");
        return conn;
    }

    void CreateSchema()
    {
        using var conn = new SqliteConnection(_connectionString);
        conn.Open();
        // WAL lets readers work while a writer holds the lock. It is a property of the
        // database file, not of the connection, so setting it once at startup is enough.
        Execute(conn, "PRAGMA journal_mode = WAL;");
        Execute(conn, """
            CREATE TABLE IF NOT EXISTS revisions (
              seq         INTEGER PRIMARY KEY AUTOINCREMENT,
              doc_id      TEXT    NOT NULL,
              rev         INTEGER NOT NULL,
              kind        TEXT    NOT NULL,
              content     TEXT,
              meta        TEXT,
              device_id   TEXT    NOT NULL,
              client_time INTEGER NOT NULL,
              server_time INTEGER NOT NULL,
              UNIQUE(doc_id, rev)
            );
            CREATE INDEX IF NOT EXISTS revisions_doc ON revisions(doc_id, seq);
            """);
        Migrate(conn);
    }

    /// <summary>Brings a database made by an older server up to the current schema.</summary>
    /// <remarks>
    /// Each step checks the schema itself instead of a version number, so a step is safe
    /// to run on every start and on a fresh file the CREATE TABLE above already made.
    /// </remarks>
    static void Migrate(SqliteConnection conn)
    {
        // Spaces (architecture.md section 25). The space is a column and not a meta field,
        // because the server filters on it and the server never reads meta in a request.
        if (!HasColumn(conn, "revisions", "space"))
        {
            // One transaction: a crash after the ALTER and before the UPDATE would leave the
            // column in place, the check above would skip the step on the next start, and
            // the keyring rows would stay in 'personal' for good.
            using var transaction = conn.BeginTransaction();
            Execute(conn, "ALTER TABLE revisions ADD COLUMN space TEXT NOT NULL DEFAULT 'personal';");
            // Before spaces every row was a normal note or the keyring record. The client
            // treats 'keyring' as a reserved space that every device receives, so a device
            // that subscribes to other spaces only still gets the keys. This is the one
            // place the server looks inside meta, once, at migration time.
            Execute(conn, "UPDATE revisions SET space = 'keyring' WHERE json_extract(meta, '$.kind') = 'keyring';");
            transaction.Commit();
        }

        // Outside the step on purpose: IF NOT EXISTS makes it free on every start, and a
        // database migrated by a build that lacked the index still gets it.
        Execute(conn, "CREATE INDEX IF NOT EXISTS revisions_space ON revisions(space, seq);");
    }

    static bool HasColumn(SqliteConnection conn, string table, string column)
    {
        // PRAGMA arguments cannot be parameters; both names are constants of this file.
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT 1 FROM pragma_table_info('{table}') WHERE name = $name";
        cmd.Parameters.AddWithValue("$name", column);
        return cmd.ExecuteScalar() is not null;
    }

    static void Execute(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    /// <summary>Builds a parameterized command. Null values become SQL NULL.</summary>
    public static SqliteCommand Command(
        SqliteConnection conn,
        string sql,
        params (string Name, object? Value)[] args)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        return cmd;
    }
}
