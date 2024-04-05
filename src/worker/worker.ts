import v8 from 'node:v8'
import { register } from 'node:module'
import { nextTick } from 'node:process'
import { dirname } from 'pathe'
import { parseErrorStacktrace } from '@vitest/utils/source-map'
import type { BirpcReturn } from 'birpc'
import type { File, Reporter, TaskResultPack, UserConsoleLog, Vitest } from 'vitest'
import type { BirpcEvents, BirpcMethods } from '../api/rpc'
import { setupFilePath } from '../constants'
import { createWorkerRPC } from './rpc'
import type { WorkerMeta, WorkerRunnerOptions } from './types'

class VSCodeReporter implements Reporter {
  private rpc!: BirpcReturn<BirpcEvents, BirpcMethods>
  private ctx!: Vitest
  private id!: string

  get isCollecting(): boolean {
    return this.ctx.configOverride.testNamePattern?.toString() === '/$a/'
  }

  initVitest(ctx: Vitest, id: string) {
    this.ctx = ctx
    this.id = id
    ctx.config.setupFiles = [
      ...ctx.config.setupFiles || [],
      setupFilePath,
    ]
    ctx.projects.forEach((project) => {
      project.config.setupFiles = [
        ...project.config.setupFiles || [],
        setupFilePath,
      ]
    })
  }

  initRpc(rpc: BirpcReturn<BirpcEvents, BirpcMethods>) {
    this.rpc = rpc
  }

  onUserConsoleLog(log: UserConsoleLog) {
    this.rpc.onConsoleLog(this.id, log)
  }

  onTaskUpdate(packs: TaskResultPack[]) {
    packs.forEach(([taskId, result]) => {
      const project = this.ctx.getProjectByTaskId(taskId)

      result?.errors?.forEach((error) => {
        if (typeof error === 'object' && error) {
          error.stacks = parseErrorStacktrace(error, {
            getSourceMap: file => project.getBrowserSourceMapModuleById(file),
          })
        }
      })
    })

    this.rpc.onTaskUpdate(this.id, packs)
  }

  onFinished(files?: File[], errors?: unknown[]) {
    const collecting = this.isCollecting
    nextTick(() => {
      this.rpc.onFinished(this.id, files, errors, collecting)
    })
  }

  onCollected(files?: File[]) {
    this.rpc.onCollected(this.id, files, this.isCollecting)
  }

  onWatcherStart(files?: File[], errors?: unknown[]) {
    this.rpc.onWatcherStart(this.id, files, errors, this.isCollecting)
  }

  onWatcherRerun(files: string[], trigger?: string) {
    this.rpc.onWatcherRerun(this.id, files, trigger, this.isCollecting)
  }
}

async function initVitest(meta: WorkerMeta) {
  const vitestMode = await import(meta.vitestNodePath) as typeof import('vitest/node')
  const reporter = new VSCodeReporter()
  const vitest = await vitestMode.createVitest(
    'test',
    {
      config: meta.configFile,
      workspace: meta.workspaceFile,
      watch: true,
      api: false,
      root: dirname(meta.id),
      reporters: [reporter],
      ui: false,
      includeTaskLocation: true,
    },
    {
      server: {
        middlewareMode: true,
      },
      plugins: [
        {
          name: 'vitest:vscode-extension',
          configResolved(config) {
            // stub a server so Vite doesn't start a websocket connection,
            // because we don't need it in the extension and it messes up Vite dev command
            config.server.hmr = {
              server: {
                on: () => {},
                off: () => {},
              } as any,
            }
            if (!config.server.fs.allow.includes(setupFilePath))
              config.server.fs.allow.push(setupFilePath)
          },
        },
      ],
    },
  )
  reporter.initVitest(vitest, meta.id)
  return {
    vitest,
    reporter,
    meta,
  }
}

const cwd = process.cwd()

process.on('message', async function init(message: any) {
  if (message.type === 'init') {
    process.off('message', init)
    const data = message as WorkerRunnerOptions

    try {
      if (data.loader)
        register(data.loader)
      const errors = []

      const vitest = []
      for (const meta of data.meta) {
        process.chdir(dirname(meta.id))
        try {
          vitest.push(await initVitest(meta))
        }
        catch (err: any) {
          errors.push([meta.id, err.stack])
        }
      }
      process.chdir(cwd)

      if (!vitest.length) {
        process.send!({ type: 'error', errors })
        return
      }

      const vitestById = Object.fromEntries(vitest.map(v => [v.meta.id, v.vitest]))
      const rpc = createWorkerRPC(vitestById, {
        on(listener) {
          process.on('message', listener)
        },
        post(message) {
          process.send!(message)
        },
        serialize: v8.serialize,
        deserialize: v => v8.deserialize(Buffer.from(v)),
      })
      vitest.forEach(v => v.reporter.initRpc(rpc))
      process.send!({ type: 'ready', errors })
    }
    catch (err: any) {
      error(err)
    }
  }
})

function error(err: any) {
  process.send!({
    type: 'error',
    errors: ['', String(err.stack)],
  })
}

function _debug(...args: any[]) {
  process.send!({
    type: 'debug',
    args,
  })
}
