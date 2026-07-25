# Reference data provenance

All reference data is open data. Nothing here is derived from real case records.

## Committed

| File | Rows | Source |
|---|---|---|
| `ncrb_states_2023.json` | 36 states/UTs + India total | NCRB *Crime in India 2023* (Vols I–III), Ministry of Home Affairs. Total cognizable crimes, crime rate per lakh, chargesheet rate, conviction rate, violent-crime rate, and murder / rape / kidnapping / extortion / robbery-dacoity rates per lakh. |
| `india_districts_full.json` | 640 districts, 36 states/UTs | Built by `build-geo.js`. Census 2011 demography joined to Census 2011 district boundaries. Read at runtime by the API function for the hotspot map. |
| `india_cities.json` | 528 cities ≥ 1 lakh | Census 2011 town/city population with coordinates. Retained for the legacy Karnataka generator (`generate.js`). |
| `india_districts.json` | 416 districts | Superseded by `india_districts_full.json`; kept until the legacy generator is retired. |

## Regenerated, not committed

| File | Rows | How to rebuild |
|---|---|---|
| `india_localities.json` | ~154,800 localities, 9,708 taluks | `./fetch-geo.sh && node build-geo.js` (9 MB, generator-only) |

## Raw inputs (`datastore/raw/`, gitignored, ~57 MB)

Fetched by `fetch-geo.sh`:

- **`census_districts_2011.csv`** — Census of India 2011 Primary Census Abstract,
  640 districts × 118 columns: population, sex, literacy, SC/ST, worker
  classification, religion, education level, age bands, household amenities.
- **`dists11.geojson`** — [datameet/maps](https://github.com/datameet/maps) district
  boundaries on Census 2011 vintage, 641 polygons keyed on `censuscode`.
- **`postoffices.csv`** — India Post directory, 154,797 post offices with
  office name, pincode, taluk/tehsil, district, state.
- **`postoffice_latlng.txt`** — coordinates for 141,567 of those post offices
  (PMJDY GIS). Coverage is uneven by design of the source; `build-geo.js` fills
  the remainder by sampling inside the district boundary.

## Known caveats

- Census demography is 2011; NCRB crime figures are 2023. District population is
  used only as a *relative* within-state weight, and state case volume is anchored
  on NCRB's actual 2023 counts, so the vintage gap does not bias totals.
- Boundaries are Census 2011. Districts created later (Mewat/Nuh, Palwal, and the
  post-2011 reorganisations in Telangana, Assam and Arunachal Pradesh) are not
  separately represented; their areas fall inside their parent districts.
- Telangana (2014) and Ladakh (2019) postdate every input source and are assigned
  from explicit district lists in `build-geo.js`.
- Registered-crime rates reflect reporting and recording practice as well as
  underlying incidence. A high-rate state is not necessarily less safe — Kerala's
  rate is the highest in India largely because it records the most.
