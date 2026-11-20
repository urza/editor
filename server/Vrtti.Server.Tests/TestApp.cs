using System.Collections.Concurrent;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Vrtti.Server.Tests;

/// <summary>A server instance with its own SQLite file in a temporary directory.</summary>
/// <remarks>
/// The server reads its configuration from environment variables before the host exists,
/// so a test cannot inject them through IConfiguration. Environment variables are
/// process-wide, which is why AssemblyInfo.cs switches test parallelization off.
/// </remarks>
/// <param name="model">A fake language model behind VRTTI_MODEL_URL; null for no model.</param>
public sealed class TestApp(HttpMessageHandler? model = null) : WebApplicationFactory<Program>
{
    public const string Token = "test-token-6c1f9a";

    readonly string _dir = Path.Combine(
        Path.GetTempPath(), "vrtti-tests", Guid.NewGuid().ToString("n"));

    protected override IHost CreateHost(IHostBuilder builder)
    {
        Environment.SetEnvironmentVariable("VRTTI_TOKEN", Token);
        Environment.SetEnvironmentVariable("VRTTI_DB", Path.Combine(_dir, "vrtti.db"));
        Environment.SetEnvironmentVariable("VRTTI_ORIGINS", "https://urza.github.io, http://localhost:8000");
        // Set or cleared on every host: the variable is process-wide, and a test with a
        // model must not leave one behind for the next test.
        Environment.SetEnvironmentVariable("VRTTI_MODEL_URL", model is null ? null : "http://model.test/v1");
        return base.CreateHost(builder);
    }

    /// <summary>Every log message of the server, as text, for tests of the model log.</summary>
    public ConcurrentQueue<string> Logs { get; } = new();

    sealed class ListLogger(ConcurrentQueue<string> logs) : ILoggerProvider, ILogger
    {
        public ILogger CreateLogger(string category) => this;
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => level >= LogLevel.Information;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? e, Func<TState, Exception?, string> format) =>
            logs.Enqueue($"{level}: {format(state, e)}");
        public void Dispose() { }
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureLogging(logging => logging.AddProvider(new ListLogger(Logs)));
        if (model is not null)
        {
            builder.ConfigureServices(services =>
                services.AddHttpClient<Vrtti.Server.DiacriticsModel>().ConfigurePrimaryHttpMessageHandler(() => model));
        }
    }

    /// <summary>A client with a bearer token. Pass null for an anonymous client.</summary>
    public HttpClient Client(string? token = Token)
    {
        var client = CreateClient();
        if (token is not null)
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing)
        {
            return;
        }

        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A leftover temporary directory must never fail a test run.
        }
    }
}
