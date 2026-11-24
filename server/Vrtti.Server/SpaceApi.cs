namespace Vrtti.Server;

/// <summary>The spaces of a device and their logs (architecture.md section 27).</summary>
public static class SpaceApi
{
    /// <summary>An entry is a few hundred bytes; this bound only stops abuse.</summary>
    const int MaxEntryLength = 16384;

    public static void Map(RouteGroupBuilder api)
    {
        // Only the caller's spaces. A device must not learn the names of the others.
        api.MapGet("/spaces", (HttpContext context, Db db) =>
        {
            var conn = context.GetConnection(db);
            return Results.Ok(SpaceLog.Of(conn, context.Caller().Id));
        });

        // The upgrade: spaces from before this server have rows and no member. Only a
        // device registered with the (new) server token sees and claims them, so a dev
        // machine that joined by code cannot take "personal".
        api.MapGet("/spaces/unclaimed", (HttpContext context, Db db) =>
        {
            if (!context.Caller().ViaServerToken)
            {
                return Results.Json(new ErrorResponse("only a device registered with the server token"), statusCode: 403);
            }

            var conn = context.GetConnection(db);
            return Results.Ok(SpaceLog.Unclaimed(conn));
        });

        api.MapGet("/spaces/{name}/log", (HttpContext context, Db db, string name, long? since) =>
        {
            if (!SpaceLog.IsSpaceName(name))
            {
                return Results.BadRequest(new ErrorResponse(SpaceLog.BadSpaceName));
            }

            var conn = context.GetConnection(db);
            return SpaceLog.IsMember(conn, name, context.Caller().Id)
                ? Results.Ok(SpaceLog.Since(conn, name, since ?? 0))
                : Results.Json(new ErrorResponse($"not a member of {name}"), statusCode: 403);
        });

        api.MapPost("/spaces/{name}/log", (HttpContext context, Db db, string name, LogAppendRequest request) =>
            Append(context, db, name, request, claim: false));

        api.MapPost("/spaces/{name}/claim", (HttpContext context, Db db, string name, LogAppendRequest request) =>
            Append(context, db, name, request, claim: true));
    }

    static IResult Append(HttpContext context, Db db, string name, LogAppendRequest request, bool claim)
    {
        if (!SpaceLog.IsSpaceName(name))
        {
            return Results.BadRequest(new ErrorResponse(SpaceLog.BadSpaceName));
        }

        if (request.Entry is not { Length: > 0 and <= MaxEntryLength } entry)
        {
            return Results.BadRequest(new ErrorResponse("entry is required"));
        }

        var conn = context.GetConnection(db);
        var result = SpaceLog.Append(conn, name, entry, context.Caller(), claim);
        return result.Status == 201
            ? Results.Created($"/api/spaces/{name}/log", new LogAppendResponse(result.Seq))
            : Results.Json(new ErrorResponse(result.Error!), statusCode: result.Status);
    }
}
