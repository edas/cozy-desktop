/* @flow */

const path = require('path')
const _ = require('lodash')

const { getInode } = require('./event')
const localChange = require('./change')
const ChangeMap = require('./ChangeMap')
const logger = require('../logger')
const measureTime = require('../perftools')

/*::
import type { LocalEvent } from './event'
import type {
  LocalChange,
  LocalDirAddition,
  LocalDirDeletion,
  LocalDirMove,
  LocalFileAddition,
  LocalFileDeletion,
  LocalFileMove
} from './change'
*/

const log = logger({
  component: 'LocalAnalysis'
})
log.chokidar = log.child({
  component: 'chokidar'
})

module.exports = function analysis (events /*: LocalEvent[] */, pendingChanges /*: LocalChange[] */) /*: LocalChange[] */ {
  const changes /*: LocalChange[] */ = analyseEvents(events, pendingChanges)
  sortBeforeSquash(changes)
  squashMoves(changes)
  finalSort(changes)
  return separatePendingChanges(changes, pendingChanges)
}

const panic = (context, description) => {
  log.error(_.merge({sentry: true}, context), description)
  throw new Error(description)
}

function analyseEvents (events /*: LocalEvent[] */, pendingChanges /*: LocalChange[] */) /*: LocalChange[] */ {
  const stopMeasure = measureTime('LocalWatcher#analyseEvents')
  const changes = ChangeMap.init(pendingChanges)
  const changeFound = (c /*: LocalChange */) => ChangeMap.put(changes, c)

  if (pendingChanges.length > 0) {
    log.warn({pendingChanges}, `Prepended ${pendingChanges.length} pending change(s)`)
    pendingChanges.length = 0
  }

  log.trace('Analyze events...')

  for (let e/*: LocalEvent */ of events) {
    try {
      // chokidar make mistakes
      if (e.type === 'unlinkDir' && e.old && e.old.docType === 'file') {
        log.warn({event: e, old: e.old, path: e.path}, 'chokidar miscategorized event (was file, event unlinkDir)')
        // $FlowFixMe
        e.type = 'unlink'
      }

      if (e.type === 'unlink' && e.old && e.old.docType === 'folder') {
        log.warn({event: e, old: e.old, path: e.path}, 'chokidar miscategorized event (was folder, event unlink)')
        // $FlowFixMe
        e.type = 'unlinkDir'
      }

      const sameInodeChange = ChangeMap.byInode(changes, getInode(e))
      const samePathChange = ChangeMap.byPath(changes, e.path)

      switch (e.type) {
        case 'add':
          {
            const moveChange /*: ?LocalFileMove */ = localChange.maybeMoveFile(sameInodeChange)
            if (moveChange) {
              localChange.includeAddEventInFileMove(moveChange, e)
              break
            }

            const unlinkChange /*: ?LocalFileDeletion */ = localChange.maybeDeleteFile(sameInodeChange)
            if (unlinkChange) {
              changeFound(localChange.fileMoveFromUnlinkAdd(unlinkChange, e))
              break
            }

            changeFound(
              localChange.fileMoveIdenticalOffline(e) ||
              localChange.fromEvent(e)
            )
          }
          break
        case 'addDir':
          {
            const moveChange /*: ?LocalDirMove */ = localChange.maybeMoveFolder(sameInodeChange)
            if (moveChange) {
              localChange.includeAddDirEventInDirMove(moveChange, e)
              break
            }
            const unlinkChange /*: ?LocalDirDeletion */ = localChange.maybeDeleteFolder(sameInodeChange)
            if (unlinkChange) {
              changeFound(localChange.dirMoveFromUnlinkAdd(unlinkChange, e))
              break
            }
            const addChange /*: ?LocalDirAddition */ = localChange.maybePutFolder(sameInodeChange)
            if (addChange) {
              changeFound(localChange.dirRenamingCaseOnlyFromAddAdd(addChange, e))
              break
            }
            changeFound(
              localChange.dirMoveIdenticalOffline(e) ||
              localChange.fromEvent(e)
            )
          }
          break
        case 'change':
          const moveChange /*: ?LocalFileMove */ = localChange.maybeMoveFile(sameInodeChange)
          if (moveChange) {
            localChange.includeChangeEventIntoFileMove(moveChange, e)
            break
          }

          // There was an unlink on the same file, this is most probably a move and replace
          const unlinkChange /*: ?LocalFileDeletion */ = localChange.maybeDeleteFile(sameInodeChange)
          if (unlinkChange) {
            const moveChange = localChange.fileMoveFromFileDeletionChange(unlinkChange, e)
            changeFound(moveChange)
            break
          }

          const addChange /*: ?LocalFileAddition */ = localChange.maybeAddFile(sameInodeChange)
          if (addChange && addChange.path !== e.path) {
            changeFound(localChange.fileMoveIdentical(addChange, e))
            break
          }

          changeFound(localChange.fromEvent(e))
          break
        case 'unlink':
          {
            const moveChange /*: ?LocalFileMove */ = localChange.maybeMoveFile(sameInodeChange)
            /* istanbul ignore next */
            if (moveChange) {
              // TODO: Pending move
              panic({path: e.path, moveChange, event: e},
                'We should not have both move and unlink changes since ' +
                'checksumless adds and inode-less unlink events are dropped')
            }

            const addChange /*: ?LocalFileAddition */ = localChange.maybeAddFile(sameInodeChange)
            if (addChange) {
              // TODO: pending move
              changeFound(localChange.fileMoveFromAddUnlink(addChange, e))
              break
            } else if (getInode(e)) {
              changeFound(localChange.fromEvent(e))
              break
            }
            const change /*: ?LocalFileMove */ = localChange.maybeMoveFile(samePathChange)
            if (change && change.md5sum == null) { // FIXME: if change && change.wip?
              localChange.convertFileMoveToDeletion(change)
            }
            // Otherwise, skip unlink event by multiple moves
          }
          break
        case 'unlinkDir':
          {
            const moveChange /*: ?LocalDirMove */ = localChange.maybeMoveFolder(sameInodeChange)
            /* istanbul ignore next */
            if (moveChange) {
              // TODO: pending move
              panic({path: e.path, moveChange, event: e},
                'We should not have both move and unlinkDir changes since ' +
                'non-existing addDir and inode-less unlinkDir events are dropped')
            }

            const addChange /*: ?LocalDirAddition */ = localChange.maybePutFolder(sameInodeChange)
            if (addChange) {
              changeFound(localChange.dirMoveFromAddUnlink(addChange, e))
            } else if (getInode(e)) {
              changeFound(localChange.fromEvent(e))
            } else {
              const addChangeSamePath /*: ?LocalDirAddition */ = localChange.maybePutFolder(samePathChange)
              if (addChangeSamePath && addChangeSamePath.wip) {
                log.debug({path: addChangeSamePath.path, ino: addChangeSamePath.ino},
                  'Folder was added then deleted. Ignoring add.')
                // $FlowFixMe
                addChangeSamePath.type = 'Ignored'
              }

              const moveChangeSamePath /*: ?LocalDirMove */ = localChange.maybeMoveFolder(samePathChange)
              if (moveChangeSamePath && moveChangeSamePath.wip) {
                localChange.convertDirMoveToDeletion(moveChangeSamePath)
              }
            }
          }
          break
        default:
          throw new TypeError(`Unknown event type: ${e.type}`)
      }
    } catch (err) {
      log.error({err, path: e.path})
      throw err
    }
    if (process.env.DEBUG) log.trace({currentEvent: e, path: e.path})
  }

  log.trace('Flatten changes map...')
  const result = ChangeMap.toArray(changes)

  stopMeasure()
  return result
}

