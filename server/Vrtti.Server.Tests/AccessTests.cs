using System.Net;
using System.Net.Http.Json;
using static Vrtti.Server.Tests.TestApp;

namespace Vrtti.Server.Tests;

/// <summary>What a device may read and write, moves, and the refusal of plain text.</summary>
public class AccessTests
{
    /// <summary>phone is in personal and dev-work; dev only in dev-work.</summary>
    static async Task<(TestApp App, Device Phone, Device Dev)> Start()
    {
        var app = new TestApp();
        var phone = await app.Register("phone");
        var dev = await app.Register("dev");
        await app.Space("personal", phone);
        await app.Space("dev-work", phone, dev);
        return (app, phone, dev);
    }

    [Fact]
    public async Task A_non_member_gets_403_on_changes_and_404_on_a_note()
    {
        var (app, phone, dev) = await Start();
        using var _ = app;
        await Push(phone.Http, "secret", "personal", baseRev: 0);
        await Push(phone.Http, "shared", "dev-work", baseRev: 0);

        using var changes = await dev.Http.GetAsync("/api/changes?spaces=personal");
        Assert.Equal(HttpStatusCode.Forbidden, changes.StatusCode);
        using var log = await dev.Http.GetAsync("/api/spaces/personal/log");
        Assert.Equal(HttpStatusCode.Forbidden, log.StatusCode);

        // Without spaces= a device gets its own spaces only.
        var all = await dev.Http.GetFromJsonAsync<ChangesResponse>("/api/changes");
        Assert.Equal(["shared"], all!.Changes.Select(c => c.DocId));

        foreach (var path in new[] { "/api/docs/secret", "/api/docs/secret/revisions", "/api/docs/secret/revisions/1" })
        {
            using var read = await dev.Http.GetAsync(path);
            Assert.Equal(HttpStatusCode.NotFound, read.StatusCode);
        }

        using var push = await Push(dev.Http, "secret", "dev-work", baseRev: 1);
        Assert.Equal(HttpStatusCode.NotFound, push.StatusCode);
        using var tombstone = await Push(dev.Http, "secret", "personal", kind: "deleted", content: null);
        Assert.Equal(HttpStatusCode.NotFound, tombstone.StatusCode);
        using var purge = await dev.Http.DeleteAsync("/api/docs/secret/revisions?below=1");
        Assert.Equal(HttpStatusCode.NotFound, purge.StatusCode);

        // A new note in a space of which dev is not a member.
        using var foreign = await Push(dev.Http, "new", "personal");
        Assert.Equal(HttpStatusCode.Forbidden, foreign.StatusCode);
        Assert.Equal(1, (await phone.Http.GetFromJsonAsync<Change>("/api/docs/secret"))!.Rev);
    }

    [Fact]
    public async Task The_keyring_is_open_to_each_device_and_skips_the_age_check()
    {
        var (app, phone, dev) = await Start();
        using var _ = app;

        using var push = await Push(phone.Http, "keyring", "keyring", content: "{\"v\":1}", meta: new { kind = "keyring" });
        Assert.Equal(HttpStatusCode.Created, push.StatusCode);
        using var devPush = await Push(dev.Http, "keyring", "keyring", content: "{\"v\":2}", meta: new { kind = "keyring" });
        Assert.Equal(HttpStatusCode.Created, devPush.StatusCode);

        var changes = await dev.Http.GetFromJsonAsync<ChangesResponse>("/api/changes");
        Assert.Equal("{\"v\":2}", Assert.Single(changes!.Changes).Content);

        // A note cannot move into the keyring, where each device could read it.
        await Push(phone.Http, "note", "personal");
        using var intoKeyring = await Push(phone.Http, "note", "keyring", content: "plain");
        Assert.Equal(HttpStatusCode.BadRequest, intoKeyring.StatusCode);

        // Nor can a new document: a dev device would put a plain note on each device.
        using var injected = await Push(dev.Http, "fake", "keyring", content: "plain", meta: new { kind = "scratch" });
        Assert.Equal(HttpStatusCode.BadRequest, injected.StatusCode);

        // The keyring record stays in keyring, and no device removes it.
        using var outOfKeyring = await Push(phone.Http, "keyring", "personal");
        Assert.Equal(HttpStatusCode.BadRequest, outOfKeyring.StatusCode);
        using var tombstone = await Push(dev.Http, "keyring", "keyring", kind: "deleted", content: null);
        Assert.Equal(HttpStatusCode.BadRequest, tombstone.StatusCode);
    }

