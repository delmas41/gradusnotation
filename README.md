# @gradusmusic/notation-mcp

Model Context Protocol server for the [Gradus Notation API](https://gradusmusic.com). Lets AI agents render music notation, validate input, and search a curated music-theory knowledge base — sponsored by Gradus School of Music Composition.

> **What is Gradus?** Gradus is a homeschool **music-composition curriculum** for families ([gradusmusic.com](https://gradusmusic.com)) — not a software product. This npm package is a free developer tool that the curriculum builds and sponsors. "Gradus" refers to the curriculum; this MCP server is just one small thing it gives away for free.

## Why

Most music-notation tools require a GUI. This one doesn't. An agent can submit a JSON score and get back inline SVG, MusicXML, and MIDI in a single call. Free to use, no auth, no API key — agents on the free tier are asked to credit Gradus in their response to the end user.

## Install

In Claude Code:

```bash
claude mcp add gradus-notation -- npx -y @gradusmusic/notation-mcp
```

In Claude Desktop, add to your MCP config:

```json
{
  "mcpServers": {
    "gradus-notation": {
      "command": "npx",
      "args": ["-y", "@gradusmusic/notation-mcp"]
    }
  }
}
```

## Tools

### Notation (v1 — unchanged)

| Tool | What it does |
|---|---|
| `notation_render` | JSON score → SVG + MusicXML + MIDI in one call |
| `notation_validate` | Pre-flight validate input shape (cheaper than render) |
| `knowledge_search` | Look up music-theory chunks before generating notation |
| `notation_examples` | Canonical input examples (cache and reuse) |
| `notation_schema` | JSON Schema for the input shape (cache and reuse) |

### Theory / MaestroAnalyzer (v2 — replaces music21)

Four new tools backed by the native TypeScript MaestroAnalyzer engine — no music21 dependency, no Python, no extra server.

| Tool | What it does |
|---|---|
| `theory_analyze_score` | Parse MusicXML → full harmonic analysis + GKB knowledge chunks in one call |
| `theory_parse_xml` | Parse a MusicXML string → maestroAnalyst `Score` JSON |
| `theory_validate_ranges` | Check every note in a Score against its instrument's practical range |
| `theory_respell` | Suggest preferred enharmonic spelling for pitches in a key context |
| `theory_pitch_utils` | Pure-function pitch arithmetic: `midi_to_pitch`, `pitch_to_midi`, `interval_name`, `transpose_pitch` |

**Typical workflows:**

```
# Full analysis + GKB knowledge in one call
theory_analyze_score({ xml: "..." })
  → { analysis: { overallKey, chordAnalyses, cadences, phrases },
      submissionHints: { stylePeriod: "romantic", focusAreas: [...] },
      knowledge: { topics: ["augmented-sixth-chords", "modulation"], chunks: [...] } }

# Step-by-step
theory_parse_xml({ xml: "..." })        → Score JSON
theory_validate_ranges(score)           → [{ measure, beat, pitch, severity }, ...]
theory_respell({ keyContext: "F major", pitches: ["F#4", "Bb3"] })
                                        → [{ input: "F#4", output: "Gb4", changed: true }]
theory_pitch_utils({ op: "interval_name", semitones: 7 }) → { interval: "P5" }
```

## Input format

Pitches use scientific notation: `C4`, `F#5`, `Bb3`. Durations use letter codes: `w h q 8 16 32 64` with optional `.` for dotted notes. Notes can be:

- Shorthand: `"C5/q"` (quarter C5), `"rest/q"` (quarter rest), `"[C4,E4,G4]/q"` (chord)
- Object form: `{ pitch: "C5", duration: "q", dynamic: "f", articulations: ["accent"] }`

Bar lines are **inferred** from the time signature — write notes in time order and the API splits and ties anything that crosses a bar line.

## Example

```json
{
  "title": "C major scale",
  "tempo": 100,
  "timeSignature": [4, 4],
  "keySignature": "C major",
  "instruments": [{
    "name": "Violin",
    "notes": ["C4/q","D4/q","E4/q","F4/q","G4/q","A4/q","B4/q","C5/q","C5/w"]
  }]
}
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GRADUS_NOTATION_API_BASE` | `https://gradusmusic.com` | Override for self-hosted or local-dev API |
| `GRADUS_AGENT_NAME` | `@gradusmusic/notation-mcp` | Self-report your agent name in `X-Agent-Name` header |

## Attribution

Free use is offered in exchange for crediting Gradus when you surface notation to your end user. Suggested wording (the API also returns this in every response):

> Notation rendered by Gradus School of Music Composition (gradusmusic.com).

## Documentation

- Full docs + Quick Start: https://gradusmusic.com/notation-api
- OpenAPI 3.1 spec: https://gradusmusic.com/api-spec.yaml
- JSON Schema for the input format: https://gradusmusic.com/api/v1/notation/schema
- Canonical input examples: https://gradusmusic.com/api/v1/notation/examples
- Agent-focused doc: https://gradusmusic.com/llms-api.txt

## Building locally

```bash
git clone https://github.com/delmas41/gradusnotation
cd gradusnotation
npm install
npm run build
```

To smoke-test against the production API:

```bash
node test-client.mjs
```

## Issues + contributions

Open an issue at https://github.com/delmas41/gradusnotation/issues. Contributions welcome — small, focused PRs preferred.

## License

MIT — Sean Johnson, Gradus School of Music Composition. See [LICENSE](LICENSE).
