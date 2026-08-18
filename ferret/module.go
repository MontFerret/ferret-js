//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"syscall/js"

	"github.com/MontFerret/ferret/v2/pkg/module"
	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

const shorthandModuleName = "@ferret/functions"

var lifecycleNames = map[string]struct{}{
	"onInit":         {},
	"onClose":        {},
	"beforeCompile":  {},
	"afterCompile":   {},
	"onPlanClose":    {},
	"beforeRun":      {},
	"afterRun":       {},
	"onSessionClose": {},
}

type (
	jsFunction struct {
		callback js.Value
		name     string
	}

	jsModule struct {
		lifecycle map[string]js.Value
		functions []jsFunction
		name      string
		namespace []string
		registry  *hostRegistry
	}

	compileMetadata struct {
		name string
		text string
	}

	compileMetadataKey struct{}
)

func parseModuleDefinitions(registry *hostRegistry, functions, modules js.Value) ([]module.Module, error) {
	parsed := make([]module.Module, 0)

	shorthand, err := parseFunctions(functions, "functions")
	if err != nil {
		return nil, err
	}

	if len(shorthand) > 0 {
		parsed = append(parsed, &jsModule{name: shorthandModuleName, functions: shorthand, registry: registry})
	}

	if modules.Type() == js.TypeUndefined || modules.Type() == js.TypeNull {
		return parsed, nil
	}

	if modules.Type() != js.TypeObject || !js.Global().Get("Array").Call("isArray", modules).Bool() {
		return nil, errors.New("modules must be an array")
	}

	names := make(map[string]struct{}, modules.Length())
	for index := 0; index < modules.Length(); index++ {
		path := fmt.Sprintf("modules[%d]", index)
		definition := modules.Index(index)
		if !isPlainJSObject(definition) {
			return nil, fmt.Errorf("%s must be a plain JavaScript object", path)
		}

		nameValue := definition.Get("name")
		if nameValue.Type() != js.TypeString || strings.TrimSpace(nameValue.String()) == "" {
			return nil, fmt.Errorf("%s.name must be a non-empty string", path)
		}

		name := nameValue.String()
		if _, duplicate := names[name]; duplicate {
			return nil, fmt.Errorf("duplicate module name %q", name)
		}
		names[name] = struct{}{}

		namespace, err := parseNamespace(definition.Get("namespace"), path+".namespace")
		if err != nil {
			return nil, err
		}

		moduleFunctions, err := parseFunctions(definition.Get("functions"), path+".functions")
		if err != nil {
			return nil, err
		}

		lifecycle, err := parseLifecycle(definition.Get("lifecycle"), path+".lifecycle")
		if err != nil {
			return nil, err
		}

		parsed = append(parsed, &jsModule{
			name:      name,
			namespace: namespace,
			functions: moduleFunctions,
			lifecycle: lifecycle,
			registry:  registry,
		})
	}

	return parsed, nil
}

func parseFunctions(input js.Value, path string) ([]jsFunction, error) {
	if input.Type() == js.TypeUndefined || input.Type() == js.TypeNull {
		return nil, nil
	}

	if !isPlainJSObject(input) {
		return nil, fmt.Errorf("%s must be a plain JavaScript object", path)
	}

	object := js.Global().Get("Object")
	keys := object.Call("keys", input)
	functions := make([]jsFunction, 0, keys.Length())
	names := make(map[string]struct{}, keys.Length())

	for index := 0; index < keys.Length(); index++ {
		rawName := keys.Index(index).String()
		name := strings.ToUpper(strings.TrimSpace(rawName))
		if name == "" {
			return nil, fmt.Errorf("%s contains an empty function name", path)
		}

		if _, duplicate := names[name]; duplicate {
			return nil, fmt.Errorf("duplicate function name %q in %s", name, path)
		}
		names[name] = struct{}{}

		callback := input.Get(rawName)
		if callback.Type() != js.TypeFunction {
			return nil, fmt.Errorf("%s[%q] must be callable", path, rawName)
		}

		functions = append(functions, jsFunction{name: name, callback: callback})
	}

	return functions, nil
}

func parseNamespace(input js.Value, path string) ([]string, error) {
	if input.Type() == js.TypeUndefined {
		return nil, nil
	}

	if input.Type() != js.TypeString {
		return nil, fmt.Errorf("%s must be a string", path)
	}

	segments := strings.Split(input.String(), runtime.NamespaceSeparator)
	for _, segment := range segments {
		if !isFQLIdentifier(segment) {
			return nil, fmt.Errorf(
				"%s must contain valid FQL identifier segments separated by %q",
				path,
				runtime.NamespaceSeparator,
			)
		}
	}

	return segments, nil
}