    [Theory]
    [InlineData("plain text", null)]
    [InlineData(" -----BEGIN AGE ENCRYPTED FILE-----", null)]
    [InlineData(Age, "title")]
    [InlineData(Age, "lang")]
    [InlineData(Age, "sealed-plain")]
    [InlineData(Age, "sealed-number")]
    [InlineData(Age, "array")]
    public async Task Plain_text_and_readable_meta_are_refused(string content, string? metaCase)
    {
        var (app, phone, _) = await Start();
        using var __ = app;
        object? meta = metaCase switch
        {
            "title" => new { title = "Diary" },
            "lang" => new { kind = "note", lang = "markdown" },
            "sealed-plain" => new { @sealed = "{\"title\":\"Diary\"}" },
            "sealed-number" => new { @sealed = 5 },
            "array" => new[] { 1 },
            _ => null,
        };

        using var push = await Push(phone.Http, "doc", "personal", content: content, meta: meta);
        Assert.Equal(HttpStatusCode.BadRequest, push.StatusCode);
        using var tombstone = await Push(phone.Http, "doc", "personal", kind: "deleted", content: metaCase is null ? content : null, meta: meta);
        Assert.Equal(HttpStatusCode.BadRequest, tombstone.StatusCode);
    }

    [Fact]
    public async Task Sealed_notes_and_tombstones_pass()
    {
        var (app, phone, _) = await Start();
        using var __ = app;

        using var note = await Push(phone.Http, "doc", "personal", baseRev: 0,
            meta: new { kind = "note", enc = new { preset = "space", spaceSeq = 1 }, @sealed = Age });
        Assert.Equal(HttpStatusCode.Created, note.StatusCode);
        using var tombstone = await Push(phone.Http, "doc", "personal", baseRev: 1, kind: "deleted", content: null);
        Assert.Equal(HttpStatusCode.Created, tombstone.StatusCode);
    }

    [Fact]
    public async Task A_move_shows_in_the_old_space_without_content_also_when_the_note_sat_still()
    {
        var (app, phone, dev) = await Start();
        using var _ = app;
        await Push(dev.Http, "lent", "dev-work", baseRev: 0, meta: new { @sealed = Age });

        // dev synced up to here; the note then sits still in dev-work.
        var before = await dev.Http.GetFromJsonAsync<ChangesResponse>("/api/changes");
        Assert.Equal(["lent"], before!.Changes.Select(c => c.DocId));
        await Push(phone.Http, "other", "personal");

        // phone moves it to personal, where dev is not a member.
        using var moved = await Push(phone.Http, "lent", "personal", baseRev: 1, meta: new { enc = new { preset = "space" }, @sealed = Age });
        Assert.Equal(HttpStatusCode.Created, moved.StatusCode);

        var after = await dev.Http.GetFromJsonAsync<ChangesResponse>($"/api/changes?since={before.Next}");
        var row = Assert.Single(after!.Changes);
        Assert.Equal("lent", row.DocId);
        Assert.Equal("personal", row.Space);
        Assert.Equal(2, row.Rev);
        Assert.Null(row.Content);
        Assert.False(row.Meta!.Value.TryGetProperty("sealed", out var __));
        Assert.Equal("space", row.Meta!.Value.GetProperty("enc").GetProperty("preset").GetString());

        // phone, a member of both, gets the full row; dev cannot open the note any more.
        var full = await phone.Http.GetFromJsonAsync<ChangesResponse>($"/api/changes?spaces=dev-work&since={before.Next}");
        Assert.Equal(Age, Assert.Single(full!.Changes).Content);
        using var open = await dev.Http.GetAsync("/api/docs/lent");
        Assert.Equal(HttpStatusCode.NotFound, open.StatusCode);

        // A later pull from dev does not see the note again.
        var later = await dev.Http.GetFromJsonAsync<ChangesResponse>($"/api/changes?since={after.Next}");
        Assert.Empty(later!.Changes);
    }

