import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  // The Agent owns its model: a selection is recorded on the Session, and the step's route follows it.
  const agent = { ctx, session, model: { current: () => undefined as ModelSelection | undefined,
    select: (selection: ModelSelection) => { session.append('model/selection', selection) } } } as unknown as Agent
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const selections = () => agent.session.snapshotEvents().filter(event => event.type === 'model/selection')
  return { ctx, agent, resolve, flush, request, selections }
}
it('records the role model as the Agent selection without saving the host default', async () => {
  const { agent, resolve, flush, selections } = await fixture()
  await initializeRoleModel(agent.ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect(resolve).toHaveBeenCalledOnce()
  expect(selections()).toHaveLength(1)
  expect(selections()[0]).toMatchObject({ data: { provider: 'worker-provider', model: 'worker-model' } })
  expect(flush).toHaveBeenCalledOnce()
})
it('leaves the request route of the prepared step to the Agent', async () => {
  const { ctx, agent, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  // The step fixes the route from the Agent's selection; a request-time override may no longer change it.
  expect(await request()).toEqual({ provider: 'seed', model: 'seed' })
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve, selections } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  // The role model is not seeded: a resumed Session keeps the route it already has.
  expect(selections()).toHaveLength(kind === 'header' ? 0 : 1)
})
it('records nothing without a role model and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, flush, selections } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(selections()).toHaveLength(0)
  expect(flush).not.toHaveBeenCalled()
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(selections()).toHaveLength(0)
})
