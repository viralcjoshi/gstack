/**
 * plan-ceo-review plan-mode smoke (gate, paid, real-PTY).
 *
 * Asserts: when /plan-ceo-review is invoked in plan mode, the FIRST terminal
 * outcome is 'asked' — a skill-question numbered list. Permission dialogs
 * (which also render numbered lists) are filtered out by `runPlanSkillObservation`
 * via its `isPermissionDialogVisible(visible.slice(-1500))` short-circuit.
 *
 * Reaching 'plan_ready' first IS the regression we want to catch: the agent
 * skipped Step 0 entirely and went straight to ExitPlanMode. The original
 * failure had the assistant read a diff, write a plan with two issues, and
 * call ExitPlanMode without ever firing AskUserQuestion — the user had to
 * manually call out the missing per-issue questions.
 *
 * Why this skill is special: unlike plan-eng-review / plan-design-review /
 * plan-devex-review (whose smokes accept either 'asked' or 'plan_ready'),
 * plan-ceo-review's template mandates Step 0A premise challenge (3 baked-in
 * questions) AND Step 0F mode selection BEFORE any plan write. There is no
 * legitimate path to plan_ready that does not first emit a skill-question
 * numbered prompt.
 *
 * Env passthrough: passes `QUESTION_TUNING=false` and `EXPLAIN_LEVEL=default`
 * via the runner's env option. Today these are advisory — `gstack-config`
 * reads `~/.gstack/config.yaml`, not env vars, so a contributor with
 * `question_tuning: true` set in their YAML config can still see AUTO_DECIDE
 * masking. The env passthrough is wired so a future gstack-config change to
 * honor env overrides will make this test hermetic without further edits.
 * Tracked as a post-merge follow-up.
 *
 * FAIL conditions: 'plan_ready' first, silent Write/Edit before any prompt,
 * claude crash, timeout.
 *
 * See test/helpers/claude-pty-runner.ts for runner internals.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanSkillObservation,
  planFileHasDecisionsSection,
  assertReportAtBottomIfPlanWritten,
  isProseAUQVisible,
} from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

// Concrete plan to review. Used by the --disallowedTools test to skip
// the "what should I review?" deliberation that otherwise eats the
// model's budget. Has CEO-review-shaped issues (premise gap, vague
// success metric, scope-creep smell) so Step 0 has real material.
const SEED_PLAN_FOR_CEO_REVIEW = `
# Plan: Launch a "developer-friendly" pricing tier

## Goal
Increase developer adoption.

## Success metric
More signups.

## Premise
We haven't talked to any developers about whether the current pricing
is actually a barrier. The team agreed it "feels like" it should be
cheaper. No data yet on what dev users would pay for or what the unit
economics would look like at the new price point.

## Plan
- Pick a 30% discount as the developer tier
- Add an email field to /pricing for "verify with @company.com"
- Auto-enroll anyone with @gmail/@hotmail addresses too as a pilot
- Ship next week
`.trim();

describeE2E('plan-ceo-review plan-mode smoke (gate)', () => {
  test('first terminal outcome is asked (Step 0 fires before any plan write)', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'plan-ceo-review',
      inPlanMode: true,
      timeoutMs: 300_000,
      env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    });

    if (obs.outcome !== 'asked') {
      const diagnosis =
        obs.outcome === 'plan_ready'
          ? `'plan_ready' first means the agent skipped Step 0 entirely and went straight to ExitPlanMode without asking.`
          : obs.outcome === 'timeout'
            ? `Timeout means the agent neither asked nor completed within the budget — likely hung mid-question or stuck on a permission dialog.`
            : obs.outcome === 'silent_write'
              ? `Silent Write/Edit fired to an unsanctioned path before any AskUserQuestion — also a Step 0 skip.`
              : `Outcome '${obs.outcome}' is unexpected; investigate the evidence below.`;
      throw new Error(
        `plan-ceo-review smoke FAILED: outcome=${obs.outcome}\n` +
          `${diagnosis}\n` +
          `Expected 'asked'. See plan-ceo-review/SKILL.md.tmpl: the Step 0 STOP rules ` +
          `and the "One issue = one AskUserQuestion call" rule under "CRITICAL RULE — ` +
          `How to ask questions".\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    assertReportAtBottomIfPlanWritten(obs);
  }, 360_000);

  // v1.21+ regression: Conductor launches Claude Code with
  // `--disallowedTools AskUserQuestion --permission-mode default` (verified
  // via `ps` on the live Conductor claude process). Native AskUserQuestion
  // is removed from the model's tool registry; without fallback guidance
  // the model can't ask and silently proceeds.
  //
  // After v1.28+ (forever-war fix), the preamble fallback that wrote a
  // "## Decisions to confirm" section was deleted in favor of a hard
  // BLOCKED rule. The pass envelope under --disallowedTools accepts:
  //   - 'asked'      — model emits a numbered-option prompt as prose
  //   - 'plan_ready' WITH (## Decisions section [legacy]
  //                  OR BLOCKED string visible [post-fix])
  //   - 'exited'     WITH BLOCKED string visible [post-fix]
  //
  // The legacy `## Decisions` path stays in the envelope so this test
  // keeps passing during the migration window when the fallback delete
  // and resolver edits land in the same PR but mid-rebase states are
  // possible. Once the deletion has been on main long enough that the
  // generated SKILL.md cache has flushed, the legacy branch can be
  // removed in a follow-up.
  //
  // Failure signals (regression we DO want to catch):
  //   - 'auto_decided' — AUTO_DECIDE preamble fired without /plan-tune opt-in
  //   - 'silent_write' — Write/Edit before any AUQ surface
  //   - 'timeout'      — neither asked nor terminated in budget
  //   - 'plan_ready' or 'exited' WITHOUT either Decisions section or BLOCKED
  test('AskUserQuestion surfaces when --disallowedTools AskUserQuestion is set', async () => {
    // Pre-prime with concrete plan content so the model doesn't burn its
    // budget deliberating about WHICH artifact to review. Without this seed,
    // a bare /plan-ceo-review under --disallowedTools puts the model in a
    // 5-minute thinking loop trying to enumerate scope options before
    // surfacing them as prose. With the seed, the model has a real plan to
    // critique and can move directly to Step 0 / Section 1 findings.
    //
    // The test still exercises the regression we care about: under
    // --disallowedTools, does the skill SURFACE its first decision question
    // (via prose, BLOCKED, or some visible surface) rather than silently
    // ExitPlanMode-ing?
    const obs = await runPlanSkillObservation({
      skillName: 'plan-ceo-review',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'AskUserQuestion'],
      initialPlanContent: SEED_PLAN_FOR_CEO_REVIEW,
      timeoutMs: 300_000,
    });

    // The user must SEE the question one way or another. Three valid surfaces:
    //   1. `## Decisions to confirm` section in the plan file (legacy fallback)
    //   2. `BLOCKED — AskUserQuestion` string visible in TTY (post-v1.28 BLOCKED rule)
    //   3. Numbered/lettered options visible in TTY as prose (post-v1.28 prose-AUQ rendering)
    const blockedVisible = /BLOCKED\s*[—-]\s*AskUserQuestion/i.test(obs.evidence);
    const proseAUQVisible = isProseAUQVisible(obs.evidence) || obs.proseAUQEverObserved === true;
    const surfaceVisible = blockedVisible || proseAUQVisible || obs.waitingEverObserved === true;

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `plan-ceo-review AskUserQuestion-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'exited' && !surfaceVisible) {
      throw new Error(
        `plan-ceo-review AskUserQuestion-blocked regression: outcome=exited without any visible question surface (no BLOCKED string, no prose-rendered AUQ options). Model quit silently.\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'plan_ready') {
      if (!obs.planFile) {
        if (!surfaceVisible) {
          throw new Error(
            `plan-ceo-review AskUserQuestion-blocked regression: outcome=plan_ready but no plan file path detected, no BLOCKED string, no prose AUQ options. Cannot verify the model used any legitimate path.\n` +
              `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
          );
        }
      } else if (!planFileHasDecisionsSection(obs.planFile) && !surfaceVisible) {
        throw new Error(
          `plan-ceo-review AskUserQuestion-blocked regression: model wrote ${obs.planFile} without a "## Decisions" section AND no BLOCKED string AND no prose AUQ options in TTY. Step 0 was silently skipped.\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
    }
    expect(['asked', 'plan_ready', 'exited']).toContain(obs.outcome);
    // NOTE: assertReportAtBottomIfPlanWritten is intentionally NOT called
    // here. This test runs --disallowedTools AskUserQuestion and only
    // checks "did the question surface" — the model can't run the full
    // multi-section review without AUQ tools, so no review report exists
    // to enforce the at-bottom contract against. The contract is
    // exercised by the periodic finding-count tests, which DO run the
    // full review.
  }, 360_000);
});
