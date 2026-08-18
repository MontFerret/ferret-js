//go:build js && wasm

package ferret

import (
	"context"
	"fmt"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostCollection struct{ *hostValue }

func (v *hostCollection) Iterate(ctx context.Context) (runtime.Iterator, error) {
	return v.newIterator(ctx, hostIterationValues)
}

func (v *hostCollection) Length(ctx context.Context) (runtime.Int, error) {
	return (&hostMeasurable{hostValue: v.hostValue}).Length(ctx)
}

func (v *hostCollection) Contains(ctx context.Context, value runtime.Value) (runtime.Boolean, error) {
	return (&hostContainable{hostValue: v.hostValue}).Contains(ctx, value)
}

func (v *hostCollection) Clear(ctx context.Context) error {
	return (&hostClearable{hostValue: v.hostValue}).Clear(ctx)
}

func (v *hostCollection) Clone(ctx context.Context) (runtime.Cloneable, error) {
	return (&hostCloneable{hostValue: v.hostValue}).Clone(ctx)
}

func (v *hostCollection) Equal(ctx context.Context, other runtime.Value) (bool, error) {
	return v.hostValue.equal(ctx, other)
}

func (v *hostCollection) Compare(ctx context.Context, other runtime.Value) (runtime.Ordering, error) {
	return v.hostValue.compare(ctx, other)
}

func (v *hostValue) equal(ctx context.Context, other runtime.Value) (bool, error) {
	if v.has("equatable") {
		return (&hostEquatable{hostValue: v}).Equal(ctx, other)
	}

	identity, ok := other.(interface{ javascriptIdentity() uint64 })

	return ok && identity.javascriptIdentity() == v.identity, nil
}

func (v *hostValue) compare(ctx context.Context, other runtime.Value) (runtime.Ordering, error) {
	if v.has("comparable") {
		return (&hostComparable{hostValue: v}).Compare(ctx, other)
	}

	identity, ok := other.(interface{ javascriptIdentity() uint64 })
	if !ok {
		return runtime.Equal, runtime.Error(runtime.ErrInvalidOperation, "incompatible JavaScript host comparison")
	}

	otherIdentity := identity.javascriptIdentity()
	switch {
	case v.identity < otherIdentity:
		return runtime.Less, nil
	case v.identity > otherIdentity:
		return runtime.Greater, nil
	default:
		return runtime.Equal, nil
	}
}

func (v *hostValue) spawnList(ctx context.Context) (runtime.List, error) {
	value, err := v.invokeValue(ctx, "spawnable")
	if err != nil {
		return nil, err
	}

	spawned, ok := runtime.ResolveCapability[runtime.List](value)
	if !ok {
		return nil, fmt.Errorf("spawnable must return a List-compatible value")
	}

	return spawned, nil
}

func (v *hostValue) spawnMap(ctx context.Context) (runtime.Map, error) {
	value, err := v.invokeValue(ctx, "spawnable")
	if err != nil {
		return nil, err
	}

	spawned, ok := runtime.ResolveCapability[runtime.Map](value)
	if !ok {
		return nil, fmt.Errorf("spawnable must return a Map-compatible value")
	}

	return spawned, nil
}

func (v *hostValue) cloneList(ctx context.Context, source runtime.List) (runtime.Cloneable, error) {
	if v.has("cloneable") {
		return (&hostCloneable{hostValue: v}).Clone(ctx)
	}

	clone, err := v.spawnList(ctx)
	if err != nil {
		return nil, err
	}

	if err := clone.Concat(ctx, source); err != nil {
		return nil, err
	}

	return clone, nil
}

func (v *hostValue) cloneMap(ctx context.Context, source runtime.Map) (runtime.Cloneable, error) {
	if v.has("cloneable") {
		return (&hostCloneable{hostValue: v}).Clone(ctx)
	}

	clone, err := v.spawnMap(ctx)
	if err != nil {
		return nil, err
	}

	if err := clone.Merge(ctx, source); err != nil {
		return nil, err
	}

	return clone, nil
}
