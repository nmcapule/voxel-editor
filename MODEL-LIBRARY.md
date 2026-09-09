# Shared Model And Scene Libraries

One server has shared model and scene libraries. There are no accounts, ownership rules, or deletion endpoint. Everyone who can reach the server can read and update every model and scene. Browser recovery is separate from these libraries; the trusted-server deployment model is unchanged.

## Run

- `bun install`, then `bun run dev` starts Vite and a private loopback API on an ephemeral port. Vite proxies `/api/models` and `/api/scenes` on the app's origin. Existing Vite arguments such as `--host 0.0.0.0` still work.
- `bun run dev:assistant` includes the same library; the assistant proxy is unchanged.
- `bun run build`, then `bun run preview` starts Vite preview with the same API and storage.
- `bun run build`, then `bun run start` serves only built files in `dist` plus the API, without Vite. Missing files return 404, not the app HTML. `HOST` defaults to `127.0.0.1`; `PORT` defaults to `4173`.
- `bun test scripts/model-thumbnail.test.ts scripts/model-server.test.ts vite.config.test.ts` runs the renderer, integration, and existing gzip checks; `bun run typecheck` includes the server, renderer, and launcher.
- `bun test src/editors/scene/document.test.ts src/editors/scene/renderer.test.ts src/app/scene-model-bridge.test.ts scripts/scene-server.test.ts` covers scene metadata/recovery, streaming/render budgets, workspace transitions, server CAS, and portable files. Existing model-library/thumbnail coverage remains applicable.

Startup errors exit nonzero. SIGINT/SIGTERM stop the listener, close SQLite, and stop the Vite child when present.
The API and launcher use Bun. Vite runs on Node because its config-change restart
hangs under Bun with an active browser connection; Node must also be installed.

## Storage And Backups

The database is `data/models.sqlite`, resolved relative to the project root, not the current working directory. `VOXEL_DATA_DIR` overrides the directory for all commands; relative overrides are also project-root-relative. Keep it outside `dist` and on persistent local storage with working SQLite locks. Production refuses a data directory inside `dist`. The default `data/` is gitignored; separately exclude any custom directory from version control and static hosting.

The same database also holds `scenes`, `scene_assets`, `scene_instances`, and immutable
`scene_blobs`. Back up these together with models; scene asset provenance does not
depend on a live model-library row. There is no blob garbage-collection endpoint.

SQLite uses WAL journaling, `synchronous=FULL`, and a busy timeout. The `models.sqlite-wal` and `models.sqlite-shm` files can accompany the database while running. **Do not copy only the main database while the server is running**: committed data may still be in the WAL. For a simple backup, stop all dev/preview/production processes using this database, then copy the complete data directory. For a live backup, use SQLite's online backup API or the `sqlite3` CLI `.backup` command. Restore with all server processes stopped. Keep backups outside publicly served directories.

## Trusted Deployment

This is a trusted shared server, not a public multi-tenant service. Loopback is the safe default. To share it, use a private network or an authenticated HTTPS reverse proxy with appropriate access and request-size limits. Do not expose an unauthenticated writable library to the public internet. Both APIs have no CORS support and reject foreign Origin/Referer and cross-site Fetch Metadata. Metadata writes require JSON; scene blob uploads require `application/octet-stream`. These are browser cross-site defenses, **not authentication**; command-line clients without browser headers are allowed.

Standalone production validates `Host` before serving either files or the API, independently of Origin. Defaults allow only `localhost`, `127.0.0.1`, `::1`, and the configured concrete `HOST` bind hostname/IP. Binding to `0.0.0.0` or `::` does not allow other hosts. Add private deployment names/IPs with `VOXEL_ALLOWED_HOSTS`, a comma-separated list of exact names without schemes, ports, or wildcards. Names are case-insensitive; a trailing DNS dot is ignored. IPv6 entries may be bare or bracketed. For example, `HOST=0.0.0.0 VOXEL_ALLOWED_HOSTS=studio.example,192.168.1.20 bun run start` permits those two deployment addresses in addition to loopback. Unknown hosts receive HTTP 400, even without Origin/Referer headers.

