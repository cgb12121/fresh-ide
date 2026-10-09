//! Exercise the actual workbench plugins in separate QuickJS contexts.
use crate::common::harness::{copy_plugin_lib, EditorTestHarness, HarnessOptions};
use crossterm::event::{KeyCode, KeyModifiers};
use fresh::config_io::DirectoryContext;
use std::{fs, path::Path};

fn install(project: &Path) {
    let plugins = project.join("plugins");
    fs::create_dir_all(&plugins).unwrap();
    copy_plugin_lib(&plugins);
    for name in ["activity_bar", "git_control_panel", "extensions_panel"] {
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("plugins/{name}.ts")),
            plugins.join(format!("{name}.ts")),
        )
        .unwrap();
    }
}

fn click_icon(h: &mut EditorTestHarness, icon: &str) {
    h.wait_until(|h| {
        h.screen_to_string()
            .lines()
            .any(|l| l.chars().take(5).collect::<String>().contains(icon))
    })
    .unwrap();
    let y = h
        .screen_to_string()
        .lines()
        .position(|l| l.chars().take(5).collect::<String>().contains(icon))
        .unwrap() as u16;
    h.mouse_click(2, y).unwrap();
}

#[test]
fn activity_icons_switch_views_and_remain_available_when_content_is_hidden() {
    let temp = tempfile::TempDir::new().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("visible-file.txt"), "hello\n").unwrap();
    install(&project);
    let mut h = EditorTestHarness::create(
        100,
        30,
        HarnessOptions::new()
            .with_working_dir(project)
            .with_shared_dir_context(DirectoryContext::for_testing(temp.path()))
            .without_empty_plugins_dir(),
    )
    .unwrap();
    h.editor_mut()
        .restore_active_window_on_launch(false)
        .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("visible-file.txt"))
        .unwrap();
    h.assert_no_plugin_errors();
    assert!(
        !h.screen_to_string().contains("Source Control"),
        "Git must not auto-mount"
    );

    click_icon(&mut h, "⊞");
    h.wait_until(|h| h.screen_to_string().contains("LANGUAGE SERVERS"))
        .unwrap();
    assert!(!h.screen_to_string().contains("File Explorer"));

    click_icon(&mut h, "⑂");
    h.wait_until(|h| h.screen_to_string().contains("Source Control"))
        .unwrap();
    assert!(!h.screen_to_string().contains("LANGUAGE SERVERS"));

    // Re-click hides only the content; the same icon can reopen it.
    click_icon(&mut h, "⑂");
    h.wait_until(|h| !h.screen_to_string().contains("Source Control"))
        .unwrap();
    click_icon(&mut h, "⑂");
    h.wait_until(|h| h.screen_to_string().contains("Source Control"))
        .unwrap();

    click_icon(&mut h, "▱");
    h.wait_until(|h| h.screen_to_string().contains("visible-file.txt"))
        .unwrap();
    assert!(!h.screen_to_string().contains("Source Control"));
    h.send_key(
        KeyCode::Char('x'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    )
    .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("LANGUAGE SERVERS"))
        .unwrap();
    // Fresh's original Ctrl+E must switch back, rather than focus a hidden tree.
    h.send_key(KeyCode::Char('e'), KeyModifiers::CONTROL)
        .unwrap();
    h.wait_until(|h| h.screen_to_string().contains("visible-file.txt"))
        .unwrap();
    h.assert_no_plugin_errors();
}
