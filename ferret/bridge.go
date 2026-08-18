//go:build js && wasm

package ferret

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"syscall/js"

	core "github.com/MontFerret/ferret/v2"
	"github.com/MontFerret/ferret/v2/pkg/module"
	ferretnet "github.com/MontFerret/ferret/v2/pkg/net"
	"github.com/MontFerret/ferret/v2/pkg/source"
)

type (
	planHandle struct {
		plan                    *core.Plan
		sessions                map[string]*sessionHandle
		id                      string
		pendingSessionCreations int
		closing                 bool
		closed                  bool
	}

	sessionHandle struct {
		session *core.Session
		id      string
		planID  string
		running bool
		closing bool
		closed  bool
	}

	Bridge struct {
		mu           sync.Mutex
		engine       *core.Engine
		network      ferretnet.Network
		plans        map[string]*planHandle
		sessions     map[string]*sessionHandle
		methods      []js.Func
		version      Version
		registry     *hostRegistry
		nextID       atomic.Uint64
		shutdown     func()
		closing      bool
		closed       bool
		initializing bool
		compiling    int
	}
)

func NewBridge(version Version, shutdown func()) *Bridge {
	return &Bridge{
		plans:    make(map[string]*planHandle),
		sessions: make(map[string]*sessionHandle),
		version:  version,
		shutdown: sync.OnceFunc(shutdown),
		registry: newHostRegistry(),
	}
}

func (b *Bridge) JSValue() js.Value {
	object := js.Global().Get("Object").New()
	b.setMethod(object, "initialize", b.initialize)
	b.setMethod(object, "version", b.getVersion)
	b.setMethod(object, "compile", b.compile)
	b.setMethod(object, "createSession", b.createSession)
	b.setMethod(object, "runSession", b.runSession)
	b.setMethod(object, "closeSession", b.closeSession)
	b.setMethod(object, "closePlan", b.closePlan)
	b.setMethod(object, "closeEngine", b.closeEngine)
	b.setMethod(object, "shutdown", b.shutdownRuntime)

	return object
}

func (b *Bridge) setMethod(object js.Value, name string, method func(js.Value, []js.Value) any) {
	fn := js.FuncOf(method)
	b.methods = append(b.methods, fn)
	object.Set(name, fn)
}

func (b *Bridge) Release() {
	for _, method := range b.methods {
		method.Release()
	}

	b.methods = nil
}

func (b *Bridge) initialize(_ js.Value, args []js.Value) any {
	if len(args) < 5 {
		return failure(errors.New("functions, modules, HTTP settings, transport, and callback are required"))
	}

	callback := args[4]
	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	registered, err := parseModuleDefinitions(b.registry, args[0], args[1])
	if err != nil {
		return failure(err)
	}

	if args[2].Type() != js.TypeBoolean {
		return failure(errors.New("http.allowLocalhost must be a boolean"))
	}

	b.mu.Lock()
	if b.engine != nil || b.initializing {
		b.mu.Unlock()
		return failure(errors.New("engine is already initialized"))
	}

	if b.closed || b.closing {
		b.mu.Unlock()
		return failure(errors.New("engine is closed"))
	}

	b.initializing = true
	b.mu.Unlock()

	allowLocalhost := args[2].Bool()
	transport := args[3]

	go func() {
		result := b.initializeEngine(registered, allowLocalhost, transport)
		invoke(callback, result)
	}()

	return ok(nil)
}

