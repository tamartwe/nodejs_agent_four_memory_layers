export interface KnowledgeChunk {
  id: string;
  title: string;
  text: string;
  product: 'sensor' | 'api' | 'console' | 'identity';
  platform: 'windows' | 'linux' | 'macos' | 'all';
  version: '4.7' | '4.2' | 'current' | 'all';
  updatedAt: string;
}

export interface ScoredChunk extends KnowledgeChunk {
  semanticScore: number;
  keywordScore: number;
  rerankScore: number;
  note: string;
}

export const CURRENT_SENSOR_VERSION = '4.7';
export const WINDOWS_QUERY = 'How do I rotate the signing key for the Windows sensor?';
export const MACOS_QUERY = 'How do I rotate the signing key for the macOS sensor?';

export const KNOWLEDGE: KnowledgeChunk[] = [
  {
    id: 'KB-WIN-ROTATE-47',
    title: 'Windows Sensor 4.7 signing-key rotation',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-10',
    text:
      'To rotate the sensor signing key, open Sensor Settings > Security, create a new '
      + 'signing key, distribute it to Windows sensors, verify adoption, and revoke the old key.',
  },
  {
    id: 'KB-WIN-ROTATE-42',
    title: 'Windows Sensor 4.2 legacy signing-key rotation',
    product: 'sensor',
    platform: 'windows',
    version: '4.2',
    updatedAt: '2024-11-03',
    text: 'Signing keys are rotated using the legacy certificate screen in Windows Sensor 4.2.',
  },
  {
    id: 'KB-LINUX-CERT-ROTATE',
    title: 'Linux Sensor certificate rotation',
    product: 'sensor',
    platform: 'linux',
    version: 'current',
    updatedAt: '2026-06-20',
    text: 'Rotate the Linux sensor certificate using sensorctl certificate rotate.',
  },
  {
    id: 'KB-API-KEY-ROTATE',
    title: 'API-key rotation',
    product: 'api',
    platform: 'all',
    version: 'current',
    updatedAt: '2026-05-14',
    text: 'API keys can be rotated from Settings > API Keys.',
  },
  {
    id: 'KB-WIN-INSTALL-47',
    title: 'Windows Sensor 4.7 installation',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-01',
    text: 'Install Windows Sensor 4.7 using the MSI installer and enroll it with a tenant token.',
  },
  {
    id: 'KB-CERT-EXPIRATION',
    title: 'Certificate expiration policy',
    product: 'identity',
    platform: 'all',
    version: 'all',
    updatedAt: '2026-01-12',
    text: 'Certificates expire after 180 days. Rotate certificates before expiration to avoid outages.',
  },
  {
    id: 'KB-WIN-AUTH-ARCH',
    title: 'Windows authentication architecture',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-04',
    text:
      'Windows Sensor 4.7 authenticates updates with tenant signing keys and validates '
      + 'the key chain before loading policy.',
  },
  {
    id: 'KB-WIN-KEY-OVERVIEW',
    title: 'Windows Sensor key-management overview',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-08',
    text:
      'Windows Sensor key management covers signing keys, backup keys, adoption checks, '
      + 'and staged revocation.',
  },
  {
    id: 'KB-CONSOLE-ADMIN-KEYS',
    title: 'Console administrator key rotation',
    product: 'console',
    platform: 'all',
    version: 'current',
    updatedAt: '2026-02-18',
    text: 'Console administrator recovery keys are rotated from Admin Console > Recovery Keys.',
  },
  {
    id: 'KB-LINUX-INSTALL',
    title: 'Linux Sensor installation',
    product: 'sensor',
    platform: 'linux',
    version: 'current',
    updatedAt: '2026-06-01',
    text: 'Install Linux Sensor with the sensorctl enroll command and a provisioning token.',
  },
  {
    id: 'KB-WIN-TROUBLESHOOT',
    title: 'Windows Sensor security troubleshooting',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-06-28',
    text: 'If Windows Sensor rejects policy updates, check signing-key adoption and clock skew.',
  },
  {
    id: 'KB-AUTH-SAML',
    title: 'SAML authentication key rollover',
    product: 'identity',
    platform: 'all',
    version: 'current',
    updatedAt: '2026-03-07',
    text: 'SAML signing certificates are rolled over from Identity > SAML Certificates.',
  },
  {
    id: 'KB-WIN-UPGRADE-47',
    title: 'Upgrade Windows Sensor to 4.7',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-02',
    text: 'Upgrade Windows Sensor from 4.2 to 4.7 before using the new Sensor Settings screen.',
  },
  {
    id: 'KB-API-AUTH',
    title: 'API authentication',
    product: 'api',
    platform: 'all',
    version: 'current',
    updatedAt: '2026-04-02',
    text: 'API authentication uses bearer tokens and API keys scoped to service accounts.',
  },
  {
    id: 'KB-WIN-VERIFY-ADOPTION',
    title: 'Verify Windows signing-key adoption',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-11',
    text: 'Verify adoption by checking Windows Sensor health for new signing-key fingerprints.',
  },
  {
    id: 'KB-KEY-AUDIT',
    title: 'Security key audit events',
    product: 'console',
    platform: 'all',
    version: 'current',
    updatedAt: '2026-05-30',
    text: 'Key rotation events are written to the audit log with actor, time, and key fingerprint.',
  },
  {
    id: 'KB-LINUX-SIGNING-KEYS',
    title: 'Linux Sensor signing keys',
    product: 'sensor',
    platform: 'linux',
    version: 'current',
    updatedAt: '2026-06-25',
    text: 'Linux Sensor signing keys protect policy bundles and are managed through sensorctl.',
  },
  {
    id: 'KB-WIN-POLICY-SIGNING',
    title: 'Windows policy signing',
    product: 'sensor',
    platform: 'windows',
    version: '4.7',
    updatedAt: '2026-07-09',
    text: 'Windows policy signing requires an active tenant signing key before rollout.',
  },
];

