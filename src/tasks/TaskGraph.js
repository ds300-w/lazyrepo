import micromatch from 'micromatch'
import { cpus } from 'os'
import { isAbsolute, join } from 'path'
import pc from 'picocolors'
import { logger } from '../logger/logger.js'
import { isTest } from '../utils/isTest.js'
import { uniq } from '../utils/uniq.js'
import { runTaskIfNeeded } from './runTaskIfNeeded.js'

/**
 * @typedef {Object} TaskKeyProps
 * @property {string} taskDir
 * @property {string} scriptName
 * @property {string} workspaceRoot
 */

const numCpus = cpus().length

const maxConcurrentTasks = process.env.__test__FORCE_PARALLEL
  ? 2
  : isTest
  ? 1
  : Math.max(1, numCpus - 1)

/**
 * @typedef {Object} TaskGraphProps
 *
 * @property {import('../config/config.js').Config} config
 * @property {import('../types.js').RequestedTask[]} requestedTasks
 */

export class TaskGraph {
  /**
   * @readonly
   * @type {import('../config/config.js').Config}
   */
  config
  /**
   * @readonly
   * @type {Record<string, import('../types.js').ScheduledTask>}
   */
  allTasks = {}
  /**
   * @readonly
   * @type {string[]}
   */
  sortedTaskKeys = []

  /**
   * @param {TaskGraphProps} arg
   */
  constructor({ config, requestedTasks }) {
    this.config = config

    /**
     * @param {string[]} path
     * @param {{ requestedTask: import('../types.js').RequestedTask, workspace: import('../project/project-types.js').Workspace }} arg
     * @returns
     */
    const visit = (path, { requestedTask, workspace }) => {
      const taskConfig = this.config.getTaskConfig(workspace, requestedTask.scriptName)
      const key = this.config.getTaskKey(workspace.dir, requestedTask.scriptName)
      if (this.allTasks[key]) {
        if (path.includes(key)) {
          logger.fail(`Circular dependency detected: \n${path.join('\n -> ')}\n -> ${pc.bold(key)}`)
        }
        return
      }
      path = [...path, key]
      this.allTasks[key] = {
        key,
        taskConfig: taskConfig,
        scriptName: requestedTask.scriptName,
        extraArgs: requestedTask.extraArgs,
        force: requestedTask.force,
        status: 'pending',
        outputFiles: [],
        dependencies: [],
        inputManifestCacheKey: null,
        workspace,
        logger: logger.task(key, config.isVerbose),
      }
      const result = this.allTasks[key]

      for (const [upstreamScriptName, upstreamScriptConfig] of taskConfig.runsAfterEntries) {
        /**
         * @type {string[]}
         */
        let filterPaths = []
        if (upstreamScriptConfig.in === 'self-and-dependencies') {
          filterPaths = [workspace.dir].concat(
            workspace.localDependencyWorkspaceNames.map(
              (dep) => this.config.project.getWorkspaceByName(dep).dir,
            ) ?? [],
          )
        } else if (upstreamScriptConfig.in === 'self-only') {
          filterPaths = [workspace.dir]
        }
        enqueueTask(
          path,
          {
            scriptName: upstreamScriptName,
            extraArgs: [],
            force: requestedTask.force,
            filterPaths,
          },
          result.dependencies,
        )
      }

      if (taskConfig.execution === 'dependent') {
        for (const workspaceName of workspace.localDependencyWorkspaceNames ?? []) {
          const dependency = this.config.project.getWorkspaceByName(workspaceName)
          if (dependency.scripts?.[requestedTask.scriptName]) {
            const depKey = this.config.getTaskKey(dependency.dir, requestedTask.scriptName)
            result.dependencies.push(depKey)
            visit(path, {
              requestedTask,
              workspace: dependency,
            })
          }
        }
      }

      this.sortedTaskKeys.push(key)
    }

    /**
     *
     * @param {string[]} path
     * @param {import('../types.js').RequestedTask} requestedTask
     * @param {string[]} [dependencies]
     * @returns
     */
    const enqueueTask = (path, requestedTask, dependencies) => {
      if (this.config.isTopLevelScript(requestedTask.scriptName)) {
        const key = this.config.getTaskKey(this.config.project.root.dir, requestedTask.scriptName)
        dependencies?.push(key)
        visit(path, {
          requestedTask,
          workspace: this.config.project.root,
        })
        return
      }

      const dirs = filterPackageDirs(
        this.config.project.root.dir,
        this.config.project,
        requestedTask.filterPaths,
      )

      for (const dir of dirs) {
        const workspace = this.config.project.getWorkspaceByDir(dir)
        if (workspace.scripts[requestedTask.scriptName]) {
          const key = this.config.getTaskKey(dir, requestedTask.scriptName)
          dependencies?.push(key)
          visit(path, {
            requestedTask,
            workspace: workspace,
          })
        }
      }
    }

    for (const requestedTask of requestedTasks) {
      enqueueTask([], requestedTask)
    }
  }

