package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func createUserBody(password string) string {
	b, _ := json.Marshal(map[string]any{
		"email": "new.user@example.com", "password": password,
		"displayName": "New User", "role": "admin",
	})
	return string(b)
}

// postCreateUser runs CreateUser on a zero-value Handlers (nil Store/Repo):
// reached reports whether the handler got past validation to the store, which
// would panic on the nil Store.
func postCreateUser(t *testing.T, password string) (code int, body string, reached bool) {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/users", strings.NewReader(createUserBody(password)))
	func() {
		defer func() {
			if recover() != nil {
				reached = true
			}
		}()
		(&Handlers{}).CreateUser(w, r)
	}()
	return w.Code, w.Body.String(), reached
}

// Fix 3: POST /users and /auth/register enforce the same 8-128 code point
// password rule as the admin reset, before any store work.
func TestCreateUserEnforcesPasswordLength(t *testing.T) {
	for name, pw := range map[string]string{
		"too short": strings.Repeat("a", 7),
		"empty":     "",
		"too long":  strings.Repeat("a", 129),
		"7 emoji":   strings.Repeat("\U0001F600", 7),
	} {
		t.Run(name, func(t *testing.T) {
			code, body, reached := postCreateUser(t, pw)
			if reached {
				t.Fatal("store reached despite invalid password")
			}
			if code != http.StatusBadRequest || !strings.Contains(body, "password must be 8-128 characters") {
				t.Fatalf("status=%d body=%s", code, body)
			}
		})
	}
	for name, pw := range map[string]string{
		"8 chars": strings.Repeat("a", 8),
		"128":     strings.Repeat("a", 128),
		"8 emoji": strings.Repeat("\U0001F600", 8),
	} {
		t.Run("accepts "+name, func(t *testing.T) {
			_, _, reached := postCreateUser(t, pw)
			if !reached {
				t.Fatal("valid password must pass validation and reach the store")
			}
		})
	}
}