// TODO: Rename according to the sort logic
function sortBeforeSquash (changes /*: LocalChange[] */) {
  log.trace('Sort changes before squash...')
  const stopMeasure = measureTime('LocalWatcher#sortBeforeSquash')
  changes.sort((a, b) => {
    if (a.type === 'DirMove' || a.type === 'FileMove') {
      if (b.type === 'DirMove' || b.type === 'FileMove') {
        if (a.path < b.path) return -1
        else if (a.path > b.path) return 1
        else return 0
      } else return -1
    } else if (b.type === 'DirMove' || b.type === 'FileMove') {
      return 1
    } else {
      return 0
    }
  })
  stopMeasure()
}

function squashMoves (changes /*: LocalChange[] */) {
  log.trace('Squash moves...')
  const stopMeasure = measureTime('LocalWatcher#squashMoves')

  for (let i = 0; i < changes.length; i++) {
    let a = changes[i]

    if (a.type !== 'DirMove' && a.type !== 'FileMove') break
    for (let j = i + 1; j < changes.length; j++) {
      let b = changes[j]
      if (b.type !== 'DirMove' && b.type !== 'FileMove') break

      // inline of LocalChange.isChildMove
      if (a.type === 'DirMove' &&
      b.path.indexOf(a.path + path.sep) === 0 &&
      a.old && b.old &&
      b.old.path.indexOf(a.old.path + path.sep) === 0) {
        log.debug({oldpath: b.old.path, path: b.path}, 'descendant move')
        a.wip = a.wip || b.wip
        if (b.path.substr(a.path.length) === b.old.path.substr(a.old.path.length)) {
          changes.splice(j--, 1)
        } else {
          // move inside move
          b.old.path = b.old.path.replace(a.old.path, a.path)
          b.needRefetch = true
        }
      }
    }
  }

  stopMeasure()
}

