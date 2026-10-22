package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"

	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

const (
	msgInvalidInput = "invalid input"
	msgDataConflict = "the change conflicts with existing data"
	// msgRequestTimeout answers a request that hit the server-side deadline.
	msgRequestTimeout = "request timed out, retry"

	// retryAfterTimeoutSeconds is the Retry-After on that 503: the work was cut by the
	// deadline, a retry usually lands on a less busy moment.
	retryAfterTimeoutSeconds = 2
)

// writeErr answers an error from a handler path. It classifies by what is in the
// error chain, not by the status the caller asked for, so database text (messages,
// SQLSTATE, constraint names) never reaches a client. Domain validation errors in a
// 4xx keep their status and text; everything unexpected becomes a generic 500 with a
// request reference, the raw error going to the log once.
func writeErr(w http.ResponseWriter, r *http.Request, status int, err error) {
	status, msg := classifyErr(r, status, err)
	if status == http.StatusServiceUnavailable && msg == msgRequestTimeout {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfterTimeoutSeconds))
	}
	httpx.Err(w, status, msg)
}

// isServerDeadline reports a database/context error caused by the server-side request
// deadline (middleware.Deadline) firing: the request context itself expired by deadline
// and the error is a deadline, driver timeout or query-cancel. A client cancel
// (context.Canceled) is not one, so it stays a generic 500.
func isServerDeadline(r *http.Request, err error) bool {
	if !errors.Is(r.Context().Err(), context.DeadlineExceeded) {
		return false
	}
	var pg *pgconn.PgError
	return errors.Is(err, context.DeadlineExceeded) || pgconn.Timeout(err) ||
		errors.As(err, &pg) && pg.Code == "57014"
}

func classifyErr(r *http.Request, status int, err error) (int, string) {
	if err == nil {
		return generic500(r, status, errors.New("nil error"))
	}
	if errors.Is(err, read.ErrNotFound) || errors.Is(err, write.ErrNotFound) || errors.Is(err, pgx.ErrNoRows) {
		return http.StatusNotFound, "not found"
	}
	if isServerDeadline(r, err) {
		logRaw(r, http.StatusServiceUnavailable, err)
		return http.StatusServiceUnavailable, msgRequestTimeout
	}
	serverSide := status == 0 || status >= http.StatusInternalServerError
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return classifyPg(r, pg, serverSide, err)
	}
	if isInfraErr(err) || status == 0 || status >= http.StatusInternalServerError && status != http.StatusServiceUnavailable {
		return generic500(r, status, err)
	}
	return status, err.Error()
}

// classifyPg maps a PostgreSQL error. On a path where the caller itself expects a 500
// only input-syntax codes (a client-supplied bad uuid or date) are the client's fault;
// any other data or integrity code there is a server-side SQL fault and stays a 500.
func classifyPg(r *http.Request, pg *pgconn.PgError, serverSide bool, err error) (int, string) {
	switch {
	case pg.Code == "40001" || pg.Code == "40P01" || pg.Code == "55P03":
		logRaw(r, http.StatusConflict, err)
		return http.StatusConflict, write.ErrBusy.Error()
	case pg.Code == "22P02" || pg.Code == "22007" || pg.Code == "22008":
		logRaw(r, http.StatusBadRequest, err)
		return http.StatusBadRequest, msgInvalidInput
	case serverSide:
		return generic500(r, http.StatusInternalServerError, err)
	case strings.HasPrefix(pg.Code, "22"):
		logRaw(r, http.StatusBadRequest, err)
		return http.StatusBadRequest, msgInvalidInput
	case strings.HasPrefix(pg.Code, "23"):
		logRaw(r, http.StatusBadRequest, err)
		return http.StatusBadRequest, msgDataConflict
	}
	return generic500(r, http.StatusInternalServerError, err)
}

// isInfraErr reports an error that must never be echoed: context, connection and
// driver failures, plus a text check that catches %v-wrapped database errors.
func isInfraErr(err error) bool {
	var (
		pg   *pgconn.PgError
		conn *pgconn.ConnectError
		scan pgx.ScanArgError
		nerr net.Error
	)
	switch {
	case errors.As(err, &pg), errors.As(err, &conn), errors.As(err, &scan), errors.As(err, &nerr):
		return true
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, pgx.ErrTxClosed):
		return true
	case pgconn.Timeout(err):
		return true
	}
	return hasDBMarker(err.Error())
}

// hasDBMarker spots database text in a string (a %v-wrapped error, a stored last_error).
// The colon forms keep a SKU such as "pgx-1" from flipping a domain message.
func hasDBMarker(s string) bool {
	return strings.Contains(s, "SQLSTATE") || strings.Contains(s, "pgx:") || strings.Contains(s, "pgconn:") || strings.HasPrefix(s, "ERROR:")
}

// safeDomainText is the text for a typed class answered at status: its own domain
// message unless the chain carries infrastructure, in which case a fixed message that
// fits the status (raw text logged with the real status).
func safeDomainText(r *http.Request, status int, err error) string {
	if !isInfraErr(err) {
		return err.Error()
	}
	logRaw(r, status, err)
	switch status {
	case http.StatusConflict:
		return msgDataConflict
	case http.StatusServiceUnavailable:
		return "temporarily unavailable, retry"
	}
	return "the request could not be processed"
}

// syncFail answers a whole-request failure on a /sync route. The POS engine retries on
// 5xx but parks items on 400 and suspends pulling on 404/409, so this is always a 500.
func syncFail(w http.ResponseWriter, r *http.Request, err error) {
	status, msg := generic500(r, http.StatusInternalServerError, err)
	httpx.Err(w, status, msg)
}

func generic500(r *http.Request, _ int, err error) (int, string) {
	logRaw(r, http.StatusInternalServerError, err)
	if id := chimw.GetReqID(r.Context()); id != "" {
		return http.StatusInternalServerError, "internal error (ref " + id + ")"
	}
	return http.StatusInternalServerError, "internal error"
}

func logRaw(r *http.Request, status int, err error) {
	slog.Error("request failed", "request_id", chimw.GetReqID(r.Context()), "method", r.Method, "path", r.URL.Path, "status", status, "err", err)
}
