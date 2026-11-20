using System.Net;
using System.Net.Http.Json;
using static Vrtti.Server.Tests.TestApp;

namespace Vrtti.Server.Tests;

/// <summary>Registration, device tokens, successors and joins.</summary>
public class DevicesTests
{
    const string Verifier = "a1b2c3";

    [Fact]
    public async Task The_server_token_registers_a_device_and_reads_nothing()
    {
        using var app = new TestApp();
        var server = app.Client();

        foreach (var path in new[] { "/api/changes", "/api/spaces", "/api/docs/x", "/api/joins" })
        {
            using var read = await server.GetAsync(path);
            Assert.Equal(HttpStatusCode.Unauthorized, read.StatusCode);
            var error = await read.Content.ReadFromJsonAsync<ErrorResponse>();
            Assert.Equal("a device token is required", error!.Error);
        }

        using var push = await Push(server, "x", "personal");
        Assert.Equal(HttpStatusCode.Unauthorized, push.StatusCode);

        var phone = await app.Register("phone");
        using var spaces = await phone.Http.GetAsync("/api/spaces");
        Assert.Equal(HttpStatusCode.OK, spaces.StatusCode);
    }

    [Fact]
    public async Task Registration_refuses_a_taken_id_a_bad_hash_and_a_device_token()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var server = app.Client();

