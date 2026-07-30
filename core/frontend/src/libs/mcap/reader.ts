/**
 * Minimal MCAP reader designed for random access over HTTP range requests.
 *
 * Only the records needed to locate and decode video messages are parsed. The file index (footer +
 * summary section) lives at the end of the file, so opening a multi-gigabyte recording costs a few
 * tens of kilobytes and every seek afterwards downloads just the chunks that overlap the requested
 * time range.
 */
import { decompress as zstdDecompress } from 'fzstd'

import { forEachRecord, RecordReader } from './record-reader'
import { ByteSource } from './source'

const MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]
const MAGIC_SIZE = MAGIC.length
const FOOTER_RECORD_SIZE = 29 // opcode + u64 length + summary_start + summary_offset_start + crc
const TAIL_READ_SIZE = 4096

enum Opcode {
  SCHEMA = 0x03,
  CHANNEL = 0x04,
  MESSAGE = 0x05,
  CHUNK = 0x06,
  MESSAGE_INDEX = 0x07,
  CHUNK_INDEX = 0x08,
  STATISTICS = 0x0b,
  SUMMARY_OFFSET = 0x0e,
}

/** Records describing what a recording contains, as opposed to where its data lives. */
const METADATA_OPCODES = [Opcode.SCHEMA, Opcode.CHANNEL, Opcode.STATISTICS]

/** opcode + u64 length + channel_id + sequence + log_time + publish_time */
const MESSAGE_HEADER_SIZE = 31

export interface McapSchema {
  id: number
  name: string
  encoding: string
  data: Uint8Array
}

export interface McapChannel {
  id: number
  schemaId: number
  topic: string
  messageEncoding: string
}

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
  /** Skip the chunk index, which is only needed to seek and read messages. */
  metadataOnly?: boolean
  signal?: AbortSignal
}

export interface McapMessage {
  channelId: number
  logTime: bigint
  data: Uint8Array
}

export interface McapSummary {
  size: number
  startTime: bigint
  endTime: bigint
  schemas: Map<number, McapSchema>
  channels: Map<number, McapChannel>
  chunkIndexes: McapChunkIndex[]
  messageCountByChannel: Map<number, bigint>
}

function hasMagic(bytes: Uint8Array, offset: number): boolean {
  return MAGIC.every((byte, index) => bytes[offset + index] === byte)
}

function decompressChunk(compression: string, compressed: Uint8Array, uncompressedSize: number): Uint8Array {
  switch (compression) {
    case '':
      return compressed
    case 'zstd':
      return zstdDecompress(compressed, uncompressedSize > 0 ? new Uint8Array(uncompressedSize) : undefined)
    default:
      throw new Error(`Unsupported MCAP chunk compression: '${compression}'.`)
  }
}

export class McapIndexedReader {
  private constructor(public readonly source: ByteSource, public readonly summary: McapSummary) {}

  /**
   * Reads the index of a recording. With `metadataOnly` the chunk index is skipped, which keeps the
   * cost at a few kilobytes even for multi gigabyte recordings, at the price of not being seekable.
   */
  static async open(source: ByteSource, options: McapOpenOptions = {}): Promise<McapIndexedReader> {
    const { metadataOnly = false, signal } = options
    const size = await source.size(signal)
    if (size < MAGIC_SIZE * 2 + FOOTER_RECORD_SIZE) {
      throw new Error('File is too small to be an MCAP recording.')
    }

    const tailSize = Math.min(TAIL_READ_SIZE, size)
    const tail = await source.read(size - tailSize, tailSize, signal)
    if (!hasMagic(tail, tail.length - MAGIC_SIZE)) {
      throw new Error('Not an MCAP file, or the recording was truncated before being closed.')
    }

    const footer = new RecordReader(tail, tail.length - MAGIC_SIZE - FOOTER_RECORD_SIZE)
    footer.uint8()
    footer.size()
    const summaryStart = Number(footer.uint64())
    const summaryOffsetStart = Number(footer.uint64())
    if (summaryStart === 0) {
      throw new Error('Recording has no index, so it cannot be streamed. It needs to be repaired first.')
    }

    const summaryEnd = size - MAGIC_SIZE - FOOTER_RECORD_SIZE
    const sections = metadataOnly
      ? await McapIndexedReader.readMetadataSections(source, summaryOffsetStart, summaryEnd, tail, size, signal)
      : null
    const summaryData = sections ?? await source.read(summaryStart, summaryEnd - summaryStart, signal)
    return new McapIndexedReader(source, McapIndexedReader.parseSummary(summaryData, size))
  }

