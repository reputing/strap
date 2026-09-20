# Blossom Strap — Performance

A launcher that costs more than it saves is a bad trade. This document records
what Blossom does about that, and — more importantly — how each claim can be
checked.

---

## 1. The honest problem

Blossom is an Electron application. That buys a fast, consistent interface and
costs a Chromium process tree. The mitigations below are real, but the cost is
not zero, and this document does not pretend otherwise.

What we can say precisely:

- **Idle, with no window open, Blossom holds no timers.** Process lifetime comes
  from an OS event subscription; discovery is invalidated by a directory
  watcher. There is no polling loop.
- **Closing the window destroys the renderer.** The Chromium renderer and its
  memory go away; the main process and its subscriptions stay.
- **While a client is running, one 1 Hz sampler runs**, and only if something is
  displaying the numbers it produces.
- **While an overlay is visible, one 2 Hz window-position check runs.** It is a
  no-op when the bounds have not changed. This is the only poll in the product,
  and it exists because Windows has no notification for "another process moved
  its window".

---

## 2. Measured, not asserted

Diagnostics → Benchmarks measures this machine. Every result carries its unit
and its sample count, and a measurement that could not be taken reports
`unavailable` rather than `0`.

| Benchmark | What it actually does |
|---|---|
| Blossom startup | Process start to the main window being ready to show |
| Resident memory | RSS of the main process |
| Cache write / read (256 KB) | 24 real writes and reads to the volume the cache lives on |
| Content hash (256 KB) | 24 real SHA-256 passes — the per-asset deduplication cost |
| Configuration parse | 200 parses of a document shaped like your configuration |
| Cache hit rate | Share of intercepted requests served locally this session |
| Interception overhead | Mean milliseconds added per intercepted request |
| Last Roblox launch | Press-to-process-visible, including applying the profile |

Two figures observed during development, on a 4-thread container under a virtual
display, for calibration rather than as promises: window ready in **282 ms**
from a cold start, main-process bundle **205 kB**.

---

## 3. Startup

The renderer's startup bundle is **262 kB** (221 kB framework + 41 kB shell).
Each page is a separate 6–20 kB chunk fetched the first time it is visited.

This was not free. `electron-vite` leaves the renderer unminified by default,
which is easy to miss because the app still works: the bundle was **902 kB**
before minification was turned on and pages were split. In an Electron app that
is parse time on every cold start, not transfer size.

The framework is pinned to its own chunk so editing a page does not invalidate
it, and so the overlay entry cannot pull it in.

Verify with `npm run build` and read the chunk sizes.

---

## 4. The overlays

The crosshair window is **3.3 kB** and the geometry it shares with the designer
is **0.6 kB**. Neither loads React.

The first implementation did, because sharing a React component between the
designer and the overlay was the obvious way to keep one source of truth. That
put a 613 kB chunk into a 400-pixel transparent window. The fix was to share the
*geometry* — a pure function returning lines, a dot and a circle — and let the
designer render it as JSX while the overlay renders it as SVG DOM. One source of
truth, no framework in the window that sits over the game.

---

## 5. The asset cache

The cache is the part most likely to become a performance problem, because it
grows without bound if nothing stops it.

- **SQLite, not the filesystem.** Search, type filters, size and date ranges,
  duplicate detection and sorting over tens of thousands of rows are index
  lookups. The same operations over a directory listing are full scans — this is
  the specific limitation that a filesystem-shaped cache runs into as it grows.
- **Content-addressed blobs.** Identical bytes are stored once, as a property of
  the layout rather than as a background job. The cache page shows what that
  saved.
- **WAL journaling**, so the capture ingester writing does not block the cache
  browser reading.
- **Metadata only in the database.** Blobs are files; a database holding
  multi-megabyte blobs is a database that has to rewrite them.
- **A byte budget**, enforced by evicting least-recently-used blobs.

The browser is windowed: it renders the rows in view plus a small overscan, over
a keyset-paginated query. Scrolling near the end asks for the next page. The
whole cache never enters renderer memory.

---

## 6. Capture under load

A busy experience requests assets faster than they can be hashed and indexed.
That is a producer/consumer problem, and an unbounded queue there is an
out-of-memory crash waiting for a popular place.

- The ingest queue has a **fixed capacity** and drops **oldest-first**.
- Every drop is **counted and surfaced** — in the capture panel and in the
  interception statistics. A silent drop is a lie about what was captured.
- Events are **coalesced on a 150 ms timer** before crossing IPC. Sending each
  of several hundred events per second individually is what makes a live view
  stutter.
- The queue is **serial by design**. Hashing a hundred assets concurrently
  starves the rest of the process for no gain on a disk-bound workload.

---

## 7. The interception proxy

- **Hosts out of scope are blind-tunnelled** with `net.connect` and two pipes.
  No parsing, no buffering, no decryption.
- **Large bodies stream.** Only responses small enough to be worth caching are
  buffered; everything else is piped straight through.
- **Leaf certificates are cached**, bounded to 64 hosts, because minting an RSA
  key pair per connection would be the single most expensive thing in the path.
- **Overhead is measured**, not assumed. The mean added latency per intercepted
  request is on the Assets page and in the benchmark suite.

---

## 8. Windows integration

Shelling out to PowerShell costs 150–300 ms per invocation. Blossom spawns it
**once**, and speaks newline-delimited JSON to a long-lived agent for process
lists, counters, hardware, window bounds, priority and registry work.

Process lifetime uses a WMI event subscription rather than a `tasklist` loop.
The polling that remains happens inside the WMI service at 2-second granularity,
which is dramatically cheaper than doing it in our own process.

If the agent dies it is restarted with backoff; after five failures Blossom
reports OS integration as unavailable rather than thrashing.

---

## 9. Rules kept while building this

- Never scan the Roblox installation on navigation. Cache it; invalidate on a
  watcher.
- Never parse JSON on the renderer thread. It happens in the main process.
- Never decode an asset because it exists. Previews are fetched on selection and
  released on navigation.
- Never render a list you can window.
- Never run a timer nothing is watching. Sampling is reference-counted.
- Never let a counter, a hit tally or a capture event fail a request.

---

## 10. Where the costs actually are

Being specific about the remaining costs is more useful than claiming there are
none:

- **The Chromium renderer**, while a window is open. Mitigated by closing to
  tray, not eliminated.
- **The window-follow poll**, 2 Hz while an overlay is visible.
- **Hashing captured assets**, ~0.6 ms per 256 KB. Bounded by the queue.
- **TLS termination** for in-scope hosts. Measured and shown.
- **The PowerShell agent**, one idle process while Blossom runs.
