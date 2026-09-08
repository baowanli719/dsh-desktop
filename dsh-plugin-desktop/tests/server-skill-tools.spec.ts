import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GsRequest } from '../src/server/gs-client.ts'
import type { GsServerService } from '../src/server/gs-server-service.ts'
import { createGsServerSkillCatalog } from '../src/server-skill-provider.ts'
import * as toolsPlugin from '../src/server-skill-tools.ts'

const ENDPOINT = 'http://127.0.0.1:18300/gsclaw'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

interface RecordedCall {
  readonly url: string
  readonly init: RequestInit
}

interface ToolsHarness {
  readonly ctx: Context
  readonly catalog: ReturnType<typeof createGsServerSkillCatalog>
  readonly registered: Map<string, ToolDefinition>
  readonly calls: RecordedCall[]
  readonly invalidate: ReturnType<typeof vi.fn<() => void>>
  run(name: string, args: Record<string, unknown>): Promise<unknown>
}

async function setup(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): Promise<ToolsHarness> {
  const ctx = new Context()
  const registered = new Map<string, ToolDefinition>()
  const calls: RecordedCall[] = []
  const catalog = createGsServerSkillCatalog()
  const invalidate = vi.fn<() => void>()
  catalog.bindInvalidate(invalidate)
  const request: GsRequest = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }
  ctx.provide('tools', {
    register: vi.fn((definition: ToolDefinition) => {
      if (registered.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`)
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    }),
  } as never)
  ctx.provide('gsServer', {
    endpoints: { resolve: () => ENDPOINT },
    auth: { accessToken: () => 'access-1', refreshAccessToken: async () => 'refreshed-1' },
  } as unknown as GsServerService)
  ctx.provide('gsServerSkillCatalog', catalog)
  const plugin = await ctx.plugin(toolsPlugin, { request })
  disposals.push(async () => { await plugin.dispose() })
  return {
    ctx,
    catalog,
    registered,
    calls,
    invalidate,
    async run(name, args) {
      const definition = registered.get(name)
      if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
      const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
      return definition.execute(args, exec)
    },
  }
}

function publishDataQuery(catalog: ReturnType<typeof createGsServerSkillCatalog>): void {
  catalog.update({
    supported: true,
    types: ['data-query'],
    remotes: [{ name: 'customer-analysis', runtimeType: 'data-query', definitionRevision: 'rev-1' }],
  })
}

function okExecution(): Response {
  return Response.json({
    requestId: 'req-1',
    traceId: 'trace-1',
    status: 'ok',
    content: [{ type: 'text', text: '12 new customers' }],
    truncated: false,
  })
}

describe('server-skill-tools visibility', () => {
  it('stays hidden while the server lacks the capability or the catalog has no matching skill', async () => {
    const harness = await setup(() => okExecution())
    expect(harness.registered.size).toBe(0)

    // Capability present but no available skill of the type.
    harness.catalog.update({ supported: true, types: ['data-query'], remotes: [] })
    expect(harness.registered.size).toBe(0)

    // A skill of an unadvertised type does not expose the tool either.
    harness.catalog.update({
      supported: true,
      types: ['server-mcp'],
      remotes: [{ name: 'customer-analysis', runtimeType: 'data-query', definitionRevision: 'rev-1' }],
    })
    expect(harness.registered.size).toBe(0)
  })

  it('registers and unregisters each tool as the effective catalog changes', async () => {
    const harness = await setup(() => okExecution())

    publishDataQuery(harness.catalog)
    expect([...harness.registered.keys()]).toEqual([toolsPlugin.RUN_DATA_QUERY_TOOL])

    harness.catalog.update({
      supported: true,
      types: ['data-query', 'server-mcp'],
      remotes: [
        { name: 'customer-analysis', runtimeType: 'data-query', definitionRevision: 'rev-1' },
        { name: 'crm-lookup', runtimeType: 'server-mcp', definitionRevision: 'rev-9' },
      ],
    })
    expect([...harness.registered.keys()].sort()).toEqual(
      [toolsPlugin.RUN_DATA_QUERY_TOOL, toolsPlugin.RUN_MCP_SKILL_TOOL].sort(),
    )

    harness.catalog.update({ supported: false, types: [], remotes: [] })
    expect(harness.registered.size).toBe(0)
  })

  it('survives a same-name registration conflict with a warning instead of a crash', async () => {
    const harness = await setup(() => okExecution())
    // Another layer already owns the name: the bridge stays hidden and the
    // host keeps running; the next catalog change retries the registration.
    harness.registered.set(toolsPlugin.RUN_DATA_QUERY_TOOL, { name: toolsPlugin.RUN_DATA_QUERY_TOOL } as ToolDefinition)

    publishDataQuery(harness.catalog)
    expect(harness.registered.get(toolsPlugin.RUN_DATA_QUERY_TOOL)).toEqual({ name: toolsPlugin.RUN_DATA_QUERY_TOOL })

    harness.registered.delete(toolsPlugin.RUN_DATA_QUERY_TOOL)
    publishDataQuery(harness.catalog)
    expect(typeof harness.registered.get(toolsPlugin.RUN_DATA_QUERY_TOOL)?.execute).toBe('function')
  })
})

describe('server-skill-tools execution', () => {
  it('forwards a data-query call to the execute endpoint with the catalog revision', async () => {
    const harness = await setup(() => okExecution())
    publishDataQuery(harness.catalog)

    const value = await harness.run(toolsPlugin.RUN_DATA_QUERY_TOOL, {
      skill: 'customer-analysis',
      query: 'customer_summary',
      params: { start_date: '2026-08-01' },
    }) as Record<string, unknown>

    expect(value).toEqual(expect.objectContaining({ text: '12 new customers', truncated: false, traceId: 'trace-1' }))
    const call = harness.calls[0]!
    expect(call.url).toBe(`${ENDPOINT}/api/v1/skills/customer-analysis/execute`)
    expect(call.init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer access-1' }))
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    expect(body).toEqual(expect.objectContaining({
      definitionRevision: 'rev-1',
      arguments: { query: 'customer_summary', params: { start_date: '2026-08-01' } },
    }))
    expect(typeof body.requestId).toBe('string')
  })

  it('forwards an MCP call with tool and arguments', async () => {
    const harness = await setup(() => okExecution())
    harness.catalog.update({
      supported: true,
      types: ['server-mcp'],
      remotes: [{ name: 'crm-lookup', runtimeType: 'server-mcp', definitionRevision: 'rev-9' }],
    })

    await harness.run(toolsPlugin.RUN_MCP_SKILL_TOOL, {
      skill: 'crm-lookup',
      tool: 'find_customer',
      arguments: { id: 7 },
    })

    const body = JSON.parse(String(harness.calls[0]!.init.body as string)) as Record<string, unknown>
    expect(body).toEqual(expect.objectContaining({
      definitionRevision: 'rev-9',
      arguments: { tool: 'find_customer', arguments: { id: 7 } },
    }))
  })

  it('rejects a skill outside the current catalog of that runtime type', async () => {
    const harness = await setup(() => okExecution())
    publishDataQuery(harness.catalog)

    await expect(harness.run(toolsPlugin.RUN_DATA_QUERY_TOOL, { skill: 'ghost', query: 'q' }))
      .rejects.toThrow('not an available data-query skill')
    // A server-mcp skill does not satisfy the data-query tool.
    harness.catalog.update({
      supported: true,
      types: ['data-query', 'server-mcp'],
      remotes: [{ name: 'crm-lookup', runtimeType: 'server-mcp', definitionRevision: 'rev-9' }],
    })
    await expect(harness.run(toolsPlugin.RUN_DATA_QUERY_TOOL, { skill: 'crm-lookup', tool: 'x' } as never))
      .rejects.toThrow()
    expect(harness.calls).toHaveLength(0)
  })

  it('turns server business failures into model-facing errors, never empty success', async () => {
    const harness = await setup(() => Response.json({
      requestId: 'req-1',
      traceId: 'trace-2',
      status: 'error',
      error: { code: 'execution_failed', message: 'data source offline' },
    }))
    publishDataQuery(harness.catalog)

    await expect(harness.run(toolsPlugin.RUN_DATA_QUERY_TOOL, { skill: 'customer-analysis', query: 'q' }))
      .rejects.toThrow('execution_failed')
  })

  it('invalidates the catalog on definition_changed and asks the model to reconstruct the call', async () => {
    const harness = await setup(() => Response.json(
      { code: 'definition_changed', message: 'definition moved', traceId: 'trace-3', definitionRevision: 'rev-2' },
      { status: 409 },
    ))
    publishDataQuery(harness.catalog)

    await expect(harness.run(toolsPlugin.RUN_DATA_QUERY_TOOL, { skill: 'customer-analysis', query: 'q' }))
      .rejects.toThrow('definition changed')
    expect(harness.invalidate).toHaveBeenCalledTimes(1)
  })
})
