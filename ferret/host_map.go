//go:build js && wasm

package ferret

import (
	"context"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostMap struct{ *hostValue }

func (v *hostMap) Iterate(ctx context.Context) (runtime.Iterator, error) {
	return v.newIterator(ctx, hostIterationMap)
}

func (v *hostMap) Length(ctx context.Context) (runtime.Int, error) {
	return (&hostMeasurable{hostValue: v.hostValue}).Length(ctx)
}

func (v *hostMap) Get(ctx context.Context, key runtime.Value) (runtime.Value, error) {
	return (&hostKeyReadable{hostValue: v.hostValue}).Get(ctx, key)
}

func (v *hostMap) Lookup(ctx context.Context, key runtime.Value) (runtime.Value, bool, error) {
	return (&hostKeyReadable{hostValue: v.hostValue}).Lookup(ctx, key)
}

func (v *hostMap) Set(ctx context.Context, key, value runtime.Value) error {
	return (&hostKeyWritable{hostValue: v.hostValue}).Set(ctx, key, value)
}

func (v *hostMap) RemoveKey(ctx context.Context, key runtime.Value) error {
	return (&hostKeyRemovable{hostValue: v.hostValue}).RemoveKey(ctx, key)
}

func (v *hostMap) Empty(ctx context.Context) (runtime.Map, error) {
	return v.spawnMap(ctx)
}

func (v *hostMap) ContainsKey(ctx context.Context, key runtime.Value) (runtime.Boolean, error) {
	_, found, err := v.Lookup(ctx, key)

	return runtime.Boolean(found), err
}

func (v *hostMap) Contains(ctx context.Context, value runtime.Value) (runtime.Boolean, error) {
	if v.has("containable") {
		return (&hostContainable{hostValue: v.hostValue}).Contains(ctx, value)
	}

	found := runtime.False
	err := v.ForEach(ctx, func(ctx context.Context, item, _ runtime.Value) (runtime.Boolean, error) {
		equal, err := runtime.EqualValues(ctx, value, item)
		if err != nil {
			return runtime.False, err
		}
		if equal {
			found = runtime.True
			return runtime.False, nil
		}

		return runtime.True, nil
	})

	return found, err
}

func (v *hostMap) Remove(ctx context.Context, value runtime.Value) error {
	if v.has("valueRemovable") {
		return (&hostValueRemovable{hostValue: v.hostValue}).Remove(ctx, value)
	}

	var matched runtime.Value
	found := false
	err := v.ForEach(ctx, func(ctx context.Context, item, key runtime.Value) (runtime.Boolean, error) {
		equal, err := runtime.EqualValues(ctx, value, item)
		if err != nil {
			return runtime.False, err
		}
		if equal {
			matched = key
			found = true
			return runtime.False, nil
		}

		return runtime.True, nil
	})
	if err != nil || !found {
		return err
	}

	return v.RemoveKey(ctx, matched)
}

func (v *hostMap) Clear(ctx context.Context) error {
	if v.has("clearable") {
		return (&hostClearable{hostValue: v.hostValue}).Clear(ctx)
	}

	keys, err := v.Keys(ctx)
	if err != nil {
		return err
	}

	return runtime.ForEach(ctx, keys, func(ctx context.Context, key, _ runtime.Value) (runtime.Boolean, error) {
		if err := v.RemoveKey(ctx, key); err != nil {
			return runtime.False, err
		}

		return runtime.True, nil
	})
}

func (v *hostMap) Clone(ctx context.Context) (runtime.Cloneable, error) {
	return v.cloneMap(ctx, v)
}

func (v *hostMap) Equal(ctx context.Context, other runtime.Value) (bool, error) {
	return v.hostValue.equal(ctx, other)
}

func (v *hostMap) Compare(ctx context.Context, other runtime.Value) (runtime.Ordering, error) {
	return v.hostValue.compare(ctx, other)
}

func (v *hostMap) Merge(ctx context.Context, other runtime.Map) error {
	return other.ForEach(ctx, func(ctx context.Context, value, key runtime.Value) (runtime.Boolean, error) {
		if err := v.Set(ctx, key, value); err != nil {
			return runtime.False, err
		}

		return runtime.True, nil
	})
}

func (v *hostMap) Keys(ctx context.Context) (runtime.List, error) {
	length, err := v.Length(ctx)
	if err != nil {
		return nil, err
	}

	result := runtime.NewArray64(length)
	err = v.ForEach(ctx, func(ctx context.Context, _, key runtime.Value) (runtime.Boolean, error) {
		if err := result.Append(ctx, key); err != nil {
			return runtime.False, err
		}

		return runtime.True, nil
	})

	return result, err
}

func (v *hostMap) Values(ctx context.Context) (runtime.List, error) {
	length, err := v.Length(ctx)
	if err != nil {
		return nil, err
	}

	result := runtime.NewArray64(length)
	err = v.ForEach(ctx, func(ctx context.Context, value, _ runtime.Value) (runtime.Boolean, error) {
		if err := result.Append(ctx, value); err != nil {
			return runtime.False, err
		}

		return runtime.True, nil
	})

	return result, err
}

func (v *hostMap) Filter(ctx context.Context, predicate runtime.KeyReadablePredicate) (runtime.List, error) {
	length, err := v.Length(ctx)
	if err != nil {
		return nil, err
	}

	result := runtime.NewArray64(length)
	err = v.ForEach(ctx, func(ctx context.Context, value, key runtime.Value) (runtime.Boolean, error) {
		match, err := predicate(ctx, value, key)
		if err != nil {
			return runtime.False, err
		}
		if match {
			if err := result.Append(ctx, value); err != nil {
				return runtime.False, err
			}
		}

		return runtime.True, nil
	})

	return result, err
}

func (v *hostMap) Find(ctx context.Context, predicate runtime.KeyReadablePredicate) (runtime.Value, runtime.Boolean, error) {
	result := runtime.Value(runtime.None)
	found := runtime.False
	err := v.ForEach(ctx, func(ctx context.Context, value, key runtime.Value) (runtime.Boolean, error) {
		match, err := predicate(ctx, value, key)
		if err != nil {
			return runtime.False, err
		}
		if match {
			result = value
			found = runtime.True
			return runtime.False, nil
		}

		return runtime.True, nil
	})

	return result, found, err
}

func (v *hostMap) ForEach(ctx context.Context, predicate runtime.KeyReadablePredicate) error {
	return runtime.ForEach(ctx, v, func(ctx context.Context, value, key runtime.Value) (runtime.Boolean, error) {
		return predicate(ctx, value, key)
	})
}
