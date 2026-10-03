import { EDGE_TYPES, LESSON_KINDS, type EdgeType, type EvidenceRef, type Lesson } from './types.ts';

/**
 * JSON-LD interchange for the lesson graph, using schema.org for the
 * creative-work vocabulary and W3C PROV-O for provenance. Orbit-specific
 * terms live under a URN namespace so the export names no host.
 *
 * The importer reads the compact form this module writes (same context, same
 * term names). It is not a general JSON-LD processor: documents from other
 * tools should be converted to this shape first.
 */
export const ORBIT_JSONLD_CONTEXT = {
  schema: 'https://schema.org/',
  prov: 'http://www.w3.org/ns/prov#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  orbit: 'urn:orbit:vocab#',
  Dataset: 'schema:Dataset',
  CreativeWork: 'schema:CreativeWork',
  Entity: 'prov:Entity',
  Activity: 'prov:Activity',
  SoftwareAgent: 'prov:SoftwareAgent',
  Lesson: 'orbit:Lesson',
  Edge: 'orbit:Edge',
  dateCreated: { '@id': 'schema:dateCreated', '@type': 'xsd:dateTime' },
  identifier: 'schema:identifier',
  schemaVersion: 'schema:schemaVersion',
  lessonKind: 'orbit:kind',
  statement: 'schema:text',
  rationale: 'schema:description',
  verification: 'orbit:verification',
  status: 'schema:creativeWorkStatus',
  scope: 'orbit:scope',
  confidence: 'orbit:confidence',
  codeFree: { '@id': 'orbit:codeFree', '@type': 'xsd:boolean' },
  applicability: 'orbit:applicability',
  programmingLanguage: { '@id': 'schema:programmingLanguage', '@container': '@set' },
  frameworks: { '@id': 'orbit:framework', '@container': '@set' },
  pathGlobs: { '@id': 'orbit:pathGlob', '@container': '@set' },
  checkIds: { '@id': 'orbit:checkId', '@container': '@set' },
  fingerprints: { '@id': 'orbit:failureFingerprint', '@container': '@set' },
  roles: { '@id': 'orbit:role', '@container': '@set' },
  keywords: { '@id': 'schema:keywords', '@container': '@set' },
  evidence: { '@id': 'orbit:evidence', '@container': '@list' },
  run: 'orbit:run',
  atLocation: 'prov:atLocation',
  sha256: 'orbit:sha256',
  relation: 'orbit:relation',
  wasGeneratedBy: 'prov:wasGeneratedBy',
  wasAssociatedWith: 'prov:wasAssociatedWith',
  provenanceSource: 'orbit:provenanceSource',
  name: 'schema:name',
  endedAtTime: { '@id': 'prov:endedAtTime', '@type': 'xsd:dateTime' },
  generatedAtTime: { '@id': 'prov:generatedAtTime', '@type': 'xsd:dateTime' },
  hadPrimarySource: 'prov:hadPrimarySource',
  wasDerivedFrom: { '@id': 'prov:wasDerivedFrom', '@container': '@list' },
  wasRevisionOf: { '@id': 'prov:wasRevisionOf', '@type': '@id' },
  edgeType: 'orbit:edgeType',
  edgeFrom: 'orbit:edgeFrom',
  edgeTo: 'orbit:edgeTo',
  edgeData: { '@id': 'orbit:edgeData', '@type': '@json' },
} as const;

export const LESSON_IRI_PREFIX = 'urn:orbit:lesson:';

export interface JsonLdDocument {
  '@context': typeof ORBIT_JSONLD_CONTEXT;
  '@type': 'Dataset';
  dateCreated: string;
  '@graph': Record<string, unknown>[];
}

export interface JsonLdEdge {
  src: string;
  dst: string;
  type: EdgeType;
  run_id: string | null;
  data: Record<string, unknown> | null;
}

function lessonNode(l: Lesson): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@id': `${LESSON_IRI_PREFIX}${l.id}`,
    '@type': ['Lesson', 'CreativeWork', 'Entity'],
    identifier: l.id,
    schemaVersion: l.schema,
    lessonKind: l.kind,
    statement: l.statement,
    rationale: l.rationale,
    verification: l.verification,
    applicability: {
      programmingLanguage: l.applicability.languages,
      frameworks: l.applicability.frameworks,
      pathGlobs: l.applicability.paths,
      checkIds: l.applicability.check_ids,
      fingerprints: l.applicability.fingerprints,
      roles: l.applicability.roles,
      keywords: l.applicability.keywords,
    },
    evidence: l.evidence.map((e) => ({
      '@type': 'Entity',
      run: e.run_id,
      atLocation: e.artifact,
      ...(e.sha256 ? { sha256: e.sha256 } : {}),
      relation: e.relation,
    })),
    wasGeneratedBy: {
      '@type': 'Activity',
      provenanceSource: l.provenance.source,
      wasAssociatedWith: { '@type': 'SoftwareAgent', name: l.provenance.generated_by },
      endedAtTime: l.provenance.generated_at,
    },
    generatedAtTime: l.provenance.generated_at,
    wasDerivedFrom: l.provenance.derived_from,
    confidence: l.confidence,
    status: l.status,
    scope: l.scope,
    codeFree: l.code_free,
  };
  if (l.provenance.uri !== null) node.hadPrimarySource = l.provenance.uri;
  if (l.supersedes !== null) node.wasRevisionOf = `${LESSON_IRI_PREFIX}${l.supersedes}`;
  return node;
}

