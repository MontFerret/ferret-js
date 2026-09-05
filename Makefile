PACKAGE_VERSION ?= $(shell sh scripts/versions.sh package)
FERRET_VERSION = $(shell sh scripts/versions.sh ferret)
DIST := ./dist

.PHONY: build clean fmt install js test test-browser test-go wasm

build: clean js wasm

clean:
	node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"

install:
	go mod download
	npm ci

js:
	npm run build:js

wasm:
	mkdir -p $(DIST)
	GOOS=js GOARCH=wasm go build -trimpath \
		-ldflags "-s -w -X main.version=$(PACKAGE_VERSION) -X main.ferretVersion=$(FERRET_VERSION)" \
		-o $(DIST)/ferret.wasm .
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(DIST)/wasm_exec.js

test: build
	npm test

test-browser: build
	npm run test:browser

test-go:
	GOOS=js GOARCH=wasm go test \
		-exec="$$(go env GOROOT)/lib/wasm/go_js_wasm_exec" ./...

fmt:
	gofmt -w main.go ferret
	npm run format
