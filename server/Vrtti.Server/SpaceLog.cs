using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Vrtti.Server;

/// <summary>The space logs and the member table (architecture.md section 27).</summary>
/// <remarks>
/// The clients decide who is a member: each one replays the signed log and checks every
/// signature. The server cannot check signatures (.NET has no built-in Ed25519) and does
/// not try. It keeps its own member table from the same log, with the same rules, and
/// uses it only to decide what a device may download and write.
/// </remarks>
public static partial class SpaceLog
{
    /// <summary>The space of the keyring record. Each registered device reads and writes it.</summary>
    public const string Keyring = "keyring";

    /// <summary>
    /// The one document of the keyring space. Same name as the space, as in the client
    /// (KEYRING_ID in app/js/model/docs.js).
    /// </summary>
    public const string KeyringDoc = "keyring";

    public const string BadSpaceName = "space must be 1-32 letters, digits, - or _";

    // A space name goes into URLs, settings keys and the sidebar, so it stays a plain
    // token. \z and not $: $ also matches before a trailing newline, and "work\n" would
    // pass as a name.
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,32}\z")]
    private static partial Regex SpaceNameRule();

    public static bool IsSpaceName(string name) => SpaceNameRule().IsMatch(name);

    /// <summary>The outcome of an append: an HTTP status, an error text, the new seq.</summary>
    public sealed record Result(int Status, string? Error = null, long Seq = 0);

    /// <summary>The fields of an entry that the server reads. The rest is the client's.</summary>
    sealed record Parsed(long Seq, string? Prev, string Op, string Space, string Device, string By);

    public static bool IsMember(SqliteConnection conn, string space, string deviceId)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT 1 FROM members WHERE space = $space AND device_id = $device",
            ("$space", space),
            ("$device", deviceId));
        return cmd.ExecuteScalar() is not null;
    }

    /// <summary>The spaces a device may read: its memberships and the keyring.</summary>
    public static HashSet<string> Readable(SqliteConnection conn, string deviceId)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT space FROM members WHERE device_id = $device",
            ("$device", deviceId));
        using var reader = cmd.ExecuteReader();
        var set = new HashSet<string>(StringComparer.Ordinal) { Keyring };
        while (reader.Read())
        {
            set.Add(reader.GetString(0));
        }

        return set;
    }

    /// <summary>The caller's spaces, with live documents and the log head, ordered by name.</summary>
    /// <remarks>
    /// A document counts in the space of its newest row, and only when that row is
    /// <c>text</c>. A space with no documents still shows, because a new space starts
    /// empty and the device must see it.
    /// </remarks>
    public static List<SpaceInfo> Of(SqliteConnection conn, string deviceId)
    {
        using var cmd = Db.Command(
            conn,
            """
            SELECT m.space,
                   (SELECT COUNT(*) FROM revisions r
                    WHERE r.space = m.space AND r.kind = 'text'
                      AND r.seq = (SELECT MAX(r2.seq) FROM revisions r2 WHERE r2.doc_id = r.doc_id)),
                   (SELECT MAX(l.seq) FROM space_log l WHERE l.space = m.space)
            FROM members m
            WHERE m.device_id = $device
            ORDER BY m.space
            """,
            ("$device", deviceId));
        using var reader = cmd.ExecuteReader();
        var list = new List<SpaceInfo>();
        while (reader.Read())
        {
            list.Add(new SpaceInfo(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2)));
        }

        return list;
    }

    /// <summary>The spaces from before the upgrade: rows, but no log and so no member.</summary>
    public static List<string> Unclaimed(SqliteConnection conn)
    {
        using var cmd = Db.Command(
            conn,
            """
            SELECT DISTINCT r.space FROM revisions r
            WHERE r.space <> $keyring
              AND NOT EXISTS (SELECT 1 FROM space_log l WHERE l.space = r.space)
            ORDER BY r.space
            """,
            ("$keyring", Keyring));
        using var reader = cmd.ExecuteReader();
        var list = new List<string>();
        while (reader.Read())
        {
            list.Add(reader.GetString(0));
        }

        return list;
    }

    public static List<LogEntry> Since(SqliteConnection conn, string space, long since)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT seq, entry FROM space_log WHERE space = $space AND seq > $since ORDER BY seq",
            ("$space", space),
            ("$since", since));
        using var reader = cmd.ExecuteReader();
        var list = new List<LogEntry>();
        while (reader.Read())
        {
            list.Add(new LogEntry(reader.GetInt64(0), reader.GetString(1)));
        }

        return list;
    }

    /// <summary>
    /// Appends one entry and changes the member table to match, in one transaction.
    /// </summary>
    /// <param name="claim">
    /// True for <c>POST /api/spaces/{name}/claim</c>: a <c>create</c> of a space that has
    /// rows from before the upgrade. A normal <c>create</c> needs a space with no rows, so
    /// a device that joined later cannot take an old space before the user claims it.
    /// </param>
    public static Result Append(SqliteConnection conn, string space, string entryText, Caller caller, bool claim)
    {
        if (Parse(entryText) is not { } entry)
        {
            return new Result(400, "the entry needs seq, prev, op, space, device, by and sig");
        }

        if (entry.Space != space)
        {
            return new Result(400, "the entry names another space");
        }

        // The server cannot check the signature, but it can refuse an entry that claims
        // another author. A device id is the second line of an entry key.
        if (DeviceIdOf(entry.By) != caller.Id || DeviceIdOf(entry.Device) is not { } deviceId)
        {
            return new Result(400, "by must be the caller's device entry");
        }

        if (entry.Op == "create" && space == Keyring)
        {
            return new Result(400, "keyring is a reserved space");
        }

        if (claim && (entry.Op != "create" || !caller.ViaServerToken))
        {
            return new Result(403, "only a device registered with the server token claims a space");
        }

        // BEGIN IMMEDIATE, so two appends cannot both read the same head and both write
        // the next seq; the second one waits and then sees a wrong seq (409).
        using var transaction = conn.BeginTransaction(deferred: false);
        var (lastSeq, lastEntry) = Head(conn, space);

        if (entry.Op == "create")
        {
            if (lastSeq > 0 || HasRows(conn, space) != claim)
            {
                return new Result(409, claim ? "the space has no old rows or has an owner" : "the space name is taken");
            }

            if (entry.Seq != 1 || entry.Prev is not null || deviceId != caller.Id)
            {
                return new Result(400, "a create is seq 1, has no prev, and adds its author");
            }
        }
        else
        {
            if (lastSeq == 0)
            {
                return new Result(404, "unknown space");
            }

            if (!IsMember(conn, space, caller.Id))
            {
                return new Result(403, "not a member of this space");
            }

            if (entry.Seq != lastSeq + 1 || entry.Prev != Hash(lastEntry!))
            {
                return new Result(409, "seq or prev does not follow the last entry");
            }
        }

        switch (entry.Op)
        {
            case "create":
                SetMember(conn, space, deviceId, add: true);
                break;
            case "add":
                if (!Devices.Exists(conn, deviceId))
                {
                    return new Result(400, "unknown device");
                }

                if (IsMember(conn, space, deviceId))
                {
                    return new Result(400, "already a member");
                }

                SetMember(conn, space, deviceId, add: true);
                break;
            case "remove":
                if (!IsMember(conn, space, deviceId))
                {
                    return new Result(400, "not a member");
                }

                // With one member left, that member is the caller: the last member cannot
                // remove itself, or the space would have no one who can read it.
                if (MemberCount(conn, space) == 1)
                {
                    return new Result(409, "the last member cannot remove itself");
                }

                SetMember(conn, space, deviceId, add: false);
                break;
            case "color":
                break;
            default:
                return new Result(400, "op must be create, add, remove or color");
        }

        using (var insert = Db.Command(
            conn,
            "INSERT INTO space_log (space, seq, entry) VALUES ($space, $seq, $entry)",
            ("$space", space),
            ("$seq", entry.Seq),
            ("$entry", entryText)))
        {
            insert.ExecuteNonQuery();
        }

        transaction.Commit();
        return new Result(201, Seq: entry.Seq);
    }

    /// <summary>The device id inside an entry key, or null for a malformed key.</summary>
    /// <remarks>
    /// An entry key is the device entry as lines: "vrtti-device", id, name, recipient,
    /// sign key, added time (app/js/crypto/keyring.js, entryKey).
    /// </remarks>
    public static string? DeviceIdOf(string entryKey)
    {
        var lines = entryKey.Split('\n');
        return lines.Length >= 2 && lines[0] == "vrtti-device" && lines[1].Length > 0 ? lines[1] : null;
    }

    /// <summary>The prev of the next entry: the lowercase hex SHA-256 of the stored text.</summary>
    public static string Hash(string entryText) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(entryText)));

    static Parsed? Parse(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("seq", out var seq) || seq.ValueKind != JsonValueKind.Number
                || !root.TryGetProperty("prev", out var prev) || prev.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)
                || !root.TryGetProperty("sig", out var sig) || sig.ValueKind != JsonValueKind.String
                || Text(root, "op") is not { } op
                || Text(root, "space") is not { } space
                || Text(root, "device") is not { } device
                || Text(root, "by") is not { } by
                || !seq.TryGetInt64(out var seqValue))
            {
                return null;
            }

            return new Parsed(seqValue, prev.ValueKind == JsonValueKind.Null ? null : prev.GetString(), op, space, device, by);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    static (long Seq, string? Entry) Head(SqliteConnection conn, string space)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT seq, entry FROM space_log WHERE space = $space ORDER BY seq DESC LIMIT 1",
            ("$space", space));
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? (reader.GetInt64(0), reader.GetString(1)) : (0, null);
    }

    static bool HasRows(SqliteConnection conn, string space)
    {
        using var cmd = Db.Command(conn, "SELECT 1 FROM revisions WHERE space = $space LIMIT 1", ("$space", space));
        return cmd.ExecuteScalar() is not null;
    }

    static long MemberCount(SqliteConnection conn, string space)
    {
        using var cmd = Db.Command(conn, "SELECT COUNT(*) FROM members WHERE space = $space", ("$space", space));
        return (long)cmd.ExecuteScalar()!;
    }

    static void SetMember(SqliteConnection conn, string space, string deviceId, bool add)
    {
        using var cmd = Db.Command(
            conn,
            add
                ? "INSERT INTO members (space, device_id) VALUES ($space, $device)"
                : "DELETE FROM members WHERE space = $space AND device_id = $device",
            ("$space", space),
            ("$device", deviceId));
        cmd.ExecuteNonQuery();
    }
}
