import { Logger } from '@botpress/logger'
import { TrainingErrorType, TrainInput, TrainingStatus, TrainingError } from '@botpress/nlu-client'
import * as NLUEngine from '@botpress/nlu-engine'
import Bluebird from 'bluebird'
import _ from 'lodash'
import moment from 'moment'
import ms from 'ms'

import { ModelRepository } from '../infrastructure/model-repo'
import {
  Training,
  TrainingId,
  TrainingRepository,
  TrainingState,
  WrittableTrainingRepository
} from '../infrastructure/training-repo/typings'
import { serializeError } from '../utils/error-utils'
import { watchDog, WatchDog } from '../utils/watch-dog'
import { TrainingAlreadyStartedError, TrainingNotFoundError } from './errors'

const MAX_MODEL_PER_USER_PER_LANG = 1

const TRAINING_HEARTBEAT_SECURITY_FACTOR = 3
const MIN_TRAINING_HEARTBEAT = ms('10s')
const MAX_TRAINING_HEARTBEAT = MIN_TRAINING_HEARTBEAT * TRAINING_HEARTBEAT_SECURITY_FACTOR

export interface QueueOptions {
  maxTraining: number
}
const DEFAULT_OPTIONS: QueueOptions = {
  maxTraining: 2
}

export default class TrainingQueue {
  private logger: Logger
  private options: QueueOptions
  private task!: WatchDog<[]>

  constructor(
    private engine: NLUEngine.Engine,
    private modelRepo: ModelRepository,
    private trainingRepo: TrainingRepository,
    private _clusterId: string,
    logger: Logger,
    opt: Partial<QueueOptions> = {}
  ) {
    this.logger = logger.sub('training-queue')
    this.options = { ...DEFAULT_OPTIONS, ..._.pickBy(opt) }
  }

  public async initialize() {
    this.task = watchDog(this._runTask.bind(this), MAX_TRAINING_HEARTBEAT * 2)
  }

  public async teardown() {
    return this.task.stop()
  }

  public queueTraining = async (appId: string, modelId: NLUEngine.ModelId, trainInput: TrainInput) => {
    const trainId: TrainingId = { modelId, appId }
    const trainKey = this._toKey(trainId)

    await this.trainingRepo.inTransaction(async (repo) => {
      const currentTraining = await repo.get(trainId)
      if (currentTraining && (currentTraining.status === 'training' || currentTraining.status === 'training-pending')) {
        throw new TrainingAlreadyStartedError(appId, modelId)
      }

      const state: TrainingState = {
        status: 'training-pending',
        progress: 0,
        cluster: this._clusterId
      }

      this.logger.debug(`Queuing "${trainKey}"`)
      return repo.set({
        ...trainId,
        ...state,
        dataset: trainInput
      })
    }, 'queueTraining')
    this.logger.info(`[${trainKey}] Training Queued.`)

    // to return asap
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.runTask()
  }

  public async cancelTraining(appId: string, modelId: NLUEngine.ModelId): Promise<void> {
    const trainId: TrainingId = { modelId, appId }
    const trainKey = this._toKey(trainId)

    return this.trainingRepo.inTransaction(async (repo) => {
      const currentTraining = await repo.get(trainId)
      if (!currentTraining) {
        throw new TrainingNotFoundError(modelId)
      }

      const zombieTrainings = await this._getZombies(repo)
      const isZombie = !!zombieTrainings.find((t) => this._areSame(t, trainId))

      if (currentTraining.status === 'training-pending' || isZombie) {
        const newTraining = { ...currentTraining, status: <TrainingStatus>'canceled' }

        return repo.set(newTraining)
      }

      if (currentTraining.cluster !== this._clusterId) {
        this.logger.debug(`Training "${trainKey}" was not launched on this instance`)
        return
      }

      if (currentTraining.status === 'training') {
        return this.engine.cancelTraining(trainKey)
      }
    }, 'cancelTraining')
  }

  protected async runTask() {
    return this.task.run()
  }