func (b *Bridge) initializeEngine(modules []module.Module, allowLocalhost bool, transport js.Value) any {
	client, err := newHostHTTPClient(allowLocalhost, transport)
	if err != nil {
		b.finishInitialization()
		return failure(fmt.Errorf("initialize HTTP client: %w", err))
	}

	network, err := ferretnet.New(ferretnet.WithHTTPClient(client))
	if err != nil {
		client.CloseIdleConnections()
		b.finishInitialization()

		return failure(fmt.Errorf("initialize network: %w", err))
	}

	options := []core.Option{core.WithNetwork(network)}
	if len(modules) > 0 {
		options = append(options, core.WithModules(modules...))
	}

	engine, err := core.New(options...)
	if err != nil {
		ferretnet.CloseIdleNetworkConnections(network)
		b.finishInitialization()

		return failure(fmt.Errorf("initialize engine: %w", err))
	}

	b.mu.Lock()
	b.initializing = false
	if b.closed || b.closing {
		b.mu.Unlock()
		_ = engine.Close()
		ferretnet.CloseIdleNetworkConnections(network)

		return failure(errors.New("engine is closed"))
	}
	b.engine = engine
	b.network = network
	b.mu.Unlock()

	return ok(nil)
}

func (b *Bridge) finishInitialization() {
	b.mu.Lock()
	b.initializing = false
	b.mu.Unlock()
}

func (b *Bridge) getVersion(_ js.Value, _ []js.Value) any {
	return ok(map[string]any{
		"self":   b.version.Self,
		"ferret": b.version.Ferret,
	})
}

func (b *Bridge) compile(_ js.Value, args []js.Value) any {
	if len(args) < 4 {
		return failure(errors.New("source name, text, signal, and callback are required"))
	}

	name := args[0].String()
	text := args[1].String()
	signal := args[2]
	callback := args[3]

	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	b.mu.Lock()
	if b.closed || b.closing || b.engine == nil {
		b.mu.Unlock()
		return failure(errors.New("engine is closed"))
	}
	engine := b.engine
	b.compiling++
	b.mu.Unlock()

	go func() {
		result := func() any {
			ctx, cleanup, err := contextFromSignal(signal)
			if err != nil {
				return failure(err)
			}

			defer cleanup()

			if err := ctx.Err(); err != nil {
				return failure(err)
			}

			ctx = withCompileMetadata(ctx, name, text)

			plan, err := engine.Compile(ctx, source.New(name, text))
			if err != nil {
				return failure(fmt.Errorf("compile query: %w", err))
			}

			if err := ctx.Err(); err != nil {
				_ = plan.Close()
				return failure(err)
			}

			id := b.newID("plan")
			params := plan.Params()
			paramValues := make([]any, len(params))

			for index, param := range params {
				paramValues[index] = param
			}

			b.mu.Lock()
			if b.closed {
				b.mu.Unlock()
				_ = plan.Close()
				return failure(errors.New("engine is closed"))
			}
			b.plans[id] = &planHandle{id: id, plan: plan, sessions: make(map[string]*sessionHandle)}
			b.mu.Unlock()

			return ok(map[string]any{"id": id, "params": paramValues})
		}()

		b.mu.Lock()
		b.compiling--
		b.mu.Unlock()

		invoke(callback, result)
	}()

	return ok(nil)
}

func (b *Bridge) createSession(_ js.Value, args []js.Value) any {
	if len(args) < 4 {
		return failure(errors.New("plan id, params, signal, and callback are required"))
	}

	planID := args[0].String()
	params := args[1]
	signal := args[2]
	callback := args[3]

	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	parsed, err := jsParams(b.registry, params)
	if err != nil {
		return failure(fmt.Errorf("convert params: %w", err))
	}

	b.mu.Lock()
	handle, exists := b.plans[planID]

	if !exists || handle.closed || handle.closing || b.closed || b.closing {
		b.mu.Unlock()

		return failure(errors.New("plan is closed"))
	}

	plan := handle.plan
	handle.pendingSessionCreations++
	b.mu.Unlock()

	go func() {
		result := func() any {
			ctx, cleanup, err := contextFromSignal(signal)
			if err != nil {
				return failure(err)
			}

			defer cleanup()

			if err := ctx.Err(); err != nil {
				return failure(err)
			}

			options := make([]core.SessionOption, 0, 1)
			if len(parsed) > 0 {
				options = append(options, core.WithSessionParams(parsed))
			}

			session, err := plan.NewSession(ctx, options...)
			if err != nil {
				return failure(fmt.Errorf("create session: %w", err))
			}

			if err := ctx.Err(); err != nil {
				_ = session.Close()
				return failure(err)
			}

			id := b.newID("session")
			sessionHandle := &sessionHandle{id: id, session: session, planID: planID}

			b.mu.Lock()
			handle, exists = b.plans[planID]
			if !exists || handle.closed || b.closed {
				b.mu.Unlock()
				_ = session.Close()
				return failure(errors.New("plan is closed"))
			}
			handle.sessions[id] = sessionHandle
			b.sessions[id] = sessionHandle
			b.mu.Unlock()

			return ok(id)
		}()

		b.mu.Lock()
		if current, found := b.plans[planID]; found {
			current.pendingSessionCreations--
		}
		b.mu.Unlock()

		invoke(callback, result)
	}()

	return ok(nil)
}