The Vite launcher explicitly delegates host validation to Vite because its API is private on loopback; Vite's existing allowed-host rules remain unchanged. It also enables forwarded-origin handling. Preserve the original Host/Origin headers; when a trusted upstream rewrites Host or terminates TLS, it must replace `X-Forwarded-Host` and `X-Forwarded-Proto` with the original public host and scheme. Production ignores forwarded headers unless `VOXEL_TRUST_PROXY=1` is explicitly set. This does **not** disable production host validation: both `Host` and any trusted `X-Forwarded-Host` must be allowed. For an HTTPS proxy forwarding to loopback, use `VOXEL_ALLOWED_HOSTS=studio.example VOXEL_TRUST_PROXY=1 bun run start`; if the proxy uses another internal Host, add that exact name too. Enable forwarded headers only behind a trusted proxy that sanitizes them, with direct API access blocked. Never rewrite Origin to make foreign requests appear same-origin.

## API

All endpoints are same-origin under `/api/models`. IDs are server-generated UUIDs. Times are UTC ISO 8601 strings. A `ModelSummary` is:

```ts
{
  id: string; name: string; tags: string[]; version: number;
  createdAt: string; updatedAt: string;
  dimensions: { x: number; y: number; z: number }; voxelCount: number;
}
```

- `GET /api/models?q=...&tag=...&offset=...` returns `{ models: ModelSummary[], tags: string[], total: number }`. Pages contain at most 50 summaries, newest `updatedAt` first, with a stable ID tie-break. Offset defaults to 0 and must be a non-negative safe integer. `q` is a case-insensitive literal substring of a name or any tag; `%` and `_` are not wildcards. `tag` is a case-insensitive exact tag filter. Both filters apply together. `total` counts filtered models; `tags` is the global distinct sorted lowercase tag list, independent of filters or pagination. Browse queries never read full snapshots/chunks.
- `GET /api/models/:id` returns the summary fields plus `snapshot: ProjectSnapshot`.
- `GET /api/models/:id/thumbnail.png?v=<model.version>` returns a **256 x 256, 8-bit RGBA PNG** with a transparent background. Derive this URL from the existing summary's `id` and `version`; list/load metadata has no new fields. HEAD is also supported without a body or generation. See thumbnail caching below.
- `POST /api/models` accepts `{ snapshot, tags }`, creates a model at version 1, and returns its summary with HTTP 201.
- `PUT /api/models/:id` accepts `{ snapshot, tags, version }` and returns the updated summary. Version must be the positive integer from the last open/save. The atomic version check increments it on success; a stale update returns HTTP 409 without changing any data. Reopen the newer model or POST a copy instead.

Errors are `{ error: string }`: HTTP 400 for invalid input/host/origin/method, 404 for missing entries/files or unknown model subroutes, 409 for version conflict, 413 for an oversized body, and 500 for unexpected server/storage failure. No deletion or cross-origin preflight endpoint exists. GET never changes authored model data; an image GET may populate its derived thumbnail cache. HEAD is read-only and has no body, including for errors. Thumbnail requests use the same host/origin/Fetch Metadata defenses as the rest of the API, including cache hits and conditional requests; images have `Cross-Origin-Resource-Policy: same-origin` and no CORS support.

The request body limit is **100 MiB**, including JSON and base64 overhead, enforced during streaming even without Content-Length. Compressed request bodies are not accepted. Tags must be an array of strings: trim, lowercase, deduplicate, ignore blank strings, then allow at most 20 distinct tags of at most 40 JavaScript characters each. Commas and control characters are rejected, even in otherwise blank entries. Names, dimensions, chunks, layers, palettes, materials, and view settings are validated by the existing `parseProjectSnapshot` protocol parser. `voxelCount` counts occupied entries across all layers, including hidden/overlapping voxels, not just the visible composition.

