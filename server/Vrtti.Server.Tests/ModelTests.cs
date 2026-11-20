using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Vrtti.Server.Tests;

/// <summary>The model endpoints for "Add diacritics (vllm)".</summary>
public class ModelTests
{
    /// <summary>A fake OpenAI-compatible chat endpoint.</summary>
    sealed class FakeModel(Func<string, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<JsonElement> Requests { get; } = [];
        public List<long?> Lengths { get; } = [];

        // The model list of GET /v1/models; null answers 503, as a vLLM that is down.
        public string[]? Served { get; set; } = ["default"];
        public int Checks { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.RequestUri!.ToString() == "http://model.test/v1/models")
            {
                Checks++;
                return Served is null
                    ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    : new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = JsonContent.Create(new { data = Served.Select(id => new { id }).ToArray() }),
                    };
            }

            Assert.Equal("http://model.test/v1/chat/completions", request.RequestUri!.ToString());
            Lengths.Add(request.Content!.Headers.ContentLength);
            var body = await request.Content!.ReadFromJsonAsync<JsonElement>(token);
            Requests.Add(body);
            var text = body.GetProperty("messages")[1].GetProperty("content").GetString()!;
            return answer(text);
        }

        public static HttpResponseMessage Chat(string content) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { choices = new[] { new { message = new { content } } } }),
                Encoding.UTF8,
                "application/json"),
        };
    }

    [Fact]
    public async Task Model_says_false_without_VRTTI_MODEL_URL_and_post_is_404()
    {
        using var app = new TestApp();
        var client = app.Client();

        var info = await client.GetFromJsonAsync<JsonElement>("/api/model");
        Assert.False(info.GetProperty("diacritics").GetBoolean());

        using var post = await client.PostAsJsonAsync("/api/model/diacritics", new { text = "ahoj" });
        Assert.Equal(HttpStatusCode.NotFound, post.StatusCode);
    }

    [Fact]
    public async Task The_model_routes_need_the_token()
    {
        using var app = new TestApp(new FakeModel(_ => FakeModel.Chat("x")));
        var anonymous = app.Client(token: null);

        using var get = await anonymous.GetAsync("/api/model");
        using var post = await anonymous.PostAsJsonAsync("/api/model/diacritics", new { text = "ahoj" });

        Assert.Equal(HttpStatusCode.Unauthorized, get.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, post.StatusCode);
    }

    [Fact]
    public async Task A_paragraph_goes_to_the_model_with_the_fixed_instruction()
    {
        var model = new FakeModel(_ => FakeModel.Chat("tlačítko palcové otevře menu"));
        using var app = new TestApp(model);
        var client = app.Client();

        var info = await client.GetFromJsonAsync<JsonElement>("/api/model");
        Assert.True(info.GetProperty("diacritics").GetBoolean());

        using var response = await client.PostAsJsonAsync("/api/model/diacritics", new { text = "tlacitko palcove otevre menu" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("tlačítko palcové otevře menu", body.GetProperty("text").GetString());

        var sent = Assert.Single(model.Requests);
        Assert.Equal(0, sent.GetProperty("temperature").GetInt32());
        Assert.Equal("system", sent.GetProperty("messages")[0].GetProperty("role").GetString());
        Assert.Equal("tlacitko palcove otevre menu", sent.GetProperty("messages")[1].GetProperty("content").GetString());
        // A fixed length and not a chunked body: some servers do not read chunked requests
        // (found with a small Python fake model, which closed the connection).
        Assert.NotNull(Assert.Single(model.Lengths));
    }

    [Fact]
    public async Task A_think_block_is_removed_from_the_answer()
    {
        using var app = new TestApp(new FakeModel(_ => FakeModel.Chat("<think>\nhmm\n</think>\n\nže")));
        using var response = await app.Client().PostAsJsonAsync("/api/model/diacritics", new { text = "ze" });

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("že", body.GetProperty("text").GetString());
    }

    [Fact]
    public async Task A_failing_model_gives_502()
    {
        using var app = new TestApp(new FakeModel(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError)));
        using var response = await app.Client().PostAsJsonAsync("/api/model/diacritics", new { text = "ahoj" });

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    [Fact]
    public async Task A_paragraph_above_the_limit_gives_413_and_never_reaches_the_model()
    {
        var model = new FakeModel(_ => FakeModel.Chat("x"));
        using var app = new TestApp(model);
        var text = new string('a', DiacriticsModel.MaxChars + 1);
        using var response = await app.Client().PostAsJsonAsync("/api/model/diacritics", new { text });

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Empty(model.Requests);
    }

    [Theory]
    [InlineData(new[] { "default" }, "answers")]
    [InlineData(new[] { "Qwen/Qwen3-8B" }, "name not served")]
    [InlineData(null, "not answering")]
    public async Task The_model_route_checks_vllm_live(string[]? served, string state)
    {
        var model = new FakeModel(_ => FakeModel.Chat("x")) { Served = served };
        using var app = new TestApp(model);

        var info = await app.Client().GetFromJsonAsync<JsonElement>("/api/model");

        // "diacritics" stays true while the model is down: the app keeps the menu entry.
        Assert.True(info.GetProperty("diacritics").GetBoolean());
        Assert.Equal("default", info.GetProperty("name").GetString());
        Assert.Equal(state, info.GetProperty("state").GetString());
        Assert.True(model.Checks >= 1);
    }

    [Fact]
    public async Task The_log_names_the_caller_and_the_outcome_and_never_the_text()
    {
        using var app = new TestApp(new FakeModel(_ => FakeModel.Chat("tlačítko palcové")));
        var client = app.Client();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/model/diacritics")
        {
            Content = JsonContent.Create(new { text = "tlacitko palcove" }),
        };
        // The app URI-encodes the name; a newline in it must not forge a second log line.
        request.Headers.Add("X-Vrtti-Device", Uri.EscapeDataString("Telefon Šárky\ninfo: forged"));
        request.Headers.Add("X-Vrtti-Run", "7f3a");
        request.Headers.Add("X-Vrtti-Part", "2/5");

        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        // The second line is written after the response is out, so wait for it.
        for (var i = 0; i < 50 && !app.Logs.Any(line => line.Contains("relayed")); i++)
        {
            await Task.Delay(20);
        }

        var lines = app.Logs.Where(line => line.Contains("diacritics run")).ToArray();
        Assert.Equal(2, lines.Length);
        Assert.Equal("Information: diacritics run 7f3a from Telefon Šárkyinfo: forged: paragraph 2/5 asked, 16 characters", lines[0]);
        Assert.StartsWith("Information: diacritics run 7f3a paragraph 2/5: model 200 in ", lines[1]);
        Assert.EndsWith(", same length, 3 letters changed, relayed", lines[1]);
        Assert.DoesNotContain(app.Logs, line => line.Contains("tlac") || line.Contains("tlač"));
    }

    [Fact]
    public async Task A_client_without_the_headers_still_works_and_logs_question_marks()
    {
        using var app = new TestApp(new FakeModel(_ => FakeModel.Chat("ze")));
        using var response = await app.Client().PostAsJsonAsync("/api/model/diacritics", new { text = "ze" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(app.Logs, line => line == "Information: diacritics run ? from ?: paragraph ? asked, 2 characters");
    }

    [Theory]
    [InlineData("ze", "že", "same length, 1 letter changed")]
    [InlineData("ze", "ze", "same length, 0 letters changed")]
    [InlineData("ze", "že!", "other length")]
    // NFD from the model counts as one letter, as the client's check reads it (NFC).
    [InlineData("ze", "zě", "same length, 1 letter changed")]
    public void Difference_counts_letters_only(string sent, string answer, string expected) =>
        Assert.Equal(expected, DiacriticsModel.Difference(sent, answer));
}
