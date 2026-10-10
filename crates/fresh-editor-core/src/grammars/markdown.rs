//! Keep Syntect's Markdown grammar, but reject impossible tables cheaply.
//!
//! The bundled grammar expands inline markup into block/table lookaheads.
//! Nested repetitions backtrack heavily when looking for a table separator in
//! prose containing many code spans. A pipe is necessary for a table: checking
//! for it before the expanded lookahead preserves every possible match.
use syntect::parsing::{syntax_definition::Pattern, Regex, SyntaxSetBuilder};

pub fn optimize_builtin_builder(original: SyntaxSetBuilder) -> SyntaxSetBuilder {
    // Preserve syntax order and context names: linked ContextIds from the
    // defaults still name the same contexts after Syntect's sorted rebuild.
    let mut builder = SyntaxSetBuilder::new();
    for mut syntax in original.syntaxes().iter().cloned() {
        if syntax.name == "Markdown" {
            for context in syntax.contexts.values_mut() {
                for pattern in &mut context.patterns {
                    if let Pattern::Match(pattern) = pattern {
                        let original = pattern.regex.regex_str();
                        let optimized = optimize_table_lookahead(original);
                        if optimized != original {
                            pattern.regex = Regex::new(optimized);
                        }
                    }
                }
            }
        }
        builder.add(syntax);
    }
    builder
}

pub fn optimize_table_lookahead(regex: &str) -> String {
    // This is the expanded table-start alternative in the bundled main
    // block dispatcher. Other alternatives (headings, lists, quotes) keep
    // their original matching and capture numbering.
    let guarded = regex.replacen(
        "|    (?x:\n    (?:(?x:\n",
        "|    (?=[^\\n]*\\|)(?x:\n    (?:(?x:\n",
        1,
    );
    if regex.starts_with("^(?=") && regex.contains("followed by a pipe char") {
        format!(r"(?=[^\n]*\|){guarded}")
    } else {
        guarded
    }
}
