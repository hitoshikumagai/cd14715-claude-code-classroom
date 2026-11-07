import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/index.js';

/**
 * Refactoring Suggester
 * Modernization and pattern improvements with before/after examples.
 */
export const refactoringSuggester: AgentDefinition = {
  description:
    'Suggests behavior-preserving refactorings for a single PR file (extract function, rename, modernize, simplify, pattern improvements) with before/after code. Returns JSON.',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  // Works only from the code passed in the Agent prompt
  tools: [],
  // Inherit ANTHROPIC_MODEL: this SDK maps the 'sonnet' alias to a retired model ID
  model: 'inherit'
};
