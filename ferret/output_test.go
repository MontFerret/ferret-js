//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"sync"
	"syscall/js"
	"testing"

	core "github.com/MontFerret/ferret/v2"
)

type fixtureOutput struct {
	content  *core.Content
	terminal error
	cleanup  error
	closes   int
}

func (o *fixtureOutput) Metadata() core.Metadata {
	if o.content != nil {
		return o.content.Metadata
	}
	return core.Metadata{}
}
func (o *fixtureOutput) Collect(context.Context) (*core.Content, error) { return o.content, o.terminal }
func (o *fixtureOutput) Consume(ctx context.Context, consumer core.Consumer) error {
	var err error
	if o.content != nil {
		err = consumer(ctx, o.content.Data)
	}
	return errors.Join(o.terminal, err)
}
func (o *fixtureOutput) Close() error { o.closes++; return o.cleanup }

func TestOutputCollectionRepresentations(t *testing.T) {
	for _, name := range []string{"absent", "empty", "partial"} {
		t.Run(name, func(t *testing.T) {
			native := &fixtureOutput{}
			if name != "absent" {
				native.content = &core.Content{Metadata: core.Metadata{ContentType: "application/json", LengthKnown: true}}
			}
			if name == "partial" {
				native.content.Data = []byte("{")
				native.content.Metadata.Length = 2
				native.terminal = errors.New("incomplete payload")
				native.cleanup = errors.New("cleanup failed")
			}
			bridge := NewBridge(Version{}, func() {})
			cleaned := 0
			bridge.outputs["test"] = &outputHandle{output: native, ctx: context.Background(), cleanup: sync.OnceFunc(func() { cleaned++ })}
			results := make(chan js.Value, 1)
			callback := js.FuncOf(func(_ js.Value, args []js.Value) any { results <- args[0]; return nil })
			defer callback.Release()
			accepted := bridge.collectOutput(js.Undefined(), []js.Value{js.ValueOf("test"), js.Undefined(), callback.Value})
			if !accepted.(map[string]any)["ok"].(bool) {
				t.Fatal(accepted)
			}
			result := (<-results).Get("data")
			content := result.Get("content")
			if name == "absent" {
				if !content.IsNull() {
					t.Fatal("absent content became present")
				}
			} else {
				if content.IsNull() {
					t.Fatal("present content became absent")
				}
				if content.Get("data").Length() != len(native.content.Data) {
					t.Fatal("incorrect bytes")
				}
				if content.Get("metadata").Get("length").Int() != int(native.content.Metadata.Length) {
					t.Fatal("metadata changed")
				}
			}
			if name == "partial" {
				if result.Get("error").Get("message").String() != "incomplete payload" {
					t.Fatal("terminal error lost")
				}
				if result.Get("closeError").Get("message").String() != "cleanup failed" {
					t.Fatal("cleanup error lost")
				}
			}
			if cleaned != 1 || native.closes != 1 || len(bridge.outputs) != 0 {
				t.Fatal("output not finalized exactly once")
			}
		})
	}
}

func TestOutputConsumersReceiveOwnedBytes(t *testing.T) {
	for _, name := range []string{"absent", "empty", "bytes"} {
		t.Run(name, func(t *testing.T) {
			native := &fixtureOutput{}
			if name != "absent" {
				native.content = &core.Content{}
			}
			if name == "bytes" {
				native.content.Data = []byte("42")
			}
			bridge := NewBridge(Version{}, func() {})
			bridge.outputs["test"] = &outputHandle{output: native, ctx: context.Background(), cleanup: func() {}}
			calls := 0
			consumer := js.FuncOf(func(_ js.Value, args []js.Value) any {
				calls++
				if args[0].Length() > 0 {
					args[0].SetIndex(0, 0)
				}
				return nil
			})
			defer consumer.Release()
			results := make(chan js.Value, 1)
			callback := js.FuncOf(func(_ js.Value, args []js.Value) any { results <- args[0]; return nil })
			defer callback.Release()
			bridge.consumeOutput(js.Undefined(), []js.Value{js.ValueOf("test"), js.Undefined(), consumer.Value, callback.Value})
			<-results
			expected := 1
			if name == "absent" {
				expected = 0
			}
			if calls != expected {
				t.Fatalf("got %d callbacks, want %d", calls, expected)
			}
			if name == "bytes" && string(native.content.Data) != "42" {
				t.Fatal("JavaScript mutated borrowed native bytes")
			}
		})
	}
}
