package handlers

import (
	"crypto/subtle"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/receiptlink"
)

const (
	ratingFormMaxBytes   = 8 << 10
	ratingCommentRunes   = 500
	ratingFastThreshold  = 60 * time.Second
	msgRatingPickStars   = "Pilih jumlah bintang terlebih dahulu."
	msgRatingBadRequest  = "Penilaian tidak dapat dibaca. Silakan coba lagi."
	msgRatingSaveFailed  = "Penilaian belum dapat disimpan. Silakan coba lagi."
	receiptDefaultZoneID = "Asia/Jakarta"
)

// ratingForm is the form state kept when the page is shown again after an error.
type ratingForm struct {
	stars   int
	tags    []string
	comment string
	err     string
}

// receiptLinkFor resolves the {token} of a public request. Every miss (bad shape, unknown,
// expired) renders the same 404 body; a database failure renders a 503 without detail.
func (h *Handlers) receiptLinkFor(w http.ResponseWriter, r *http.Request) (read.ReceiptLinkInfo, bool) {
	hash, ok := receiptlink.HashToken(chi.URLParam(r, "token"))
	if !ok {
		receiptlink.RenderGone(w, h.receiptLogo.Peek())
		return read.ReceiptLinkInfo{}, false
	}
	link, err := h.Repo.ReceiptLinkByHash(r.Context(), hash)
	if errors.Is(err, read.ErrNotFound) {
		receiptlink.RenderGone(w, h.receiptLogo.Peek())
		return link, false
	}
	if err != nil {
		slog.Error("receipt link lookup failed", "err", err)
		receiptlink.RenderUnavailable(w, h.receiptLogo.Peek())
		return link, false
	}
	return link, true
}

// ReceiptPage is GET /r/{token}: the public digital receipt and rating form.
func (h *Handlers) ReceiptPage(w http.ResponseWriter, r *http.Request) {
	link, ok := h.receiptLinkFor(w, r)
	if !ok {
		return
	}
	h.writeReceiptPage(w, r, link, http.StatusOK, ratingForm{})
}

