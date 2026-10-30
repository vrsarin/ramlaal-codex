# OLLAMA=local (default): use Ollama installed on this machine. OLLAMA=docker: run it as a compose service.
OLLAMA ?= local

ifeq ($(OLLAMA),docker)
export COMPOSE_PROFILES := ollama
export OLLAMA_BASE_URL := http://ollama:11434
OLLAMA_CMD = docker compose exec ollama ollama
OLLAMA_SVC = ollama
else
OLLAMA_CMD = ollama
OLLAMA_SVC =
endif

.PHONY: ollama
ollama:
	docker compose up -d $(OLLAMA_SVC) pgvector
	$(OLLAMA_CMD) pull llama3.2:3b
	$(OLLAMA_CMD) pull gpt-oss:20b
	$(OLLAMA_CMD) pull embeddinggemma

.PHONY: up test
up: ollama
	docker compose up -d --build

test:
	cd src/gateway && npm test
	cd src/orchestrator && go test ./...
	cd src/memory && go test ./...
	cd src/ui && npm run build
