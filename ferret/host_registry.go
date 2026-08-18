//go:build js && wasm

package ferret

import (
	"fmt"
	"math"
	"sync"
	"syscall/js"
)

var protocolNames = []string{
	"keyReadable",
	"keyWritable",
	"keyRemovable",
	"indexReadable",
	"indexWritable",
	"indexRemovable",
	"indexInsertable",
	"appendable",
	"swappable",
	"valueRemovable",
	"clearable",
	"measurable",
	"containable",
	"spawnable",
	"cloneable",
	"hashable",
	"equatable",
	"comparable",
	"sortable",
	"dispatchable",
	"observable",
	"queryable",
	"serializable",
}

type hostRegistry struct {
	mu      sync.Mutex
	weak    js.Value
	symbols map[string]js.Value
	nextID  uint64
	closed  bool
}

func newHostRegistry() *hostRegistry {
	symbols := make(map[string]js.Value, len(protocolNames))
	symbol := js.Global().Get("Symbol")

	for _, name := range protocolNames {
		symbols[name] = symbol.Call("for", "ferret.capability."+name)
	}

	return &hostRegistry{
		weak:    js.Global().Get("WeakMap").New(),
		symbols: symbols,
	}
}

func (r *hostRegistry) identity(target js.Value) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.closed {
		return 0, fmt.Errorf("JavaScript host registry is closed")
	}

	current := r.weak.Call("get", target)
	if current.Type() == js.TypeNumber {
		return uint64(current.Float()), nil
	}

	if r.nextID >= uint64(1<<53-1) {
		return 0, fmt.Errorf("JavaScript host identity space exhausted")
	}

	r.nextID++
	r.weak.Call("set", target, float64(r.nextID))

	return r.nextID, nil
}

func (r *hostRegistry) close() {
	r.mu.Lock()
	r.closed = true
	r.weak = js.Undefined()
	r.symbols = nil
	r.mu.Unlock()
}

func (r *hostRegistry) convert(input js.Value, seen []js.Value, path string) (any, error) {
	return convertJSValue(r, input, seen, path)
}

func (r *hostRegistry) wrap(input js.Value, path string) (*hostValue, bool, error) {
	methods, explicit, err := r.snapshotMethods(input, path)
	if err != nil {
		return nil, false, err
	}

	asyncIterator, syncIterator, err := snapshotIterators(input, path)
	if err != nil {
		return nil, false, err
	}

	global := js.Global()
	builtin := input.InstanceOf(global.Get("Uint8Array")) ||
		global.Get("Array").Call("isArray", input).Bool() ||
		isPlainJSObject(input)

	if builtin && !explicit {
		return nil, false, nil
	}

	if !explicit && asyncIterator.Type() != js.TypeFunction && syncIterator.Type() != js.TypeFunction {
		return nil, false, nil
	}

	identity, err := r.identity(input)
	if err != nil {
		return nil, false, err
	}

	value := &hostValue{
		registry:      r,
		target:        input,
		methods:       methods,
		asyncIterator: asyncIterator,
		syncIterator:  syncIterator,
		identity:      identity,
	}

	if err := value.initializeViews(); err != nil {
		return nil, false, fmt.Errorf("%s: %w", path, err)
	}

	return value, true, nil
}

func (r *hostRegistry) snapshotMethods(input js.Value, path string) (map[string]js.Value, bool, error) {
	methods := make(map[string]js.Value)
	explicit := false

	for _, name := range protocolNames {
		method, err := reflectGet(input, r.symbols[name])
		if err != nil {
			return nil, false, fmt.Errorf("%s[%s]: %w", path, name, err)
		}

		if method.Type() == js.TypeUndefined {
			continue
		}

		explicit = true
		if method.Type() != js.TypeFunction {
			return nil, false, fmt.Errorf("%s[%s] must be callable", path, name)
		}

		methods[name] = method
	}

	return methods, explicit, nil
}

func snapshotIterators(input js.Value, path string) (js.Value, js.Value, error) {
	symbol := js.Global().Get("Symbol")
	asyncIterator, err := reflectGet(input, symbol.Get("asyncIterator"))
	if err != nil {
		return js.Undefined(), js.Undefined(), fmt.Errorf("%s[Symbol.asyncIterator]: %w", path, err)
	}

	if asyncIterator.Type() != js.TypeUndefined && asyncIterator.Type() != js.TypeFunction {
		return js.Undefined(), js.Undefined(), fmt.Errorf("%s[Symbol.asyncIterator] must be callable", path)
	}

	syncIterator, err := reflectGet(input, symbol.Get("iterator"))
	if err != nil {
		return js.Undefined(), js.Undefined(), fmt.Errorf("%s[Symbol.iterator]: %w", path, err)
	}

	if syncIterator.Type() != js.TypeUndefined && syncIterator.Type() != js.TypeFunction {
		return js.Undefined(), js.Undefined(), fmt.Errorf("%s[Symbol.iterator] must be callable", path)
	}

	return asyncIterator, syncIterator, nil
}

func reflectGet(target, key js.Value) (output js.Value, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			output = js.Undefined()
			err = fmt.Errorf("read JavaScript property: %v", recovered)
		}
	}()

	return js.Global().Get("Reflect").Call("get", target, key), nil
}

func safeInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value && math.Abs(value) <= float64(1<<53-1)
}
