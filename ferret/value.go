//go:build js && wasm

package ferret

import (
	"context"
	"fmt"
	"math"
	"reflect"
	"syscall/js"
	"time"

	encodingjson "github.com/MontFerret/ferret/v2/pkg/encoding/json"
	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

type runtimeValueIdentity struct {
	typeOf  reflect.Type
	pointer uintptr
}

func runtimeValueToJS(ctx context.Context, value runtime.Value) (js.Value, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	return runtimeValueToJSWithState(ctx, value, make(map[runtimeValueIdentity]struct{}))
}

func runtimeValueToJSWithState(
	ctx context.Context,
	value runtime.Value,
	active map[runtimeValueIdentity]struct{},
) (js.Value, error) {
	if value == nil || value == runtime.None {
		return js.Null(), nil
	}

	if host, ok := value.(interface{ javascriptTarget() js.Value }); ok {
		return host.javascriptTarget(), nil
	}

	if binary, isBinary := value.(runtime.Binary); isBinary {
		array := js.Global().Get("Uint8Array").New(len(binary))
		js.CopyBytesToJS(array, binary)
		return array, nil
	}

	switch value := value.(type) {
	case runtime.Boolean:
		return js.ValueOf(bool(value)), nil
	case runtime.Int:
		return js.ValueOf(float64(value)), nil
	case runtime.Float:
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return js.Undefined(), fmt.Errorf("Ferret Float must be finite")
		}
		return js.ValueOf(float64(value)), nil
	case runtime.Duration:
		return js.ValueOf(value.String()), nil
	case runtime.String:
		return js.ValueOf(string(value)), nil
	case *runtime.Regexp:
		return js.ValueOf(value.String()), nil
	case runtime.DateTime:
		return js.ValueOf(value.Time.Format(time.RFC3339Nano)), nil
	}

	identity, tracked := runtimeValueIdentityOf(value)
	if tracked {
		if _, recursive := active[identity]; recursive {
			return js.Undefined(), fmt.Errorf("recursive Ferret value")
		}

		active[identity] = struct{}{}
		defer delete(active, identity)
	}

	if mapValue, ok := runtime.ResolveCapability[runtime.Map](value); ok {
		output := js.Global().Get("Object").New()
		err := mapValue.ForEach(ctx, func(ctx context.Context, item, key runtime.Value) (runtime.Boolean, error) {
			converted, err := runtimeValueToJSWithState(ctx, item, active)
			if err != nil {
				return runtime.False, err
			}

			descriptor := js.Global().Get("Object").New()
			descriptor.Set("value", converted)
			descriptor.Set("writable", true)
			descriptor.Set("enumerable", true)
			descriptor.Set("configurable", true)
			defined := js.Global().Get("Reflect").Call("defineProperty", output, key.String(), descriptor)
			if !defined.Bool() {
				return runtime.False, fmt.Errorf("define JavaScript property %q", key.String())
			}

			return runtime.True, nil
		})
		if err != nil {
			return js.Undefined(), err
		}

		return output, nil
	}

	if list, ok := runtime.ResolveCapability[runtime.List](value); ok {
		length, err := list.Length(ctx)
		if err != nil {
			return js.Undefined(), err
		}
		if length < 0 {
			return js.Undefined(), fmt.Errorf("Ferret List returned a negative length")
		}

		output := js.Global().Get("Array").New()
		for index := runtime.ZeroInt; index < length; index++ {
			item, err := list.At(ctx, index)
			if err != nil {
				return js.Undefined(), err
			}

			converted, err := runtimeValueToJSWithState(ctx, item, active)
			if err != nil {
				return js.Undefined(), err
			}

			output.Call("push", converted)
		}

		return output, nil
	}

	if iterable, ok := runtime.ResolveCapability[runtime.Iterable](value); ok {
		output := js.Global().Get("Array").New()
		err := runtime.ForEach(ctx, iterable, func(ctx context.Context, item, _ runtime.Value) (runtime.Boolean, error) {
			converted, err := runtimeValueToJSWithState(ctx, item, active)
			if err != nil {
				return runtime.False, err
			}

			output.Call("push", converted)

			return runtime.True, nil
		})
		if err != nil {
			return js.Undefined(), err
		}

		return output, nil
	}

	encoded, err := encodingjson.Default.Encode(value)
	if err != nil {
		return js.Undefined(), err
	}

	return js.Global().Get("JSON").Call("parse", string(encoded)), nil
}

func runtimeValueIdentityOf(value runtime.Value) (runtimeValueIdentity, bool) {
	reflected := reflect.ValueOf(value)
	if !reflected.IsValid() {
		return runtimeValueIdentity{}, false
	}

	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Map, reflect.Pointer, reflect.Slice, reflect.UnsafePointer:
		return runtimeValueIdentity{typeOf: reflected.Type(), pointer: reflected.Pointer()}, true
	default:
		return runtimeValueIdentity{}, false
	}
}