        using var again = await server.PostAsJsonAsync("/api/devices", new { id = "phone", tokenHash = Devices.HashToken("other") });
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);

        using var badHash = await server.PostAsJsonAsync("/api/devices", new { id = "x", tokenHash = "NOTHEX" });
        Assert.Equal(HttpStatusCode.BadRequest, badHash.StatusCode);

        // A device token must not register devices, or one token makes any number of them.
        using var byDevice = await phone.Http.PostAsJsonAsync("/api/devices", new { id = "x", tokenHash = Devices.HashToken("t") });
        Assert.Equal(HttpStatusCode.Forbidden, byDevice.StatusCode);
    }

    [Fact]
    public async Task A_device_token_acts_only_for_its_own_device()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var dev = await app.Register("dev");
        await app.Space("personal", phone);
        await app.Space("dev-work", dev);

        await Push(dev.Http, "d", "dev-work");
        var change = await dev.Http.GetFromJsonAsync<Change>("/api/docs/d");
        Assert.Equal("dev", change!.DeviceId);

        // dev cannot write an entry in the name of phone, also not in its own space.
        using var forged = await app.Post(dev, "dev-work", app.NextEntry("dev-work", "add", "phone", "phone"));
        Assert.Equal(HttpStatusCode.BadRequest, forged.StatusCode);
    }

    [Fact]
    public async Task A_successor_needs_the_old_device_token_and_comes_once()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");

        using var anonymous = await app.Client(null).PostAsJsonAsync("/api/devices/successor",
            new { id = "phone-2", tokenHash = Devices.HashToken("t2") });
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        // The server token cannot do it either: only the first device has it.
        using var server = await app.Client().PostAsJsonAsync("/api/devices/successor",
            new { id = "phone-2", tokenHash = Devices.HashToken("t2") });
        Assert.Equal(HttpStatusCode.Unauthorized, server.StatusCode);

        var token = NewToken();
        using var first = await phone.Http.PostAsJsonAsync("/api/devices/successor",
            new { id = "phone-2", tokenHash = Devices.HashToken(token) });
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        using var second = await phone.Http.PostAsJsonAsync("/api/devices/successor",
            new { id = "phone-3", tokenHash = Devices.HashToken(NewToken()) });
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);

        // The successor works with its own token and is a member of nothing yet.
        var successor = app.Client(token);
        Assert.Empty((await successor.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces"))!);
    }

    [Fact]
    public async Task A_join_registers_the_new_device_and_waits_for_the_member()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Space("personal", phone);
        await app.Space("dev-work", phone);

        using var created = await CreateJoin(phone, "K7M", ["dev-work"]);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);

        var token = NewToken();
        using var redeemed = await Redeem(app, "K7M", Verifier, "dev", token);
        Assert.Equal(HttpStatusCode.Created, redeemed.StatusCode);

        // The member sees the used join, with what the new device sent.
        var pending = Assert.Single((await phone.Http.GetFromJsonAsync<List<PendingJoin>>("/api/joins"))!);
        Assert.Equal("K7M", pending.Slot);
        Assert.Equal(["dev-work"], pending.Spaces);
        Assert.Equal("dev", pending.DeviceId);
        Assert.Equal(KeyOf("dev"), pending.Entry);
        Assert.Equal("proof", pending.Proof);

        var dev = new Device("dev", app.Client(token));
        var waiting = await dev.Http.GetFromJsonAsync<JoinReply>("/api/joins/K7M/reply");
        Assert.Null(waiting!.Reply);

        // The member adds the device, then answers.
        using var added = await app.Op(phone, "dev-work", "add", dev);
        Assert.Equal(HttpStatusCode.Created, added.StatusCode);
        using var answered = await phone.Http.PostAsJsonAsync("/api/joins/K7M/reply", new { reply = "r", mac = "m" });
        Assert.Equal(HttpStatusCode.NoContent, answered.StatusCode);
        Assert.Empty((await phone.Http.GetFromJsonAsync<List<PendingJoin>>("/api/joins"))!);

        var reply = await dev.Http.GetFromJsonAsync<JoinReply>("/api/joins/K7M/reply");
        Assert.Equal(new JoinReply("r", "m"), reply);
        Assert.Equal(["dev-work"], (await dev.Http.GetFromJsonAsync<List<SpaceInfo>>("/api/spaces"))!.Select(s => s.Space));

        // Another device cannot read the reply, and a second redeem fails.
        using var foreign = await phone.Http.GetAsync("/api/joins/K7M/reply");
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        using var twice = await Redeem(app, "K7M", Verifier, "dev-2", NewToken());
        Assert.Equal(HttpStatusCode.NotFound, twice.StatusCode);
    }

    [Fact]
    public async Task A_join_gives_only_spaces_of_the_member()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var dev = await app.Register("dev");
        await app.Space("personal", phone);
        await app.Space("dev-work", dev);

        using var foreign = await CreateJoin(dev, "AAA", ["dev-work", "personal"]);
        Assert.Equal(HttpStatusCode.Forbidden, foreign.StatusCode);

        using var badSlot = await CreateJoin(phone, "ILO", ["personal"]);
        Assert.Equal(HttpStatusCode.BadRequest, badSlot.StatusCode);

        using var ok = await CreateJoin(phone, "AAA", ["personal"]);
        Assert.Equal(HttpStatusCode.Created, ok.StatusCode);
        using var busy = await CreateJoin(dev, "AAA", ["dev-work"]);
        Assert.Equal(HttpStatusCode.Conflict, busy.StatusCode);
    }

    [Fact]
    public async Task Five_wrong_verifiers_end_the_join()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Space("personal", phone);
        await CreateJoin(phone, "BBB", ["personal"]);

        for (var i = 0; i < 5; i++)
        {
            using var wrong = await Redeem(app, "BBB", "wrong", "dev", NewToken());
            Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
        }

        using var right = await Redeem(app, "BBB", Verifier, "dev", NewToken());
        Assert.Equal(HttpStatusCode.NotFound, right.StatusCode);
        Assert.Empty((await phone.Http.GetFromJsonAsync<List<PendingJoin>>("/api/joins"))!);
    }

    [Fact]
    public async Task A_join_expires_after_ten_minutes_and_frees_its_slot()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Space("personal", phone);
        await CreateJoin(phone, "CCC", ["personal"]);

        app.Clock.Now += TimeSpan.FromMinutes(10) + TimeSpan.FromSeconds(1);
        using var late = await Redeem(app, "CCC", Verifier, "dev", NewToken());
        Assert.Equal(HttpStatusCode.NotFound, late.StatusCode);

        using var reuse = await CreateJoin(phone, "CCC", ["personal"]);
        Assert.Equal(HttpStatusCode.Created, reuse.StatusCode);
        using var inTime = await Redeem(app, "CCC", Verifier, "dev", NewToken());
        Assert.Equal(HttpStatusCode.Created, inTime.StatusCode);

        // A used join that waits for its member keeps its slot after the ten minutes.
        app.Clock.Now += TimeSpan.FromMinutes(11);
        using var taken = await CreateJoin(phone, "CCC", ["personal"]);
        Assert.Equal(HttpStatusCode.Conflict, taken.StatusCode);
    }

    [Fact]
    public async Task A_redeem_with_a_taken_device_id_keeps_the_join_open()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Space("personal", phone);
        await CreateJoin(phone, "DDD", ["personal"]);

        using var clash = await Redeem(app, "DDD", Verifier, "phone", NewToken());
        Assert.Equal(HttpStatusCode.Conflict, clash.StatusCode);
        using var retry = await Redeem(app, "DDD", Verifier, "dev", NewToken());
        Assert.Equal(HttpStatusCode.Created, retry.StatusCode);
    }

    static Task<HttpResponseMessage> CreateJoin(Device member, string slot, string[] spaces) =>
        member.Http.PostAsJsonAsync("/api/joins", new { slot, verifier = Verifier, spaces });

    static Task<HttpResponseMessage> Redeem(TestApp app, string slot, string verifier, string deviceId, string token) =>
        app.Client(null).PostAsJsonAsync("/api/joins/redeem", new
        {
            slot,
            verifier,
            deviceId,
            tokenHash = Devices.HashToken(token),
            entry = KeyOf(deviceId),
            proof = "proof",
        });
}
