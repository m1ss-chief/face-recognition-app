"""Convert a Claude Code session transcript (.jsonl) into readable Markdown.

Keeps: user prompts, attachments (named only), assistant replies, and a one-line
summary of each tool call. Drops: hidden reasoning, raw tool output, system
reminders and any e-mail addresses.
"""
import json
import re
import sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
SYS = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
IDE = re.compile(r"<ide_[a-z_]+>.*?</ide_[a-z_]+>", re.S)


def clean(t: str) -> str:
    t = SYS.sub("", t)
    t = IDE.sub("", t)
    t = EMAIL.sub("[email removed]", t)
    return t.strip()


def tool_line(b: dict) -> str:
    name = b.get("name", "tool")
    inp = b.get("input") or {}
    desc = inp.get("description") or inp.get("file_path") or inp.get("pattern") or inp.get("url") or ""
    if name == "AskUserQuestion":
        qs = inp.get("questions") or []
        parts = []
        for q in qs:
            opts = " / ".join(o.get("label", "") for o in q.get("options", []))
            parts.append(f"**Q:** {q.get('question','')}  \n  _Options:_ {opts}")
        return "> 🗳️ **AI asked:**  \n> " + "  \n> ".join(parts)
    return f"> 🔧 `{name}`: {clean(str(desc))[:160]}"


out = [
    "# Full AI chat history",
    "",
    "Tool: **Claude Code** (Claude Opus 5.5) in VS Code. One continuous session, from the very first prompt.",
    "",
    "Exported from the local Claude Code session transcript with `scripts/export_chat.py`:",
    "- user messages and AI replies are verbatim;",
    "- each tool the AI ran is shown as a one-line summary (🔧);",
    "- raw tool output, hidden reasoning and e-mail addresses are omitted.",
    "",
    "---",
    "",
]
seen_answers = set()
for line in src.open(encoding="utf-8"):
    d = json.loads(line)
    typ = d.get("type")
    if d.get("isSidechain"):
        continue
    att = d.get("attachment") if typ == "attachment" else None
    if isinstance(att, dict) and att.get("type") == "queued_command" and (att.get("origin") or {}).get("kind") == "human":
        prompt = att.get("prompt")
        texts = [p.get("text", "") for p in prompt] if isinstance(prompt, list) else [str(prompt or "")]
        c = clean("\n".join(texts))
        if c:
            out += ["### 🧑 Me (sent while the AI was working)", "", c, ""]
        continue
    m = d.get("message")
    if not isinstance(m, dict):
        continue
    content = m.get("content")
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
    if typ == "user":
        texts, docs = [], []
        for b in blocks:
            if b.get("type") == "text":
                t = clean(b.get("text", ""))
                if t and not t.startswith("[Request interrupted"):
                    texts.append(t)
            elif b.get("type") == "document":
                docs.append(b.get("title") or (b.get("source") or {}).get("filename") or "PDF")
            elif b.get("type") == "tool_result":
                r = d.get("toolUseResult")
                if isinstance(r, dict) and "answers" in r and r["answers"]:
                    key = json.dumps(r["answers"], sort_keys=True)
                    if key not in seen_answers:
                        seen_answers.add(key)
                        ans = "  \n".join(f"- {v}" for v in r["answers"].values())
                        out += ["### 🧑 Me (answered the AI's question)", "", ans, ""]
        if d.get("isMeta"):
            continue
        if texts or docs:
            out.append("### 🧑 Me")
            out.append("")
            for doc in docs:
                out.append(f"📎 _Attached: {doc} (the assignment brief)_")
                out.append("")
            out += texts + [""]
    elif typ == "assistant":
        for b in blocks:
            if b.get("type") == "text":
                t = clean(b.get("text", ""))
                if t:
                    out += ["### 🤖 AI", "", t, ""]
            elif b.get("type") == "tool_use":
                out += [tool_line(b), ""]

dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text("\n".join(out), encoding="utf-8")
print("wrote", dst, len(out), "lines")
