# Build context is the server/ directory: docker build -t vrtti-server server/
#
# The SDK stage pins itself to the builder's own architecture and cross-compiles with
# dotnet's `-a` flag. An arm64 image therefore needs no QEMU emulation of the whole
# SDK, which turns a ten-minute build into a one-minute one. The runtime stage below
# stays unpinned, so buildx pulls the aspnet image for the target architecture.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG TARGETARCH
WORKDIR /src

# ${TARGETARCH:+-a $TARGETARCH} expands to nothing when TARGETARCH is empty, which
# keeps a plain non-buildkit `docker build` working: no flag, so the build targets the
# host. Restore and publish must pass the same value, or --no-restore finds no runtime
# pack for the target RID.
# The project file comes first, alone, so the restore layer survives a code edit.
COPY Vrtti.Server/Vrtti.Server.csproj Vrtti.Server/
RUN dotnet restore Vrtti.Server/Vrtti.Server.csproj ${TARGETARCH:+-a $TARGETARCH}

COPY Vrtti.Server/ Vrtti.Server/
RUN dotnet publish Vrtti.Server/Vrtti.Server.csproj -c Release -o /app --no-restore ${TARGETARCH:+-a $TARGETARCH}

# An empty directory, carried into the runtime stage as /data. See the note there.
RUN mkdir /data-empty

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .

# The aspnet image ships a non-root user named "app". The data directory must exist and
# belong to that user before VOLUME: a fresh volume copies the ownership of the image
# directory, and a root-owned /data would leave the server unable to write its database.
#
# It arrives as a COPY --chown, not `RUN mkdir && chown`, because a RUN in this stage
# executes target-architecture binaries. On an amd64 builder that means QEMU, and the
# arm64 build fails outright without it. COPY and its name lookup run on the builder,
# so both architectures build with no emulation at all.
COPY --from=build --chown=app:app /data-empty /data
VOLUME /data
USER app

ENV ASPNETCORE_URLS=http://+:8080
ENV VRTTI_DB=/data/vrtti.db
EXPOSE 8080

ENTRYPOINT ["dotnet", "Vrtti.Server.dll"]
