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
public sealed partial class DiacriticsModel(HttpClient http, ModelSettings settings, ModelCheckCache cache, ILogger<DiacriticsModel> log)
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

    public string Name => settings.Name;

    // The check asks only for the model list: it answers in milliseconds, needs no
    // model work, and finds the two usual mistakes (a wrong address, a wrong name).
    static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(3);

    // GET /api/model checks live, and every app window asks it at its start. The cache
    // keeps a room of open tabs from becoming a stream of calls to vLLM.
    static readonly TimeSpan CheckFresh = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Whether vLLM answers and serves the configured name. Logs the result when it
    /// differs from the last one, or always with <paramref name="logAlways"/> (the
    /// check at the server start, so <c>docker logs</c> shows a mistake at once).
    /// </summary>
    public async Task<ModelCheck> Check(bool logAlways = false)
    {
        if (!logAlways && cache.Last is { } last && DateTime.UtcNow - last.At < CheckFresh)
        {
            return last;
        }

        var watch = System.Diagnostics.Stopwatch.StartNew();
        ModelCheck result;
        try
        {
            using var timeout = new CancellationTokenSource(CheckTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(settings.Url!, "models"));
            if (settings.Key is not null)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.Key);
            }

            using var response = await http.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                result = new ModelCheck("not answering", [], $"vLLM answered {(int)response.StatusCode}", DateTime.UtcNow);
            }
            else
            {
                var body = await response.Content.ReadFromJsonAsync<JsonElement>(timeout.Token);
                var served = body.GetProperty("data").EnumerateArray()
                    .Select(model => model.GetProperty("id").GetString() ?? "")
                    .ToArray();
                result = served.Contains(settings.Name)
                    ? new ModelCheck("answers", served, null, DateTime.UtcNow)
                    : new ModelCheck("name not served", served, null, DateTime.UtcNow);
            }
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException
                                      or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            result = new ModelCheck("not answering", [], e is OperationCanceledException
                ? $"no answer in {CheckTimeout.TotalSeconds:0} s"
                : $"{e.GetType().Name}: {e.InnerException?.Message ?? e.Message}", DateTime.UtcNow);
        }

        var previous = cache.Last;
        cache.Last = result;
        if (logAlways || previous?.State != result.State)
        {
            LogCheck(result, watch.ElapsedMilliseconds);
        }

        return result;
    }

    void LogCheck(ModelCheck check, long ms)
    {
        switch (check.State)
        {
            case "answers":
                log.LogInformation("model check: {Url} answers, \"{Name}\" is served ({Ms} ms)", settings.Url, settings.Name, ms);
                break;
            case "name not served":
                log.LogWarning("model check: {Url} answers, but it does not serve \"{Name}\"; it serves {Served}",
                    settings.Url, settings.Name, string.Join(", ", check.Served.Select(name => $"\"{name}\"")));
                break;
            default:
                log.LogWarning("model check: {Url} is not answering ({Why})", settings.Url, check.Why);
                break;
        }
    }

    /// <summary>
    /// The answer of the model (null when it failed or took too long), and one line on
    /// what happened, for the log. The line never holds text of the note.
    /// </summary>
    public async Task<ModelAnswer> AddDiacritics(string text, CancellationToken aborted)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        string Seconds() => $"{watch.Elapsed.TotalSeconds:0.00} s";
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        timeout.CancelAfter(Timeout);
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(settings.Url!, "chat/completions"))
        {
            // A body with a Content-Length: JsonContent streams it chunked, and not every
            // OpenAI-compatible server reads a chunked request.
            Content = new StringContent(JsonSerializer.Serialize(new
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
            }), System.Text.Encoding.UTF8, "application/json"),
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
                return new ModelAnswer(null, $"model {(int)response.StatusCode} in {Seconds()}");
            }

            var body = await response.Content.ReadFromJsonAsync<JsonElement>(timeout.Token);
            var content = body.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString();
            return content is null
                ? new ModelAnswer(null, $"model 200 in {Seconds()} with no text")
                : new ModelAnswer(ThinkBlock().Replace(content, ""), $"model 200 in {Seconds()}");
        }
        catch (OperationCanceledException) when (aborted.IsCancellationRequested)
        {
            return new ModelAnswer(null, $"the device left after {Seconds()}");
        }
        catch (OperationCanceledException)
        {
            return new ModelAnswer(null, $"no model answer in {Timeout.TotalSeconds:0} s");
        }
        catch (Exception e) when (e is HttpRequestException or JsonException or KeyNotFoundException
                                      or InvalidOperationException or IndexOutOfRangeException)
        {
            // The kind and the message of the failure, never the text of the note: an
            // exception message here can only name the connection or the JSON shape.
            return new ModelAnswer(null, $"model call failed after {Seconds()}: {e.GetType().Name}: {e.InnerException?.Message ?? e.Message}");
        }
    }

    /// <summary>
    /// How much the model changed, as counts only: "same length, 9 letters changed" or
    /// "other length". The client rejects an answer of another length (checkAnswer), so
    /// "other length" in the log means the model broke the format.
    /// </summary>
    public static string Difference(string sent, string answer)
    {
        sent = sent.Normalize(System.Text.NormalizationForm.FormC);
        answer = answer.Normalize(System.Text.NormalizationForm.FormC);
        if (sent.Length != answer.Length)
        {
            return "other length";
        }

        var changed = sent.Where((c, i) => c != answer[i]).Count();
        return $"same length, {changed} {(changed == 1 ? "letter" : "letters")} changed";
    }

    /// <summary>
    /// Who asked, from the headers the app sends (X-Vrtti-Device, -Run, -Part). The
    /// values come from the device, so they are cleaned before they reach the log: no
    /// control characters (a newline would forge a log line), and a short length.
    /// A client without the headers (an old build) still works and shows as "?".
    /// </summary>
    public static (string Device, string Run, string Part) Caller(IHeaderDictionary headers)
    {
        static string Clean(string? value, int max)
        {
            if (string.IsNullOrWhiteSpace(value)) return "?";
            // The app sends the device name URI-encoded: fetch() refuses a header with
            // characters outside Latin-1, and a name can hold any letter.
            try { value = Uri.UnescapeDataString(value); } catch (UriFormatException) { }
            var clean = new string(value.Where(c => !char.IsControl(c)).ToArray()).Trim();
            return clean.Length == 0 ? "?" : clean.Length > max ? clean[..max] : clean;
        }

        return (Clean(headers["X-Vrtti-Device"], 40), Clean(headers["X-Vrtti-Run"], 8), Clean(headers["X-Vrtti-Part"], 11));
    }

    // A model that thinks aloud anyway puts it first, in one block.
    [GeneratedRegex(@"^\s*<think>.*?</think>\s*", RegexOptions.Singleline)]
    private static partial Regex ThinkBlock();
}

/// <summary>
/// The result of a model check. <c>State</c> is "answers", "not answering" or "name not
/// served"; <c>Why</c> says why it is not answering.
/// </summary>
public record ModelCheck(string State, string[] Served, string? Why, DateTime At);

/// <summary>The answer text (null on a failure) and one log line on what happened.</summary>
public record ModelAnswer(string? Text, string Outcome);

/// <summary>
/// The last check, for the whole server. DiacriticsModel is a typed HttpClient, and the
/// container makes a new one for each request, so it can not keep the result itself.
/// </summary>
public sealed class ModelCheckCache
{
    public ModelCheck? Last { get; set; }
}
