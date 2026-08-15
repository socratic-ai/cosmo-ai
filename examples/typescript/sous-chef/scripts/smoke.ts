/**
 * Build-time smoke check: no session, no network, no browser.
 *
 * It drives a whole cook through the store on a hand-cranked clock, then
 * constructs every tool — construction is where the backend's restricted
 * schema dialect is enforced, so a schema the server would reject fails here
 * rather than as a rejected tool at connect — and exercises the house rules
 * the PreToolUse guard applies.
 *
 * Run it with `npm run smoke`.
 */
import assert from 'node:assert/strict';

import type { BackgroundClientToolSpec, ClientToolJob, ClientToolSpec, RealtimeTool } from 'cosmo-ai';

import { sousChefAgent } from '../src/agent/agent';
import { guardDecision } from '../src/agent/guards';
import { makeClientTools } from '../src/agent/tools';
import { CookStore, scaleQuantity } from '../src/state/store';
import type { TimerOutcome } from '../src/state/types';

function storeSmoke(): void {
  const store = new CookStore();

  store.setRecipe({
    title: 'Test rigatoni',
    servings: 2,
    ingredients: [
      { name: 'rigatoni', quantity: '200 g', checked: false },
      { name: 'salt', quantity: 'a pinch', checked: false },
    ],
    steps: [
      { text: 'Boil water', minutes: 5 },
      { text: 'Cook pasta', minutes: 9, donenessCue: 'al dente, pale center gone' },
    ],
  });
  assert.equal(store.getState().recipe?.title, 'Test rigatoni');

  store.setStep(1);
  assert.equal(store.getState().stepIndex, 1);
  assert.throws(() => store.setStep(2), RangeError);
  assert.throws(() => store.setStep(-1), RangeError);

  assert.equal(store.checkIngredient('Rigatoni'), true);
  assert.equal(store.checkIngredient('saffron'), false);
  assert.equal(store.getState().recipe?.ingredients[0].checked, true);

  assert.equal(store.scaleServings(3), true);
  assert.equal(store.getState().recipe?.ingredients[0].quantity, '300 g');
  assert.equal(store.getState().recipe?.ingredients[1].quantity, 'a pinch');
  assert.equal(scaleQuantity('1/2 cup', 2), '1 cup');
  assert.equal(scaleQuantity('to taste', 4), 'to taste');

  const outcomes: TimerOutcome[] = [];
  assert.equal(
    store.startTimer('pasta', 9, (outcome) => outcomes.push(outcome)),
    null,
  );
  assert.match(String(store.startTimer('pasta', 5, () => undefined)), /already running/);
  store.tick(4);
  assert.equal(store.getState().timers[0].remainingSeconds, 5);
  store.tick(5);
  assert.deepEqual(outcomes, ['fired']);
  assert.equal(store.getState().alert, 'pasta');
  assert.equal(store.getState().timers.length, 0);
  store.clearAlert();
  assert.equal(store.getState().alert, null);

  assert.equal(
    store.startTimer('rest', 60, (outcome) => outcomes.push(outcome)),
    null,
  );
  assert.equal(store.cancelTimer('rest'), true);
  assert.equal(store.cancelTimer('rest'), false);
  assert.deepEqual(outcomes, ['fired', 'cancelled']);

  // Subscribers see every commit — this is what keeps the card in step with
  // the agent's own picture of the cook.
  let notified = 0;
  const unsubscribe = store.subscribe(() => (notified += 1));
  store.setStep(0);
  unsubscribe();
  store.setStep(1);
  assert.equal(notified, 1);

  // A new recipe is a new cook. A timer armed for the last one would fire for
  // food that is no longer on the card, so it settles as cancelled instead of
  // counting on into the new recipe.
  const stranded: TimerOutcome[] = [];
  store.startTimer('old pot', 300, (outcome) => stranded.push(outcome));
  store.setRecipe({
    title: 'Second cook',
    servings: 2,
    ingredients: [],
    steps: [{ text: 'Start again' }, { text: 'And again' }],
  });
  assert.equal(store.getState().timers.length, 0);
  assert.deepEqual(stranded, ['cancelled']);
  store.tick(600);
  assert.equal(store.getState().alert, null, 'a timer outlived the recipe it belonged to');

  // Servings is the divisor in every rescale, so the card cannot hold a count
  // you cannot divide by — without this, "200 g" rescales to "Infinity g".
  assert.throws(
    () => store.setRecipe({ title: 'Nothing', servings: 0, ingredients: [], steps: [] }),
    RangeError,
  );
  assert.equal(store.scaleServings(0), false);
  assert.equal(store.getState().recipe?.title, 'Second cook');

  // Ending a cook clears the card, and a timer left running with it — its
  // settle callback has no session to deliver to.
  let settledAfterReset = false;
  store.startTimer('leftover', 30, () => (settledAfterReset = true));
  store.reset();
  assert.equal(store.getState().recipe, null);
  assert.equal(store.getState().timers.length, 0);
  assert.equal(store.getState().stepIndex, 0);
  store.tick(60);
  assert.equal(settledAfterReset, false);

  console.log('smoke: store OK');
}

