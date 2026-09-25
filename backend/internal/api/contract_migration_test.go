package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/mandalika/pos-backend/internal/api"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/oapi-codegen/nullable"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestApprovedNullableFields(t *testing.T) {
	for _, v := range []struct {
		name, field string
		new         func() any
		value       string
	}{
		{"Transfer.sender", "senderLetterhead", func() any { return &api.Transfer{} }, `{"locationName":"Depot","brandName":"Mändalika","addressLines":["Owned Street"],"phone":null}`},
		{"Transfer.receiver", "receiverLetterhead", func() any { return &api.Transfer{} }, `{"locationName":"Outlet","brandName":"Mändalika","addressLines":["Owned Street"]}`},
		{"IngredientTransfer.sender", "senderLetterhead", func() any { return &api.IngredientTransfer{} }, `{"locationName":"Depot","brandName":"Mändalika","addressLines":["Owned Street"]}`},
		{"IngredientTransfer.receiver", "receiverLetterhead", func() any { return &api.IngredientTransfer{} }, `{"locationName":"Outlet","brandName":"Mändalika","addressLines":["Owned Street"]}`},
		{"SyncItemResult.transfer", "transfer", func() any { return &api.SyncItemResult{} }, `{"id":"00000000-0000-4000-8000-000000000001","transferNo":"TR-OWNED","status":"completed","items":[],"source":{"kind":"warehouse","id":"00000000-0000-4000-8000-000000000002"},"dest":{"kind":"outlet","id":"00000000-0000-4000-8000-000000000003"},"createdAt":"2026-09-25T01:00:00Z"}`},
	} {
		t.Run(v.name, func(t *testing.T) {
			for _, state := range []string{"absent", "null", "object", "invalid"} {
				t.Run(state, func(t *testing.T) {
					input := "{}"
					if state != "absent" {
						value := v.value
						if state == "null" {
							value = "null"
						}
						if state == "invalid" {
							value = `"invalid-type"`
						}
						input = `{"` + v.field + `":` + value + `}`
					}
					var first []byte
					for i := 0; i < 3; i++ {
						out := v.new()
						err := json.Unmarshal([]byte(input), out)
						if state == "invalid" {
							if err == nil {
								t.Fatal("invalid accepted")
							}
							return
						}
						if err != nil {
							t.Fatal(err)
						}
						b, err := json.Marshal(out)
						if err != nil {
							t.Fatal(err)
						}
						var fields map[string]json.RawMessage
						json.Unmarshal(b, &fields)
						value, ok := fields[v.field]
						if state == "absent" && ok {
							t.Fatal("absence fabricated")
						}
						if state == "null" && (!ok || string(value) != "null") {
							t.Fatal("null lost")
						}
						if state == "object" && (!ok || string(value) == "{}" || string(value) == "null") {
							t.Fatal("object lost")
						}
						if i > 0 && string(first) != string(b) {
							t.Fatal("unstable repeated roundtrip")
						}
						first = b
						input = string(b)
					}
				})
			}
		})
	}
}
func TestNullableConstructorsAndActualSyncPointer(t *testing.T) {
	lh := api.Letterhead{}
	n := nullable.NewNullableWithValue(lh)
	if _, err := n.Get(); err != nil || !n.IsSpecified() || n.IsNull() {
		t.Fatal("constructor")
	}
	n.SetNull()
	if _, err := n.Get(); err == nil || !n.IsNull() {
		t.Fatal("null accessor")
	}
	n.SetUnspecified()
	if _, err := n.Get(); err == nil || n.IsSpecified() {
		t.Fatal("absent accessor")
	}
	tr := nullable.NewNullableWithValue(api.Transfer{})
	if _, err := tr.Get(); err != nil {
		t.Fatal(err)
	}
	f, _ := reflect.TypeOf(syncpkg.ItemResult{}).FieldByName("Transfer")
	if f.Type.Kind() != reflect.Pointer {
		t.Fatal("actual sync result contract changed")
	}
	for _, input := range []string{`{}`, `{"transfer":null}`} {
		var item syncpkg.ItemResult
		if err := json.Unmarshal([]byte(input), &item); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(item)
		var fields map[string]json.RawMessage
		json.Unmarshal(b, &fields)
		if _, ok := fields["transfer"]; ok {
			t.Fatal("actual sync pointer null collapse changed")
		}
	}
}

