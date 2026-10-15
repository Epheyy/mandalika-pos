package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID      string   `json:"uid"`
	Role        string   `json:"role"`
	OutletID    string   `json:"outlet_id,omitempty"`
	Permissions []string `json:"perms,omitempty"`
	jwt.RegisteredClaims
}

type RefreshClaims struct {
	UserID string `json:"uid"`
	jwt.RegisteredClaims
}

type Tokens struct {
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
}

func IssueAccess(secret []byte, ttl time.Duration, uid, role, outletID string, perms []string) (string, error) {
	now := time.Now()
	c := Claims{
		UserID: uid, Role: role, OutletID: outletID, Permissions: perms,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   uid,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(secret)
}

// SignRefresh signs a refresh token with a caller-chosen jti, iat and exp. The
// session row in Postgres stores the same second-truncated values, so a token
// can be re-minted byte-for-byte from the row (HS256 is deterministic).
func SignRefresh(secret []byte, uid, jti string, iat, exp time.Time) (string, error) {
	c := RefreshClaims{
		UserID: uid,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        jti,
			Subject:   uid,
			IssuedAt:  jwt.NewNumericDate(iat),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(secret)
}

func ParseAccess(secret []byte, token string) (*Claims, error) {
	c := &Claims{}
	t, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !t.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

func ParseRefresh(secret []byte, token string) (*RefreshClaims, error) {
	c := &RefreshClaims{}
	t, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return secret, nil
	})
	if err != nil || !t.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}
