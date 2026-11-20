using System.Net;
using System.Net.Http.Json;
using Microsoft.Data.Sqlite;
using static Vrtti.Server.Tests.TestApp;

namespace Vrtti.Server.Tests;

/// <summary>The space log, the member table and the claim of old spaces.</summary>
public class SpaceLogTests
{
    [Fact]
    public async Task Members_add_and_remove_devices_and_the_log_records_each_step()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var desk = await app.Register("desk");
        var dev = await app.Register("dev");
        await app.Space("personal", phone, desk);

        // desk is a member like phone: no admins.
        using var added = await app.Op(desk, "personal", "add", dev);
        Assert.Equal(HttpStatusCode.Created, added.StatusCode);
        using var removed = await app.Op(dev, "personal", "remove", phone);
        Assert.Equal(HttpStatusCode.Created, removed.StatusCode);

        var log = await desk.Http.GetFromJsonAsync<List<LogEntry>>("/api/spaces/personal/log") ?? [];
        Assert.Equal([1L, 2L, 3L, 4L], log.Select(e => e.Seq));
        var tail = await desk.Http.GetFromJsonAsync<List<LogEntry>>("/api/spaces/personal/log?since=2") ?? [];
        Assert.Equal([3L, 4L], tail.Select(e => e.Seq));
        // Each entry comes back as the exact text that was sent, so prev hashes match.
        Assert.Equal(SpaceLog.Hash(log[0].Entry), System.Text.Json.JsonDocument.Parse(log[1].Entry).RootElement.GetProperty("prev").GetString());

        // phone is out: no log, no spaces, no entries.
        using var phoneLog = await phone.Http.GetAsync("/api/spaces/personal/log");
        Assert.Equal(HttpStatusCode.Forbidden, phoneLog.StatusCode);
        Assert.Empty((await phone.Http.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces"))!);
        using var phoneEntry = await app.Op(phone, "personal", "add", phone);
        Assert.Equal(HttpStatusCode.Forbidden, phoneEntry.StatusCode);
    }

    [Fact]
    public async Task An_entry_with_a_wrong_seq_or_prev_is_409()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var desk = await app.Register("desk");
        await app.Space("personal", phone);
        var created = (await phone.Http.GetFromJsonAsync<List<LogEntry>>("/api/spaces/personal/log"))![0].Entry;

        using var oldSeq = await app.Post(phone, "personal", Entry(1, null, "add", "personal", KeyOf("desk"), KeyOf("phone")));
        Assert.Equal(HttpStatusCode.Conflict, oldSeq.StatusCode);
        using var gap = await app.Post(phone, "personal", Entry(3, SpaceLog.Hash(created), "add", "personal", KeyOf("desk"), KeyOf("phone")));
        Assert.Equal(HttpStatusCode.Conflict, gap.StatusCode);
        using var badPrev = await app.Post(phone, "personal", Entry(2, SpaceLog.Hash("other"), "add", "personal", KeyOf("desk"), KeyOf("phone")));
        Assert.Equal(HttpStatusCode.Conflict, badPrev.StatusCode);
        using var right = await app.Post(phone, "personal", Entry(2, SpaceLog.Hash(created), "add", "personal", KeyOf("desk"), KeyOf("phone")));
        Assert.Equal(HttpStatusCode.Created, right.StatusCode);
    }

    [Fact]
    public async Task A_non_member_cannot_write_an_entry()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var dev = await app.Register("dev");
        await app.Space("personal", phone);

