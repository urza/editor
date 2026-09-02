using System.Text.Json;

namespace Vrtti.Server;

/// <summary>One revision row, as the API returns it (architecture.md section 7).</summary>
/// <remarks>
/// <c>Meta</c> is a <see cref="JsonElement"/> and never a typed shape: the server is
/// content-agnostic. The client owns the meta fields and may add new ones at any time,
/// so the server stores the raw JSON text and hands it back unchanged.
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
    long ServerTime);

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
/// </remarks>
public record PushRequest(
    long? BaseRev,
    string? Kind,
    string? Content,
    JsonElement? Meta,
    string? DeviceId,
    long ClientTime);

public record PushResponse(long Rev, long Seq);

/// <summary>409 body. <c>Current</c> is null when the document has no rows at all.</summary>
public record ConflictResponse(Change? Current);

public record ChangesResponse(IReadOnlyList<Change> Changes, long Next, bool More);

public record PurgeResponse(int Purged);

public record ErrorResponse(string Error);
