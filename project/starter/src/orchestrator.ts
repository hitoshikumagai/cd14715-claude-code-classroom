import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { ReviewReport, ReviewReportSchema, ReviewReportJSONSchema } from './types/report-types.js';
import { subagents } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import { mcpServersConfig } from './config/mcp.config.js';
import { RateLimiter, RateLimiterConfig } from './utils/rate-limiter.js';
import { ReviewError, ErrorCodes, withRetry, withTimeout, formatError } from './utils/error-handler.js';
import { logger } from './utils/logger.js';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /** Rate limits applied to review runs (merged with DEFAULT_RATE_LIMITS) */
  rateLimits?: Partial<RateLimiterConfig>;
  /** Model for the orchestrator; subagents set their own. Defaults to ANTHROPIC_MODEL */
  model?: string;
  /** Directory containing .claude/skills/. Defaults to PROJECT_ROOT, then cwd */
  projectRoot?: string;
  /** Attempts per review before giving up (default: 3) */
  maxRetries?: number;
  /** Base delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
  /** Timeout for one review attempt in ms (default: 10 minutes) */
  timeoutMs?: number;
  /** Max conversation turns for the orchestrator (default: 50) */
  maxTurns?: number;
  /** Token estimate reserved per review for rate limiting (default: 10000) */
  estimatedTokensPerReview?: number;
}

// Built-in tools the orchestrator session can see at all; MCP tools come from mcpServers
const BUILT_IN_TOOLS = ['Agent', 'Skill'];

// Tools approved without a permission prompt
const ALLOWED_TOOLS = [
  'Agent',
  'Skill',
  'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files',
  'mcp__github__get_file_contents',
  'mcp__github__search_code',
  'mcp__eslint__lint-files'
];

const DISALLOWED_TOOLS = [
  'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
  // The GitHub MCP server also exposes write tools; a review must never change the repository
  'mcp__github__add_issue_comment',
  'mcp__github__create_branch',
  'mcp__github__create_issue',
  'mcp__github__create_or_update_file',
  'mcp__github__create_pull_request',
  'mcp__github__create_pull_request_review',
  'mcp__github__create_repository',
  'mcp__github__fork_repository',
  'mcp__github__merge_pull_request',
  'mcp__github__push_files',
  'mcp__github__update_issue',
  'mcp__github__update_pull_request_branch'
];

// API errors that retrying cannot fix. Without stopping on these, the SDK keeps
// prompting for structured output until maxTurns, on every retry.
const FATAL_API_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'cloud_credential_error'
]);

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  readonly rateLimiter: RateLimiter;
  private readonly options: Required<Omit<OrchestratorOptions, 'rateLimits' | 'model'>> & { model?: string };

  constructor(options: OrchestratorOptions = {}) {
    this.rateLimiter = new RateLimiter(options.rateLimits);
    this.options = {
      model: options.model ?? process.env.ANTHROPIC_MODEL,
      projectRoot: options.projectRoot ?? process.env.PROJECT_ROOT ?? process.cwd(),
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1000,
      timeoutMs: options.timeoutMs ?? 10 * 60 * 1000,
      maxTurns: options.maxTurns ?? 50,
      estimatedTokensPerReview: options.estimatedTokensPerReview ?? 10000
    };
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const startedAt = Date.now();
    logger.info('Starting code review', { owner, repo, prNumber });

    await this.rateLimiter.acquire(this.options.estimatedTokensPerReview);
    let tokensUsed: number | undefined;

    try {
      // Validation runs inside the retry so a malformed report gets another attempt
      const { result, report } = await withRetry(
        async () => {
          const result = await withTimeout(
            () => this.runReview(owner, repo, prNumber),
            this.options.timeoutMs,
            `Review of ${owner}/${repo}#${prNumber} timed out`
          );
          tokensUsed = (tokensUsed ?? 0) + result.usage.input_tokens + result.usage.output_tokens;
          return { result, report: this.validateReport(result.structured_output, startedAt) };
        },
        this.options.maxRetries,
        this.options.retryDelayMs
      );

      logger.info('Code review completed', {
        owner,
        repo,
        prNumber,
        score: report.summary.overallScore,
        duration: report.metadata.duration,
        costUsd: result.total_cost_usd
      });
      return report;
    } catch (error) {
      logger.error('Code review failed', { owner, repo, prNumber, error: formatError(error) });
      throw error;
    } finally {
      this.rateLimiter.release(tokensUsed);
    }
  }

  /**
   * Run one orchestrator session and return its successful result message
   */
  private async runReview(owner: string, repo: string, prNumber: number) {
    const stream = query({
      prompt: buildOrchestratorPrompt(owner, repo, prNumber),
      options: {
        model: this.options.model,
        cwd: this.options.projectRoot,
        // Load .claude/skills/ from the project so subagents can invoke Skills
        settingSources: ['project'],
        agents: subagents,
        mcpServers: mcpServersConfig,
        tools: BUILT_IN_TOOLS,
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        maxTurns: this.options.maxTurns,
        outputFormat: { type: 'json_schema', schema: ReviewReportJSONSchema }
      }
    });

    let result: SDKResultMessage | undefined;
    for await (const message of stream) {
      if (message.type === 'result') {
        result = message;
      } else if (message.type === 'assistant') {
        if (message.error && FATAL_API_ERRORS.has(message.error)) {
          // Leaving the loop closes the stream and stops the SDK session
          throw new ReviewError(
            `Claude API error: ${message.error}`,
            ErrorCodes.AGENT_FAILED,
            { apiError: message.error, retryable: false }
          );
        }
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            logger.debug('Tool call', { tool: block.name });
          }
        }
      }
    }

    if (!result) {
      throw new ReviewError('Orchestrator finished without a result', ErrorCodes.AGENT_FAILED);
    }
    if (result.subtype !== 'success') {
      throw new ReviewError(
        `Orchestrator failed: ${result.subtype}`,
        ErrorCodes.AGENT_FAILED,
        { subtype: result.subtype, errors: result.errors }
      );
    }
    if (result.structured_output === undefined) {
      throw new ReviewError('Orchestrator returned no structured output', ErrorCodes.STRUCTURED_OUTPUT_FAILED);
    }
    return result;
  }

  /**
   * Fill in metadata the model can't know, then validate against the report schema
   */
  private validateReport(output: unknown, startedAt: number): ReviewReport {
    const withMetadata = {
      ...(output as Record<string, unknown>),
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration: Date.now() - startedAt,
        agentVersions: Object.fromEntries(
          Object.entries(subagents).map(([name, agent]) => [
            name,
            !agent.model || agent.model === 'inherit' ? this.options.model ?? 'default' : agent.model
          ])
        )
      }
    };

    const parsed = ReviewReportSchema.safeParse(withMetadata);
    if (!parsed.success) {
      throw new ReviewError(
        'Structured output validation failed',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        { issues: parsed.error.issues.slice(0, 10) }
      );
    }
    return parsed.data;
  }
}
