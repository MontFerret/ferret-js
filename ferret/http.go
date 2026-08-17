//go:build js && wasm

package ferret

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	stdhttp "net/http"
	"sort"
	"strings"
	"syscall/js"

	ferrethttp "github.com/MontFerret/ferret/v2/pkg/net/http"
)

func readHostRequestBody(req *stdhttp.Request) ([]byte, error) {
	if req.Body == nil || req.Body == stdhttp.NoBody {
		return nil, nil
	}

	defer req.Body.Close()
	body, err := io.ReadAll(io.LimitReader(req.Body, hostHTTPMaxRequestSize+1))
	if err != nil {
		return nil, err
	}

	if int64(len(body)) > hostHTTPMaxRequestSize {
		return nil, &ferrethttp.RequestBodyLimitError{
			Size:  int64(len(body)),
			Limit: hostHTTPMaxRequestSize,
		}
	}

	return body, nil
}

func parseHostHTTPResponse(req *stdhttp.Request, value js.Value) (*stdhttp.Response, error) {
	if value.Type() != js.TypeObject {
		return nil, errors.New("HTTP transport returned an invalid response")
	}

	statusCode := value.Get("statusCode")
	status := value.Get("status")
	bodyValue := value.Get("body")
	if statusCode.Type() != js.TypeNumber ||
		status.Type() != js.TypeString ||
		!bodyValue.InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, errors.New("HTTP transport returned an invalid response")
	}

	if value.Get("bodySizeExceeded").Type() == js.TypeBoolean &&
		value.Get("bodySizeExceeded").Bool() {
		observed := hostHTTPMaxResponseSize + 1

		if raw := value.Get("observedBodySize"); raw.Type() == js.TypeNumber {
			observed = max(int64(raw.Float()), observed)
		}

		return nil, &ferrethttp.ResponseBodyLimitError{
			Size:  observed,
			Limit: hostHTTPMaxResponseSize,
		}
	}

	body := make([]byte, bodyValue.Get("byteLength").Int())

	if copied := js.CopyBytesToGo(body, bodyValue); copied != len(body) {
		return nil, errors.New("HTTP transport returned a truncated response body")
	}

	if int64(len(body)) > hostHTTPMaxResponseSize {
		return nil, &ferrethttp.ResponseBodyLimitError{
			Size:  int64(len(body)),
			Limit: hostHTTPMaxResponseSize,
		}
	}

	headers, err := hostHeadersFromJS(value.Get("headers"))
	if err != nil {
		return nil, err
	}

	return &stdhttp.Response{
		StatusCode:    statusCode.Int(),
		Status:        status.String(),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        headers,
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
		Request:       req,
	}, nil
}

func callJSMethod(object js.Value, method string, args ...any) (value js.Value, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("JavaScript HTTP transport panicked: %v", recovered)
		}
	}()

	value = object.Call(method, args...)
	if value.Type() != js.TypeObject || value.Get("then").Type() != js.TypeFunction {
		return js.Undefined(), errors.New("HTTP transport request() must return a Promise")
	}

	return value, nil
}

func awaitHostPromise(
	ctx context.Context,
	promise js.Value,
	onCancel func(),
) (js.Value, error) {
	result := make(chan hostPromiseResult, 1)
	var success js.Func
	var rejected js.Func

	release := func() {
		go func() {
			success.Release()
			rejected.Release()
		}()
	}

	success = js.FuncOf(func(_ js.Value, values []js.Value) any {
		value := js.Undefined()
		if len(values) > 0 {
			value = values[0]
		}

		select {
		case result <- hostPromiseResult{value: value}:
		default:
		}
		release()

		return nil
	})

	rejected = js.FuncOf(func(_ js.Value, values []js.Value) any {
		message := "JavaScript HTTP transport rejected"
		if len(values) > 0 {
			message = js.Global().Get("String").Invoke(values[0]).String()
		}

		select {
		case result <- hostPromiseResult{err: errors.New(message)}:
		default:
		}
		release()

		return nil
	})

	promise.Call("then", success, rejected)

	select {
	case <-ctx.Done():
		onCancel()
		<-result
		return js.Undefined(), ctx.Err()
	case settled := <-result:
		if ctx.Err() != nil {
			return js.Undefined(), ctx.Err()
		}
		return settled.value, settled.err
	}
}

