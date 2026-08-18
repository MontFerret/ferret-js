//go:build js && wasm

package ferret

import (
	"context"
	"fmt"
	"syscall/js"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostKeyReadable struct{ *hostValue }

func (v *hostKeyReadable) Get(ctx context.Context, key runtime.Value) (runtime.Value, error) {
	value, _, err := v.Lookup(ctx, key)

	return value, err
}

func (v *hostKeyReadable) Lookup(ctx context.Context, key runtime.Value) (runtime.Value, bool, error) {
	argument, err := v.jsArgument(ctx, key)
	if err != nil {
		return runtime.None, false, err
	}

	output, err := v.invoke(ctx, "keyReadable", argument)
	if err != nil {
		return runtime.None, false, err
	}

	if output.Type() == js.TypeUndefined {
		return runtime.None, false, nil
	}

	value, err := v.runtimeValue(output, "$keyReadable")

	return value, err == nil, err
}

type hostKeyWritable struct{ *hostValue }

func (v *hostKeyWritable) Set(ctx context.Context, key, value runtime.Value) error {
	jsKey, err := v.jsArgument(ctx, key)
	if err != nil {
		return err
	}

	jsValue, err := v.jsArgument(ctx, value)
	if err != nil {
		return err
	}

	return v.invokeVoid(ctx, "keyWritable", jsKey, jsValue)
}

type hostKeyRemovable struct{ *hostValue }

func (v *hostKeyRemovable) RemoveKey(ctx context.Context, key runtime.Value) error {
	argument, err := v.jsArgument(ctx, key)
	if err != nil {
		return err
	}

	return v.invokeVoid(ctx, "keyRemovable", argument)
}

type hostIndexReadable struct{ *hostValue }

func (v *hostIndexReadable) At(ctx context.Context, index runtime.Int) (runtime.Value, error) {
	value, _, err := v.LookupAt(ctx, index)

	return value, err
}

func (v *hostIndexReadable) LookupAt(ctx context.Context, index runtime.Int) (runtime.Value, bool, error) {
	output, err := v.invoke(ctx, "indexReadable", float64(index))
	if err != nil {
		return runtime.None, false, err
	}

	if output.Type() == js.TypeUndefined {
		return runtime.None, false, nil
	}

	value, err := v.runtimeValue(output, "$indexReadable")

	return value, err == nil, err
}

type hostIndexWritable struct{ *hostValue }

func (v *hostIndexWritable) SetAt(ctx context.Context, index runtime.Int, value runtime.Value) error {
	argument, err := v.jsArgument(ctx, value)
	if err != nil {
		return err
	}

	return v.invokeVoid(ctx, "indexWritable", float64(index), argument)
}

type hostIndexRemovable struct{ *hostValue }

func (v *hostIndexRemovable) RemoveAt(ctx context.Context, index runtime.Int) (runtime.Value, error) {
	readable, ok := runtime.ResolveCapability[runtime.IndexLookup](v.hostValue)
	if !ok {
		return runtime.None, runtime.TypeErrorOf(v.hostValue, runtime.TypeIndexReadable)
	}

	removed, found, err := readable.LookupAt(ctx, index)
	if err != nil || !found {
		return runtime.None, err
	}

	if err := v.invokeVoid(ctx, "indexRemovable", float64(index)); err != nil {
		return runtime.None, err
	}

	return removed, nil
}

type hostIndexInsertable struct{ *hostValue }

func (v *hostIndexInsertable) Insert(ctx context.Context, index runtime.Int, value runtime.Value) error {
	argument, err := v.jsArgument(ctx, value)
	if err != nil {
		return err
	}

	return v.invokeVoid(ctx, "indexInsertable", float64(index), argument)
}

type hostAppendable struct{ *hostValue }

func (v *hostAppendable) Append(ctx context.Context, value runtime.Value) error {
	argument, err := v.jsArgument(ctx, value)
	if err != nil {
		return err
	}

	return v.invokeVoid(ctx, "appendable", argument)
}

type hostSwappable struct{ *hostValue }

func (v *hostSwappable) Swap(ctx context.Context, first, second runtime.Int) error {
	return v.invokeVoid(ctx, "swappable", float64(first), float64(second))
}

type hostValueRemovable struct{ *hostValue }

func (v *hostValueRemovable) Remove(ctx context.Context, value runtime.Value) error {
	argument, err := v.jsArgument(ctx, value)
	if err != nil {
		return err
	}

	return v.invokeVoid(ctx, "valueRemovable", argument)
}

type hostClearable struct{ *hostValue }

func (v *hostClearable) Clear(ctx context.Context) error {
	return v.invokeVoid(ctx, "clearable")
}

type hostMeasurable struct{ *hostValue }

func (v *hostMeasurable) Length(ctx context.Context) (runtime.Int, error) {
	output, err := v.invoke(ctx, "measurable")
	if err != nil {
		return runtime.ZeroInt, err
	}

	if output.Type() != js.TypeNumber || !safeInteger(output.Float()) || output.Float() < 0 {
		return runtime.ZeroInt, fmt.Errorf("measurable must return a non-negative safe integer")
	}

	return runtime.Int(output.Float()), nil
}

type hostContainable struct{ *hostValue }

func (v *hostContainable) Contains(ctx context.Context, value runtime.Value) (runtime.Boolean, error) {
	argument, err := v.jsArgument(ctx, value)
	if err != nil {
		return runtime.False, err
	}

	output, err := v.invoke(ctx, "containable", argument)
	if err != nil {
		return runtime.False, err
	}

	if output.Type() != js.TypeBoolean {
		return runtime.False, fmt.Errorf("containable must return a boolean")
	}

	return runtime.Boolean(output.Bool()), nil
}

type hostCloneable struct{ *hostValue }

func (v *hostCloneable) Clone(ctx context.Context) (runtime.Cloneable, error) {
	value, err := v.invokeValue(ctx, "cloneable")
	if err != nil {
		return nil, err
	}

	clone, ok := runtime.ResolveCapability[runtime.Cloneable](value)
	if !ok {
		return nil, fmt.Errorf("cloneable must return a cloneable value")
	}

	return clone, nil
}

type hostEquatable struct{ *hostValue }

func (v *hostEquatable) Equal(ctx context.Context, other runtime.Value) (bool, error) {
	argument, err := v.jsArgument(ctx, other)
	if err != nil {
		return false, err
	}

	output, err := v.invoke(ctx, "equatable", argument)
	if err != nil {
		return false, err
	}

	if output.Type() != js.TypeBoolean {
		return false, fmt.Errorf("equatable must return a boolean")
	}

	return output.Bool(), nil
}

type hostComparable struct{ *hostValue }

func (v *hostComparable) Compare(ctx context.Context, other runtime.Value) (runtime.Ordering, error) {
	argument, err := v.jsArgument(ctx, other)
	if err != nil {
		return runtime.Equal, err
	}

	output, err := v.invoke(ctx, "comparable", argument)
	if err != nil {
		return runtime.Equal, err
	}

	if output.Type() != js.TypeNumber {
		return runtime.Equal, fmt.Errorf("comparable must return a number")
	}

	return normalizeHostOrdering(output.Float())
}

type hostSortable struct{ *hostValue }

func (v *hostSortable) SortAsc(ctx context.Context) error {
	return v.invokeVoid(ctx, "sortable", "asc")
}

func (v *hostSortable) SortDesc(ctx context.Context) error {
	return v.invokeVoid(ctx, "sortable", "desc")
}

type hostSerializable struct{ *hostValue }

func (v *hostSerializable) Serialize() (runtime.Value, error) {
	method := v.methods["serializable"]
	output, err := invokeJSMethodSync(v.target, method)
	if err != nil {
		return runtime.None, fmt.Errorf("serializable: %w", err)
	}

	if output.Type() == js.TypeUndefined {
		return runtime.None, fmt.Errorf("serializable must return materializable JavaScript data")
	}

	if output.Type() == js.TypeObject && output.Equal(v.target) {
		return runtime.None, fmt.Errorf("serializable returned its host value")
	}

	return ordinaryJSValueToRuntime(output, []js.Value{v.target}, "$serializable")
}
