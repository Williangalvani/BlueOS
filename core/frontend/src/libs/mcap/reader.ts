/**
 * Indexed MCAP reader built on `@mcap/core`, with the chunk-oriented helpers the video player needs.
 *
 * Foxglove's reader owns the footer/summary/index parse and message iteration. On top of that we keep
 * a decompressed-chunk cache (so simultaneous streams of one recording share downloads), message-index
 * size hints for keyframe seeking, and AbortSignal plumbing that IReadable does not provide.
 */
import {
  type Channel,
  type ChunkIndex,
  type DecompressHandlers,
  McapIndexedReader as CoreMcapIndexedReader,
  type Message,
  Opcode,
  type Schema,
} from '@mcap/core'
import { decompress as zstdDecompress } from 'fzstd'

import McapNeedsRepairError from './needs-repair-error'
import { forEachRecord, RecordReader } from './record-reader'
import { ByteSource } from './source'

export { default as McapNeedsRepairError } from './needs-repair-error'

/** opcode + u64 length + channel_id + sequence + log_time + publish_time */
const MESSAGE_HEADER_SIZE = 31
const CHUNK_CACHE_LIMIT_BYTES = 32 * 1024 * 1024

export type McapSchema = Schema
export type McapChannel = Channel
export type McapMessage = Message

export interface McapChunkIndex {
  startTime: bigint
  endTime: bigint
  offset: number
  length: number
  compression: string
  compressedSize: number
  uncompressedSize: number
  channelIds: number[]
  /** Total size of the message index records that follow the chunk. */
  messageIndexLength: number
}

/** Log time and size of a single message, derived from the message index alone. */
export interface McapMessageEntry {
  logTime: bigint
  size: number
}

export interface McapOpenOptions {
  /**
   * Kept for call-site compatibility. `@mcap/core` always loads the full summary, including the
   * chunk index, so this no longer avoids that download.
   */
  metadataOnly?: boolean
  signal?: AbortSignal
}

export interface McapSummary {
  size: number
  startTime: bigint
  endTime: bigint
  schemas: ReadonlyMap<number, McapSchema>
  channels: ReadonlyMap<number, McapChannel>
  chunkIndexes: McapChunkIndex[]
  messageCountByChannel: ReadonlyMap<number, bigint>
}

function abortError(): Error {
  const error = new Error('The read was aborted.')
  error.name = 'AbortError'
  return error
}

/**
 * Waits for work that is shared between callers. Aborting only gives up waiting, since cancelling the
 * download would take it away from the other streams reading the same chunk.
 */
