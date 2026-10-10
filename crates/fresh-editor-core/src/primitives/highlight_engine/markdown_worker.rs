//! A bounded, non-blocking parser for a Markdown buffer. The worker owns its
//! parser/checkpoints; the UI owns its display cache. Neither shares a lock.
use super::{CachedSpan, StructureLines, TextMateEngine};
use crate::model::{
    buffer::{Buffer, BufferSnapshot},
    filesystem::FileSystem,
};
use crate::theme::{Theme, THEME_LIGHT};
use std::{
    ops::Range,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc,
    },
};
use syntect::parsing::SyntaxSet;

#[derive(Clone, Copy)]
pub(super) enum Edit {
    Insert(usize, usize),
    Delete(usize, usize),
}

#[derive(Clone)]
pub(super) struct Key {
    pub version: u64,
    pub generation: u64,
    pub range: Range<usize>,
    pub context: usize,
}

impl Key {
    fn covers(&self, other: &Self) -> bool {
        self.version == other.version
            && self.generation == other.generation
            && self.range.start <= other.range.start
            && self.range.end >= other.range.end
            && self.context >= other.context
    }
}

struct Spec {
    key: Key,
    snapshot: Arc<BufferSnapshot>,
    fs: Arc<dyn FileSystem + Send + Sync>,
}

struct Request {
    spec: Spec,
    edits: Vec<Edit>,
    reset: bool,
}

pub(super) struct Response {
    pub key: Key,
    pub cache: Option<DisplayCache>,
    pub structure: StructureLines,
}

// ParseState carries native Oniguruma state and stays on its owning thread.
// Only byte ranges and syntax categories cross back to the UI.
pub(super) struct DisplayCache {
    pub range: Range<usize>,
    pub spans: Vec<CachedSpan>,
}

pub(super) struct MarkdownWorker {
    sender: SyncSender<Request>,
    receiver: Receiver<Response>,
    generation: u64,
    cancellation: Arc<AtomicU64>,
    in_flight: Option<Key>,
    pending: Option<Spec>,
    ready: Option<Key>,
    snapshot: Option<(u64, Arc<BufferSnapshot>)>,
    edits: Vec<Edit>,
    reset: bool,
    failed: bool,
}