Snapshots retain the authored voxel data, layers, palette occupancy (including black), scalar material properties, and view settings. They **do not contain texture image binaries, camera pose, or undo/redo history**. Saving to this library is not a backup of those omitted editor resources. There are no per-library quotas or rate limits; set deployment limits and monitor disk usage for a shared installation.

## Scene Recovery

Inserting a library model copies its snapshot into a scene-local `SceneAsset`.
Optional `source: { id, version }` is provenance only, not a live link. Instances
share that asset until Make unique creates another asset identity; immutable chunk
blobs can remain deduplicated. Child edits never PUT the original library model.

`src/editors/scene/storage.ts` uses separate IndexedDB `voxel-studio-scenes` stores for
scene headers, assets, instances, blobs, and the active recovery marker. Autosave
writes changed asset/instance records plus the header/context in one transaction;
a save-token compare-and-swap (CAS) blocks stale-tab overwrites, including equal
revisions. Conflicts keep the current work and require export or explicit reload.
The context can retain scene camera, selection, library link, and editing asset ID,
but not undo history. Standalone recovery is not replaced by child editing.
Scene recovery is read only after opening **Project menu > Plugins > Scene editor**.
Refresh starts in the standalone model editor; returning to it from the plugin
retains the scene recovery marker and data for a later explicit opening.

**Local recovery does not guarantee a complete offline scene.** Remote hash references
may remain uncached; missing chunks load from the same-origin server and are verified
before caching. Reopening/editing, full-detail rendering, or export may require being
online. A successful `.vscene` export is self-contained for voxel data, not images.