func jsValueToGo(registry *hostRegistry, input js.Value) (any, error) {
	return convertJSValue(registry, input, nil, "$")
}

func convertJSValue(registry *hostRegistry, input js.Value, seen []js.Value, path string) (any, error) {
	switch input.Type() {
	case js.TypeUndefined, js.TypeNull:
		return nil, nil
	case js.TypeBoolean:
		return input.Bool(), nil
	case js.TypeString:
		return input.String(), nil
	case js.TypeNumber:
		value := input.Float()
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("%s: number must be finite", path)
		}
		return value, nil
	case js.TypeObject:
		return convertJSObject(registry, input, seen, path)
	default:
		return nil, fmt.Errorf("%s: unsupported JavaScript value type %s", path, input.Type())
	}
}

func convertJSObject(registry *hostRegistry, input js.Value, seen []js.Value, path string) (any, error) {
	for _, ancestor := range seen {
		if ancestor.Equal(input) {
			return nil, fmt.Errorf("%s: cyclic JavaScript value", path)
		}
	}

	if registry != nil {
		host, wrapped, err := registry.wrap(input, path)
		if err != nil {
			return nil, err
		}

		if wrapped {
			return host, nil
		}
	}

	seen = append(seen, input)

	global := js.Global()
	if input.InstanceOf(global.Get("Uint8Array")) {
		out := make([]byte, input.Get("byteLength").Int())
		js.CopyBytesToGo(out, input)
		return out, nil
	}

	if global.Get("Array").Call("isArray", input).Bool() {
		out := make([]any, input.Length())

		for index := 0; index < input.Length(); index++ {
			value, err := convertJSValue(registry, input.Index(index), seen, fmt.Sprintf("%s[%d]", path, index))
			if err != nil {
				return nil, err
			}

			out[index] = value
		}

		return out, nil
	}

	object := global.Get("Object")
	prototype := object.Call("getPrototypeOf", input)

	if !prototype.IsNull() && !prototype.Equal(object.Get("prototype")) {
		return nil, fmt.Errorf("%s: only plain JavaScript objects are supported", path)
	}

	keys := object.Call("keys", input)
	out := make(map[string]any, keys.Length())

	for index := 0; index < keys.Length(); index++ {
		key := keys.Index(index).String()
		value, err := convertJSValue(registry, input.Get(key), seen, path+"."+key)

		if err != nil {
			return nil, err
		}

		out[key] = value
	}

	return out, nil
}

func freezeObject(object js.Value) js.Value {
	return js.Global().Get("Object").Call("freeze", object)
}

func isPlainJSObject(input js.Value) bool {
	if input.Type() != js.TypeObject || js.Global().Get("Array").Call("isArray", input).Bool() {
		return false
	}

	object := js.Global().Get("Object")
	prototype := object.Call("getPrototypeOf", input)
	return prototype.IsNull() || prototype.Equal(object.Get("prototype"))
}

func jsParams(registry *hostRegistry, input js.Value) (map[string]any, error) {
	if input.Type() == js.TypeUndefined || input.Type() == js.TypeNull {
		return nil, nil
	}

	value, err := jsValueToGo(registry, input)
	if err != nil {
		return nil, err
	}

	params, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("params must be a plain JavaScript object")
	}

	return params, nil
}

func invokeRuntimeFunction(ctx context.Context, registry *hostRegistry, fn js.Value, args ...runtime.Value) (runtime.Value, error) {
	jsArgs := make([]any, len(args))

	for index, arg := range args {
		value, err := runtimeValueToJS(ctx, arg)
		if err != nil {
			return runtime.None, fmt.Errorf("convert argument %d: %w", index, err)
		}

		jsArgs[index] = value
	}

	output, err := invokeJS(ctx, fn, jsArgs...)
	if err != nil {
		return runtime.None, err
	}

	return parseFunctionOutput(registry, output)
}

func parseFunctionOutput(registry *hostRegistry, output js.Value) (runtime.Value, error) {
	value, err := jsValueToGo(registry, output)
	if err != nil {
		return runtime.None, err
	}

	parsed, err := runtime.ValueOf(value)
	if err != nil {
		return runtime.None, err
	}

	return parsed, nil
}

func ordinaryJSValueToRuntime(input js.Value, seen []js.Value, path string) (runtime.Value, error) {
	value, err := convertJSValue(nil, input, seen, path)
	if err != nil {
		return runtime.None, err
	}

	return runtime.ValueOf(value)
}
