use fresh_editor_core::{
    model::{buffer::Buffer, filesystem::StdFileSystem},
    primitives::{
        grammar::{GrammarRegistry, LocalGrammarLoader},
        highlight_engine::HighlightEngine,
    },
    theme::{Theme, THEME_LIGHT},
};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use syntect::parsing::{ParseState, SyntaxSet};

#[path = "../src/grammars/markdown.rs"]
mod markdown_grammar;

#[test]
fn optimized_grammar_preserves_markdown_scopes() {
    let original = SyntaxSet::load_defaults_newlines();
    let optimized =
        markdown_grammar::optimize_builtin_builder(original.clone().into_builder()).build();
    let definitions = optimized.clone().into_builder();
    let md = definitions
        .syntaxes()
        .iter()
        .find(|s| s.name == "Markdown")
        .unwrap();
    assert!(
        format!("{:?}", md.contexts["main"].patterns[0]).contains("(?=[^\\\\n]*\\\\|)"),
        "table guard must be present"
    );
    let snippets = [
        "Plain `one` and ``two ` three`` with **bold** and *italic*.\n",
        "# Heading `code`\n\nTitle\n=====\n\n---\n",
        "| Header `a` | [link](url) |\n| --- | --- |\n| `a|b` | escaped \\| pipe |\n\nAfter table.\n",
        "Header `a` | Header **b**\n--- | ---\n`x` | *y*\n\n",
        "- **Findings:** `a` `b` `c` `d` `e` `f` `g` `h` `i` `j`.\n",
        "> quoted `code` with | pipes\n\n    indented `code`\n",
        "```java\nString value = \"hello\";\n```\n\n~ fence `inline`\n",
        "[text `code`](url) ![image `alt`](img)\n\n[reference]: url\n",
        "Unicode tiếng Việt `giá trị` và emoji 🐈 | cuối.\n",
        "`unclosed\n\n`balanced` and bare | pipe\n",
    ];
    for text in snippets {
        let mut before = ParseState::new(original.find_syntax_by_extension("md").unwrap());
        let mut after = ParseState::new(optimized.find_syntax_by_extension("md").unwrap());
        for line in text.split_inclusive('\n') {
            assert_eq!(
                before.parse_line(line, &original).unwrap(),
                after.parse_line(line, &optimized).unwrap(),
                "scope operations changed for {line:?}"
            );
        }
    }
}

fn engine(registry: &GrammarRegistry) -> HighlightEngine {
    HighlightEngine::for_file(Path::new("board.md"), None, registry)
}

fn await_structure(
    engine: &mut HighlightEngine,
    buffer: &Buffer,
) -> fresh_editor_core::primitives::highlight_engine::StructureLines {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(structure) = engine.structure_lines_ready(buffer, 0..buffer.len()) {
            return structure;
        }
        assert!(
            Instant::now() < deadline,
            "worker did not deliver current version"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn worker_coalesces_edits_and_matches_current_structure_and_highlighting() {
    let registry = GrammarRegistry::load(&LocalGrammarLoader::embedded_only());
    let theme = Theme::load_builtin(THEME_LIGHT).unwrap();
    let mut buffer = Buffer::from_str(
        "# Title\n\n| A | B |\n| --- | --- |\n| `one` | two |\n\n```java\nint n = 2;\n```\n",
        0,
        Arc::new(StdFileSystem),
    );
    let mut background = engine(&registry);
    background.enable_background_markdown();
    assert!(background
        .structure_lines_ready(&buffer, 0..buffer.len())
        .is_none());
    // Invalidate an outstanding result and repeatedly replace the queued job.
    for _ in 0..40 {
        buffer.insert(0, "\n");
        background.notify_insert(0, 1);
        background.highlight_viewport(&buffer, 0, buffer.len(), &theme, 0);
    }
    let structure = await_structure(&mut background, &buffer);
    let mut synchronous = engine(&registry);
    let expected = synchronous.structure_lines_in(&buffer, 0..buffer.len());
    assert_eq!(structure.regions, expected.regions);
    assert_eq!(structure.tables, expected.tables);
    let before = synchronous.highlight_viewport(&buffer, 0, buffer.len(), &theme, 0);
    let after = background.highlight_viewport(&buffer, 0, buffer.len(), &theme, 0);
    assert_eq!(format!("{before:?}"), format!("{after:?}"));
    // A file reload must invalidate even when its buffer version is unchanged.
    background.invalidate_all();
    assert!(background
        .structure_lines_ready(&buffer, 0..buffer.len())
        .is_none());
    let reloaded = await_structure(&mut background, &buffer);
    assert_eq!(reloaded.regions, expected.regions);
    assert_eq!(reloaded.tables, expected.tables);
}

#[test]
fn structure_cache_filters_subranges_and_invalidates_after_edit() {
    let registry = GrammarRegistry::load(&LocalGrammarLoader::embedded_only());
    let mut buffer = Buffer::from_str(
        "| A | B |\n| --- | --- |\n| one | two |\n\n",
        0,
        Arc::new(StdFileSystem),
    );
    let mut cached = engine(&registry);
    let full = cached.structure_lines_in(&buffer, 0..buffer.len());
    let start = buffer.line_start_offset(2).unwrap();
    let partial = cached.structure_lines_in(&buffer, start..buffer.len());
    assert_eq!(
        partial.tables,
        full.tables
            .into_iter()
            .filter(|(p, _)| *p >= start)
            .collect::<Vec<_>>()
    );
    buffer.insert(0, "```\n");
    cached.notify_insert(0, 4);
    let mut fresh = engine(&registry);
    assert_eq!(
        cached.structure_lines_in(&buffer, 0..buffer.len()).tables,
        fresh.structure_lines_in(&buffer, 0..buffer.len()).tables
    );
}
