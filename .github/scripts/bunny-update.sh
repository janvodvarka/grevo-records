#!/usr/bin/env bash
# Point one Magic Containers container at a new image tag.
# Replaces BunnyWay/actions/container-update-image, which neither awaits nor
# checks its PATCH (a green step proved nothing) and only says "not found"
# without listing what the API actually returned.
# Usage: bunny-update.sh <app_id> <container_name> <image_tag>   (needs BUNNY_API_KEY)
set -euo pipefail
app_id=$1; want=$2; tag=$3
api="https://api.bunny.net/mc/apps/$app_id"

app=$(curl -fsS -H "AccessKey: $BUNNY_API_KEY" -H 'Accept: application/json' "$api")
echo "Containers in app $app_id:"
jq -r '.containerTemplates[] | "  - \(.name | @json)  id=\(.id)  image=\(.imageName // "?"):\(.imageTag // "?")"' <<<"$app"

# Exact match first, then trimmed + case-insensitive (dashboard names can
# differ from the API's in whitespace or case).
id=$(jq -r --arg n "$want" '[.containerTemplates[] | select(.name == $n)][0].id // empty' <<<"$app")
[ -n "$id" ] || id=$(jq -r --arg n "$want" \
  '[.containerTemplates[] | select((.name | ascii_downcase | gsub("^\\s+|\\s+$"; "")) == ($n | ascii_downcase))][0].id // empty' <<<"$app")
if [ -z "$id" ]; then
  echo "::error::No container named \"$want\" in app $app_id (see list above)"
  exit 1
fi

echo "Updating \"$want\" ($id) to tag $tag"
code=$(curl -sS -o /tmp/bunny-patch.out -w '%{http_code}' -X PATCH \
  -H "AccessKey: $BUNNY_API_KEY" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg id "$id" --arg t "$tag" '{id: $id, imageTag: $t}')" \
  "$api/containers/$id")
if [ "${code:0:1}" != 2 ]; then
  echo "::error::Bunny PATCH returned HTTP $code"; cat /tmp/bunny-patch.out; exit 1
fi
echo "OK (HTTP $code)"