type optionalStub struct {
	api.StrictServerInterface
	called, nilBody bool
	body            []byte
}

func (s *optionalStub) OpenShift(_ context.Context, r api.OpenShiftRequestObject) (api.OpenShiftResponseObject, error) {
	s.called = true
	s.nilBody = r.Body == nil
	s.body, _ = json.Marshal(r.Body)
	return nil, errors.New("dispatch observation, never business success")
}
func (s *optionalStub) CloseShift(_ context.Context, r api.CloseShiftRequestObject) (api.CloseShiftResponseObject, error) {
	s.called = true
	s.nilBody = r.Body == nil
	s.body, _ = json.Marshal(r.Body)
	return nil, errors.New("dispatch observation, never business success")
}
func (s *optionalStub) CompleteStockCount(_ context.Context, r api.CompleteStockCountRequestObject) (api.CompleteStockCountResponseObject, error) {
	s.called = true
	s.nilBody = r.Body == nil
	s.body, _ = json.Marshal(r.Body)
	return nil, errors.New("dispatch observation, never business success")
}
func (s *optionalStub) Logout(_ context.Context, r api.LogoutRequestObject) (api.LogoutResponseObject, error) {
	s.called = true
	s.nilBody = r.Body == nil
	s.body, _ = json.Marshal(r.Body)
	return nil, errors.New("dispatch observation, never business success")
}
func (s *optionalStub) RestoreRecipeVersion(_ context.Context, r api.RestoreRecipeVersionRequestObject) (api.RestoreRecipeVersionResponseObject, error) {
	s.called = true
	s.nilBody = r.Body == nil
	s.body, _ = json.Marshal(r.Body)
	return nil, errors.New("dispatch observation, never business success")
}
func (s *optionalStub) SignUpload(_ context.Context, r api.SignUploadRequestObject) (api.SignUploadResponseObject, error) {
	s.called = true
	s.nilBody = r.Body == nil
	s.body, _ = json.Marshal(r.Body)
	return nil, errors.New("dispatch observation, never business success")
}

