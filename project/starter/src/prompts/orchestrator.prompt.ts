/**
 * Prompt for the main orchestrator
 * Tells it how to fetch the PR, fan out to the 3 subagents, and aggregate results
 */
export function buildOrchestratorPrompt(owner: string, repo: string, prNumber: number): string {
  return `You are the lead code reviewer coordinating a team of specialist subagents.

Review pull request #${prNumber} in ${owner}/${repo}.

## Step 1: Fetch the pull request
- Use mcp__github__get_pull_request to read the PR title and description.
- Use mcp__github__get_pull_request_files to list changed files with their patches (diffs).
- Skip files that are deleted, binary, lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml), generated, or vendored.
- For each remaining file, use mcp__github__get_file_contents with ref set to the PR's head commit SHA (head.sha). Do not use the head branch name: it may live on a fork.

## Step 2: Analyze every file with all 3 subagents IN PARALLEL
Launch every Agent call for every file in ONE message, each with run_in_background set to false.
Calls in the same message run concurrently, and with run_in_background false each call returns the subagent's result directly, so you never need to wait or poll.
Launch each (file, subagent) pair exactly once. For each file:
- subagent_type "code-quality-analyzer"
- subagent_type "test-coverage-analyzer"
- subagent_type "refactoring-suggester"

Each Agent prompt must include: the repository (${owner}/${repo}), the PR head commit SHA, the file path, the full file content, the file's patch, and the list of all changed file paths.
Each subagent replies with a JSON object. Use its fields as-is; do not rewrite their findings.
If a subagent fails or returns invalid JSON, retry it once. If it fails again, use an empty result for that analyzer (empty arrays, score/coverage 0, summary "Analysis failed").

## Step 3: Aggregate into the final report
- fileReviews: one entry per analyzed file, combining the three subagent results.
- summary.totalFiles: number of analyzed files.
- summary.overallScore: average of codeQuality.overallScore across files (rounded integer).
- summary.criticalIssues: count of code quality issues with severity "critical".
- summary.highPriorityTests: count of untested paths with priority "critical" or "high".
- summary.refactoringOpportunities: total number of refactoring suggestions.
- recommendations: 3-7 cross-file action items, most important first. Group related findings and list the files each affects.
- pullRequest: { owner: "${owner}", repo: "${repo}", number: ${prNumber} }
- metadata: set analyzedAt to "", duration to 0, agentVersions to {} — the application fills these in.

Return the final report as structured output matching the provided schema.`;
}
