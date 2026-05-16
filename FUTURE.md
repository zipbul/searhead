# FUTURE

Open gaps that prevent Knoldr from fully serving as the zipbul agentic data backbone. Listed in priority order.

## 1. Multimodal & local-file ingestion

**Role**: Widen the data inlet. Today the only entry path is web research text via LangSearch.

**Function**:

- Accept PDF, image, audio, and local markdown files from users or agents.
- Convert to text via OCR (images, scanned PDFs), ASR (audio), VLM captioning (figures), and native PDF extraction.
- Funnel the resulting text into the existing `entry → claim → verify → KG` pipeline so verification, authority, and KG extraction apply uniformly.

## 2. KG query & inference surface

**Role**: Make the already-extracted `entity` and `kg_relation` tables usable by agents. Today the graph is write-only.

**Function**:

- Graph query API: neighbors of an entity, n-hop paths, common neighbors, subgraph by relation type.
- Inference: transitive-relation candidate generation (A→B, B→C ⇒ A→C), contradiction detection on edges, path scoring weighted by `claim.certainty` and `entry.authority`.
- Expose via the A2A protocol so agents can ask graph-shaped questions, not just hybrid-search ones.

## 3. Claim verdict regression measurement

**Role**: Decide objectively whether a pipeline change improves or regresses verification quality. Today only one threshold is auto-tuned (`calibration_state`); other changes (prompt edits, model swaps, new CoVe steps) ship blind.

**Function**:

- Maintain a labelled golden set of claims (verified / disputed / unverified / not_applicable).
- On each pipeline run or commit, compute precision / recall / F1 per verdict and per claim type.
- Persist results keyed by commit and model version so trends across changes are visible.
- Wire into CI so regressions block merges.
