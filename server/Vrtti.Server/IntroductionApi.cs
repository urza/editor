namespace Vrtti.Server;

/// <summary>The device directory (architecture.md section 27): signed introductions.</summary>
/// <remarks>
/// An introduction gives no space. It only lets a device show another device in its grid
/// and trust a space log add that device signed. The space logs still decide who reads a
/// space, so this table is separate from <c>members</c> and <c>space_log</c>.
/// </remarks>
public static class IntroductionApi
{
    /// <summary>An entry key is a few hundred characters; this bound only stops abuse.</summary>
    const int MaxKeyLength = 4096;

    const int MaxSigLength = 256;

    public static void Map(RouteGroupBuilder api)
    {
        // Every registered device reads every entry: a device needs the entries of
        // devices it shares no space with, or it cannot follow a chain to them.
        api.MapGet("/introductions", (HttpContext context, Db db) =>
        {
            var conn = context.GetConnection(db);
            using var cmd = Db.Command(conn, "SELECT device, by, replaces, sig FROM introductions ORDER BY created, rowid");
            using var reader = cmd.ExecuteReader();
            var all = new List<Introduction>();
            while (reader.Read())
            {
                all.Add(new Introduction(reader.GetString(0), reader.GetString(1), reader.GetInt64(2) != 0, reader.GetString(3)));
            }

            return Results.Ok(all);
        });

        api.MapPost("/introductions", (HttpContext context, Db db, TimeProvider clock, IntroductionRequest request) =>
        {
            if (request.Device is not { Length: > 0 and <= MaxKeyLength } device
                || request.By is not { Length: > 0 and <= MaxKeyLength } by
                || request.Sig is not { Length: > 0 and <= MaxSigLength } sig)
            {
                return Results.BadRequest(new ErrorResponse("device, by and sig are required"));
            }

            // A device writes only in its own name. The signature would refuse a forged
            // entry on the clients anyway; this keeps the table free of them.
            if (SpaceLog.DeviceIdOf(by) != context.Caller().Id)
            {
                return Results.Json(new ErrorResponse("by must be the calling device"), statusCode: 403);
            }

            var conn = context.GetConnection(db);
            if (SpaceLog.DeviceIdOf(device) is not { } deviceId || !Devices.Exists(conn, deviceId))
            {
                return Results.BadRequest(new ErrorResponse("device is not a registered device"));
            }

            // The clients refuse an entry where a device vouches for itself
            // (checkIntroduction); the table keeps none either.
            if (deviceId == context.Caller().Id)
            {
                return Results.BadRequest(new ErrorResponse("a device cannot introduce itself"));
            }

            // The first entry for a pair stays: an entry never changes (only grows).
            using var cmd = Db.Command(conn, """
                INSERT OR IGNORE INTO introductions (device, by, replaces, sig, created)
                VALUES ($device, $by, $replaces, $sig, $created)
                """,
                ("$device", device), ("$by", by), ("$replaces", request.Replaces == true ? 1 : 0),
                ("$sig", sig), ("$created", clock.GetUtcNow().ToUnixTimeMilliseconds()));
            return cmd.ExecuteNonQuery() == 1 ? Results.Created("/api/introductions", null) : Results.Ok();
        });
    }
}
