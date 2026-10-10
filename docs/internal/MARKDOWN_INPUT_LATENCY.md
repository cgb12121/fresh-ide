# Markdown input latency

## Reproduction and cause

The PayMeNow `Workspace/Backlog/Sprint-01-Core-Hardening/SPRINT-BOARD.md`
reproduction has 15,384 bytes and 128 lines. Its slowest lines are prose after
the tables, with many inline code spans. The bundled Syntect Markdown grammar
expands an expensive table-start lookahead into the main block dispatcher. On
these non-table lines, the lookahead spends hundreds of milliseconds rejecting
the match. Both highlighting and `structure_lines_in` used this grammar on the
render thread, including in source mode.

## Changes

- The built-in grammar's table lookahead now first checks for a literal pipe on
  the line. This is a necessary condition for the original expression to match;
  the original expression and capture numbers are preserved.
- Structure classification is cached by buffer version and covered byte range.
  Insert, delete and complete invalidation clear this cache.
- Desktop Markdown buffers parse on a worker that owns its parser and native
  regex state. Only ranges, categories and structural roles cross to the UI.
  Colors are resolved using the current UI theme.
- Requests use immutable buffer snapshots, copied once per requested version.
  One job runs at a time, with one coalesced latest request. Edit history is
  bounded; oversized histories reset the worker parser from the latest snapshot.
- A generation counter cancels obsolete parsing between lines. A native regex
  already running cannot be interrupted. Replies must match the live buffer's
  version and generation. Closing a buffer cancels without joining the worker.
- Pending classification leaves plugin lines unseen, so the renderer retries
  them rather than treating pending metadata as a permanent absence. Editor
  ticks poll completion and request repaint, including when input is idle.

## Release measurements

Same Board contents, measured by `markdown_latency_probe`. These are individual
samples, not an isolated benchmark suite; release linking was also running.
The baseline option selects the original grammar in the current core, so it
includes the new structure cache, not the complete old editor implementation.

| Operation | Original grammar | Fixed grammar, synchronous |
| --- | ---: | ---: |
| Cold highlighting | 834.89 ms | 15.70 ms |
| Initial structure classification | 789.67 ms | 7.23 ms |
| Structure classification after insertion | 809.95 ms | 5.19 ms |

With the worker enabled, the UI calls took 0.00–0.01 ms in this probe. Worker
delivery took 20.15 ms initially and 17.05 ms after insertion. The latter
includes two queued range requests and the probe's 1 ms polling interval.
Unchanged classification was a cache hit (below the printed 0.01 ms resolution).
These numbers do not measure terminal I/O or the user's complete live session.
Snapshot creation still copies loaded text; very large buffers need separate
measurement of that cost.

## Validation and reproduction commands

- `cargo test -p fresh-editor-core --test markdown_latency`: three checks for
  grammar scope preservation, structural cache invalidation, and worker results
  after an edit burst and reload.
- `cargo test -p fresh-editor --test all_tests markdown_fenced_code_highlighting -- --test-threads=1`:
  four rendered fence/highlighting checks, including typing in a fence.
- `cargo test -p fresh-editor --test all_tests markdown_compose_table_structure -- --test-threads=1`:
  four table paging, border, alignment and wrapping checks.
- `markdown_latency_probe <path> --compare-scopes`: exact scope operations
  matched on all 128 lines of the real reproduction.

Build the probe with `cargo build --release -p fresh-editor-core --example
markdown_latency_probe`, then run `target/release/examples/markdown_latency_probe`
with the Markdown path. Options: `--baseline` uses the original grammar;
`--background` measures UI calls and worker delivery; `--compare-scopes` compares
the original and optimized grammar; `--regex-profile` profiles individual original
grammar expressions on reproduction line 124.
