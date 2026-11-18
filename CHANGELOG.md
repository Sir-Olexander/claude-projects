# What's new in Claude Projects

## Unreleased

## 1.0.0 (2026-11-18)

### Added

- **Claude Chats**: every chat you open here now opens in one tab instead of a tab each, so chats no longer scatter across the tab bar. A strip on top has two rows: your projects with open chats (each in its own colour, with counts of chats that need you, are running or finished), then the chats of the project you pick. Up to three chats show side by side.
- In the strip: drag projects and chats to reorder them, hover one for a × that closes it, double-click a project to open the chat you were last in there, and right-click for more. Keys: 1–9 show a chat of the selected project, Alt+1–9 pick a project.
- A chat's `…` menu can pop it out to a tab of its own, and that tab has a button to move it back. To always use a tab per chat, set **Chat: Open In** (`claudeProjects.chat.openIn`) to `tab`.
- **Flags** for sessions: Main (pinned first in its project), Review, Waiting, Parked and Trash. Set them from the strip, the tag in a chat's header or *Flag Session…* in the Projects view. They show in the strip, the Projects view and the dashboard. **Delete N trashed** deletes a project's trashed chats after one confirmation.
- A one-time message for existing users about Claude Chats, and this changelog (*Claude Projects: What's New*).

### Changed

- A chat keeps its green "finished" check until you click or type in it, even while it's on screen.
- The **Terminal: Location** setting now says which commands it applies to.

### Fixed

- The Projects view lists sessions by status, then by their latest activity again. Chats merely open (or opened just to read) no longer jump to the top.

## 0.4.0 (2026-11-03)

- Search button in the Projects view to find projects and sessions.
- A session's transcript is found even when Claude has moved into a subfolder.
- Chat tab numbers no longer repeat or come out of order.

## 0.3.0 (2026-10-28)

- *Remove Projects…* removes several projects at once.
- Importing projects skips folders inside hidden folders.
- Closing a session stopped at a usage limit removes it from Idle and cancels its automatic continue.

## 0.2.0 (2026-10-28)

- Published on the Marketplace as `Sir-Olexander.claude-projects`.
- Windows support: finding the `claude` CLI, Windows paths, toast notifications and Reveal in File Explorer.
- Yolo auto mode: auto mode where permission prompts are answered yes for you.
- Icon-only chat tabs, numbered 0, 1, 2… with the same numbers on the dashboard.
- Rename a session by clicking its name in the chat header; click the project name to show it in the Projects view.
- Delete a session from its chat or the dashboard.
- The dashboard lists each session once, under its state, and can close chats and idle sessions.

## 0.1.0 (2026-10-25)

First version: projects, worktrees and sessions in one window, per-project Source Control and Files views, a sessions dashboard, plan usage in the status bar, notifications, and Open Here chats with forking, bookmarks, a shared `.env`, Remote Control, prompt presets and continuing after usage limits.
