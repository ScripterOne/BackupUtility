# The Consolidator — plan

**Operator, 2026-09-20:** *"I have duplicate data in 100's of thousands of places, and what I want
the backup program to do is start working it out."* … *"I want a new Program. Real GUI, Web Based
… The Idea is to get some Large drives freed up … aggregate a single copy of each file on all the
other machines. That's the deduplication I want."*

A new program, superseding `BackupUtility.ps1` + `DeDuplicator.ps1`. This document is the plan,
not the build.

---

## 1. Why the old pair produced the problem it was meant to solve

`BackupUtility.ps1` resolves a destination collision by **keeping both copies**:

```powershell
if (Test-Path $destinationFile) {
    $timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $newFileName = "$fileNameWithoutExtension`_$timestamp$fileExtension"
}
Copy-Item -Path $file.FullName -Destination $destinationFile
```

It never asks whether the file it is about to copy is the *same* file. So every re-run duplicates
everything whose name already exists at the destination, and every additional source drive
multiplies it again. `DeDuplicator.ps1` exists to mop up afterwards — the pair is a generator and
a mop.

It also **destroys provenance**: files land flat in `$rootFolder\<extension>\`, so
`C:\projects\foo\readme.md` and `C:\docs\bar\readme.md` become one `readme.md` and one
`readme_20260920103000.md`, and nothing records where either came from. That is what makes the
existing pile hard to sort — not the duplication, but that the duplicates lost their addresses on
the way in.

**Two non-negotiables fall straight out of that, and they are the spine of the new design:**

- **Idempotent.** Re-running must be a no-op, never a doubling.
- **Provenance-preserving.** Every copy in the catalogue knows every place it was seen.

`filetypes2.psd1` is **kept**. The taxonomy is the operator's judgement about what is worth
harvesting, and it is the reason this is not a 36 TB problem.

---

## 2. Operator rulings, 2026-09-20

| Decision | Ruling |
| --- | --- |
| Destination | The two ex-HyperDeck drives hang off **LabZilla**, ~40 TB. **Multiple destination volumes are fine** — the aggregate is not expected to fit on one. |
| Archives | **Index the contents of everything, dedupe inner files.** |
| Photos | **Exact hash only.** No perceptual/near-duplicate matching. |
| Copy engine | **Use ROBOCOPY where we can.** |
| OS files | An **option to ignore** operating-system files. |
| GUI | **Real GUI, web based.** |
| Scope | **Personal data. Arcade-machine drives are OUT for now.** |
| Database | **The tool owns its own.** A self-contained catalogue, not a table in someone else's server. |

**The archive ruling's main risk is now out of scope.** Unpacking and deduping inner files breaks
**ROM sets** — MAME and most emulators require one `.zip` per game with exact member files and
CRCs. With the **arcade-machine drives excluded** (operator, 2026-09-20) that exposure largely
disappears. It is kept on the record because ROM and disc-image archives turn up in personal
storage too, and because the arcade drives come into scope eventually. The standing mitigation is
R3: **this program never deletes anything.**

**Space is gained by RETIRING DRIVES, not by recovering bytes in place.** *(Operator,
2026-09-20: "we will gain space after we can delete a drive because its data has been deduped
safely stored.")* See §4 — this is the operating model, and it dissolves the capacity problem.

**Number to confirm:** the operator wrote *"the net result will likely be around 80GB"*. Read as
**80 TB** for planning. With the drain-and-retire loop the aggregate never has to hold everything
at once, so this figure sizes the *end state*, not the starting pool.

---

## 3. BLOCKER — the destination write path must be tested first

**LabZilla's existing 45.5 TB of USB storage fails sustained writes.** All four bays are one
multi-bay DAS, chained hub-behind-hub on a single USB root port:

```
UAS Mass Storage Device (serials 915000000C01..C04, sequential)
  <- Generic SuperSpeed USB Hub [9&18b4fc45&0&3]    <-- same instance for all four bays
  <- Generic SuperSpeed USB Hub [MSFT30000000001]   <-- hub behind a hub
  <- USB Root Hub (USB 3.0)
