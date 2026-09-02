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
