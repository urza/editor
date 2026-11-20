using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Vrtti.Server;

/// <summary>The authenticated device of a request.</summary>
/// <remarks>
/// <c>ViaServerToken</c> is true for a device that registered with the server token.
/// Only such a device may list and claim the spaces from before the upgrade.
/// </remarks>
public sealed record Caller(string Id, bool ViaServerToken);

/// <summary>Every query against the <c>devices</c> and <c>joins</c> tables.</summary>
public static class Devices
{
    /// <summary>The lowercase hex SHA-256 of a device token.</summary>
    /// <remarks>
    /// The lookup by hash is a plain SQL equality and not a constant-time compare. That is
    /// fine: a timing leak tells an attacker bytes of the hash, and a hash of 32 random
    /// bytes gives no way back to the token.
    /// </remarks>
    public static string HashToken(string token) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public static bool IsTokenHash(string? value) =>
        value is { Length: 64 } && value.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    public static Caller? ByTokenHash(SqliteConnection conn, string hash)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT id, via_server_token FROM devices WHERE token_hash = $hash",
            ("$hash", hash));
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? new Caller(reader.GetString(0), reader.GetInt64(1) != 0) : null;
    }

    public static bool Exists(SqliteConnection conn, string id)
    {
        using var cmd = Db.Command(conn, "SELECT 1 FROM devices WHERE id = $id", ("$id", id));
        return cmd.ExecuteScalar() is not null;
    }

    /// <summary>Registers a device. False when the id or the token hash is taken.</summary>
    public static bool Register(
        SqliteConnection conn,
        string id,
        string tokenHash,
        bool viaServerToken,
        string? predecessor,
        long now)
    {
        using var cmd = Db.Command(
            conn,
            """
            INSERT OR IGNORE INTO devices (id, token_hash, via_server_token, predecessor, created)
            VALUES ($id, $hash, $via, $pred, $now)
            """,
            ("$id", id),
            ("$hash", tokenHash),
            ("$via", viaServerToken ? 1 : 0),
            ("$pred", predecessor),
            ("$now", now));
        // OR IGNORE turns all three UNIQUE rules (id, token hash, one successor for each
        // predecessor) into "no row", which the caller reports as 409.
        return cmd.ExecuteNonQuery() == 1;
    }

    /// <summary>
    /// Writes a new join on a free slot. False when the slot still serves another join.
    /// </summary>
    /// <remarks>
    /// A slot is free again when its join expired unused, or when the member answered it
    /// and its time is over. A used join that waits for its member stays, also after the
    /// ten minutes, so a slow member can still complete it.
    /// </remarks>
    public static bool CreateJoin(
        SqliteConnection conn,
        string slot,
        string verifier,
        string[] spaces,
        string byDevice,
        long expires,
        long now)
    {
        using var free = Db.Command(
            conn,
            """
            DELETE FROM joins
            WHERE slot = $slot AND expires < $now AND (device_id IS NULL OR reply IS NOT NULL)
            """,
            ("$slot", slot),
            ("$now", now));
        free.ExecuteNonQuery();

        using var cmd = Db.Command(
            conn,
            """
            INSERT OR IGNORE INTO joins (slot, verifier, spaces, by_device, expires)
            VALUES ($slot, $verifier, $spaces, $by, $expires)
            """,
            ("$slot", slot),
            ("$verifier", verifier),
            ("$spaces", JsonSerializer.Serialize(spaces)),
            ("$by", byDevice),
            ("$expires", expires));
        return cmd.ExecuteNonQuery() == 1;
    }

    /// <summary>The state of a join that a new device tries to redeem.</summary>
    public sealed record OpenJoin(string Verifier, long Expires, long Tries, bool Used);

    public static OpenJoin? FindJoin(SqliteConnection conn, string slot)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT verifier, expires, tries, device_id IS NOT NULL FROM joins WHERE slot = $slot",
            ("$slot", slot));
        using var reader = cmd.ExecuteReader();
        return reader.Read()
            ? new OpenJoin(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2), reader.GetInt64(3) != 0)
            : null;
    }

    public static void CountWrongTry(SqliteConnection conn, string slot)
    {
        using var cmd = Db.Command(conn, "UPDATE joins SET tries = tries + 1 WHERE slot = $slot", ("$slot", slot));
        cmd.ExecuteNonQuery();
    }

    public static void MarkUsed(SqliteConnection conn, string slot, string deviceId, string entry, string proof)
    {
        using var cmd = Db.Command(
            conn,
            "UPDATE joins SET device_id = $device, entry = $entry, proof = $proof WHERE slot = $slot",
            ("$slot", slot),
            ("$device", deviceId),
            ("$entry", entry),
            ("$proof", proof));
        cmd.ExecuteNonQuery();
    }

    /// <summary>The used joins of one member that it has not answered yet.</summary>
    public static List<PendingJoin> Pending(SqliteConnection conn, string byDevice)
    {
        using var cmd = Db.Command(
            conn,
            """
            SELECT slot, spaces, device_id, entry, proof FROM joins
            WHERE by_device = $by AND device_id IS NOT NULL AND reply IS NULL
            ORDER BY slot
            """,
            ("$by", byDevice));
        using var reader = cmd.ExecuteReader();
        var list = new List<PendingJoin>();
        while (reader.Read())
        {
            list.Add(new PendingJoin(
                reader.GetString(0),
                JsonSerializer.Deserialize<string[]>(reader.GetString(1)) ?? [],
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4)));
        }

        return list;
    }

    /// <summary>Stores the reply of the member. False when the join is not its pending one.</summary>
    public static bool Answer(SqliteConnection conn, string slot, string byDevice, string reply, string mac)
    {
        using var cmd = Db.Command(
            conn,
            """
            UPDATE joins SET reply = $reply, mac = $mac
            WHERE slot = $slot AND by_device = $by AND device_id IS NOT NULL AND reply IS NULL
            """,
            ("$slot", slot),
            ("$by", byDevice),
            ("$reply", reply),
            ("$mac", mac));
        return cmd.ExecuteNonQuery() == 1;
    }

    /// <summary>The reply for the device that joined, or null when the slot is not its join.</summary>
    public static JoinReply? ReplyFor(SqliteConnection conn, string slot, string deviceId)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT reply, mac FROM joins WHERE slot = $slot AND device_id = $device",
            ("$slot", slot),
            ("$device", deviceId));
        using var reader = cmd.ExecuteReader();
        return reader.Read()
            ? new JoinReply(reader.IsDBNull(0) ? null : reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1))
            : null;
    }
}
