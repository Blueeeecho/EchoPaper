# EchoPaper

**English** | [简体中文](README.zh-CN.md)

Research usually ends up scattered across too many places: PDFs in one app, translations in a browser tab, notes in Markdown files, manuscripts in a LaTeX editor, and group-meeting slides in PowerPoint. **EchoPaper** brings those pieces together into one ordinary local folder on your computer—open it in your browser, work directly on your own files, and keep everything on disk without cloud lock-in.

## What you can do with it

- **Read papers without losing context**: Connect your local paper folders to browse titles, translated Chinese titles, venues/years, and keywords at a glance, search across originals and translations, and read PDFs side-by-side with translations and Markdown notes.
- **Keep each research topic straight**: Track milestones, daily todos, experiment notes, and explore an interactive map showing how the papers in a topic connect to one another.
- **Write and revise LaTeX in one place**: Edit manuscripts with Tectonic PDF preview, jump back and forth between source lines and the PDF, leave highlights or sticky notes on pages, manage point-by-point reviewer responses, and bundle clean submission archives.
- **Get AI help and draft slides**: Plug in your own OpenAI-compatible model to discuss papers or polish drafts (proposed edits always pause for your review before touching a file), and turn papers or notes into editable `.pptx` slides when a group meeting is coming up.

## Quick start

You will need **Node.js 22+** and **Python 3** (plus **Tectonic** if you want local LaTeX compilation, and **Git** for version history). Keep the whole repository folder together—don't copy `_system` by itself.

```sh
git clone https://github.com/Blueeeecho/EchoPaper.git
cd EchoPaper
```

**Easiest way**: double-click `启动工作台.command` on macOS or `启动工作台.bat` on Windows (and use the matching `停止工作台` script to shut it down). On first launch—or after moving the folder between macOS and Windows—it automatically installs what your system needs and opens `http://127.0.0.1:4173`.

**Prefer the terminal?**

```sh
npm --prefix _system ci --no-audit --no-fund
npm --prefix _system run build
node _system/scripts/control.mjs start
```

Everything local (reading, notes, library search, LaTeX editing and compilation) works offline with zero API keys. When you want AI chat, document translation, or OCR parsing, add your own endpoint and key in **Settings**—credentials stay in macOS Keychain or Windows Credential Manager, never inside the repository.

## More

- Sample project lives in `papers/DEMO/`; LaTeX edits sync on disk and only compile when you save a build target or click Compile.
- Looking for CLI commands, local APIs, translation setup, or the optional macOS launcher? See [`LOCAL_API.md`](_system/docs/LOCAL_API.md), [`ACADEMIC_API.md`](_system/docs/ACADEMIC_API.md), [`TRANSLATION_SERVICES.md`](_system/docs/TRANSLATION_SERVICES.md), and [`_system/native/README.md`](_system/native/README.md).
- This is a sanitized public source release with no personal papers or credentials ([`SHARING_NOTES.md`](SHARING_NOTES.md)). After using it locally, avoid zipping the whole folder to share.
- Third-party packages keep their original licenses, and the included HZAU slide template assets retain their original rights ([`ACADEMIC_REUSE.md`](_system/docs/ACADEMIC_REUSE.md)); no unified open-source license is declared for the repository as a whole.
