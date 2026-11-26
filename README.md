# J.A.R.V.I.S.

A voice-first personal AI for your desktop. Full screen, an orange hologram you talk to, and two 3D maps projected above a holographic table: one of everything it knows, one of your files.

![The hologram in the Core view](docs/core.png)

## Run it

```bash
npm install
```

```bash
npm start
```

`npm run dev` opens it in a window instead of full screen. F11 (or `F`) toggles full screen.

Requires Node 20+. The first launch downloads the speech models (about 105 MB, once: Whisper to hear you, tiny-voca to speak) — you'll see progress in the top-left corner. `npm install` also brings the Claude Agent SDK with its own copy of Claude Code (about 400 MB); Jarvis prefers the `claude` you already have and falls back to that copy.

### Give it a brain

If you use [Claude Code](https://claude.com/claude-code) and are signed in to it, there is nothing to set up: Jarvis thinks through that sign-in. No API key.

Press **Tab** to open the controls to change it. Under **Brain**:

- **Cloud** — Claude (Opus 5.5 by default; Sonnet, Haiku and Fable are in the dropdown; Haiku answers soonest). **Sign in with** chooses how:
  - **Claude login (Claude Code CLI)**, the default. Jarvis runs the `claude` program on your computer and uses the account it is signed in to, so replies count against that plan's limits. The line underneath says what it found — `Claude Code 2.1.332 found · signed in` — or what to do: install the CLI, or run `claude` in a terminal and sign in, then press **Re-check**. If `claude` is somewhere unusual, put its location in **Path to claude**.
  - **API key** — paste an Anthropic API key instead. It is stored encrypted with your OS keychain.
- **Local** — install [Ollama](https://ollama.com), pull a model that supports tools (`ollama pull qwen3`), and choose it from the list. Nothing leaves your machine.

You can flip between cloud and local at any time from the chip in the top-left corner; the conversation and memory carry over. The chip also says when the cloud brain cannot answer yet (`signed out`, `no Claude Code`, `no API key`).

With the Claude login, Jarvis uses Claude Code only as a way to reach the model. The model gets Jarvis's own tools and, with Internet access on, web search and page fetching — never Claude Code's shell, file editing or agents, and nothing from your Claude Code settings, instructions, hooks, skills, plugins or MCP servers. Jarvis's conversations do not appear among your Claude Code sessions, and your other Claude Code sessions cannot send it messages. Variables in your shell that would point Claude Code somewhere else (an API key, a gateway address, a Bedrock or Vertex switch) are not passed on: replies go to Anthropic on the Claude login, or not at all.

One thing Jarvis cannot leave out: on a computer where an organisation manages Claude Code, that organisation's policy (its managed settings) applies here too, and any hooks it sets are handed what you say and what Jarvis answers. The sign-in line says so when that is the case — `… signed in · managed by your organisation …` — and an API key or Local avoids it. If the policy requires its own MCP servers, or sends Claude Code to Bedrock, Vertex or a gateway instead of a Claude login, Jarvis does not use Claude Code at all and says to choose an API key or Local.

The sign-in is yours and for your own use; Anthropic's terms do not let an app hand a Claude login on to other people.

## Talking to it

Just talk. It listens continuously, works out when you've finished a thought, and answers out loud sentence by sentence as the reply is generated. Talk over it and it stops and listens.

| | |
|---|---|
| Hold **Space** | Push-to-talk (works even with hands-free off or the mic muted) |
| **/** or **Enter** | Type instead |
| **Esc** | Close whatever is open (the type box, the controls, the file viewer, a card), otherwise interrupt; during a transcription, stop it first |
| **M** | Mute the microphone |
| **1 2 3** | Core / Mind / Files view |
| **Tab** | Controls |

While you talk, the words it has caught so far appear under the hologram and settle into the final transcript when you stop (live captions use a small extra model, about 124 MB, fetched the first time you speak). Its own reply is captioned as it speaks: the part already said is bright, the rest dim.

### Files, by voice

Ask for a file and it opens in the app's viewer, then Jarvis answers about it:

- "Show me the cottage picture." · "Pull up the floor plan model." · "Open last week's minutes."
- "What's in this?" or "Summarize this." — *this* is whatever the viewer is showing. You get three to five sentences aloud; for anything long, a fuller summary is also saved as a document next to the file's Text tab.
- "Transcribe this." — for a recording or video, Jarvis's own speech recognizer writes out what is said, with times; for a PDF, Word file, slides, spreadsheet or web page it pulls out the full text; for a picture it reads the text in it. The transcript appears in the viewer's **Text** tab and is saved as a project document. It is not read out. A long recording gets an estimate first ("forty minutes long, about seven minutes to transcribe") and goes ahead when you say so; Esc stops it, and so does talking to Jarvis meanwhile — the part already done is kept as a partial transcript.

The viewer's **Summarize** and **Transcribe** buttons ask the same thing.

Speech recognition (Whisper) and the voice both run locally. The voice is [tiny-voca](https://github.com/n4ze3m/tiny-voca) by default: a small model (29 MB) that has a sentence ready in a few hundred milliseconds or less, so replies start almost at once. It speaks American English only, male (M2) or female (F2), at a speed you choose. For a more natural voice, British by default, choose **Neural voice (Kokoro)** under Voice: each sentence takes a second or more to prepare, and it downloads 92 MB the first time, then a larger, faster copy (325 MB) in the background. If the fast voice cannot be downloaded or started, Jarvis says so and uses Kokoro (if it is already downloaded) or the system voice until the next launch. Coming from an earlier Jarvis, you move to the fast voice unless you had picked a Kokoro voice other than George.

tiny-voca is by n4ze3m, under the Apache-2.0 licence; its phonemizer is included in `src/main/vendor/tiny-voca`, and the model is downloaded from Hugging Face.

If you use open speakers and it keeps interrupting itself, turn off "Let me interrupt while it is talking" under Voice, or use headphones.

The microphone and the speaker are chosen separately under **Voice** in the controls — a headset microphone with desk speakers, say. The meter beside the microphone shows what it hears and **Test** plays a tone through the speaker. If a chosen device is unplugged, Jarvis uses the system default until it comes back.

## What's on screen

- **Core** — the hologram. It breathes when idle, tightens its rings when it hears you, spins up while thinking, and its surface follows the voice when it speaks.
- **Mind** — a 3D map of what it knows. Projects are the double-ringed gold hubs; people, topics, facts, tasks and documents hang off them. Click any marker to see it, and **Forget** to delete it.
- **Files** — a 3D map of your folders (your home folder by default; change it under Files in the controls). Folders are diamonds, files are dots, coloured by kind. Click a folder to open it further; click a file to open it in the viewer.
- **Viewer** — a framed pane over the scene that shows a file without leaving Jarvis: pictures (scroll to zoom, drag to pan), 3D models (glTF/GLB, OBJ, STL, PLY, FBX, 3MF, DAE — turning slowly as an amber hologram, or **Solid** in their own materials; drag to spin), PDFs, markdown, code and text with line numbers, CSV tables, audio and video. Word, Excel and PowerPoint files get an info card — Jarvis can still read them. Along the bottom: **Summarize**, **Transcribe**, **Open in default app**, **Show in folder**. A transcript or extracted text shows in the **Text** tab, with **Copy**. Esc closes it. While a video or recording plays, hands-free listening pauses so Jarvis does not take the soundtrack for you (push-to-talk still works).

![The Mind view](docs/mind.png)

![The Files view](docs/files.png)

You can also ask for these by voice: "show me my files", "pull up the volleyball project", "show me roster.csv".

Ask where something is — "where's the roster?", "where did I put the serve ladder?" — and Jarvis flies to it on whichever map it lives on, opening folders down to it if need be, and marks it. It also points on its own, once, when the talk turns to a project, person, document or file that is on a map; a file it opens is marked on the Files map behind the viewer, and asked where something else is while a file is open, it closes the viewer to show you. It never moves the view while you have hold of it or the controls are open.

## Memory and projects

After each exchange a background step files anything durable — people, plans, preferences, decisions — into the mind map. That map is what gets put in front of the model, so:

- deleting a node (in the Mind view, in the controls, or by saying "forget about X") removes it from what Jarvis knows, including mentions in the saved conversation;
- related things are grouped into **projects** automatically when a conversation is clearly part of an ongoing effort ("let's plan practices for my U14 team", "I want to research home batteries").

Long work — a practice plan, research notes, a dataset — is written as a markdown document into the project's folder rather than read aloud. Jarvis tells you the gist and can open it.

## Skills and connections

- **Skills** are plain-language instructions Jarvis loads when a task calls for them. Three ship by default (practice planner, research collector, daily briefing). Add your own in the controls, or import any folder containing a `SKILL.md`.
- **Connections** are [MCP servers](https://modelcontextprotocol.io) — add one by command (`npx -y @modelcontextprotocol/server-filesystem ~/Documents`) or by URL, and its tools become available immediately. Command-type servers run as programs on your computer with your permissions, so only add ones you trust.
- **Internet access** is a single switch (top-left chip). Off means no search or page fetching tools are offered to the model at all.

## Privacy

- Local mode: everything stays on the machine.
- Cloud mode: what you say, the memory summary, and tool results (including any file contents Jarvis reads at your request) are sent to Anthropic — through your Claude login or your API key, whichever is chosen.
- With the Claude login, the Claude Code program adds a little of its own to each request: the account's email address, and a note of the operating system, the date and the (empty) folder inside Jarvis's data folder that it runs in. Pages are fetched from this computer rather than by Anthropic. It keeps no transcript, and nothing is remembered between one reply and the next except what Jarvis's own memory puts in front of it — so what you delete is gone there too.
- With the Claude login on a computer whose Claude Code is managed by an organisation, that organisation's policy still applies: hooks it sets receive what you say together with the memory summary sent along, the inputs of the tools Jarvis uses, and the reply, and its settings can turn on its own logging. Jarvis shows this under Brain and when it starts; it cannot switch it off. An API key or Local is not subject to it.
- Files are read only when you ask to see them or ask about them. In cloud mode, the text Jarvis reads out of a file, and a picture it looks at (scaled down to at most 1568 pixels on its long side), go to Anthropic with that request. Nothing is uploaded just because it is in the Files map or open in the viewer; while the viewer is open, only the file's name and location go along with what you say, so "this" works. In local mode a picture goes only to an Ollama model that can see images; others are told they cannot.
- Transcribing a recording or video happens on this computer, with the same speech recognizer that hears you; the sound is never sent anywhere. Only the transcript's opening lines go to the model, so it can tell you it is done — more only if you then ask about what was said.
- The viewer and file tools are confined to the folder you choose and Jarvis's own project documents (links pointing elsewhere are refused too); they can read and open, never write or delete. Files are shown, never run: web pages are shown as source, and markdown and SVG are drawn without scripts or remote content. Jarvis only writes inside its own project folders.
- All data lives in the app's data folder (shown under System in the controls).

## Development

```bash
npm test
```

```
src/main/        Electron main process: agent loop, memory graph, tools, MCP, file scan, speech process
src/main/llm/    The brains: Claude through the Claude Code login or an API key (cloud), Ollama (local)
src/renderer/    The window: hologram, 3D graphs, voice loop, HUD and controls
```
