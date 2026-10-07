import path from 'node:path';
import { z } from 'zod';
import type { Episode, MemoryItem, ProposedOp } from './types';
import { MEMORY_KINDS } from './types';
import type { MemoryStore } from './store';
import { extractJson, type LlmClient } from './llm';
import { rankItems, strength } from './ranking';
import { redactText } from '../../shared/redact';
import { truncate } from '../../shared/util';

export const DEFAULT_POLICY = `# Memory policy

Jaffer keeps ONE continuous session with you and learns from it. These rules steer what it remembers.
Edit this file freely — it is yours and is never rewritten automatically.

## Remember
- Stable preferences (tools, style, workflow, communication).
- Conventions and facts about the projects you work in (how to build/test, layout, constraints).
- Mistakes that cost time and the fix that worked.
- Procedures you repeat.

## Never remember
- Secrets, tokens, passwords, keys, private personal data.
- One-off, transient state (a particular error from today, a temporary file path).
- Anything you tell Jaffer to forget.
`;

const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), kind: z.string(), scope: z.string().optional(), text: z.string(), tags: z.array(z.string()).optional(), confidence: z.number().optional(), why: z.string().optional() }),
  z.object({ op: z.literal('reinforce'), id: z.string(), why: z.string().optional() }),
  z.object({ op: z.literal('update'), id: z.string(), text: z.string(), why: z.string().optional() }),
  z.object({ op: z.literal('merge'), ids: z.array(z.string()).min(2), text: z.string(), kind: z.string().optional(), scope: z.string().optional(), why: z.string().optional() }),
  z.object({ op: z.literal('contradict'), id: z.string(), why: z.string().optional() }),
  z.object({ op: z.literal('forget'), id: z.string(), why: z.string().optional() }),
  z.object({
    op: z.literal('skill'),
    name: z.string(),
    description: z.string(),
    whenToUse: z.string(),
    steps: z.array(z.string()).min(1),
    scope: z.string().optional(),
    why: z.string().optional(),
  }),
]);
const ResponseSchema = z.object({ ops: z.array(z.unknown()) });

export function parseOps(raw: string, validIds: Set<string>): { ops: ProposedOp[]; dropped: number } {
  const json = extractJson(raw);
  const parsed = ResponseSchema.safeParse(Array.isArray(json) ? { ops: json } : json);
  if (!parsed.success) return { ops: [], dropped: 0 };
  const ops: ProposedOp[] = [];
  let dropped = 0;
  for (const candidate of parsed.data.ops) {
    const r = OpSchema.safeParse(candidate);
    if (!r.success) {
      dropped++;
      continue;
    }
    const op = r.data;
    switch (op.op) {
      case 'add':
        if (!MEMORY_KINDS.includes(op.kind as never)) {
          dropped++;
          continue;
        }
        ops.push(op as unknown as ProposedOp);
        break;
      case 'reinforce':
      case 'update':
      case 'contradict':
      case 'forget':
        if (!validIds.has(op.id)) {
          dropped++;
          continue;
        }
        ops.push(op as ProposedOp);
        break;
      case 'merge':
        if (!op.ids.every((id) => validIds.has(id))) {
          dropped++;
          continue;
        }
        ops.push(op as unknown as ProposedOp);
        break;
      case 'skill':
        ops.push(op as unknown as ProposedOp);
        break;
    }
  }
  return { ops, dropped };
}

/** Compress episodes into a prompt-sized digest. Agent turns and corrections win over plain commands. */
export function buildDigest(episodes: Episode[], budgetChars = 22_000): string {
  const lines: { prio: number; text: string }[] = [];
  for (const e of episodes) {
    const where = e.project ? path.basename(e.project) : e.cwd ? path.basename(e.cwd) : '-';
    const time = e.ts.slice(5, 16).replace('T', ' ');
    switch (e.t) {
      case 'cmd': {
        const status = e.exit === 0 ? 'ok' : `exit ${e.exit}`;
        let l = `[${time}] (${where}) $ ${truncate(e.cmd, 200)} → ${status}`;
        if (e.exit !== 0 && e.out) l += `\n    output tail: ${truncate(e.out.replace(/\s+/g, ' '), 300)}`;
        lines.push({ prio: e.exit !== 0 ? 2 : 1, text: l });
        break;
      }
      case 'ext':
        lines.push({ prio: e.correction ? 5 : e.role === 'user' ? 3 : 1, text: `[${time}] (${where}) ${e.agent} ${e.role.toUpperCase()}${e.correction ? ' [CORRECTION]' : ''}: ${truncate(e.text, 400)}` });
        break;
      case 'note':
        lines.push({ prio: 6, text: `[${time}] (${where}) NOTE FROM USER: ${truncate(e.text, 400)}` });
        break;
    }
  }
  // Keep chronological order but drop the lowest-priority lines first until it fits.
  let total = lines.reduce((s, l) => s + l.text.length + 1, 0);
  const keep = lines.map(() => true);
  const order = lines.map((l, i) => ({ i, prio: l.prio })).sort((a, b) => a.prio - b.prio || a.i - b.i);
  for (const { i } of order) {
    if (total <= budgetChars) break;
    keep[i] = false;
    total -= lines[i]!.text.length + 1;
  }
  return lines.filter((_, i) => keep[i]).map((l) => l.text).join('\n');
}