Texture image bytes are session-only. `src/editors/model/editor.ts` retains map-set
payloads per model session; `plugins/scene/client.ts` retains child maps by
asset ID within the current scene. Rehydrating that asset can restore maps after
child-history eviction. Opening another scene clears this cache; refresh, reopening
a scene, and Make unique do not transfer images. Recovery, scene-library saves,
and `.vscene` omit images.
The scene renderer currently uses palette/scalar materials, not these child-editor
image maps. Keep original image files separately. Child/standalone session retention
is described in [PRODUCT.md](PRODUCT.md#capabilities-and-constraints); hydration and
undo-eviction limits are in [RENDERING.md](RENDERING.md#scene-resources).

## Scene API

`scripts/scene-server.ts` runs under the same host/origin defenses, error envelope,
tag rules, storage, and launch modes as the model API. Scene IDs are server-generated
UUIDs, independent of the manifest ID; server `version` is separate from manifest
`revision`. `SceneSummary` is:

```ts
{
  id: string; name: string; tags: string[]; version: number;
  createdAt: string; updatedAt: string;
  instanceCount: number; assetCount: number; voxelCount: number;
}
```

- `GET /api/scenes?q=...&tag=...&offset=...` returns `{ scenes: SceneSummary[], tags: string[], total: number }`, with the model library's literal search, exact-tag filter, 50-entry pages, ordering, and global tag-list semantics. Browsing reads summaries, not assets or voxel bytes.
- `GET /api/scenes/:id` returns summary fields plus `snapshot: SceneManifest`, without chunk byte payloads. Scene list/load also support bodyless HEAD. There is no scene-thumbnail endpoint.
- `POST /api/scenes` accepts `{ snapshot, tags }`, creates version 1, and returns a summary with HTTP 201.
- `PUT /api/scenes/:id` accepts `{ snapshot, tags, version }`; atomic CAS increments the server version or returns 409 without partial publication. Reopen the newer scene or POST a copy.
- `POST /api/scenes/blobs/check` accepts `{ hashes: string[] }` with at most 1,000 lowercase SHA-256 hashes and returns deduplicated `{ missing: string[] }` (70,000-byte request cap, or a lower configured cap).
- `PUT /api/scenes/blobs/:hash` accepts exactly 4,096 uncompressed binary bytes, verifies SHA-256, and returns `{ hash }`. Uploads are immutable/idempotent; short bodies fail with 400 and oversized bodies with 413, including streamed bodies without Content-Length.
- `GET /api/scenes/blobs/:hash` returns those bytes with immutable one-year caching and a hash ETag; conditional GET and bodyless HEAD are supported.

Save uploads missing deduplicated blobs first (client batches up to eight uploads),
then publishes metadata within the **100 MiB JSON request limit**. Publication checks
each descriptor's count, colors, 4-cubed LOD and bounds against metadata derived from
verified bytes at upload; absent or inconsistent chunks reject the whole scene.
The summary's `voxelCount` sums each instance's source asset count, including repeated,
hidden, and overlapping layer voxels, not unique world occupancy. Publication reads
stored blob descriptors, not raw voxel arrays. It updates only changed asset/instance
records in the CAS transaction, although the HTTP write sends the complete manifest.

## Scene Files

`SceneManifest` in `src/editors/scene/types.ts` has schema `voxel-studio/scene`, version 1,
identity/revision, extent, settings, scene layers/active layer, assets, and instances.
Each asset carries a project header without byte chunks, pivot/bounds/count,
optional provenance, and chunk descriptors (`id`, `layerId`, `blob`, `count`,
`bounds`, `colors`, `lod`). Instances reference assets/layers and store independent
TRS. Parsing validates references, finite transforms, counts, and the combined
[metadata limits](RENDERING.md#scene-resources), without hydrating all voxel bytes.

`.vscene` is UTF-8 newline-delimited JSON (`application/x-ndjson`), not VOX or one
giant JSON array. `src/editors/scene/library.ts` writes records with these TypeScript shapes:

```ts
{ schema: 'voxel-studio/scene-file', version: 1, snapshot: SceneManifest }
{ type: 'chunk', hash: string, dataBase64: string } // one per distinct referenced hash
```

The first line is a header bounded to **100 MiB**; following records are bounded to
**8,192 bytes** each and encode exactly **4,096 bytes** (5,464 canonical base64
characters). Import streams bounded records, validates hashes and descriptors, and
rejects missing, duplicate, unexpected, or malformed chunks even if locally cached.
It allows at most 262,144 references and preflights total file size against the
header-plus-record limits; it never reads the whole file as text.

Writable-file browsers export one verified chunk at a time, with abort on failure.
Without writable-file support, the in-memory Blob download is limited to **64 MiB**
including header/base64 overhead, rejected before chunk reads. Use native writable
files or the scene library for larger exports. Chunk reads are bounded to 4,096 bytes;
streaming does not eliminate the bounded manifest's own memory cost.

## Thumbnail Rendering

Thumbnails show actual occupied cubes from a fixed orthographic **+(1,1,1)** isometric view, with Y up, centered and fitted to projected visible occupied bounds with a 16-pixel margin. CPU ray DDA selects the nearest occupied geometry at each pixel. The existing `VoxelDocument` visible composition ignores hidden layers, includes locked visible layers, and lets the topmost visible layer win at overlaps. Nonzero palette indices remain occupied even when their RGB color is black. Chunk insertion order does not affect the result. Empty and fully hidden models produce a completely transparent PNG of the same dimensions.

This is a **shape/color preview, not a PBR render**. Palette RGB channels have fixed face multipliers: +Y (top) 1.0, +X 0.8, +Z 0.6. Occupied pixels are opaque. Roughness, metalness, emission, opacity, transmission, IOR, textures, camera pose, and authored lighting/background/grid settings are not simulated. Each pixel uses one center ray, so subpixel details can disappear; there is no antialiasing, floor, shadow, or browser/WebGL rendering.

The renderer has no added dependencies: it uses a byte-per-cell visible color field, fixed-size pixel buffers, and native `node:zlib` deflate/CRC32 for PNG encoding. At the protocol maximum of 256 cubed, the field is **16 MiB**, there are **65,536 rays with at most 768 cell visits each**, and the PNG is **under 264 KiB** even for poorly compressible pixels. It never builds per-voxel polygons, SVG, or an unbounded image. These are renderer ceilings, not a total process memory limit: snapshot JSON/base64 parsing and document composition still scale with stored chunks/layers, bounded by the existing 100 MiB write request limit.

## Thumbnail Caching

SQLite stores one nullable `thumbnail BLOB` per model. Startup checks `PRAGMA table_info(models)` and adds the column with `ALTER TABLE` for older databases, without backfilling or rewriting old rows. New saves also leave it NULL. Startup, browse, model load, and HEAD never render. An unconditional image GET generates a missing thumbnail and persists it; later hits select only the model version and PNG, **never the snapshot**. Cache entries survive restarts and do not change model timestamps, versions, or summaries.

A successful PUT sets the thumbnail to NULL **inside the same atomic, version-checked model update**. Stale or failed saves retain the old cache. Cold generation rechecks the cache and reads/renders/writes within an immediate SQLite transaction, preventing another server process from saving a newer snapshot between generation and cache storage. Generation is synchronous: a cold request blocks this Bun process and holds the database writer lock until completion. Shared installations with heavy cold-image traffic may need a worker and version-checked cache write; this implementation has no background rendering or job queue.

Images use **`Cache-Control: no-cache` plus a weak ETag containing the model ID, model version, and renderer revision**. Clients may retain bytes but must revalidate before reuse; a matching `If-None-Match` receives a bodyless 304 without rendering, even if the SQLite cache is empty. `v` is a client cache-key hint, not historical version selection: omitted, old, or future values all serve the current model and current ETag. Thus even an old URL cannot keep serving stale pixels after a successful update. HEAD returns the current ETag and image type, and includes the PNG Content-Length when already cached; it never decodes a snapshot or fills the cache.

## Thumbnail Checks

Renderer tests independently verify PNG chunk CRCs (including the standard `123456789` CRC32 vector), dimensions, filters, alpha, face shading, 3D depth against per-cube ray intersections, occupied-bound fitting, hidden/overlapping/black voxels, deterministic ordering, and sparse 256-cubed output. API tests cover lazy create/load, conditional GET and read-only HEAD, persistence/restart, snapshot-free cache hits, atomic invalidation and failed saves, legacy rows without backfill, route errors, origin/host checks, and dev/preview proxying.

Run the optional end-to-end benchmark with `VOXEL_THUMBNAIL_BENCHMARK=1 bun test scripts/model-server.test.ts -t 'thumbnail benchmark'`. On Linux, prefix the `bun` command with `/usr/bin/time -v` for peak process RSS. It creates temporary SQLite databases and removes them afterward; timings include HTTP GET, cold snapshot decode, composition, rendering, compression, and cache persistence, or a full cached PNG response. Fixture construction and POST are outside the reported GET timing.

Sample on x86_64 Linux, Bun 1.3.14 (machine/load dependent):

| 256-cubed fixture | Cold GET | Five cached GETs | PNG bytes |
| --- | ---: | ---: | ---: |
| Two occupied opposite corners | 154 ms | 0.11-0.43 ms | 2,057 |
| 4,097 occupied voxels across all 4,096 chunks | 1,489 ms | 4.07-7.57 ms | 1,818 |
| 16,777,216 occupied voxels, noisy 255-color palette | 1,800 ms | 4.37-13.53 ms | 59,557 |

The sparse/all-chunks and dense snapshots were each 21.53 MiB of JSON. Peak RSS for the whole sequential benchmark process was about **410 MiB**, including the test's authored fixtures, HTTP client, server, SQLite, JSON/base64 buffers, and garbage-collector overhead; this is not the renderer's incremental memory use. Both the sparse long-ray case and fully occupied model remain fixed-size PNGs with the same 16 MiB maximum color field.
