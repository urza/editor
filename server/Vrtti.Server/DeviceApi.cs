using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Vrtti.Server;

/// <summary>What the token middleware in Program.cs leaves for the endpoints.</summary>
public static class Auth
{
    /// <summary>Set when the request carries the server token; only POST /api/devices reads it.</summary>
    public const string ServerTokenKey = "vrtti.serverToken";

    /// <summary>The device of the request. Each endpoint behind the middleware has one.</summary>
    public static Caller Caller(this HttpContext context) =>
        context.Items[typeof(Caller)] as Caller
        ?? throw new InvalidOperationException("no device on this request");
}

/// <summary>Registration, successors and joins (architecture.md section 27).</summary>
public static partial class DeviceApi
{
    /// <summary>A join code lives this long.</summary>
    static readonly TimeSpan JoinLifetime = TimeSpan.FromMinutes(10);

    /// <summary>After this many wrong verifiers the join is dead.</summary>
    const int MaxWrongTries = 5;

    // Three characters of Crockford base32: the public part of a join code.
    [GeneratedRegex(@"^[0-9A-HJKMNP-TV-Z]{3}\z")]
    private static partial Regex SlotRule();

    public static void Map(RouteGroupBuilder api)
    {
        // The server token registers a device that is a member of no space. With it the
        // first device starts, and it makes or claims spaces from there.
        api.MapPost("/devices", (HttpContext context, Db db, TimeProvider clock, RegisterRequest request) =>
        {
            if (!context.Items.ContainsKey(Auth.ServerTokenKey))
            {
                // A device token must not register devices: then one token would make any
                // number of them. A device makes its successor through /devices/successor.
                return Results.Json(new ErrorResponse("only the server token registers a device"), statusCode: 403);
            }

            return Register(db, clock, request, viaServerToken: true, predecessor: null);
        });

        // A change of the passphrase switch makes a new key pair and so a new device. The
        // old device token vouches for it, once.
        api.MapPost("/devices/successor", (HttpContext context, Db db, TimeProvider clock, RegisterRequest request) =>
            Register(db, clock, request, viaServerToken: false, predecessor: context.Caller().Id));

        api.MapPost("/joins", (HttpContext context, Db db, TimeProvider clock, JoinCreateRequest request) =>
        {
            var caller = context.Caller();
            if (request.Slot is not { } slot || !SlotRule().IsMatch(slot)
                || request.Verifier is not { Length: > 0 and <= 256 } verifier
                // An empty list is a join to the server only: the member adds the
                // device to spaces later with plain add entries.
                || request.Spaces is not { } spaces)
            {
                return Results.BadRequest(new ErrorResponse("slot, verifier and spaces are required"));
            }

            using var conn = db.Open();
            using var transaction = conn.BeginTransaction(deferred: false);
            // A member gives away only spaces it is in; the server enforces it here, and
            // the add entries later need the membership anyway.
            if (spaces.FirstOrDefault(s => !SpaceLog.IsSpaceName(s) || !SpaceLog.IsMember(conn, s, caller.Id)) is { } foreign)
            {
                return Results.Json(new ErrorResponse($"not a member of {foreign}"), statusCode: 403);
            }

            var now = clock.GetUtcNow();
            if (!Devices.CreateJoin(conn, slot, verifier, spaces, caller.Id,
                    (now + JoinLifetime).ToUnixTimeMilliseconds(), now.ToUnixTimeMilliseconds()))
            {
                // The member draws a new code; 32768 slots make a second clash rare.
                return Results.Conflict(new ErrorResponse("the slot is in use"));
            }

            transaction.Commit();
            return Results.Created($"/api/joins/{slot}", null);
        });

        // No token: the middleware lets this one request through. The verifier proves the
        // code, and five wrong ones end the join.
        api.MapPost("/joins/redeem", (Db db, TimeProvider clock, JoinRedeemRequest request) =>
        {
            if (request.Slot is not { } slot || !SlotRule().IsMatch(slot)
                || request.Verifier is not { Length: > 0 and <= 256 } verifier
                || request.DeviceId is not { Length: > 0 and <= 64 } deviceId
                || !Devices.IsTokenHash(request.TokenHash)
                || request.Entry is not { Length: > 0 and <= 4096 } entry
                || request.Proof is not { Length: > 0 and <= 256 } proof)
            {
                return Results.BadRequest(new ErrorResponse("slot, verifier, deviceId, tokenHash, entry and proof are required"));
            }

            using var conn = db.Open();
            using var transaction = conn.BeginTransaction(deferred: false);
            var join = Devices.FindJoin(conn, slot);
            if (join is null || join.Used || join.Tries >= MaxWrongTries
                || clock.GetUtcNow().ToUnixTimeMilliseconds() > join.Expires)
            {
                return Results.NotFound(new ErrorResponse("unknown or expired join"));
            }

            // Constant-time, for the reason of the token compare in Program.cs.
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(verifier), Encoding.UTF8.GetBytes(join.Verifier)))
            {
                Devices.CountWrongTry(conn, slot);
                transaction.Commit();
                return Results.Json(new ErrorResponse("wrong code"), statusCode: 403);
            }

            var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
            if (!Devices.Register(conn, deviceId, request.TokenHash!, viaServerToken: false, predecessor: null, now))
            {
                // Rolled back: the join stays open for a retry with a fresh id.
                return Results.Conflict(new ErrorResponse("the device id or token is taken"));
            }

            Devices.MarkUsed(conn, slot, deviceId, entry, proof);
            transaction.Commit();
            return Results.Created("/api/devices", null);
        });

        // The member's next sync finds the device that used its code.
        api.MapGet("/joins", (HttpContext context, Db db) =>
        {
            using var conn = db.Open();
            return Results.Ok(Devices.Pending(conn, context.Caller().Id));
        });

        api.MapPost("/joins/{slot}/reply", (HttpContext context, Db db, string slot, JoinReply request) =>
        {
            if (request.Reply is not { Length: > 0 and <= 65536 } reply || request.Mac is not { Length: > 0 and <= 256 } mac)
            {
                return Results.BadRequest(new ErrorResponse("reply and mac are required"));
            }

            using var conn = db.Open();
            return Devices.Answer(conn, slot, context.Caller().Id, reply, mac)
                ? Results.NoContent()
                : Results.NotFound(new ErrorResponse("no pending join of yours on this slot"));
        });

        // The new device polls here and shows "Waiting for <member>…" while both are null.
        api.MapGet("/joins/{slot}/reply", (HttpContext context, Db db, string slot) =>
        {
            using var conn = db.Open();
            return Devices.ReplyFor(conn, slot, context.Caller().Id) is { } reply
                ? Results.Ok(reply)
                : Results.NotFound(new ErrorResponse("no join of this device on this slot"));
        });
    }

    static IResult Register(Db db, TimeProvider clock, RegisterRequest request, bool viaServerToken, string? predecessor)
    {
        if (request.Id is not { Length: > 0 and <= 64 } id || !Devices.IsTokenHash(request.TokenHash))
        {
            return Results.BadRequest(new ErrorResponse("id and tokenHash (64 lowercase hex) are required"));
        }

        using var conn = db.Open();
        return Devices.Register(conn, id, request.TokenHash!, viaServerToken, predecessor, clock.GetUtcNow().ToUnixTimeMilliseconds())
            ? Results.Created("/api/devices", null)
            : Results.Conflict(new ErrorResponse(predecessor is null
                ? "the device id or token is taken"
                : "the device id or token is taken, or this device has a successor"));
    }
}