function edgeNode(e: JsonLdEdge): Record<string, unknown> {
  return {
    '@type': 'Edge',
    edgeType: e.type,
    edgeFrom: e.src,
    edgeTo: e.dst,
    ...(e.run_id ? { run: e.run_id } : {}),
    ...(e.data ? { edgeData: e.data } : {}),
  };
}

export function toJsonLd(lessons: readonly Lesson[], edges: readonly JsonLdEdge[], dateCreated: string): JsonLdDocument {
  return {
    '@context': ORBIT_JSONLD_CONTEXT,
    '@type': 'Dataset',
    dateCreated,
    '@graph': [...[...lessons].sort((a, b) => a.id.localeCompare(b.id)).map(lessonNode), ...edges.map(edgeNode)],
  };
}

function types(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : typeof t === 'string' ? [t] : [];
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('expected a string');
  return v;
}

function strList(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error('expected a list of strings');
  return v as string[];
}

function obj(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
  return v as Record<string, unknown>;
}

/** An unknown relation is an error, never a default: reading it as support would invent evidence. */
function relationOf(v: unknown): EvidenceRef['relation'] {
  if (v === 'supports' || v === 'contradicts') return v;
  throw new Error(`unknown evidence relation ${JSON.stringify(v)}`);
}

function lessonFromNode(node: Record<string, unknown>): Lesson {
  const app = obj(node.applicability ?? {});
  const gen = obj(node.wasGeneratedBy ?? {});
  const agent = obj(gen.wasAssociatedWith ?? {});
  const evidence: EvidenceRef[] = (Array.isArray(node.evidence) ? node.evidence : []).map((raw) => {
    const e = obj(raw);
    return {
      run_id: str(e.run),
      artifact: str(e.atLocation),
      sha256: typeof e.sha256 === 'string' ? e.sha256 : null,
      relation: relationOf(e.relation),
    };
  });
  const supersedes = typeof node.wasRevisionOf === 'string' ? node.wasRevisionOf.replace(LESSON_IRI_PREFIX, '') : null;
  const kind = str(node.lessonKind);
  if (!(LESSON_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown lesson kind ${kind}`);
  // The schema validator downstream checks every enumerated field; the casts
  // here only shape the object for it.
  return {
    schema: str(node.schemaVersion) as Lesson['schema'],
    id: str(node.identifier),
    kind: kind as Lesson['kind'],
    statement: str(node.statement),
    rationale: str(node.rationale ?? ''),
    applicability: {
      languages: strList(app.programmingLanguage),
      frameworks: strList(app.frameworks),
      paths: strList(app.pathGlobs),
      check_ids: strList(app.checkIds),
      fingerprints: strList(app.fingerprints),
      roles: strList(app.roles),
      keywords: strList(app.keywords),
    },
    verification: str(node.verification ?? ''),
    evidence,
    provenance: {
      source: str(gen.provenanceSource) as Lesson['provenance']['source'],
      uri: typeof node.hadPrimarySource === 'string' ? node.hadPrimarySource : null,
      derived_from: strList(node.wasDerivedFrom),
      generated_by: str(agent.name),
      generated_at: str(node.generatedAtTime ?? gen.endedAtTime),
    },
    confidence: str(node.confidence) as Lesson['confidence'],
    status: str(node.status) as Lesson['status'],
    scope: str(node.scope) as Lesson['scope'],
    code_free: node.codeFree === true,
    supersedes,
  };
}

/** Parse lessons and edges out of an exported document; malformed nodes are reported, not thrown. */
export function fromJsonLd(doc: unknown): { lessons: Lesson[]; edges: JsonLdEdge[]; rejected: { ref: string; reason: string }[] } {
  const root = obj(doc);
  const graph = root['@graph'];
  if (!Array.isArray(graph)) throw new Error('JSON-LD document has no @graph array');
  const lessons: Lesson[] = [];
  const edges: JsonLdEdge[] = [];
  const rejected: { ref: string; reason: string }[] = [];
  graph.forEach((raw, index) => {
    const ref = `@graph[${index}]`;
    try {
      const node = obj(raw);
      const t = types(node);
      if (t.includes('Lesson')) {
        lessons.push(lessonFromNode(node));
      } else if (t.includes('Edge')) {
        const type = str(node.edgeType);
        if (!(EDGE_TYPES as readonly string[]).includes(type)) throw new Error(`unknown edge type ${type}`);
        edges.push({
          src: str(node.edgeFrom),
          dst: str(node.edgeTo),
          type: type as EdgeType,
          run_id: typeof node.run === 'string' ? node.run : null,
          data: node.edgeData === undefined ? null : obj(node.edgeData),
        });
      }
    } catch (err) {
      rejected.push({ ref, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  return { lessons, edges, rejected };
}
