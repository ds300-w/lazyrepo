import { spawnSync } from 'child_process'
import process from 'process'
import { Config } from '../config/config.js'
import { logger } from '../logger/logger.js'
import { run } from './run.js'

/**
 * @param {import('../types.js').CLIOption} options
 */
export async function inherit(options) {
  const scriptName = process.env.npm_lifecycle_event
  if (!scriptName) {
    logger.fail(
      'No npm_lifecycle_event found. Did you run `lazy inherit` directly instead of via "scripts"?',
    )
    process.exit(1)
  }
  const config = await Config.fromCwd(process.cwd())
  const workspace =
    process.cwd() === config.project.root.dir
      ? config.project.root
      : config.project.getWorkspaceByDir(process.cwd())

  const task = config.getTaskConfig(workspace, scriptName)
  if (!task.baseCommand) {
    logger.fail(
      `No baseCommand found for task '${scriptName}'. Using 'lazy inherit' requires you to add a baseCommand for the relevant task in your lazy.config file!`,
    )
    process.exit(1)
  }

  if (process.env.__LAZY_WORKFLOW__ === 'true') {
    const result = spawnSync(task.baseCommand, options['--'] ?? [], {
      stdio: 'inherit',
      shell: true,
    })
    process.exit(result.status ?? 1)
  } else {
    await run({ taskName: scriptName, options: { ...options, filter: [process.cwd()] } }, config)
  }
}
