/**
 * ApplyPilot — AI API layer
 *
 * Anthropic (default, claude-haiku with extended thinking) + OpenAI fallback.
 * All fetch() calls are made from the background service worker to avoid CORS.
 *
 * Prompt design goals:
 *  • Force the model to reason about JD↔resume fit BEFORE writing (thinking block)
 *  • Extract hard technical requirements from the JD, not just "experience needed"
 *  • Match candidate achievements to those exact requirements with evidence
 *  • Banned-phrase enforcement so output never sounds templated
 *  • Role-aware tone: backend/Go, infra/platform, AI/LLM, PHP/web all feel different
 */

import type { CoverLetterPayload, Settings, UserProfile } from '../types';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a resume/CV text with Haiku and return pre-filled profile fields.
 * Called directly from the options page (no background relay needed — options
 * page has host_permission for api.anthropic.com).
 */
export async function extractProfileFromResume(
  resumeText: string,
  apiKey:     string,
): Promise<Partial<UserProfile>> {
  if (!apiKey) throw new Error('No Anthropic API key set. Add it in Settings → API Keys first.');

  const prompt = `Extract structured information from this resume/CV and return ONLY a JSON object.

RESUME:
${resumeText.slice(0, 6000)}

Return a JSON object with these exact keys (omit any key you cannot determine):
{
  "firstName": "",
  "lastName": "",
  "email": "",
  "phone": "",
  "city": "",
  "country": "",
  "currentJobTitle": "",
  "currentCompany": "",
  "yearsOfExperience": "",
  "summary": "",
  "skills": [],
  "linkedinUrl": "",
  "githubUrl": "",
  "portfolioUrl": ""
}

Rules:
- yearsOfExperience: a number string like "7" (estimate from work history dates if not stated)
- skills: array of specific tech tools/languages only (no soft skills)
- summary: 1–2 sentence professional summary, past tense, factual
- Return ONLY the JSON — no explanation, no markdown fences`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${err}`);
  }

  const data = await resp.json() as { content: Array<{ type: string; text?: string }> };
  const raw  = (data.content ?? [])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('')
    .trim();

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  const parsed  = JSON.parse(cleaned) as Partial<UserProfile>;

  // Derive full name
  if (parsed.firstName || parsed.lastName) {
    parsed.name = `${parsed.firstName ?? ''} ${parsed.lastName ?? ''}`.trim();
  }

  return parsed;
}

export async function generateCoverLetter(
  payload:  CoverLetterPayload,
  settings: Settings,
): Promise<string> {
  if (settings.aiProvider === 'anthropic' && settings.anthropicApiKey) {
    return callAnthropic(payload, settings);
  }
  if (settings.aiProvider === 'openai' && settings.openaiApiKey) {
    return callOpenAI(payload, settings);
  }
  throw new Error('No AI API key configured. Go to Settings → API Keys.');
}

// ── Anthropic — extended thinking enabled ────────────────────────────────────

async function callAnthropic(
  payload:  CoverLetterPayload,
  settings: Settings,
): Promise<string> {
  const model = settings.aiModel || 'claude-haiku-4-5-20251001';

  const { system, user } = buildAnthropicMessages(payload);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         settings.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      // Extended thinking: model reasons through JD↔resume fit before writing
      'anthropic-beta':    'interleaved-thinking-2025-05-14',
    },
    body: JSON.stringify({
      model,
      max_tokens: 5000,   // must be > thinking.budget_tokens
      thinking: {
        type:          'enabled',
        budget_tokens: 3500,  // deeper JD analysis, richer evidence matching,
                               // stronger hook planning — up from 1500
      },
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${err}`);
  }

  const data = await resp.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  // Collect only the visible text blocks (thinking blocks are hidden from user)
  const letter = data.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n')
    .trim();

  return postProcess(letter);
}

// ── OpenAI fallback ───────────────────────────────────────────────────────────

