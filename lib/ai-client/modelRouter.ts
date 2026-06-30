// Tiered model routing: routes AI tasks to local (Ollama) or cloud models
// based on task complexity. Checks Ollama availability and falls back to
// cloud when local inference is unavailable.

import type { FetchFn } from './types.js';
import type { ModelRegistry } from './registry.js';
import { isOllamaAvailable } from './providers/ollama.js';
import { ActionableError } from '../errors/actionableError.js';

// ── Task tiers ───────────────────────────────────────────

export enum TaskTier {
  /** Simple tasks: summarization, enrichment, extraction */
  LOCAL = 'local',
  /** Medium complexity: scoring, classification, standard generation */
  CLOUD_FAST = 'cloud_fast',
  /** High complexity: multi-step reasoning, synthesis, analysis */
  CLOUD_FRONTIER = 'cloud_frontier',
}

// ── Purpose strings ──────────────────────────────────────
// Extend this union with your application's task types.

export type TaskPurpose =
  // Tier 1 — Local
  | 'summarization'
  | 'extraction'
  | 'classification'
  | 'enrichment'
  // Tier 2 — Cloud Fast
  | 'generation'
  | 'scoring'
  | 'moderation'
  | 'planning'
  // Tier 3 — Cloud Frontier
  | 'synthesis'
  | 'analysis'
  | 'reasoning'
  | 'evaluation';

/** Map each task purpose to its preferred tier. */
export const PURPOSE_TIER_MAP: Record<TaskPurpose, TaskTier> = {
  // Tier 1 — Local (simple extraction / enrichment)
  summarization:    TaskTier.LOCAL,
  extraction:       TaskTier.LOCAL,
  classification:   TaskTier.LOCAL,
  enrichment:       TaskTier.LOCAL,
  // Tier 2 — Cloud Fast (moderate reasoning)
  generation:       TaskTier.CLOUD_FAST,
  scoring:          TaskTier.CLOUD_FAST,
  moderation:       TaskTier.CLOUD_FAST,
  planning:         TaskTier.CLOUD_FAST,
  // Tier 3 — Cloud Frontier (complex multi-step reasoning)
  synthesis:        TaskTier.CLOUD_FRONTIER,
  analysis:         TaskTier.CLOUD_FRONTIER,
  reasoning:        TaskTier.CLOUD_FRONTIER,
  evaluation:       TaskTier.CLOUD_FRONTIER,
};

// ── Router configuration ─────────────────────────────────

export interface RouterConfig {
  /** Whether to prefer local models for Tier 1 tasks (default: true) */
  preferLocal: boolean;
  /** Default model for Tier 2 (cloud fast) tasks */
  cloudFastModel: string;
  /** Default model for Tier 3 (cloud frontier) tasks */
  cloudFrontierModel: string;
  /** Local model to use for Tier 1 tasks */
  localModel: string;
}

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  preferLocal: true,
  cloudFastModel: 'gemini-2.0-flash-lite',
  cloudFrontierModel: 'gemini-2.5-flash',
  localModel: 'ollama-gemma3',
};

// ── Router state ─────────────────────────────────────────

let _ollamaAvailable: boolean | null = null;
let _config: RouterConfig = { ...DEFAULT_ROUTER_CONFIG };

export async function probeOllama(fetchFn: FetchFn): Promise<boolean> {
  _ollamaAvailable = await isOllamaAvailable(fetchFn);
  return _ollamaAvailable;
}

/** Update router configuration. Merges with current config. */
export function configureRouter(overrides: Partial<RouterConfig>): void {
  _config = { ..._config, ...overrides };
}

/** Get current router configuration (for diagnostics). */
export function getRouterConfig(): Readonly<RouterConfig & { ollamaAvailable: boolean | null }> {
  return { ..._config, ollamaAvailable: _ollamaAvailable };
}

// ── Core routing ─────────────────────────────────────────

export interface RoutedModel {
  model: string;
  tier: TaskTier;
  isLocal: boolean;
  purpose: TaskPurpose;
}

export async function resolveModelForPurpose(
  purpose: TaskPurpose,
  explicitModel?: string,
  fetchFn?: FetchFn,
): Promise<RoutedModel> {
  if (explicitModel) {
    const tier = PURPOSE_TIER_MAP[purpose] ?? TaskTier.CLOUD_FAST;
    const isLocal = explicitModel.startsWith('ollama');
    return { model: explicitModel, tier, isLocal, purpose };
  }

  const tier = PURPOSE_TIER_MAP[purpose] ?? TaskTier.CLOUD_FAST;

  if (tier === TaskTier.LOCAL && _config.preferLocal) {
    if (_ollamaAvailable === null && fetchFn) {
      _ollamaAvailable = await isOllamaAvailable(fetchFn);
    }
    if (_ollamaAvailable) {
      return { model: _config.localModel, tier, isLocal: true, purpose };
    }
  }

  switch (tier) {
    case TaskTier.LOCAL:
      return { model: _config.cloudFastModel, tier, isLocal: false, purpose };
    case TaskTier.CLOUD_FAST:
      return { model: _config.cloudFastModel, tier, isLocal: false, purpose };
    case TaskTier.CLOUD_FRONTIER:
      return { model: _config.cloudFrontierModel, tier, isLocal: false, purpose };
  }
}

export function getTierForPurpose(purpose: TaskPurpose): TaskTier {
  return PURPOSE_TIER_MAP[purpose] ?? TaskTier.CLOUD_FAST;
}

// ── Multi-provider model resolution ──────────────────────

export type ModelTier = 'basic' | 'advanced';

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function resolveMultiProviderModels(
  tier: ModelTier,
  availableBackends: string[],
  speakers: string[],
  registry: ModelRegistry,
): Record<string, string> {
  const tierMap = registry.taskTiers?.[tier];
  if (!tierMap) {
    throw new ActionableError({
      goal: 'Resolve multi-provider models',
      problem: `Unknown task tier "${tier}" — registry has no taskTiers entry for it`,
      location: 'modelRouter.resolveMultiProviderModels',
      nextSteps: ['Use "basic" or "advanced" as tier', 'Check ai-models.json taskTiers config'],
    });
  }

  const eligible = availableBackends.filter(b => tierMap[b] != null);
  if (eligible.length === 0) {
    throw new ActionableError({
      goal: 'Resolve multi-provider models',
      problem: `No available backends have models defined for tier "${tier}". Available: [${availableBackends.join(', ')}], tier has: [${Object.keys(tierMap).join(', ')}]`,
      location: 'modelRouter.resolveMultiProviderModels',
      nextSteps: ['Register at least one API key for a backend in the tier', 'Check ai-models.json taskTiers config'],
    });
  }

  const shuffled = fisherYatesShuffle(eligible);
  const result: Record<string, string> = {};
  for (let i = 0; i < speakers.length; i++) {
    const backend = shuffled[i % shuffled.length];
    result[speakers[i]] = tierMap[backend];
  }
  return result;
}
