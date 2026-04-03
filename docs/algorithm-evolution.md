# Recommendation Algorithm Evolution

This document tracks the evolution of the Watchlist recommendation algorithm,
preserving the rationale behind each version and the thresholds chosen.

---

## v1 — Content-Based (baseline)

**Script:** `scripts/recommend.mjs`

Simple content-based filtering using IMDb datasets. Genre vectors, IMDb quality
thresholds, and a basic cosine similarity score.

**Key thresholds:**
- `MIN_VOTES = 50,000` (English titles)
- `MIN_VOTES_FOREIGN = 3,000` (non-English)
- `MIN_RATING = 6.0`
- `MIN_YEAR = 1970`

**Rationale:** High MIN_VOTES surfaces mainstream titles that "most people have
heard of." The foreign threshold is lower because IMDb vote counts skew heavily
toward English-language content.

---

## v2 — Content-Based (infrastructure)

**Script:** `scripts/recommend.mjs` (parameterized)

Added TMDB enrichment, cross-list exclusion, and a richer feature vector
(genres + keywords + directors + actors). IDF weighting and MMR diversity
attempted but removed due to noise. Hybrid scoring blend also explored and
removed. Reverted to v1's simplicity + better infrastructure.

---

## v3 — Content-Based (stable)

**Script:** `scripts/recommendations.mjs`

v1 philosophy applied with v2's infrastructure:
- Simple cosine similarity on genre + enrichment vectors (no IDF, no MMR)
- Per-list positive signal, cross-list exclusion
- Full TMDB enrichment for all candidates
- Feature-aware explanations
- Same IMDb thresholds as v1

**Quality filter retained:** The high MIN_VOTES threshold worked well in
practice — it reliably filtered "obscure trash" while keeping foreign-language
gems through the lower foreign threshold.

---

## v4 — Graph-Based (raw count + diversity)

**Script:** `scripts/graph-recommend.mjs`

Replaced content-based similarity with a graph traversal approach:
- Load TMDB `/recommendations` or `/similar` forward index (built by
  `build-recs-cache.mjs` / `build-similar-cache.mjs`)
- For each watched/archived title, look up its TMDB recommendation neighbors
- Aggregate by reference count — titles recommended by many watched titles rank
  higher
- Ranking A: raw reference count (with tie groups)
- Ranking B: diversity-adjusted via graph pruning (each selected title "spends"
  its source nodes, reducing overlap in subsequent picks)

**No quality filter in v4 base.** The graph approach surfaces titles that are
"objectively popular" (many neighbors in the TMDB graph) but that doesn't
guarantee quality — some high-degree nodes are popular trash.

---

## v4 + O4 — Graph-Based + IMDb Quality Filter

**Eval script:** `scripts/graph-recommend-filtered.mjs`  
**Production pipeline:** `scripts/generate-recommendations.mjs` (`ALGORITHM_VERSION = "v4-graph-q1"`)

Adds IMDb quality thresholds to the v4 graph pipeline. The eval script was used
to compare three threshold configurations against the shared list (152 watched
TV shows). **Production now uses the agreed thresholds** (see below).

### What was added

- Load `data/imdb/title.ratings.tsv` into memory (~1.2M entries)
- For each candidate in the top-N pool:
  1. Resolve `imdbId` from `titleRegistry` (by tmdbId) or TMDB API fallback
     (`/{mediaType}/{tmdbId}?append_to_response=external_ids`)
  2. Resolve `original_language` from registry or TMDB API response
  3. Look up IMDb `averageRating` and `numVotes`
  4. Apply threshold: PASS or FAIL
- Build two rankings side-by-side: unfiltered vs quality-filtered
- Print candidate audit table, comparison, and filter impact summary

### Agreed production thresholds

Evaluated three configurations against the shared list (152 watched TV shows):

| Config | EN votes | Result |
|--------|----------|--------|
| 50k EN | 50,000 | Too aggressive — killed 83% of candidates, including Younger (34k votes) |
| **15k EN** ✅ | **15,000** | Good balance — filters obscure niche titles, keeps mid-popularity quality shows |
| No filter | — | Lets in trash: And Just Like That… (5.6 rating), Tyler Perry shows (3.7/4.4) |

**Correctly drops:** And Just Like That… (5.6 rating), A Nero Wolfe Mystery (2k votes), Eight Is Enough (4k), Bad Judge (5k), Tyler Perry shows  
**Correctly keeps:** Younger (34k), Ballers (78k), Will & Grace (64k), Search Party (15k)  
**Promoted quality:** Goliath (8.1, 63k), Weeds (7.9, 122k), Why Women Kill (8.3, 38k)

```
MIN_RATING = 6.0
MIN_VOTES_EN = 15,000     # English titles
MIN_VOTES_FOREIGN = 3,000 # Non-English titles
```

### How to run

```bash
# Basic: filter shows for a shared list
node scripts/graph-recommend-filtered.mjs <listId> --type show

# Custom thresholds
node scripts/graph-recommend-filtered.mjs <listId> --min-rating 6.5 --min-votes-en 30000

# Show quality data without dropping anything (audit mode)
node scripts/graph-recommend-filtered.mjs <listId> --no-filter

# Larger pool for sparser graphs (movies)
node scripts/graph-recommend-filtered.mjs <listId> --type movie --pool 60

# Treat titles with no IMDb data as PASS instead of FAIL
node scripts/graph-recommend-filtered.mjs <listId> --allow-unknown
```

Requires `data/imdb/title.ratings.tsv`. If missing:
```bash
# Download from IMDb datasets
curl -O https://datasets.imdbws.com/title.ratings.tsv.gz
gunzip title.ratings.tsv.gz
mv title.ratings.tsv data/imdb/
```

### Production integration

The quality filter is integrated into `generate-recommendations.mjs` as of
`v4-graph-q1`. The pipeline enriches a 3× pool (min 30 candidates), applies
the filter, then takes the top-k survivors. Gracefully degrades: if
`data/imdb/title.ratings.tsv` is absent (e.g. in Vercel CI), filtering is
skipped and the doc's `qualityFilter` field is set to `null`.

---

## Preserved scripts

| Script | Version | Status |
|--------|---------|--------|
| `scripts/recommend.mjs` | v1/v2 (parameterized) | Preserved |
| `scripts/recommendations.mjs` | v3 (content-based, stable) | Preserved |
| `scripts/graph-recommend.mjs` | v4 (raw count + diversity) | Active eval |
| `scripts/graph-recommend-filtered.mjs` | v4 + O4 (quality filter) | Active eval |
| `scripts/generate-recommendations.mjs` | v4-graph-q1 (production pipeline) | Production |