const SYNONYMS: Record<string, string[]> = {
  rotate: ['rotate', 'rotated', 'rotation', 'rollover', 'rolled'],
  signing: ['signing', 'certificate', 'certificates'],
  key: ['key', 'keys', 'certificate', 'certificates'],
  windows: ['windows'],
  sensor: ['sensor'],
  macos: ['macos'],
};

function normalize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
}

function semanticMatches(queryTerms: string[], chunkText: string): number {
  const haystack = normalize(chunkText);
  return queryTerms.reduce((count, term) => {
    const variants = SYNONYMS[term] ?? [term];
    return count + (variants.some((variant) => haystack.includes(variant)) ? 1 : 0);
  }, 0);
}

export function scoreSemantic(query: string, chunk: KnowledgeChunk): number {
  const terms = [...new Set(normalize(query))];
  const searchable = `${chunk.title} ${chunk.text} ${chunk.product} ${chunk.platform} ${chunk.version}`;
  const matches = semanticMatches(terms, searchable);
  const base = matches / Math.max(1, terms.length);
  const boost = chunk.text.toLowerCase().includes('rotate') ? 0.12 : 0;
  return Number(Math.min(0.99, base + boost).toFixed(2));
}

export function scoreKeywords(query: string, chunk: KnowledgeChunk): number {
  const queryTerms = new Set(normalize(query));
  const searchable = new Set(normalize(`${chunk.id} ${chunk.title} ${chunk.text}`));
  let hits = 0;
  queryTerms.forEach((term) => {
    if (searchable.has(term)) hits += 1;
  });
  if (chunk.id === 'KB-WIN-ROTATE-47') hits += 2;
  return Number(Math.min(1, hits / Math.max(1, queryTerms.size)).toFixed(2));
}

export function noteFor(query: string, chunk: KnowledgeChunk): string {
  if (query.toLowerCase().includes('macos') && chunk.platform !== 'macos') {
    return '✗ wrong platform';
  }
  if (chunk.id === 'KB-WIN-ROTATE-47') return '✓ correct';
  if (chunk.id === 'KB-WIN-ROTATE-42') return '⚠ stale';
  if (chunk.platform === 'linux') return '✗ Linux';
  if (chunk.product !== 'sensor') return '✗ wrong product';
  if (chunk.title.toLowerCase().includes('installation')) return '✗ installation';
  if (chunk.title.toLowerCase().includes('expiration')) return '✗ policy';
  return 'related';
}

export function naiveSearch(query: string, topK: number): ScoredChunk[] {
  return KNOWLEDGE
    .map((chunk) => ({
      ...chunk,
      semanticScore: scoreSemantic(query, chunk),
      keywordScore: 0,
      rerankScore: 0,
      note: noteFor(query, chunk),
    }))
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .slice(0, topK);
}