        using var entry = await app.Op(dev, "personal", "add", dev);
        Assert.Equal(HttpStatusCode.Forbidden, entry.StatusCode);
    }

    [Fact]
    public async Task The_last_member_cannot_remove_itself_and_nothing_changes()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Space("personal", phone);

        using var removed = await app.Op(phone, "personal", "remove", phone);
        Assert.Equal(HttpStatusCode.Conflict, removed.StatusCode);

        // The entry and the member row change together, or not at all.
        Assert.Single((await phone.Http.GetFromJsonAsync<List<LogEntry>>("/api/spaces/personal/log"))!);
        Assert.Equal(["personal"], (await phone.Http.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces"))!.Select(s => s.Space));
    }

    [Fact]
    public async Task Adds_and_removes_must_make_sense()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var desk = await app.Register("desk");
        await app.Space("personal", phone, desk);

        using var twice = await app.Op(phone, "personal", "add", desk);
        Assert.Equal(HttpStatusCode.BadRequest, twice.StatusCode);
        using var unknown = await app.Post(phone, "personal", app.NextEntry("personal", "add", "ghost", "phone"));
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        using var nonsense = await app.Post(phone, "personal", app.NextEntry("personal", "promote", "desk", "phone"));
        Assert.Equal(HttpStatusCode.BadRequest, nonsense.StatusCode);
        using var color = await app.Op(desk, "personal", "color", desk);
        Assert.Equal(HttpStatusCode.Created, color.StatusCode);
    }

    [Fact]
    public async Task A_second_create_of_a_name_is_refused()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var dev = await app.Register("dev");
        await app.Space("personal", phone);

        using var again = await app.Post(dev, "personal", Entry(1, null, "create", "personal", KeyOf("dev"), KeyOf("dev")));
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);

        using var keyring = await app.Post(dev, "keyring", Entry(1, null, "create", "keyring", KeyOf("dev"), KeyOf("dev")));
        Assert.Equal(HttpStatusCode.BadRequest, keyring.StatusCode);

        // A create adds its own author and nobody else.
        using var forOther = await app.Post(dev, "mine", Entry(1, null, "create", "mine", KeyOf("phone"), KeyOf("dev")));
        Assert.Equal(HttpStatusCode.BadRequest, forOther.StatusCode);
        using var otherSpace = await app.Post(dev, "mine", Entry(1, null, "create", "yours", KeyOf("dev"), KeyOf("dev")));
        Assert.Equal(HttpStatusCode.BadRequest, otherSpace.StatusCode);
        using var garbage = await app.Post(dev, "mine", "not json");
        Assert.Equal(HttpStatusCode.BadRequest, garbage.StatusCode);
    }

    [Fact]
    public async Task Old_spaces_are_listed_and_claimed_only_by_a_device_of_the_server_token()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        // Rows from before the upgrade: no member, no log.
        SeedOldRows(app.DbPath, ("n1", "personal"), ("n2", "work"), ("k", "keyring"));

        Assert.Equal(["personal", "work"], await phone.Http.GetFromJsonAsync<List<string>>("/api/spaces/unclaimed"));

        // A joined device has no right to old spaces, and a normal create cannot take one.
        await app.Space("dev-work", phone);
        await phone.Http.PostAsJsonAsync("/api/joins", new { slot = "EEE", verifier = "v", spaces = new[] { "dev-work" } });
        var token = NewToken();
        await app.Client(null).PostAsJsonAsync("/api/joins/redeem", new
        {
            slot = "EEE", verifier = "v", deviceId = "dev", tokenHash = Devices.HashToken(token), entry = KeyOf("dev"), proof = "p",
        });
        var dev = new Device("dev", app.Client(token));
        using var devList = await dev.Http.GetAsync("/api/spaces/unclaimed");
        Assert.Equal(HttpStatusCode.Forbidden, devList.StatusCode);
        using var devClaim = await app.Op(dev, "personal", "create", dev, claim: true);
        Assert.Equal(HttpStatusCode.Forbidden, devClaim.StatusCode);
        using var devCreate = await app.Op(dev, "personal", "create", dev);
        Assert.Equal(HttpStatusCode.Conflict, devCreate.StatusCode);

        // A claim needs old rows: a fresh name goes through create.
        using var fresh = await app.Op(phone, "fresh", "create", phone, claim: true);
        Assert.Equal(HttpStatusCode.Conflict, fresh.StatusCode);

        using var claimed = await app.Op(phone, "personal", "create", phone, claim: true);
        Assert.Equal(HttpStatusCode.Created, claimed.StatusCode);
        Assert.Equal(["work"], await phone.Http.GetFromJsonAsync<List<string>>("/api/spaces/unclaimed"));
        var changes = await phone.Http.GetFromJsonAsync<ChangesResponse>("/api/changes?spaces=personal");
        Assert.Equal(["n1"], changes!.Changes.Select(c => c.DocId));

        using var second = await app.Post(phone, "personal", Entry(1, null, "create", "personal", KeyOf("phone"), KeyOf("phone")), claim: true);
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
    }

    /// <summary>Writes rows straight into the table, as an old server left them.</summary>
    static void SeedOldRows(string path, params (string DocId, string Space)[] rows)
    {
        using var conn = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path }.ToString());
        conn.Open();
        foreach (var (docId, space) in rows)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time, space)
                VALUES ($id, 1, 'text', 'plain old text', NULL, 'old', 1, 1, $space)
                """;
            cmd.Parameters.AddWithValue("$id", docId);
            cmd.Parameters.AddWithValue("$space", space);
            cmd.ExecuteNonQuery();
        }
    }
}
