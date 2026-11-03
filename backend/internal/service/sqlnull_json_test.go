package service

import "testing"

func TestNullJSONValue(t *testing.T) {
	for _, in := range []string{"", "null", " null\n"} {
		if got := nullJSONValue([]byte(in)); got != nil {
			t.Errorf("nullJSONValue(%q)=%v want nil (SQL NULL)", in, got)
		}
	}
	arr := []byte(`[{"label":"X","amount":1}]`)
	if got, ok := nullJSONValue(arr).([]byte); !ok || string(got) != string(arr) {
		t.Errorf("array must pass through, got %v", got)
	}
	if got, ok := nullJSONValue([]byte("[]")).([]byte); !ok || string(got) != "[]" {
		t.Errorf("empty array must pass through, got %v", got)
	}
}