/** Every array-typed property in a JSON Schema, however deeply nested. */
function arraySchemas(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (typeof node !== 'object' || node === null) return found;
  if (Array.isArray(node)) {
    for (const item of node) arraySchemas(item, found);
    return found;
  }
  const object = node as Record<string, unknown>;
  if (object.type === 'array') found.push(object);
  for (const value of Object.values(object)) arraySchemas(value, found);
  return found;
}

function localTool(tools: RealtimeTool[], name: string): ClientToolSpec {
  const found = tools.find((entry) => entry.kind === 'client' && entry.name === name);
  assert.ok(found !== undefined && found.kind === 'client', `tool ${name} is missing`);
  assert.ok(found.background !== true, `tool ${name} is a background tool`);
  return found;
}

/** The background counterpart: its handler takes the job that answers later. */
function backgroundTool(tools: RealtimeTool[], name: string): BackgroundClientToolSpec {
  const found = tools.find((entry) => entry.kind === 'client' && entry.name === name);
  assert.ok(found !== undefined && found.kind === 'client', `tool ${name} is missing`);
  assert.ok(found.background === true, `tool ${name} is not a background tool`);
  return found;
}

async function toolsSmoke(): Promise<void> {
  const store = new CookStore();
  // Constructing the tools IS the schema test: `tool()` checks the emitted
  // JSON Schema against the backend's restricted dialect and throws here, so
  // a schema the server would reject never reaches a session.
  const tools = makeClientTools(store);
  assert.equal(tools.length, 6);

  // The dialect has no array bounds, so a Zod `.min()`/`.max()` on an array
  // would have thrown above. Assert the emitted shape too, because that
  // failure is the one worth naming.
  for (const spec of tools) {
    if (spec.kind !== 'client') continue;
    for (const array of arraySchemas(spec.parameters)) {
      assert.equal(array.minItems, undefined, `${spec.name} emits minItems`);
      assert.equal(array.maxItems, undefined, `${spec.name} emits maxItems`);
    }
  }

  const timer = tools.find((entry) => entry.kind === 'client' && entry.name === 'start_timer');
  assert.ok(timer !== undefined && timer.kind === 'client');
  assert.equal(timer.background, true, 'start_timer must stay a background tool');

  // Handlers run the same validation the model's calls go through.
  await localTool(tools, 'set_recipe').handler?.({
    title: 'Smoke stew',
    servings: 2,
    ingredients: [{ name: 'onion', quantity: '1' }],
    steps: [
      { text: 'Chop the onion' },
      { text: 'Fry it', minutes: 6, doneness_cue: 'golden at the edges' },
    ],
  });
  const recipe = store.getState().recipe;
  assert.equal(recipe?.title, 'Smoke stew');
  assert.equal(recipe?.ingredients[0].checked, false);
  assert.equal(recipe?.steps[1].donenessCue, 'golden at the edges');

  await localTool(tools, 'set_step').handler?.({ index: 1 });
  assert.equal(store.getState().stepIndex, 1);

  // Changing step reports what is still counting, so a timer for the step
  // just left cannot quietly outlive it.
  store.startTimer('noodles', 480, () => undefined);
  const moved = await localTool(tools, 'set_step').handler?.({ index: 0 });
  assert.deepEqual((moved as { running_timers: string[] }).running_timers, ['noodles']);
  store.cancelTimer('noodles');

  await localTool(tools, 'check_ingredient').handler?.({ name: 'ONION' });
  assert.equal(store.getState().recipe?.ingredients[0].checked, true);

  const missing = await localTool(tools, 'check_ingredient').handler?.({ name: 'saffron' });
  assert.equal((missing as { ok: boolean }).ok, false);

  await localTool(tools, 'scale_servings').handler?.({ servings: 4 });
  assert.equal(store.getState().recipe?.ingredients[0].quantity, '2');

  await assert.rejects(() => localTool(tools, 'set_step').handler?.({ index: 'two' }) ?? Promise.resolve());

  // Numeric bounds, unlike array ones, do survive the dialect — and `zodInput`
  // enforces them, so the servings floor stops a divide-by-zero at the door
  // rather than describing one.
  const servings = (
    localTool(tools, 'set_recipe').parameters as {
      properties: { servings: Record<string, unknown> };
    }
  ).properties.servings;
  assert.equal(servings.minimum, 1, 'set_recipe accepts a servings count of zero');
  await assert.rejects(
    () =>
      localTool(tools, 'set_recipe').handler?.({
        title: 'Divide by zero',
        servings: 0,
        ingredients: [{ name: 'flour', quantity: '200 g' }],
        steps: [{ text: 'Never happens' }],
      }) ?? Promise.resolve(),
  );
  await assert.rejects(
    () => localTool(tools, 'scale_servings').handler?.({ servings: 0 }) ?? Promise.resolve(),
  );

  console.log('smoke: tools OK');
}

