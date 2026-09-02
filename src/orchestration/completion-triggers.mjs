import { backgroundTasks } from '../core/background-tasks.mjs';
import { dispatch } from './dispatch.mjs';

/**
 * Wake-on-finish: a background job that declared on_complete fires a
 * TriggerEvent through dispatch() when it exits — so a finished build can
 * deterministically wake a verifier agent. Chain depth and cycle guards
 * apply like any other trigger; a job started BY that agent whose own
 * on_complete points back would be refused by the chain guard.
 *
 * buildCtx is called lazily at fire time so the dispatch context always
 * reflects the live tool executor / registry.
 */
export function registerJobCompletionDispatch(buildCtx) {
  return backgroundTasks.onExit((job) => {
    const target = job?.on_complete?.target;
    if (!target) return;
    const instruction = job.on_complete.instruction
      || `Background job ${job.id} (${job.name}) finished: ${job.status}`
        + (job.exit_code != null ? ` (exit ${job.exit_code})` : '')
        + `. Review the output and act on it:\n${String(job.tail || '').slice(-4000)}`;
    Promise.resolve()
      .then(() => dispatch({
        type: 'invoke',
        source: `job:${job.id}`,
        target,
        params: { instruction },
        channel: null,
        initiator: { chain: [`job:${job.id}`] },
      }, buildCtx()))
      .then((outcome) => {
        if (outcome && !outcome.dispatched) {
          process.stderr.write(`  on_complete for ${job.id} not dispatched: ${outcome.reason}\n`);
        }
      })
      .catch((err) => {
        process.stderr.write(`  on_complete for ${job.id} failed: ${err?.message || err}\n`);
      });
  });
}
