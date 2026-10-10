//! Read-only Markdown latency probe; edits are made only to an in-memory buffer.
use fresh_editor_core::{
    model::{buffer::Buffer, filesystem::StdFileSystem},
    primitives::{
        grammar::{GrammarRegistry, LocalGrammarLoader},
        highlight_engine::HighlightEngine,
    },
    theme::{self, Theme},
};
use std::{sync::Arc, time::Instant};
use syntect::parsing::ParseState;
#[path = "../src/grammars/markdown.rs"]
mod markdown_grammar;

fn main() {
    let path = std::env::args().nth(1).expect("Markdown path required");
    if path == "--grammar" {
        let builder = syntect::parsing::SyntaxSet::load_defaults_newlines().into_builder();
        let md = builder
            .syntaxes()
            .iter()
            .find(|s| s.name == "Markdown")
            .unwrap();
        let mut contexts: Vec<_> = md.contexts.iter().collect();
        contexts.sort_by_key(|(name, _)| *name);
        for (name, context) in contexts {
            println!("CONTEXT {name}");
            for pattern in &context.patterns {
                println!("{pattern:?}");
            }
        }
        return;
    }
    let text = std::fs::read_to_string(&path).expect("read Markdown");
    if std::env::args().any(|a| a == "--compare-scopes") {
        let original = syntect::parsing::SyntaxSet::load_defaults_newlines();
        let optimized =
            markdown_grammar::optimize_builtin_builder(original.clone().into_builder()).build();
        let mut before = ParseState::new(original.find_syntax_by_extension("md").unwrap());
        let mut after = ParseState::new(optimized.find_syntax_by_extension("md").unwrap());
        for (number, line) in text.split_inclusive('\n').enumerate() {
            assert_eq!(
                before.parse_line(line, &original).unwrap(),
                after.parse_line(line, &optimized).unwrap(),
                "scope mismatch on line {}",
                number + 1
            );
        }
        println!(
            "Scope operations identical on all {} lines",
            text.lines().count()
        );
        return;
    }
    if std::env::args().any(|a| a == "--regex-profile") {
        let builder = syntect::parsing::SyntaxSet::load_defaults_newlines().into_builder();
        let md = builder
            .syntaxes()
            .iter()
            .find(|s| s.name == "Markdown")
            .unwrap();
        let line = text.lines().nth(123).unwrap().to_owned() + "\n";
        for (name, context) in &md.contexts {
            for (index, pattern) in context.patterns.iter().enumerate() {
                if let syntect::parsing::syntax_definition::Pattern::Match(p) = pattern {
                    if syntect::parsing::Regex::try_compile(p.regex.regex_str()).is_some() {
                        continue;
                    }
                    p.regex.search(&line, 0, line.len(), None);
                    let start = Instant::now();
                    let matched = p.regex.search(&line, 0, line.len(), None);
                    let ms = start.elapsed().as_secs_f64() * 1000.0;
                    if ms > 0.1 {
                        println!("context={name} index={index} regex_bytes={} match={matched} ms={ms:.3}", p.regex.regex_str().len());
                    }
                }
            }
        }
        return;
    }
    let registry = GrammarRegistry::load(&LocalGrammarLoader::embedded_only());
    let syntax_set = if std::env::args().any(|a| a == "--baseline") {
        Arc::new(syntect::parsing::SyntaxSet::load_defaults_newlines())
    } else if std::env::args().any(|a| a == "--optimized") {
        let builder = markdown_grammar::optimize_builtin_builder(
            registry.syntax_set().as_ref().clone().into_builder(),
        );
        Arc::new(builder.build())
    } else {
        registry.syntax_set_arc()
    };
    let theme = Theme::load_builtin(theme::THEME_LIGHT).unwrap();
    println!("bytes={} lines={}", text.len(), text.lines().count());
    for (label, content) in [
        ("original", text.clone()),
        ("without_inline_backticks", text.replace('`', "'")),
    ] {
        let mut buffer = Buffer::from_str(&content, 0, Arc::new(StdFileSystem));
        let syntax_index = syntax_set
            .syntaxes()
            .iter()
            .rposition(|s| s.name == "Markdown")
            .unwrap();
        let mut engine = HighlightEngine::TextMate(Box::new(
            fresh_editor_core::primitives::highlight_engine::TextMateEngine::new(
                syntax_set.clone(),
                syntax_index,
            ),
        ));
        let background = std::env::args().any(|a| a == "--background");
        if background {
            engine.enable_background_markdown();
        }
        let start = Instant::now();
        engine.highlight_viewport(&buffer, 0, buffer.len(), &theme, 0);
        println!(
            "{label}: cold_highlight_ms={:.2}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        if background {
            let start = Instant::now();
            while engine
                .structure_lines_ready(&buffer, 0..buffer.len())
                .is_none()
            {
                assert!(start.elapsed().as_secs() < 10, "worker timeout");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            println!(
                "{label}: background_delivery_ms={:.2}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
        for pass in 0..2 {
            let start = Instant::now();
            engine.structure_lines_in(&buffer, 0..buffer.len());
            println!(
                "{label}: structure_pass={pass} ms={:.2}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
        let offset = content
            .lines()
            .filter(|l| l.starts_with('|'))
            .max_by_key(|l| l.len())
            .and_then(|line| content.find(line))
            .unwrap_or(0);
        buffer.insert(offset, "x");
        engine.notify_insert(offset, 1);
        let start = Instant::now();
        engine.structure_lines_in(&buffer, offset..buffer.len());
        println!(
            "{label}: after_insert_structure_ms={:.2}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        let start = Instant::now();
        engine.highlight_viewport(&buffer, offset, buffer.len(), &theme, 0);
        println!(
            "{label}: after_insert_highlight_ms={:.2}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        if background {
            let start = Instant::now();
            while engine
                .structure_lines_ready(&buffer, 0..buffer.len())
                .is_none()
            {
                assert!(start.elapsed().as_secs() < 10, "worker timeout");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            println!(
                "{label}: after_insert_delivery_ms={:.2}",
                start.elapsed().as_secs_f64() * 1000.0
            );
        }
    }
    let syntax = syntax_set.find_syntax_by_extension("md").unwrap();
    let mut state = ParseState::new(syntax);
    let mut slow = Vec::new();
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let start = Instant::now();
        state.parse_line(line, &syntax_set).unwrap();
        slow.push((
            start.elapsed().as_secs_f64() * 1000.0,
            i + 1,
            line.len(),
            line.matches('`').count(),
        ));
    }
    slow.sort_by(|a, b| b.0.total_cmp(&a.0));
    for (ms, line, bytes, ticks) in slow.into_iter().take(8) {
        println!("line={line} bytes={bytes} backticks={ticks} parse_ms={ms:.2}");
    }
}