func isFQLIdentifier(value string) bool {
	if len(value) == 0 || !isASCIILetter(value[0]) {
		return false
	}

	for index := 1; index < len(value); index++ {
		char := value[index]
		if !isASCIILetter(char) && !isASCIIDigit(char) && char != '_' {
			return false
		}
	}

	return true
}

func isASCIILetter(char byte) bool {
	return char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z'
}

func isASCIIDigit(char byte) bool {
	return char >= '0' && char <= '9'
}

func parseLifecycle(input js.Value, path string) (map[string]js.Value, error) {
	if input.Type() == js.TypeUndefined || input.Type() == js.TypeNull {
		return nil, nil
	}

	if !isPlainJSObject(input) {
		return nil, fmt.Errorf("%s must be a plain JavaScript object", path)
	}

	object := js.Global().Get("Object")
	keys := object.Call("keys", input)
	callbacks := make(map[string]js.Value, keys.Length())

	for index := 0; index < keys.Length(); index++ {
		name := keys.Index(index).String()
		if _, supported := lifecycleNames[name]; !supported {
			return nil, fmt.Errorf("%s.%s is not a supported lifecycle callback", path, name)
		}

		callback := input.Get(name)
		if callback.Type() != js.TypeFunction {
			return nil, fmt.Errorf("%s.%s must be callable", path, name)
		}

		callbacks[name] = callback
	}

	return callbacks, nil
}

func (m *jsModule) Name() string {
	if m == nil {
		return ""
	}

	return m.name
}

func (m *jsModule) Register(bootstrap module.Bootstrap) error {
	if m == nil {
		return errors.New("module cannot be nil")
	}

	var registration runtime.Namespace = bootstrap.Host().Library()
	for _, segment := range m.namespace {
		registration = registration.Namespace(segment)
	}

	definitions := registration.Function().Var()
	for _, definition := range m.functions {
		callback := definition.callback
		definitions.Add(definition.name, func(ctx context.Context, args ...runtime.Value) (runtime.Value, error) {
			return invokeRuntimeFunction(ctx, m.registry, callback, args...)
		})
	}

	hooks := bootstrap.Hooks()
	if m.hasLifecycle("onInit") {
		hooks.Engine().OnInit(func() error {
			return m.invokeLifecycle(context.Background(), "onInit")
		})
	}
	if m.hasLifecycle("onClose") {
		hooks.Engine().OnClose(func() error {
			return m.invokeLifecycle(context.Background(), "onClose")
		})
	}
	if m.hasLifecycle("beforeCompile") {
		hooks.Plan().BeforeCompile(func(ctx context.Context) error {
			return m.invokeLifecycle(ctx, "beforeCompile", compileEvent(ctx, nil))
		})
	}
	if m.hasLifecycle("afterCompile") {
		hooks.Plan().AfterCompile(func(ctx context.Context, compileErr error) error {
			return m.invokeLifecycle(ctx, "afterCompile", compileEvent(ctx, compileErr))
		})
	}
	if m.hasLifecycle("onPlanClose") {
		hooks.Plan().OnClose(func() error {
			return m.invokeLifecycle(context.Background(), "onPlanClose", emptyEvent())
		})
	}
	if m.hasLifecycle("beforeRun") {
		hooks.Session().BeforeRun(func(ctx context.Context) (context.Context, error) {
			return ctx, m.invokeLifecycle(ctx, "beforeRun", emptyEvent())
		})
	}
	if m.hasLifecycle("afterRun") {
		hooks.Session().AfterRun(func(ctx context.Context, runErr error) error {
			return m.invokeLifecycle(ctx, "afterRun", resultEvent(runErr))
		})
	}
	if m.hasLifecycle("onSessionClose") {
		hooks.Session().OnClose(func() error {
			return m.invokeLifecycle(context.Background(), "onSessionClose", emptyEvent())
		})
	}

	return nil
}

func (m *jsModule) hasLifecycle(name string) bool {
	_, exists := m.lifecycle[name]
	return exists
}

func (m *jsModule) invokeLifecycle(ctx context.Context, phase string, args ...any) error {
	callback, exists := m.lifecycle[phase]
	if !exists {
		return nil
	}

	if _, err := invokeJS(ctx, callback, args...); err != nil {
		return fmt.Errorf("module %q lifecycle %s: %w", m.name, phase, err)
	}

	return nil
}