func newHostHTTPRequest(
	ctx context.Context,
	req *ferrethttp.Request,
) (*stdhttp.Request, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = stdhttp.MethodGet
	}

	if !isValidHTTPMethod(method) {
		return nil, &ferrethttp.InvalidMethodError{Method: req.Method}
	}

	rawURL := strings.TrimSpace(req.URL)
	stdReq, err := stdhttp.NewRequestWithContext(
		ctx,
		method,
		rawURL,
		bytes.NewReader(req.Body),
	)

	if err != nil {
		return nil, &ferrethttp.URLParseError{Err: err}
	}

	if rawURL == "" {
		return nil, &ferrethttp.URLValidationError{Field: "url", Reason: "is required"}
	}

	if stdReq.URL.Scheme == "" {
		return nil, &ferrethttp.URLValidationError{Field: "scheme", Reason: "is required"}
	}

	if stdReq.URL.Host == "" {
		return nil, &ferrethttp.URLValidationError{Field: "host", Reason: "is required"}
	}

	stdReq.URL.Scheme = strings.ToLower(stdReq.URL.Scheme)
	stdReq.URL.Host = strings.ToLower(stdReq.URL.Host)
	stdReq.Host = stdReq.URL.Host
	stdReq.Header = copyHostHTTPHeaders(req.Headers)

	return stdReq, nil
}

func newHostHTTPResponse(res *stdhttp.Response) (*ferrethttp.Response, error) {
	if res == nil {
		return nil, ferrethttp.ErrNilResponse
	}

	if res.Body == nil {
		return &ferrethttp.Response{
			StatusCode: res.StatusCode,
			Status:     res.Status,
			Headers:    copyFerretHTTPHeaders(res.Header),
		}, nil
	}

	defer res.Body.Close()

	limit := saturatedIncrement(hostHTTPMaxResponseSize)
	body, err := io.ReadAll(io.LimitReader(res.Body, limit))

	if int64(len(body)) > hostHTTPMaxResponseSize {
		return nil, &ferrethttp.ResponseBodyLimitError{
			Size:  limit,
			Limit: hostHTTPMaxResponseSize,
		}
	}

	if err != nil {
		return nil, err
	}

	return &ferrethttp.Response{
		StatusCode: res.StatusCode,
		Status:     res.Status,
		Headers:    copyFerretHTTPHeaders(res.Header),
		Body:       body,
	}, nil
}

func copyHostHTTPHeaders(src ferrethttp.Headers) stdhttp.Header {
	dst := make(stdhttp.Header, len(src))
	keys := make([]string, 0, len(src))

	for key := range src {
		keys = append(keys, key)
	}

	sort.Strings(keys)

	for _, key := range keys {
		canonicalKey := stdhttp.CanonicalHeaderKey(key)
		dst[canonicalKey] = append(dst[canonicalKey], src[key]...)
	}

	return dst
}

func copyFerretHTTPHeaders(src stdhttp.Header) ferrethttp.Headers {
	if len(src) == 0 {
		return nil
	}

	dst := make(ferrethttp.Headers, len(src))

	for key, values := range src {
		dst[key] = append([]string(nil), values...)
	}

	return dst
}

func hostHeadersToJS(src stdhttp.Header) js.Value {
	object := js.Global().Get("Object").New()

	for name, values := range src {
		array := js.Global().Get("Array").New(len(values))
		for index, value := range values {
			array.SetIndex(index, value)
		}
		object.Set(name, array)
	}

	return object
}

func hostHeadersFromJS(value js.Value) (stdhttp.Header, error) {
	if value.Type() != js.TypeObject {
		return nil, errors.New("HTTP transport returned invalid response headers")
	}

	keys := js.Global().Get("Object").Call("keys", value)
	headers := make(stdhttp.Header, keys.Length())

	for index := 0; index < keys.Length(); index++ {
		name := keys.Index(index).String()
		values := value.Get(name)
		if !js.Global().Get("Array").Call("isArray", values).Bool() {
			return nil, errors.New("HTTP transport returned invalid response headers")
		}

		items := make([]string, values.Length())
		for itemIndex := range items {
			if values.Index(itemIndex).Type() != js.TypeString {
				return nil, errors.New("HTTP transport returned invalid response headers")
			}
			items[itemIndex] = values.Index(itemIndex).String()
		}
		headers[name] = items
	}

	return headers, nil
}

func bytesToJS(value []byte) js.Value {
	array := js.Global().Get("Uint8Array").New(len(value))
	js.CopyBytesToJS(array, value)
	return array
}

func isValidHTTPMethod(method string) bool {
	if method == "" {
		return false
	}

	for _, character := range method {
		if character <= ' ' || character >= 127 ||
			strings.ContainsRune("()<>@,;:\\\"/[]?={}", character) {
			return false
		}
	}

	return true
}

func saturatedIncrement(value int64) int64 {
	if value == math.MaxInt64 {
		return math.MaxInt64
	}

	return value + 1
}