```

Writes above a size threshold fail with `Errno 22` (or robocopy "I/O device error") after a
consistent **~4.2 s bus timeout**. Reads stay reliable, which is why it went unnoticed for two
months and was only caught staging a model checkpoint.

**Aggregating tens of TB is the most write-heavy thing this path could be asked to do.**

**Test before building anything that depends on it:** attach one ex-HyperDeck drive to a root port
that does **not** share the existing DAS hub chain, write 200 GB+ sustained, verify by hash, and
watch for the 4.2 s hang. Pass → LabZilla is the aggregation host. Fail → the topology is at fault
rather than the drives, and the destination moves.

**If a drive will not spin up: try Kapton tape over SATA pin 3 (PWDIS) before declaring it dead.**
That is how `J:` came back as a healthy 20 TB volume on 2026-09-19.

---

## 4. The operating model — drain, verify, retire, absorb

The gain is not recovered bytes on a drive you keep. It is **a whole drive you no longer need**.

That makes this a loop rather than a migration, and the loop **bootstraps**:

```
   [ 40 TB pool ]
         |
         v
  pick the fullest / least healthy source drive
         |
   1. inventory + fingerprint it          (read-only)
   2. copy its files that are not already  (robocopy /Z)
      in the pool
   3. verify every copy by hash
   4. prove 100% of the drive is accounted for
         |
         v
   5. operator wipes the drive
         |
         v
   6. THE EMPTY DRIVE JOINS THE POOL  -----+
         |                                  |
         +----------------------------------+
                  pool is now larger
