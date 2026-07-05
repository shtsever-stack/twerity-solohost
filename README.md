# Twerity Light

Private local AI Twin for Pi SoloHost, designed around Docker Model Runner.

## v0.10.0 — Local AI providers

- **Multiple local providers** (Hermes-style, but local-only by design):
  Docker Model Runner stays built in; users can add **Ollama**, **LM Studio**
  or any local OpenAI-compatible server from Settings (presets included).
- **Local-only enforcement** — cloud base URLs are rejected server-side with a
  clear message: cloud models are part of Twerity.com. Twerity Light keeps the
  "nothing leaves your device" promise.
- Provider management: add / test connection (lists models + latency) /
  switch active / remove; optional API key stored in the encrypted profile.
- The model dropdown, chat, analysis, feed, calibration, daily prompt and
  consolidation all follow the active provider.
- Sidebar status shows the active provider name, online state and latency.
- Config: Gemma 4B is now labeled "recommended for AI analysis" in the
  SoloHost configurator.

## v0.9.0 — Honest Twin score + power features

### AI quality analysis (the headline)
- **"Analyze with AI"** on the Command Center: the local model reads the whole
  profile and scores 4 dimensions (style clarity, depth & specificity, topic
  coverage, memory quality) with short reasons and concrete advice. Vague,
  generic answers score low even when many fields are filled in.
- The displayed **Twin score** is now a 50/50 blend of the data score
  (quantity) and the AI quality score; the header shows the breakdown
  ("Data 74% · AI 58%") and warns when the profile changed since the last
  analysis.

### Twin training
- **Feed your Twin** — paste 10–50 real posts/messages at once; they are stored
  as writing samples and the model distills a style summary (saved as a pinned
  memory) plus up to 5 facts.
- **Style calibration** — the Twin writes the same message two ways; picking
  the one that "sounds like you" saves a pinned style-preference memory and a
  writing sample. Optional custom sentence per round.
- **Daily journal question** — one model-generated (or fallback) question per
  day in the Journal tab; tap it to start writing.
- **Memory clean-up** — "Clean up" in Twin Memory merges duplicate/overlapping
  unpinned memories with the model (pinned ones are never touched).

### Chat
- **Task modes** in the composer: Chat, Reply for me, Rewrite, Post, Explain —
  each adds a dedicated instruction server-side.
- **Download conversation as Markdown** (MD button in the chat topbar).

### App
- **Settings tab** — creativity (temperature), answer length, and a model
  picker populated live from Docker Model Runner; stored in the encrypted
  profile and applied to all model calls.
- **PWA** — manifest + service worker (network-first, offline shell fallback);
  installable on the phone home screen.
- **Profile snapshots** — the last 5 encrypted profile snapshots are kept in
  `data/backups/` before import, bulk feed and memory consolidation.
- **Unlock rate limit** — 8 failed passwords → 5-minute lockout.

All v0.8 behavior is kept: sessions, SSE streaming with Stop/Regenerate,
model-powered memory extraction, Twin Memory panel, markdown chat, import.

## Local test

```cmd
cd /d <your-path>\twerity-solohost-v10
docker build --no-cache -t twerity-solohost:v10 .
docker run --rm -p 127.0.0.1:18788:8787 ^
  -e APP_PASSWORD=test123456 ^
  -e LOCAL_MEMORY_KEY=test-local-memory-key-123 ^
  -e TWERITY_MODEL_PROVIDER=dmr ^
  -e TWERITY_DMR_URL=http://host.docker.internal:12434/engines/v1 ^
  -e TWERITY_DMR_MODEL=ai/gemma3:1B-Q4_K_M ^
  -e TWERITY_DMR_API_KEY=docker-model-runner ^
  twerity-solohost:v10
```

Open:

```txt
http://127.0.0.1:18788
```

## SoloHost publish image

The Compose file expects:

```txt
ghcr.io/shtsever-stack/twerity-solohost:latest
```

Pushing to the `main` branch of `shtsever-stack/twerity-solohost` builds and
publishes `:latest` automatically via GitHub Actions. For a manual versioned
push:

```cmd
docker tag twerity-solohost:v10 ghcr.io/shtsever-stack/twerity-solohost:v0.10.0
docker tag twerity-solohost:v10 ghcr.io/shtsever-stack/twerity-solohost:latest
docker push ghcr.io/shtsever-stack/twerity-solohost:v0.10.0
docker push ghcr.io/shtsever-stack/twerity-solohost:latest
```

Make the GHCR package public before using it in SoloHost.

## Light version notice

Twerity Light does not include TWER rewards, and usage here is separate from PortalPi.games.
For now, TWER credits are available only on PortalPi.games.

This app runs locally through SoloHost. Nothing syncs automatically; users can export their Twin profile manually when they decide.
