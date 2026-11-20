using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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

// A push without a space comes from a client older than spaces (architecture.md section
// 25). Its notes belong where the migration put every old row.
const string defaultSpace = "personal";
const string badSpace = "space must be 1-32 letters, digits, - or _";

var builder = WebApplication.CreateBuilder(args);
// The console is the log (`docker logs`). One line per entry with the time, and no
// line for each request or each outgoing call: those were six lines per sync request,
// and they buried the model log (Model.cs) and the start lines. Their warnings stay.
builder.Logging.AddSimpleConsole(options =>
{
    options.SingleLine = true;
    options.TimestampFormat = "yyyy-MM-dd HH:mm:ss ";
});
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = maxBodyBytes);
builder.Services.AddSingleton(new Db(dbPath));
// The user's language model for "Add diacritics (vllm)", if VRTTI_MODEL_URL is set.
builder.Services.AddSingleton(ModelSettings.FromEnvironment());
builder.Services.AddSingleton<ModelCheckCache>();
builder.Services.AddHttpClient<DiacriticsModel>();
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins(origins)
    // The X-Vrtti-* headers name the caller of a model request for the log (Model.cs).
    .WithHeaders("Authorization", "Content-Type", "X-Vrtti-Device", "X-Vrtti-Run", "X-Vrtti-Part")
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
    var guarded = path.StartsWithSegments("/api")
        && !path.StartsWithSegments("/api/health")
        && !path.StartsWithSegments("/api/version");
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

// The build stamp is the UTC minute of the build, set in the project file. No auth: it
// exists to check that a deploy took, and that check is easiest from a plain browser tab.
var build = long.Parse(typeof(Program).Assembly
    .GetCustomAttributes<AssemblyMetadataAttribute>()
    .First(attribute => attribute.Key == "BuildStamp").Value!);
api.MapGet("/version", () => Results.Ok(new { build }));

// Behind the token, unlike /version: whether a model exists is nobody else's business.
// "diacritics" says only that a model is set, and the app shows "Add diacritics (vllm)"
// on it even when the model does not answer now: vLLM can start after the app.
// "state" is a live check (Model.cs, Check) for Settings and for curl.
api.MapGet("/model", async (DiacriticsModel model) =>
{
    if (!model.Available)
    {
        return Results.Ok(new { diacritics = false });
    }

    var check = await model.Check();
    return Results.Ok(new { diacritics = true, name = model.Name, state = check.State, served = check.Served, why = check.Why });
});

// One paragraph in, the same paragraph with diacritics out (.work/mixed-spellcheck/plan.md).
// The client sends many of these at once; the model batches them.
// Two log lines for each paragraph, with counts and states only, never text: "asked"
// shows a request that hangs at the model, and the second line says how it ended.
api.MapPost("/model/diacritics", async (DiacriticsModel model, DiacriticsRequest request, HttpContext context, ILogger<DiacriticsModel> log) =>
{
    if (!model.Available)
    {
        return Results.NotFound(new ErrorResponse("no model"));
    }

    if (request.Text is null)
    {
        return Results.BadRequest(new ErrorResponse("text is required"));
    }

    var (device, run, part) = DiacriticsModel.Caller(context.Request.Headers);
    if (request.Text.Length > DiacriticsModel.MaxChars)
    {
        log.LogWarning("diacritics run {Run} from {Device}: paragraph {Part} refused, {Chars} characters is above the limit",
            run, device, part, request.Text.Length);
        return Results.Json(new ErrorResponse("text too long"), statusCode: StatusCodes.Status413PayloadTooLarge);
    }

    log.LogInformation("diacritics run {Run} from {Device}: paragraph {Part} asked, {Chars} characters",
        run, device, part, request.Text.Length);
    var answer = await model.AddDiacritics(request.Text, context.RequestAborted);
    var outcome = answer.Text is null ? answer.Outcome : $"{answer.Outcome}, {DiacriticsModel.Difference(request.Text, answer.Text)}";

    // After the response is out, so "relayed" means the device got it. A device that
    // closed the app during the call shows here too, with the time it waited.
    context.Response.OnCompleted(() =>
    {
        var left = context.RequestAborted.IsCancellationRequested;
        var level = left || answer.Text is null ? LogLevel.Warning : LogLevel.Information;
        // A device that left during the model call is already in the outcome.
        var relay = !left ? (answer.Text is null ? "502 relayed" : "relayed")
            : answer.Outcome.StartsWith("the device left") ? "not relayed" : "not relayed, the device left";
        log.Log(level, "diacritics run {Run} paragraph {Part}: {Outcome}, {Relay}", run, part, outcome, relay);
        return Task.CompletedTask;
    });

    return answer.Text is null
        ? Results.Json(new ErrorResponse("the model did not answer"), statusCode: StatusCodes.Status502BadGateway)
        : Results.Ok(new DiacriticsResponse(answer.Text));
});

api.MapGet("/changes", (Db db, long? since, int? limit, string? spaces) =>
{
    var from = since is > 0 ? since.Value : 0;
    var take = Math.Clamp(limit ?? 200, 1, 500);

    // "spaces=a,b" is a subscription, not a grant: one token sees every space, and the
    // filter only keeps a device from storing what it does not want. Absent or empty
    // means every space, so a client from before spaces still gets all documents.
    var names = (spaces ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (!names.All(IsSpaceName))
    {
        return Results.BadRequest(new ErrorResponse(badSpace));
    }

    using var conn = db.Open();
    // One row over the page size answers "is there more?" without a second count query.
    var changes = Revisions.Changes(conn, from, take + 1, names);
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

    // The name is the only thing the server checks about a space. A new name makes a new
    // space; there is no list of spaces to register in.
    var space = request.Space ?? defaultSpace;
    if (!IsSpaceName(space))
    {
        return Results.BadRequest(new ErrorResponse(badSpace));
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
        request.DeviceId, request.ClientTime, serverTime, space);
    transaction.Commit();

    return Results.Created($"/api/docs/{id}/revisions/{rev}", new PushResponse(rev, seq));
});

// The settings panel lists the spaces a device can subscribe to. Counts, not documents:
// a device must not need to pull a space to learn that it exists.
api.MapGet("/spaces", (Db db) =>
{
    using var conn = db.Open();
    return Results.Ok(Revisions.Spaces(conn));
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

// One model check at the start, so `docker logs` shows a wrong VRTTI_MODEL_URL or
// VRTTI_MODEL_NAME right after `docker run`. Not awaited: vLLM may be slow or down,
// and the sync server must start anyway.
app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(async () =>
{
    using var scope = app.Services.CreateScope();
    var model = scope.ServiceProvider.GetRequiredService<DiacriticsModel>();
    if (model.Available)
    {
        await model.Check(logAlways: true);
    }
}));

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
public partial class Program
{
    // A space name goes into URLs, settings keys and the sidebar, so it stays a plain
    // token. \z and not $: $ also matches before a trailing newline, and "work\n" would
    // pass as a name.
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,32}\z")]
    private static partial Regex SpaceNameRule();

    static bool IsSpaceName(string name) => SpaceNameRule().IsMatch(name);
}