func (b *Bridge) runSession(_ js.Value, args []js.Value) any {
	if len(args) < 3 {
		return failure(errors.New("session id, signal, and callback are required"))
	}

	id := args[0].String()
	signal := args[1]
	callback := args[2]

	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	b.mu.Lock()
	handle, exists := b.sessions[id]
	if !exists || handle.closed || handle.closing || b.closed || b.closing {
		b.mu.Unlock()
		return failure(errors.New("session is closed"))
	}

	if handle.running {
		b.mu.Unlock()
		return failure(errors.New("session is already running"))
	}

	handle.running = true
	session := handle.session
	b.mu.Unlock()

	go func() {
		result := func() any {
			ctx, cleanup, err := contextFromSignal(signal)
			if err != nil {
				return failure(err)
			}

			defer cleanup()

			output, runErr := session.Run(ctx)
			if runErr != nil {
				return failure(fmt.Errorf("run session: %w", runErr))
			}

			return ok(string(output.Content))
		}()

		b.finishRun(id)
		invoke(callback, result)
	}()

	return ok(nil)
}

func (b *Bridge) closeSession(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return failure(errors.New("session id and callback are required"))
	}

	callback := args[1]
	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	handle, err := b.beginSessionClose(args[0].String(), false)
	if err != nil {
		return failure(err)
	}

	go func() {
		invoke(callback, resultFromError(b.finishSessionClose(handle)))
	}()

	return ok(nil)
}

func (b *Bridge) beginSessionClose(id string, internal bool) (*sessionHandle, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !internal && b.closing {
		return nil, errors.New("engine is closing")
	}

	handle, exists := b.sessions[id]
	if !exists || handle.closed {
		return nil, nil
	}

	if handle.closing {
		return nil, errors.New("session is closing")
	}

	if handle.running {
		return nil, errors.New("cannot close a running session")
	}

	if !internal {
		if plan, found := b.plans[handle.planID]; found && plan.closing {
			return nil, errors.New("plan is closing")
		}
	}

	handle.closing = true
	return handle, nil
}

func (b *Bridge) finishSessionClose(handle *sessionHandle) error {
	if handle == nil {
		return nil
	}

	closeErr := handle.session.Close()

	b.mu.Lock()
	handle.closing = false
	handle.closed = true
	delete(b.sessions, handle.id)

	if plan, found := b.plans[handle.planID]; found {
		delete(plan.sessions, handle.id)
	}
	b.mu.Unlock()

	return closeErr
}

func (b *Bridge) closePlan(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return failure(errors.New("plan id and callback are required"))
	}

	callback := args[1]
	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	handle, sessionIDs, err := b.beginPlanClose(args[0].String(), false)
	if err != nil {
		return failure(err)
	}

	go func() {
		invoke(callback, resultFromError(b.finishPlanClose(handle, sessionIDs)))
	}()

	return ok(nil)
}

