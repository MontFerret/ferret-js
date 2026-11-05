//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"syscall/js"

	core "github.com/MontFerret/ferret/v2"
)

type outputHandle struct {
	output    core.Output
	ctx       context.Context
	cleanup   func()
	consuming bool
	closing   bool
	delivered chan struct{}
}

func metadataValue(metadata core.Metadata) any {
	return map[string]any{
		"contentType": metadata.ContentType,
		"length":      metadata.Length,
		"lengthKnown": metadata.LengthKnown,
	}
}

func contentValue(content *core.Content) any {
	if content == nil {
		return nil
	}
	return map[string]any{"metadata": metadataValue(content.Metadata), "data": bytesToJS(content.Data)}
}

func (b *Bridge) collectOutput(_ js.Value, args []js.Value) any {
	if len(args) < 3 || args[2].Type() != js.TypeFunction {
		return failure(errors.New("output id, signal, and callback are required"))
	}
	return b.startOutputConsumption(args[0].String(), args[1], js.Undefined(), args[2])
}

func (b *Bridge) consumeOutput(_ js.Value, args []js.Value) any {
	if len(args) < 4 || args[2].Type() != js.TypeFunction || args[3].Type() != js.TypeFunction {
		return failure(errors.New("output id, signal, consumer, and callback are required"))
	}
	return b.startOutputConsumption(args[0].String(), args[1], args[2], args[3])
}

func (b *Bridge) startOutputConsumption(id string, signal, consumer, callback js.Value) any {
	ctx, cleanup, err := contextFromSignal(signal)
	if err != nil {
		return failure(err)
	}
	b.mu.Lock()
	handle := b.outputs[id]
	switch {
	case ctx.Err() != nil:
		err = ctx.Err()
	case handle == nil || b.closed || b.closing:
		err = core.ErrOutputClosed
	case handle.ctx.Err() != nil:
		err = handle.ctx.Err()
	case handle.closing:
		err = core.ErrOutputClosed
	case handle.consuming:
		err = core.ErrOutputInUse
	}
	if err != nil {
		b.mu.Unlock()
		cleanup()
		return failure(err)
	}
	handle.consuming = true
	handle.delivered = make(chan struct{})
	b.mu.Unlock()

	go func() {
		defer close(handle.delivered)
		defer cleanup()
		var content *core.Content
		var operationErr error
		if consumer.IsUndefined() {
			content, operationErr = handle.output.Collect(ctx)
		} else {
			operationErr = handle.output.Consume(ctx, func(effective context.Context, chunk []byte) error {
				_, err := invokeJS(effective, consumer, bytesToJS(chunk))
				return err
			})
		}
		closeErr := handle.output.Close()
		b.releaseOutput(id, handle)
		invoke(callback, ok(map[string]any{
			"content":    contentValue(content),
			"error":      errorValue(operationErr),
			"closeError": errorValue(closeErr),
		}))
	}()
	return ok(nil)
}

func (b *Bridge) closeOutput(_ js.Value, args []js.Value) any {
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return failure(errors.New("output id and callback are required"))
	}
	id, callback := args[0].String(), args[1]
	b.mu.Lock()
	handle := b.outputs[id]
	var delivered chan struct{}
	if handle != nil {
		handle.closing = true
		delivered = handle.delivered
	}
	b.mu.Unlock()
	go func() {
		var err error
		if handle != nil {
			err = handle.output.Close()
			// Consumption's completion callback must run before shutdown can be
			// requested by the close callback, even when Close races delivery.
			if delivered != nil {
				<-delivered
			}
			b.releaseOutput(id, handle)
		}
		invoke(callback, resultFromError(err))
	}()
	return ok(nil)
}

func (b *Bridge) releaseOutput(id string, handle *outputHandle) {
	handle.cleanup()
	b.mu.Lock()
	delete(b.outputs, id)
	b.mu.Unlock()
}
