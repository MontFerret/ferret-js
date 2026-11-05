//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"syscall/js"

	core "github.com/MontFerret/ferret/v2"
)

const abortCode = "ABORTED"

func ok(data any) any {
	out := map[string]any{"ok": true}

	if data != nil {
		out["data"] = data
	}

	return out
}

func failure(err error) any {
	if err == nil {
		err = errors.New("unexpected error")
	}

	return map[string]any{"ok": false, "error": errorValue(err)}
}

func errorValue(err error) any {
	if err == nil {
		return nil
	}
	code := ""
	switch {
	case errors.Is(err, core.ErrOutputClosed):
		code = "OUTPUT_CLOSED"
	case errors.Is(err, core.ErrOutputInUse):
		code = "OUTPUT_IN_USE"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = abortCode
	}
	return map[string]any{"message": err.Error(), "code": code}
}

func invoke(callback js.Value, result any) {
	callback.Invoke(js.ValueOf(result))
}