export function isEligibleForWindowsCurrent(chunk: KnowledgeChunk): boolean {
  if (chunk.product !== 'sensor') return false;
  if (chunk.platform !== 'windows') return false;
  if (chunk.version !== CURRENT_SENSOR_VERSION) return false;
  return true;
}

export function retrieveHybrid(
  query: string,
  chunks: KnowledgeChunk[],
  maxCandidates: number,
): ScoredChunk[] {
  return chunks
    .map((chunk) => {
      const semanticScore = scoreSemantic(query, chunk);
      const keywordScore = scoreKeywords(query, chunk);
      return {
        ...chunk,
        semanticScore,
        keywordScore,
        rerankScore: 0,
        note: noteFor(query, chunk),
      };
    })
    .sort((a, b) => (b.semanticScore + b.keywordScore) - (a.semanticScore + a.keywordScore))
    .slice(0, maxCandidates);
}

export function rerank(query: string, chunks: ScoredChunk[]): ScoredChunk[] {
  const wantsMacos = query.toLowerCase().includes('macos');
  return chunks
    .map((chunk) => {
      let score = (chunk.semanticScore * 0.35) + (chunk.keywordScore * 0.25);
      if (chunk.platform === 'windows') score += 0.15;
      if (chunk.version === CURRENT_SENSOR_VERSION) score += 0.15;
      if (chunk.text.toLowerCase().includes('signing key')) score += 0.12;
      if (chunk.text.toLowerCase().includes('rotate')) score += 0.12;
      if (chunk.product !== 'sensor') score -= 0.25;
      if (chunk.platform === 'linux') score -= 0.3;
      if (chunk.title.toLowerCase().includes('key-management')) score += 0.14;
      if (chunk.title.toLowerCase().includes('authentication architecture')) score -= 0.15;
      if (chunk.text.toLowerCase().includes('installation')) score -= 0.2;
      if (chunk.title.toLowerCase().includes('expiration')) score -= 0.2;
      if (chunk.id === 'KB-WIN-ROTATE-47') score += 0.2;
      if (wantsMacos && chunk.platform !== 'macos') score -= 0.9;
      return {
        ...chunk,
        rerankScore: Number(Math.max(0, Math.min(0.99, score)).toFixed(2)),
      };
    })
    .sort((a, b) => b.rerankScore - a.rerankScore);
}

export interface AdmitOptions {
  threshold: number;
  maxChunks: number;
  contextBudgetChars: number;
}

export function admit(chunks: ScoredChunk[], options: AdmitOptions): ScoredChunk[] {
  const seen = new Set<string>();
  let used = 0;
  const admitted: ScoredChunk[] = [];

  for (const chunk of chunks) {
    const nextUsed = used + chunk.text.length;
    const allowed = chunk.rerankScore >= options.threshold
      && !seen.has(chunk.id)
      && nextUsed <= options.contextBudgetChars;

    if (allowed) {
      admitted.push(chunk);
      seen.add(chunk.id);
      used = nextUsed;
      if (admitted.length >= options.maxChunks) break;
    }
  }

  return admitted;
}

export function countContextChars(chunks: KnowledgeChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
}

export function simulateNaiveAnswer(chunks: KnowledgeChunk[]): string {
  const hasApi = chunks.some((chunk) => chunk.id === 'KB-API-KEY-ROTATE');
  const hasLinux = chunks.some((chunk) => chunk.id === 'KB-LINUX-CERT-ROTATE');
  const hasOldWindows = chunks.some((chunk) => chunk.id === 'KB-WIN-ROTATE-42');

  return [
    'Open Sensor Settings > Security to create a new signing key.',
    hasApi ? 'You may also need Settings > API Keys.' : '',
    hasLinux ? 'If the sensor uses CLI workflows, run sensorctl certificate rotate.' : '',
    hasOldWindows ? 'Some Windows versions use the legacy certificate screen.' : '',
    'Verify adoption before revoking the old key.',
  ].filter(Boolean).join(' ');
}

export function simulateStrictAnswer(chunks: KnowledgeChunk[]): string {
  const correct = chunks.find((chunk) => chunk.id === 'KB-WIN-ROTATE-47');
  if (!correct) return 'I do not have supported documentation for that sensor/platform/version.';
  return 'Open Sensor Settings > Security, create a new signing key, distribute it to Windows '
    + 'Sensor 4.7 devices, verify adoption, then revoke the old key.';
}

export function line(title: string): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(title);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}
