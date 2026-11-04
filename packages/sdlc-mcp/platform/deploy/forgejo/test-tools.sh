#!/bin/bash
# Functional sweep of the Forgejo workflow MCP tools against a real Forgejo, through the real
# Keycloak-authenticated MCP endpoint, acting as a connected user.
#   - Always: connect via OAuth, create a fixture repo, and exercise the read tools.
#   - When the server runs with SDLC_ENABLE_WRITES=true: also exercise the write tools and gates.
# The fixture repository must be in SDLC_ALLOWED_REPOSITORIES (default internal/lab-cloud).
set -euo pipefail

cd "$(dirname "$0")/../../.."
set -a; . ./.env; set +a

FORGEJO="http://$FORGEJO_HOSTNAME/api/v1"
auth=(-u "$FORGEJO_ADMIN_USERNAME:$FORGEJO_ADMIN_PASSWORD")
repo="${SDLC_ALLOWED_REPOSITORIES%%,*}"; owner="${repo%/*}"; name="${repo#*/}"
failures=0
check() { if [ "$2" = true ]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi; }
gh() { curl -s "${auth[@]}" -H 'content-type: application/json' "$@"; }

# Fixture: owner (org or user), repository with a commit, a branch with a change, one issue.
if ! gh "$FORGEJO/orgs/$owner" | jq -e .id >/dev/null 2>&1; then gh -X POST "$FORGEJO/orgs" -d "{\"username\":\"$owner\",\"visibility\":\"private\"}" >/dev/null; fi
if ! gh "$FORGEJO/repos/$owner/$name" | jq -e .id >/dev/null 2>&1; then
  gh -X POST "$FORGEJO/orgs/$owner/repos" -d "{\"name\":\"$name\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":true}" >/dev/null
fi
gh -X POST "$FORGEJO/repos/$owner/$name/branches" -d '{"new_branch_name":"mcp-test","old_branch_name":"main"}' >/dev/null || true
gh -X POST "$FORGEJO/repos/$owner/$name/contents/mcp-test-$$.txt" -d "{\"branch\":\"mcp-test\",\"content\":\"$(printf 'hello' | base64)\",\"message\":\"mcp test change\"}" >/dev/null
issue_no="$(gh -X POST "$FORGEJO/repos/$owner/$name/issues" -d '{"title":"MCP fixture issue","body":"created by test-tools.sh"}' | jq -r .number)"

# Connect as the Forgejo administrator and keep the grant for the sweep.
KEEP_CONNECTED=1 deploy/forgejo/test-oauth-connect.sh >/dev/null 2>&1 || { echo "FAIL  could not connect Forgejo via OAuth"; exit 1; }
clients=("$FORGEJO_MCP_OAUTH_CLIENT_ID")
KC="http://$KEYCLOAK_HOSTNAME"; REALM_URL="$KC/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
. deploy/keycloak/lib.sh
keycloak_token="$(token_for "$FORGEJO_MCP_OAUTH_CLIENT_ID" "$FORGEJO_MCP_PUBLIC_URL")"
cleanup() { tool disconnect_forgejo '{}' >/dev/null 2>&1 || true; restore_direct_grants; }
trap cleanup EXIT

tool() { # name arguments-json -> JSON-RPC response (SSE unwrapped)
  curl -s -X POST "$FORGEJO_MCP_PUBLIC_URL" -H "authorization: Bearer $keycloak_token" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
    | { grep '^data: ' || true; } | cut -c7-
}
ok() { jq -e '(.result.isError // false) | not' <<<"$1" >/dev/null 2>&1 && echo true || echo false; }
body() { jq -r '.result.content[0].text' <<<"$1"; }
R="{\"owner\":\"$owner\",\"repo\":\"$name\"}"
I="{\"owner\":\"$owner\",\"repo\":\"$name\",\"index\":$issue_no}"

echo "== reads (repository $repo, issue #$issue_no)"
out="$(tool get_repository "$R")";               check "get_repository returns the repo and default branch" "$([ "$(body "$out" | jq -r .default_branch 2>/dev/null)" = main ] && echo true || echo false)"
out="$(tool get_issue "$I")";                    check "get_issue reads the fixture issue" "$([ "$(body "$out" | jq -r .title 2>/dev/null)" = "MCP fixture issue" ] && echo true || echo false)"
out="$(tool search_issues "$(jq -c '. + {query:"fixture"}' <<<"$R")")"; check "search_issues finds it by text" "$([ "$(body "$out" | jq 'length' 2>/dev/null)" -ge 1 ] 2>/dev/null && echo true || echo false)"
for t in list_pull_requests discover_issue_fields list_commits list_releases_and_tags list_branch_protections list_webhooks list_repository_teams list_action_runs; do
  out="$(tool "$t" "$R")"; check "$t succeeds" "$(ok "$out")"
done
for t in list_issue_comments list_issue_dependencies list_time_entries list_issue_attachments; do
  out="$(tool "$t" "$I")"; check "$t succeeds" "$(ok "$out")"