func (b *Bridge) beginPlanClose(id string, internal bool) (*planHandle, []string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !internal && b.closing {
		return nil, nil, errors.New("engine is closing")
	}

	handle, exists := b.plans[id]
	if !exists || handle.closed {
		return nil, nil, nil
	}

	if handle.closing {
		return nil, nil, errors.New("plan is closing")
	}

	if handle.pendingSessionCreations > 0 {
		return nil, nil, errors.New("cannot close a plan while creating a session")
	}

	for _, session := range handle.sessions {
		if session.running {
			return nil, nil, errors.New("cannot close a plan with a running session")
		}
		if session.closing {
			return nil, nil, errors.New("cannot close a plan with a closing session")
		}
	}

	sessionIDs := make([]string, 0, len(handle.sessions))
	for sessionID := range handle.sessions {
		sessionIDs = append(sessionIDs, sessionID)
	}

	handle.closing = true
	return handle, sessionIDs, nil
}

func (b *Bridge) finishPlanClose(handle *planHandle, sessionIDs []string) error {
	if handle == nil {
		return nil
	}

	var closeErr error
	for _, sessionID := range sessionIDs {
		session, err := b.beginSessionClose(sessionID, true)
		if err != nil {
			closeErr = errors.Join(closeErr, err)
			continue
		}
		closeErr = errors.Join(closeErr, b.finishSessionClose(session))
	}

	closeErr = errors.Join(closeErr, handle.plan.Close())

	b.mu.Lock()
	handle.closing = false
	handle.closed = true
	delete(b.plans, handle.id)
	b.mu.Unlock()

	return closeErr
}

func (b *Bridge) closeEngine(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return failure(errors.New("callback is required"))
	}

	callback := args[0]
	if callback.Type() != js.TypeFunction {
		return failure(errors.New("callback must be callable"))
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		go invoke(callback, ok(nil))
		return ok(nil)
	}
	if b.initializing {
		b.mu.Unlock()
		return failure(errors.New("cannot close an engine while initializing"))
	}
	if b.closing {
		b.mu.Unlock()
		return failure(errors.New("engine is closing"))
	}

	if b.compiling > 0 {
		b.mu.Unlock()
		return failure(errors.New("cannot close an engine while compiling a plan"))
	}

	for _, plan := range b.plans {
		if plan.pendingSessionCreations > 0 {
			b.mu.Unlock()
			return failure(errors.New("cannot close an engine while creating a session"))
		}
		if plan.closing {
			b.mu.Unlock()
			return failure(errors.New("cannot close an engine with a closing plan"))
		}
	}

	for _, session := range b.sessions {
		if session.running {
			b.mu.Unlock()
			return failure(errors.New("cannot close an engine with a running session"))
		}
		if session.closing {
			b.mu.Unlock()
			return failure(errors.New("cannot close an engine with a closing session"))
		}
	}

	planIDs := make([]string, 0, len(b.plans))
	for id := range b.plans {
		planIDs = append(planIDs, id)
	}

	engine := b.engine
	network := b.network
	b.closing = true
	b.mu.Unlock()

	go func() {
		var closeErr error
		for _, id := range planIDs {
			plan, sessionIDs, err := b.beginPlanClose(id, true)
			if err != nil {
				closeErr = errors.Join(closeErr, err)
				continue
			}
			closeErr = errors.Join(closeErr, b.finishPlanClose(plan, sessionIDs))
		}

		if engine != nil {
			closeErr = errors.Join(closeErr, engine.Close())
		}

		ferretnet.CloseIdleNetworkConnections(network)

		b.mu.Lock()
		b.closing = false
		b.closed = true
		b.engine = nil
		b.network = nil
		clear(b.plans)
		clear(b.sessions)
		b.mu.Unlock()
		b.registry.close()

		invoke(callback, resultFromError(closeErr))
	}()

	return ok(nil)
}

func (b *Bridge) shutdownRuntime(_ js.Value, _ []js.Value) any {
	b.mu.Lock()
	closed := b.closed
	b.mu.Unlock()

	if !closed {
		return failure(errors.New("engine must be closed before shutdown"))
	}

	go b.shutdown()

	return ok(nil)
}

func (b *Bridge) newID(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, b.nextID.Add(1))
}

func (b *Bridge) finishRun(id string) {
	b.mu.Lock()

	if handle, exists := b.sessions[id]; exists {
		handle.running = false
	}

	b.mu.Unlock()
}
