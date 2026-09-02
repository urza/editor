using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Primitives;
using Vrtti.Server;

// Configuration comes from the environment only. The server is one process with one
// user and one token; a settings file would add a second place to look.
var token = Environment.GetEnvironmentVariable("VRTTI_TOKEN");
if (string.IsNullOrWhiteSpace(token))
{
    Console.Error.WriteLine(
        "VRTTI_TOKEN is not set. The server refuses to start without it, because an "
        + "empty token would leave every document open to the internet.");
    Console.Error.WriteLine("Generate one with: openssl rand -hex 32");
    return 1;
}

var dbPath = Environment.GetEnvironmentVariable("VRTTI_DB") is { Length: > 0 } configuredDb
    ? configuredDb
    : "./data/vrtti.db";

var origins = (Environment.GetEnvironmentVariable("VRTTI_ORIGINS") is { Length: > 0 } configuredOrigins
        ? configuredOrigins
        : "https://urza.github.io")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

// One revision carries a whole document. 10 MB is far above any text file a person
// edits by hand, and it stops a single request from filling the disk.
const long maxBodyBytes = 10L * 1024 * 1024;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = maxBodyBytes);
builder.Services.AddSingleton(new Db(dbPath));
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(origins)
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "DELETE")));

var app = builder.Build();

// CORS runs before the token check for two reasons. A preflight request carries no
// Authorization header, so the check would answer it with 401 and the browser would
// never send the real request. And a 401 needs the CORS headers too, or the browser
// hides the status from the client.
app.UseCors();

var expectedToken = Encoding.UTF8.GetBytes(token);
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    var guarded = path.StartsWithSegments("/api") && !path.StartsWithSegments("/api/health");
    if (guarded && !IsAuthorized(context.Request.Headers.Authorization, expectedToken))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new ErrorResponse("unauthorized"));
        return;
    }

    await next(context);
});

var api = app.MapGroup("/api");

// No auth: a monitor or a reverse proxy must be able to see the server is alive.
api.MapGet("/health", () => Results.Ok(new { ok = true }));

api.MapGet("/changes", (Db db, long? since, int? limit) =>
{
    var from = since is > 0 ? since.Value : 0;
    var take = Math.Clamp(limit ?? 200, 1, 500);

    using var conn = db.Open();
    // One row over the page size answers "is there more?" without a second count query.
    var changes = Revisions.Changes(conn, from, take + 1);
    var more = changes.Count > take;
    if (more)
    {
        changes.RemoveAt(changes.Count - 1);
    }

    // An empty page must not move the cursor backward, so it keeps the old value.
    var next = changes.Count > 0 ? changes[^1].Seq : from;
    return Results.Ok(new ChangesResponse(changes, next, more));
});

api.MapPost("/docs/{id}/revisions", (Db db, string id, PushRequest request) =>
{
    if (request.Kind is not ("text" or "deleted" or "detached"))
    {
        return Results.BadRequest(new ErrorResponse("kind must be text, deleted or detached"));
    }

    if (string.IsNullOrWhiteSpace(request.DeviceId))
    {
        return Results.BadRequest(new ErrorResponse("deviceId is required"));
    }

    // The meta object is stored as the exact JSON text the client sent. The server never
    // reads inside it (architecture.md section 7).
    var meta = request.Meta is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } value
        ? value.GetRawText()
        : null;
    var serverTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    using var conn = db.Open();
    // BEGIN IMMEDIATE (deferred: false) takes the write lock before the first read. With a
    // deferred transaction two concurrent pushes could both read the same current revision
    // and then race for rev + 1; one would fail on the UNIQUE(doc_id, rev) constraint.
    using var transaction = conn.BeginTransaction(deferred: false);

    var current = Revisions.CurrentRev(conn, id);
    if (request.BaseRev is { } claimed && claimed != current)
    {
        // The client pushed against a revision that is no longer current. It gets the
        // current one back and resolves the conflict locally (architecture.md section 3).
        return Results.Json(new ConflictResponse(Revisions.Current(conn, id)), statusCode: 409);
    }

    var rev = current + 1;
    var seq = Revisions.Insert(
        conn, id, rev, request.Kind, request.Content, meta,
        request.DeviceId, request.ClientTime, serverTime);
    transaction.Commit();

    return Results.Created($"/api/docs/{id}/revisions/{rev}", new PushResponse(rev, seq));
});

api.MapGet("/docs/{id}", (Db db, string id) =>
{
    using var conn = db.Open();
    var change = Revisions.Current(conn, id);
    return change is null
        ? Results.NotFound(new ErrorResponse("unknown document"))
        : Results.Ok(change);
});

api.MapGet("/docs/{id}/revisions", (Db db, string id) =>
{
    using var conn = db.Open();
    return Results.Ok(Revisions.History(conn, id));
});

api.MapGet("/docs/{id}/revisions/{rev:long}", (Db db, string id, long rev) =>
{
    using var conn = db.Open();
    var change = Revisions.One(conn, id, rev);
    return change is null
        ? Results.NotFound(new ErrorResponse("unknown revision"))
        : Results.Ok(change);
});

api.MapDelete("/docs/{id}/revisions", (Db db, string id, long? below) =>
{
    // "below" is required on purpose: a purge without a bound would be "delete the
    // history", and a typo in a query string should not do that.
    if (below is null)
    {
        return Results.BadRequest(new ErrorResponse("below is required"));
    }

    using var conn = db.Open();
    return Results.Ok(new PurgeResponse(Revisions.Purge(conn, id, below.Value)));
});

app.Run();
return 0;

static bool IsAuthorized(StringValues header, byte[] expected)
{
    var value = header.Count == 1 ? header[0] : null;
    if (value is null || !value.StartsWith("Bearer ", StringComparison.Ordinal))
    {
        return false;
    }

    var given = Encoding.UTF8.GetBytes(value["Bearer ".Length..]);
    // Constant-time compare. A normal comparison stops at the first wrong byte, so the
    // response time tells an attacker how many leading bytes are right, and the token
    // falls byte by byte. FixedTimeEquals always reads both buffers.
    // It does return false at once for a length mismatch; the token length is not secret.
    return CryptographicOperations.FixedTimeEquals(given, expected);
}

// WebApplicationFactory<Program> in the test project needs a public Program type.
public partial class Program;
