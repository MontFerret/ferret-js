//go:build js && wasm

package ferret

import (
	"context"
	"errors"
	"fmt"
	"net"
	stdhttp "net/http"
	"net/netip"
	"strings"
	"sync"
	"syscall/js"
	"time"

	ferrethttp "github.com/MontFerret/ferret/v2/pkg/net/http"
)

// These mirror Ferret's secure HTTP defaults. Go owns the limits and passes
// them to the host transport so response data is bounded before crossing the
// JavaScript/WASM boundary.
const (
	hostHTTPTimeout               = 30 * time.Second
	hostHTTPMaxRequestSize        = int64(16 << 20)
	hostHTTPMaxResponseSize       = int64(16 << 20)
	hostHTTPMaxResponseHeaderSize = int64(1 << 20)
	hostHTTPMaxRedirects          = 10
)

type (
	hostHTTPClient struct {
		policy    *ferrethttp.Policy
		client    stdhttp.Client
		transport *hostRoundTripper
	}

	hostRoundTripper struct {
		policy        *ferrethttp.Policy
		addressPolicy *ferrethttp.Policy
		transport     js.Value
		closeOnce     sync.Once
	}

	hostPromiseResult struct {
		value js.Value
		err   error
	}
)

func newHostHTTPClient(allowLocalhost bool, transport js.Value) (*hostHTTPClient, error) {
	if transport.Type() != js.TypeObject ||
		transport.Get("request").Type() != js.TypeFunction ||
		transport.Get("close").Type() != js.TypeFunction {

		return nil, errors.New("HTTP transport must expose request() and close()")
	}

	policy, err := ferrethttp.NewPolicy(
		ferrethttp.WithAllowLocalhost(allowLocalhost),
	)

	if err != nil {
		return nil, err
	}

	// Host allow/deny rules belong to the request policy. DNS answers only need
	// address-class validation so Node can reject mixed or rebinding-prone sets.
	addressPolicy, err := ferrethttp.NewPolicy(
		ferrethttp.WithAllowLocalhost(allowLocalhost),
	)

	if err != nil {
		return nil, err
	}

	roundTripper := &hostRoundTripper{
		policy:        policy,
		addressPolicy: addressPolicy,
		transport:     transport,
	}
	client := &hostHTTPClient{
		policy:    policy,
		transport: roundTripper,
	}
	client.client.Transport = roundTripper
	client.client.Timeout = hostHTTPTimeout
	client.client.CheckRedirect = client.checkRedirect

	return client, nil
}

func (c *hostHTTPClient) Do(
	ctx context.Context,
	req *ferrethttp.Request,
) (*ferrethttp.Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	if req == nil {
		return nil, ferrethttp.ErrNilRequest
	}

	stdReq, err := newHostHTTPRequest(ctx, req)
	if err != nil {
		return nil, err
	}

	if err := c.policy.Prepare(stdReq); err != nil {
		return nil, err
	}

	res, err := c.client.Do(stdReq)
	if err != nil {
		var policyErr *ferrethttp.PolicyError

		if errors.As(err, &policyErr) {
			return nil, policyErr
		}

		return nil, err
	}

	return newHostHTTPResponse(res)
}

func (c *hostHTTPClient) checkRedirect(req *stdhttp.Request, via []*stdhttp.Request) error {
	if len(via) > hostHTTPMaxRedirects {
		return &ferrethttp.RedirectLimitError{Limit: hostHTTPMaxRedirects}
	}

	return c.policy.Prepare(req)
}

func (c *hostHTTPClient) CloseIdleConnections() {
	c.client.CloseIdleConnections()
}

func (t *hostRoundTripper) RoundTrip(req *stdhttp.Request) (*stdhttp.Response, error) {
	if req == nil {
		return nil, ferrethttp.ErrNilRequest
	}

	if err := t.policy.Prepare(req); err != nil {
		return nil, err
	}

	request, err := t.requestValue(req)
	if err != nil {
		return nil, err
	}

	abortController := js.Global().Get("AbortController").New()
	var addressErr error
	validateAddress := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 || args[0].Type() != js.TypeString {
			addressErr = errors.New("resolved address must be a string")
			return addressErr.Error()
		}

		addressErr = t.validateAddress(args[0].String())
		if addressErr != nil {
			return addressErr.Error()
		}

		return js.Undefined()
	})

	promise, invokeErr := callJSMethod(
		t.transport,
		"request",
		request,
		abortController.Get("signal"),
		validateAddress,
	)
	if invokeErr != nil {
		validateAddress.Release()
		return nil, invokeErr
	}

	value, err := awaitHostPromise(req.Context(), promise, func() {
		abortController.Call("abort")
	})
	validateAddress.Release()

	if err != nil {
		if addressErr != nil {
			return nil, addressErr
		}

		return nil, err
	}

	return parseHostHTTPResponse(req, value)
}

func (t *hostRoundTripper) CloseIdleConnections() {
	t.closeOnce.Do(func() {
		defer func() {
			_ = recover()
		}()

		t.transport.Call("close")
	})
}

func (t *hostRoundTripper) validateAddress(raw string) error {
	address, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("invalid resolved address %q: %w", raw, err)
	}

	host := net.JoinHostPort(address.String(), "80")
	req, err := stdhttp.NewRequest(stdhttp.MethodGet, "http://"+host+"/", nil)
	if err != nil {
		return err
	}

	return t.addressPolicy.Eval(req)
}

func (t *hostRoundTripper) requestValue(req *stdhttp.Request) (js.Value, error) {
	body, err := readHostRequestBody(req)
	if err != nil {
		return js.Undefined(), err
	}

	object := js.Global().Get("Object").New()
	object.Set("method", req.Method)
	object.Set("url", req.URL.String())
	object.Set("headers", hostHeadersToJS(req.Header))
	object.Set("body", bytesToJS(body))
	object.Set("maxResponseSize", hostHTTPMaxResponseSize)
	object.Set("maxResponseHeaderSize", hostHTTPMaxResponseHeaderSize)

	return object, nil
}
