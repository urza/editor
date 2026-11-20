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
/// There is no device id in the body: the server takes it from the device token, so a
/// device cannot write a row in the name of another device.
/// </para>
/// </remarks>
public record PushRequest(
    long? BaseRev,
    string? Kind,
    string? Content,
    JsonElement? Meta,
    long ClientTime,
    string? Space);

public record PushResponse(long Rev, long Seq);

/// <summary>409 body. <c>Current</c> is null when the document has no rows at all.</summary>
public record ConflictResponse(Change? Current);

public record ChangesResponse(IReadOnlyList<Change> Changes, long Next, bool More);

public record PurgeResponse(int Purged);

/// <summary>One entry of <c>GET /api/spaces</c>: a space of the caller.</summary>
/// <remarks>
/// <c>Count</c> is the number of live documents. <c>LogSeq</c> is the seq of the last
/// log entry, so a device pulls the log only when it is behind.
/// </remarks>
public record SpaceInfo(string Space, long Count, long LogSeq);

public record ErrorResponse(string Error);

/// <summary>Body of <c>POST /api/devices</c> and <c>POST /api/devices/successor</c>.</summary>
/// <remarks><c>TokenHash</c> is the lowercase hex SHA-256 of the device token.</remarks>
public record RegisterRequest(string? Id, string? TokenHash);

/// <summary>Body of <c>POST /api/spaces/{name}/log</c> and <c>.../claim</c>.</summary>
/// <remarks>
/// The entry travels as a string and not as an object: the next entry's <c>prev</c> is the
/// SHA-256 of exactly these bytes, so no JSON layer may re-serialize it.
/// </remarks>
public record LogAppendRequest(string? Entry);

public record LogAppendResponse(long Seq);

/// <summary>One entry of <c>GET /api/spaces/{name}/log</c>; <c>Entry</c> is the stored text.</summary>
public record LogEntry(long Seq, string Entry);

/// <summary>Body of <c>POST /api/joins</c>, sent by the member that shows the code.</summary>
public record JoinCreateRequest(string? Slot, string? Verifier, string[]? Spaces);

/// <summary>Body of <c>POST /api/joins/redeem</c>, sent by the new device without a token.</summary>
/// <remarks>
/// <c>Entry</c> (the device entry) and <c>Proof</c> are opaque to the server; the member
/// checks the proof with the code.
/// </remarks>
public record JoinRedeemRequest(
    string? Slot,
    string? Verifier,
    string? DeviceId,
    string? TokenHash,
    string? Entry,
    string? Proof);

/// <summary>A used join that waits for its member (<c>GET /api/joins</c>).</summary>
public record PendingJoin(string Slot, string[] Spaces, string DeviceId, string Entry, string Proof);

/// <summary>The member's reply to a join; both null while the member has not answered.</summary>
public record JoinReply(string? Reply, string? Mac);

/// <summary>Body of <c>POST /api/model/diacritics</c>: one paragraph.</summary>
public record DiacriticsRequest(string? Text);

/// <summary>The paragraph as the model returned it. The client checks it again.</summary>
public record DiacriticsResponse(string Text);
