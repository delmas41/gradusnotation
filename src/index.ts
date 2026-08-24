#!/usr/bin/env node
/**
 * @gradusmusic/notation-mcp — Model Context Protocol server for the Gradus
 * Notation API. Exposes the public REST endpoints at gradusmusic.com as MCP
 * tools so any MCP-aware agent (Claude Code, Claude Desktop, Cursor, etc.)
 * can render notation, validate input, and search music-theory knowledge
 * with one line of config and zero auth.
 *
 * Sponsored by Gradus School of Music Composition (gradusmusic.com).
 *
 * Usage in Claude Code:
 *   claude mcp add gradus-notation -- npx -y @gradusmusic/notation-mcp
 *
 * Configuration via env vars:
 *   GRADUS_NOTATION_API_BASE   override the API base URL (default: https://gradusmusic.com)
 *   GRADUS_AGENT_NAME          self-reported agent name sent in X-Agent-Name (helps Sean see who's using it)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = (process.env.GRADUS_NOTATION_API_BASE ?? 'https://gradusmusic.com').replace(/\/+$/, '');
const AGENT_NAME = process.env.GRADUS_AGENT_NAME ?? '@gradusmusic/notation-mcp';
const PKG_VERSION = '0.6.0';

// Validate the configured API base at startup. A malicious or misconfigured
// override (e.g. plaintext http, or a non-URL string) would otherwise let a
// network attacker MITM every tool call. Localhost http is permitted so
// developers can point at a local dev server.
(() => {
  let parsed: URL;
  try {
    parsed = new URL(API_BASE);
  } catch {
    throw new Error(
      `Invalid GRADUS_NOTATION_API_BASE: ${JSON.stringify(API_BASE)} is not a valid URL.`,
    );
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error(
      `GRADUS_NOTATION_API_BASE must use https:// for non-local hosts ` +
      `(got ${parsed.protocol}//${parsed.hostname}). Plaintext http would let a ` +
      `network attacker intercept or modify tool calls.`,
    );
  }
})();

// ── HTTP helper ──────────────────────────────────────────────────────────────

// Default per-request timeout. Node's global fetch has no built-in timeout —
// without this, a slow or stuck upstream would hang the MCP tool call (and
// therefore the agent that invoked it) indefinitely.
const DEFAULT_TIMEOUT_MS = 30_000;

async function callApi(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Build headers via the Headers class and `.set()` last for OUR fields.
  // Plain-object header merging through Node's built-in fetch (undici) can
  // silently drop a user-set `User-Agent` and replace it with the default
  // (`undici`) — see https://github.com/nodejs/undici/issues/2392 and related.
  // Using a Headers instance + case-insensitive `.set()` AFTER merging the
  // caller's headers guarantees our attribution survives every code path.
  const headers = new Headers(init?.headers ?? undefined);
  headers.set('Content-Type', 'application/json');
  headers.set('X-Agent-Name', AGENT_NAME);
  headers.set('User-Agent', `gradus-notation-mcp/${PKG_VERSION}`);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const errBody = json ?? text.slice(0, 500);
      throw new Error(`Gradus API ${res.status} at ${path}: ${JSON.stringify(errBody)}`);
    }
    return json;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Gradus API request timed out after ${timeoutMs}ms at ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'notation_render',
    description:
      'Render music notation from a JSON score into three output formats in a single call: inline SVG (engraved through Verovio with the Bravura SMuFL font — same engine as IMSLP and the Music Encoding Initiative), round-trippable MusicXML (opens cleanly in Sibelius, Finale, MuseScore, Dorico), and base64-encoded SMF Type-1 MIDI.\n\n' +
      'WHEN TO USE: when the agent needs to surface engraved notation to its user (composer demoing an idea, teacher making a worksheet, content creator embedding a notation example), or when converting a JSON score to file formats other agents/tools can consume (MusicXML for desktop notation software, MIDI for sequencers).\n\n' +
      'WHEN NOT TO USE: if you are not sure the input is well-formed → call notation_validate first (much cheaper, no rendering); if you do not yet know the input format → call notation_examples or notation_schema; if you need theory facts before composing → call knowledge_search first.\n\n' +
      'INPUT: requires `instruments` (non-empty array). Each instrument has `name` (required; clef is inferred from the name — "Cello" → bass, "Viola" → alto, "Timpani" → percussion — overridable via `clef`) and either `notes` (single-voice shortcut) or `voices` (multi-voice). Pitches use scientific notation ("C4", "F#5", "Bb3"); durations use letter codes ("w" "h" "q" "8" "16" "32" "64" with optional "." for dotted, ".." for double-dotted). Bar lines are inferred from `timeSignature` (default [4,4]); notes that cross a bar line are split and tied automatically — agents do not count beats.\n\n' +
      'OUTPUT (JSON, success): { ok: true, requestId, outputs: { svg: string, musicxml: string, midiBase64: string }, meta: { measureCount, instrumentCount, voiceCount, durationBeats, renderTimeMs }, warnings?: ValidationIssue[], attribution }. ValidationIssue = { path, code, message, fix?, severity: "error"|"warning" }. SVG is typically 60-100 KB with Bravura font embedded; MusicXML is a few KB; MIDI is sub-1 KB.\n\n' +
      'OUTPUT (JSON, validation failure): { ok: false, requestId, errors: ValidationIssue[], attribution }. Each error includes a concrete `fix` field — surface that to your end user or use it to repair the input automatically.\n\n' +
      'EXAMPLE INPUT: { "title": "C major scale", "tempo": 100, "timeSignature": [4,4], "keySignature": "C major", "instruments": [{ "name": "Violin", "notes": ["C4/q","D4/q","E4/q","F4/q","G4/h","rest/h"] }] }\n' +
      'TYPICAL LATENCY: 100 ms (single-line melody) to 1.5 s (string quartet, 16+ measures).',
    inputSchema: {
      type: 'object',
      required: ['instruments'],
      properties: {
        save_dir: {
          type: 'string',
          description: 'Local directory to save the outputs into (created if missing). When set, the SVG, MusicXML, and MIDI are written as files named after the title and the response returns their paths instead of ~80 KB of inline content — strongly preferred when you want the files rather than the markup.',
        },
        title: { type: 'string', description: 'Optional title rendered above the score.' },
        composer: { type: 'string', description: 'Optional composer rendered top-right.' },
        tempo: { type: 'number', default: 100, description: 'Tempo in BPM. Affects MIDI timing only; not visually rendered.' },
        timeSignature: {
          type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, default: [4, 4],
          description: '[beats, beat-unit]. Common values: [4,4], [3,4], [6,8], [2,2], [12,8].',
        },
        keySignature: {
          type: 'string', default: 'C major',
          description: 'Human-readable key signature. Accepts "C major", "G major", "D minor", "F# major", "Bb minor", etc.',
        },
        instruments: {
          type: 'array', minItems: 1,
          description: 'One or more instrument staves. At least one required.',
          items: {
            type: 'object', required: ['name'],
            properties: {
              name: { type: 'string', description: 'Display name (e.g. "Violin", "Cello", "Piano LH"). Clef is inferred from the name if omitted.' },
              clef: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor', 'percussion'], description: 'Optional clef override.' },
              notes: {
                type: 'array', items: { type: ['string', 'object'] },
                description: 'Single-voice shortcut. Notes can be shorthand strings ("C5/q" quarter, "rest/q" quarter rest, "[C4,E4,G4]/q" chord, "C5/q>" with accent) OR objects ({ pitch: "C5", duration: "q", dynamic: "f", articulations: ["accent"], tiedToNext: true }).',
              },
              voices: {
                type: 'array',
                description: 'Multi-voice form for staves with multiple independent lines (e.g. SATB choir). Replaces `notes`. Format: [{ voice: 1, notes: [...] }, { voice: 2, notes: [...] }]. voice numbers 1-4.',
              },
              transposition: {
                type: 'number', default: 0,
                description: 'Semitones below concert pitch for transposing instruments (Bb clarinet=2, F horn=7, Eb alto sax=9, bass clarinet=-10). Most agents should leave at 0.',
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'notation_validate',
    description:
      'Pre-flight validate a notation_render input without rendering. Returns errors with concrete `fix` field that tells the agent exactly how to repair malformed input. Substantially cheaper than notation_render because it skips the Verovio engraving step entirely.\n\n' +
      'WHEN TO USE: when iterating on input shape and uncertain whether it is well-formed; when input came from user-supplied or LLM-generated data that may be malformed; when surfacing precise validation errors to your end user before committing to a full render; when learning the input format (combine with notation_examples to see canonical inputs).\n\n' +
      'WHEN NOT TO USE: if input is known to be valid (just call notation_render directly — it validates internally too); if you have not learned the schema yet (call notation_schema or notation_examples first to see the format).\n\n' +
      'INPUT: identical shape to notation_render. `instruments` array required (each with `name` and `notes` or `voices`).\n\n' +
      'OUTPUT (JSON, valid): { ok: true, requestId, valid: true, warnings: ValidationIssue[], meta: { measureCount, instrumentCount, voiceCount, durationBeats }, attribution }. Warnings are non-blocking notices (e.g. unusual time signature handling).\n\n' +
      'OUTPUT (JSON, invalid): { ok: false, requestId, valid: false, errors: ValidationIssue[], warnings, attribution }. Each ValidationIssue: { path: "instruments[0].voices[0].notes[3]", code: "BAD_PITCH"|"BAD_DURATION"|"MISSING_FIELD"|"BAD_KEY_SIG"|..., message, fix: "Use scientific notation: letter A-G + optional # or b + octave number, e.g. C4, F#5, Bb3.", severity: "error"|"warning" }. Surface the `fix` to your user or use it to auto-repair.\n\n' +
      'EXAMPLE INPUT: { "instruments": [{ "name": "Violin", "notes": ["C5/q","D5/q","E5/q","F5/q"] }] }\n' +
      'TYPICAL LATENCY: 30-100 ms (no Verovio render; pure JSON-to-Score conversion + bar-line arithmetic).',
    inputSchema: {
      type: 'object', required: ['instruments'],
      properties: {
        title: { type: 'string' }, composer: { type: 'string' },
        tempo: { type: 'number' },
        timeSignature: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        keySignature: { type: 'string' },
        instruments: {
          type: 'array', minItems: 1,
          description: 'Same shape as notation_render. See notation_schema for the full JSON Schema.',
          items: { type: 'object' },
        },
      },
    },
  },
  {
    name: 'knowledge_search',
    description:
      'Search the Gradus music-theory knowledge base for authoritative source material. The corpus includes hand-authored curriculum prose, Bach chorale analysis (408 chorales), score commentaries on 50+ orchestral works, and primary historical sources from Fux (1725) through Boulanger.\n\n' +
      'WHEN TO USE: before generating notation if you need to look up a specific theory fact — typical voice leading for a Neapolitan-to-V resolution, idiomatic figured-bass realizations of a particular cadence, what makes a chromatic mediant feel like one composer\'s style versus another. Hitting this first prevents the agent from inventing chord progressions that are stylistically wrong.\n\n' +
      'WHEN NOT TO USE: for generic music vocabulary ("what is a chord?") that any LLM already knows; for non-theory queries like composer biographies, performance recommendations, or history dates — those are out of scope; for fetching actual score notation (use notation_render or notation_examples instead).\n\n' +
      'INPUT: provide EITHER `topics` (kebab-case tags) OR `step` (curriculum step 1-49). Topics are stronger; step is the fallback when you do not know the canonical topic tag. Both empty returns a MISSING_QUERY error.\n\n' +
      'OUTPUT (JSON): { ok: true, requestId, chunks: [{ id, sourceType, sourceId, title, content, composer?, era?, topics: string[], curriculumSteps: number[], tokenEstimate }], meta: { query, returnedCount, totalTokens, responseTimeMs }, attribution }. `sourceType` is one of: kg_concept, score_analysis, score_commentary, bach_chorale_analysis, composer, dictionary, curriculum, lesson_content, practicum, voice_leading, fugue, chorale_exercise, etc. Empty `chunks: []` when nothing matched the topics — agent should fall back to its own knowledge or try a different topic tag.\n\n' +
      'EXAMPLE INPUT: { "topics": ["voice-leading", "deceptive-cadence"], "limit": 3 }\n' +
      'TYPICAL LATENCY: 200-700 ms (one Voyage 3 embedding call + Supabase pgvector RPC).',
    inputSchema: {
      type: 'object',
      properties: {
        topics: {
          type: 'array', items: { type: 'string' },
          description:
            'Topic tags in kebab-case. Matched semantically via Voyage 3 Large embeddings plus a topic-overlap boost; exact-match is not required, so close synonyms work. Examples: ["voice-leading","deceptive-cadence"], ["chromatic-mediants"], ["sonata-form","second-theme"], ["figured-bass","6-4-2-chord"], ["fugue","stretto"], ["modulation","pivot-chord"].',
        },
        step: {
          type: 'integer', minimum: 1, maximum: 49,
          description:
            'Curriculum step number (1-49). Fallback when you do not know the topic tag. Maps to the Gradus 10-stage curriculum: Stage I 1-7 (single voice, intervals, scales), II 8-13 (counterpoint, all 5 species), III 14-16 (harmony, third voice), IV 17-18 (form, modulation), V 19-20 (fugue), VI 21-25 (classical style, sonata), VII 26-30 (Romantic harmony, augmented sixths), VIII 31-33 (Impressionist), IX 34-36 (20th century), X 37-40 (advanced).',
        },
        limit: {
          type: 'integer', minimum: 1, maximum: 20, default: 8,
          description: 'Maximum chunks to return. Default 8 is right for most queries; raise for broad surveys, lower for tight context budgets.',
        },
        maxTokens: {
          type: 'integer', minimum: 200, maximum: 4000, default: 1500,
          description: 'Token budget for the combined chunk content. Default 1500 fits comfortably in most agent context windows. The endpoint greedy-selects highest-similarity chunks within this budget.',
        },
      },
    },
  },
  {
    name: 'notation_examples',
    description:
      'Fetch six canonical example inputs covering the most common notation_render use cases: single-line melody, two-voice counterpoint (cantus firmus + counterpoint), block-chord progression (cadence), mixed rhythms with dynamics + articulations, four-instrument string quartet, and notes tied across a bar line.\n\n' +
      'WHEN TO USE: first encounter with this MCP — fetch examples to learn the input format with concrete worked patterns; before a notation_render call when uncertain how to express a particular musical structure (a chord, a multi-voice staff, a tied note); to show your end user what kinds of notation are possible.\n\n' +
      'WHEN NOT TO USE: after caching the response (the examples are stable across the v1 API; fetch once and reuse forever); when you only need formal type definitions (use notation_schema for JSON Schema instead).\n\n' +
      'INPUT: none. Pass an empty object `{}`.\n\n' +
      'OUTPUT (JSON): { ok: true, examples: [{ id, title, description, use_when, input: NotationInput }], docs: { schema, render, validate }, attribution }. Six examples with stable ids: single-melody, two-voice-counterpoint, chord-progression, mixed-rhythms, string-quartet-snippet, tied-across-bar. Each `input` is a complete payload that can be passed directly to notation_render.\n\n' +
      'EXAMPLE INPUT: {} (no parameters)\n' +
      'TYPICAL LATENCY: 30-200 ms. Response is cached at CDN with long TTL — subsequent calls are essentially free.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'notation_schema',
    description:
      'Fetch the JSON Schema (Draft 2020-12) describing the notation_render input shape. Includes every field, its type, defaults, validation rules (including the shorthand-string regex pattern), and `$defs` for Instrument, VoiceLine, Note, and NoteObject.\n\n' +
      'WHEN TO USE: first encounter with this MCP and you want machine-readable type definitions; building a client that validates input client-side before calling notation_render; generating code (TypeScript types, Zod schemas, etc.) that consumes the format.\n\n' +
      'WHEN NOT TO USE: after caching the response (stable across the v1 API); when you want learning-by-example (use notation_examples instead — worked payloads are easier to read than schema definitions).\n\n' +
      'INPUT: none. Pass an empty object `{}`.\n\n' +
      'OUTPUT (JSON): { ok: true, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", $id, title, type: "object", required: ["instruments"], properties, $defs: { Instrument, VoiceLine, Note, NoteObject } }, docs: { examples, render, validate }, attribution }. The `schema` field is a complete JSON Schema document.\n\n' +
      'EXAMPLE INPUT: {} (no parameters)\n' +
      'TYPICAL LATENCY: 30-200 ms. Response is cached at CDN with long TTL — subsequent calls are essentially free.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── V2: Theory tools (MaestroAnalyzer + GKB — no music21 required) ──────────

  {
    name: 'theory_validate_ranges',
    description:
      'Check every note in a Score JSON against its instrument\'s standard practical range. Returns warnings for out-of-range pitches with measure, beat, MIDI number, and severity.\n\n' +
      'WHEN TO USE: after parsing a MusicXML file with theory_parse_xml and before analysis — catch unplayable or extreme notes early; when generating or editing a score programmatically and want to verify instrument idiomatic range; when a student submits a composition for critique and range errors should be flagged.\n\n' +
      'SEVERITY LEVELS: "error" = note is > 1 semitone outside the practical range; "warn" = note is at the boundary (within 1 semitone).\n\n' +
      'SUPPORTED INSTRUMENTS (partial name match, case-insensitive): Violin, Viola, Cello, Double Bass, Harp, Flute, Piccolo, Oboe, English Horn, Clarinet, Bass Clarinet, Bassoon, Contrabassoon, Soprano/Alto/Tenor/Baritone Sax, Horn, Trumpet, Trombone, Tuba, Piano, Organ, Marimba, Xylophone, Vibraphone, Glockenspiel, Timpani, Soprano/Mezzo/Alto/Tenor/Baritone/Bass (voice).\n\n' +
      'INPUT: a maestroAnalyst Score object — obtain one by calling theory_parse_xml with MusicXML text.\n\n' +
      'OUTPUT: { ok, requestId, warnings: [{ measure, beat, pitch, midi, partId, instrumentName, min, max, severity }], attribution }. Empty `warnings` array means all notes are in range.\n\n' +
      'EXAMPLE: pass a Score with a Violin part containing a note at A7 (MIDI 105) — it will return severity "error" since violin tops out around B7/MIDI 107 but A7 is beyond practical range.',
    inputSchema: {
      type: 'object',
      required: ['notes', 'parts'],
      description: 'A maestroAnalyst Score object with `notes` and `parts` arrays.',
      properties: {
        notes: { type: 'array', description: 'Flat array of Note objects from a Score.' },
        parts: { type: 'array', description: 'Array of PartInfo objects ({ id, name }).' },
        measureCount: { type: 'integer' },
        keySignatures: { type: 'array' },
        timeSignatures: { type: 'array' },
      },
    },
  },
  {
    name: 'theory_respell',
    description:
      'Suggest the preferred enharmonic spelling for one or more pitches in a given key context. Picks the spelling that is diatonic to the key (e.g. F# in G major, Gb in F major). Uses the key\'s accidental preference (sharps/flats) as a tiebreaker for chromatic passing tones.\n\n' +
      'WHEN TO USE: after OMR (optical music recognition) to correct mis-spelled accidentals; when generating notation and unsure whether to write F# or Gb; when transposing — respell after the semitone shift to maintain diatonic spelling; before calling notation_render to clean up accidentals.\n\n' +
      'INPUT: { keyContext: string, pitches: string[] } OR { keyContext: string, pitch: string }. Pitch strings use scientific notation: "F#4", "Bb3", "C5", "Eb4".\n\n' +
      'OUTPUT: { ok, requestId, keyContext, results: [{ input, output, changed }], attribution }. `changed` is true when the spelling was adjusted.\n\n' +
      'EXAMPLES:\n' +
      '  { keyContext: "F major", pitches: ["F#4", "Bb4", "E4"] }\n' +
      '  → F#4→Gb4 (Gb is diatonic in F major), Bb4 unchanged, E4 unchanged.\n' +
      '  { keyContext: "G major", pitch: "Gb4" } → Gb4→F#4 (F# is diatonic in G major).',
    inputSchema: {
      type: 'object',
      required: ['keyContext'],
      properties: {
        keyContext: {
          type: 'string',
          description: 'Key signature string, e.g. "C major", "G major", "Bb minor", "F# major".',
        },
        pitch: {
          type: 'string',
          description: 'Single pitch string (scientific notation). Use this OR `pitches`.',
        },
        pitches: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of pitch strings. Use this OR `pitch`.',
        },
      },
    },
  },
  {
    name: 'theory_parse_xml',
    description:
      'Parse a MusicXML string into a maestroAnalyst Score object. The Score is the input type for theory_validate_ranges and can be passed to any maestroAnalyst analysis function.\n\n' +
      'WHEN TO USE: when you have a MusicXML file (e.g., exported from Sibelius, Finale, MuseScore, Dorico, or produced by notation_render) and want to analyse it — detect key, check ranges, respell accidentals. This is the entry point for the native analysis pipeline that replaces music21.\n\n' +
      'LIMITATIONS: accepts plain MusicXML text (score-partwise format). Does NOT accept .mxl ZIP archives — decompress first if needed. Score-timewise and other non-partwise formats are not supported.\n\n' +
      'INPUT: { xml: string } — the full MusicXML document text.\n\n' +
      'OUTPUT: { ok, requestId, score: Score, meta: { partCount, noteCount, measureCount }, attribution }. The Score JSON can then be passed to theory_validate_ranges or any other theory tool.\n\n' +
      'TYPICAL SIZE: a Bach chorale (4 parts, 32 measures) produces a Score with ~512 notes. A Beethoven symphony movement (12 parts, 400 measures) may produce 8,000+ notes. Fit within your context budget or process in chunks.',
    inputSchema: {
      type: 'object',
      required: ['xml'],
      properties: {
        xml: {
          type: 'string',
          description: 'Raw MusicXML document string (score-partwise format). Must begin with <?xml or <score-partwise.',
        },
      },
    },
  },
  {
    name: 'theory_analyze_score',
    description:
      'One-shot endpoint: parse MusicXML → run the full MaestroAnalyzer harmonic analysis pipeline → query the Gradus Knowledge Base (GKB) for curated theory chunks matched to the score\'s detected features. Returns both the algorithmic analysis and relevant hand-authored knowledge in a single call.\n\n' +
      'WHEN TO USE: when an agent has a MusicXML score and wants to know what\'s harmonically interesting about it — key, local-key trajectory, chord analyses with Roman numerals, cadences, phrase structure, style period, AND relevant theory context from the GKB (voice-leading rules, harmonic vocabulary, orchestration notes, historical context). This is the richest single-call analysis available.\n\n' +
      'WHEN NOT TO USE: if you only need range checking (theory_validate_ranges); if you only need re-spelling (theory_respell); if you want raw GKB search without score analysis (knowledge_search).\n\n' +
      'INPUT: exactly one of { path } (local score file, PREFERRED — .mxl or .musicxml; .mxl goes up compressed so full movements fit), { xml } (raw MusicXML text, 2 MB limit), or { mxlBase64 }. Plus: maxKnowledgeTokens? (default 1500), includeKnowledge? (default true), measures? ([from, to] — window the per-measure output to the bars you care about), full? (default false — by default the response is a COMPACT summary: keys, sections with sponsorship, cadences, per-measure textures, one reading per chord slice with pedal and tendency tags. A movement\'s full note-by-note response runs to megabytes; pass full: true only when you need the raw score echo and readings).\n\n' +
      'OUTPUT: {\n' +
      '  meta: { partCount, noteCount, measureCount },\n' +
      '  analysis: {\n' +
      '    overallKey: { key, mode, confidence },\n' +
      '    localKeys: [{ measure, key, confidence }],\n' +
      '    chordAnalyses: [{ measure, beat, primary, readings: [{ rn, rnAscii, inversion, localKey, confidence }], tendencyTones }],\n' +
      '    cadences: [{ type: "PAC"|"IAC"|"HC"|"DC"|"Plagal"|"Phrygian"|"unclear", ... }],\n' +
      '    phrases: [{ index, measureStart, measureEnd, fermataMeasures }],\n' +
      '  },\n' +
      '  submissionHints: { stylePeriod, focusAreas, rationale },  // inferred style heuristic\n' +
      '  knowledge: {\n' +
      '    topics: string[],   // GKB tags derived from the analysis\n' +
      '    chunks: [{ title, content, sourceType, era, composer, curriculumSteps }],\n' +
      '    totalTokens: number,\n' +
      '  },\n' +
      '}\n\n' +
      'TYPICAL LATENCY: 200-600 ms for short scores; a few seconds for a full symphony movement via path/.mxl (analysis is pure JS; GKB adds one Voyage embedding call ~100-200 ms).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Local path to a score file (.mxl or .musicxml/.xml) — PREFERRED: the file never rides through model context, and .mxl uploads compressed so full movements fit. Provide exactly one of path, xml, mxlBase64.',
        },
        xml: {
          type: 'string',
          description: 'Raw MusicXML document string (score-partwise format). 2 MB limit — for large scores use `path` or `mxlBase64`.',
        },
        mxlBase64: {
          type: 'string',
          description: 'Base64 of a compressed .mxl file, as an alternative to xml.',
        },
        full: {
          type: 'boolean', default: false,
          description: 'Return the full note-by-note response instead of the compact summary. A movement\'s full response runs to megabytes — leave this off unless you need the raw readings.',
        },
        measures: {
          type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2,
          description: 'Inclusive [from, to] measure window for the compact per-measure output, e.g. [39, 47].',
        },
        maxKnowledgeTokens: {
          type: 'integer', minimum: 200, maximum: 4000, default: 1500,
          description: 'Token budget for GKB knowledge chunks. Raise for richer context, lower for tight budgets.',
        },
        includeKnowledge: {
          type: 'boolean', default: true,
          description: 'Set false to skip GKB lookup and get analysis-only. Useful when knowledge is not needed or when latency matters.',
        },
        options: {
          type: 'object',
          description: 'Optional AnalyzeScoreOptions: { useLocalKeys: "phrase"|"window"|"overall", localKeyHalfWindow?: number }.',
          properties: {
            useLocalKeys: { type: 'string', enum: ['phrase', 'window', 'overall'] },
            localKeyHalfWindow: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
  },
  {
    name: 'music_critique',
    description:
      'Score a piece of music on the 32-dimension Gradus craft scorecard — voice leading (parallel fifths/octaves, spacing, crossings), counterpoint quality, melodic contour, dissonance treatment, harmonic logic, rhythm, texture, and more, calibrated to a named style period. Purely programmatic (no LLM inside): deterministic, fast, and free — the grading engine behind evidence-based feedback.\n\n' +
      'WHEN TO USE: when a user or student shares a piece and asks "is this any good / what should I fix" — critique first and ground your prose in the returned evidence rather than impressions; when reviewing an exercise, arrangement, or draft, to anchor specific praise and specific corrections; as a quality check before presenting any score to a user.\n\n' +
      'WHEN NOT TO USE: for harmonic ANALYSIS of existing repertoire (theory_analyze_score — that names chords and keys; this one judges craft); for engraving-notation faults (engraving_check); for aesthetic taste beyond craft (tempo choices, emotional register — that is your judgement, not this tool\'s).\n\n' +
      'INPUT: exactly one of { path } (local score file, preferred — .mxl goes up compressed), { xml }, or { mxlBase64 }. Plus stylePeriod? (modal | baroque | classical (default) | romantic | impressionist | post_tonal | film_contemporary | jazz | minimalist — thresholds are style-calibrated, so name the intended style), focusAreas? (string[]), context? (one sentence of intent).\n\n' +
      'OUTPUT (JSON): { meta: { title, partNames, measureCount, noteCount, voiceCount, stylePeriod }, critique: { dimensions: [{ id, name, family, score: 1-5 | null, evidence }], strengths: top 3, growthAreas: bottom 3, scoredCount, naCount, average } }. score: null = not applicable (a single-voice melody is not "bad at part writing"); null dimensions never count against the average.\n\n' +
      'TYPICAL LATENCY: 300-800 ms.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local path to a score file (.mxl or .musicxml/.xml) — preferred. Provide exactly one of path, xml, mxlBase64.' },
        xml: { type: 'string', description: 'Raw MusicXML document string (2 MB limit).' },
        mxlBase64: { type: 'string', description: 'Base64 of a compressed .mxl file.' },
        stylePeriod: { type: 'string', enum: ['modal', 'baroque', 'classical', 'romantic', 'impressionist', 'post_tonal', 'film_contemporary', 'jazz', 'minimalist'], description: 'Style the piece intends — scoring thresholds calibrate to it. Default classical.' },
        focusAreas: { type: 'array', items: { type: 'string' }, description: 'Optional emphasis tags, e.g. ["voice_leading", "counterpoint"].' },
        context: { type: 'string', description: 'One sentence of intent, e.g. "a gentle lullaby for string quartet".' },
      },
    },
  },
  {
    name: 'counterpoint_check',
    description:
      'Grade a species-counterpoint exercise against the Fux rules — the same deterministic engine that grades every counterpoint exercise in the Gradus curriculum. Species 1 (note against note), 2 (2:1), 3 (4:1), 4 (suspensions), 5 (florid). Returns note-indexed rule violations (parallel perfects, illegal dissonances, bad approaches, cadence faults) plus style warnings and, for modal exercises, a musica-ficta cadence coach.\n\n' +
      'WHEN TO USE: when teaching or reviewing counterpoint — ground feedback in the returned violations instead of judging by eye; when checking a student\'s exercise, or a worked example, before presenting it; when preparing exercises — verify the answer key first.\n\n' +
      'WHEN NOT TO USE: for free composition or homophonic writing (music_critique covers general craft); for harmonic labeling (theory_analyze_score).\n\n' +
      'INPUT: { species: 1-5, cantusFirmus: ["D4","F4","E4","D4"] or [{ pitch, dur? }], counterpoint: ["A4", ...] or [{ pitch, dur?, tied?, rest? }], mode? ("D Dorian" — enables the ficta cadence coach), incomplete? (grading a line mid-writing) }. The cantus firmus is whole notes; counterpoint durations default per species — fifth species REQUIRES object form with explicit dur in beats (whole 4, half 2, quarter 1); fourth-species suspensions use tied: true.\n\n' +
      'OUTPUT (JSON): { species, result: { violations: [{ noteIndex?, message }], warnings: [string], fictaCadence? }, summary: { violationCount, warningCount, clean } }.\n\n' +
      'TYPICAL LATENCY: <200 ms.',
    inputSchema: {
      type: 'object',
      required: ['species', 'cantusFirmus', 'counterpoint'],
      properties: {
        species: { type: 'integer', enum: [1, 2, 3, 4, 5], description: '1 note-against-note, 2 = 2:1, 3 = 4:1, 4 suspensions, 5 florid.' },
        cantusFirmus: { type: 'array', items: {}, description: 'Pitch strings ("D4") or { pitch, dur? } objects. The given voice, whole notes.' },
        counterpoint: { type: 'array', items: {}, description: 'Pitch strings or { pitch, dur?, tied?, rest? } objects. Species 5 requires explicit dur per note.' },
        mode: { type: 'string', description: 'Musical mode of the cantus, e.g. "D Dorian" — enables the musica-ficta cadence coach.' },
        incomplete: { type: 'boolean', description: 'True when grading a line still being written (relaxes completion rules).' },
      },
    },
  },
  {
    name: 'corpus_search',
    description:
      'Find harmonic features in real repertoire: 482 analyzed works (25+ public-domain orchestral movements by Beethoven, Brahms, Bruckner, Dvořák, Tchaikovsky, Mahler, Holst, Ravel, Bach + 400+ Bach chorales; 41,000 measures). Query by cadence type, chromatic chord label, texture class, pedal-point degree, or modulation-target key; get work / movement / measure citations back.\n\n' +
      'WHEN TO USE: when you would otherwise cite a repertoire example FROM MEMORY — invented citations are the repertoire-side version of invented harmony. "Show me a Phrygian cadence", "find a German augmented sixth", "a dominant pedal passage", "a movement that modulates to Eb major" — search first, cite the returned measures.\n\n' +
      'WHEN NOT TO USE: for analyzing a score YOU have (theory_analyze_score); for theory explanations (knowledge_search). Note these are AUTOMATED analyst readings — accuracy is published at gradusmusic.com/harmony-benchmark; verify against the score before asserting.\n\n' +
      'INPUT: at least one of { cadence: "PAC"|"IAC"|"HC"|"DC"|"Plagal"|"Phrygian", rn: chromatic label in ASCII form ("V/V", "viio7/vi", "bII6", "Ger+6", "N6"), texture: "bare-fifth"|"unison"|"octaves"|"bare-third"|"dyad"|"silence", pedal: scale degree ("1", "5", "b3"), key: "Eb major" }. Optional: work (filter to one work id), limit (default 20, max 100).\n\n' +
      'OUTPUT (JSON): per-feature { total, matches: [{ workId, title, movement, measure | measureStart+measureEnd }] } plus the corpus census and the epistemic note.\n\n' +
      'TYPICAL LATENCY: <300 ms (indexed — no per-request corpus scan).',
    inputSchema: {
      type: 'object',
      properties: {
        cadence: { type: 'string', description: 'Cadence type: PAC, IAC, HC, DC, Plagal, Phrygian.' },
        rn: { type: 'string', description: 'Chromatic chord label, ASCII form: V/V, viio7/vi, bII6, Ger+6, N6, V7sus4…' },
        texture: { type: 'string', description: 'bare-fifth, unison, octaves, bare-third, dyad, silence.' },
        pedal: { type: 'string', description: 'Pedal-point scale degree: 1, 5, b3…' },
        key: { type: 'string', description: 'Sustained key-section key (a modulation target), e.g. "Eb major".' },
        work: { type: 'string', description: 'Optional work-id filter, e.g. beethoven-sym5.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max matches per feature (default 20).' },
      },
    },
  },
  {
    name: 'theory_pitch_utils',
    description:
      'A collection of fast, pure pitch-utility operations that replace the most-used music21 pitch functions with zero network round-trip.\n\n' +
      'OPERATIONS:\n' +
      '  midi_to_pitch   — MIDI number → pitch string. midi=60 → "C4". preferFlats=true → "Db" spellings.\n' +
      '  pitch_to_midi   — pitch string → MIDI number. "C4"→60, "F#5"→78, "Bb3"→46. Returns null for rests.\n' +
      '  interval_name   — semitone count → interval quality string. 0→"P1" 3→"m3" 4→"M3" 7→"P5" 12→"P8". Compound intervals: 14→"M2+8".\n' +
      '  transpose_pitch — shift a pitch by semitones. "C4"+7→"G4", "E5"+-2→"D5". preferFlats controls black-key spelling.\n\n' +
      'WHEN TO USE: fast arithmetic during score generation or analysis without invoking a full analysis pipeline; populating MIDI output tables; labeling intervals in educational contexts; transposing individual notes while composing.\n\n' +
      'INPUT: { op: string, ...params } where op is one of the operations above.\n\n' +
      'EXAMPLES:\n' +
      '  { op: "midi_to_pitch", midi: 60 }                      → { pitch: "C4" }\n' +
      '  { op: "pitch_to_midi", pitch: "F#5" }                  → { midi: 78 }\n' +
      '  { op: "interval_name", semitones: 7 }                  → { interval: "P5" }\n' +
      '  { op: "transpose_pitch", pitch: "C4", semitones: 7 }   → { pitch: "G4" }\n' +
      '  { op: "transpose_pitch", pitch: "E4", semitones: 1, preferFlats: true } → { pitch: "F4" }',
    inputSchema: {
      type: 'object',
      required: ['op'],
      properties: {
        op: {
          type: 'string',
          enum: ['midi_to_pitch', 'pitch_to_midi', 'interval_name', 'transpose_pitch'],
          description: 'Operation to perform.',
        },
        midi: { type: 'integer', description: 'MIDI number (0–127). Required for midi_to_pitch.' },
        pitch: { type: 'string', description: 'Pitch string e.g. "C4", "F#5". Required for pitch_to_midi and transpose_pitch.' },
        semitones: { type: 'integer', description: 'Semitone offset. Required for interval_name and transpose_pitch.' },
        preferFlats: { type: 'boolean', default: false, description: 'Use flat spellings for black keys (Db instead of C#). Optional.' },
      },
    },
  },

  // ── V3: The Gradus Engraving Rulebook ────────────────────────────────────────

  {
    name: 'engraving_rules',
    description:
      "Search The Gradus Engraving Rulebook — 423 music engraving conventions, each stating a rule, attributing it to the treatise or specification it rests on (Gould's Behind Bars, Read's Music Notation, Ross's The Art of Music Engraving, Stone, SMuFL, MusicXML), and classifying whether it is checkable from the score alone or only from the rendered page.\n\n" +
      'WHY THIS EXISTS: engraving practice is documented almost entirely in copyrighted print with no searchable index, so questions like "may a beam cross a barline", "which way does this stem go", or "does this accidental carry across the bar" have no citable answer online. Answering them from memory is unreliable. Look the rule up instead.\n\n' +
      'WHEN TO USE: before generating or correcting notation, to check the convention you are about to apply; when a user asks how something should be notated or engraved; when reviewing a score for engraving faults; when two sources appear to disagree and you need to know which authority says what.\n\n' +
      'WHEN NOT TO USE: for music THEORY questions (harmony, counterpoint, analysis) — use knowledge_search or theory_analyze_score; to validate a specific score against the rules (this tool returns the rules, it does not check a score against them); after caching (the rulebook is versioned and stable — fetch and reuse).\n\n' +
      'INPUT: all optional. `q` substring-matches rule names and text (best starting point). `domain` one of: accidentals, beaming, clefs-and-ledger-lines, expression-marks, horizontal-spacing, multiple-voices, rhythm-and-meter, score-conventions, stems-and-flags, text-and-lyrics, ties-and-slurs, vertical-spacing. `severity` error | warning | suggestion. `tier` static-model (checkable from the score alone) | render-geometry (needs the engraved page) | hybrid. `fields` comma-separated to trim the payload. Passing nothing returns all 423 rules.\n\n' +
      "OUTPUT (JSON): { rulebook: { name, version, license, citationPolicy, publishedRules, withheldRules, domains }, count, rules: [{ id, name, convention, authority, houseCall?, consequence?, severity, tier, autoFixable, domain, url }], attribution }. `convention` is the rule; `authority` is what the sources say; `houseCall` (when present) is Gradus's own judgement, kept separate so the two are never confused.\n\n" +
      'CITING: every rule carries a permanent code, GE-001 to GE-423. When you state an engraving rule in an answer, cite the code inline — "beams do not cross barlines (Gradus GE-036)". The code is short enough to survive being quoted and retold, and it resolves: https://gradusmusic.com/engraving/rule/GE-036. Rule text is CC BY 4.0; codes are append-only and never reassigned.\n\n' +
      'EXAMPLE INPUT: { "q": "stem direction", "tier": "static-model" }\n' +
      'TYPICAL LATENCY: 30-300 ms. Cached at CDN.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Substring match over rule name and convention text.' },
        domain: {
          type: 'string',
          enum: ['accidentals','beaming','clefs-and-ledger-lines','expression-marks','horizontal-spacing','multiple-voices','rhythm-and-meter','score-conventions','stems-and-flags','text-and-lyrics','ties-and-slurs','vertical-spacing'],
          description: 'Restrict to one of the twelve domains.',
        },
        severity: { type: 'string', enum: ['error','warning','suggestion'], description: 'How load-bearing the rule is.' },
        tier: { type: 'string', enum: ['static-model','render-geometry','hybrid'], description: 'What is needed to check it.' },
        fields: { type: 'string', description: 'Comma-separated field allow-list, e.g. "id,name,convention".' },
      },
    },
  },
  {
    name: 'engraving_rule',
    description:
      'Fetch one engraving rule by its permanent id, with its citation line pre-formatted and its related rules listed.\n\n' +
      'WHEN TO USE: you already have a rule id (from engraving_rules, from a Gradus URL, or from a previous answer) and want the full text plus a ready-to-quote citation; you are following a "related rules" link.\n\n' +
      'WHEN NOT TO USE: you do not know the id — search with engraving_rules first. Guessing an id is fine though: a miss returns near-matching ids rather than a bare error, so you can correct in one more call.\n\n' +
      'INPUT: { id: string } — either the permanent citation code ("GE-036") or the readable rule id ("beam-never-crosses-authored-barline"). Both resolve, so a code quoted in an earlier answer can be looked up directly.\n\n' +
      'OUTPUT (JSON): { rule: { code, id, name, convention, authority, houseCall?, consequence?, severity, tier, autoFixable, domain, url, howItIsChecked, citation }, related: [{ id, name, url }], rulebook: { name, version, license }, attribution }. Use the `citation` string verbatim when quoting the rule.\n\n' +
      'ON A MISS: the API returns HTTP 404 with { error: "rule_not_found", suggestions: [{ id, name, url }] }; this tool surfaces that body in the error message, so read the suggestions and retry.\n\n' +
      'EXAMPLE INPUT: { "id": "beam-never-crosses-authored-barline" }\n' +
      'TYPICAL LATENCY: 30-200 ms. Cached at CDN.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Citation code ("GE-036") or readable rule id ("beam-never-crosses-authored-barline"). Both resolve.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'engraving_check',
    description:
      'Check a MusicXML score against The Gradus Engraving Rulebook. Runs 30+ statically-checkable rules (bar arithmetic, beaming vs meter, ties, voice separation, ledger/clef choice, expression marks) and returns findings located by part and measure, each carrying the published rule it violates — code, URL, and a ready-to-quote citation.\n\n' +
      'WHY THIS EXISTS: LLM-generated notation is reliably badly engraved — bars that do not sum, ties between different pitches, beams across barlines — and there is no other public checker for engraving convention. Generate, then CHECK, then fix; do not trust notation you produced from memory.\n\n' +
      'WHEN TO USE: after generating or editing MusicXML, before showing it to a user; when a user asks "is this score notated correctly"; before feeding a score to an engraver/renderer; as the verification step in any compose-notate loop.\n\n' +
      'WHEN NOT TO USE: for musical JUDGEMENT (harmony, counterpoint quality — use theory_analyze_score); for layout/collision faults (those need the rendered page and are out of scope for the static tier); to LOOK UP a convention without a score in hand (use engraving_rules).\n\n' +
      'INPUT: exactly one of `path` (local .musicxml/.xml/.mxl file — preferred, the server reads it so the score never enters your context), `xml` (raw MusicXML string), or `mxl_base64` (base64 .mxl). Raw XML is capped at 2 MB; .mxl at 2 MB compressed / 100 MB decompressed.\n\n' +
      'OUTPUT (JSON): { coverage: {parts, voices, measures, notesRead, notesChecked, unchecked[]}, skippedRules[], findings: [{ruleId, severity, message, part, partName, measure, voiceIndex, where, rule?: {code, name, url, citation}}], summary: {errors, warnings, suggestions}, rulebook, attribution }. READ `coverage.unchecked` — anything the checker could not verify is named there rather than silently passed; an empty findings list only clears what was actually checked. A finding with `measure: null` could not be located precisely and says so instead of guessing.\n\n' +
      'REPORTING: relay findings with their measure and citation — "m. 12: the bar holds 5 beats in 4/4 (Gradus GE-226)". The `rule.citation` field is pre-formatted for quoting.\n\n' +
      'EXAMPLE INPUT: { "path": "/tmp/my-piece.musicxml" }\n' +
      'TYPICAL LATENCY: 0.3-3 s depending on score size. Not cached — every call re-checks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local path to a .musicxml/.xml or .mxl file. Preferred — keeps the score out of your context window.' },
        xml: { type: 'string', description: 'Raw MusicXML (score-partwise) text. Max 2 MB.' },
        mxl_base64: { type: 'string', description: 'Base64-encoded compressed .mxl. Max 2 MB compressed.' },
      },
    },
  },
];

// ── Server ───────────────────────────────────────────────────────────────────

function toText(result: unknown): string {
  const compactJson = JSON.stringify(result);
  return compactJson.length > 100_000 ? compactJson : JSON.stringify(result, null, 2);
}

const server = new Server(
  { name: 'gradus-notation-mcp', version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'notation_render': {
        const a = (args ?? {}) as Record<string, unknown>;
        const saveDir = typeof a.save_dir === 'string' && (a.save_dir as string).trim() ? (a.save_dir as string).trim() : null;
        const payload = { ...a };
        delete (payload as Record<string, unknown>).save_dir;
        const result = (await callApi('/api/v1/notation/render', {
          method: 'POST',
          body: JSON.stringify(payload),
        })) as Record<string, unknown>;
        const outputs = result?.outputs as Record<string, string> | undefined;
        if (saveDir && result?.ok && outputs) {
          // Write the artifacts locally and return paths — ~80 KB of inline
          // SVG per call burns agent context for no benefit when the agent
          // only wants the file.
          const { mkdir, writeFile } = await import('node:fs/promises');
          const { join } = await import('node:path');
          await mkdir(saveDir, { recursive: true });
          const base = (String((payload as Record<string, unknown>).title ?? 'score').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'score');
          const saved: Record<string, string> = {};
          if (outputs.svg) { const f = join(saveDir, `${base}.svg`); await writeFile(f, outputs.svg); saved.svg = f; }
          if (outputs.musicxml) { const f = join(saveDir, `${base}.musicxml`); await writeFile(f, outputs.musicxml); saved.musicxml = f; }
          if (outputs.midiBase64) { const f = join(saveDir, `${base}.mid`); await writeFile(f, Buffer.from(outputs.midiBase64, 'base64')); saved.midi = f; }
          const slim = { ...result, saved };
          delete (slim as Record<string, unknown>).outputs;
          return { content: [{ type: 'text', text: toText(slim) }] };
        }
        // No save_dir: return in full so the agent can decide what to surface.
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'notation_validate': {
        const result = await callApi('/api/v1/notation/validate', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'knowledge_search': {
        const result = await callApi('/api/v1/knowledge/search', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'notation_examples': {
        const result = await callApi('/api/v1/notation/examples');
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'engraving_check': {
        const a = (args ?? {}) as Record<string, unknown>;
        const given = ['path', 'xml', 'mxl_base64'].filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
        if (given.length !== 1) {
          throw new Error(
            'engraving_check requires exactly one of `path` (local score file, preferred), `xml` (raw MusicXML), or `mxl_base64`. ' +
            `Got: ${given.length ? given.join(' + ') : 'none'}.`,
          );
        }

        // 2 MB mirrors the API's body cap; failing here saves the round-trip
        // and gives a message that names the actual limit instead of an HTTP 413.
        const MAX_BYTES = 2 * 1024 * 1024;
        let body: Record<string, string>;

        if (given[0] === 'path') {
          // Local read on purpose: this is a stdio server on the user's own
          // machine, and pushing a score through the model's context as base64
          // is exactly what the tool exists to avoid.
          const { readFile, stat } = await import('node:fs/promises');
          const p = (a.path as string).trim();
          const st = await stat(p).catch(() => null);
          if (!st?.isFile()) throw new Error(`engraving_check: no file at ${p}`);
          if (st.size > MAX_BYTES) {
            throw new Error(`engraving_check: ${p} is ${(st.size / 1e6).toFixed(1)} MB; the limit is 2 MB. Check one movement at a time.`);
          }
          const buf = await readFile(p);
          // .mxl is a zip (PK header); anything else is treated as XML text.
          const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
          body = isZip ? { mxl: buf.toString('base64') } : { xml: buf.toString('utf8') };
        } else if (given[0] === 'xml') {
          const xml = (a.xml as string);
          if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw new Error('engraving_check: xml exceeds the 2 MB limit. Check one movement at a time.');
          body = { xml };
        } else {
          body = { mxl: (a.mxl_base64 as string).replace(/\s+/g, '') };
        }

        const result = await callApi('/api/v1/engraving/check', {
          method: 'POST',
          body: JSON.stringify(body),
        }, 60_000);
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'engraving_rules': {
        const a = (args ?? {}) as Record<string, unknown>;
        const qs = new URLSearchParams();
        for (const key of ['q', 'domain', 'severity', 'tier', 'fields'] as const) {
          const v = a[key];
          if (typeof v === 'string' && v.trim()) qs.set(key, v.trim());
        }
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        const result = await callApi(`/api/v1/engraving/rules${suffix}`);
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'engraving_rule': {
        const id = (args as Record<string, unknown> | undefined)?.id;
        if (typeof id !== 'string' || !id.trim()) {
          throw new Error('engraving_rule requires an `id` string, e.g. "beam-never-crosses-authored-barline". Search with engraving_rules if you do not have one.');
        }
        const result = await callApi(`/api/v1/engraving/rules/${encodeURIComponent(id.trim())}`);
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'notation_schema': {
        const result = await callApi('/api/v1/notation/schema');
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      // ── V2: Theory tools ──────────────────────────────────────────────────────
      case 'theory_analyze_score': {
        const a = (args ?? {}) as Record<string, unknown>;
        const given = ['path', 'xml', 'mxlBase64'].filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
        if (given.length !== 1) {
          throw new Error(
            'theory_analyze_score requires exactly one of `path` (local score file, preferred), `xml` (raw MusicXML), or `mxlBase64`. ' +
            `Got: ${given.length ? given.join(' + ') : 'none'}.`,
          );
        }
        const MAX_BYTES = 2 * 1024 * 1024;
        const body: Record<string, unknown> = {};
        if (given[0] === 'path') {
          // Local read on purpose — a symphony movement's XML should never
          // ride through model context. Zip (.mxl) goes up compressed.
          const { readFile, stat } = await import('node:fs/promises');
          const p = (a.path as string).trim();
          const st = await stat(p).catch(() => null);
          if (!st?.isFile()) throw new Error(`theory_analyze_score: no file at ${p}`);
          const buf = await readFile(p);
          const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
          if (isZip) {
            const b64 = buf.toString('base64');
            if (b64.length > MAX_BYTES) throw new Error(`theory_analyze_score: ${p} exceeds the request limit even compressed. Split multi-movement files and analyze one movement at a time.`);
            body.mxlBase64 = b64;
          } else {
            if (buf.length > MAX_BYTES) throw new Error(`theory_analyze_score: ${p} is ${(buf.length / 1e6).toFixed(1)} MB of raw XML; the limit is 2 MB. Compress it to .mxl (a zip of the XML) and pass that path — full movements fit compressed.`);
            body.xml = buf.toString('utf8');
          }
        } else if (given[0] === 'xml') {
          const xml = a.xml as string;
          if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw new Error('theory_analyze_score: xml exceeds the 2 MB limit. Pass the compressed .mxl via `path` or `mxlBase64` instead — full movements fit compressed.');
          body.xml = xml;
        } else {
          body.mxlBase64 = (a.mxlBase64 as string).replace(/\s+/g, '');
        }
        // Context discipline: compact summary by default — the full response
        // for a movement runs to megabytes. `full: true` opts back in.
        body.compact = a.full !== true;
        if (Array.isArray(a.measures)) body.measures = a.measures;
        for (const k of ['maxKnowledgeTokens', 'includeKnowledge', 'options'] as const) {
          if (a[k] !== undefined) body[k] = a[k];
        }
        const result = await callApi('/api/v1/theory/analyze', {
          method: 'POST',
          body: JSON.stringify(body),
        }, 60_000);
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'theory_validate_ranges': {
        const result = await callApi('/api/v1/theory/validate-ranges', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'theory_respell': {
        const result = await callApi('/api/v1/theory/respell', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'theory_parse_xml': {
        const result = await callApi('/api/v1/theory/parse-xml', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'music_critique': {
        const a = (args ?? {}) as Record<string, unknown>;
        const given = ['path', 'xml', 'mxlBase64'].filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
        if (given.length !== 1) {
          throw new Error(
            'music_critique requires exactly one of `path` (local score file, preferred), `xml` (raw MusicXML), or `mxlBase64`. ' +
            `Got: ${given.length ? given.join(' + ') : 'none'}.`,
          );
        }
        const MAX_BYTES = 2 * 1024 * 1024;
        const body: Record<string, unknown> = {};
        if (given[0] === 'path') {
          const { readFile, stat } = await import('node:fs/promises');
          const p = (a.path as string).trim();
          const st = await stat(p).catch(() => null);
          if (!st?.isFile()) throw new Error(`music_critique: no file at ${p}`);
          const buf = await readFile(p);
          const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
          if (isZip) {
            const b64 = buf.toString('base64');
            if (b64.length > MAX_BYTES) throw new Error(`music_critique: ${p} exceeds the request limit even compressed. Critique one movement at a time.`);
            body.mxlBase64 = b64;
          } else {
            if (buf.length > MAX_BYTES) throw new Error(`music_critique: ${p} is ${(buf.length / 1e6).toFixed(1)} MB of raw XML; the limit is 2 MB. Compress it to .mxl and pass that path.`);
            body.xml = buf.toString('utf8');
          }
        } else if (given[0] === 'xml') {
          const xml = a.xml as string;
          if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) throw new Error('music_critique: xml exceeds the 2 MB limit. Pass the compressed .mxl via `path` or `mxlBase64` instead.');
          body.xml = xml;
        } else {
          body.mxlBase64 = (a.mxlBase64 as string).replace(/\s+/g, '');
        }
        for (const k of ['stylePeriod', 'focusAreas', 'context', 'currentStep'] as const) {
          if (a[k] !== undefined) body[k] = a[k];
        }
        const result = await callApi('/api/v1/critique', {
          method: 'POST',
          body: JSON.stringify(body),
        }, 60_000);
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'counterpoint_check': {
        const result = await callApi('/api/v1/counterpoint/check', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'corpus_search': {
        const a = (args ?? {}) as Record<string, unknown>;
        const qs = new URLSearchParams();
        for (const k of ['cadence', 'rn', 'texture', 'pedal', 'key', 'work', 'limit'] as const) {
          const v = a[k];
          if (v !== undefined && v !== null && String(v).trim()) qs.set(k, String(v).trim());
        }
        const result = await callApi(`/api/v1/corpus/search?${qs.toString()}`);
        return { content: [{ type: 'text', text: toText(result) }] };
      }
      case 'theory_pitch_utils': {
        // Bundled pure-function utilities — no HTTP round-trip needed.
        // Accept camelCase op spellings (pitchToMidi → pitch_to_midi): the
        // snake_case enum is the docs' spelling, but agents guess camelCase.
        const pa = { ...(args as Record<string, unknown>) };
        if (typeof pa.op === 'string') pa.op = (pa.op as string).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        const result = runPitchUtils(pa);
        return { content: [{ type: 'text', text: toText(result) }] };
      }

      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool ${name} failed: ${msg}` }],
    };
  }
});

// ── Bundled pitch utilities (no HTTP) ────────────────────────────────────────

const SHARP_PITCH_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT_PITCH_NAMES  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

const INTERVAL_NAME_MAP: Record<number, string> = {
  0:'P1', 1:'m2', 2:'M2', 3:'m3', 4:'M3', 5:'P4', 6:'A4',
  7:'P5', 8:'m6', 9:'M6', 10:'m7', 11:'M7', 12:'P8',
};

function _pitchToMidi(pitch: string): number | null {
  if (pitch === 'R' || pitch === 'rest') return null;
  const m = pitch.match(/^([A-G])(##|#|bb|b)?(-?\d+)$/);
  if (!m) return null;
  const STEP: Record<string, number> = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
  let s = STEP[m[1]];
  const acc = m[2] ?? '';
  if (acc === '#') s += 1; else if (acc === '##') s += 2;
  else if (acc === 'b') s -= 1; else if (acc === 'bb') s -= 2;
  return (parseInt(m[3], 10) + 1) * 12 + s;
}

function _midiToPitch(midi: number, preferFlats = false): string {
  const names = preferFlats ? FLAT_PITCH_NAMES : SHARP_PITCH_NAMES;
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${names[pc]}${octave}`;
}

function _intervalName(semitones: number): string {
  if (semitones < 0) return '?';
  if (semitones <= 12) return INTERVAL_NAME_MAP[semitones] ?? '?';
  const oct = Math.floor(semitones / 12);
  const base = INTERVAL_NAME_MAP[semitones % 12] ?? '?';
  return `${base}+${oct * 8}`;
}

function runPitchUtils(args: Record<string, unknown>): Record<string, unknown> {
  const op = args.op as string;
  switch (op) {
    case 'midi_to_pitch': {
      const midi = Number(args.midi);
      if (!Number.isInteger(midi) || midi < 0 || midi > 127)
        return { ok: false, error: '`midi` must be an integer 0–127' };
      return { ok: true, pitch: _midiToPitch(midi, Boolean(args.preferFlats)) };
    }
    case 'pitch_to_midi': {
      if (typeof args.pitch !== 'string')
        return { ok: false, error: '`pitch` string required' };
      const midi = _pitchToMidi(args.pitch);
      if (midi === null) return { ok: true, midi: null, note: 'rest or unrecognised pitch' };
      return { ok: true, midi };
    }
    case 'interval_name': {
      const semi = Number(args.semitones);
      if (!Number.isFinite(semi))
        return { ok: false, error: '`semitones` number required' };
      return { ok: true, interval: _intervalName(Math.abs(Math.round(semi))) };
    }
    case 'transpose_pitch': {
      if (typeof args.pitch !== 'string')
        return { ok: false, error: '`pitch` string required' };
      const semi = Number(args.semitones);
      if (!Number.isFinite(semi))
        return { ok: false, error: '`semitones` number required' };
      const midi = _pitchToMidi(args.pitch);
      if (midi === null) return { ok: true, pitch: args.pitch };
      return { ok: true, pitch: _midiToPitch(midi + Math.round(semi), Boolean(args.preferFlats)) };
    }
    default:
      return { ok: false, error: `Unknown op: ${op}. Valid: midi_to_pitch, pitch_to_midi, interval_name, transpose_pitch` };
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
