.DEFAULT_GOAL := help
.PHONY: help install dev build clean check lint format format-fix typecheck test test-watch test-integration test-all \
        up up-deps down logs image image-run example-embedded example-networked k8s-validate k8s-deploy k8s-delete

COMPOSE ?= docker compose
IMAGE ?= jiffy-messaging:local
DATABASE_URL ?= postgres://jiffy:jiffy@localhost:5432/jiffy_messaging

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

## Development

install: ## Install dependencies
	pnpm install

dev: ## Rebuild on change
	pnpm dev

build: ## Build the package and server bundles
	pnpm build

clean: ## Remove build output
	rm -rf dist coverage

## Quality

check: lint typecheck test build ## Everything CI runs

lint: ## Lint
	pnpm lint

format: ## Check formatting
	pnpm format

format-fix: ## Apply formatting
	pnpm format:write

typecheck: ## Typecheck source and examples
	pnpm typecheck

test: ## Unit and component tests, no infrastructure needed
	pnpm test

test-watch: ## Tests in watch mode
	pnpm test:watch

test-integration: ## Integration tests, needs Postgres (see up-deps)
	DATABASE_URL=$(DATABASE_URL) pnpm test:integration

test-all: test test-integration ## Every test

## Docker

up: ## Postgres, Redis, and two service instances
	$(COMPOSE) up --build

up-deps: ## Postgres and Redis only, for local development
	$(COMPOSE) up -d postgres redis

down: ## Stop everything and remove volumes
	$(COMPOSE) down -v

logs: ## Tail service logs
	$(COMPOSE) logs -f jiffy-messaging-a jiffy-messaging-b

image: ## Build the container image
	docker build -t $(IMAGE) .

image-run: ## Run the built image against DATABASE_URL
	docker run --rm -p 8080:8080 \
		-e DATABASE_URL=$(DATABASE_URL) \
		-e JWT_SECRET=$${JWT_SECRET:-local-dev-secret-do-not-use-in-production} \
		$(IMAGE)

## Examples

example-embedded: ## Run the in-process example
	pnpm example:embedded

example-networked: ## Run the REST and WebSocket client against a running server
	pnpm example:networked

## Kubernetes

k8s-validate: ## Validate manifests, no cluster needed
	kubectl kustomize k8s/ | kubectl apply --dry-run=client -f -

k8s-deploy: ## Apply manifests to the current context
	kubectl apply -k k8s/

k8s-delete: ## Remove manifests from the current context
	kubectl delete -k k8s/