  /**
   * Uses the summary offset section to fetch only the record groups describing the recording. Falls
   * back to null when the recording has no summary offsets, in which case the caller reads it whole.
   */
  private static async readMetadataSections(
    source: ByteSource,
    summaryOffsetStart: number,
    summaryEnd: number,
    tail: Uint8Array,
    size: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    if (summaryOffsetStart === 0) {
      return null
    }

    const tailOffset = size - tail.length
    const offsetsData = summaryOffsetStart >= tailOffset
      ? tail.subarray(summaryOffsetStart - tailOffset, summaryEnd - tailOffset)
      : await source.read(summaryOffsetStart, summaryEnd - summaryOffsetStart, signal)

    const groups: { start: number, length: number }[] = []
    forEachRecord(offsetsData, (opcode, reader) => {
      if (opcode !== Opcode.SUMMARY_OFFSET) {
        return
      }
      const groupOpcode = reader.uint8()
      const start = Number(reader.uint64())
      const length = Number(reader.uint64())
      if (METADATA_OPCODES.includes(groupOpcode) && length > 0) {
        groups.push({ start, length })
      }
    })
    if (groups.length === 0) {
      return null
    }

    groups.sort((left, right) => left.start - right.start)
    const parts = await Promise.all(groups.map((group) => source.read(group.start, group.length, signal)))
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.length
    }
    return merged
  }

  private static parseSummary(data: Uint8Array, size: number): McapSummary {
    const schemas = new Map<number, McapSchema>()
    const channels = new Map<number, McapChannel>()
    const chunkIndexes: McapChunkIndex[] = []
    const messageCountByChannel = new Map<number, bigint>()
    let startTime = 0n
    let endTime = 0n

    forEachRecord(data, (opcode, reader) => {
      switch (opcode) {
        case Opcode.SCHEMA: {
          const id = reader.uint16()
          const name = reader.string()
          const encoding = reader.string()
          schemas.set(id, {
            id, name, encoding, data: reader.bytes(reader.uint32()),
          })
          break
        }
        case Opcode.CHANNEL: {
          const id = reader.uint16()
          channels.set(id, {
            id, schemaId: reader.uint16(), topic: reader.string(), messageEncoding: reader.string(),
          })
          break
        }
        case Opcode.CHUNK_INDEX: {
          const chunkStartTime = reader.uint64()
          const chunkEndTime = reader.uint64()
          const offset = Number(reader.uint64())
          const length = Number(reader.uint64())
          const channelIds: number[] = []
          const mapEnd = reader.offset + reader.uint32()
          while (reader.offset < mapEnd) {
            channelIds.push(reader.uint16())
            reader.skip(8)
          }
          const messageIndexLength = Number(reader.uint64())
          chunkIndexes.push({
            startTime: chunkStartTime,
            endTime: chunkEndTime,
            offset,
            length,
            compression: reader.string(),
            compressedSize: Number(reader.uint64()),
            uncompressedSize: Number(reader.uint64()),
            channelIds,
            messageIndexLength,
          })
          break
        }
        case Opcode.STATISTICS: {
          reader.skip(8 + 2 + 4 + 4 + 4 + 4)
          startTime = reader.uint64()
          endTime = reader.uint64()
          const mapEnd = reader.offset + reader.uint32()
          while (reader.offset < mapEnd) {
            messageCountByChannel.set(reader.uint16(), reader.uint64())
          }
          break
        }
        default:
          break
      }
    })

    chunkIndexes.sort((left, right) => Number(left.startTime - right.startTime))
    if (startTime === 0n && chunkIndexes.length > 0) {
      startTime = chunkIndexes[0].startTime
      endTime = chunkIndexes[chunkIndexes.length - 1].endTime
    }

    return {
      size, startTime, endTime, schemas, channels, chunkIndexes, messageCountByChannel,
    }
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
   * of a channel, without downloading the chunk itself. A chunk of video costs hundreds of kilobytes
   * while its message index costs a few, which is what makes cheap keyframe lookup possible.
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

    const data = await this.source.read(index.offset + index.length, index.messageIndexLength, signal)
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

    // A message ends where the next message of any channel begins.
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
  }

  async readChunkMessages(chunkIndex: number, channelId: number, signal?: AbortSignal): Promise<McapMessage[]> {
    const index = this.summary.chunkIndexes[chunkIndex]
    if (!index) {
      throw new Error(`Chunk ${chunkIndex} is out of range.`)
    }

    const record = await this.source.read(index.offset, index.length, signal)
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

    const messages: McapMessage[] = []
    forEachRecord(decompressChunk(compression, compressed, uncompressedSize), (opcode, message, end) => {
      if (opcode !== Opcode.MESSAGE || message.uint16() !== channelId) {
        return
      }
      message.skip(4) // sequence
      const logTime = message.uint64()
      message.skip(8) // publish_time
      messages.push({ channelId, logTime, data: message.bytes(end - message.offset) })
    })

    messages.sort((left, right) => Number(left.logTime - right.logTime))
    return messages
  }
}