  private _runTask = async () => {
    return this.trainingRepo.inTransaction(async (repo) => {
      const localTrainings = await repo.query({ cluster: this._clusterId, status: 'training' })
      if (localTrainings.length >= this.options.maxTraining) {
        return
      }

      const zombieTrainings = await this._getZombies(repo)
      if (zombieTrainings.length) {
        this.logger.debug(`Queuing back ${zombieTrainings.length} trainings because they seem to be zombies.`)
        const error: TrainingError = {
          type: 'zombie-training',
          message: `Zombie Training: Training had not been updated in more than ${MAX_TRAINING_HEARTBEAT} ms.`
        }
        const newState: TrainingState = { status: 'errored', progress: 0, cluster: this._clusterId, error }
        await Bluebird.each(zombieTrainings, (z) => repo.set({ ...z, ...newState }))
      }

      const pendings = await repo.query({ status: 'training-pending' })
      if (pendings.length <= 0) {
        return
      }

      const training = pendings[0]
      training.status = 'training'

      await repo.set(training)

      // floating promise to return fast from task
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this._train(training)
    }, '_runTask')
  }

  private _areSame(t1: TrainingId, t2: TrainingId) {
    return t1.appId === t2.appId && NLUEngine.modelIdService.areSame(t1.modelId, t2.modelId)
  }

  private _getZombies = (repo: WrittableTrainingRepository) => {
    const zombieThreshold = moment().subtract(MAX_TRAINING_HEARTBEAT, 'ms').toDate()
    return repo.queryOlderThan({ status: 'training' }, zombieThreshold)
  }

  private _train = async (training: Training) => {
    const trainKey = this._toKey(training)

    this.logger.debug(`training "${trainKey}" is about to start.`)

    if (!training) {
      throw new Error("Invalid state: training state can't be found")
    }

    const progressCb = async (progress: number) => {
      training.status = 'training'
      training.progress = progress
      await this.trainingRepo.inTransaction(async (repo) => {
        return repo.set(training)
      }, 'progressCallback')
    }
    const throttledCb = _.throttle(progressCb, MIN_TRAINING_HEARTBEAT / 2)

    const { dataset } = training
    try {
      const model = await this.engine.train(trainKey, dataset, {
        progressCallback: throttledCb,
        minProgressHeartbeat: MIN_TRAINING_HEARTBEAT
      })
      throttledCb.flush()

      const { language: languageCode } = dataset
      const { appId } = training

      const keep = MAX_MODEL_PER_USER_PER_LANG - 1 // TODO: make the max amount of models on FS (by appId + lang) configurable
      //await this.modelRepo.pruneModels(appId, { keep }, { languageCode })  We want to control model pruning from our chatbot-api code, so don't prune during training.
      await this.modelRepo.saveModel(appId, model)

      this.logger.info(`[${trainKey}] Training Done.`)

      training.status = 'done'
      await this.trainingRepo.inTransaction(async (repo) => {
        return repo.set(training)
      }, '_train_done')
    } catch (err) {
      throttledCb.cancel()

      if (NLUEngine.errors.isTrainingCanceled(err as Error)) {
        this.logger.info(`[${trainKey}] Training Canceled.`)

        training.status = 'canceled'
        await this.trainingRepo.inTransaction(async (repo) => {
          return repo.set(training)
        }, '_train_canceled')
        return
      }

      if (NLUEngine.errors.isTrainingAlreadyStarted(err as Error)) {
        this.logger.warn(`[${trainKey}] Training Already Started.`) // This should never occur.
        return
      }

      const type: TrainingErrorType = 'unknown'
      training.status = 'errored'
      training.error = { ...serializeError(err), type }

      await this.trainingRepo.inTransaction(async (repo) => {
        return repo.set(training)
      }, '_train_errored')

      if (type === 'unknown') {
        this.logger.attachError(err as Error).error('an error occured during training')
      }
    } finally {
      // to return asap
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.runTask()
    }
  }

  private _toKey(id: TrainingId) {
    const stringId = NLUEngine.modelIdService.toString(id.modelId)
    return `${id.appId}/${stringId}`
  }
}