function guardSmoke(): void {
  const store = new CookStore();
  const decide = (toolName: string, args: Record<string, unknown>) =>
    guardDecision(store, toolName, args);

  assert.equal(decide('set_step', { index: 0 })?.permission, 'deny');

  store.setRecipe({
    title: 'Guard test',
    servings: 1,
    ingredients: [],
    steps: [{ text: 'a' }, { text: 'b' }],
  });
  assert.equal(decide('set_step', { index: 1 }), undefined);
  assert.equal(decide('set_step', { index: 2 })?.permission, 'deny');
  assert.equal(decide('set_step', { index: -1 })?.permission, 'deny');

  assert.equal(decide('start_timer', { label: 'x', seconds: 3 })?.permission, 'deny');
  assert.equal(decide('start_timer', { label: 'x', seconds: 7201 })?.permission, 'deny');
  assert.equal(decide('start_timer', { label: 'x', seconds: 60 }), undefined);

  store.startTimer('x', 60, () => undefined);
  assert.equal(decide('start_timer', { label: 'x', seconds: 60 })?.permission, 'deny');
  assert.equal(decide('cancel_timer', { label: 'nope' })?.permission, 'deny');
  assert.equal(decide('cancel_timer', { label: 'x' }), undefined);

  // A denial has to say something the model can act on.
  const denial = decide('set_step', { index: 9 });
  assert.match(String(denial?.reason), /steps 0 to 1/);

  console.log('smoke: guard OK');
}

/** What the background timer says back to the agent, captured. */
type JobLog = {
  acked: string | null;
  completed: { result?: unknown; summary?: string } | null;
  failed: { error: string } | null;
};

