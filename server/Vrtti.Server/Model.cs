using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Vrtti.Server;

/// <summary>Where the user's language model is (VRTTI_MODEL_*). Null url: no model.</summary>
public record ModelSettings(Uri? Url, string Name, string? Key)
{
    public static ModelSettings FromEnvironment()
    {
        var url = Environment.GetEnvironmentVariable("VRTTI_MODEL_URL");
        return new ModelSettings(
            string.IsNullOrWhiteSpace(url) ? null : new Uri(url.TrimEnd('/') + "/"),
            Environment.GetEnvironmentVariable("VRTTI_MODEL_NAME") is { Length: > 0 } name ? name : "default",
            Environment.GetEnvironmentVariable("VRTTI_MODEL_KEY") is { Length: > 0 } key ? key : null);
    }
}

/// <summary>
/// "Add diacritics (vllm)" (.work/mixed-spellcheck/plan.md): one paragraph to an
/// OpenAI-compatible chat endpoint (vLLM), one answer back.
/// </summary>
/// <remarks>
/// The instruction is fixed here, so the endpoint can do this one job and nothing else: a
/// holder of the token can not use it as a general door to the model. The client checks
/// the answer again (diacritics.js, checkAnswer): the model may only add diacritics.
/// <para>
/// No note text goes into a log or an error message. The server otherwise never reads
/// the text of a note; this is the one exception, and only on the user's command.
/// </para>
/// </remarks>
public sealed partial class DiacriticsModel(HttpClient http, ModelSettings settings)
{
    // A paragraph, not a note: the client sends one request per paragraph.
    public const int MaxChars = 20_000;

    // A guard against a model that hangs, not an expected time: one paragraph takes a
    // second or two on a local model.
    static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    const string Instruction =
        "Doplň do českého textu chybějící diakritiku (háčky a čárky). Neměň nic jiného: "
        + "žádná slova, pořadí, interpunkci, mezery, velká písmena ani formátování. "
        + "Anglická slova, jména, kód a odkazy nech beze změny. "
        + "Odpověz pouze upraveným textem, bez úvodu a bez vysvětlení.";

    public bool Available => settings.Url is not null;

    /// <summary>The answer of the model, or null when it failed or took too long.</summary>
    public async Task<string?> AddDiacritics(string text, CancellationToken aborted)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(settings.Url!, "chat/completions"))
        {
            Content = JsonContent.Create(new
            {
                model = settings.Name,
                temperature = 0,
                // The answer has the length of the input. Czech runs at about one token per
                // two to three characters, so this leaves room and still stops a model that
                // does not stop.
                max_tokens = text.Length + 64,
                // Qwen3 and similar models think aloud by default; vLLM passes this to the
                // chat template, and templates that do not know it ignore it.
                chat_template_kwargs = new { enable_thinking = false },
                messages = new object[]
                {
                    new { role = "system", content = Instruction },
                    new { role = "user", content = text },
                },
            }),
        };
        if (settings.Key is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.Key);
        }

        try
        {
            using var response = await http.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var body = await response.Content.ReadFromJsonAsync<JsonElement>(timeout.Token);
            var content = body.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
            return content is null ? null : ThinkBlock().Replace(content, "");
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException
                                      or JsonException or KeyNotFoundException
                                      or InvalidOperationException or IndexOutOfRangeException)
        {
            return null;
        }
    }

    // A model that thinks aloud anyway puts it first, in one block.
    [GeneratedRegex(@"^\s*<think>.*?</think>\s*", RegexOptions.Singleline)]
    private static partial Regex ThinkBlock();
}
