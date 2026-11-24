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

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = full,
            // WAL still allows only one writer at a time. DefaultTimeout makes SQLite wait up
            // to 5 s on SQLITE_BUSY without issuing an extra PRAGMA query on every Open().
            DefaultTimeout = 5,
        }.ToString();
        CreateSchema();
    }

    /// <summary>Opens a connection. Prefer <see cref="Auth.GetConnection"/> inside HTTP requests.</summary>
    public SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
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

        // Spaces as groups of devices (architecture.md section 27). prev_space marks a row
        // that moved a document, so the old space still learns that the document left.
        if (!HasColumn(conn, "revisions", "prev_space"))
        {
            // One transaction, for the reason of the step above. The json_remove belongs
            // to this step and runs once: notes encrypted before the upgrade carried a
            // readable title and spellcheck languages in meta, and the new server holds no
            // readable field. It keeps the rows, so the history of those notes stays.
            // json_remove ignores a path that is not there, so rows without these fields
            // are unchanged.
            using var transaction = conn.BeginTransaction();
            Execute(conn, "ALTER TABLE revisions ADD COLUMN prev_space TEXT;");
            Execute(conn, """
                UPDATE revisions SET meta = json_remove(meta, '$.title', '$.lang', '$.langSource', '$.spellOff')
                WHERE meta IS NOT NULL AND json_valid(meta);
                """);
            transaction.Commit();
        }

        // Stored character count for History(), paired with the covering index below so listing
        // revisions of a document with multi-MB blobs never walks SQLite overflow pages.
        if (!HasColumn(conn, "revisions", "size"))
        {
            using var transaction = conn.BeginTransaction();
            Execute(conn, "ALTER TABLE revisions ADD COLUMN size INTEGER;");
            Execute(conn, "UPDATE revisions SET size = COALESCE(LENGTH(content), 0);");
            transaction.Commit();
        }
        else if (NeedsSizeBackfill(conn))
        {
            // Heals rows inserted without `size` by external SQLite imports or benchmark seeders.
            Execute(conn, "UPDATE revisions SET size = COALESCE(LENGTH(content), 0) WHERE size IS NULL;");
        }

        // Outside the steps on purpose: IF NOT EXISTS makes it free on every start, and a
        // database migrated by a build that lacked an index or a table still gets it.
        // revisions_head covers CurrentHead() and History() without reading `content` or `meta`
        // (columns after `content` in the table row sit past its overflow chain).
        Execute(conn, """
            CREATE INDEX IF NOT EXISTS revisions_space ON revisions(space, seq);
            CREATE INDEX IF NOT EXISTS revisions_prev_space ON revisions(prev_space, seq)
              WHERE prev_space IS NOT NULL;
            CREATE INDEX IF NOT EXISTS revisions_head
              ON revisions(doc_id, rev DESC, seq, kind, space, device_id, client_time, server_time, size);

            -- One row for each registered device. The server stores only the SHA-256 of
            -- the device token. predecessor is UNIQUE: one device has at most one
            -- successor (a change of the passphrase switch makes a new device).
            CREATE TABLE IF NOT EXISTS devices (
              id               TEXT    PRIMARY KEY,
              token_hash       TEXT    NOT NULL UNIQUE,
              via_server_token INTEGER NOT NULL,
              predecessor      TEXT    UNIQUE,
              created          INTEGER NOT NULL
            );

            -- Who may read a space. Written only together with space_log, in one
            -- transaction, so the two never disagree.
            CREATE TABLE IF NOT EXISTS members (
              space     TEXT NOT NULL,
              device_id TEXT NOT NULL,
              PRIMARY KEY (space, device_id)
            );
            CREATE INDEX IF NOT EXISTS members_device ON members(device_id, space);

            -- The signed log of each space, stored as the exact text the client sent: the
            -- next entry's prev is the SHA-256 of these bytes.
            CREATE TABLE IF NOT EXISTS space_log (
              space TEXT    NOT NULL,
              seq   INTEGER NOT NULL,
              entry TEXT    NOT NULL,
              PRIMARY KEY (space, seq)
            );

            -- Join codes. The server knows the slot and the verifier, never the code.
            CREATE TABLE IF NOT EXISTS joins (
              slot      TEXT    PRIMARY KEY,
              verifier  TEXT    NOT NULL,
              spaces    TEXT    NOT NULL,
              by_device TEXT    NOT NULL,
              expires   INTEGER NOT NULL,
              tries     INTEGER NOT NULL DEFAULT 0,
              device_id TEXT,
              entry     TEXT,
              proof     TEXT,
              reply     TEXT,
              mac       TEXT
            );

            -- The device directory: device B vouches for device D, signed by B. The list
            -- only grows. replaces marks a passphrase switch (by is the old key, device the
            -- new one); it is stored because the signature covers it. The clients check
            -- the signatures; the server never does.
            CREATE TABLE IF NOT EXISTS introductions (
              device   TEXT    NOT NULL,
              by       TEXT    NOT NULL,
              replaces INTEGER NOT NULL DEFAULT 0,
              sig      TEXT    NOT NULL,
              created  INTEGER NOT NULL,
              PRIMARY KEY (device, by)
            );
            """);
    }

    static bool HasColumn(SqliteConnection conn, string table, string column)
    {
        // PRAGMA arguments cannot be parameters; both names are constants of this file.
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT 1 FROM pragma_table_info('{table}') WHERE name = $name";
        cmd.Parameters.AddWithValue("$name", column);
        return cmd.ExecuteScalar() is not null;
    }

    static bool NeedsSizeBackfill(SqliteConnection conn)
    {
        // Primary-key lookup on the newest row only, so normal boots do zero table scan.
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM revisions WHERE seq = (SELECT MAX(seq) FROM revisions) AND size IS NULL";
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
