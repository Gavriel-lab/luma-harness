import fs from 'fs';
import path from 'path';

export class CheckpointStore {
  /**
   * @param {string} storageDir
   */
  constructor(storageDir) {
    this.storageDir = storageDir;
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  _getFilePath(jobId) {
    const safeName = jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `checkpoint_${safeName}.json`);
  }

  /**
   * Load checkpoint for a given jobId and strictly verify full binding
   * @param {string} jobId
   * @param {object} [expectedBinding]
   * @param {string} [expectedBinding.agentId]
   * @param {string} [expectedBinding.homeId]
   * @param {string} [expectedBinding.executorId]
   * @param {string} [expectedBinding.workspace]
   * @param {string} [expectedBinding.attemptId]
   * @param {number} [expectedBinding.contextVersion]
   */
  load(jobId, expectedBinding = null) {
    const filePath = this._getFilePath(jobId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const checkpoint = JSON.parse(data);

      if (expectedBinding) {
        // Strict: Checkpoint MUST have agentId to be compatible
        if (!checkpoint.agentId) {
          return null;
        }

        if (expectedBinding.agentId && checkpoint.agentId !== expectedBinding.agentId) {
          return null;
        }
        if (expectedBinding.homeId && checkpoint.homeId && checkpoint.homeId !== expectedBinding.homeId) {
          return null;
        }
        if (expectedBinding.executorId && checkpoint.executorId && checkpoint.executorId !== expectedBinding.executorId) {
          return null;
        }
        if (expectedBinding.attemptId && checkpoint.attemptId && checkpoint.attemptId !== expectedBinding.attemptId) {
          return null;
        }
        if (expectedBinding.workspace && checkpoint.workspace) {
          const normExp = path.normalize(path.resolve(expectedBinding.workspace));
          const normSaved = path.normalize(path.resolve(checkpoint.workspace));
          if (normExp !== normSaved) {
            return null;
          }
        }
        // If contextVersion in packet is newer than checkpoint, session cannot be blindly reused if changed!
        if (expectedBinding.contextVersion && checkpoint.contextVersion) {
          if (expectedBinding.contextVersion !== checkpoint.contextVersion) {
            checkpoint.sessionInvalidated = true;
          }
        }
      }

      return checkpoint;
    } catch (err) {
      return null;
    }
  }

  /**
   * Save checkpoint
   * @param {string} jobId
   * @param {object} checkpointData
   */
  save(jobId, checkpointData) {
    const filePath = this._getFilePath(jobId);
    const dataToSave = {
      ...checkpointData,
      jobId,
      updatedAt: Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
    return dataToSave;
  }

  /**
   * Clear checkpoint upon successful completion or abandonment
   * @param {string} jobId
   */
  clear(jobId) {
    const filePath = this._getFilePath(jobId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