function whileWaiting<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work
  }
  if (signal.aborted) {
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    function onAbort(): void {
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function adaptChunkIndex(chunk: ChunkIndex): McapChunkIndex {
  return {
    startTime: chunk.messageStartTime,
    endTime: chunk.messageEndTime,
    offset: Number(chunk.chunkStartOffset),
    length: Number(chunk.chunkLength),
    compression: chunk.compression,
    compressedSize: Number(chunk.compressedSize),
    uncompressedSize: Number(chunk.uncompressedSize),
    channelIds: [...chunk.messageIndexOffsets.keys()],
    messageIndexLength: Number(chunk.messageIndexLength),
  }
}

function isRepairFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not indexed|too small to be valid MCAP|Unable to read footer|Incorrect summary|MCAP magic/i
    .test(message)
}

const decompressHandlers: DecompressHandlers = {
  zstd: (buffer, decompressedSize) => {
    const size = Number(decompressedSize)
    return zstdDecompress(buffer, size > 0 ? new Uint8Array(size) : undefined)
  },
}

export class McapIndexedReader {
  /** Decompressed chunks, in least recently used order. */
  private chunkCache = new Map<number, Uint8Array>()

  private chunkCacheBytes = 0

  private chunkLoads = new Map<number, Promise<Uint8Array>>()

  private constructor(
    private readonly core: CoreMcapIndexedReader,
    public readonly source: ByteSource,
    public readonly summary: McapSummary,
  ) {}

  static async open(source: ByteSource, options: McapOpenOptions = {}): Promise<McapIndexedReader> {
    const { signal } = options
    source.abortSignal = signal
    try {
      const core = await CoreMcapIndexedReader.Initialize({
        readable: source,
        decompressHandlers,
        // Keep message indexes around so seeks across streams of the same recording stay cheap.
        messageIndexCacheSizeBytes: 8 * 1024 * 1024,
      })
      const size = Number(await source.size())
      const chunkIndexes = core.chunkIndexes.map(adaptChunkIndex)
      const startTime = core.statistics?.messageStartTime
        ?? chunkIndexes[0]?.startTime
        ?? 0n
      const endTime = core.statistics?.messageEndTime
        ?? chunkIndexes[chunkIndexes.length - 1]?.endTime
        ?? startTime
      return new McapIndexedReader(core, source, {
        size,
        startTime,
        endTime,
        schemas: core.schemasById,
        channels: core.channelsById,
        chunkIndexes,
        messageCountByChannel: core.statistics?.channelMessageCounts ?? new Map(),
      })
    } catch (error) {
      if (error instanceof McapNeedsRepairError) {
        throw error
      }
      if (isRepairFailure(error)) {
        throw new McapNeedsRepairError(
          error instanceof Error ? error.message : 'This recording cannot be read until it is repaired.',
        )
      }
      throw error
    } finally {
      source.abortSignal = undefined
    }
  }

  /** Always complete: `@mcap/core` loads the whole chunk index during Initialize. */
  get chunkIndexComplete(): boolean {
    return this.summary.chunkIndexes.length >= 0
  }

  loadMoreChunkIndexes(): Promise<boolean> {
    return Promise.resolve(!this.chunkIndexComplete)
  }

  async loadChunkIndexesUntil(): Promise<void> {
    // Index is already complete after open; keep the method for call-site compatibility.
    await Promise.resolve(this.chunkIndexComplete)
  }

  channelsBySchemaName(schemaName: string): McapChannel[] {
    return [...this.summary.channels.values()]
      .filter((channel) => this.summary.schemas.get(channel.schemaId)?.name === schemaName)
      .sort((left, right) => left.topic.localeCompare(right.topic))
  }

  /** Indexes of the chunks holding messages for a channel, in time order. */
  chunkIndexesForChannel(channelId: number): number[] {
    return this.summary.chunkIndexes
      .map((chunk, index) => ({ chunk, index }))
      .filter(({ chunk }) => chunk.channelIds.length === 0 || chunk.channelIds.includes(channelId))
      .map(({ index }) => index)
  }

  /** First chunk that may contain a message at or after the given time. */
  findChunkIndexAtTime(channelId: number, time: bigint): number {
    const candidates = this.chunkIndexesForChannel(channelId)
    let result = candidates.length > 0 ? candidates[0] : 0
    for (const index of candidates) {
      if (this.summary.chunkIndexes[index].startTime > time) {
        break
      }
      result = index
    }
    return result
  }

  /**
   * Reads the message index that follows a chunk to obtain the log time and size of every message
   * of a channel, without downloading the chunk itself.
   */
  async readChunkMessageEntries(
    chunkIndex: number,
    channelId: number,
    signal?: AbortSignal,
  ): Promise<McapMessageEntry[] | null> {
    const index = this.summary.chunkIndexes[chunkIndex]
    if (!index || index.messageIndexLength === 0) {
      return null
    }

    this.source.abortSignal = signal
    try {
      const data = await this.source.read(
        BigInt(index.offset + index.length),
        BigInt(index.messageIndexLength),
      )
      const allOffsets: number[] = []
      const channelOffsets: { logTime: bigint, offset: number }[] = []
      forEachRecord(data, (opcode, reader) => {
        if (opcode !== Opcode.MESSAGE_INDEX) {
          return
        }
        const recordChannelId = reader.uint16()
        const arrayEnd = reader.offset + reader.uint32()
        while (reader.offset < arrayEnd) {
          const logTime = reader.uint64()
          const offset = Number(reader.uint64())
          allOffsets.push(offset)
          if (recordChannelId === channelId) {
            channelOffsets.push({ logTime, offset })
          }
        }
      })

      allOffsets.sort((left, right) => left - right)
      return channelOffsets.map(({ logTime, offset }) => {
        let low = 0
        let high = allOffsets.length
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          if (allOffsets[middle] <= offset) {
            low = middle + 1
          } else {
            high = middle
          }
        }
        const end = low < allOffsets.length ? allOffsets[low] : index.uncompressedSize
        return { logTime, size: Math.max(0, end - offset - MESSAGE_HEADER_SIZE) }
      }).sort((left, right) => Number(left.logTime - right.logTime))
    } finally {
      this.source.abortSignal = undefined
    }
  }

  async readChunkMessages(chunkIndex: number, channelId: number, signal?: AbortSignal): Promise<McapMessage[]> {
    const data = await this.readChunkData(chunkIndex, signal)

    const messages: McapMessage[] = []
    forEachRecord(data, (opcode, message, end) => {
      if (opcode !== Opcode.MESSAGE || message.uint16() !== channelId) {
        return
      }
      const sequence = message.uint32()
      const logTime = message.uint64()
      const publishTime = message.uint64()
      messages.push({
        type: 'Message',
        channelId,
        sequence,
        logTime,
        publishTime,
        data: message.bytes(end - message.offset),
      })
    })

    messages.sort((left, right) => Number(left.logTime - right.logTime))
    return messages
  }

  /**
   * Decompressed contents of a chunk. Downloads in flight are shared, so several streams asking for
   * the same chunk at the same time cost one request, and recently used chunks are kept in memory for
   * the streams that are still catching up.
   */
  private async readChunkData(chunkIndex: number, signal?: AbortSignal): Promise<Uint8Array> {
    const cached = this.chunkCache.get(chunkIndex)
    if (cached) {
      this.chunkCache.delete(chunkIndex)
      this.chunkCache.set(chunkIndex, cached)
      return cached
    }

    let load = this.chunkLoads.get(chunkIndex)
    if (!load) {
      load = this.downloadChunk(chunkIndex)
        .then((data) => {
          this.cacheChunk(chunkIndex, data)
          return data
        })
        .finally(() => this.chunkLoads.delete(chunkIndex))
      this.chunkLoads.set(chunkIndex, load)
    }
    return whileWaiting(load, signal)
  }

  private async downloadChunk(chunkIndex: number): Promise<Uint8Array> {
    const index = this.summary.chunkIndexes[chunkIndex]
    if (!index) {
      throw new Error(`Chunk ${chunkIndex} is out of range.`)
    }

    const record = await this.source.read(BigInt(index.offset), BigInt(index.length))
    const reader = new RecordReader(record)
    if (reader.uint8() !== Opcode.CHUNK) {
      throw new Error(`Expected a chunk record at offset ${index.offset}.`)
    }
    reader.size()
    reader.skip(8 + 8) // message_start_time, message_end_time
    const uncompressedSize = reader.size()
    reader.skip(4) // uncompressed_crc
    const compression = reader.string()
    const compressed = reader.bytes(reader.size())
    if (!compression) {
      return compressed
    }
    const handler = decompressHandlers[compression]
    if (!handler) {
      throw new Error(`Unsupported MCAP chunk compression: '${compression}'.`)
    }
    return handler(compressed, BigInt(uncompressedSize))
  }

  private cacheChunk(chunkIndex: number, data: Uint8Array): void {
    this.chunkCache.set(chunkIndex, data)
    this.chunkCacheBytes += data.length
    for (const [key, value] of this.chunkCache) {
      if (this.chunkCacheBytes <= CHUNK_CACHE_LIMIT_BYTES || key === chunkIndex) {
        break
      }
      this.chunkCache.delete(key)
      this.chunkCacheBytes -= value.length
    }
  }
}
