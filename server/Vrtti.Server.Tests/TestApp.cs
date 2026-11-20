using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Vrtti.Server.Tests;

/// <summary>A server instance with its own SQLite file in a temporary directory.</summary>
/// <remarks>
/// The server reads its configuration from environment variables before the host exists,
/// so a test cannot inject them through IConfiguration. Environment variables are
/// process-wide, which is why AssemblyInfo.cs switches test parallelization off.
/// </remarks>
public sealed class TestApp : WebApplicationFactory<Program>
{
    public const string Token = "test-token-6c1f9a";

    /// <summary>An armored age file as far as the server can tell: it checks the header only.</summary>
    public const string Age = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n";

    public const long ClientTime = 1_700_000_000_000;

    readonly string _dir = Path.Combine(
        Path.GetTempPath(), "vrtti-tests", Guid.NewGuid().ToString("n"));

    /// <summary>The last entry of each space log that this test wrote, for seq and prev.</summary>
    readonly Dictionary<string, (long Seq, string Entry)> _heads = [];

    public FakeClock Clock { get; } = new();

    public string DbPath => Path.Combine(_dir, "vrtti.db");

    protected override IHost CreateHost(IHostBuilder builder)
    {
        Environment.SetEnvironmentVariable("VRTTI_TOKEN", Token);
        Environment.SetEnvironmentVariable("VRTTI_DB", DbPath);
        Environment.SetEnvironmentVariable("VRTTI_ORIGINS", "https://urza.github.io, http://localhost:8000");
        return base.CreateHost(builder);
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureServices(services => services.AddSingleton<TimeProvider>(Clock));

    /// <summary>A client with a bearer token. Pass null for an anonymous client.</summary>
    public HttpClient Client(string? token = Token)
    {
        var client = CreateClient();
        if (token is not null)
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return client;
    }

    /// <summary>Registers a device with the server token and returns it.</summary>
    public async Task<Device> Register(string id)
    {
        var token = NewToken();
        using var response = await Client().PostAsJsonAsync("/api/devices", new { id, tokenHash = Devices.HashToken(token) });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return new Device(id, Client(token));
    }

    public static string NewToken() => Convert.ToHexStringLower(Guid.NewGuid().ToByteArray()) + "-device";

    /// <summary>An entry key as app/js/crypto/keyring.js builds it.</summary>
    public static string KeyOf(string deviceId) =>
        string.Join("\n", "vrtti-device", deviceId, "name of " + deviceId, "age1recipient", "signkey", "1");

    /// <summary>The next entry of a space log, with the right seq and prev.</summary>
    public string NextEntry(string space, string op, string device, string by)
    {
        var (seq, last) = _heads.TryGetValue(space, out var head) ? head : (0, null!);
        return Entry(seq + 1, seq == 0 ? null : SpaceLog.Hash(last), op, space, KeyOf(device), KeyOf(by));
    }

    public static string Entry(long seq, string? prev, string op, string space, string device, string by) =>
        JsonSerializer.Serialize(new { seq, prev, op, space, device, by, color = "#6699CC", sig = "c2ln" });

    /// <summary>Posts an entry; on success it becomes the head of its space.</summary>
    public async Task<HttpResponseMessage> Post(Device caller, string space, string entry, bool claim = false)
    {
        var response = await caller.Http.PostAsJsonAsync($"/api/spaces/{space}/{(claim ? "claim" : "log")}", new { entry });
        if (response.StatusCode == HttpStatusCode.Created)
        {
            using var doc = JsonDocument.Parse(entry);
            _heads[space] = (doc.RootElement.GetProperty("seq").GetInt64(), entry);
        }

        return response;
    }

    public Task<HttpResponseMessage> Op(Device caller, string space, string op, Device target, bool claim = false) =>
        Post(caller, space, NextEntry(space, op, target.Id, caller.Id), claim);

    /// <summary>Makes a space with <paramref name="creator"/> and adds the others.</summary>
    public async Task Space(string space, Device creator, params Device[] others)
    {
        using var created = await Op(creator, space, "create", creator);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        foreach (var other in others)
        {
            using var added = await Op(creator, space, "add", other);
            Assert.Equal(HttpStatusCode.Created, added.StatusCode);
        }
    }

    public static Task<HttpResponseMessage> Push(
        HttpClient client,
        string docId,
        string? space,
        long? baseRev = null,
        string kind = "text",
        string? content = Age,
        object? meta = null)
        => client.PostAsJsonAsync(
            $"/api/docs/{docId}/revisions",
            new { baseRev, kind, content, meta, clientTime = ClientTime, space });

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing)
        {
            return;
        }

        try
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A leftover temporary directory must never fail a test run.
        }
    }
}

/// <summary>A registered device and a client that carries its device token.</summary>
public sealed record Device(string Id, HttpClient Http);

/// <summary>A clock the test moves by hand, to expire a join code.</summary>
public sealed class FakeClock : TimeProvider
{
    public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;

    public override DateTimeOffset GetUtcNow() => Now;
}
