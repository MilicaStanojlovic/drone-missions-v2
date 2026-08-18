export const meta = {
  name: 'migrate-phase',
  description: 'Run one migration phase: plan it into a task checklist, implement task-by-task, review for behavior parity, test, with up to 2 fix retries',
  whenToUse: 'Run once per phase of the drone-missions v2 migration with args {phaseSlug, phaseTitle, phaseSpec, doneWhen}. phaseSpec is the full text of that phase\'s section from MIGRATION_PLAN.md. Returns {status: "passed"|"blocked", planFile, review, test}.',
  phases: [
    { title: 'Plan' },
    { title: 'Implement' },
    { title: 'Review' },
    { title: 'Test' },
    { title: 'Fix' },
  ],
}

const TARGET = '/workspace/drone-missionsv2'
const BACKEND = '/workspace/drone-missions-backend/drone-missions'
const FRONTEND = '/workspace/drone-missions-frontend/drone-missions-frontend'

const TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  required: ['tasks'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    report: { type: 'string' },
  },
  required: ['green', 'report'],
}

if (!args || typeof args !== 'object' || !args.phaseSlug || !args.phaseSpec) {
  throw new Error('migrate-phase needs args {phaseSlug, phaseTitle, phaseSpec, doneWhen}')
}
const { phaseSlug, phaseTitle, phaseSpec, doneWhen } = args
const planFile = `${TARGET}/plans/PLAN-${phaseSlug}.md`
log(`Phase: ${phaseTitle || phaseSlug} — plan file: ${planFile}`)

const repoContext = [
  `Target repo (read+write): ${TARGET}`,
  `Spring backend ground truth (READ ONLY): ${BACKEND}`,
  `Angular frontend ground truth (READ ONLY): ${FRONTEND}`,
  `Full migration plan: ${TARGET}/MIGRATION_PLAN.md`,
].join('\n')



// Custom agentTypes from .claude/agents/ are not in this session's registry (created after
// session start), so each subagent instead reads its role file and adopts it.
const role = (name) => `First, Read ${TARGET}/.claude/agents/${name}.md and adopt the entire body as your role instructions for this task (ignore the frontmatter's tools/model fields — they are for a different invocation path). Follow that role exactly, including its read-only rules on the source repos.`

// agent() resolves to null if the subagent dies on a terminal API error (e.g. 529 Overloaded).
// Re-attempt transient failures instead of crashing the whole phase run.
async function runAgent(prompt, opts) {
  for (let i = 1; i <= 3; i++) {
    const result = await agent(prompt, i === 1 ? opts : { ...opts, label: `${opts.label || 'agent'}~retry${i - 1}` })
    if (result !== null && result !== undefined) return result
    log(`Agent ${opts.label || ''} returned null (attempt ${i}/3)${i < 3 ? ' — retrying' : ''}.`)
  }
  throw new Error(`Agent ${opts.label || ''} failed after 3 attempts`)
}

// ---- Plan ----
phase('Plan')
const plan = await runAgent(
  `You are planning ONE phase of the drone-missions v2 migration (Spring Boot + Angular -> unified Next.js 15 / React 19 / TypeScript / Drizzle / Supabase Postgres). You never write implementation code; produce only a task checklist.

${repoContext}

Phase to plan: ${phaseTitle || phaseSlug}
Phase spec (from MIGRATION_PLAN.md — the map; the source repos are the ground truth):
---
${phaseSpec}
---

Procedure:
1. Read ${TARGET}/MIGRATION_PLAN.md sections 2-6 for stack, structure, and migration discipline.
2. Explore the SOURCE repos (Grep/Glob/Read) to find the concrete Spring classes (controller/service/DAO/entity/validators/tests) and Angular components/services this phase ports.
3. Look at what already exists in ${TARGET}/src to build on ported patterns, not duplicate them.

Write the plan file at exactly ${planFile} (overwrite if it exists) in this format:

# ${phaseTitle || phaseSlug}

- [ ] <task 1>
- [ ] <task 2>

Rules:
- Migrate by FUNCTIONALITY, not by file: each task is one capability (one endpoint + its service/query logic, one Zod schema, one UI page/component, one test suite) — never "convert file X" and never "implement the whole phase".
- Each task small enough for one implementer pass; order tasks so the build stays compilable (schema/queries before service, service before route, route before UI, tests alongside or right after the behavior they cover).
- Name the concrete SOURCE files (absolute paths) each task ports from, and the TARGET files it creates/changes.
- Include the phase's test tasks (Vitest suites mirroring the source's JUnit cases, plus the phase's Playwright happy-path) — tests are part of the phase, not optional.
- Keep it tight: prefer 4-10 tasks.

Then return the same list as structured output.`,
  { schema: TASKS_SCHEMA, phase: 'Plan', label: `plan:${phaseSlug}` }
)
log(`Planned ${plan.tasks.length} task(s).`)

