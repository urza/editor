using System.Net;
using System.Net.Http.Json;
using Microsoft.Data.Sqlite;
using static Vrtti.Server.Tests.TestApp;

namespace Vrtti.Server.Tests;

/// <summary>Space names, the filter, the list, the migration.</summary>
public class SpacesTests
{
    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("dot.ted")]
    [InlineData("work\n")]
    [InlineData("a23456789012345678901234567890123")]
    public async Task A_bad_space_name_is_400_on_push(string space)
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        using var push = await Push(phone.Http, "doc-1", space);

        Assert.Equal(HttpStatusCode.BadRequest, push.StatusCode);
        var error = await push.Content.ReadFromJsonAsync<ErrorResponse>();
        Assert.Equal("space must be 1-32 letters, digits, - or _", error!.Error);
    }

    [Theory]
    [InlineData("work,bad%20name")]
    [InlineData("sl%2Fash")]
    [InlineData("a23456789012345678901234567890123")]
    public async Task A_bad_space_name_is_400_on_the_filter(string spaces)
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        using var response = await phone.Http.GetAsync($"/api/changes?spaces={spaces}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task The_filter_returns_only_documents_of_the_named_spaces()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Space("personal", phone);
        await app.Space("work", phone);
        await app.Space("A-z_09-a234567890123456789012345", phone);
        var client = phone.Http;

        await Push(client, "home", "personal");
        await Push(client, "job", "work");
        await Push(client, "max", "A-z_09-a234567890123456789012345");

        Assert.Equal(["job"], await DocIds(client, "?spaces=work"));
        Assert.Equal(["home", "job"], await DocIds(client, "?spaces=personal,work"));
        // Spaces around a name and empty items are ignored.
        Assert.Equal(["home", "job"], await DocIds(client, "?spaces=%20personal%20,,work,"));
        Assert.Equal(["home", "job", "max"], await DocIds(client, ""));
        Assert.Equal(["home", "job", "max"], await DocIds(client, "?spaces="));
    }

    [Fact]
    public async Task Spaces_lists_the_callers_spaces_with_live_documents_and_the_log_head()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var dev = await app.Register("dev");
        await app.Space("work", phone, dev);
        await app.Space("old", phone);
        await app.Space("empty", phone);
        await app.Space("personal", phone);
        var client = phone.Http;

        await Push(client, "a", "work");
        await Push(client, "b", "work");
        await Push(client, "c", "personal");
        await Push(client, "gone", "work", baseRev: 0);
        await Push(client, "gone", "work", baseRev: 1, kind: "deleted", content: null);
        await Push(client, "left", "old", baseRev: 0);
        await Push(client, "left", "work", baseRev: 1);

        var spaces = await client.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces");

        // "gone" ends in a tombstone; "left" moved away, so "old" has nothing live. "work"
        // has two log entries: the create and the add of dev.
        Assert.Equal(
            [new SpaceInfo("empty", 0, 1), new SpaceInfo("old", 0, 1), new SpaceInfo("personal", 1, 1), new SpaceInfo("work", 3, 2)],
            spaces!);

        // dev sees only its own space, and no keyring entry.
        var devSpaces = await dev.Http.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces");
        Assert.Equal([new SpaceInfo("work", 3, 2)], devSpaces!);
    }

    [Fact]
    public void Migration_brings_a_database_from_before_spaces_to_the_current_schema()
    {
        var dir = Path.Combine(Path.GetTempPath(), "vrtti-tests", Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "vrtti.db");
        var connectionString = new SqliteConnectionStringBuilder { DataSource = path }.ToString();
        try
        {
            // The schema exactly as it was before spaces.
            using (var conn = new SqliteConnection(connectionString))
            {
                conn.Open();
                Execute(conn, """
                    CREATE TABLE revisions (
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
                    CREATE INDEX revisions_doc ON revisions(doc_id, seq);
                    INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time)
                    VALUES ('keys', 1, 'text', 'k', '{"kind":"keyring"}', 'd', 1, 1),
                           ('note', 1, 'text', 'n', '{"title":"x","lang":"markdown","langSource":"user","enc":{"preset":"all-devices"}}', 'd', 1, 1),
                           ('bare', 1, 'text', 'b', NULL, 'd', 1, 1);
                    """);
            }

            var db = new Db(path);
            // A second start must find the columns and leave the rows alone.
            _ = new Db(path);

            using var check = db.Open();
            Assert.Equal(1L, Scalar(check, "SELECT COUNT(*) FROM pragma_table_info('revisions') WHERE name = 'space'"));
            Assert.Equal(1L, Scalar(check, "SELECT COUNT(*) FROM pragma_table_info('revisions') WHERE name = 'prev_space'"));
            Assert.Equal("keyring", Scalar(check, "SELECT space FROM revisions WHERE doc_id = 'keys'"));
            Assert.Equal("personal", Scalar(check, "SELECT space FROM revisions WHERE doc_id = 'note'"));
            Assert.Equal("personal", Scalar(check, "SELECT space FROM revisions WHERE doc_id = 'bare'"));
            Assert.Equal(1L, Scalar(check, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'revisions_space'"));
            Assert.Equal(4L, Scalar(check, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('devices', 'members', 'space_log', 'joins')"));

            // The readable labels are gone, the rows and the other fields stay.
            Assert.Equal(3L, Scalar(check, "SELECT COUNT(*) FROM revisions"));
            Assert.Equal("""{"enc":{"preset":"all-devices"}}""", Scalar(check, "SELECT meta FROM revisions WHERE doc_id = 'note'"));
            Assert.Equal("""{"kind":"keyring"}""", Scalar(check, "SELECT meta FROM revisions WHERE doc_id = 'keys'"));
            Assert.Equal("n", Scalar(check, "SELECT content FROM revisions WHERE doc_id = 'note'"));
        }
        finally
        {
            // Pooled connections keep the file open, and the directory would not go.
            SqliteConnection.ClearAllPools();
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
                // A leftover temporary directory must never fail a test run.
            }
        }
    }

    static async Task<string[]> DocIds(HttpClient client, string query)
    {
        var changes = await client.GetFromJsonAsync<ChangesResponse>($"/api/changes{query}");
        return [.. changes!.Changes.Select(c => c.DocId)];
    }

    static void Execute(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    static object? Scalar(SqliteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar();
    }
}
