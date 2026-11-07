import { z } from 'zod';
import {
  CodeQualityResultSchema,
  TestCoverageResultSchema,
  RefactoringSuggestionSchema
} from './analysis-results.js';

/**
 * Complete Review Report Schema
 * Aggregates all subagent results into a unified report
 */
export const ReviewReportSchema = z.object({
  pullRequest: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number()
  }),
  fileReviews: z.array(z.object({
    file: z.string(),
    codeQuality: CodeQualityResultSchema,
    testCoverage: TestCoverageResultSchema,
    refactorings: RefactoringSuggestionSchema
  })),
  summary: z.object({
    totalFiles: z.number(),
    overallScore: z.number(),
    criticalIssues: z.number(),
    highPriorityTests: z.number(),
    refactoringOpportunities: z.number()
  }),
  recommendations: z.array(z.object({
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.string(),
    description: z.string(),
    files: z.array(z.string())
  })),
  metadata: z.object({
    analyzedAt: z.string(),
    duration: z.number(),
    agentVersions: z.record(z.string(), z.string())
  })
});

/**
 * TypeScript type inferred from Zod schema
 */
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema for SDK structured outputs
 * Per SDK docs: https://platform.claude.com/docs/en/agent-sdk/structured-outputs
 * Zod v4's built-in z.toJSONSchema inlines nested schemas by default.
 * Target draft-7: the Claude Code CLI's validator rejects the default draft 2020-12 $schema
 */
export const ReviewReportJSONSchema: JsonSchema = z.toJSONSchema(ReviewReportSchema, { target: 'draft-7' }) as JsonSchema;