// ---- Implement ----
phase('Implement')
for (const task of plan.tasks) {
  await runAgent(
    `${role('implementer')}

Implement the next unchecked task in ${planFile} (expected to be: "${task.title}"). Check it off in that file when done.`,
    { model: 'sonnet', phase: 'Implement', label: task.title } // TEMP: sonnet while opus is overloaded (529s) — revert to opus when it recovers
  )
}

// ---- Review / Test with fix retries ----
const MAX_RETRIES = 2
let review = null
let test = null
let attempt = 0

while (true) {
  review = await runAgent(
    `${role('reviewer')}

Review the cumulative work of migration phase "${phaseTitle || phaseSlug}" in ${TARGET} (git diff develop...HEAD, plus untracked files; if develop does not exist yet, review the whole tree). The phase's plan/checklist is ${planFile}; its spec is in MIGRATION_PLAN.md. Compare ported behavior against the ORIGINAL source in ${BACKEND} and ${FRONTEND}. Return structured output: green=true only if your verdict is merge-ready, and put your full findings report (or "merge-ready" summary) in report.`,
    { model: 'opus', phase: attempt === 0 ? 'Review' : 'Fix', label: `review#${attempt + 1}`, schema: VERDICT_SCHEMA }
  )

  test = await runAgent(
    `${role('tester')}

Verify migration phase "${phaseTitle || phaseSlug}" in ${TARGET}. The phase's "Done when" criteria: ${doneWhen || 'see the phase section in MIGRATION_PLAN.md'}. Its checklist is ${planFile}. Return structured output: green=true only if your verdict is all-green (environment-caused skips allowed but must be listed in report), and put the full per-check report in report.`,
    { model: 'sonnet', phase: attempt === 0 ? 'Test' : 'Fix', label: `test#${attempt + 1}`, schema: VERDICT_SCHEMA }
  )

  if (review.green && test.green) {
    return { status: 'passed', planFile, tasks: plan.tasks, review: review.report, test: test.report, attempts: attempt + 1 }
  }

  if (attempt >= MAX_RETRIES) {
    log(`Still not green after ${MAX_RETRIES} fix retries — returning blocked.`)
    return { status: 'blocked', planFile, tasks: plan.tasks, review: review.report, test: test.report, attempts: attempt + 1 }
  }

  attempt += 1
  phase('Fix')
  log(`Review green: ${review.green}, test green: ${test.green} — fix pass ${attempt}/${MAX_RETRIES}.`)
  await runAgent(
    `${role('implementer')}

Fix pass ${attempt} for migration phase "${phaseTitle || phaseSlug}". Do NOT pick a task from the plan file this time — instead, address every blocking and needs-changes finding below, in ${TARGET} only. Read the actual findings carefully and fix root causes, keeping all repo conventions (MIGRATION_PLAN.md) intact.

REVIEWER FINDINGS:
${review.report}

TESTER REPORT:
${test.report}`,
    { model: 'sonnet', phase: 'Fix', label: `fix#${attempt}` } // TEMP: sonnet while opus is overloaded — revert to opus when it recovers
  )
}
