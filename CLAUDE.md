# Notes for AI assistants working on this repo

**This repository is public.** Everything written here — code, comments, docs, test data, commit
messages — gets published.

- Never put anything from the maintainer's real WhatsApp in it: names, nicknames, phone numbers,
  WhatsApp IDs, chat or group names, message text, file or document titles, company or client details.
  When an example helps, invent one.
- `.githooks/pre-commit` blocks the most common leaks (enable it once per clone with
  `git config core.hooksPath .githooks`). If it blocks a commit, fix the content; don't bypass it with
  `--no-verify`.
- This folder may be the maintainer's live install, with direct sending turned on. Test the writing
  tools only with the fakes described in TECHNICAL-NOTES.md → "Tests" (`WACRAWL_DRAFTS_DIR`,
  `WACRAWL_OPEN_BIN`, `WACRAWL_ENTER_BIN`, `WACRAWL_FAKE_SENT_FILE`); never call the real draft or send
  tools to try something out.
- Read tools can be tested against a real archive, but what they return stays out of commits, issues
  and logs.
