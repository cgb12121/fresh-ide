use std::path::Path;

use crate::primitives::display_width::str_width;
use crate::view::theme::Theme;
use fresh_core::api::OverlayColorSpec;
use ratatui::style::Color;

use super::{cache::insert_with_aliases, decorations::FileExplorerDecorationCache};

pub const DEFAULT_LEADING_SLOT_MIN_WIDTH: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorerTooltipSummary {
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorerLeadingSlotPayload {
    pub text: String,
    pub fg: Color,
    /// The theme key `fg` was resolved from, when it was one — so the slot is
    /// drawn with that key's text attributes too, and the inspector can name
    /// it. `None` for a literal color.
    pub fg_key: Option<String>,
    pub min_width: usize,
}

impl ExplorerLeadingSlotPayload {
    pub fn width(&self) -> usize {
        str_width(&self.text).max(self.min_width)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplorerTrailingSlotPayload {
    pub text: String,
    pub fg: Color,
    /// See [`ExplorerLeadingSlotPayload::fg_key`].
    pub fg_key: Option<String>,
    pub tooltip: Option<ExplorerTooltipSummary>,
}

impl ExplorerTrailingSlotPayload {
    pub fn width(&self) -> usize {
        str_width(&self.text)
    }
}

#[derive(Debug, Clone)]
pub struct ExplorerTrailingSlotResolution {
    pub payload: Option<ExplorerTrailingSlotPayload>,
    pub name_color_hint: Option<Color>,
    /// The theme key `name_color_hint` was resolved from, when it was one.
    pub name_color_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExplorerSlotResolution {
    pub leading: Option<ExplorerLeadingSlotPayload>,
    pub trailing: Option<ExplorerTrailingSlotPayload>,
    pub name_color_hint: Option<Color>,
    /// See [`ExplorerTrailingSlotResolution::name_color_key`].
    pub name_color_key: Option<String>,
}

pub struct ExplorerSlotContext<'a> {
    pub path: &'a Path,
    pub is_dir: bool,
    pub has_unsaved: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub decorations: &'a FileExplorerDecorationCache,
    pub slot_overrides: &'a FileExplorerSlotOverrideCache,
    pub theme: &'a Theme,
    pub neutral_fg: Color,
}

pub trait ExplorerLeadingSlotProvider {
    fn resolve(&self, context: &ExplorerSlotContext<'_>) -> Option<ExplorerLeadingSlotPayload>;
}

pub trait ExplorerTrailingSlotProvider {
    fn resolve(&self, context: &ExplorerSlotContext<'_>) -> ExplorerTrailingSlotResolution;
}

#[derive(Clone, Copy)]
pub struct ExplorerSlotProviders {
    pub leading: &'static dyn ExplorerLeadingSlotProvider,
    pub trailing: &'static dyn ExplorerTrailingSlotProvider,
}

impl ExplorerSlotProviders {
    pub fn resolver(self) -> ExplorerSlotResolver<'static> {
        ExplorerSlotResolver::new(self.leading, self.trailing)
    }
}

pub fn default_slot_providers() -> ExplorerSlotProviders {
    ExplorerSlotProviders {
        leading: &DEFAULT_LEADING_SLOT_PROVIDER,
        trailing: &DEFAULT_TRAILING_SLOT_PROVIDER,
    }
}

#[derive(Clone, Copy)]
pub struct ExplorerSlotResolver<'a> {
    leading: &'a dyn ExplorerLeadingSlotProvider,
    trailing: &'a dyn ExplorerTrailingSlotProvider,
}

impl<'a> ExplorerSlotResolver<'a> {
    pub fn new(
        leading: &'a dyn ExplorerLeadingSlotProvider,
        trailing: &'a dyn ExplorerTrailingSlotProvider,
    ) -> Self {
        Self { leading, trailing }
    }

    pub fn resolve(&self, context: &ExplorerSlotContext<'_>) -> ExplorerSlotResolution {
        let trailing = self.trailing.resolve(context);
        ExplorerSlotResolution {
            leading: self.leading.resolve(context),
            trailing: trailing.payload,
            name_color_hint: trailing.name_color_hint,
            name_color_key: trailing.name_color_key,
        }
    }
}

#[derive(Debug, Clone)]
struct CachedLeadingSlot {
    text: String,
    color: OverlayColorSpec,
    min_width: usize,
}

#[derive(Debug, Clone)]
struct CachedTrailingSlot {
    text: String,
    color: OverlayColorSpec,
    tooltip: Option<ExplorerTooltipSummary>,
}

#[derive(Debug, Clone)]
struct CachedLeadingOverride {
    slot: Option<CachedLeadingSlot>,
    priority: i32,
}

#[derive(Debug, Clone)]
struct CachedTrailingOverride {
    slot: Option<CachedTrailingSlot>,
    priority: i32,
}

#[derive(Debug, Clone)]
struct CachedNameColorOverride {
    color: Option<OverlayColorSpec>,
    priority: i32,
}

#[derive(Debug, Default, Clone)]
pub struct FileExplorerSlotOverrideCache {
    direct_leading: std::collections::HashMap<std::path::PathBuf, CachedLeadingOverride>,
    direct_trailing: std::collections::HashMap<std::path::PathBuf, CachedTrailingOverride>,
    direct_name_color: std::collections::HashMap<std::path::PathBuf, CachedNameColorOverride>,
    /// The subset of `direct_name_color` whose entries set
    /// [`FileExplorerSlotEntry::apply_to_children`]. Kept apart so the common
    /// case — no entry inherits — pays an `is_empty()` check instead of an
    /// ancestor walk on every row of every frame.
    inherited_name_color: std::collections::HashMap<std::path::PathBuf, CachedNameColorOverride>,
}

impl FileExplorerSlotOverrideCache {
    pub fn rebuild<I>(
        slots: I,
        root: &Path,
        symlink_mappings: &std::collections::HashMap<std::path::PathBuf, std::path::PathBuf>,
    ) -> Self
    where
        I: IntoIterator<Item = fresh_core::file_explorer::FileExplorerSlotEntry>,
    {
        let mut direct_leading = std::collections::HashMap::new();
        let mut direct_trailing = std::collections::HashMap::new();
        let mut direct_name_color = std::collections::HashMap::new();
        let mut inherited_name_color = std::collections::HashMap::new();

        for slot in slots {
            if !slot.path.starts_with(root) {
                continue;
            }

            if slot.leading.is_some() || slot.suppress_leading {
                let cached = CachedLeadingOverride {
                    slot: slot.leading.as_ref().map(|leading| CachedLeadingSlot {
                        text: leading.text.clone(),
                        color: leading.color.clone(),
                        min_width: leading.min_width,
                    }),
                    priority: slot.priority,
                };
                insert_with_aliases(
                    &mut direct_leading,
                    &slot.path,
                    &cached,
                    symlink_mappings,
                    |map, path, value| insert_best_cached(map, path, value, |entry| entry.priority),
                );
            }

            if slot.trailing.is_some() || slot.suppress_trailing {
                let cached = CachedTrailingOverride {
                    slot: slot.trailing.as_ref().map(|trailing| CachedTrailingSlot {
                        text: trailing.text.clone(),
                        color: trailing.color.clone(),
                        tooltip: trailing
                            .tooltip
                            .as_ref()
                            .map(|tooltip| ExplorerTooltipSummary {
                                title: tooltip.title.clone(),
                                lines: tooltip.lines.clone(),
                            }),
                    }),
                    priority: slot.priority,
                };
                insert_with_aliases(
                    &mut direct_trailing,
                    &slot.path,
                    &cached,
                    symlink_mappings,
                    |map, path, value| insert_best_cached(map, path, value, |entry| entry.priority),
                );
            }

            if slot.name_color.is_some() || slot.suppress_name_color {
                let cached = CachedNameColorOverride {
                    color: slot.name_color.clone(),
                    priority: slot.priority,
                };
                insert_with_aliases(
                    &mut direct_name_color,
                    &slot.path,
                    &cached,
                    symlink_mappings,
                    |map, path, value| insert_best_cached(map, path, value, |entry| entry.priority),
                );
                if slot.apply_to_children {
                    insert_with_aliases(
                        &mut inherited_name_color,
                        &slot.path,
                        &cached,
                        symlink_mappings,
                        |map, path, value| {
                            insert_best_cached(map, path, value, |entry| entry.priority)
                        },
                    );
                }
            }
        }

        Self {
            direct_leading,
            direct_trailing,
            direct_name_color,
            inherited_name_color,
        }
    }

    fn leading_override_for_path(&self, path: &Path) -> Option<&CachedLeadingOverride> {
        self.direct_leading.get(path)
    }

    fn trailing_override_for_path(&self, path: &Path) -> Option<&CachedTrailingOverride> {
        self.direct_trailing.get(path)
    }

    fn name_color_override_for_path(&self, path: &Path) -> Option<&CachedNameColorOverride> {
        if let Some(direct) = self.direct_name_color.get(path) {
            return Some(direct);
        }
        // No entry for this exact path: an ancestor that opted into
        // `apply_to_children` colours it. This is the lookup that lets a plugin
        // style a subtree with one entry instead of one per descendant — the
        // same trade VS Code's decoration provider (asked per rendered row)
        // and IntelliJ's tree painter (inherits while painting) both make.
        //
        // The walk is bounded by the path's own depth and every key lives under
        // the explorer root, so it cannot run away.
        if self.inherited_name_color.is_empty() {
            return None;
        }
        path.ancestors()
            .skip(1)
            .find_map(|ancestor| self.inherited_name_color.get(ancestor))
    }

    pub fn has_trailing_override_for_path(&self, path: &Path) -> bool {
        self.direct_trailing.contains_key(path)
    }
}

pub struct DefaultLeadingSlotProvider;

pub static DEFAULT_LEADING_SLOT_PROVIDER: DefaultLeadingSlotProvider = DefaultLeadingSlotProvider;

impl ExplorerLeadingSlotProvider for DefaultLeadingSlotProvider {
    fn resolve(&self, context: &ExplorerSlotContext<'_>) -> Option<ExplorerLeadingSlotPayload> {
        context
            .slot_overrides
            .leading_override_for_path(context.path)
            .and_then(|override_entry| {
                override_entry
                    .slot
                    .as_ref()
                    .map(|slot| ExplorerLeadingSlotPayload {
                        text: slot.text.clone(),
                        fg: resolve_overlay_color(&slot.color, context.theme, context.neutral_fg),
                        fg_key: overlay_color_key(&slot.color),
                        min_width: slot.min_width,
                    })
            })
    }
}

pub struct DefaultTrailingSlotProvider;

pub static DEFAULT_TRAILING_SLOT_PROVIDER: DefaultTrailingSlotProvider =
    DefaultTrailingSlotProvider;

impl ExplorerTrailingSlotProvider for DefaultTrailingSlotProvider {
    fn resolve(&self, context: &ExplorerSlotContext<'_>) -> ExplorerTrailingSlotResolution {
        let compatibility =
            super::decorations::COMPATIBILITY_TRAILING_SLOT_PROVIDER.resolve(context);
        let override_trailing = context
            .slot_overrides
            .trailing_override_for_path(context.path);
        let override_name_color = context
            .slot_overrides
            .name_color_override_for_path(context.path);

        ExplorerTrailingSlotResolution {
            payload: match override_trailing {
                Some(override_entry) => {
                    override_entry
                        .slot
                        .as_ref()
                        .map(|slot| ExplorerTrailingSlotPayload {
                            text: slot.text.clone(),
                            fg: resolve_overlay_color(
                                &slot.color,
                                context.theme,
                                context.neutral_fg,
                            ),
                            fg_key: overlay_color_key(&slot.color),
                            tooltip: slot.tooltip.clone(),
                        })
                }
                None => compatibility.payload,
            },
            name_color_hint: match override_name_color {
                Some(override_entry) => override_entry
                    .color
                    .as_ref()
                    .map(|color| resolve_overlay_color(color, context.theme, context.neutral_fg)),
                None => compatibility.name_color_hint,
            },
            name_color_key: match override_name_color {
                Some(override_entry) => override_entry.color.as_ref().and_then(overlay_color_key),
                None => compatibility.name_color_key,
            },
        }
    }
}

/// The theme key a color spec names, if it names one.
pub(crate) fn overlay_color_key(spec: &OverlayColorSpec) -> Option<String> {
    match spec {
        OverlayColorSpec::Rgb(..) => None,
        OverlayColorSpec::ThemeKey(key) => Some(key.clone()),
    }
}

fn resolve_overlay_color(spec: &OverlayColorSpec, theme: &Theme, fallback: Color) -> Color {
    match spec {
        OverlayColorSpec::Rgb(r, g, b) => Color::Rgb(*r, *g, *b),
        OverlayColorSpec::ThemeKey(key) => theme.resolve_theme_key(key).unwrap_or(fallback),
    }
}

fn insert_best_cached<T, FPriority>(
    map: &mut std::collections::HashMap<std::path::PathBuf, T>,
    path: std::path::PathBuf,
    value: T,
    priority: FPriority,
) where
    FPriority: Fn(&T) -> i32,
{
    let replace = match map.get(&path) {
        Some(existing) => priority(&value) >= priority(existing),
        None => true,
    };

    if replace {
        map.insert(path, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_overrides_do_not_bubble_to_ancestors() {
        let cache = FileExplorerSlotOverrideCache::rebuild(
            vec![fresh_core::file_explorer::FileExplorerSlotEntry {
                path: std::path::PathBuf::from("/repo/src/file.ts"),
                leading: None,
                suppress_leading: false,
                trailing: Some(fresh_core::file_explorer::FileExplorerTrailingSlot {
                    text: "P".to_string(),
                    color: OverlayColorSpec::ThemeKey("syntax.string".into()),
                    tooltip: None,
                }),
                suppress_trailing: false,
                name_color: Some(OverlayColorSpec::ThemeKey("syntax.type".into())),
                suppress_name_color: false,
                apply_to_children: false,
                priority: 10,
            }],
            Path::new("/repo"),
            &std::collections::HashMap::new(),
        );

        assert!(cache.has_trailing_override_for_path(Path::new("/repo/src/file.ts")));
        assert!(!cache.has_trailing_override_for_path(Path::new("/repo/src")));
        assert!(cache
            .name_color_override_for_path(Path::new("/repo/src"))
            .is_none());
    }

    #[test]
    fn suppressed_trailing_and_name_color_block_compatibility_fallback() {
        let theme = Theme::load_builtin("dark").unwrap();
        let path = std::path::PathBuf::from("/repo/file.ts");
        let decorations = FileExplorerDecorationCache::rebuild(
            vec![fresh_core::file_explorer::FileExplorerDecoration {
                path: path.clone(),
                symbol: "M".to_string(),
                color: OverlayColorSpec::ThemeKey("ui.file_status_modified_fg".into()),
                priority: 50,
            }],
            Path::new("/repo"),
            &std::collections::HashMap::new(),
        );
        let slot_overrides = FileExplorerSlotOverrideCache::rebuild(
            vec![fresh_core::file_explorer::FileExplorerSlotEntry {
                path: path.clone(),
                leading: None,
                suppress_leading: false,
                trailing: None,
                suppress_trailing: true,
                name_color: None,
                suppress_name_color: true,
                apply_to_children: false,
                priority: 10,
            }],
            Path::new("/repo"),
            &std::collections::HashMap::new(),
        );
        let context = ExplorerSlotContext {
            path: &path,
            is_dir: false,
            has_unsaved: false,
            is_symlink: false,
            is_hidden: false,
            decorations: &decorations,
            slot_overrides: &slot_overrides,
            theme: &theme,
            neutral_fg: theme.editor_fg,
        };

        let resolved = default_slot_providers().resolver().resolve(&context);
        assert!(resolved.trailing.is_none());
        assert!(resolved.name_color_hint.is_none());
    }

    /// `apply_to_children` is what lets a plugin colour a whole subtree with one
    /// entry: the alternative is shipping an entry per descendant, which for
    /// one repo meant 2177 entries and a 457 KB payload on the editor thread.
    #[test]
    fn apply_to_children_colours_descendants_without_extra_entries() {
        let gray = OverlayColorSpec::ThemeKey("ui.fg".into());
        let blue = OverlayColorSpec::ThemeKey("ui.file_status_modified_fg".into());
        let mk = |path: &str, color: Option<OverlayColorSpec>, apply: bool| {
            fresh_core::file_explorer::FileExplorerSlotEntry {
                path: std::path::PathBuf::from(path),
                leading: None,
                suppress_leading: false,
                trailing: None,
                suppress_trailing: false,
                name_color: color,
                suppress_name_color: false,
                apply_to_children: apply,
                priority: 10,
            }
        };
        let cache = FileExplorerSlotOverrideCache::rebuild(
            vec![
                mk("/repo/node_modules", Some(gray.clone()), true),
                mk("/repo/src/App.java", Some(blue.clone()), false),
            ],
            Path::new("/repo"),
            &std::collections::HashMap::new(),
        );

        // The directory itself, and anything under it, are covered.
        assert!(cache.name_color_override_for_path(Path::new("/repo/node_modules")).is_some());
        assert!(
            cache
                .name_color_override_for_path(Path::new("/repo/node_modules/pkg/index.js"))
                .is_some()
        );
        assert!(
            cache
                .name_color_override_for_path(Path::new("/repo/node_modules/a/b/c/d.js"))
                .is_some()
        );

        // An entry that did NOT opt in stays exact: no leaking onto children.
        assert!(cache.name_color_override_for_path(Path::new("/repo/src/App.java")).is_some());
        assert!(cache.name_color_override_for_path(Path::new("/repo/src/Other.java")).is_none());
        assert!(cache.name_color_override_for_path(Path::new("/repo/src")).is_none());
    }

    /// A direct entry must win over an inherited one, or a plugin could never
    /// highlight one file inside a subtree it has coloured.
    #[test]
    fn direct_entry_beats_an_inherited_one() {
        let gray = OverlayColorSpec::ThemeKey("ui.fg".into());
        let red = OverlayColorSpec::ThemeKey("ui.file_status_deleted_fg".into());
        let cache = FileExplorerSlotOverrideCache::rebuild(
            vec![
                fresh_core::file_explorer::FileExplorerSlotEntry {
                    path: std::path::PathBuf::from("/repo/build"),
                    leading: None,
                    suppress_leading: false,
                    trailing: None,
                    suppress_trailing: false,
                    name_color: Some(gray),
                    suppress_name_color: false,
                    apply_to_children: true,
                    priority: 10,
                },
                fresh_core::file_explorer::FileExplorerSlotEntry {
                    path: std::path::PathBuf::from("/repo/build/keep.txt"),
                    leading: None,
                    suppress_leading: false,
                    trailing: None,
                    suppress_trailing: false,
                    name_color: Some(red),
                    suppress_name_color: false,
                    apply_to_children: false,
                    priority: 10,
                },
            ],
            Path::new("/repo"),
            &std::collections::HashMap::new(),
        );

        let inherited = cache
            .name_color_override_for_path(Path::new("/repo/build/other.txt"))
            .map(|c| c.color.clone());
        let direct = cache
            .name_color_override_for_path(Path::new("/repo/build/keep.txt"))
            .map(|c| c.color.clone());
        assert_ne!(inherited, direct, "a direct entry must not be overridden");
        assert!(direct.is_some());
        assert!(inherited.is_some());
    }
}
