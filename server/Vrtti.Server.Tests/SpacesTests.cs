using System.Net;
using System.Net.Http.Json;
using Microsoft.Data.Sqlite;

namespace Vrtti.Server.Tests;

/// <summary>Spaces: the column, the filter, the list, the migration (architecture.md section 25).</summary>
public class SpacesTests
{
    const long ClientTime = 1_700_000_000_000;

    [Fact]
    public async Task Push_without_a_space_reads_back_as_personal()
    {
        using var app = new TestApp();
        var client = app.Client();

        // No "space" key at all, as a client from before spaces sends it.
        using var absent = await client.PostAsJsonAsync(
            "/api/docs/doc-1/revisions",
            new { baseRev = (long?)null, kind = "text", content = "x", deviceId = "device-a", clientTime = ClientTime });
        Assert.Equal(HttpStatusCode.Created, absent.StatusCode);
        using var explicitNull = await Push(client, "doc-2", space: null);
        Assert.Equal(HttpStatusCode.Created, explicitNull.StatusCode);

        var current = await client.GetFromJsonAsync<Change>("/api/docs/doc-1");
        Assert.Equal("personal", current!.Space);

        var changes = await client.GetFromJsonAsync<ChangesResponse>("/api/changes");
        Assert.Equal(["personal", "personal"], changes!.Changes.Select(c => c.Space));
    }

    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("dot.ted")]
    [InlineData("work\n")]
    [InlineData("a23456789012345678901234567890123")]
    public async Task A_bad_space_name_is_400_on_push(string space)
    {
        using var app = new TestApp();
        using var push = await Push(app.Client(), "doc-1", space: space);

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
        using var response = await app.Client().GetAsync($"/api/changes?spaces={spaces}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task The_filter_returns_only_documents_of_the_named_spaces()
    {
        using var app = new TestApp();
        var client = app.Client();

        await Push(client, "home", space: "personal");
        await Push(client, "job", space: "work");
        await Push(client, "max", space: "A-z_09-a234567890123456789012345");

        Assert.Equal(["job"], await DocIds(client, "?spaces=work"));
        Assert.Equal(["home", "job"], await DocIds(client, "?spaces=personal,work"));
        // Spaces around a name and empty items are ignored.
        Assert.Equal(["home", "job"], await DocIds(client, "?spaces=%20personal%20,,work,"));
        Assert.Equal(["home", "job", "max"], await DocIds(client, ""));
        Assert.Equal(["home", "job", "max"], await DocIds(client, "?spaces="));
    }

    [Fact]
    public async Task A_document_that_moved_out_of_a_space_is_omitted_from_it()
    {
        using var app = new TestApp();
        var client = app.Client();

        await Push(client, "moved", baseRev: 0, space: "personal");
        await Push(client, "moved", baseRev: 1, space: "work");

        // The older row is still in personal, but the newest row decides.
        Assert.Empty(await DocIds(client, "?spaces=personal"));
        var changes = await client.GetFromJsonAsync<ChangesResponse>("/api/changes?spaces=work");
        var only = Assert.Single(changes!.Changes);
        Assert.Equal("moved", only.DocId);
        Assert.Equal(2, only.Rev);
        Assert.Equal("work", only.Space);
    }

    [Fact]
    public async Task Spaces_counts_live_documents_per_space()
    {
        using var app = new TestApp();
        var client = app.Client();

        await Push(client, "a", space: "work");
        await Push(client, "b", space: "work");
        await Push(client, "c", space: null);
        await Push(client, "gone", baseRev: 0, space: "work");
        await Push(client, "gone", baseRev: 1, kind: "deleted", content: null, space: "work");
        await Push(client, "left", baseRev: 0, space: "old");
        await Push(client, "left", baseRev: 1, space: "work");

        var spaces = await client.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces");

        // "gone" ends in a tombstone; "left" moved away, so "old" has nothing live.
        Assert.Equal(
            [new SpaceInfo("personal", 1), new SpaceInfo("work", 3)],
            spaces!);
    }

    [Fact]
    public void Migration_adds_the_space_column_to_an_old_database()
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
                           ('note', 1, 'text', 'n', '{"title":"x"}', 'd', 1, 1),
                           ('bare', 1, 'text', 'b', NULL, 'd', 1, 1);
                    """);
            }

            var db = new Db(path);
            // A second start must find the column and leave the rows alone.
            _ = new Db(path);

            using var check = db.Open();
            Assert.Equal(1L, Scalar(check, "SELECT COUNT(*) FROM pragma_table_info('revisions') WHERE name = 'space'"));
            Assert.Equal("keyring", Scalar(check, "SELECT space FROM revisions WHERE doc_id = 'keys'"));
            Assert.Equal("personal", Scalar(check, "SELECT space FROM revisions WHERE doc_id = 'note'"));
            Assert.Equal("personal", Scalar(check, "SELECT space FROM revisions WHERE doc_id = 'bare'"));
            Assert.Equal(1L, Scalar(check, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'revisions_space'"));
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

    static Task<HttpResponseMessage> Push(
        HttpClient client,
        string docId,
        string? space,
        long? baseRev = null,
        string kind = "text",
        string? content = "text")
        => client.PostAsJsonAsync(
            $"/api/docs/{docId}/revisions",
            new { baseRev, kind, content, deviceId = "device-a", clientTime = ClientTime, space });

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