function fakeJob(log: JobLog): ClientToolJob {
  return {
    ack: (note: string) => {
      log.acked = note;
    },
    complete: async (payload: { result?: unknown; summary?: string }) => {
      log.completed = payload;
    },
    fail: async (payload: { error: string }) => {
      log.failed = payload;
    },
  } as unknown as ClientToolJob;
}

/**
 * The timer is the one tool that answers twice: `ack` releases the reply so
 * the chef keeps talking, and `complete` arrives whenever the countdown ends.
 * Both halves are driven here on a hand-cranked clock, because a timer that
 * never delivers its second half looks exactly like a working one until the
 * moment it matters.
 */
async function timerSmoke(): Promise<void> {
  const store = new CookStore();
  const timer = backgroundTool(makeClientTools(store), 'start_timer');

  const log: JobLog = { acked: null, completed: null, failed: null };
  await timer.handler?.({ label: 'pasta', seconds: 11 }, fakeJob(log));

  // Acked immediately, and nothing delivered yet — the agent is free to talk.
  assert.match(String(log.acked), /pasta/);
  assert.equal(log.completed === null, true, 'delivered before it was started');
  assert.equal(store.getState().timers[0].remainingSeconds, 11);

  store.tick(10);
  assert.equal(log.completed === null, true, 'delivered before the countdown ended');

  store.tick(1);
  const delivered = log.completed;
  assert.ok(delivered !== null, 'the finished timer never reached the agent');
  assert.deepEqual(delivered.result, { label: 'pasta', outcome: 'fired' });
  assert.match(String(delivered.summary), /pasta/);
  assert.equal(store.getState().alert, 'pasta');
  assert.equal(store.getState().timers.length, 0);

  // A duplicate label fails instead of acking, so the agent hears the refusal
  // rather than waiting on a countdown that was never started.
  const first: JobLog = { acked: null, completed: null, failed: null };
  const dup: JobLog = { acked: null, completed: null, failed: null };
  await timer.handler?.({ label: 'sauce', seconds: 60 }, fakeJob(first));
  await timer.handler?.({ label: 'sauce', seconds: 60 }, fakeJob(dup));
  assert.equal(dup.acked === null, true, 'a rejected timer should not ack');
  assert.match(String(dup.failed?.error), /already running/);

  // Cancelling settles the job too — the agent is told, not left hanging.
  const cancelled: JobLog = { acked: null, completed: null, failed: null };
  await timer.handler?.({ label: 'rest', seconds: 300 }, fakeJob(cancelled));
  store.cancelTimer('rest');
  const settled = cancelled.completed;
  assert.ok(settled !== null, 'a cancelled timer never reached the agent');
  assert.deepEqual(settled.result, { label: 'rest', outcome: 'cancelled' });

  console.log('smoke: timer OK');
}

function agentSmoke(): void {
  const config = sousChefAgent(new CookStore());
  const kinds = (config.tools ?? []).map((entry) => entry.kind);
  for (const kind of ['web_search', 'examine_image', 'end_call']) {
    assert.ok(kinds.includes(kind as RealtimeTool['kind']), `missing server tool ${kind}`);
  }
  assert.equal(kinds.filter((kind) => kind === 'client').length, 6);

  const silence = (config.hooks ?? []).find((hook) => 'timeout_seconds' in hook);
  assert.ok(silence !== undefined, 'the silence check-in is not configured');

  // The provider is selected by ``model``; ``modelOptions`` only carries that
  // provider's knobs. They have to agree, or the session silently runs on the
  // workspace default instead of the one asked for.
  for (const provider of ['gemini', 'openai'] as const) {
    const forProvider = sousChefAgent(new CookStore(), provider);
    assert.equal(forProvider.model, provider);
    assert.equal(forProvider.modelOptions?.provider, provider);
  }

  console.log('smoke: agent OK');
}

storeSmoke();
await toolsSmoke();
await timerSmoke();
guardSmoke();
agentSmoke();
