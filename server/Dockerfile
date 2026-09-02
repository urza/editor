# Build context is the server/ directory: docker build -t vrtti-server server/
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# The project file comes first, alone, so the restore layer survives a code edit.
COPY Vrtti.Server/Vrtti.Server.csproj Vrtti.Server/
RUN dotnet restore Vrtti.Server/Vrtti.Server.csproj

COPY Vrtti.Server/ Vrtti.Server/
RUN dotnet publish Vrtti.Server/Vrtti.Server.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .

# The aspnet image ships a non-root user named "app". The data directory must exist and
# belong to that user before VOLUME: a fresh volume copies the ownership of the image
# directory, and a root-owned /data would leave the server unable to write its database.
RUN mkdir -p /data && chown app:app /data
VOLUME /data
USER app

ENV ASPNETCORE_URLS=http://+:8080
ENV VRTTI_DB=/data/vrtti.db
EXPOSE 8080

ENTRYPOINT ["dotnet", "Vrtti.Server.dll"]
