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
const PKG_VERSION = '0.1.0';

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function callApi(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Name': AGENT_NAME,
      'User-Agent': `gradus-notation-mcp/${PKG_VERSION}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const errBody = json ?? text.slice(0, 500);
    throw new Error(`Gradus API ${res.status} at ${path}: ${JSON.stringify(errBody)}`);
  }
  return json;
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
];

// ── Server ───────────────────────────────────────────────────────────────────

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
        const result = await callApi('/api/v1/notation/render', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        // The render response can be ~70KB+ of SVG. We return it in full so
        // the agent can decide what to surface to the user.
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'notation_validate': {
        const result = await callApi('/api/v1/notation/validate', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'knowledge_search': {
        const result = await callApi('/api/v1/knowledge/search', {
          method: 'POST',
          body: JSON.stringify(args ?? {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'notation_examples': {
        const result = await callApi('/api/v1/notation/examples');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'notation_schema': {
        const result = await callApi('/api/v1/notation/schema');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

const transport = new StdioServerTransport();
await server.connect(transport);