function separatePendingChanges (changes /*: LocalChange[] */, pendingChanges /*: LocalChange[] */) /*: LocalChange[] */ {
  log.trace('Reserve changes in progress for next flush...')

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]
    if (change.wip) {
      if (change.type === 'DirMove' || change.type === 'FileMove') {
        log.debug({
          change: change.type,
          oldpath: change.old.path,
          path: change.path,
          ino: change.ino
        }, 'incomplete change')
      } else {
        log.debug({change: change.type, path: change.path}, 'incomplete change')
      }
      pendingChanges.push(changes[i])
    } else {
      log.debug(`Identified ${changes.length} change(s).`)
      log.debug(`${pendingChanges.length} of them are still pending.`)
      return changes.slice(i)
    }
  }
  // All actions are WIP
  return []
}

// TODO: Rename according to the sort logic
const finalSorter = (a /*: LocalChange */, b /*: LocalChange */) => {
  if (a.wip && !b.wip) return -1
  if (b.wip && !a.wip) return 1

  if (!localChange.addPath(b) && localChange.childOf(localChange.addPath(a), localChange.delPath(b))) return 1
  if (!localChange.addPath(a) && localChange.childOf(localChange.addPath(b), localChange.delPath(a))) return -1

  if (localChange.childOf(localChange.addPath(a), localChange.delPath(b))) return -1
  if (localChange.childOf(localChange.addPath(b), localChange.delPath(a))) return 1

  // if one change is a child of another, it takes priority
  if (localChange.isChildAdd(a, b)) return -1
  if (localChange.isChildDelete(b, a)) return -1
  if (localChange.isChildAdd(b, a)) return 1
  if (localChange.isChildDelete(a, b)) return 1

  if (localChange.delPath(a) === localChange.addPath(b)) return -1
  if (localChange.delPath(b) === localChange.addPath(a)) return 1

  // otherwise, order by add path
  if (localChange.lower(localChange.addPath(a), localChange.addPath(b))) return -1
  if (localChange.lower(localChange.addPath(b), localChange.addPath(a))) return 1

  // if there isnt 2 add paths, sort by del path
  if (localChange.lower(localChange.delPath(b), localChange.delPath(a))) return -1

  return 1
}

// TODO: Rename according to the sort logic
function finalSort (changes /*: LocalChange[] */) {
  log.trace('Final sort...')
  const stopMeasure = measureTime('LocalWatcher#finalSort')
  changes.sort(finalSorter)
  stopMeasure()
}
