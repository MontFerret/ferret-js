//go:build js && wasm

package ferret

import (
	"context"

	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type hostList struct{ *hostValue }

func (v *hostList) Iterate(ctx context.Context) (runtime.Iterator, error) {
	return v.newIterator(ctx, hostIterationValues)
}

func (v *hostList) Length(ctx context.Context) (runtime.Int, error) {
	return (&hostMeasurable{hostValue: v.hostValue}).Length(ctx)
}

func (v *hostList) At(ctx context.Context, index runtime.Int) (runtime.Value, error) {
	return (&hostIndexReadable{hostValue: v.hostValue}).At(ctx, index)
}

func (v *hostList) LookupAt(ctx context.Context, index runtime.Int) (runtime.Value, bool, error) {
	return (&hostIndexReadable{hostValue: v.hostValue}).LookupAt(ctx, index)
}

func (v *hostList) SetAt(ctx context.Context, index runtime.Int, value runtime.Value) error {
	return (&hostIndexWritable{hostValue: v.hostValue}).SetAt(ctx, index, value)
}

func (v *hostList) RemoveAt(ctx context.Context, index runtime.Int) (runtime.Value, error) {
	return (&hostIndexRemovable{hostValue: v.hostValue}).RemoveAt(ctx, index)
}

func (v *hostList) Insert(ctx context.Context, index runtime.Int, value runtime.Value) error {
	return (&hostIndexInsertable{hostValue: v.hostValue}).Insert(ctx, index, value)
}

func (v *hostList) Append(ctx context.Context, value runtime.Value) error {
	return (&hostAppendable{hostValue: v.hostValue}).Append(ctx, value)
}

func (v *hostList) Swap(ctx context.Context, first, second runtime.Int) error {
	return (&hostSwappable{hostValue: v.hostValue}).Swap(ctx, first, second)
}

func (v *hostList) SortAsc(ctx context.Context) error {
	return (&hostSortable{hostValue: v.hostValue}).SortAsc(ctx)
}

func (v *hostList) SortDesc(ctx context.Context) error {
	return (&hostSortable{hostValue: v.hostValue}).SortDesc(ctx)
}

func (v *hostList) Empty(ctx context.Context) (runtime.List, error) {
	return v.spawnList(ctx)
}

func (v *hostList) Contains(ctx context.Context, value runtime.Value) (runtime.Boolean, error) {
	if v.has("containable") {
		return (&hostContainable{hostValue: v.hostValue}).Contains(ctx, value)
	}

	index, err := v.IndexOf(ctx, value)

	return index >= 0, err
}

func (v *hostList) IndexOf(ctx context.Context, value runtime.Value) (runtime.Int, error) {
	length, err := v.Length(ctx)
	if err != nil {
		return -1, err
	}

	for index := runtime.ZeroInt; index < length; index++ {
		item, err := v.At(ctx, index)
		if err != nil {
			return -1, err
		}

		equal, err := runtime.EqualValues(ctx, value, item)
		if err != nil {
			return -1, err
		}

		if equal {
			return index, nil
		}
	}

	return -1, nil
}

func (v *hostList) Remove(ctx context.Context, value runtime.Value) error {
	if v.has("valueRemovable") {
		return (&hostValueRemovable{hostValue: v.hostValue}).Remove(ctx, value)
	}

	index, err := v.IndexOf(ctx, value)
	if err != nil || index < 0 {
		return err
	}

	_, err = v.RemoveAt(ctx, index)

	return err
}

func (v *hostList) Clear(ctx context.Context) error {
	if v.has("clearable") {
		return (&hostClearable{hostValue: v.hostValue}).Clear(ctx)
	}

	length, err := v.Length(ctx)
	if err != nil {
		return err
	}

	for index := length - 1; index >= 0; index-- {
		if _, err := v.RemoveAt(ctx, index); err != nil {
			return err
		}
	}

	return nil
}

func (v *hostList) Clone(ctx context.Context) (runtime.Cloneable, error) {
	return v.cloneList(ctx, v)
}

func (v *hostList) Equal(ctx context.Context, other runtime.Value) (bool, error) {
	return v.hostValue.equal(ctx, other)
}

func (v *hostList) Compare(ctx context.Context, other runtime.Value) (runtime.Ordering, error) {
	return v.hostValue.compare(ctx, other)
}

func (v *hostList) Concat(ctx context.Context, other runtime.List) error {
	return runtime.ForEach(ctx, other, func(ctx context.Context, value, _ runtime.Value) (runtime.Boolean, error) {
		if err := v.Append(ctx, value); err != nil {
			return runtime.False, err
		}

		return runtime.True, nil
	})
}

func (v *hostList) First(ctx context.Context) (runtime.Value, error) {
	return v.At(ctx, runtime.ZeroInt)
}

func (v *hostList) Last(ctx context.Context) (runtime.Value, error) {
	length, err := v.Length(ctx)
	if err != nil || length == 0 {
		return runtime.None, err
	}

	return v.At(ctx, length-1)
}

func (v *hostList) Slice(ctx context.Context, start, end runtime.Int) (runtime.List, error) {
	result, err := v.Empty(ctx)
	if err != nil {
		return nil, err
	}

	length, err := v.Length(ctx)
	if err != nil {
		return nil, err
	}

	if start >= length {
		return result, nil
	}
	if end > length {
		end = length
	}

	for index := start; index < end; index++ {
		value, err := v.At(ctx, index)
		if err != nil {
			return nil, err
		}

		if err := result.Append(ctx, value); err != nil {
			return nil, err
		}
	}

	return result, nil
}

func (v *hostList) Filter(ctx context.Context, predicate runtime.IndexReadablePredicate) (runtime.List, error) {
	result, err := v.Empty(ctx)
	if err != nil {
		return nil, err
	}

	err = v.ForEach(ctx, func(ctx context.Context, value runtime.Value, index runtime.Int) (runtime.Boolean, error) {
		match, err := predicate(ctx, value, index)
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

func (v *hostList) Find(ctx context.Context, predicate runtime.IndexReadablePredicate) (runtime.Value, runtime.Boolean, error) {
	length, err := v.Length(ctx)
	if err != nil {
		return runtime.None, runtime.False, err
	}

	for index := runtime.ZeroInt; index < length; index++ {
		value, err := v.At(ctx, index)
		if err != nil {
			return runtime.None, runtime.False, err
		}

		match, err := predicate(ctx, value, index)
		if err != nil {
			return runtime.None, runtime.False, err
		}
		if match {
			return value, runtime.True, nil
		}
	}

	return runtime.None, runtime.False, nil
}

func (v *hostList) ForEach(ctx context.Context, predicate runtime.IndexReadablePredicate) error {
	length, err := v.Length(ctx)
	if err != nil {
		return err
	}

	for index := runtime.ZeroInt; index < length; index++ {
		value, err := v.At(ctx, index)
		if err != nil {
			return err
		}

		proceed, err := predicate(ctx, value, index)
		if err != nil {
			return err
		}
		if !proceed {
			return nil
		}
	}

	return nil
}
