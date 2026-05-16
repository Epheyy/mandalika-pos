package auth

type ctxKey string

const (
	CtxUserID   ctxKey = "uid"
	CtxRole     ctxKey = "role"
	CtxOutletID ctxKey = "outlet"
	CtxPerms    ctxKey = "perms"
)
