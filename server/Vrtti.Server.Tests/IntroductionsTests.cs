using System.Net;
using System.Net.Http.Json;
using static Vrtti.Server.Tests.TestApp;

namespace Vrtti.Server.Tests;

/// <summary>The device directory: signed introductions (architecture.md section 27).</summary>
public class IntroductionsTests
{
    static Task<HttpResponseMessage> Vouch(Device by, string device, bool replaces = false, string sig = "c2ln") =>
        by.Http.PostAsJsonAsync("/api/introductions", new { device = KeyOf(device), by = KeyOf(by.Id), replaces, sig });

    [Fact]
    public async Task Every_device_reads_every_entry()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        var desktop = await app.Register("desktop");
        var laptop = await app.Register("laptop");

        using var first = await Vouch(desktop, "laptop");
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        using var second = await Vouch(laptop, "desktop", replaces: true);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);

        // The phone shares nothing with either, and still reads both.
        var all = (await phone.Http.GetFromJsonAsync<List<Introduction>>("/api/introductions"))!;
        Assert.Equal(2, all.Count);
        Assert.Contains(all, i => i.Device == KeyOf("laptop") && i.By == KeyOf("desktop") && !i.Replaces && i.Sig == "c2ln");
        Assert.Contains(all, i => i.Device == KeyOf("desktop") && i.By == KeyOf("laptop") && i.Replaces);
    }

    [Fact]
    public async Task A_device_writes_only_as_itself()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Register("desktop");

        using var forged = await phone.Http.PostAsJsonAsync("/api/introductions",
            new { device = KeyOf("phone"), by = KeyOf("desktop"), sig = "c2ln" });
        Assert.Equal(HttpStatusCode.Forbidden, forged.StatusCode);
        Assert.Empty((await phone.Http.GetFromJsonAsync<List<Introduction>>("/api/introductions"))!);

        // The server token is no device and writes nothing.
        using var server = await app.Client().PostAsJsonAsync("/api/introductions",
            new { device = KeyOf("phone"), by = KeyOf("desktop"), sig = "c2ln" });
        Assert.Equal(HttpStatusCode.Unauthorized, server.StatusCode);
    }

    [Fact]
    public async Task An_unknown_device_and_oversized_fields_are_refused()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");

        using var unknown = await Vouch(phone, "stranger");
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
        using var noKey = await phone.Http.PostAsJsonAsync("/api/introductions",
            new { device = "not a key", by = KeyOf("phone"), sig = "c2ln" });
        Assert.Equal(HttpStatusCode.BadRequest, noKey.StatusCode);
        await app.Register("desktop");
        using var longSig = await Vouch(phone, "desktop", sig: new string('a', 257));
        Assert.Equal(HttpStatusCode.BadRequest, longSig.StatusCode);
        using var longKey = await phone.Http.PostAsJsonAsync("/api/introductions",
            new { device = KeyOf("desktop") + new string('x', 4096), by = KeyOf("phone"), sig = "c2ln" });
        Assert.Equal(HttpStatusCode.BadRequest, longKey.StatusCode);
        Assert.Empty((await phone.Http.GetFromJsonAsync<List<Introduction>>("/api/introductions"))!);
    }

    [Fact]
    public async Task A_duplicate_is_a_no_op()
    {
        using var app = new TestApp();
        var phone = await app.Register("phone");
        await app.Register("desktop");

        using var first = await Vouch(phone, "desktop");
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        // Another signature for the same pair does not replace the first one.
        using var again = await Vouch(phone, "desktop", replaces: true, sig: "b3RoZXI");
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);

        var entry = Assert.Single((await phone.Http.GetFromJsonAsync<List<Introduction>>("/api/introductions"))!);
        Assert.Equal("c2ln", entry.Sig);
        Assert.False(entry.Replaces);
    }
}
