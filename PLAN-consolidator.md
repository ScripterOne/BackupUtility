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

**Recorded risk on the archive ruling, accepted by the operator:** unpacking and deduping inner
files breaks **ROM sets**. MAME and most emulators require one `.zip` per game containing exact
member files and CRCs; a rebuilt or partially-deduped archive is not the same artifact. The
mitigation is that **nothing is ever deleted by this program** (§6), so sealed originals survive
until a separate, explicit decision is made about them. Flagged once here; not re-litigated.

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
| Catalogue | **Postgres on Ham** | millions of rows; already running, already backed up |
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

## 6. The phases

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

## 7. Rules

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

## 8. What gets reused

- **`filetypes2.psd1`** — the category taxonomy, unchanged.
- **The robocopy pattern** from `ZillaAI/tools/repo-backup/backup-to-ham.ps1`: UNC not mapped
  drives (a scheduled task does not inherit `Z:`), exit<8 is success, phase-level status file.
- **SHA-256** approach from `DeDuplicator.ps1`.
- The Next.js dashboard stack, Postgres on Ham, the orchestrator, Playwright for verification.

## 9. Order of work

0. **Write-test the destination path** (§3). Everything else is built on it.
1. Catalogue schema + the inventory agent. Read-only, harmless, and it turns "duplicates in
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