```

**Consequence: the destination never has to hold everything at once.** A 40 TB pool can consolidate
an 80 TB estate, because every drained drive returns its full capacity to the pool while the data
it held collapses to one deduplicated copy. The pool grows as the sources shrink. The only real
constraint is that the pool must be larger than the largest single source drive plus headroom —
not larger than the estate.

**Sequence matters.** Drain the *least healthy* drives first, not the fullest: a drive that is
failing is one you want emptied while it can still be read. The ex-HyperDeck drives, the enclosure
that needed a power-cycle to re-enumerate, and anything that has ever thrown an I/O error go early.

### THE RETIREMENT GATE

A drive becomes retirable only when **every single file on it** is either:

- **(a)** hash-verified present in the pool, or
- **(b)** a byte-identical duplicate of a file that is hash-verified present in the pool.

**100%, not 99%.** One unreadable file, one permission denial, one path too long, one encrypted
archive that could not be indexed — **any of these blocks retirement** and appears as a finding
(R6). A drive that is "basically done" is a drive that is not done, and the whole point of this
exercise is that the estate has already lost one irreplaceable library to exactly that reasoning.

Per-drive state, and the primary view in the GUI:

`discovered -> inventoried -> fingerprinted -> draining -> drained -> verified -> RETIRABLE -> retired -> absorbed`

with, on every row: bytes unique to this drive, bytes already elsewhere, files unaccounted for, and
the blocking findings by name.

---

## 5. Architecture

Reuses the estate's stack rather than inventing one.

| Piece | Choice | Why |
| --- | --- | --- |
| Catalogue | **The tool's own SQLite database** (WAL), owned by the web server process | see §6 — self-contained, portable, and kept out of the production estate |
| GUI | **Next.js**, the dashboard stack | "real GUI, web based"; the patterns and auth already exist |
| Scanner | **agent per machine** (Windows + Linux) reporting to the catalogue | the data spans both; Samba over 36 TB is the slow path |
| Copy engine | **robocopy** on Windows, **rsync** on Linux | operator ruling; `tools/repo-backup/backup-to-ham.ps1` already proves the robocopy pattern here |
| Long jobs | orchestrator work orders | scans take hours; they need to survive a browser tab closing |

### Robocopy flags that matter

`/Z` restartable mode — a 40 TB aggregation **will** be interrupted.
`/MT:8` multithreaded; tune down on USB.
`/COPY:DAT` data, attributes, timestamps.
`/R:2 /W:5` two retries, five seconds — not the default million.
`/LOG+:` and `/NP` — a per-run log without progress spam.
`/XJ` skip junctions, or a reparse-point loop will walk forever.

**Robocopy exit codes below 8 are success.** Treating any non-zero as failure is a classic false
alarm; `backup-to-ham.ps1` already gets this right (`robocopy exit=1 (<8 is success)`).

---

## 6. The catalogue — the tool's own database

*Operator, 2026-09-20: "I think our tool should have its own database to help us keep track of what
will become a massive data inventory. It will also give us a fast lookup source."*

An earlier draft of this plan put the catalogue in **Ham's production Postgres**. That was wrong
twice over:

1. **This indexes personal data.** It has no business living in the business estate's production
   database, mixed in with the orchestrator's work orders and the SIEM's schemas.
2. **It couples a standalone tool to a production service.** The catalogue would then need Ham to
   be up to answer a question about a drive sitting on the desk.

**SQLite, in WAL mode, one file, owned by the web server process.** It handles tens of millions of
rows comfortably with the right indexes, it is backed up by copying one file, it travels with the
tool, and it needs no administration.

**Concurrency, which is the one real constraint:** SQLite is single-writer, and SQLite over SMB is
a known way to corrupt a database. So **agents never touch the file.** Each scanning agent batches
its findings and POSTs them to the web server, which is the only writer. Readers — the GUI, the
lookup — are unlimited under WAL.

### Shape

| table | holds |
| --- | --- |
| `volumes` | machine, label, **serial**, size, filesystem, drain state |
| `files` | volume, full path, size, mtime, quick hash, sha256, parent archive (nullable) |
| `contents` | one row per unique sha256 — size, canonical file, where the pool copy landed |
| `archive_entries` | parent archive, inner path, size, **crc32**, sha256 when resolved |
| `findings` | volume, path, kind, detail — every skip, denial, unreadable file |

`volumes.serial` rather than drive letter: `E:` is not an identity. A drive that moves between
machines, or comes back after a re-letter, must be recognised as the same drive or the whole drain
state is nonsense.

`files` rows **are** the sightings — the same content appearing in nine places is nine `files` rows
pointing at one `contents` row. That is R4 (provenance) expressed as a schema rather than a promise.

### Fast lookup is a first-class feature, not a by-product

The operator asked for it explicitly, and it is arguably the more durable value: **a searchable
index of everything he owns, which outlives the consolidation.** SQLite **FTS5** over filenames and
paths gives sub-second search across tens of millions of rows, including inside archives — "where
is that spreadsheet" answered for a file sitting in a zip on a shelved drive.

Indexes: `(size)` for phase 2 grouping, `(sha256)`, `(quick_hash)`, `(volume_id, path)`, plus the
FTS5 virtual table.

**The catalogue is the asset.** Even if consolidation stopped after phase 3, an estate-wide,
searchable inventory with provenance would be worth having on its own.

---

## 7. The phases

**All phases up to AGGREGATE are strictly read-only.** Only the aggregate phase writes, and only to the destination.

### Phase 1 — INVENTORY (read-only)
Walk every volume on every machine. Record machine, volume, full path, size, mtime, ctime,
attributes. **No hashing.** One walk per volume — not one walk per file type, which is what the old
script did.

*OS-file exclusion* is an option here: path rules (`Windows\`, `Program Files\`, `AppData\`,
`/usr`, `/var`, `node_modules`, `.git/objects`) plus, optionally, the **NSRL known-file hash set** —
NIST publishes hashes of known OS and application files precisely so they can be excluded.

*Archives are detected by magic bytes, not extension.* A `.dat` that is really a zip is common in
exactly this kind of estate.

### Phase 2 — FINGERPRINT (read-only, tiered)
This is what makes the scale tractable:

1. **Group by size.** A file with a unique size cannot have a duplicate — **never hash it.** In a
   typical estate this eliminates most files outright.
2. **Quick hash** the size-collision groups: first 64 KB + last 64 KB + size.
3. **Full SHA-256** only where the quick hash also collides.

Full-hashing everything would be a day or more of solid I/O across enclosures that have already
proven flaky. Tiering turns it into an evening.

### Phase 3 — ARCHIVE INDEXING (read-only)
Open every archive and record each entry: inner path, size, and **CRC32, which zip already stores
in its central directory** — free, and enough to cluster candidates before any decompression.

Formats: zip, rar, 7z, tar(.gz/.bz2/.xz), cab, iso and disc images. Nested archives to a **depth
limit** — zip-in-zip is common and unbounded recursion is not.

**Encrypted or unreadable archives are recorded as findings, never silently skipped.** An archive
that could not be read is a known unknown; one that was skipped quietly is a lie in the catalogue.

### Phase 4 — ANALYSIS
Cluster by content hash. Choose a **canonical copy per group** by an explicit, written rule —
curated path beats scratch path, beats oldest mtime, beats shortest path. Produce the report:
groups, recoverable bytes, the largest offenders, and per-source-drive reclaim potential.

### Phase 5 — AGGREGATE (the only write phase)
Copy **one** canonical copy of each unique file to the destination pool via robocopy/rsync.
Multiple destination volumes; the catalogue records which volume holds what, so the pool is
addressable as one logical library.

**Verify every copy by hash after writing.** A copy that was not verified is a copy that might not
be there.

### Phase 6 — VERIFY
Re-walk the aggregate and confirm every catalogued unique file is present and correct. **Nothing
is reclaimed before this passes.**

### Phase 7 — RECLAIM (operator-gated)
**The program never deletes anything, ever.** It produces a reclaim list per source drive, with
proof that each listed file exists and is verified in the aggregate. The operator approves a drive
at a time.

---

## 8. Rules

**R1 — Idempotent.** Re-running any phase is a no-op on unchanged input. This is the original sin
of the old tool and the single most important property of the new one.

**R2 — Read-only until AGGREGATE.** Inventory, fingerprint, archive indexing and analysis never write
to a source. Ever.

**R3 — Nothing is deleted by this program.** Reclaim emits a list. Deletion is the operator's hand.

**R4 — Provenance is never discarded.** Every unique file records every path it was seen at, on
every machine. The catalogue can always answer "where did this come from."

**R5 — Every phase records its own status.** Phase-level outcome, not a single success flag —
`backup-to-ham.ps1` already does this, and Ham's restic script not doing it is why it lied for 35
days.

**R6 — A skip is a finding.** Unreadable file, encrypted archive, permission denied, path too long:
each is recorded and surfaced. Silent skips are how an incomplete aggregate passes for a complete
one.

**R7 — Verified before reclaimed.** No source file appears on a reclaim list until its canonical
copy has been hash-verified at the destination.

---

## 9. What gets reused

- **`filetypes2.psd1`** — the category taxonomy, unchanged.
- **The robocopy pattern** from `ZillaAI/tools/repo-backup/backup-to-ham.ps1`: UNC not mapped
  drives (a scheduled task does not inherit `Z:`), exit<8 is success, phase-level status file.
- **SHA-256** approach from `DeDuplicator.ps1`.
- The Next.js dashboard stack, Postgres on Ham, the orchestrator, Playwright for verification.

## 10. Order of work

0. **Write-test the destination path** (§3). Everything else is built on it.
1. **The catalogue and its schema**, plus the inventory agent. Read-only, harmless, and it turns "duplicates in
   hundreds of thousands of places" from a feeling into a number.
2. Fingerprint tiering.
3. Archive indexing.
4. Analysis + the web GUI over the catalogue.
5. Aggregate + verify.
6. Reclaim lists and the retirement gate.
7. The drain loop: first drive drained, verified, retired, absorbed — end to end on one real drive
   before it is pointed at the estate.

Steps 1–3 produce value before a single file moves: **the inventory alone answers how bad it is,
what it would recover, and which drive to empty first.**

---

## 11. The product path — what must not be foreclosed

*Operator, 2026-09-20: "We can also eventually add this to ZillaOps when we get done, it will make
people happy to have a powerful Data Tool."*

Build it for one estate. But a handful of decisions are free now and a rewrite later, so take them
now and then stop thinking about it.

**Follow the ZillaCyber boundary.** The established pattern in this estate is a **separate app that
consumes ZillaOps over the wire, never coupled into ZillaAI**. This tool is the same shape: its own
repo, its own catalogue, its own GUI, surfaced *through* ZillaOps rather than absorbed into it.
That is also what keeps a customer's file inventory out of ZillaOps' own database.

**No hardcoded estate.** No machine names, drive letters or paths in code. Volumes are discovered
and keyed on serial (§6); sources are configuration. The moment `E:` or `Hamzilla` appears in a
source file, the product option is gone.

**Keep storage behind a narrow interface.** SQLite is right for one estate and stays right for most
SMB deployments. A customer with a 50-machine fleet will want Postgres. If every query goes through
a small repository layer rather than raw SQL scattered through the app, that is an adapter, not a
rewrite. **This is the single highest-leverage thing to get right at the start.**

**The agent↔server contract gets authentication from day one.** For a personal LAN it is tempting
to skip it. Retrofitting auth onto a protocol that never had it is how you end up with a scanning
agent that will report anyone's filesystem to anyone who asks. A token on every batch POST costs
an afternoon now.

**The multi-tenant shape already exists** — one catalogue per deployment. That was chosen in §6 to
keep personal data out of the production estate, and the same boundary is what isolates one
customer from another. Do not collapse it later for convenience.

### A licensing trap to settle BEFORE choosing archive libraries

Archive-format support is where a shippable product and a personal tool part company:

- **zip / tar / gzip / bzip2 / xz** — open formats, permissive libraries. No issue.
- **7z** — 7-Zip is **LGPL**; fine to use, mind the linking terms.
- **RAR** — **the unrar licence forbids using the source to create a RAR-compatible archiver, and
  carries redistribution conditions.** It is routinely used in personal tools and is a genuine
  question the moment money changes hands.

The estate has already learned the general form of this once: *a code licence is not a
training-reuse right.* Same lesson, different clause. **Decide RAR before writing the extractor**,
not after a customer asks. A clean answer exists — shell out to the user's own installed WinRAR/7-Zip
rather than linking a library — and it is much easier to design in than to retrofit.

**Not yet:** billing, per-tenant RBAC, an installer, cloud storage targets. Those are product work
and this is not a product yet. The list above is only the set of decisions that would be expensive
to reverse.

**OPSEC:** roadmap and product intent are stealth by default. This document lives in a private repo
and the product angle is not published.
