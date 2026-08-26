# @gradusmusic/notation-mcp

Model Context Protocol server for the [Gradus Notation API](https://gradusmusic.com/notation-api). Gives AI agents music tools: render notation, validate input, analyze scores, check engraving against a cited rulebook, and search a curated music-theory knowledge base — sponsored by Gradus.

**General-purpose, not education-specific.** Any agent or application that works with music is the audience — composition assistants, musicology and corpus research, theory Q&A that wants rendered examples, MIDI pipelines, engraving quality checks, games, documentation. Music education is where the tool comes from, not a restriction on what you build with it.

**One install, three named tools:**

- **Gradus Notation** — render a JSON score to inline SVG, MusicXML, and MIDI, with pre-flight validation (`notation_render`, `notation_validate`).
- **Gradus Harmonic Analyzer** — full-score analysis: Roman numerals, keys and modulations, cadences, pedal points, texture (`theory_analyze_score` and the `theory_*` tools). Also a standalone TypeScript library: [`gradus-analyst`](https://www.npmjs.com/package/gradus-analyst) on npm.
- **Gradus Engraver** — checks a score against the [Gradus Engraving Rulebook](https://gradusmusic.com/engraving)'s citable GE-coded rules (`engraving_check`).

> **What is Gradus?** Gradus is a music-composition curriculum for homeschool families; it builds and gives away free music tools for AI agents. This MCP server is one of those tools ([gradusmusic.com](https://gradusmusic.com)) — "Gradus" refers to the curriculum, never to this package.

## Why

Most music-notation tools require a GUI. This one doesn't. An agent can submit a JSON score and get back inline SVG, MusicXML, and MIDI in a single call. Free to use, no auth, no API key — agents on the free tier are asked to credit Gradus in their response to the end user.

Beyond rendering, the same server exposes the analysis side: Roman-numeral and key analysis of a full score, pitch utilities, range validation, enharmonic respelling, and a 444-rule engraving checker with citable rule codes. One install covers the whole music surface an agent needs.

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

### Gradus Notation

| Tool | What it does |
|---|---|
| `notation_render` | JSON score → SVG + MusicXML + MIDI in one call |
| `notation_validate` | Pre-flight validate input shape (cheaper than render) |
| `knowledge_search` | Look up music-theory chunks before generating notation |
| `notation_examples` | Canonical input examples (cache and reuse) |
| `notation_schema` | JSON Schema for the input shape (cache and reuse) |

### Gradus Harmonic Analyzer

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

### Gradus Engraver — checks against the Gradus Engraving Rulebook

| Tool | What it does |
|---|---|
| `engraving_rules` | Search 423 sourced music-engraving rules by text, domain, severity, or how they are checked |
| `engraving_rule` | Fetch one rule by its permanent id, with a ready-to-quote citation and related rules |
| `engraving_check` | Check a MusicXML score against the rulebook — findings by part and measure, each citing the rule it breaks |

Engraving practice is documented almost entirely in copyrighted print — Gould's
*Behind Bars*, Read's *Music Notation*, Ross's *The Art of Music Engraving* —
with no searchable index. So "may a beam cross a barline" has no citable answer
online, and a model asked that question answers confidently from memory. These
tools return the rule **with its source**, so the answer can be checked.

Each rule separates three things that are usually mashed together: `convention`
(the rule), `authority` (what the treatises say, cited at chapter level), and
`houseCall` (where Gradus came down when the sources disagree). Rule ids are
permanent and rule text is CC BY 4.0 — quote the `citation` field.

```
# Look up before you generate
engraving_rules({ q: "stem direction", tier: "static-model" })
  → { rulebook: { version, license, domains }, count, rules: [{ id, name, convention, authority, ... }] }

# Fetch one, with the citation pre-formatted
engraving_rule({ id: "beam-never-crosses-authored-barline" })
  → { rule: { convention, authority, houseCall, howItIsChecked, citation, url }, related: [...] }
```

A wrong id is cheap: the API answers 404 with near-matching ids, so you can
correct in one more call.

`engraving_check` closes the loop: generate notation, check it, fix what it
finds. Pass a local file path when you can — the server reads it directly, so
the score never has to travel through the model's context as base64:

```
engraving_check({ path: "/tmp/my-piece.musicxml" })
  → { coverage: { parts, measures, notesChecked, unchecked: [...] },
      findings: [{ ruleId, severity, part, measure,
                   rule: { code: "GE-226", url, citation } }],
      summary: { errors, warnings, suggestions } }
```

Read `coverage.unchecked` before trusting an empty findings list — anything the
checker could not verify is named there rather than silently passed.

### Craft tools

| Tool | What it does |
|---|---|
| `music_critique` | 32-dimension craft scorecard for a score — voice leading, counterpoint, contour, harmony, texture; purely programmatic, evidence-cited |
| `counterpoint_check` | Fux species grader (species 1–5): pitch lists in, note-indexed rule violations out |
| `corpus_search` | Find harmonic features in 482 analyzed works — `cadence=Phrygian`, `rn=Ger+6`, `texture=bare-fifth` — with work/movement/measure citations |

When a user shares a piece, these ground your feedback in evidence: the critique
cites what it measured, the species grader points at the exact note, and the
corpus search answers "show me a real example" with a citation.

### The Gradus Voice-Leading Reference

| Tool | What it does |
|---|---|
| `voice_leading_patterns` | Search the citable GVL-coded patterns — suspensions, cadences, the Rule of the Octave, sequences, part-writing norms — each with an authored realization and public-domain sources |
| `voice_leading_pattern` | Fetch one pattern by id or GVL code, with a ready-to-quote citation and related patterns |

The sibling of the Engraving Rulebook: where GE codes cover how music should
look on the page, GVL codes cover how voices should move. Every pattern cites
the public-domain treatise it rests on — Fux, Rameau, Kirnberger, Fenaroli,
Riepel, Prout — at chapter level, never through a modern edition, and the
`realization.voices` field is notation-API shorthand you can hand straight to
`notation_render` to engrave.

```
voice_leading_patterns({ q: "suspension", family: "suspensions" })
  → { reference: { version, license, families }, count,
      patterns: [{ code: "GVL-001", id: "suspension-4-3", statement, realization, sources, ... }] }

voice_leading_pattern({ id: "GVL-001" })
  → { pattern: { statement, realization, commonFaults, sources, citation, url }, related: [...] }
```

### The Gradus Figured-Bass Corpus

| Tool | What it does |
|---|---|
| `figured_bass_exercises` | Search 166 original graded figured-bass exercises across seventeen stages — filter by stage, or search titles, concepts and GVL codes |
| `figured_bass_exercise` | Fetch one exercise by its permanent id, with the model realization, its teaching note, and the patterns it drills |

Where the Voice-Leading Reference states the rule, the corpus is the practice:
a bass, its figures, and — unlike almost every surviving collection — a
four-part **model realization**, machine-checked for voice leading. The stages
run from root-position triads through the Rule of the Octave, cadence formulas,
suspensions, the dominant seventh, sequences, minor mode, pedal point, the
Riepel schemata, modulation and chromatic figures to unfigured bass and
diminution.

Every exercise is original — nothing is transcribed from any edition — and the
whole corpus is CC BY 4.0. Exercise ids and stage slugs are permanent, so a
citation keeps resolving. `givenBass` is what you show the student;
`realization` is the answer to hold back until they have tried. Both are
notation-API shorthand, so either goes straight to `notation_render`.

```
figured_bass_exercises({ stage: "suspensions", fields: "id,title,teaches" })
  → { corpus: { version, license, stages }, count: 12,
      exercises: [{ id: "bass-225", title: "Suspension 4–3", teaches, ... }] }

figured_bass_exercise({ id: "bass-225" })
  → { exercise: { givenBass, realization, solutionNote, keyboard, citation, url },
      drills: [{ code: "GVL-001", name: "The 4–3 suspension", url }],
      neighbours: { prev, next } }
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
