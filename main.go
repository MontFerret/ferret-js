//go:build js && wasm

package main

import (
	"os"
	"syscall/js"

	ferretjs "github.com/MontFerret/ferret-js/ferret"
)

var (
	version       = "undefined"
	ferretVersion = "undefined"
)

func main() {
	token := os.Getenv("FERRET_WASM_INSTANCE_ID")
	if token == "" {
		panic("FERRET_WASM_INSTANCE_ID is required")
	}

	done := make(chan struct{})
	bridge := ferretjs.NewBridge(ferretjs.Version{
		Self:   version,
		Ferret: ferretVersion,
	}, func() {
		close(done)
	})

	global := js.Global()
	bridges := global.Get("__ferretWasmBridges")

	if bridges.Type() != js.TypeObject {
		bridges = global.Get("Object").Call("create", js.Null())
		global.Set("__ferretWasmBridges", bridges)
	}

	bridges.Set(token, bridge.JSValue())

	<-done
	bridge.Release()
}
