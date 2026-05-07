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
      'Render music notation from a JSON score. Returns inline SVG, MusicXML, and MIDI in one call. ' +
      'Use scientific pitches ("C4", "F#5", "Bb3") and duration codes (w h q 8 16 32 64 with optional dots). ' +
      'Bar lines are inferred from the time signature; notes that cross bar lines are split and tied automatically. ' +
      'Call notation_validate first if you are unsure your input is well-formed — validate is cheaper than render.',
    inputSchema: {
      type: 'object',
      required: ['instruments'],
      properties: {
        title: { type: 'string', description: 'Optional title rendered above the score.' },
        composer: { type: 'string' },
        tempo: { type: 'number', default: 100 },
        timeSignature: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, default: [4, 4] },
        keySignature: { type: 'string', default: 'C major', description: 'e.g. "C major", "G minor", "F# major".' },
        instruments: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['name'],
            properties: {
              name: { type: 'string', description: 'Display name. Clef inferred if omitted.' },
              clef: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor', 'percussion'] },
              notes: { type: 'array', items: { type: ['string', 'object'] }, description: 'Shortcut for single-voice. Examples: "C5/q", "[C4,E4,G4]/q", "rest/q", { pitch: "C5", duration: "q", dynamic: "f" }.' },
              voices: { type: 'array', description: 'Multi-voice form: [{ voice: 1, notes: [...] }, { voice: 2, notes: [...] }].' },
            },
          },
        },
      },
    },
  },
  {
    name: 'notation_validate',
    description:
      'Pre-flight validate an input shape without rendering. Returns errors with concrete `fix` suggestions when input is malformed. Cheaper than notation_render — use this when iterating on input shape.',
    inputSchema: {
      type: 'object', required: ['instruments'],
      properties: {
        title: { type: 'string' }, composer: { type: 'string' },
        tempo: { type: 'number' }, timeSignature: { type: 'array', items: { type: 'integer' } },
        keySignature: { type: 'string' },
        instruments: { type: 'array', items: { type: 'object' } },
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
      'Fetch canonical example inputs (single melody, two-voice counterpoint, chord progression, mixed rhythms with dynamics, string quartet snippet, tied notes across bar lines). Cache the result client-side; the response shape is stable.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'notation_schema',
    description:
      'Fetch the JSON Schema for the notation_render input shape. Cache the result client-side; this is stable across the v1 API.',
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
