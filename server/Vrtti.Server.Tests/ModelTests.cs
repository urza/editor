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

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Assert.Equal("http://model.test/v1/chat/completions", request.RequestUri!.ToString());
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
}