func TestAllApprovedOptionalAdapters(t *testing.T) {
	// Exercise each adapter's real schema, not a common object whose fields may
	// simply be ignored by unrelated body types.
	bodies := map[string][2]string{
		"OpenShift":            {`{"startingCash":0}`, `{"startingCash":25,"outletName":"Owned outlet"}`},
		"CloseShift":           {`{"closingCash":0,"countedByMethod":{}}`, `{"closingCash":25,"countedByMethod":{"cash":25}}`},
		"CompleteStockCount":   {`{"items":[]}`, `{"items":[{"actualQty":0,"difference":0,"frozenQty":0,"productId":"owned","productName":"Owned item","sku":"OWNED","variantSize":"M"}]}`},
		"Logout":               {`{"refresh":""}`, `{"refresh":"synthetic"}`},
		"RestoreRecipeVersion": {`{"expectedCurrentVersionId":"00000000-0000-0000-0000-000000000000"}`, `{"expectedCurrentVersionId":"00000000-0000-4000-8000-000000000001"}`},
		"SignUpload":           {`{"folder":""}`, `{"folder":"owned"}`},
	}
	for _, method := range []string{"OpenShift", "CloseShift", "CompleteStockCount", "Logout", "RestoreRecipeVersion", "SignUpload"} {
		t.Run(method, func(t *testing.T) {
			for _, b := range []struct {
				name, body      string
				called, nilBody bool
			}{{"EOF", "", true, true}, {"whitespace", " \n\t", true, true}, {"object", "{}", true, false}, {"null", "null", true, false}, {"zero", bodies[method][0], true, false}, {"populated", bodies[method][1], true, false}, {"malformed", "{", false, false}} {
				t.Run(b.name, func(t *testing.T) {
					body := b.body
					if b.name == "whitespace" {
						body = " \n\t"
					}
					stub := &optionalStub{}
					handler := api.NewStrictHandler(stub, nil)
					m := reflect.ValueOf(handler).MethodByName(method)
					w := httptest.NewRecorder()
					r := httptest.NewRequest("POST", "/", strings.NewReader(body))
					args := []reflect.Value{reflect.ValueOf(w), reflect.ValueOf(r)}
					for i := 2; i < m.Type().NumIn(); i++ {
						args = append(args, reflect.Zero(m.Type().In(i)))
					}
					m.Call(args)
					if stub.called != b.called || (stub.called && stub.nilBody != b.nilBody) {
						t.Fatalf("dispatch called=%v nil=%v", stub.called, stub.nilBody)
					}
					if b.name == "zero" || b.name == "populated" {
						var want, got any
						if err := json.Unmarshal([]byte(body), &want); err != nil {
							t.Fatal(err)
						}
						if err := json.Unmarshal(stub.body, &got); err != nil {
							t.Fatal(err)
						}
						if !reflect.DeepEqual(want, got) {
							t.Fatalf("decoded body lost fields: want=%s got=%s", body, stub.body)
						}
					}
					if w.Code < 400 {
						t.Fatal("stub result interpreted as business success")
					}
					t.Logf("dispatch=%v nil=%v status=%d body=%s", stub.called, stub.nilBody, w.Code, stub.body)
				})
			}
		})
	}
}
func TestGeneratedResponseEncodingBeforeStatus(t *testing.T) {
	// A real generated JSON response containing an unencodable float. Failure
	// must happen before even the first successful header/status/body write.
	response := api.ReportSummary200JSONResponse{}
	value := reflect.ValueOf(&response).Elem()
	var setFloat func(reflect.Value) bool
	setFloat = func(v reflect.Value) bool {
		if v.Kind() == reflect.Pointer && v.CanSet() {
			v.Set(reflect.New(v.Type().Elem()))
			return setFloat(v.Elem())
		}
		if (v.Kind() == reflect.Float64 || v.Kind() == reflect.Float32) && v.CanSet() {
			v.SetFloat(math.NaN())
			return true
		}
		if v.Kind() == reflect.Struct {
			for i := 0; i < v.NumField(); i++ {
				if setFloat(v.Field(i)) {
					return true
				}
			}
		}
		return false
	}
	if !setFloat(value) {
		t.Fatal("no representative generated numeric field")
	}
	w := &observedWriter{header: http.Header{}}
	if err := response.VisitReportSummaryResponse(w); err == nil {
		t.Fatal("serialization failure missing")
	}
	if w.status != 0 || w.bytes != 0 || len(w.header) != 0 {
		t.Fatal("successful response prefix escaped")
	}
}

type observedWriter struct {
	header        http.Header
	status, bytes int
}

func (w *observedWriter) Header() http.Header         { return w.header }
func (w *observedWriter) WriteHeader(n int)           { w.status = n }
func (w *observedWriter) Write(b []byte) (int, error) { w.bytes += len(b); return len(b), nil }

func TestGeneratedKeyAndNamedTypes(t *testing.T) {
	ctx := context.WithValue(context.Background(), api.BearerAuthScopes, []string{"owned"})
	if got, ok := ctx.Value(api.BearerAuthScopes).([]string); !ok || len(got) != 1 {
		t.Fatal("typed key failed")
	}
	if ctx.Value("bearerAuth.Scopes") != nil {
		t.Fatal("raw string unexpectedly interoperates")
	}
	if reflect.TypeOf(api.StrictHandlerFunc(nil)).Name() != "StrictHandlerFunc" || reflect.TypeOf(api.StrictMiddlewareFunc(nil)).Name() != "StrictMiddlewareFunc" {
		t.Fatal("named types changed")
	}
}
