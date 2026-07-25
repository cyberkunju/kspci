#!/usr/bin/env bash
# Fetches the raw open-data inputs for build-geo.js into datastore/raw/.
# These files total ~57 MB and are gitignored; provenance is in ref/SOURCES.md.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw
get() { [ -s "raw/$1" ] || curl -fsSL -o "raw/$1" "$2"; echo "  raw/$1  $(du -h "raw/$1" | cut -f1)"; }

echo "Fetching all-India geography and demography reference data…"
get census_districts_2011.csv \
  "https://raw.githubusercontent.com/nishusharma1810/India_Census_Data/main/india-districts-census-2011.csv"
get dists11.geojson \
  "https://raw.githubusercontent.com/datameet/maps/master/docs/data/geojson/dists11.geojson"
get postoffices.csv \
  "https://raw.githubusercontent.com/avinashcelestine/pincodes-data/master/postofficeswithpins.csv"
get postoffice_latlng.txt \
  "https://raw.githubusercontent.com/avinashcelestine/pincodes-data/master/pincodes_lat_lng.txt"

echo "Fetching NCRB Crime in India 2022 crime-head tables…"
get ncrb_ipc_heads_2022.xlsx \
  "https://www.ncrb.gov.in/uploads/nationalcrimerecordsbureau/custom/1701859959TABLE12.xlsx"
get ncrb_sll_heads_2022.xlsx \
  "https://www.ncrb.gov.in/uploads/nationalcrimerecordsbureau/custom/1701860030TABLE13.xlsx"
get ncrb_ipc_state_heads_2022.xlsx \
  "https://www.ncrb.gov.in/uploads/nationalcrimerecordsbureau/custom/1701860903TABLE1A4.xlsx"
get ncrb_sll_state_heads_2022.xlsx \
  "https://www.ncrb.gov.in/uploads/nationalcrimerecordsbureau/custom/1701860990TABLE1A5.xlsx"

echo "Done. Next:"
echo "  node datastore/build-geo.js"
echo "  python3 datastore/tools/parse_ncrb_state_heads.py   # needs openpyxl"
echo "  node datastore/build-state-heads.js"
