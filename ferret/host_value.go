//go:build js && wasm

package ferret

import (
	"context"
	"fmt"
	"math"
	"reflect"
	"syscall/js"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostValue struct {
	registry      *hostRegistry
	views         map[reflect.Type]any
	methods       map[string]js.Value
	target        js.Value
	asyncIterator js.Value
	syncIterator  js.Value
	identity      uint64
	hash          uint64
}

func (v *hostValue) String() string {
	return "[JavaScript HostValue]"
}

func (v *hostValue) Hash() uint64 {
	return v.hash
}

func (v *hostValue) Copy() runtime.Value {
	return v
}

func (v *hostValue) javascriptTarget() js.Value {
	return v.target
}

func (v *hostValue) javascriptIdentity() uint64 {
	return v.identity
}

func (v *hostValue) ResolveCapability(requested reflect.Type) (any, bool) {
	capability, ok := v.views[requested]

	return capability, ok
}

func (v *hostValue) initializeViews() error {
	v.views = make(map[reflect.Type]any)
	v.hash = v.identity
	if v.has("equatable") && !v.has("hashable") {
		return fmt.Errorf("equatable requires hashable")
	}

	if method, ok := v.methods["hashable"]; ok {
		output, err := invokeJSMethodSync(v.target, method)
		if err != nil {
			return fmt.Errorf("hashable: %w", err)
		}

		if output.Type() != js.TypeNumber || !safeInteger(output.Float()) || output.Float() < 0 {
			return fmt.Errorf("hashable must return a non-negative safe integer")
		}

		v.hash = uint64(output.Float())
	}

	v.registerAtomicViews()

	mapShape := v.hasAll(
		"keyReadable",
		"keyWritable",
		"keyRemovable",
		"measurable",
		"spawnable",
	) && v.iterable()
	listShape := v.hasAll(
		"indexReadable",
		"indexWritable",
		"indexRemovable",
		"indexInsertable",
		"swappable",
		"appendable",
		"measurable",
		"spawnable",
		"sortable",
	) && v.iterable()
	collectionShape := v.hasAll(
		"measurable",
		"containable",
		"clearable",
		"cloneable",
	) && v.iterable()

	switch {
	case listShape:
		view := &hostList{hostValue: v}
		v.views[reflect.TypeFor[runtime.List]()] = view
		v.views[reflect.TypeFor[runtime.Collection]()] = view
		v.registerDerivedCollectionViews(view)
	case mapShape:
		view := &hostMap{hostValue: v}
		v.views[reflect.TypeFor[runtime.Map]()] = view
		v.views[reflect.TypeFor[runtime.Collection]()] = view
		v.registerDerivedCollectionViews(view)
	case collectionShape:
		view := &hostCollection{hostValue: v}
		v.views[reflect.TypeFor[runtime.Collection]()] = view
		v.registerDerivedCollectionViews(view)
	}

	return nil
}

func (v *hostValue) registerAtomicViews() {
	if v.iterable() {
		v.views[reflect.TypeFor[runtime.Iterable]()] = &hostIterable{hostValue: v}
	}
	if v.has("keyReadable") {
		v.views[reflect.TypeFor[runtime.KeyReadable]()] = &hostKeyReadable{hostValue: v}
		v.views[reflect.TypeFor[runtime.KeyLookup]()] = &hostKeyReadable{hostValue: v}
	}
	if v.has("keyWritable") {
		v.views[reflect.TypeFor[runtime.KeyWritable]()] = &hostKeyWritable{hostValue: v}
	}
	if v.has("keyRemovable") {
		v.views[reflect.TypeFor[runtime.KeyRemovable]()] = &hostKeyRemovable{hostValue: v}
	}
	if v.has("indexReadable") {
		v.views[reflect.TypeFor[runtime.IndexReadable]()] = &hostIndexReadable{hostValue: v}
		v.views[reflect.TypeFor[runtime.IndexLookup]()] = &hostIndexReadable{hostValue: v}
	}
	if v.has("indexWritable") {
		v.views[reflect.TypeFor[runtime.IndexWritable]()] = &hostIndexWritable{hostValue: v}
	}
	if v.has("indexRemovable") {
		v.views[reflect.TypeFor[runtime.IndexRemovable]()] = &hostIndexRemovable{hostValue: v}
	}
	if v.has("indexInsertable") {
		v.views[reflect.TypeFor[runtime.IndexInsertable]()] = &hostIndexInsertable{hostValue: v}
	}
	if v.has("appendable") {
		v.views[reflect.TypeFor[runtime.Appendable]()] = &hostAppendable{hostValue: v}
	}
	if v.has("swappable") {
		v.views[reflect.TypeFor[runtime.Swappable]()] = &hostSwappable{hostValue: v}
	}
	if v.has("valueRemovable") {
		v.views[reflect.TypeFor[runtime.ValueRemovable]()] = &hostValueRemovable{hostValue: v}
	}
	if v.has("clearable") {
		v.views[reflect.TypeFor[runtime.Clearable]()] = &hostClearable{hostValue: v}
	}
	if v.has("measurable") {
		v.views[reflect.TypeFor[runtime.Measurable]()] = &hostMeasurable{hostValue: v}
	}
	if v.has("containable") {
		v.views[reflect.TypeFor[runtime.Containable]()] = &hostContainable{hostValue: v}
	}
	if v.has("cloneable") {
		v.views[reflect.TypeFor[runtime.Cloneable]()] = &hostCloneable{hostValue: v}
	}
	if v.has("equatable") {
		v.views[reflect.TypeFor[runtime.Equatable]()] = &hostEquatable{hostValue: v}
	}
	if v.has("comparable") {
		v.views[reflect.TypeFor[runtime.Comparable]()] = &hostComparable{hostValue: v}
	}
	if v.has("sortable") {
		v.views[reflect.TypeFor[runtime.Sortable]()] = &hostSortable{hostValue: v}
	}
	if v.has("dispatchable") {
		v.views[reflect.TypeFor[runtime.Dispatchable]()] = &hostDispatchable{hostValue: v}
	}
	if v.has("observable") {
		v.views[reflect.TypeFor[runtime.Observable]()] = &hostObservable{hostValue: v}
	}
	if v.has("queryable") {
		v.views[reflect.TypeFor[runtime.Queryable]()] = &hostQueryable{hostValue: v}
	}
	if v.has("serializable") {
		v.views[reflect.TypeFor[runtime.Serializable]()] = &hostSerializable{hostValue: v}
	}
}

func (v *hostValue) registerDerivedCollectionViews(view runtime.Collection) {
	v.views[reflect.TypeFor[runtime.Iterable]()] = view
	v.views[reflect.TypeFor[runtime.Measurable]()] = view
	v.views[reflect.TypeFor[runtime.Containable]()] = view
	v.views[reflect.TypeFor[runtime.Clearable]()] = view
	v.views[reflect.TypeFor[runtime.Cloneable]()] = view
	v.views[reflect.TypeFor[runtime.Equatable]()] = view
	v.views[reflect.TypeFor[runtime.Comparable]()] = view
}

func (v *hostValue) has(name string) bool {
	_, ok := v.methods[name]

	return ok
}

func (v *hostValue) hasAll(names ...string) bool {
	for _, name := range names {
		if !v.has(name) {
			return false
		}
	}

	return true
}

func (v *hostValue) iterable() bool {
	return v.asyncIterator.Type() == js.TypeFunction || v.syncIterator.Type() == js.TypeFunction
}

func (v *hostValue) invoke(ctx context.Context, name string, args ...any) (js.Value, error) {
	method, ok := v.methods[name]
	if !ok {
		return js.Undefined(), fmt.Errorf("JavaScript host value does not support %s", name)
	}

	return invokeJSMethod(ctx, v.target, method, args...)
}

func (v *hostValue) invokeVoid(ctx context.Context, name string, args ...any) error {
	_, err := v.invoke(ctx, name, args...)

	return err
}

func (v *hostValue) invokeValue(ctx context.Context, name string, args ...any) (runtime.Value, error) {
	output, err := v.invoke(ctx, name, args...)
	if err != nil {
		return runtime.None, err
	}

	return v.runtimeValue(output, "$result")
}

func (v *hostValue) runtimeValue(input js.Value, path string) (runtime.Value, error) {
	converted, err := v.registry.convert(input, nil, path)
	if err != nil {
		return runtime.None, err
	}

	return runtime.ValueOf(converted)
}

func (v *hostValue) jsArgument(ctx context.Context, input runtime.Value) (js.Value, error) {
	return runtimeValueToJS(ctx, input)
}

func normalizeHostOrdering(value float64) (runtime.Ordering, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return runtime.Equal, fmt.Errorf("comparable must return a finite number")
	}

	switch {
	case value < 0:
		return runtime.Less, nil
	case value > 0:
		return runtime.Greater, nil
	default:
		return runtime.Equal, nil
	}
}