impl MarkdownWorker {
    pub fn new(syntax_set: Arc<SyntaxSet>, syntax_index: usize) -> std::io::Result<Self> {
        let (sender, requests) = mpsc::sync_channel::<Request>(1);
        let (results, receiver) = mpsc::sync_channel(1);
        let cancellation = Arc::new(AtomicU64::new(0));
        let worker_generation = cancellation.clone();
        std::thread::Builder::new()
            .name("markdown-parser".into())
            .spawn(move || {
                let mut engine = TextMateEngine::new(syntax_set, syntax_index);
                let theme = Theme::load_builtin(THEME_LIGHT).expect("built-in theme");
                while let Ok(request) = requests.recv() {
                    let Request { spec, edits, reset } = request;
                    engine.cancellation = Some((worker_generation.clone(), spec.key.generation));
                    if reset {
                        engine.invalidate_all();
                    }
                    for edit in edits {
                        match edit {
                            Edit::Insert(p, n) => engine.notify_insert(p, n),
                            Edit::Delete(p, n) => engine.notify_delete(p, n),
                        }
                    }
                    // Parsing and all reads from the snapshot happen on this thread.
                    let mut buffer = Buffer::new(0, spec.fs);
                    buffer.restore_buffer_state(&spec.snapshot);
                    engine.highlight_viewport(
                        &buffer,
                        spec.key.range.start,
                        spec.key.range.end,
                        &theme,
                        spec.key.context,
                    );
                    let mut structure = engine.structure_lines_in(&buffer, spec.key.range.clone());
                    // An in-progress native regex cannot be interrupted, but
                    // subsequent lines stop parsing as soon as an edit arrives.
                    let superseded =
                        worker_generation.load(Ordering::Relaxed) != spec.key.generation;
                    if superseded {
                        engine.invalidate_all();
                        structure = StructureLines::default();
                    }
                    let cache = engine.cache.as_ref().map(|cache| DisplayCache {
                        range: cache.range.clone(),
                        spans: cache.spans.clone(),
                    });
                    if results
                        .send(Response {
                            key: spec.key,
                            cache,
                            structure,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })?;
        Ok(Self {
            sender,
            receiver,
            generation: 0,
            cancellation,
            in_flight: None,
            pending: None,
            ready: None,
            snapshot: None,
            edits: Vec::new(),
            reset: true,
            failed: false,
        })
    }

    pub fn edit(&mut self, edit: Edit) {
        self.generation = self.generation.wrapping_add(1);
        self.cancellation.store(self.generation, Ordering::Relaxed);
        self.ready = None;
        self.edits.push(edit);
        // If typing outpaces parsing, retain only the latest snapshot rather
        // than building an unbounded edit history.
        if self.edits.len() > 1024 {
            self.edits.clear();
            self.reset = true;
        }
    }

    pub fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.cancellation.store(self.generation, Ordering::Relaxed);
        self.ready = None;
        self.pending = None;
        self.snapshot = None;
        self.edits.clear();
        self.reset = true;
    }

    pub fn request(&mut self, buffer: &Buffer, range: Range<usize>, context: usize) {
        if self.failed {
            return;
        }
        let mut key = Key {
            version: buffer.version(),
            generation: self.generation,
            range,
            context,
        };
        if self.ready.as_ref().is_some_and(|k| k.covers(&key)) {
            return;
        }
        if let Some(previous) = self
            .pending
            .as_ref()
            .map(|s| &s.key)
            .or(self.in_flight.as_ref())
        {
            if previous.covers(&key) {
                return;
            }
            if previous.version == key.version && previous.generation == key.generation {
                key.range.start = key.range.start.min(previous.range.start);
                key.range.end = key.range.end.max(previous.range.end);
                key.context = key.context.max(previous.context);
            }
        }
        let snapshot = match &self.snapshot {
            Some((version, snapshot)) if *version == key.version => snapshot.clone(),
            _ => {
                let snapshot = buffer.snapshot_buffer_state();
                self.snapshot = Some((key.version, snapshot.clone()));
                snapshot
            }
        };
        self.pending = Some(Spec {
            key,
            snapshot,
            fs: buffer.filesystem().clone(),
        });
        self.submit();
    }

    fn submit(&mut self) {
        if self.in_flight.is_some() || self.failed {
            return;
        }
        let Some(spec) = self.pending.take() else {
            return;
        };
        if spec.key.generation != self.generation {
            return;
        }
        let key = spec.key.clone();
        let request = Request {
            spec,
            edits: std::mem::take(&mut self.edits),
            reset: std::mem::take(&mut self.reset),
        };
        // There is at most one outstanding job and one coalesced latest job.
        if self.sender.try_send(request).is_ok() {
            self.in_flight = Some(key);
        } else {
            self.failed = true;
            tracing::warn!("Markdown parser worker unavailable");
        }
    }

    pub fn poll(&mut self, version: u64) -> Option<Response> {
        let response = match self.receiver.try_recv() {
            Ok(response) => {
                self.in_flight = None;
                if response.key.version == version && response.key.generation == self.generation {
                    self.ready = Some(response.key.clone());
                    Some(response)
                } else {
                    None
                }
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.failed = true;
                self.in_flight = None;
                None
            }
        };
        self.submit();
        response
    }

    pub fn failed(&self) -> bool {
        self.failed
    }
}

impl Drop for MarkdownWorker {
    fn drop(&mut self) {
        // Closing a buffer cancels its pending parse; never join on the UI.
        self.cancellation.fetch_add(1, Ordering::Relaxed);
    }
}
