//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"syscall/js"
)

func contextFromSignal(signal js.Value) (context.Context, func(), error) {
	ctx, cancel := context.WithCancel(context.Background())

	if signal.Type() == js.TypeUndefined || signal.Type() == js.TypeNull {
		return ctx, cancel, nil
	}

	if signal.Type() != js.TypeObject ||
		signal.Get("addEventListener").Type() != js.TypeFunction ||
		signal.Get("removeEventListener").Type() != js.TypeFunction {
		cancel()

		return nil, func() {}, errors.New("signal must be an AbortSignal")
	}

	if signal.Get("aborted").Bool() {
		cancel()
		return ctx, cancel, nil
	}

	abort := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		cancel()
		return nil
	})

	signal.Call("addEventListener", "abort", abort)

	cleanup := func() {
		signal.Call("removeEventListener", "abort", abort)
		abort.Release()
		cancel()
	}

	return ctx, cleanup, nil
}

func resultFromError(err error) any {
	if err != nil {
		return failure(err)
	}

	return ok(nil)
}

func withCompileMetadata(ctx context.Context, name, text string) context.Context {
	return context.WithValue(ctx, compileMetadataKey{}, compileMetadata{name: name, text: text})
}

func compileEvent(ctx context.Context, compileErr error) js.Value {
	event := js.Global().Get("Object").New()
	source := js.Global().Get("Object").New()
	if metadata, ok := ctx.Value(compileMetadataKey{}).(compileMetadata); ok {
		source.Set("name", metadata.name)
		source.Set("text", metadata.text)
	}
	event.Set("source", freezeObject(source))
	if compileErr != nil {
		event.Set("error", js.Global().Get("Error").New(compileErr.Error()))
	}

	return freezeObject(event)
}

func resultEvent(resultErr error) js.Value {
	event := js.Global().Get("Object").New()
	if resultErr != nil {
		event.Set("error", js.Global().Get("Error").New(resultErr.Error()))
	}

	return freezeObject(event)
}

func emptyEvent() js.Value {
	return freezeObject(js.Global().Get("Object").New())
}
