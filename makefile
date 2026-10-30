.PHONY: ollama
ollama: 
	docker compose up -d ollama pgvector
	docker compose exec ollama ollama pull llama3.2:3b
	docker compose exec ollama ollama pull gpt-oss:20b
	docker compose exec ollama ollama pull embeddinggemma

.PHONY: up test
up: ollama
	docker compose up -d --build

test:
	cd src/gateway && npm test
	cd src/orchestrator && go test ./...
	cd src/memory && go test ./...
	cd src/ui && npm run build

