import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewReport } from '../src/types/report-types.js';

/**
 * Tests for CodeReviewOrchestrator
 *
 * The Agent SDK's query() is mocked so these run without API keys:
 * each test queues the messages the fake query() stream should yield.
 */

const sdkMock = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: unknown; options: Record<string, any> }>,
  responses: [] as unknown[][]
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options: Record<string, any> }) => {
    sdkMock.calls.push(params);
    const messages = sdkMock.responses.shift() ?? [];
    return (async function* () {
      yield* messages;
    })();
  }
}));

// Keep test output quiet and avoid writing to logs/
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const { CodeReviewOrchestrator } = await import('../src/orchestrator.js');
const { DEFAULT_RATE_LIMITS } = await import('../src/utils/rate-limiter.js');

function fileReview(file: string, score: number): ReviewReport['fileReviews'][number] {
  return {
    file,
    codeQuality: { file, issues: [], overallScore: score, summary: 'ok' },
    testCoverage: {
      file,
      hasTests: false,
      testFiles: [],
      untestedPaths: [],
      coverageEstimate: 0,
      summary: 'no tests'
    },
    refactorings: { file, suggestions: [], summary: 'clean' }
  };
}

const modelReport = {
  pullRequest: { owner: 'octo', repo: 'demo', number: 42 },
  fileReviews: [fileReview('src/a.ts', 90), fileReview('src/b.ts', 70)],
  summary: {
    totalFiles: 2,
    overallScore: 80,
    criticalIssues: 0,
    highPriorityTests: 0,
    refactoringOpportunities: 0
  },
  recommendations: [],
  // The model leaves metadata empty; the orchestrator fills it in
  metadata: { analyzedAt: '', duration: 0, agentVersions: {} }
};

function successResult(structuredOutput: unknown) {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1200, output_tokens: 300 },
    total_cost_usd: 0.01,
    structured_output: structuredOutput
  };
}

function errorResult(subtype: string) {
  return {
    type: 'result',
    subtype,
    usage: { input_tokens: 10, output_tokens: 0 },
    total_cost_usd: 0,
    errors: ['something went wrong']
  };
}

// retryDelayMs: 1 keeps retry tests fast
const fastOptions = { retryDelayMs: 1 };

beforeEach(() => {
  sdkMock.calls.length = 0;
  sdkMock.responses.length = 0;
});

