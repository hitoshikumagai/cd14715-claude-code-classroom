import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/index.js';

/**
 * Code Quality Analyzer
 * Security, performance, and maintainability review with severity levels.
 * Uses Claude Skills for language-specific guidance.
 */
export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Reviews a single PR file for security vulnerabilities, performance problems, bug risks, and maintainability issues. Returns severity-leveled issues and a 0-100 quality score as JSON.',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  // Skill loads .claude/skills/* guidance; file content arrives in the Task prompt
  tools: ['Skill'],
  model: 'sonnet'
};
