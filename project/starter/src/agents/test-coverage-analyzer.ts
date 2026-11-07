import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/index.js';

/**
 * Test Coverage Analyzer
 * Finds untested functions, branches, and edge cases with priority levels.
 */
export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Finds untested code paths in a single PR file by locating its existing tests in the repository. Returns prioritized test suggestions and a coverage estimate as JSON.',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  // GitHub tools let it look for existing test files outside the PR
  tools: ['mcp__github__search_code', 'mcp__github__get_file_contents'],
  model: 'sonnet'
};
