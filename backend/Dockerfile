FROM golang:1.24-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
COPY backend/cmd ./cmd
COPY backend/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/chronofish ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/chronofish /chronofish
COPY backend/db/migrations /migrations
USER nonroot:nonroot
ENV PORT=8080
ENV MIGRATIONS_DIR=/migrations/postgres
EXPOSE 8080
ENTRYPOINT ["/chronofish"]
