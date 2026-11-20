using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Vrtti.Server;

/// <summary>Every query against the <c>revisions</c> table.</summary>
public static class Revisions
{
    const string Columns = "doc_id, rev, seq, kind, content, meta, device_id, client_time, server_time, space";

    /// <summary>The newest revision of each document of <paramref name="spaces"/> with a row after <paramref name="since"/>.</summary>
    /// <remarks>
    /// <para>
    /// A document is in the result when its newest row is in one of the spaces, or when a
    /// row moved it out of one of them (<c>prev_space</c>). The second case tells a device of
    /// the old space that the document left; without it the device never hears of the move
    /// (architecture.md section 27). The caller hides the content of a row whose space it
    /// may not read.
    /// </para>
    /// <para>
    /// Each document has a key: the seq of its newest row when that row is in the spaces,
    /// else the seq of its last row that moved it out of them. The rows are filtered and
    /// ordered by the key, and the key is the <c>Seq</c> the caller gets.
    /// </para>
    /// <para>
    /// Paging: the caller asks for one row more than the page size to learn whether more
    /// rows wait, and the next cursor is the largest key in the page. That cursor never
    /// skips a document. Keys are distinct (each is the seq of a row of its own document)
    /// and only grow, so a document left out of the page has a key above the cursor, and
    /// the next call finds it again. The newest row's seq is no key for a document that
    /// moved away: later rows in its new space would put it after a page of other rows,
    /// and the next page would then test the move against a cursor that is past it.
    /// </para>
    /// </remarks>
    public static List<Change> Changes(
        SqliteConnection conn,
        long since,
        int limit,
        IReadOnlyCollection<string> spaces)
    {
        // One parameter per name: the names are validated, but they still never go into
        // the SQL text.
        var (list, args) = InList(spaces);
        args.Add(("$since", since));
        args.Add(("$limit", limit));

        using var cmd = Db.Command(
            conn,
            $"""
             SELECT doc_id, rev, k AS seq, kind, content, meta, device_id, client_time, server_time, space
             FROM (SELECT r.*,
                          CASE WHEN r.space IN ({list}) THEN r.seq
                               ELSE (SELECT MAX(r3.seq) FROM revisions r3
                                     WHERE r3.doc_id = r.doc_id AND r3.prev_space IN ({list}))
                          END AS k
                   FROM revisions r
                   -- A key is never above the newest seq, so this narrows on the index first.
                   WHERE r.seq > $since
                     AND r.seq = (SELECT MAX(r2.seq) FROM revisions r2 WHERE r2.doc_id = r.doc_id))
             WHERE k > $since
             ORDER BY k
             LIMIT $limit
             """,
            [.. args]);

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
    /// <remarks>
    /// Only revisions of <paramref name="spaces"/>: a note that moved from a space of
    /// which the caller is not a member keeps its old revisions hidden from the caller.
    /// </remarks>
    public static List<RevisionInfo> History(SqliteConnection conn, string docId, IReadOnlyCollection<string> spaces)
    {
        var (list, args) = InList(spaces);
        args.Add(("$id", docId));
        using var cmd = Db.Command(
            conn,
            // LENGTH() on text counts characters, not bytes. The size is a display hint
            // for the history dialog, so counting characters in SQL beats loading every
            // revision's content only to measure it.
            $"""
             SELECT rev, seq, kind, device_id, client_time, server_time,
                    COALESCE(LENGTH(content), 0)
             FROM revisions WHERE doc_id = $id AND space IN ({list}) ORDER BY rev DESC
             """,
            [.. args]);

        using var reader = cmd.ExecuteReader();
        var history = new List<RevisionInfo>();
        while (reader.Read())
        {
            history.Add(new RevisionInfo(
                Rev: reader.GetInt64(0),
                Seq: reader.GetInt64(1),
                Kind: reader.GetString(2),
                DeviceId: reader.GetString(3),
                ClientTime: reader.GetInt64(4),
                ServerTime: reader.GetInt64(5),
                Size: reader.GetInt32(6)));
        }

        return history;
    }

    /// <summary>Appends one revision and returns its seq. Call inside a write transaction.</summary>
    /// <param name="prevSpace">The space of the row before, when this row moves the document.</param>
    public static long Insert(
        SqliteConnection conn,
        string docId,
        long rev,
        string kind,
        string? content,
        string? meta,
        string deviceId,
        long clientTime,
        long serverTime,
        string space,
        string? prevSpace)
    {
        using var cmd = Db.Command(
            conn,
            """
            INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time, space, prev_space)
            VALUES ($id, $rev, $kind, $content, $meta, $device, $clientTime, $serverTime, $space, $prevSpace)
            RETURNING seq
            """,
            ("$id", docId),
            ("$rev", rev),
            ("$kind", kind),
            ("$content", content),
            ("$meta", meta),
            ("$device", deviceId),
            ("$clientTime", clientTime),
            ("$serverTime", serverTime),
            ("$space", space),
            ("$prevSpace", prevSpace));
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

    /// <summary>The row as a device of the old space sees a document that moved away.</summary>
    /// <remarks>
    /// The device learns that the note left and where to, but not its text and not its
    /// sealed meta: those are for the members of the new space.
    /// </remarks>
    public static Change WithoutSecrets(Change change)
    {
        JsonElement? meta = null;
        if (change.Meta is { ValueKind: JsonValueKind.Object } value
            && JsonNode.Parse(value.GetRawText()) is JsonObject node)
        {
            node.Remove("sealed");
            meta = JsonSerializer.SerializeToElement(node);
        }

        return change with { Content = null, Meta = meta };
    }

    /// <summary>"$s0, $s1, ..." for an IN clause, with one parameter for each name.</summary>
    static (string List, List<(string, object?)> Args) InList(IReadOnlyCollection<string> names) =>
        (string.Join(", ", names.Select((_, i) => $"$s{i}")),
         [.. names.Select((name, i) => ($"$s{i}", (object?)name))]);

    static Change ReadChange(SqliteDataReader reader) => new(
        DocId: reader.GetString(0),
        Rev: reader.GetInt64(1),
        Seq: reader.GetInt64(2),
        Kind: reader.GetString(3),
        Content: reader.IsDBNull(4) ? null : reader.GetString(4),
        Meta: reader.IsDBNull(5) ? null : ParseMeta(reader.GetString(5)),
        DeviceId: reader.GetString(6),
        ClientTime: reader.GetInt64(7),
        ServerTime: reader.GetInt64(8),
        Space: reader.GetString(9));

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