    [Fact]
    public async Task A_move_is_not_lost_across_pages_when_the_note_changes_later()
    {
        var (app, phone, dev) = await Start();
        using var _ = app;
        await Push(dev.Http, "lent", "dev-work", baseRev: 0, meta: new { @sealed = Age });
        var start = await dev.Http.GetFromJsonAsync<ChangesResponse>("/api/changes");

        // The move, then a page of other rows in dev-work, then an edit in personal.
        using var moved = await Push(phone.Http, "lent", "personal", baseRev: 1, meta: new { @sealed = Age });
        var moveSeq = (await moved.Content.ReadFromJsonAsync<PushResponse>())!.Seq;
        for (var i = 0; i < 3; i++)
        {
            await Push(phone.Http, $"n{i}", "dev-work", baseRev: 0, meta: new { @sealed = Age });
        }

        await Push(phone.Http, "lent", "personal", baseRev: 2, meta: new { @sealed = Age });

        var seen = new List<Change>();
        var since = start!.Next;
        while (true)
        {
            var page = await dev.Http.GetFromJsonAsync<ChangesResponse>($"/api/changes?since={since}&limit=2");
            seen.AddRange(page!.Changes);
            since = page.Next;
            if (!page.More)
            {
                break;
            }
        }

        // The move comes first, at the seq of the move, and only once.
        Assert.Equal(["lent", "n0", "n1", "n2"], seen.Select(c => c.DocId));
        Assert.Equal(moveSeq, seen[0].Seq);
        Assert.Equal("personal", seen[0].Space);
        Assert.Null(seen[0].Content);
    }

    [Fact]
    public async Task A_move_needs_a_membership_of_both_spaces()
    {
        var (app, phone, dev) = await Start();
        using var _ = app;
        await Push(dev.Http, "lent", "dev-work", baseRev: 0);

        using var move = await Push(dev.Http, "lent", "personal", baseRev: 1);
        Assert.Equal(HttpStatusCode.Forbidden, move.StatusCode);
        using var back = await Push(phone.Http, "lent", "personal", baseRev: 1);
        Assert.Equal(HttpStatusCode.Created, back.StatusCode);
    }

    [Fact]
    public async Task History_leaves_out_revisions_of_other_spaces()
    {
        var (app, phone, dev) = await Start();
        using var _ = app;
        await Push(phone.Http, "lent", "personal", baseRev: 0);
        await Push(phone.Http, "lent", "personal", baseRev: 1);
        await Push(phone.Http, "lent", "dev-work", baseRev: 2);
        await Push(dev.Http, "lent", "dev-work", baseRev: 3);

        var devHistory = await dev.Http.GetFromJsonAsync<List<RevisionInfo>>("/api/docs/lent/revisions");
        Assert.Equal([4L, 3L], devHistory!.Select(r => r.Rev));
        using var old = await dev.Http.GetAsync("/api/docs/lent/revisions/1");
        Assert.Equal(HttpStatusCode.NotFound, old.StatusCode);

        var phoneHistory = await phone.Http.GetFromJsonAsync<List<RevisionInfo>>("/api/docs/lent/revisions");
        Assert.Equal([4L, 3L, 2L, 1L], phoneHistory!.Select(r => r.Rev));
    }
}