async function callOpenAI(
  payload:  CoverLetterPayload,
  settings: Settings,
): Promise<string> {
  const model = settings.aiModel || 'gpt-4o-mini';
  // OpenAI doesn't expose extended thinking, but we embed the reasoning
  // chain-of-thought instruction directly in the prompt.
  const { system, user } = buildOpenAIMessages(payload);

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${settings.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [
        { role: 'system',  content: system },
        { role: 'user',    content: user   },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${err}`);
  }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return postProcess(data.choices[0]?.message?.content?.trim() ?? '');
}

// ── System prompt (role-aware) ────────────────────────────────────────────────

function buildSystemPrompt(payload: CoverLetterPayload): string {
  const roleType = classifyRole(payload.jobTitle);

  return `You are a senior ${roleType.hiring} who also writes exceptional cover letters for engineers.
You have reviewed thousands of applications. You know immediately which letters are templated and which are genuine.

YOUR STRICT WRITING RULES:
1. Every sentence must contain a concrete noun (a technology, a metric, a company name, a product) — no abstract claims.
2. The opening sentence must reference something SPECIFIC from this job description or company, not the candidate's feelings.
3. Technical terms must match the JD exactly — if the JD says "Go" use "Go", not "Golang"; if it says "K8s" use "K8s".
4. Achievements must be specific: "reduced p99 latency by 40%" beats "improved performance significantly".
5. European market note: Engineering culture values precision and directness. No marketing language.
6. If the candidate is authorized to work without sponsorship, state it once — it's a real competitive advantage. Do NOT mention specific visa types (Blue Card, PR, etc.) — just say "authorized to work" or "no sponsorship needed".

FORBIDDEN PHRASES (using any of these fails the task):
- "I am writing to express my interest"
- "I am passionate about" / "I am excited about"
- "I am a passionate developer"
- "I believe I would be a great fit"
- "team player" / "hard worker" / "fast learner"
- "leverage my experience" / "leverage my skills"
- "strong background in" / "deep knowledge of" / "extensive experience"
- "I look forward to discussing" / "I look forward to hearing from you"
- "Thank you for your consideration"
- "Dear Hiring Manager" (do not include salutation at all)

ROLE CONTEXT: This is a ${roleType.label} role. ${roleType.emphasis}`;
}

// ── Role classifier — shapes tone and technical emphasis ─────────────────────

interface RoleType {
  label:    string;
  hiring:   string;
  emphasis: string;
}

function classifyRole(title: string): RoleType {
  const t = title.toLowerCase();

  if (/\bgo\b|golang|backend.*go|go.*backend/.test(t)) return {
    label:   'Go/Backend Engineering',
    hiring:  'backend engineering hiring manager (Go specialist)',
    emphasis: 'Emphasise: concurrency patterns, service reliability, API design, Go-specific idioms, gRPC/protobuf, observability. Show ownership of services in production, not just coding.',
  };

  if (/platform|infrastructure|infra|devops|sre|cloud|kubernetes|k8s/.test(t)) return {
    label:   'Platform/Infrastructure Engineering',
    hiring:  'platform engineering director',
    emphasis: 'Emphasise: scale, reliability, developer experience improvements, IaC (Terraform/Pulumi), Kubernetes operators, CI/CD pipelines, incident response. Engineers at this level own systems, not tickets.',
  };

  if (/ai|llm|ml|machine.?learn|agent|nlp|genai|gen.?ai/.test(t)) return {
    label:   'AI/LLM Engineering',
    hiring:  'AI engineering lead',
    emphasis: 'Emphasise: LLM integration patterns, RAG, agent frameworks, evaluation pipelines, production AI systems (not research). Show pragmatism — shipping AI features, not just experimenting.',
  };

  if (/php|laravel|symfony|web.?dev|full.?stack|wordpress/.test(t)) return {
    label:   'PHP/Web Engineering',
    hiring:  'web engineering hiring manager',
    emphasis: 'Emphasise: clean architecture, testability, database performance, API design. PHP world values pragmatism — show you can ship at scale, not just write clean code in isolation.',
  };

  if (/product.*engineer|engineering.*product|senior.*engineer|staff.*engineer|principal/.test(t)) return {
    label:   'Senior/Product Engineering',
    hiring:  'engineering manager at a product-led company',
    emphasis: 'Emphasise: end-to-end ownership, product intuition, cross-functional collaboration, technical leadership without title. Senior engineers multiply team output — show that.',
  };

  // Generic engineering fallback
  return {
    label:   'Software Engineering',
    hiring:  'engineering hiring manager',
    emphasis: 'Emphasise: concrete impact, system ownership, technical depth in the stack mentioned in the JD.',
  };
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildAnthropicMessages(p: CoverLetterPayload): { system: string; user: string } {
  return {
    system: buildSystemPrompt(p),
    user:   buildUserPrompt(p),
  };
}

function buildOpenAIMessages(p: CoverLetterPayload): { system: string; user: string } {
  const base = buildSystemPrompt(p);
  // For OpenAI, embed a lightweight chain-of-thought instruction since there's no native thinking
  const cot = `\n\nBefore writing, silently identify:
1. The top 3 hard technical requirements from the JD (specific tools/stacks, NOT soft skills)
2. The strongest matching evidence from the resume for each
3. One specific hook about this company/role that isn't generic
Then write the letter. Do not include your analysis in the output.`;

  return {
    system: base + cot,
    user:   buildUserPrompt(p),
  };
}

function buildUserPrompt(p: CoverLetterPayload): string {
  const { profile } = p;
  const name        = profile.name || `${profile.firstName} ${profile.lastName}`.trim();
  const experience  = profile.yearsOfExperience ? `${profile.yearsOfExperience} years experience` : '';
  const currentRole = profile.currentJobTitle
    ? `${profile.currentJobTitle}${profile.currentCompany ? ' at ' + profile.currentCompany : ''}`
    : '';
  const notice      = profile.noticePeriod
    ? `${profile.noticePeriod} ${profile.noticePeriodUnit} notice period`
    : '';
  const salary      = profile.salaryMin
    ? `${profile.salaryMin}–${profile.salaryMax} ${profile.salaryCurrency}`
    : '';
  const visaNote    = profile.noVisaSponsorship
    ? 'Authorized to work — no visa sponsorship needed'
    : '';

  // Extract JD tech stack keywords to highlight in the prompt
  const jdKeywords  = extractTechKeywords(p.jobDescription);
  const resumeMatch = jdKeywords
    .filter((kw) => p.resumeText.toLowerCase().includes(kw.toLowerCase()))
    .slice(0, 8);

  return `═══ TARGET ROLE ═══
Title:    ${p.jobTitle}
Company:  ${p.company}
Location: ${p.location || 'Germany'}

JOB DESCRIPTION (read carefully — extract hard requirements, not soft skills):
${p.jobDescription.slice(0, 4500)}

═══ CANDIDATE ═══
Name:         ${name}
Current role: ${currentRole || '(not specified)'}
Experience:   ${experience || '(not specified)'}
Skills:       ${profile.skills.join(', ')}
${salary    ? `Salary target: ${salary}` : ''}
${notice    ? `Availability: ${notice}` : ''}
${visaNote  ? `Work status: ${visaNote}` : ''}
Work mode:    ${profile.workModePreference}
${profile.summary ? `\nSummary: ${profile.summary}` : ''}

JD ↔ RESUME TECH OVERLAPS (keywords found in both — prioritise these):
${resumeMatch.length > 0 ? resumeMatch.join(', ') : '(analyse manually)'}

═══ RESUME (source of truth — only cite facts from here) ═══
${p.resumeText.slice(0, 5000)}

═══ WRITE THE COVER LETTER ═══
Structure (3 paragraphs, max 310 words total):

PARAGRAPH 1 — Hook (45–65 words)
Open with a sentence that ONLY someone who read this specific JD could write.
Reference a specific technical challenge, product decision, or stack detail from the JD.
Then connect it to ONE concrete thing from the candidate's background.
Do NOT start with "I" as the first word.

PARAGRAPH 2 — Evidence (140–170 words)
Pick the 2–3 requirements most emphasised in the JD (look for repetition, section headers, "must have").
For each: state the requirement, then give specific evidence from the resume.
Use exact technology names. Include at least one number/metric if the resume contains any.
If the resume mentions a tech the JD asks for, name both and link them explicitly.

PARAGRAPH 3 — Close (55–75 words)
One sentence: why THIS company specifically (product, technical challenge, or market position — not "culture" or "growth").
Restate practical fit: availability, work mode, visa/PR status if relevant.
End with a direct, confident CTA — not a question, not "I look forward to".

OUTPUT: The letter body only. No salutation. No sign-off. No subject line.`;
}

// ── JD tech keyword extractor ─────────────────────────────────────────────────
// Pulls hard technical nouns from the JD so the prompt can show the overlap
// with the candidate's resume — nudges the model to reference the right terms.

const TECH_VOCAB = [
  'Go','Golang','Python','PHP','Java','TypeScript','JavaScript','Rust','C++','Ruby',
  'Kubernetes','K8s','Docker','Helm','Terraform','Pulumi','Ansible','ArgoCD','FluxCD',
  'AWS','GCP','Azure','EKS','GKE','AKS','EC2','S3','Lambda','CloudFormation',
  'gRPC','protobuf','REST','GraphQL','OpenAPI','Kafka','RabbitMQ','NATS','Redis',
  'PostgreSQL','MySQL','MongoDB','DynamoDB','Cassandra','ClickHouse','BigQuery',
  'Prometheus','Grafana','OpenTelemetry','Datadog','Jaeger','Elasticsearch',
  'React','Next.js','Vue','Angular','Laravel','Symfony','Django','FastAPI',
  'LLM','RAG','OpenAI','Anthropic','LangChain','LlamaIndex','vector database',
  'microservices','event-driven','CQRS','DDD','clean architecture',
  'CI/CD','GitHub Actions','GitLab CI','Jenkins','Tekton',
  'Linux','bash','shell','systemd','eBPF',
  'Agile','Scrum','Kanban','OKR',
];

function extractTechKeywords(jd: string): string[] {
  const lower = jd.toLowerCase();
  return TECH_VOCAB.filter((kw) => lower.includes(kw.toLowerCase()));
}

// ── Post-processor — catch any remaining generic phrases ─────────────────────

const BANNED_PATTERNS: Array<[RegExp, string]> = [
  [/I am writing to (express|apply|inquire)/gi,  ''],
  [/I am (passionate|excited|thrilled) (about|to)/gi, ''],
  [/I believe I (would|will) be a (great|good|excellent|perfect) fit/gi, ''],
  [/team player/gi, ''],
  [/hard worker/gi, ''],
  [/fast learner/gi, ''],
  [/leverage my (experience|skills|background)/gi, ''],
  [/I look forward to (discussing|hearing|speaking)/gi, ''],
  [/Thank you for (your consideration|considering|taking the time)/gi, ''],
  [/Dear Hiring Manager[,:]?\s*/gi, ''],
  [/Sincerely[,\s]+\S+/gi, ''],
  [/Best regards[,\s]+\S+/gi, ''],
  [/Kind regards[,\s]+\S+/gi, ''],
];

function postProcess(text: string): string {
  let out = text.trim();
  for (const [pattern, replacement] of BANNED_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Collapse multiple blank lines left by deletions
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

// ── API key validation ────────────────────────────────────────────────────────

export async function testAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Hi' }],
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function testOpenAIKey(apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return resp.ok;
  } catch {
    return false;
  }
}
