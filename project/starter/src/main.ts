// Must be the first import: ES imports are hoisted, so a later dotenv.config()
// call would run after modules like mcp.config.ts have already read process.env
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';
import { formatError } from './utils/error-handler.js';

/**
 * Print an error and exit with a non-zero status
 */
function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  // Validate command line arguments
  if (!owner || !repo || !prStr) {
    fail('Usage: npm run dev -- <owner> <repo> <pr-number>\n   Example: npm run dev -- facebook react 12345');
  }
  const prNumber = Number(prStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    fail(`PR number must be a positive integer, got "${prStr}"`);
  }

  // Validate authentication (Anthropic API key or AWS Bedrock credentials)
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (hasAnthropicKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else if (hasAwsCredentials) {
    if (!process.env.AWS_REGION) {
      fail('AWS_REGION must be set when using AWS Bedrock authentication');
    }
    // Tells the Agent SDK to route requests through Bedrock
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    console.log('🔐 Using AWS Bedrock authentication');
  } else {
    fail(
      'No authentication configured. Set ONE of these in .env:\n' +
      '   Option 1 (Anthropic API): ANTHROPIC_API_KEY=sk-ant-...\n' +
      '   Option 2 (AWS Bedrock):   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION'
    );
  }

  // Validate model (required for both authentication methods)
  if (!process.env.ANTHROPIC_MODEL) {
    fail(
      'ANTHROPIC_MODEL is not set. Add it to .env:\n' +
      '   Anthropic API: ANTHROPIC_MODEL=claude-sonnet-5-5\n' +
      '   AWS Bedrock:   ANTHROPIC_MODEL=<Bedrock model ID, e.g. us.anthropic.claude-...-v1:0>'
    );
  }

  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠️  GITHUB_TOKEN is not set: only public repositories work, with lower GitHub rate limits');
  }

  console.log(`🔍 Reviewing ${owner}/${repo}#${prNumber} with ${process.env.ANTHROPIC_MODEL}...`);

  try {
    const orchestrator = new CodeReviewOrchestrator();
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    // Save Markdown, HTML, and JSON reports to reports/
    const generator = new ReportGenerator();
    const reportsDir = path.resolve('reports');
    await mkdir(reportsDir, { recursive: true });

    const timestamp = report.metadata.analyzedAt.replace(/[:.]/g, '-');
    const baseName = `${owner}-${repo}-pr${prNumber}-${timestamp}`;
    const outputs: Array<[string, string]> = [
      [`${baseName}.md`, generator.generateMarkdownReport(report)],
      [`${baseName}.html`, generator.generateHTMLReport(report)],
      [`${baseName}.json`, generator.generateJSONReport(report)]
    ];
    for (const [fileName, content] of outputs) {
      await writeFile(path.join(reportsDir, fileName), content, 'utf8');
    }

    const { summary } = report;
    console.log('\n✅ Review complete');
    console.log(`   Files analyzed:            ${summary.totalFiles}`);
    console.log(`   Overall score:             ${summary.overallScore}/100`);
    console.log(`   Critical issues:           ${summary.criticalIssues}`);
    console.log(`   High-priority tests:       ${summary.highPriorityTests}`);
    console.log(`   Refactoring opportunities: ${summary.refactoringOpportunities}`);
    console.log(`   Duration:                  ${(report.metadata.duration / 1000).toFixed(1)}s`);
    console.log('\n📄 Reports saved:');
    for (const [fileName] of outputs) {
      console.log(`   ${path.join(reportsDir, fileName)}`);
    }
  } catch (error) {
    fail(`Review failed: ${formatError(error)}`);
  }
}

main();
