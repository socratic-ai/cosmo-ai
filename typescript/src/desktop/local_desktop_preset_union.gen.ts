// Auto-generated. Do not edit.
//
// The server-defined union of local desktop tool names — the tools
// a desktop host process executes, which browser-side adapters must
// NOT register handlers for, so the per-session allowlist excludes
// them rather than hitting ``RpcError 1400 Method not supported at
// destination``.

export const LOCAL_DESKTOP_PRESET_UNION: readonly string[] = [
  "accessibility_tree",
  "clipboard_read",
  "clipboard_write",
  "file_list",
  "file_read",
  "file_search",
  "file_write",
  "focus_app",
  "inspect_element_at_cursor",
  "iterm_capture",
  "iterm_close_tab",
  "iterm_create_tab",
  "iterm_list_tabs",
  "iterm_select_tab",
  "iterm_send_key",
  "iterm_send_text",
  "launch_app",
  "list_running_apps",
  "open_file",
  "press_key",
  "read_screen_text",
  "replace_text",
  "tmux_capture",
  "tmux_create_window",
  "tmux_kill_pane",
  "tmux_kill_window",
  "tmux_list_panes",
  "tmux_list_sessions",
  "tmux_rename_window",
  "tmux_select_window",
  "tmux_send_key",
  "tmux_send_text",
  "tmux_split_pane",
  "type_text",
];
