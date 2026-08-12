import type { IReadable } from '@mcap/core'

/**
 * Random-access byte source for MCAP. Extends Foxglove's IReadable with download accounting and an
 * AbortSignal the caller can swap in before a read, since IReadable itself has no abort parameter.
 */
export interface ByteSource extends IReadable {
  /** Bytes actually transferred so far, used to show the real cost of playback to the user. */
  readonly bytesRead: number
  /** Applied to the next underlying transfer; cleared by the caller when the operation ends. */
  abortSignal?: AbortSignal
}

/** Bytes fetched from the end of the file to learn its size and read the MCAP footer at once. */
const TAIL_SIZE = 4096

export class HttpByteSource implements ByteSource {
  bytesRead = 0

  abortSignal?: AbortSignal

  private total: bigint | null = null

  private tail: { offset: bigint, data: Uint8Array } | null = null

  constructor(public readonly url: string) {}

  async size(): Promise<bigint> {
    if (this.total === null) {
      await this.readTail()
    }
    return this.total ?? 0n
  }

  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    const length = Number(size)
    const start = Number(offset)
    if (length <= 0) {
      return new Uint8Array()
    }
    const cached = this.fromTail(start, length)
    if (cached) {
      return cached
    }
    const { data } = await this.request(`bytes=${start}-${start + length - 1}`)
    return data
  }

  private fromTail(offset: number, length: number): Uint8Array | null {
    if (!this.tail) {
      return null
    }
    const tailOffset = Number(this.tail.offset)
    if (offset < tailOffset || offset + length > tailOffset + this.tail.data.length) {
      return null
    }
    const start = offset - tailOffset
    return this.tail.data.subarray(start, start + length)
  }

  /** A suffix range tells us the total size and gives us the footer in a single request. */
  private async readTail(): Promise<void> {
    const { data, total } = await this.request(`bytes=-${TAIL_SIZE}`)
    this.total = BigInt(total)
    this.tail = { offset: BigInt(Math.max(0, total - data.length)), data }
  }

  private async request(range: string): Promise<{ data: Uint8Array, total: number }> {
    const response = await fetch(this.url, {
      headers: { Range: range },
      signal: this.abortSignal,
    })
    if (response.status !== 206) {
      // A 200 here means the whole file is on its way, which we must never do on a vehicle link.
      response.body?.cancel()
      throw new Error(`Recording server does not support range requests (got ${response.status}).`)
    }

    const total = Number(response.headers.get('content-range')?.split('/')?.[1])
    const data = new Uint8Array(await response.arrayBuffer())
    this.bytesRead += data.byteLength
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('Recording server did not report the file size.')
    }
    return { data, total }
  }
}