describe('CodeReviewOrchestrator', () => {
  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      const status = orchestrator.rateLimiter.getStatus();

      expect(status.availableRequests).toBe(DEFAULT_RATE_LIMITS.maxRequestsPerMinute);
      expect(status.availableTokens).toBe(DEFAULT_RATE_LIMITS.maxTokensPerMinute);
      expect(status.activeRequests).toBe(0);
    });

    it('should accept custom rate limit configuration', () => {
      const orchestrator = new CodeReviewOrchestrator({
        rateLimits: { maxRequestsPerMinute: 10, maxTokensPerMinute: 5000, maxConcurrent: 2 }
      });
      const status = orchestrator.rateLimiter.getStatus();

      expect(status.availableRequests).toBe(10);
      expect(status.availableTokens).toBe(5000);
    });
  });

  describe('reviewPullRequest', () => {
    it('should fetch PR files from GitHub MCP', async () => {
      sdkMock.responses.push([successResult(modelReport)]);

      await new CodeReviewOrchestrator(fastOptions).reviewPullRequest('octo', 'demo', 42);

      const { prompt, options } = sdkMock.calls[0]!;
      expect(options.mcpServers.github).toMatchObject({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github']
      });
      expect(options.allowedTools).toEqual(
        expect.arrayContaining([
          'mcp__github__get_pull_request_files',
          'mcp__github__get_file_contents'
        ])
      );
      expect(prompt).toContain('mcp__github__get_pull_request_files');
      expect(prompt).toContain('#42 in octo/demo');
    });

    it('should spawn all 3 subagents in parallel', async () => {
      sdkMock.responses.push([successResult(modelReport)]);

      await new CodeReviewOrchestrator(fastOptions).reviewPullRequest('octo', 'demo', 42);

      const { prompt, options } = sdkMock.calls[0]!;
      expect(Object.keys(options.agents).sort()).toEqual([
        'code-quality-analyzer',
        'refactoring-suggester',
        'test-coverage-analyzer'
      ]);
      expect(options.allowedTools).toContain('Agent');
      expect(options.tools).toEqual(['Agent', 'Skill']);
      expect(prompt).toContain('run_in_background set to false');
      expect(prompt).toContain('IN PARALLEL');
      // Skills in .claude/skills/ are only loaded with the project setting source
      expect(options.settingSources).toEqual(['project']);
    });

    it('should aggregate results into ReviewReport', async () => {
      sdkMock.responses.push([
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent' }] } },
        successResult(modelReport)
      ]);

      const orchestrator = new CodeReviewOrchestrator({ ...fastOptions, model: 'test-model' });
      const report = await orchestrator.reviewPullRequest('octo', 'demo', 42);

      expect(report.fileReviews.map(r => r.file)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(report.summary.overallScore).toBe(80);
      expect(report.metadata.analyzedAt).not.toBe('');
      expect(Number.isNaN(Date.parse(report.metadata.analyzedAt))).toBe(false);
      expect(report.metadata.agentVersions).toEqual({
        // Subagents inherit the orchestrator's model
        'code-quality-analyzer': 'test-model',
        'test-coverage-analyzer': 'test-model',
        'refactoring-suggester': 'test-model'
      });
      // Slot is released and actual token usage recorded
      const status = orchestrator.rateLimiter.getStatus();
      expect(status.activeRequests).toBe(0);
      expect(status.tokensInWindow).toBe(1500);
    });

    it('should validate output with Zod schema', async () => {
      const invalid = { ...modelReport, summary: { totalFiles: 'two' } };
      sdkMock.responses.push(
        [successResult(invalid)],
        [successResult(invalid)],
        [successResult(invalid)]
      );

      const orchestrator = new CodeReviewOrchestrator(fastOptions);

      await expect(orchestrator.reviewPullRequest('octo', 'demo', 42)).rejects.toMatchObject({
        code: 'RETRY_EXHAUSTED',
        message: expect.stringContaining('STRUCTURED_OUTPUT_FAILED')
      });
      expect(sdkMock.calls).toHaveLength(3);
      expect(orchestrator.rateLimiter.getStatus().activeRequests).toBe(0);
    });

    it('should retry after a failed run and then succeed', async () => {
      sdkMock.responses.push(
        [errorResult('error_max_turns')],
        [successResult({ not: 'a report' })],
        [successResult(modelReport)]
      );

      const report = await new CodeReviewOrchestrator(fastOptions).reviewPullRequest('octo', 'demo', 42);

      expect(sdkMock.calls).toHaveLength(3);
      expect(report.pullRequest).toEqual({ owner: 'octo', repo: 'demo', number: 42 });
    });

    it('should stop immediately on a non-retryable API error', async () => {
      sdkMock.responses.push([
        { type: 'assistant', error: 'model_not_found', message: { content: [{ type: 'text', text: 'API Error: 404' }] } },
        // Never reached: the orchestrator must stop at the error above
        errorResult('error_max_turns')
      ]);

      await expect(
        new CodeReviewOrchestrator(fastOptions).reviewPullRequest('octo', 'demo', 42)
      ).rejects.toMatchObject({ code: 'AGENT_FAILED', message: expect.stringContaining('model_not_found') });
      // No retries for errors that would fail the same way again
      expect(sdkMock.calls).toHaveLength(1);
    });

    it('should fail when the stream ends without a result', async () => {
      sdkMock.responses.push([], [], []);

      await expect(
        new CodeReviewOrchestrator(fastOptions).reviewPullRequest('octo', 'demo', 42)
      ).rejects.toMatchObject({
        code: 'RETRY_EXHAUSTED',
        message: expect.stringContaining('without a result')
      });
    });
  });

  describe('Integration', () => {
    // These tests require actual API keys and should be skipped in CI
    it.skip('should review a real small PR', async () => {
      // NOTE: Only run manually with valid API keys
    });
  });
});
