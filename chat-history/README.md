# Chat history

- [`claude-code-session.md`](claude-code-session.md): the full Claude Code session used to build this project, from the very first prompt (the brief PDF plus the repo link) onwards.
- It was generated from the local session transcript with [`scripts/export_chat.py`](../scripts/export_chat.py):
  - my messages and the AI's replies are verbatim;
  - each tool the AI ran (commands, file edits, web reads) is shown as a one-line 🔧 summary;
  - raw tool output and hidden reasoning are left out to keep it readable;
  - e-mail addresses are removed.