// SubmitReceiptRating is POST /r/{token}: the first rating of the order wins; a repeat changes
// nothing. Success redirects (303) back to the page, which then shows the thank-you state.
func (h *Handlers) SubmitReceiptRating(w http.ResponseWriter, r *http.Request) {
	link, ok := h.receiptLinkFor(w, r)
	if !ok {
		return
	}
	if link.Rated {
		redirectToReceipt(w, chi.URLParam(r, "token"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, ratingFormMaxBytes)
	if err := r.ParseForm(); err != nil {
		h.writeReceiptPage(w, r, link, http.StatusBadRequest, ratingForm{err: msgRatingBadRequest})
		return
	}
	form := ratingForm{tags: cleanRatingTags(r.PostForm["tags"]), comment: cleanRatingComment(r.PostFormValue("comment"))}
	stars, err := strconv.Atoi(strings.TrimSpace(r.PostFormValue("stars")))
	if err != nil || stars < 1 || stars > 5 {
		form.err = msgRatingPickStars
		h.writeReceiptPage(w, r, link, http.StatusBadRequest, form)
		return
	}
	form.stars = stars
	sameNet := subtle.ConstantTimeCompare(receiptlink.NetHash(link.NetSalt, clientip.ClientIPBucket(r)), link.NetHash) == 1
	if _, err := h.Write.InsertOrderRating(r.Context(), writeRating(link, form, time.Since(link.CreatedAt) < ratingFastThreshold, sameNet)); err != nil {
		slog.Error("order rating insert failed", "err", err)
		form.err = msgRatingSaveFailed
		h.writeReceiptPage(w, r, link, http.StatusServiceUnavailable, form)
		return
	}
	redirectToReceipt(w, chi.URLParam(r, "token"))
}

// redirectToReceipt sends the browser back to the page with a relative Location (the token is
// already shape-checked: base64url only).
func redirectToReceipt(w http.ResponseWriter, token string) {
	receiptlink.SetPublicHeaders(w)
	w.Header().Set("Location", token)
	w.WriteHeader(http.StatusSeeOther)
}

// cleanRatingTags keeps the allowed tag codes, once each, in form order.
func cleanRatingTags(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range in {
		if receiptlink.TagLabel(t) != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// cleanRatingComment trims the comment, drops control characters (a tab becomes a space, newlines
// stay) and cuts it to 500 runes.
func cleanRatingComment(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\t':
			return ' '
		case r == '\n':
			return r
		case unicode.IsControl(r) || r == 0x2028 || r == 0x2029:
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > ratingCommentRunes {
		s = string([]rune(s)[:ratingCommentRunes])
	}
	return s
}

func (h *Handlers) writeReceiptPage(w http.ResponseWriter, r *http.Request, link read.ReceiptLinkInfo, status int, form ratingForm) {
	d, err := h.Repo.ReceiptPage(r.Context(), link.OrderID)
	if err != nil {
		slog.Error("receipt page read failed", "err", err)
		receiptlink.RenderUnavailable(w, h.receiptLogo.Peek())
		return
	}
	page := buildReceiptPage(d, link, form)
	page.Logo = h.receiptLogo.DataURI(r.Context(), d.LogoURL)
	receiptlink.RenderReceipt(w, status, page)
}

// ReceiptRateLimited is the 429 refusal of the public receipt routes. No database, no fetch.
func (h *Handlers) ReceiptRateLimited(w http.ResponseWriter, _ *http.Request) {
	receiptlink.RenderRateLimited(w, h.receiptLogo.Peek())
}

// buildReceiptPage turns the stored order into the public page: first name only, money formatted,
// the outlet's own time zone.
func buildReceiptPage(d read.ReceiptPageData, link read.ReceiptLinkInfo, form ratingForm) receiptlink.PageData {
	loc, err := time.LoadLocation(d.Zone)
	if err != nil {
		loc, _ = time.LoadLocation(receiptDefaultZoneID)
	}
	p := receiptlink.PageData{
		Brand: d.Brand, Outlet: d.OutletName, FirstName: d.CustomerFirstName, OrderNumber: d.OrderNumber,
		Salesman: strings.TrimSpace(d.SalesmanName),
		When:     receiptlink.FormatWhen(d.CreatedAt, loc), Subtotal: receiptlink.FormatRupiah(d.Subtotal),
		Total: receiptlink.FormatRupiah(d.Total), Payment: d.Payment, PromptTitle: receiptlink.PromptTitle(link.SalesmanName),
		Error: form.err, Comment: form.comment,
	}
	for _, l := range d.Lines {
		p.Lines = append(p.Lines, receiptlink.Line{Name: l.Name, Variant: l.Variant, Qty: l.Qty, Subtotal: receiptlink.FormatRupiah(l.Subtotal)})
	}
	if d.Discount > 0 {
		p.Discount = receiptlink.FormatRupiah(-d.Discount)
	}
	if d.Tax > 0 {
		p.Tax = receiptlink.FormatRupiah(d.Tax)
	}
	if d.Surcharge > 0 {
		p.Extras = append(p.Extras, receiptlink.AdjRow{Label: "Biaya tambahan", Amount: receiptlink.FormatRupiah(d.Surcharge)})
	}
	if d.PointsRedeemed > 0 {
		p.Extras = append(p.Extras, receiptlink.AdjRow{Label: "Tukar poin", Amount: receiptlink.FormatRupiah(-d.PointsRedeemed)})
	}
	if row, ok := roundingRow(d); ok {
		p.Extras = append(p.Extras, row)
	}
	if link.Rated {
		p.Rated, p.RatedStars, p.RatedStarRow, p.RatedComment = true, link.Stars, receiptlink.StarRow(link.Stars), link.Comment
		for _, t := range link.Tags {
			if l := receiptlink.TagLabel(t); l != "" {
				p.RatedTags = append(p.RatedTags, l)
			}
		}
		return p
	}
	p.Stars, p.TagChoices = receiptlink.FormChoices(form.stars, form.tags)
	return p
}

// roundingRow mirrors the POS Riwayat "Pembulatan" row (orderAdjustmentRows in receiptRows.ts): what
// is left between the shown rows and the stored total, so the rows add up to Total.
func roundingRow(d read.ReceiptPageData) (receiptlink.AdjRow, bool) {
	residual := d.Subtotal - d.Discount + d.Surcharge + d.Tax - d.PointsRedeemed - d.Total
	if math.Abs(residual) < 1 {
		return receiptlink.AdjRow{}, false
	}
	return receiptlink.AdjRow{Label: "Pembulatan", Amount: receiptlink.FormatRupiah(-residual)}, true
}
