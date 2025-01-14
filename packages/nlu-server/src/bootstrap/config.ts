import bytes from 'bytes'
import fse from 'fs-extra'
import { getAppDataPath } from '../app-data'

interface LanguageSource {
  endpoint: string
  authToken?: string
}

interface BaseOptions {
  host: string
  port: number
  limitWindow: string
  limit: number
  bodySize: string
  batchSize: number
  modelCacheSize: string
  dbURL?: string
  modelDir: string
  verbose: number
  doc: boolean
  logFilter?: string[]
  apmEnabled?: boolean
  apmSampleRate?: number
  maxTraining: number
}

export type CommandLineOptions = Partial<BaseOptions> & {
  languageURL: string
  languageAuthToken?: string
  ducklingURL: string
  ducklingEnabled: boolean
  config?: string
}

export type NLUServerOptions = BaseOptions & {
  languageSources: LanguageSource[] // when passed by env variable, there can be more than one lang server
  ducklingURL: string
  ducklingEnabled: boolean
  legacyElection: boolean // not available from CLI
  ignoreSync?: boolean
}

const DEFAULT_OPTIONS = (): NLUServerOptions => ({
  host: 'localhost',
  port: 3200,
  limit: 0,
  limitWindow: '1h',
  bodySize: '2mb',
  batchSize: 1,
  languageSources: [{ endpoint: 'https://lang-01.botpress.io' }],
  ducklingURL: 'https://duckling.botpress.io',
  ducklingEnabled: true,
  modelCacheSize: '2.5gb',
  verbose: 3,
  doc: false,
  logFilter: undefined,
  legacyElection: false,
  modelDir: getAppDataPath(),
  maxTraining: 2,
  ignoreSync: false
})

export type ConfigSource = 'environment' | 'cli' | 'file'

const _mapCli = (c: CommandLineOptions): Partial<NLUServerOptions> => {
  const { ducklingEnabled, ducklingURL, languageURL, languageAuthToken } = c
  return {
    ...c,
    languageSources: [
      {
        endpoint: languageURL,
        authToken: languageAuthToken
      }
    ],
    ducklingEnabled,
    ducklingURL,
    legacyElection: false
  }
}

const readEnvJSONConfig = (): NLUServerOptions | null => {
  const rawContent = process.env.NLU_SERVER_CONFIG
  if (!rawContent) {
    return null
  }
  try {
    const parsedContent = JSON.parse(rawContent)
    const defaults = DEFAULT_OPTIONS()
    return { ...defaults, ...parsedContent }
  } catch {
    return null
  }
}

const readFileConfig = async (configPath: string): Promise<NLUServerOptions> => {
  try {
    const rawContent = await fse.readFile(configPath, 'utf8')
    const parsedContent = JSON.parse(rawContent)
    const defaults = DEFAULT_OPTIONS()
    return { ...defaults, ...parsedContent }
  } catch (err) {
    const e = new Error(`The following errored occured when reading config file "${configPath}": ${err.message}`)
    e.stack = err.stack
    throw e
  }
}

export const getConfig = async (
  c: CommandLineOptions
): Promise<{ options: NLUServerOptions; source: ConfigSource }> => {
  const envConfig = readEnvJSONConfig()
  if (envConfig) {
    return { options: envConfig, source: 'environment' }
  }

  if (c.config) {
    const options = await readFileConfig(c.config)
    return { options, source: 'file' }
  }

  const cliOptions = _mapCli(c)
  const defaults = DEFAULT_OPTIONS()
  const options: NLUServerOptions = { ...defaults, ...cliOptions }
  return { options, source: 'cli' }
}

export const validateConfig = (options: NLUServerOptions) => {
  if (!bytes(options.bodySize)) {
    throw new Error(`Specified body-size "${options.bodySize}" has an invalid format.`)
  }
}
