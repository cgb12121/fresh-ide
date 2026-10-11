use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(super) fn insert_with_aliases<T, FInsert>(
    direct: &mut HashMap<PathBuf, T>,
    path: &Path,
    value: &T,
    symlink_mappings: &HashMap<PathBuf, PathBuf>,
    mut insert: FInsert,
) where
    T: Clone,
    FInsert: FnMut(&mut HashMap<PathBuf, T>, PathBuf, T),
{
    insert(direct, path.to_path_buf(), value.clone());

    #[cfg(windows)]
    {
        let stripped = crate::services::terminal::manager::strip_verbatim_prefix(path);
        if stripped.as_ref() != path {
            insert(direct, stripped.into_owned(), value.clone());
        }
        let s = path.to_string_lossy();
        if s.contains('/') {
            let backslashed = PathBuf::from(s.replace('/', "\\"));
            insert(direct, backslashed, value.clone());
        }
    }

    for (symlink_path, canonical_target) in symlink_mappings {
        if let Ok(suffix) = path.strip_prefix(canonical_target) {
            insert(direct, symlink_path.join(suffix), value.clone());
        }
    }
}

pub(super) fn build_bubbled_cache<T, FInsert, FAncestorValue>(
    direct: &HashMap<PathBuf, T>,
    root: &Path,
    mut insert: FInsert,
    mut ancestor_value: FAncestorValue,
) -> HashMap<PathBuf, T>
where
    T: Clone,
    FInsert: FnMut(&mut HashMap<PathBuf, T>, PathBuf, T),
    FAncestorValue: FnMut(&Path, &T) -> T,
{
    let mut bubbled = HashMap::new();
    let stripped_root = crate::services::terminal::manager::strip_verbatim_prefix(root);

    for (path, value) in direct {
        for ancestor in path.ancestors() {
            let stripped_ancestor = crate::services::terminal::manager::strip_verbatim_prefix(ancestor);
            if !ancestor.starts_with(root)
                && !stripped_ancestor.starts_with(stripped_root.as_ref())
                && !ancestor.starts_with(stripped_root.as_ref())
            {
                break;
            }
            insert(
                &mut bubbled,
                ancestor.to_path_buf(),
                ancestor_value(ancestor, value),
            );
            #[cfg(windows)]
            {
                let s = ancestor.to_string_lossy();
                if s.contains('/') {
                    let backslashed = PathBuf::from(s.replace('/', "\\"));
                    insert(
                        &mut bubbled,
                        backslashed.clone(),
                        ancestor_value(&backslashed, value),
                    );
                }
            }
        }
    }

    bubbled
}
