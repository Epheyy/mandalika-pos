package auth

import "context"

// HasPermission uses the authenticated request's token claims, not a fresh
// database permission lookup. Preserve the existing technical-admin bypass.
func HasPermission(ctx context.Context, permission string) bool {
	role, _ := ctx.Value(CtxRole).(string)
	if role == "admin" {
		return true
	}
	permissions, _ := ctx.Value(CtxPerms).([]string)
	for _, p := range permissions {
		if p == permission {
			return true
		}
	}
	return false
}
