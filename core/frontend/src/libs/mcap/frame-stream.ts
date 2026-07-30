/**
 * Sequential frame reader for a single video channel. It downloads one MCAP chunk at a time, so
 * memory and bandwidth stay proportional to what is actually being watched.
 */
import { KeyframeLocator } from './keyframe-index'
import { McapIndexedReader } from './reader'
import { VideoFrame, VideoFrameDecoder, VideoTrack } from './video-track'

/** Chunks worth of message index to inspect while looking for a keyframe around a seek target. */
const KEYFRAME_SEARCH_CHUNKS = 64

export default class VideoFrameStream {
  private chunkPositions: number[]

  private cursor = 0

  private queue: VideoFrame[] = []

  private decoder: VideoFrameDecoder

  private locator: KeyframeLocator

  constructor(private reader: McapIndexedReader, public readonly track: VideoTrack) {
    const channel = reader.summary.channels.get(track.channelId)
    if (!channel) {
      throw new Error(`Recording has no channel ${track.channelId}.`)
    }
    this.decoder = VideoFrameDecoder.create(reader, channel)
    this.chunkPositions = reader.chunkIndexesForChannel(track.channelId)
    this.locator = new KeyframeLocator(reader, track.channelId, this.chunkPositions)
  }

  get startTime(): bigint {
    return this.reader.summary.startTime
  }

  get durationSeconds(): number {
    return Number(this.reader.summary.endTime - this.startTime) / 1e9
  }

  get bytesRead(): number {
    return this.reader.source.bytesRead
  }

  toSeconds(logTime: bigint): number {
    return Number(logTime - this.startTime) / 1e9
  }

  toLogTime(seconds: number): bigint {
    return this.startTime + BigInt(Math.max(0, Math.round(seconds * 1e9)))
  }

  private positionForTime(logTime: bigint): number {
    const chunkIndex = this.reader.findChunkIndexAtTime(this.track.channelId, logTime)
    const position = this.chunkPositions.indexOf(chunkIndex)
    return position >= 0 ? position : 0
  }

  /**
   * Moves the stream to the keyframe that starts playback for the given time, preferring the
   * keyframe at or before it so that seeking does not skip forward over content.
   */
  async seekToKeyframe(seconds: number, signal?: AbortSignal): Promise<void> {
    const logTime = this.toLogTime(seconds)
    const position = this.positionForTime(logTime)
    const hint = await this.locator.findBefore(logTime, position, KEYFRAME_SEARCH_CHUNKS, signal)
      ?? await this.locator.findForward(position, KEYFRAME_SEARCH_CHUNKS, signal)
    this.queue = []
    this.cursor = hint?.position ?? position
  }

  /**
   * Positions the stream at the beginning of the recording. No keyframe lookup here: the first chunk
   * has to be downloaded either way, and scanning it for the first real keyframe starts playback
   * earlier than any size-based guess could.
   */
  seekToStart(): void {
    this.queue = []
    this.cursor = 0
  }

  /**
   * Skips to the next chunk that looks like it holds a keyframe. Meant for callers that already
   * decoded frames and found none, so nothing playable is left behind. Returns false when the guess
   * points at the chunk being read, in which case reading on is cheaper than jumping.
   */
  async skipToKeyframeHint(signal?: AbortSignal): Promise<boolean> {
    const current = Math.max(0, this.cursor - 1)
    const hint = await this.locator.findForward(current, KEYFRAME_SEARCH_CHUNKS, signal)
    if (!hint || hint.position <= current) {
      return false
    }
    this.queue = []
    this.cursor = hint.position
    return true
  }

  async next(signal?: AbortSignal): Promise<VideoFrame | null> {
    while (this.queue.length === 0) {
      if (this.cursor >= this.chunkPositions.length) {
        return null
      }
      const chunkIndex = this.chunkPositions[this.cursor]
      this.cursor += 1
      // eslint-disable-next-line no-await-in-loop
      const messages = await this.reader.readChunkMessages(chunkIndex, this.track.channelId, signal)
      this.queue = messages.map((message) => this.decoder.decode(message))
    }
    return this.queue.shift() ?? null
  }
}
