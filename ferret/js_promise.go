//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"syscall/js"
)

type jsPromiseResult struct {
	value js.Value
	err   error
}

func invokeJS(ctx context.Context, fn js.Value, args ...any) (output js.Value, err error) {
	if ctx == nil {
		ctx = context.Background()
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			output = js.Undefined()
			err = fmt.Errorf("JavaScript callback threw: %v", recovered)
		}
	}()

	output = fn.Invoke(args...)
	if output.Type() != js.TypeObject || output.Get("then").Type() != js.TypeFunction {
		return output, nil
	}

	return awaitJSPromise(ctx, output)
}

func awaitJSPromise(ctx context.Context, promise js.Value) (js.Value, error) {
	result := make(chan jsPromiseResult, 1)

	var success js.Func
	var rejected js.Func
	var releaseOnce sync.Once
	released := make(chan struct{})
	release := func() {
		releaseOnce.Do(func() {
			go func() {
				success.Release()
				rejected.Release()
				close(released)
			}()
		})
	}

	success = js.FuncOf(func(_ js.Value, values []js.Value) any {
		value := js.Undefined()
		if len(values) > 0 {
			value = values[0]
		}

		select {
		case result <- jsPromiseResult{value: value}:
		default:
		}

		release()
		return nil
	})

	rejected = js.FuncOf(func(_ js.Value, values []js.Value) any {
		message := "JavaScript promise rejected"
		if len(values) > 0 {
			message = jsValueString(values[0], message)
		}

		select {
		case result <- jsPromiseResult{value: js.Undefined(), err: errors.New(message)}:
		default:
		}

		release()
		return nil
	})

	if err := attachPromiseHandlers(promise, success, rejected); err != nil {
		release()
		<-released
		return js.Undefined(), err
	}

	select {
	case settled := <-result:
		<-released
		if err := ctx.Err(); err != nil {
			return js.Undefined(), err
		}
		return settled.value, settled.err
	case <-ctx.Done():
		// JavaScript promises cannot be cancelled generically. Wait for settlement
		// so their Go callbacks cannot outlive the WASM runtime, then report the
		// cancellation observed by Ferret.
		<-result
		<-released
		return js.Undefined(), ctx.Err()
	}
}

func attachPromiseHandlers(promise js.Value, success, rejected js.Func) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("attach JavaScript promise handlers: %v", recovered)
		}
	}()

	promise.Call("then", success, rejected)
	return nil
}

func jsValueString(value js.Value, fallback string) (out string) {
	out = fallback

	defer func() {
		_ = recover()
	}()

	return js.Global().Get("String").Invoke(value).String()
}
