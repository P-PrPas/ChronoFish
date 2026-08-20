FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/chronofish ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/chronofish /chronofish
USER nonroot:nonroot
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/chronofish"]
