using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Primitives;
using Vrtti.Server;

// Configuration comes from the environment only. The server is one process with one
// user; a settings file would add a second place to look.
var token = Environment.GetEnvironmentVariable("VRTTI_TOKEN");
if (string.IsNullOrWhiteSpace(token))
{
    Console.Error.WriteLine(
        "VRTTI_TOKEN is not set. The server refuses to start without it, because an "
        + "empty token would let anyone register a device.");
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
// TryAdd: the tests register a clock of their own first, to expire a join code.
builder.Services.TryAddSingleton(TimeProvider.System);
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

// Two kinds of bearer token (architecture.md section 27). The server token only
// registers the first device: with it, POST /api/devices and nothing else. Every other
// request carries a device token, and the server knows the device from its hash.
var serverToken = Encoding.UTF8.GetBytes(token);
app.Use(async (context, next) =>
{
    var request = context.Request;
    var path = request.Path;
    var open = !path.StartsWithSegments("/api")
        || path.StartsWithSegments("/api/health")
        || path.StartsWithSegments("/api/version")
        // The new device has no token yet; the join code is its proof.
        || (HttpMethods.IsPost(request.Method) && IsExactly(path, "/api/joins/redeem"));
    if (open)
    {
        await next(context);
        return;
    }

    var bearer = BearerOf(request.Headers.Authorization);
    if (bearer is null)
    {
        await Unauthorized(context, "unauthorized");
        return;
    }

    // Constant-time compare. A normal comparison stops at the first wrong byte, so the
    // response time tells an attacker how many leading bytes are right, and the token
    // falls byte by byte. FixedTimeEquals always reads both buffers.
    if (CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(bearer), serverToken))
    {
        if (HttpMethods.IsPost(request.Method) && IsExactly(path, "/api/devices"))
        {
            context.Items[Auth.ServerTokenKey] = true;
            await next(context);
            return;
        }

        // The upgrade relies on this answer: a device that still holds the server token
        // learns that it must register or join (architecture.md section 27).
        await Unauthorized(context, "a device token is required");
        return;
    }

    var db = context.RequestServices.GetRequiredService<Db>();
    using (var conn = db.Open())
    {
        if (Devices.ByTokenHash(conn, Devices.HashToken(bearer)) is not { } caller)
        {
            await Unauthorized(context, "unauthorized");
            return;
        }

        context.Items[typeof(Caller)] = caller;
    }

    await next(context);
});

var api = app.MapGroup("/api");

// No auth: a monitor or a reverse proxy must be able to see the server is alive.
api.MapGet("/health", () => Results.Ok(new { ok = true }));

// The build stamp is the UTC minute of the build, set in the project file. No auth: it
// exists to check that a deploy took, and that check is easiest from a plain browser tab.
var build = long.Parse(typeof(Program).Assembly
    .GetCustomAttributes<AssemblyMetadataAttribute>()
    .First(attribute => attribute.Key == "BuildStamp").Value!);
api.MapGet("/version", () => Results.Ok(new { build }));

DeviceApi.Map(api);
SpaceApi.Map(api);