  /**
   * @param {string} key
   * @returns
   */
  isTaskReady(key) {
    const task = this.allTasks[key]
    return (
      task.status === 'pending' &&
      task.dependencies.every((dep) => this.allTasks[dep].status.startsWith('success'))
    )
  }

  allReadyTaskKeys() {
    const allReadyTaskKeys = this.sortedTaskKeys.filter((key) => this.isTaskReady(key))
    const unparallelizableScripts = new Set()
    // filter out duplicates for unparallelizable tasks
    return allReadyTaskKeys
      .filter((key) => {
        const { scriptName, taskConfig } = this.allTasks[key]

        if (taskConfig.parallel) return true

        if (unparallelizableScripts.has(scriptName)) {
          return false
        }

        unparallelizableScripts.add(scriptName)

        return true
      })
      .sort()
  }

  getTaskStats() {
    const stats = {
      pending: 0,
      running: 0,
      'success:lazy': 0,
      'success:eager': 0,
      successful: 0,
      failure: 0,
      allTasks: 0,
    }
    for (const key of this.sortedTaskKeys) {
      const status = this.allTasks[key].status
      if (status.startsWith('success')) {
        stats.successful++
      }
      stats[this.allTasks[key].status]++
      stats.allTasks++
    }
    return stats
  }

  allRunningTaskKeys() {
    return this.sortedTaskKeys.filter((key) => this.allTasks[key].status === 'running')
  }

  allFailedTaskKeys() {
    return this.sortedTaskKeys.filter((key) => this.allTasks[key].status === 'failure')
  }

  async runAllTasks() {
    /**
     * @type {(val: any) => any}
     */
    let resolve = () => {}
    const promise = new Promise((res) => {
      resolve = res
    })

    const tick = () => {
      const runningTasks = this.allRunningTaskKeys()
      const readyTasks = this.allReadyTaskKeys()

      if (runningTasks.length === 0 && readyTasks.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return resolve(null)
      }

      if (runningTasks.length >= maxConcurrentTasks) {
        // wait for tasks to finish before starting more
        return
      }

      if (readyTasks.length === 0) {
        // just wait for running tasks to finish
        return
      }

      // start as many tasks as we can
      const numTasksToStart = Math.min(maxConcurrentTasks - runningTasks.length, readyTasks.length)

      for (let i = 0; i < numTasksToStart; i++) {
        const taskKey = readyTasks[i]
        this.allTasks[taskKey].status = 'running'
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        runTask(readyTasks[i])
      }

      return true
    }
    /**
     * @param {string} taskKey
     */
    const runTask = async (taskKey) => {
      const { didRunTask, didSucceed } = await runTaskIfNeeded(this.allTasks[taskKey], this)
      this.allTasks[taskKey].status = didSucceed
        ? didRunTask
          ? 'success:eager'
          : 'success:lazy'
        : 'failure'
      tick()
    }

    tick()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return await promise
  }
}

/**
 * Match a list of filter path globs against the list of package directories.
 *
 * @param {string} workspaceRoot
 * @param {import('../project/Project.js').Project} project
 * @param {string[]} filterPaths
 */
function filterPackageDirs(workspaceRoot, project, filterPaths) {
  const allWorkspaceDirs = [...project.workspacesByDir.keys()]

  /** @type {Array<string> | null} */
  if (!filterPaths.length) {
    return allWorkspaceDirs
  }

  return uniq(
    filterPaths.flatMap((pattern) =>
      micromatch.match(
        allWorkspaceDirs,
        isAbsolute(pattern) ? pattern : join(workspaceRoot, pattern),
      ),
    ),
  )
}
