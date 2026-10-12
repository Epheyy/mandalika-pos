# Sourced helpers for the backend deploy/promote scripts (Cloud Run service mandalika-pos).
SERVICE="mandalika-pos"
REGION="asia-southeast2"
PROJECT="mandalika-pos"

# Print the Cloud Run traffic entries as JSON.
cr_traffic_json() {
  gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format=json |
    python -c "import sys,json;print(json.dumps(json.load(sys.stdin).get('status',{}).get('traffic',[])))"
}

# cr_field <field> [tag]: with no tag, the field of the entry serving 100% of traffic
# (untagged entry preferred); with a tag, the field of the entry carrying that tag.
cr_field() {
  cr_traffic_json | CR_FIELD="$1" CR_TAG="${2:-}" python -c "
import sys,json,os
t=json.load(sys.stdin); f=os.environ['CR_FIELD']; tag=os.environ['CR_TAG']
if tag:
    c=[e for e in t if e.get('tag')==tag]
else:
    c=[e for e in t if e.get('percent')==100]
print((c[0].get(f,'') if c else ''))
"
}

# cr_revision_label <tag> <label>: label value on the revision carrying that traffic tag.
cr_revision_label() {
  local rev
  rev=$(cr_field revisionName "$1")
  [ -n "$rev" ] || return 1
  gcloud run revisions describe "$rev" --region "$REGION" --project "$PROJECT" --format=json |
    CR_LABEL="$2" python -c "
import sys,json,os
print(json.load(sys.stdin).get('metadata',{}).get('labels',{}).get(os.environ['CR_LABEL'],''))
"
}