api.MapGet("/changes", (HttpContext context, Db db, long? since, int? limit, string? spaces) =>
{
    var caller = context.Caller();
    var from = since is > 0 ? since.Value : 0;
    var take = Math.Clamp(limit ?? 200, 1, 500);
    var names = (spaces ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (!names.All(SpaceLog.IsSpaceName))
    {
        return Results.BadRequest(new ErrorResponse(SpaceLog.BadSpaceName));
    }

    using var conn = db.Open();
    var readable = SpaceLog.Readable(conn, caller.Id);
    // "spaces=a,b" narrows the caller's spaces; it never widens them. Absent or empty
    // means all of them.
    if (names.FirstOrDefault(name => !readable.Contains(name)) is { } foreign)
    {
        return Results.Json(new ErrorResponse($"not a member of {foreign}"), statusCode: 403);
    }

    IReadOnlyCollection<string> wanted = names.Length > 0 ? names.ToHashSet() : readable;
    // One row over the page size answers "is there more?" without a second count query.
    var changes = Revisions.Changes(conn, from, take + 1, wanted);
    var more = changes.Count > take;
    if (more)
    {
        changes.RemoveAt(changes.Count - 1);
    }

    // An empty page must not move the cursor backward, so it keeps the old value.
    var next = changes.Count > 0 ? changes[^1].Seq : from;
    // A row that moved the document into a space the caller cannot read only says that
    // the document left.
    var visible = changes.Select(c => readable.Contains(c.Space) ? c : Revisions.WithoutSecrets(c)).ToList();
    return Results.Ok(new ChangesResponse(visible, next, more));
});

api.MapPost("/docs/{id}/revisions", (HttpContext context, Db db, TimeProvider clock, string id, PushRequest request) =>
{
    var caller = context.Caller();
    if (request.Kind is not ("text" or "deleted" or "detached"))
    {
        return Results.BadRequest(new ErrorResponse("kind must be text, deleted or detached"));
    }

    if (request.Space is not { } space || !SpaceLog.IsSpaceName(space))
    {
        return Results.BadRequest(new ErrorResponse(SpaceLog.BadSpaceName));
    }

    if (space != SpaceLog.Keyring && Sealed.Check(request.Kind, request.Content, request.Meta) is { } refused)
    {
        return Results.BadRequest(new ErrorResponse(refused));
    }

    // The meta object is stored as the exact JSON text the client sent.
    var meta = request.Meta is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } value
        ? value.GetRawText()
        : null;
    var serverTime = clock.GetUtcNow().ToUnixTimeMilliseconds();

    using var conn = db.Open();
    // BEGIN IMMEDIATE (deferred: false) takes the write lock before the first read. With a
    // deferred transaction two concurrent pushes could both read the same current revision
    // and then race for rev + 1; one would fail on the UNIQUE(doc_id, rev) constraint.
    using var transaction = conn.BeginTransaction(deferred: false);

    var readable = SpaceLog.Readable(conn, caller.Id);
    var current = Revisions.Current(conn, id);
    // 404 and not 403: a device outside the space must not learn that the note exists.
    if (current is not null && !readable.Contains(current.Space))
    {
        return Results.NotFound(new ErrorResponse("unknown document"));
    }

    if (!readable.Contains(space))
    {
        return Results.Json(new ErrorResponse($"not a member of {space}"), statusCode: 403);
    }

    // The keyring space skips the plain-text check and every device reads it, so a note
    // that moved in would be open to all devices.
    if (current is not null && (current.Space == SpaceLog.Keyring) != (space == SpaceLog.Keyring))
    {
        return Results.BadRequest(new ErrorResponse("a document cannot move into or out of keyring"));
    }

    var currentRev = current?.Rev ?? 0;
    if (request.BaseRev is { } claimed && claimed != currentRev)
    {
        // The client pushed against a revision that is no longer current. It gets the
        // current one back and resolves the conflict locally (architecture.md section 3).
        return Results.Json(new ConflictResponse(current), statusCode: 409);
    }

    var rev = currentRev + 1;
    var prevSpace = current is not null && current.Space != space ? current.Space : null;
    var seq = Revisions.Insert(
        conn, id, rev, request.Kind, request.Content, meta,
        caller.Id, request.ClientTime, serverTime, space, prevSpace);
    transaction.Commit();

    return Results.Created($"/api/docs/{id}/revisions/{rev}", new PushResponse(rev, seq));
});

api.MapGet("/docs/{id}", (HttpContext context, Db db, string id) =>
{
    using var conn = db.Open();
    var change = Revisions.Current(conn, id);
    return change is null || !SpaceLog.Readable(conn, context.Caller().Id).Contains(change.Space)
        ? Results.NotFound(new ErrorResponse("unknown document"))
        : Results.Ok(change);
});

api.MapGet("/docs/{id}/revisions", (HttpContext context, Db db, string id) =>
{
    using var conn = db.Open();
    var readable = SpaceLog.Readable(conn, context.Caller().Id);
    var current = Revisions.Current(conn, id);
    return current is null || !readable.Contains(current.Space)
        ? Results.NotFound(new ErrorResponse("unknown document"))
        : Results.Ok(Revisions.History(conn, id, readable));
});

api.MapGet("/docs/{id}/revisions/{rev:long}", (HttpContext context, Db db, string id, long rev) =>
{
    using var conn = db.Open();
    var readable = SpaceLog.Readable(conn, context.Caller().Id);
    var current = Revisions.Current(conn, id);
    var change = current is not null && readable.Contains(current.Space) ? Revisions.One(conn, id, rev) : null;
    return change is null || !readable.Contains(change.Space)
        ? Results.NotFound(new ErrorResponse("unknown revision"))
        : Results.Ok(change);
});

api.MapDelete("/docs/{id}/revisions", (HttpContext context, Db db, string id, long? below) =>
{
    // "below" is required on purpose: a purge without a bound would be "delete the
    // history", and a typo in a query string should not do that.
    if (below is null)
    {
        return Results.BadRequest(new ErrorResponse("below is required"));
    }

    using var conn = db.Open();
    var current = Revisions.Current(conn, id);
    if (current is not null && !SpaceLog.Readable(conn, context.Caller().Id).Contains(current.Space))
    {
        return Results.NotFound(new ErrorResponse("unknown document"));
    }

    return Results.Ok(new PurgeResponse(Revisions.Purge(conn, id, below.Value)));
});

app.Run();
return 0;

static string? BearerOf(StringValues header)
{
    var value = header.Count == 1 ? header[0] : null;
    return value is not null && value.StartsWith("Bearer ", StringComparison.Ordinal)
        ? value["Bearer ".Length..]
        : null;
}

static bool IsExactly(PathString path, string expected) =>
    path.StartsWithSegments(expected, out var rest) && !rest.HasValue;

static Task Unauthorized(HttpContext context, string error)
{
    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
    return context.Response.WriteAsJsonAsync(new ErrorResponse(error));
}

// WebApplicationFactory<Program> in the test project needs a public Program type.
public partial class Program;
