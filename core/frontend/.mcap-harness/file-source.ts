/** Shared filesystem IReadable for the local MCAP harness scripts. */
import { closeSync, openSync, readSync, statSync } from 'fs'

import { ByteSource } from '../src/libs/mcap/source'

export class FileSource implements ByteSource {
  bytesRead = 0

  requests = 0

  abortSignal?: AbortSignal

  private fd: number

  constructor(private path: string) {
    this.fd = openSync(path, 'r')
  }

  async size(): Promise<bigint> {
    return BigInt(statSync(this.path).size)
  }

  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    const length = Number(size)
    const buffer = Buffer.allocUnsafe(length)
    const read = readSync(this.fd, buffer, 0, length, Number(offset))
    this.bytesRead += read
    this.requests += 1
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read)
  }

  close(): void {
    closeSync(this.fd)
  }
}