done
out="$(tool list_organizations '{}')";           check "list_organizations answers for the connected account" "$(ok "$out")"
out="$(tool get_commit_status "$(jq -c '. + {ref:"main"}' <<<"$R")")"; check "get_commit_status reads main" "$(ok "$out")"
out="$(tool get_issue '{"owner":"someone","repo":"else","index":1}')"; check "a repository outside the allowlist is refused" "$(grep -q SDLC_ALLOWED_REPOSITORIES <<<"$out" && echo true || echo false)"
out="$(tool get_issue '{"owner":"../x","repo":"y","index":1}')"; check "path-traversal input is rejected by the schema" "$([ "$(ok "$out")" = false ] && echo true || echo false)"

if [ "$(tool create_issue '{}' | grep -c 'Tool create_issue not found\|not found')" -gt 0 ]; then
  echo "== writes are disabled on this server (restart with SDLC_ENABLE_WRITES=true to test them)"
  check "write tools are absent while writes are disabled" true
else
  echo "== writes"
  key="tools-$$-$RANDOM"
  # merge FIRST-JSON SECOND-JSON; build each part with jq so no shell quoting is involved
  merge() { jq -c --argjson e "$2" '. + $e' <<<"$1"; }
  obj() { jq -nc "$@"; }
  confirm="$(obj '{confirmed:true,reason:"test-tools.sh"}')"
  create="$(merge "$(merge "$R" "$(obj --arg k "$key" '{title:("MCP created "+$k),body:"b",idempotencyKey:$k}')")" "$confirm")"
  out="$(tool create_issue "$create")"
  check "create_issue creates and reads back" "$([ "$(body "$out" | jq -r .created 2>/dev/null)" = true ] && echo true || echo false)"
  new_no="$(body "$out" | jq -r .issue.number 2>/dev/null)"
  out="$(tool create_issue "$create")"
  [ "$(body "$out" | jq -r .created 2>/dev/null)" = false ] && dup=true || { dup=false; echo "      second create returned: $(body "$out" | head -c 200)"; }
  check "create_issue with the same key creates nothing new" "$dup"
  out="$(tool create_issue "$(merge "$R" "$(obj '{title:"no confirm",idempotencyKey:"abc-123",reason:"test"}')")")"
  check "a write without confirmation is rejected" "$([ "$(ok "$out")" = false ] && echo true || echo false)"
  NI="$(merge "$(merge "$R" "$(obj --argjson n "$new_no" '{index:$n}')")" "$confirm")"
  out="$(tool add_issue_comment "$(merge "$NI" "$(obj --arg k "c-$key" '{body:"a note",idempotencyKey:$k}')")")"; check "add_issue_comment adds and reads back" "$([ "$(body "$out" | jq -r .created 2>/dev/null)" = true ] && echo true || echo false)"
  out="$(tool update_issue "$(merge "$NI" "$(obj '{title:"MCP renamed"}')")")";  check "update_issue changes the title" "$([ "$(body "$out" | jq -r .issue.title 2>/dev/null)" = "MCP renamed" ] && echo true || echo false)"
  out="$(tool add_issue_dependency "$(merge "$NI" "$(obj --arg o "$owner" --arg r "$name" --argjson i "$issue_no" '{dependencyOwner:$o,dependencyRepo:$r,dependencyIndex:$i}')")")"; check "add_issue_dependency links the two issues" "$(ok "$out")"
  out="$(tool add_time_entry "$(merge "$NI" "$(obj '{seconds:60}')")")";           check "add_time_entry records time" "$(ok "$out")"
  pr="$(merge "$(merge "$R" "$(obj --arg k "$key" '{title:("MCP PR "+$k),head:"mcp-test",base:"main",draft:true,idempotencyKey:("pr-"+$k)}')")" "$confirm")"
  out="$(tool create_pull_request "$pr")"
  check "create_pull_request opens a draft PR" "$([ "$(body "$out" | jq -r .created 2>/dev/null)" = true ] && echo true || echo false)"
  pr_no="$(body "$out" | jq -r .pullRequest.number 2>/dev/null)"
  PI="$(merge "$(merge "$R" "$(obj --argjson n "${pr_no:-0}" '{index:$n}')")" "$confirm")"
  out="$(tool get_pull_changes "$(jq -c 'del(.confirmed,.reason)' <<<"$PI")")"; check "get_pull_changes lists the changed file" "$(body "$out" | grep -q "mcp-test-" && echo true || echo false)"
  out="$(tool create_pull_review "$(merge "$PI" "$(obj '{event:"COMMENT",body:"looks fine"}')")")"; check "create_pull_review submits a review" "$(ok "$out")"
  out="$(tool update_pull_request "$(merge "$PI" "$(obj '{state:"closed"}')")")"; check "update_pull_request closes the PR (merge is unavailable)" "$(ok "$out")"
  check "there is no merge tool" "$([ -z "$(tool merge_pull_request "$PI" | grep -v 'not found')" ] && echo true || echo false)"
fi

[ "$failures" -eq 0 ] && echo "All Forgejo tool checks passed." || { echo "$failures check(s) failed."; exit 1; }