export function describeMemoryForPrompt(items: MemoryItem[], maxItems = 80): string {
  const now = Date.now();
  return [...items]
    .sort((a, b) => strength(b, now) - strength(a, now))
    .slice(0, maxItems)
    .map((i) => `${i.id} [${i.kind} | ${i.scope === 'global' ? 'global' : i.scope} | c=${i.confidence.toFixed(2)} n=${i.evidence}${i.pinned ? ' | pinned' : ''}] ${i.text}`)
    .join('\n');
}

const SYSTEM = `You are the memory curator for Jaffer, a terminal that keeps ONE continuous session with its user and learns from it.
You are given (1) the current long-term memory with ids, (2) the user's memory policy, and (3) a digest of recent activity.
Decide how memory should change. Respond with ONLY a JSON object: {"ops":[...]}. No prose.

Operations:
- {"op":"add","kind":"preference|convention|fact|workflow|lesson|project|environment","scope":"global"|"project:<absolute path>","text":"...","tags":["..."],"confidence":0.0-1.0,"why":"..."}
- {"op":"reinforce","id":"m_..."}      the activity again confirms an existing item
- {"op":"update","id":"m_...","text":"..."}   an item is right but imprecise/outdated; rewrite it
- {"op":"merge","ids":["m_a","m_b"],"text":"..."}   several items say the same thing
- {"op":"contradict","id":"m_...","why":"..."}  the activity shows an item is wrong or no longer true
- {"op":"forget","id":"m_...","why":"..."}      an item is noise, obsolete, or the user asked to drop it
- {"op":"skill","name":"...","description":"...","whenToUse":"...","steps":["..."],"scope":"global"|"project:<path>"}  a multi-step procedure the user keeps repeating or that required real effort to figure out

Principles:
- Memory is for FUTURE sessions. Keep only durable, reusable knowledge. Be sparse: usually 0-6 ops. Returning {"ops":[]} is often right.
- Prefer reinforce/update/merge over add. Never add something already covered by an existing item.
- Each item is one self-contained sentence, under 220 characters, written so a stranger could act on it.
- Use scope "project:<path>" for repo-specific knowledge (use the exact project path shown in the digest), "global" for personal/tooling preferences.
- Moments marked [CORRECTION] are the strongest signal: extract the rule the user was enforcing.
- Never store secrets, tokens, credentials or personal data. Never store transient state.
- Respect the policy and do not touch pinned items except to reinforce them.`;

export interface ReflectInput {
  llm: LlmClient;
  store: MemoryStore;
  episodes: Episode[];
  policy: string;
  model?: string;
  /** Extra instruction, e.g. for consolidation passes. */
  focus?: string;
}

export async function reflectWithLlm(input: ReflectInput): Promise<{ ops: ProposedOp[]; dropped: number; raw: string }> {
  const { store, episodes } = input;
  const active = store.listItems();
  const projects = new Set(episodes.map((e) => e.project).filter(Boolean) as string[]);
  const relevant = active.filter((i) => i.scope === 'global' || (i.scope.startsWith('project:') && projects.has(i.scope.slice(8))));
  const ranked = rankItems(relevant, {}).map((r) => r.item);
  const digest = buildDigest(episodes);
  const user = [
    `## Policy\n${truncate(input.policy, 2500)}`,
    `## Current memory (${ranked.length} items shown)\n${describeMemoryForPrompt(ranked) || '(empty)'}`,
    `## Recent activity\n${digest || '(none)'}`,
    input.focus ? `## Focus\n${input.focus}` : '',
    'Return the JSON now.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const raw = await input.llm.complete({ system: SYSTEM, user: redactText(user), maxTokens: 3000, model: input.model });
  const { ops, dropped } = parseOps(raw, new Set(active.map((i) => i.id)));
  return { ops, dropped, raw };
}
