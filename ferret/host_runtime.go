//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"syscall/js"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostDispatchable struct{ *hostValue }

func (v *hostDispatchable) Dispatch(ctx context.Context, event runtime.DispatchEvent) error {
	payload, err := runtimeValueToJS(ctx, event.Payload)
	if err != nil {
		return err
	}
	options, err := runtimeValueToJS(ctx, event.Options)
	if err != nil {
		return err
	}

	jsEvent := js.Global().Get("Object").New()
	jsEvent.Set("name", event.Name.String())
	jsEvent.Set("payload", payload)
	jsEvent.Set("options", options)

	return v.invokeVoid(ctx, "dispatchable", jsEvent)
}

type hostQueryable struct{ *hostValue }

func (v *hostQueryable) Query(ctx context.Context, query runtime.Query) (runtime.List, error) {
	params, err := runtimeValueToJS(ctx, query.Params)
	if err != nil {
		return nil, err
	}
	options, err := runtimeValueToJS(ctx, query.Options)
	if err != nil {
		return nil, err
	}

	jsQuery := js.Global().Get("Object").New()
	jsQuery.Set("kind", query.Kind.String())
	jsQuery.Set("expression", query.Expression.String())
	jsQuery.Set("params", params)
	jsQuery.Set("options", options)

	output, err := v.invoke(ctx, "queryable", jsQuery)
	if err != nil {
		return nil, err
	}

	value, err := v.runtimeValue(output, "$queryable")
	if err != nil {
		return nil, err
	}

	if list, ok := runtime.ResolveCapability[runtime.List](value); ok {
		return list, nil
	}

	if _, ok := runtime.ResolveCapability[runtime.Iterable](value); ok {
		return runtime.ToList(ctx, value)
	}

	return nil, fmt.Errorf("queryable must return an array or iterable")
}

func (v *hostQueryable) QueryOne(ctx context.Context, query runtime.Query) (runtime.Value, error) {
	return runtime.DefaultQueryOne(ctx, query, v.Query)
}

func (v *hostQueryable) QueryCount(ctx context.Context, query runtime.Query) (runtime.Int, error) {
	return runtime.DefaultQueryCount(ctx, query, v.Query)
}

func (v *hostQueryable) QueryExists(ctx context.Context, query runtime.Query) (runtime.Boolean, error) {
	return runtime.DefaultQueryExists(ctx, query, v.Query)
}

type hostObservable struct{ *hostValue }

func (v *hostObservable) Subscribe(ctx context.Context, subscription runtime.Subscription) (runtime.Stream, error) {
	options, err := runtimeValueToJS(ctx, subscription.Options)
	if err != nil {
		return nil, fmt.Errorf("convert observable options: %w", err)
	}

	jsSubscription := js.Global().Get("Object").New()
	jsSubscription.Set("eventName", subscription.EventName.String())
	jsSubscription.Set("options", options)

	output, err := v.invoke(ctx, "observable", jsSubscription)
	if err != nil {
		return nil, fmt.Errorf("invoke observable: %w", err)
	}

	value, err := v.runtimeValue(output, "$observable")
	if err != nil {
		return nil, fmt.Errorf("convert observable result: %w", err)
	}

	iterable, ok := runtime.ResolveCapability[runtime.Iterable](value)
	if !ok {
		return nil, fmt.Errorf("observable must return an iterable")
	}

	iterator, err := iterable.Iterate(ctx)
	if err != nil {
		return nil, err
	}

	return newHostStream(iterator), nil
}

type hostStream struct {
	once     sync.Once
	mu       sync.Mutex
	iterator runtime.Iterator
	messages chan runtime.Message
	cancel   context.CancelFunc
	closed   bool
}

func newHostStream(iterator runtime.Iterator) *hostStream {
	return &hostStream{
		iterator: iterator,
		messages: make(chan runtime.Message),
	}
}

func (s *hostStream) Read(ctx context.Context) <-chan runtime.Message {
	s.once.Do(func() {
		readCtx, cancel := context.WithCancel(ctx)

		s.mu.Lock()
		s.cancel = cancel
		closed := s.closed
		s.mu.Unlock()

		if closed {
			cancel()
		}

		go s.read(readCtx)
	})

	return s.messages
}

func (s *hostStream) read(ctx context.Context) {
	defer close(s.messages)
	defer func() {
		if closer, ok := s.iterator.(io.Closer); ok {
			_ = closer.Close()
		}
	}()

	for {
		value, _, err := s.iterator.Next(ctx)
		if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			select {
			case s.messages <- runtime.NewErrorMessage(err):
			case <-ctx.Done():
			}
			return
		}

		select {
		case s.messages <- runtime.NewValueMessage(value):
		case <-ctx.Done():
			return
		}
	}
}

func (s *hostStream) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}

	s.closed = true
	cancel := s.cancel
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}

	if closer, ok := s.iterator.(io.Closer); ok {
		return closer.Close()
	}

	return nil
}
