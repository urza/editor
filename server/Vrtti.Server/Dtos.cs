using System.Text.Json;

namespace Vrtti.Server;

/// <summary>One revision row, as the API returns it (architecture.md section 7).</summary>
/// <remarks>
/// <c>Meta</c> is a <see cref="JsonElement"/> and never a typed shape: the server is
/// content-agnostic. The client owns the meta fields and may add new ones at any time,
/// so the server stores the raw JSON text and hands it back unchanged.
/// <para>
/// <c>Space</c> is the bucket of this row (architecture.md section 25). The newest row's
/// space is the document's space, so a move is one more row and the table stays
/// append-only.
/// </para>
/// </remarks>
public record Change(
    string DocId,
    long Rev,
    long Seq,
    string Kind,
    string? Content,
    JsonElement? Meta,
    string DeviceId,
    long ClientTime,
    long ServerTime,
    string Space);

/// <summary>One history entry: everything but the content.</summary>
public record RevisionInfo(
    long Rev,
    long Seq,
    string Kind,
    string DeviceId,
    long ClientTime,
    long ServerTime,
    int Size);

/// <summary>Body of <c>POST /api/docs/{id}/revisions</c>.</summary>
/// <remarks>
/// <c>BaseRev</c> null means "attach without a claim": the push always appends.
/// A number is a claim about the current revision, and a mismatch is a 409.
/// <para>
/// <c>Space</c> null means <c>personal</c>, so a client from before spaces keeps working
/// and its notes land where the migration put the old ones.
/// </para>
/// </remarks>
public record PushRequest(
    long? BaseRev,
    string? Kind,
    string? Content,
    JsonElement? Meta,
    string? DeviceId,
    long ClientTime,
    string? Space = null);

public record PushResponse(long Rev, long Seq);

/// <summary>409 body. <c>Current</c> is null when the document has no rows at all.</summary>
public record ConflictResponse(Change? Current);

public record ChangesResponse(IReadOnlyList<Change> Changes, long Next, bool More);

public record PurgeResponse(int Purged);

/// <summary>One entry of <c>GET /api/spaces</c>: a space and its live documents.</summary>
public record SpaceInfo(string Space, long Count);

public record ErrorResponse(string Error);
