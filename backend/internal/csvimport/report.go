package csvimport

import "sort"

// Report limits (D4): every error and warning is listed up to MaxIssues; the per-row
// action table is capped at MaxReportRows (the summary counts are always exact).
const (
	MaxIssues     = 5000
	MaxReportRows = 500
)

// Row actions.
const (
	ActionCreate = "create"
	ActionUpdate = "update"
	ActionSkip   = "skip"
	ActionError  = "error"
)

// Severities.
const (
	SevError   = "error"
	SevWarning = "warning"
)

// Summary holds exact counts: Create/Update/Skip/Error are data rows by outcome,
// Warning counts warnings, NewCategories counts categories that apply would create.
type Summary struct {
	Create        int `json:"create"`
	Update        int `json:"update"`
	Skip          int `json:"skip"`
	Error         int `json:"error"`
	Warning       int `json:"warning"`
	NewCategories int `json:"newCategories"`
}

// FileIssue is a problem with the file as a whole (encoding, quoting, headers, limits).
type FileIssue struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	Column   string `json:"column,omitempty"`
}

// Issue is a per-row error or warning. Row is the 1-based data-row index, Line the
// physical line the record starts on.
type Issue struct {
	Row      int    `json:"row"`
	Line     int    `json:"line"`
	Column   string `json:"column,omitempty"`
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
	Value    string `json:"value,omitempty"`
}

// RowResult is one line of the preview action table.
type RowResult struct {
	Row    int    `json:"row"`
	Line   int    `json:"line"`
	Action string `json:"action"`
	Key    string `json:"key"`
	Reason string `json:"reason,omitempty"`
}

// Report is the one shape shared by preview, apply (200), 422 and replay.
type Report struct {
	Kind       string      `json:"kind"`
	Delimiter  string      `json:"delimiter"`
	FileSHA256 string      `json:"fileSha256"`
	TotalRows  int         `json:"totalRows"`
	Summary    Summary     `json:"summary"`
	FileIssues []FileIssue `json:"fileIssues"`
	Issues     []Issue     `json:"issues"`
	Rows       []RowResult `json:"rows"`
	RunID      string      `json:"runId,omitempty"`
	AppliedAt  string      `json:"appliedAt,omitempty"`
}

// HasErrors is true when apply must be refused: a file-level error or any errored row.
func (r Report) HasErrors() bool {
	if r.Summary.Error > 0 {
		return true
	}
	for _, f := range r.FileIssues {
		if f.Severity == SevError {
			return true
		}
	}
	return false
}

// Redacted returns a copy that is safe to keep in the audit table: no issue value (it can
// be a phone, email or name taken from the file) and, for customer imports, no row key
// (the phone). Counts, row numbers, codes, columns, messages (none embeds a customer
// value) and per-row actions stay, so a replay still gives a coherent report. Product and
// ingredient keys are catalog data (SKU/name) and are kept.
func (r Report) Redacted() Report {
	out := r
	out.Issues = make([]Issue, len(r.Issues))
	for i, is := range r.Issues {
		is.Value = ""
		out.Issues[i] = is
	}
	out.Rows = make([]RowResult, len(r.Rows))
	for i, row := range r.Rows {
		if r.Kind == KindCustomers {
			row.Key = ""
		}
		out.Rows[i] = row
	}
	out.FileIssues = append([]FileIssue{}, r.FileIssues...)
	return out
}

// Builder collects a Report while a planner walks the rows.
type Builder struct {
	r       Report
	errRows map[int]bool
}

// NewBuilder starts a report for a parsed table (kind is customers/products/ingredients).
func NewBuilder(kind string, t *Table) *Builder {
	b := &Builder{
		r: Report{
			Kind: kind, Delimiter: t.Delimiter, FileSHA256: t.SHA256,
			TotalRows: len(t.Rows), FileIssues: append([]FileIssue{}, t.FileIssues...),
			Issues: []Issue{}, Rows: []RowResult{},
		},
		errRows: map[int]bool{},
	}
	return b
}

// Begin adopts the reader's own row problems (short/long rows).
func (b *Builder) Begin(row Row) {
	for _, p := range row.Problems {
		b.addIssue(p)
	}
}

// Issue records a row problem. An error issue forces the row's action to "error".
func (b *Builder) Issue(row Row, column, severity, code, message, value string) {
	b.addIssue(Issue{Row: row.Index, Line: row.Line, Column: column, Severity: severity,
		Code: code, Message: message, Value: truncateValue(value)})
}

func (b *Builder) addIssue(i Issue) {
	if i.Severity == SevError {
		b.errRows[i.Row] = true
	} else {
		b.r.Summary.Warning++
	}
	if len(b.r.Issues) >= MaxIssues {
		if !b.hasFileIssue("too_many_issues") {
			b.r.FileIssues = append(b.r.FileIssues, FileIssue{Severity: SevWarning, Code: "too_many_issues",
				Message: "terlalu banyak masalah; hanya 5000 pertama yang ditampilkan"})
		}
		return
	}
	b.r.Issues = append(b.r.Issues, i)
}

func (b *Builder) hasFileIssue(code string) bool {
	for _, f := range b.r.FileIssues {
		if f.Code == code {
			return true
		}
	}
	return false
}

// RowHasError reports whether an error was recorded for the row so far.
func (b *Builder) RowHasError(row Row) bool { return b.errRows[row.Index] }

// Row records the row's outcome. A row with any error issue is always an "error".
func (b *Builder) Row(row Row, action, key, reason string) {
	if b.errRows[row.Index] {
		action, reason = ActionError, ""
	}
	switch action {
	case ActionCreate:
		b.r.Summary.Create++
	case ActionUpdate:
		b.r.Summary.Update++
	case ActionSkip:
		b.r.Summary.Skip++
	default:
		b.r.Summary.Error++
	}
	if len(b.r.Rows) < MaxReportRows {
		b.r.Rows = append(b.r.Rows, RowResult{Row: row.Index, Line: row.Line, Action: action, Key: key, Reason: reason})
	}
}

// NewCategories records how many categories apply would create.
func (b *Builder) NewCategories(n int) { b.r.Summary.NewCategories = n }

// Report finalises the collected report (issues and rows ordered by row index).
func (b *Builder) Report() Report {
	sort.SliceStable(b.r.Issues, func(i, j int) bool { return b.r.Issues[i].Row < b.r.Issues[j].Row })
	sort.SliceStable(b.r.Rows, func(i, j int) bool { return b.r.Rows[i].Row < b.r.Rows[j].Row })
	return b.r
}

func truncateValue(v string) string {
	if r := []rune(v); len(r) > 80 {
		return string(r[:80]) + "…"
	}
	return v
}
