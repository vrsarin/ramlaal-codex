FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/orchestrator ./cmd/orchestrator

# sh is needed: verify commands run through the shell
FROM alpine:3.22
COPY --from=build /out/orchestrator /usr/local/bin/orchestrator
EXPOSE 8000
CMD ["orchestrator"]
