using System.Text.Json;

namespace Vrtti.Server;

/// <summary>The server refuses plain text (architecture.md section 27).</summary>
/// <remarks>
/// The clients encrypt each synced note, and this check stays on the server anyway: an old
/// or faulty client must not be able to put readable text or a readable title on it. The
/// keyring record is the one exception, and the caller skips this check for it.
/// </remarks>
public static class Sealed
{
    /// <summary>The first line of an armored age file.</summary>
    const string AgeHeader = "-----BEGIN AGE ENCRYPTED FILE-----";

    /// <summary>The meta fields a note may show the server. The secret ones live in <c>sealed</c>.</summary>
    static readonly HashSet<string> AllowedMeta = ["kind", "enc", "sealed"];

    /// <summary>Null when the row may be stored, else the reason for a 400.</summary>
    public static string? Check(string kind, string? content, JsonElement? meta)
    {
        // A tombstone has no text, but if it carries content, that content is age too.
        if (kind == "text" ? !IsAge(content) : content is not null && !IsAge(content))
        {
            return "content must be an armored age file";
        }

        if (meta is not { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } value)
        {
            return null;
        }

        if (value.ValueKind != JsonValueKind.Object)
        {
            return "meta must be an object";
        }

        foreach (var field in value.EnumerateObject())
        {
            if (!AllowedMeta.Contains(field.Name))
            {
                return "meta may hold only kind, enc and sealed";
            }

            if (field.Name == "sealed"
                && (field.Value.ValueKind != JsonValueKind.String || !IsAge(field.Value.GetString())))
            {
                return "meta.sealed must be an armored age file";
            }
        }

        return null;
    }

    static bool IsAge(string? text) => text is not null && text.StartsWith(AgeHeader, StringComparison.Ordinal);
}
