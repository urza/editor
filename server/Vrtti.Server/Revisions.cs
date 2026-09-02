using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Vrtti.Server;

/// <summary>Every query against the <c>revisions</c> table.</summary>
public static class Revisions
{
    const string Columns = "doc_id, rev, seq, kind, content, meta, device_id, client_time, server_time";

    /// <summary>The newest revision of each document with a row after <paramref name="since"/>.</summary>
    /// <remarks>
    /// Paging: the caller asks for one row more than the page size to learn whether more
    /// rows wait, and the next cursor is the largest seq in the page.
    /// <para>
    /// That cursor never skips a document. The rows are ordered by seq and every returned
    /// row is a document's newest row, so a document left out of the page has its newest
    /// row at a seq above every seq in the page, therefore above the cursor. The next call
    /// with <c>since = next</c> finds it again. A document inside the page cannot come back
    /// unless it gets a new row, and that row has a seq above the cursor as well.
    /// </para>
    /// </remarks>
    public static List<Change> Changes(SqliteConnection conn, long since, int limit)
    {
        using var cmd = Db.Command(
            conn,
            $"""
             SELECT {Columns}
             FROM revisions r
             WHERE r.seq > $since
               AND r.seq = (SELECT MAX(r2.seq) FROM revisions r2
                            WHERE r2.doc_id = r.doc_id AND r2.seq > $since)
             ORDER BY r.seq
             LIMIT $limit
             """,
            ("$since", since),
            ("$limit", limit));

        using var reader = cmd.ExecuteReader();
        var changes = new List<Change>();
        while (reader.Read())
        {
            changes.Add(ReadChange(reader));
        }

        return changes;
    }

    /// <summary>The current revision number, or 0 when the document has no rows.</summary>
    public static long CurrentRev(SqliteConnection conn, string docId)
    {
        using var cmd = Db.Command(
            conn,
            "SELECT COALESCE(MAX(rev), 0) FROM revisions WHERE doc_id = $id",
            ("$id", docId));
        return (long)(cmd.ExecuteScalar() ?? 0L);
    }

    /// <summary>The newest revision of one document, or null when it has no rows.</summary>
    public static Change? Current(SqliteConnection conn, string docId)
    {
        using var cmd = Db.Command(
            conn,
            $"SELECT {Columns} FROM revisions WHERE doc_id = $id ORDER BY rev DESC LIMIT 1",
            ("$id", docId));
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? ReadChange(reader) : null;
    }

    /// <summary>One revision by number, or null when it is unknown or purged.</summary>
    public static Change? One(SqliteConnection conn, string docId, long rev)
    {
        using var cmd = Db.Command(
            conn,
            $"SELECT {Columns} FROM revisions WHERE doc_id = $id AND rev = $rev",
            ("$id", docId),
            ("$rev", rev));
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? ReadChange(reader) : null;
    }

    /// <summary>History of one document, newest first, without the content.</summary>
    public static List<RevisionInfo> History(SqliteConnection conn, string docId)
    {
        using var cmd = Db.Command(
            conn,
            // LENGTH() on text counts characters, not bytes. The size is a display hint
            // for the history dialog, so counting characters in SQL beats loading every
            // revision's content only to measure it.
            """
            SELECT rev, seq, kind, device_id, client_time, server_time,
                   COALESCE(LENGTH(content), 0)
            FROM revisions WHERE doc_id = $id ORDER BY rev DESC
            """,
            ("$id", docId));

        using var reader = cmd.ExecuteReader();
        var list = new List<RevisionInfo>();
        while (reader.Read())
        {
            list.Add(new RevisionInfo(
                Rev: reader.GetInt64(0),
                Seq: reader.GetInt64(1),
                Kind: reader.GetString(2),
                DeviceId: reader.GetString(3),
                ClientTime: reader.GetInt64(4),
                ServerTime: reader.GetInt64(5),
                Size: reader.GetInt32(6)));
        }

        return list;
    }

    /// <summary>Appends one revision and returns its seq. Call inside a write transaction.</summary>
    public static long Insert(
        SqliteConnection conn,
        string docId,
        long rev,
        string kind,
        string? content,
        string? meta,
        string deviceId,
        long clientTime,
        long serverTime)
    {
        using var cmd = Db.Command(
            conn,
            """
            INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time)
            VALUES ($id, $rev, $kind, $content, $meta, $device, $clientTime, $serverTime)
            RETURNING seq
            """,
            ("$id", docId),
            ("$rev", rev),
            ("$kind", kind),
            ("$content", content),
            ("$meta", meta),
            ("$device", deviceId),
            ("$clientTime", clientTime),
            ("$serverTime", serverTime));
        return (long)cmd.ExecuteScalar()!;
    }

    /// <summary>Deletes revisions below <paramref name="below"/>, keeping the newest row.</summary>
    /// <remarks>
    /// Purge exists for the plaintext-to-encrypted conversion (architecture.md section 5):
    /// the old revisions still hold the readable text, so encrypting the current revision
    /// alone changes nothing on an untrusted server. The client purges after the first
    /// encrypted push.
    /// <para>
    /// The newest row survives even when <c>below</c> is above the current revision. It
    /// carries the document's largest seq, and pull cursors point past it; deleting it
    /// would make an already-synced document look new to nobody and lose the document for
    /// every device that pulls later.
    /// </para>
    /// </remarks>
    public static int Purge(SqliteConnection conn, string docId, long below)
    {
        var newest = CurrentRev(conn, docId);
        using var cmd = Db.Command(
            conn,
            "DELETE FROM revisions WHERE doc_id = $id AND rev < $below AND rev < $newest",
            ("$id", docId),
            ("$below", below),
            ("$newest", newest));
        return cmd.ExecuteNonQuery();
    }

    static Change ReadChange(SqliteDataReader reader) => new(
        DocId: reader.GetString(0),
        Rev: reader.GetInt64(1),
        Seq: reader.GetInt64(2),
        Kind: reader.GetString(3),
        Content: reader.IsDBNull(4) ? null : reader.GetString(4),
        Meta: reader.IsDBNull(5) ? null : ParseMeta(reader.GetString(5)),
        DeviceId: reader.GetString(6),
        ClientTime: reader.GetInt64(7),
        ServerTime: reader.GetInt64(8));

    /// <summary>Turns the stored meta text back into a JSON value.</summary>
    /// <remarks>
    /// Clone() detaches the element from the JsonDocument, so the document can be disposed
    /// here while the element travels on to the response writer.
    /// </remarks>
    static JsonElement ParseMeta(string text)
    {
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }
}
