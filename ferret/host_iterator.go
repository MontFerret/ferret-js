//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"syscall/js"
	"time"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostIterationMode uint8

const (
	hostIterationValues hostIterationMode = iota
	hostIterationMap
)

type hostIterable struct{ *hostValue }

func (v *hostIterable) Iterate(ctx context.Context) (runtime.Iterator, error) {
	return v.newIterator(ctx, hostIterationValues)
}

func (v *hostValue) newIterator(ctx context.Context, mode hostIterationMode) (runtime.Iterator, error) {
	factory := v.asyncIterator
	if factory.Type() != js.TypeFunction {
		factory = v.syncIterator
	}

	if factory.Type() != js.TypeFunction {
		return nil, fmt.Errorf("JavaScript host value is not iterable")
	}

	iterator, err := invokeJSMethod(ctx, v.target, factory)
	if err != nil {
		return nil, err
	}

	if iterator.Type() != js.TypeObject || iterator.IsNull() {
		return nil, fmt.Errorf("JavaScript iterator factory must return an object")
	}

	next, nextErr := reflectGet(iterator, js.ValueOf("next"))
	closer, err := reflectGet(iterator, js.ValueOf("return"))
	if err != nil {
		return nil, err
	}
	if closer.Type() != js.TypeUndefined && closer.Type() != js.TypeFunction {
		return nil, fmt.Errorf("JavaScript iterator.return must be callable")
	}
	if nextErr != nil {
		return nil, errors.Join(nextErr, closeHostIterator(iterator, closer))
	}
	if next.Type() != js.TypeFunction {
		return nil, errors.Join(
			fmt.Errorf("JavaScript iterator.next must be callable"),
			closeHostIterator(iterator, closer),
		)
	}

	return &hostIterator{
		registry: v.registry,
		iterator: iterator,
		next:     next,
		closer:   closer,
		mode:     mode,
	}, nil
}

func closeHostIterator(iterator, closer js.Value) error {
	if closer.Type() != js.TypeFunction {
		return nil
	}

	_, err := invokeJSMethod(context.Background(), iterator, closer)

	return err
}

type hostIterator struct {
	mu       sync.Mutex
	registry *hostRegistry
	iterator js.Value
	next     js.Value
	closer   js.Value
	index    runtime.Int
	mode     hostIterationMode
	cleanup  chan error
	done     bool
	closed   bool
}

func (it *hostIterator) Next(ctx context.Context) (runtime.Value, runtime.Value, error) {
	it.mu.Lock()
	defer it.mu.Unlock()

	if it.done || it.closed {
		return runtime.None, runtime.None, io.EOF
	}

	result, err := invokeJSMethodWithCancel(ctx, it.iterator, it.next, it.closeOnCancelLocked)
	if err != nil {
		return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
	}

	if result.Type() != js.TypeObject || result.IsNull() {
		err := fmt.Errorf("JavaScript iterator.next must return an object")
		return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
	}

	done, err := reflectGet(result, js.ValueOf("done"))
	if err != nil {
		return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
	}
	if done.Type() != js.TypeUndefined && done.Type() != js.TypeBoolean {
		err := fmt.Errorf("JavaScript iterator result.done must be a boolean")
		return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
	}
	if done.Type() == js.TypeBoolean && done.Bool() {
		it.done = true
		return runtime.None, runtime.None, io.EOF
	}

	value, err := reflectGet(result, js.ValueOf("value"))
	if err != nil {
		return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
	}

	if it.mode == hostIterationMap {
		if value.Type() != js.TypeObject || !js.Global().Get("Array").Call("isArray", value).Bool() || value.Length() != 2 {
			err := fmt.Errorf("JavaScript map iterator must yield [key, value] entries")
			return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
		}

		key, err := it.runtimeValue(value.Index(0), "$iterator.key")
		if err != nil {
			return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
		}

		item, err := it.runtimeValue(value.Index(1), "$iterator.value")
		if err != nil {
			return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
		}

		return item, key, nil
	}

	item, err := it.runtimeValue(value, "$iterator.value")
	if err != nil {
		return runtime.None, runtime.None, errors.Join(err, it.closeLocked())
	}

	key := it.index
	it.index++

	return item, key, nil
}

func (it *hostIterator) Close() error {
	it.mu.Lock()
	defer it.mu.Unlock()

	return it.closeLocked()
}

func (it *hostIterator) closeLocked() error {
	if it.closed {
		if it.cleanup != nil {
			err := <-it.cleanup
			it.cleanup = nil

			return err
		}

		return nil
	}
	if it.done {
		return nil
	}

	it.closed = true
	if it.closer.Type() != js.TypeFunction {
		return nil
	}

	return closeHostIterator(it.iterator, it.closer)
}

func (it *hostIterator) closeOnCancelLocked() error {
	if it.closed || it.done {
		return nil
	}

	it.closed = true
	if it.closer.Type() != js.TypeFunction {
		return nil
	}

	// AbortSignal listeners enter Go from JavaScript synchronously. Let that
	// listener unwind before calling JavaScript again; re-entering the WASM
	// runtime from cancellation delivery can deadlock the event loop.
	iterator := it.iterator
	closer := it.closer
	it.cleanup = make(chan error, 1)
	cleanup := it.cleanup
	go func() {
		time.Sleep(time.Millisecond)
		cleanup <- closeHostIterator(iterator, closer)
		close(cleanup)
	}()

	return nil
}

func (it *hostIterator) runtimeValue(input js.Value, path string) (runtime.Value, error) {
	converted, err := it.registry.convert(input, nil, path)
	if err != nil {
		return runtime.None, err
	}

	return runtime.ValueOf(converted)
}
