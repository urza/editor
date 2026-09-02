using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Vrtti.Server.Tests;

public class SyncApiTests
{
    const long ClientTime = 1_700_000_000_000;

    [Fact]
    public async Task Health_needs_no_token()
    {
        using var app = new TestApp();
        using var response = await app.Client(token: null).GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("ok").GetBoolean());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("wrong-token")]
    public async Task Api_rejects_a_missing_or_wrong_token(string? token)
    {
        using var app = new TestApp();
        using var response = await app.Client(token).GetAsync("/api/changes");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Push_then_get_returns_the_document_with_its_meta()
    {
        using var app = new TestApp();
        var client = app.Client();

        using var push = await Push(client, "doc-1", baseRev: null, content: "hello",
            meta: new { title = "Notes", lang = "markdown" });
        Assert.Equal(HttpStatusCode.Created, push.StatusCode);
        var created = await push.Content.ReadFromJsonAsync<PushResponse>();
        Assert.Equal(1, created!.Rev);
        Assert.True(created.Seq > 0);

        var change = await client.GetFromJsonAsync<Change>("/api/docs/doc-1");
        Assert.Equal("doc-1", change!.DocId);
        Assert.Equal(1, change.Rev);
        Assert.Equal("text", change.Kind);
        Assert.Equal("hello", change.Content);
        Assert.Equal("device-a", change.DeviceId);
        Assert.Equal(ClientTime, change.ClientTime);
        Assert.True(change.ServerTime > 0);
        // The server hands meta back as a JSON object, unchanged.
        Assert.Equal("Notes", change.Meta!.Value.GetProperty("title").GetString());
        Assert.Equal("markdown", change.Meta!.Value.GetProperty("lang").GetString());

        using var missing = await client.GetAsync("/api/docs/no-such-doc");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task Push_with_the_current_base_rev_increments_the_rev()
    {
        using var app = new TestApp();
        var client = app.Client();

        using var first = await Push(client, "doc-2", baseRev: 0, content: "one");
        using var second = await Push(client, "doc-2", baseRev: 1, content: "two");

        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        var pushed = await second.Content.ReadFromJsonAsync<PushResponse>();
        Assert.Equal(2, pushed!.Rev);

        var change = await client.GetFromJsonAsync<Change>("/api/docs/doc-2");
        Assert.Equal("two", change!.Content);
    }

    [Fact]
    public async Task Push_with_a_stale_base_rev_returns_409_with_the_current_revision()
    {
        using var app = new TestApp();
        var client = app.Client();

        using var _ = await Push(client, "doc-3", baseRev: 0, content: "one");
        using var __ = await Push(client, "doc-3", baseRev: 1, content: "two");
        using var stale = await Push(client, "doc-3", baseRev: 1, content: "conflicting");

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var conflict = await stale.Content.ReadFromJsonAsync<ConflictResponse>();
        Assert.Equal(2, conflict!.Current!.Rev);
        Assert.Equal("two", conflict.Current.Content);

        // A claim about an unknown document reports no current revision.
        using var unknown = await Push(client, "doc-never-seen", baseRev: 7);
        Assert.Equal(HttpStatusCode.Conflict, unknown.StatusCode);
        var empty = await unknown.Content.ReadFromJsonAsync<ConflictResponse>();
        Assert.Null(empty!.Current);
    }

    [Fact]
    public async Task Push_with_a_null_base_rev_always_appends()
    {
        using var app = new TestApp();
        var client = app.Client();

        using var first = await Push(client, "doc-4", baseRev: null, content: "one");
        using var second = await Push(client, "doc-4", baseRev: null, content: "two");
        using var third = await Push(client, "doc-4", baseRev: null, content: "three");

        Assert.Equal(HttpStatusCode.Created, third.StatusCode);
        var pushed = await third.Content.ReadFromJsonAsync<PushResponse>();
        Assert.Equal(3, pushed!.Rev);
    }

    [Fact]
    public async Task Changes_returns_the_newest_revision_per_document_and_pages()
    {
        using var app = new TestApp();
        var client = app.Client();

        // Order of the pushes decides the seq order: a=1,2  b=3  c=4,5,6.
        await Push(client, "a", 0, content: "a1");
        await Push(client, "a", 1, content: "a2");
        await Push(client, "b", 0, content: "b1");
        await Push(client, "c", 0, content: "c1");
        await Push(client, "c", 1, content: "c2");
        await Push(client, "c", 2, content: "c3");

        var page1 = await client.GetFromJsonAsync<ChangesResponse>("/api/changes?limit=2");
        Assert.True(page1!.More);
        Assert.Equal(["a", "b"], page1.Changes.Select(c => c.DocId));
        Assert.Equal([2L, 1L], page1.Changes.Select(c => c.Rev));
        Assert.Equal(["a2", "b1"], page1.Changes.Select(c => c.Content));
        Assert.Equal(page1.Changes[^1].Seq, page1.Next);

        var page2 = await client.GetFromJsonAsync<ChangesResponse>($"/api/changes?since={page1.Next}&limit=2");
        Assert.False(page2!.More);
        var only = Assert.Single(page2.Changes);
        Assert.Equal("c", only.DocId);
        Assert.Equal(3, only.Rev);
        Assert.Equal("c3", only.Content);

        // An empty page keeps the cursor where it was.
        var page3 = await client.GetFromJsonAsync<ChangesResponse>($"/api/changes?since={page2.Next}&limit=2");
        Assert.Empty(page3!.Changes);
        Assert.False(page3.More);
        Assert.Equal(page2.Next, page3.Next);
    }

    [Fact]
    public async Task Tombstone_kinds_are_accepted_and_returned()
    {
        using var app = new TestApp();
        var client = app.Client();

        await Push(client, "gone", 0, content: "text");
        using var deleted = await Push(client, "gone", 1, kind: "deleted", content: null);
        Assert.Equal(HttpStatusCode.Created, deleted.StatusCode);

        await Push(client, "kept", 0, content: "text");
        using var detached = await Push(client, "kept", 1, kind: "detached", content: null);
        Assert.Equal(HttpStatusCode.Created, detached.StatusCode);

        var changes = await client.GetFromJsonAsync<ChangesResponse>("/api/changes");
        Assert.Equal(["deleted", "detached"], changes!.Changes.Select(c => c.Kind));
        Assert.All(changes.Changes, c => Assert.Null(c.Content));

        using var bad = await Push(client, "gone", null, kind: "nonsense");
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        using var noDevice = await client.PostAsJsonAsync(
            "/api/docs/gone/revisions",
            new { baseRev = (long?)null, kind = "text", content = "x", deviceId = "", clientTime = ClientTime });
        Assert.Equal(HttpStatusCode.BadRequest, noDevice.StatusCode);
    }

    [Fact]
    public async Task Purge_removes_only_the_revisions_below_the_bound()
    {
        using var app = new TestApp();
        var client = app.Client();

        await Push(client, "doc-5", 0, content: "one");
        await Push(client, "doc-5", 1, content: "two");
        await Push(client, "doc-5", 2, content: "three");

        using var noBound = await client.DeleteAsync("/api/docs/doc-5/revisions");
        Assert.Equal(HttpStatusCode.BadRequest, noBound.StatusCode);

        using var purge = await client.DeleteAsync("/api/docs/doc-5/revisions?below=3");
        var purged = await purge.Content.ReadFromJsonAsync<PurgeResponse>();
        Assert.Equal(2, purged!.Purged);

        var history = await client.GetFromJsonAsync<List<RevisionInfo>>("/api/docs/doc-5/revisions");
        var kept = Assert.Single(history!);
        Assert.Equal(3, kept.Rev);
        Assert.Equal(5, kept.Size);

        using var old = await client.GetAsync("/api/docs/doc-5/revisions/1");
        Assert.Equal(HttpStatusCode.NotFound, old.StatusCode);

        var still = await client.GetFromJsonAsync<Change>("/api/docs/doc-5/revisions/3");
        Assert.Equal("three", still!.Content);

        // A bound above the current revision never removes the newest row.
        using var greedy = await client.DeleteAsync("/api/docs/doc-5/revisions?below=99");
        var none = await greedy.Content.ReadFromJsonAsync<PurgeResponse>();
        Assert.Equal(0, none!.Purged);
        Assert.NotNull(await client.GetFromJsonAsync<Change>("/api/docs/doc-5"));
    }

    [Fact]
    public async Task History_lists_revisions_newest_first_without_content()
    {
        using var app = new TestApp();
        var client = app.Client();

        await Push(client, "doc-6", 0, content: "one");
        await Push(client, "doc-6", 1, kind: "deleted", content: null);

        var history = await client.GetFromJsonAsync<List<RevisionInfo>>("/api/docs/doc-6/revisions") ?? [];

        Assert.Equal([2L, 1L], history.Select(r => r.Rev));
        Assert.Equal(["deleted", "text"], history.Select(r => r.Kind));
        Assert.Equal([0, 3], history.Select(r => r.Size));
        Assert.All(history, r => Assert.Equal("device-a", r.DeviceId));
    }

    [Fact]
    public async Task Cors_preflight_from_an_allowed_origin_allows_the_Authorization_header()
    {
        using var app = new TestApp();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/api/docs/doc-7/revisions");
        request.Headers.Add("Origin", "https://urza.github.io");
        request.Headers.Add("Access-Control-Request-Method", "POST");
        request.Headers.Add("Access-Control-Request-Headers", "authorization,content-type");

        // No token: a preflight request carries none, and it must still succeed.
        using var response = await app.Client(token: null).SendAsync(request);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("https://urza.github.io", Header(response, "Access-Control-Allow-Origin"));
        Assert.Contains("Authorization", Header(response, "Access-Control-Allow-Headers"), StringComparison.OrdinalIgnoreCase);
        Assert.Contains("POST", Header(response, "Access-Control-Allow-Methods"), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Cors_preflight_from_an_unknown_origin_gets_no_allow_headers()
    {
        using var app = new TestApp();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/api/changes");
        request.Headers.Add("Origin", "https://evil.example");
        request.Headers.Add("Access-Control-Request-Method", "GET");

        using var response = await app.Client(token: null).SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }

    static Task<HttpResponseMessage> Push(
        HttpClient client,
        string docId,
        long? baseRev,
        string kind = "text",
        string? content = "text",
        object? meta = null,
        string deviceId = "device-a")
        => client.PostAsJsonAsync(
            $"/api/docs/{docId}/revisions",
            new { baseRev, kind, content, meta, deviceId, clientTime = ClientTime });

    static string Header(HttpResponseMessage response, string name) =>
        string.Join(",", response.Headers.GetValues(name));
}
